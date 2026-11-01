import { createSocial } from './modules/social.mjs';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig, validateConfig } from './domain/config.mjs';
import { createChainValues } from './modules/chain-values.mjs';
import { createWalletGateway, walletView } from './adapters/wallet.mjs';
import { WalletLease } from '../recovery-journal.mjs';
import { Activity } from './runtime/activity.mjs';
import { acquireInstanceLock } from './runtime/instance-lock.mjs';
import { openStore } from './runtime/store.mjs';
import { createRunner } from './runtime/runner.mjs';
import { composeModules } from './composition.mjs';
import { pendingOperations } from './domain/operations.mjs';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
export function createApplication({ root, config, initialize = false, migrateLegacy = false, fetchImpl = globalThis.fetch, executeFile, now = Date.now } = {}) {
  if (!root) throw new Error('An explicit installation root is required');
  root = resolve(root);
  const CONFIG = validateConfig(config || loadConfig(join(root, 'config.json')));
  CONFIG.telegram = { ...CONFIG.telegram, botToken: CONFIG.telegram?.botToken || process.env.TG_BOT_TOKEN, chatId: CONFIG.telegram?.chatId || process.env.TG_CHAT_ID };
  const dataRoot = join(root, 'data'); mkdirSync(dataRoot, { recursive: true });
  const release = acquireInstanceLock(join(dataRoot, 'watch.lock'));
  try {
    const store = openStore(dataRoot, CONFIG, { initialize, migrateLegacy });
    const activity = new Activity(), controller = new AbortController(), timers = new Set();
    const ts = () => new Date(now()).toLocaleString('zh-TW', { hour12: false, timeZone: CONFIG.timeZone });
    const LOG = join(dataRoot, 'watch.log');
    const log = (message) => appendFileSync(LOG, `[${ts()}] ${message}\n`);
    const WALLETS = CONFIG.wallets.map((w) => Object.freeze({ name: w.name, addr: w.address, agentId: createChainValues({}).keccak256(w.name.toLowerCase().replace(/\.ai$/, '')) }));
    const wallet = createWalletGateway({ wallets: CONFIG.wallets, root, activity, executeFile });
    const sleep = async (ms) => {
      if (controller.signal.aborted) return;
      await new Promise((done) => {
        const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); done(); };
        const timer = setTimeout(finish, ms); controller.signal.addEventListener('abort', finish, { once: true });
      });
    };
    const controlledFetch = (url, options = {}) => {
      controller.signal.throwIfAborted();
      return fetchImpl(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
    };
    const defer = (fn, ms) => {
      if (activity.stopping) return;
      const timer = setTimeout(() => { timers.delete(timer); if (!activity.stopping) activity.track(Promise.resolve().then(fn).catch((e) => log('Deferred: ' + e.message))); }, ms);
      timers.add(timer);
    };
    let social;
    const services = composeModules({ CONFIG, configuredBudget: CONFIG.paid.maxUsd, DIR: root, LOG, STATE: store.statePath,
      PROJECT_BUDGET: store.budget, RECOVERY: store.recovery, WALLET_LEASE: new WalletLease(),
      S: store.state, save: store.save, log, ts, sleep, WALLETS, ME: WALLETS[0].addr,
      noteTransactions: txs => social?.noteTransactions(txs), activity, scheduler: {}, wallet, walletRead: walletView(wallet), walletSession: walletView(wallet, { authentication: true }),
      fetchImpl: controlledFetch, defer, UPD: { on: false, ver: '2.6.2-modular', repo: 'potent22/agentid-sniper' } });
    social = createSocial({ ...services });
    services.socialPoll = social.socialPoll; services.inscriptionPoll = social.inscriptionPoll;
    const heartbeat = () => writeFileSync(join(dataRoot, 'watch_heartbeat.txt'), `${ts()} scanLag=${services.S.scanLag ?? '?'} active=${activity.count} stopping=${activity.stopping}\n`);
    const runner = createRunner({ services, activity, now, sleep, heartbeat, stopped: () => existsSync(join(root, 'WATCH_STOP')) });
    let running, stopPromise, watchdog;
    async function stop(reason = 'requested') {
      if (stopPromise) return stopPromise;
      activity.stop(); clearInterval(watchdog);
      for (const timer of timers) clearTimeout(timer); timers.clear();
      try { log('Stopping: ' + reason); } catch (error) { console.error('Shutdown logging failed: ' + error.message); }
      stopPromise = (async () => {
        // Receipt reconciliation can finish using normal I/O. After the grace
        // period, abort reads; unresolved sends remain durably journaled.
        const deadline = now() + 240000;
        while (activity.count > 0 && now() < deadline) await delay(100);
        controller.abort(new Error('Application stopped'));
        await social.close();
        const drained = await activity.drain({ sleep: delay, timeoutMs: 10000, now });
        if (running) await Promise.race([running, delay(1000)]);
        store.save(); heartbeat();
        if (drained) release(); // Unclean exit keeps the lock for reconciliation.
        return { drained, pending: WALLETS.flatMap((W) => store.budget.pendingEntries(W.addr)), recovery: store.recovery.read().wallets };
      })();
      return stopPromise;
    }
    async function run() {
      if (running || activity.stopping) throw new Error('Application can only run once');
      if (existsSync(join(root, 'WATCH_STOP'))) return stop('WATCH_STOP');
      log('Starting modular watcher');
      watchdog = setInterval(() => {
        if (existsSync(join(root, 'WATCH_STOP'))) void stop('WATCH_STOP');
        else if (now() - runner.lastLoopAt() > (activity.count ? 11 : 8) * 60000) void stop('watchdog');
      }, 1000);
      running = activity.track(runner.run());
      try { await running; }
      catch (error) { await stop('loop failed').catch(() => {}); throw error; }
      return stop('loop stopped');
    }
    const status = () => ({ schemaVersion: 1, stopping: activity.stopping, inflight: activity.count, jobs: runner.jobs(),
      operations: pendingOperations({ wallets: WALLETS.map((w) => w.addr), budget: store.budget, recovery: store.recovery }) });
    return { run, stop, status, services, activity, runner, root, dataRoot };
  } catch (error) { release(); throw error; }
}

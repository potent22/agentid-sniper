import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, cpSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApplication } from '../src/application.mjs';
import { Activity } from '../src/runtime/activity.mjs';
import { createRunner } from '../src/runtime/runner.mjs';
import { createWalletGateway, walletView } from '../src/adapters/wallet.mjs';
import { createTransactions } from '../src/modules/transactions.mjs';
import { createChainValues } from '../src/modules/chain-values.mjs';
import { contractIntent, rawAmount } from '../src/domain/contracts.mjs';
import { NotSubmittedError } from '../src/domain/errors.mjs';
import { validateConfig } from '../src/domain/config.mjs';
import { inspectStartup } from '../preflight.mjs';
import { ProjectBudget } from '../project-budget.mjs';
import { RecoveryJournal, WalletLease } from '../recovery-journal.mjs';
import { guardedSwap } from '../swap-recovery.mjs';
import { executeGuarded } from '../guarded-contract-executor.mjs';

const address = '0x' + '1'.repeat(40), project = '0x' + '2'.repeat(40), txHash = '0x' + 'a'.repeat(64);
const configuration = () => ({ wallets: [{ name: 'test.ai', address }], paid: { maxUsd: 1.2 }, timeZone: 'Asia/Shanghai' });
const forbidden = () => { throw new Error('Real I/O forbidden in test'); };
function temporary(t) { const path = mkdtempSync(join(tmpdir(), 'modular-runtime-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }

test('importing the entry in an empty installation has no file, timer, network or process side effects', (t) => {
  const dir = temporary(t), entry = new URL('../watch.mjs', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { syncBuiltinESMExports } from 'node:module';
    import fs from 'node:fs'; import child from 'node:child_process';
    const fail = () => { throw new Error('import side effect'); };
    fs.writeFileSync = fail; fs.appendFileSync = fail; fs.mkdirSync = fail; child.execFile = fail;
    globalThis.fetch = fail; globalThis.setInterval = fail; globalThis.setTimeout = fail;
    syncBuiltinESMExports(); await import(${JSON.stringify(entry)}); console.log('inert');
  `], { cwd: dir, encoding: 'utf8' });
  assert.equal(output.trim(), 'inert'); assert.deepEqual(readdirSync(dir), []);
});

test('configuration and preflight share the 1.2U ceiling; raw boundary amounts never round', async () => {
  const config = configuration(); assert.deepEqual(validateConfig(JSON.parse(JSON.stringify(config))), config);
  for (const limit of [0, -1, 1.200001, 5, NaN, Infinity, '1.2']) {
    const bad = { ...config, paid: { maxUsd: limit } };
    assert.throws(() => validateConfig(bad), /paid.maxUsd/);
    const result = await inspectStartup({ config: bad, runCli: forbidden, rpc: forbidden });
    assert.equal(result.ready, false); assert.equal(result.checks.length, 1);
  }
  const value = '999999999999999999999999';
  assert.equal(rawAmount(value).toString(), value);
  assert.equal(contractIntent({ chainId: '56', wallet: address, contract: project, value, inputData: '0x12345678' }).value, value);
  for (const value of [1, -1n, '1.2', '01', '-1']) assert.throws(() => rawAmount(value));
  assert.throws(() => rawAmount((1n << 256n).toString()), /uint256/);
});

test('wallet arguments are literal; read-only capabilities and the shutdown send gate cannot mutate', async () => {
  const activity = new Activity(), calls = [];
  const gateway = createWalletGateway({ wallets: configuration().wallets, root: '/unused', activity,
    executeFile: (command, args, options, cb) => { calls.push({ command, args, options }); cb(null, JSON.stringify(args[0] === 'wallet' && args[1] === 'address' ? { success: true, data: { addresses: [{ binanceChainId: '56', address }] } } : { success: true }), ''); } });
  await gateway.call(address, ['contract-call', 'execute', '--requestId', 'literal;$(do-not-execute)']);
  assert.equal(calls[1].options.shell, false); assert.equal(calls[1].args[3], 'literal;$(do-not-execute)');
  assert.throws(() => walletView(gateway).call(address, ['market-order', 'swap']), /capability denied/);
  await assert.rejects(gateway.call(project, ['wallet', 'status']), /invalid wallet/);
  activity.stop();
  await assert.rejects(gateway.call(address, ['contract-call', 'execute', '--requestId', 'x']), NotSubmittedError);
  assert.equal(calls.length, 2);
  await walletView(gateway).call(address, ['wallet', 'status']); assert.equal(calls.length, 3);
});

test('a wallet identity mismatch stops before contract submission', async () => {
  const activity = new Activity(), calls = [];
  const gateway = createWalletGateway({ wallets: configuration().wallets, root: '/unused', activity,
    executeFile: (_command, args, _options, cb) => { calls.push(args.slice(0, 2).join(' ')); cb(null, JSON.stringify({ success: true, data: { addresses: [{ binanceChainId: '56', address: project }] } }), ''); } });
  await assert.rejects(gateway.call(address, ['contract-call', 'execute', '--requestId', 'test']), NotSubmittedError);
  assert.deepEqual(calls, ['wallet address']);
});

test('a stop during the identity query prevents the subsequent send', async () => {
  const activity = new Activity(), calls = [];
  const gateway = createWalletGateway({ wallets: configuration().wallets, root: '/unused', activity,
    executeFile: (_command, args, _options, cb) => {
      calls.push(args.slice(0, 2).join(' ')); activity.stop();
      cb(null, JSON.stringify({ success: true, data: { addresses: [{ binanceChainId: '56', address }] } }), '');
    } });
  await assert.rejects(gateway.call(address, ['contract-call', 'execute', '--requestId', 'test']), NotSubmittedError);
  assert.deepEqual(calls, ['wallet address']);
});

test('unverified Permit2 cleanup blocks a swap before creating a recovery job or sending', async (t) => {
  const root = temporary(t), journal = new RecoveryJournal(join(root, 'recovery.json'));
  const tx = createTransactions({ RECOVERY: journal, PROJECT_BUDGET: new ProjectBudget(join(root, 'budget.json'), 1200000n), activity: new Activity(), wallet: { call: forbidden } });
  await assert.rejects(tx.swapConfirmed({ addr: address }, ['market-order', 'swap']), /Permit2/);
  assert.equal(journal.get(address), null);
});

test('stop between preview and execution releases only the proven-unsent reservation', async (t) => {
  const root = temporary(t), activity = new Activity(); let sends = 0;
  const wallet = createWalletGateway({ wallets: configuration().wallets, root, activity,
    executeFile: (_command, args, _options, cb) => {
      if (args[1] === 'execute') { sends++; throw new Error('Must not send'); }
      activity.stop(); cb(null, JSON.stringify({ success: true, data: { requestId: 'test', simulationResult: { balanceChanges: [{ owner: address, contractAddress: project, tokenType: 'Erc20', change: '1' }] } } }), '');
    } });
  const budget = new ProjectBudget(join(root, 'budget.json'), 1200000n);
  const tx = createTransactions({ ...createChainValues({}), CONFIG: configuration(), S: { tokens: {} }, STATE: join(root, 'state.json'),
    PROJECT_BUDGET: budget, RECOVERY: new RecoveryJournal(join(root, 'recovery.json')), WALLET_LEASE: new WalletLease(),
    activity, wallet, FORCE: new Set(), flapGuard: () => '', enforceMintRisk: async () => {}, riskBlock: async () => '',
    rpc: async (method) => { assert.equal(method, 'eth_call'); return '0x' + '0'.repeat(64); }, sleep: forbidden });
  await assert.rejects(tx.previewExec({ addr: address, name: 'test.ai' }, project, '0x12345678', 0n, () => ''), NotSubmittedError);
  assert.equal(sends, 0); assert.equal(budget.pending(address, project), null);
  assert.equal(budget.read().projects[`${address}:${project}`].spent, '0');
});

test('unknown submission remains reserved even if an upstream error imitates the local cancellation code', async (t) => {
  const root = temporary(t), budget = new ProjectBudget(join(root, 'budget.json'), 1200000n);
  const error = Object.assign(new Error('remote error'), { code: 'NOT_SUBMITTED' });
  await assert.rejects(executeGuarded({ budget, wallet: address, project, ceiling: 1000000n, submit: async () => { throw error; }, rpc: forbidden, sleep: forbidden }), /結果不明/);
  assert.equal(new ProjectBudget(budget.path, 1200000n).pending(address, project).ceiling, '1000000');
});

test('swap cancellation clears only an unsent job; unknown execution survives restart', async (t) => {
  const root = temporary(t), journal = new RecoveryJournal(join(root, 'recovery.json')), lease = new WalletLease();
  const options = { journal, lease, wallet: address, args: [], getBlock: async () => '0x1', finish: forbidden };
  await assert.rejects(guardedSwap({ ...options, submit: async () => { throw new NotSubmittedError(); } }), NotSubmittedError);
  assert.equal(journal.get(address), null);
  await assert.rejects(guardedSwap({ ...options, submit: async () => { throw new Error('network disappeared'); } }), /結果不明/);
  assert.equal(new RecoveryJournal(journal.path).get(address).phase, 'prepared');
});

test('application restart preserves ledger and pending identity; another instance and a missing ledger fail closed', async (t) => {
  const root = temporary(t), options = { root, config: configuration(), fetchImpl: forbidden, executeFile: forbidden };
  const app = createApplication({ ...options, initialize: true });
  app.services.S.tokens.example = { stage: 2 };
  app.services.PROJECT_BUDGET.reserve(address, project, 'operation', 700000n);
  app.services.PROJECT_BUDGET.recordTx(address, project, 'operation', txHash);
  assert.throws(() => createApplication(options), /EEXIST/);
  await app.stop('test restart');
  const next = createApplication(options);
  assert.equal(next.services.S.tokens.example.stage, 2);
  assert.deepEqual(next.status().operations[0], { schemaVersion: 1, kind: 'contract', wallet: address, contract: project,
    operationId: 'operation', state: 'submitted', txHash, principalCeilingMicros: '700000' });
  writeFileSync(join(root, 'WATCH_STOP'), 'test');
  assert.equal((await next.run()).drained, true);
  unlinkSync(join(root, 'data', 'project_budget.json'));
  assert.throws(() => createApplication(options), /Required ledger missing/);
  assert.equal(existsSync(join(root, 'data', 'watch.lock')), false);
});

test('data-root binding prevents accidentally starting against a copied development ledger', async (t) => {
  const root = temporary(t), other = temporary(t), config = configuration();
  const app = createApplication({ root, config, initialize: true, fetchImpl: forbidden, executeFile: forbidden }); await app.stop();
  cpSync(join(root, 'data'), join(other, 'data'), { recursive: true });
  assert.throws(() => createApplication({ root: other, config, fetchImpl: forbidden, executeFile: forbidden }), /Data root/);
  assert.throws(() => createApplication({ root: temporary(t), config, fetchImpl: forbidden, executeFile: forbidden }), /explicit initialization/);
});

test('runner stops scheduling after a stop during a blocked scan', async () => {
  const activity = new Activity(); let releaseScan, sideEffects = 0;
  const scan = new Promise((done) => { releaseScan = done; });
  const runner = createRunner({ activity, now: Date.now, heartbeat: () => { sideEffects++; }, stopped: () => false, sleep: forbidden,
    services: { WALLETS: [], rpc: async () => '0x1', scanNew: () => scan, S: { tokens: {} } } });
  const tick = runner.tick(); await Promise.resolve(); activity.stop(); releaseScan(); await tick;
  assert.equal(sideEffects, 0); assert.deepEqual(runner.jobs(), []);
});

test('legacy-format migration and code rollback preserve the latest amounts and execution markers', async (t) => {
  const root = temporary(t), data = join(root, 'data'); mkdirSync(data);
  const state = { tokens: {}, appliedExecutions: { [`mint:${address}:${txHash}`]: txHash }, dyn: [] };
  writeFileSync(join(data, 'watch_state.json'), JSON.stringify(state));
  const budget = new ProjectBudget(join(data, 'project_budget.json'), 1200000n);
  budget.reserve(address, project, 'completed', 700000n); budget.settle(address, project, 'completed', 700000n);
  budget.reserve(address, project, 'pending', 200000n); budget.recordTx(address, project, 'pending', txHash);
  writeFileSync(join(data, 'recovery.json'), JSON.stringify({ version: 1, wallets: {} }));
  const before = readFileSync(budget.path, 'utf8'), options = { root, config: configuration(), fetchImpl: forbidden, executeFile: forbidden };
  assert.throws(() => createApplication(options), /explicit, reconciled migration/);
  const app = createApplication({ ...options, migrateLegacy: true });
  assert.equal(readFileSync(budget.path, 'utf8'), before); await app.stop();
  // The prior JSON ledger implementation can still read and settle the latest
  // state. Rolling code back must never restore an earlier funds snapshot.
  const legacyReader = new ProjectBudget(budget.path, 1200000n);
  legacyReader.settle(address, project, 'pending', 200000n);
  const next = createApplication(options);
  assert.equal(next.services.PROJECT_BUDGET.read().projects[`${address}:${project}`].spent, '900000');
  assert.equal(next.services.S.appliedExecutions[`mint:${address}:${txHash}`], txHash);
  assert.deepEqual(next.status().operations, []); await next.stop();
});

test('legacy daily date metadata is not principal; positive or unknown spend still blocks a missing budget', async (t) => {
  for (const amount of [undefined, 0, 0.001, null, 'unknown']) {
    const root = temporary(t), data = join(root, 'data'); mkdirSync(data);
    const state = { tokens: {}, paidSpend: { day: '2026-11-01', ...(amount === undefined ? {} : { 'test.ai': amount }) },
      appliedExecutions: { 'funding:historical-topup': txHash } };
    writeFileSync(join(data, 'watch_state.json'), JSON.stringify(state));
    writeFileSync(join(data, 'recovery.json'), JSON.stringify({ version: 1, wallets: {} }));
    const options = { root, config: configuration(), migrateLegacy: true, fetchImpl: forbidden, executeFile: forbidden };
    if (amount !== undefined && amount !== 0) { assert.throws(() => createApplication(options), /Budget missing/); continue; }
    const app = createApplication(options);
    assert.deepEqual(app.services.PROJECT_BUDGET.read().projects, {});
    assert.deepEqual(app.services.S.appliedExecutions, state.appliedExecutions);
    assert.deepEqual(app.services.S.paidSpend, state.paidSpend); await app.stop();
  }
});

test('composed app scans and shuts down using only fake RPC and wallet queries', { timeout: 5000 }, async (t) => {
  const root = temporary(t), calls = [];
  const app = createApplication({ root, config: configuration(), initialize: true,
    fetchImpl: async (_url, options = {}) => ({ json: async () => {
      const request = JSON.parse(options.body || '{}');
      const answer = (r) => ({ id: r.id, result: r.method === 'eth_blockNumber' ? '0x64'
        : r.method === 'eth_getBlockByNumber' ? { number: r.params[0], timestamp: '0x69000000', transactions: [] }
        : ['eth_getLogs', 'eth_getBlockReceipts'].includes(r.method) ? []
        : r.method === 'eth_getCode' ? '0x' : '0x' + '0'.repeat(64 * 12) });
      return Array.isArray(request) ? request.map(answer) : answer(request);
    } }),
    executeFile: (_command, args, _options, callback) => {
      calls.push(args.slice(0, 2).join(' '));
      assert.ok(['wallet status', 'wallet settings', 'approvals list'].includes(calls.at(-1)));
      callback(null, JSON.stringify({ success: true, data: args[1] === 'status' ? { status: 'CONNECTED' }
        : args[1] === 'settings' ? { devMode: { enabled: true, expiresAt: '2030-01-01T00:00:00Z' } } : { list: [] } }), '');
    } });
  app.services.S.smartAt = Date.now(); app.services.S.nftVolAt = Date.now();
  const running = app.run();
  await new Promise((done) => setTimeout(done, 50));
  const outcome = await app.stop('offline verification'); await running;
  assert.equal(outcome.drained, true); assert.deepEqual(app.status().operations, []);
  assert.ok(app.services.S.lastBlock > 0); assert.ok(calls.includes('wallet status'));
  assert.equal(existsSync(join(root, 'data', 'watch.lock')), false);
});

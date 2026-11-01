// Scheduling has no wallet authority. Tasks own their receipt/journal recovery;
// stop closes the send gate first, then waits for their durable outcome.
export function createRunner({ services: s, activity, now = Date.now, heartbeat, stopped, sleep, intervalMs = 1000 }) {
  const jobs = new Map(), last = new Map();
  let lastLoop = now();
  function schedule(name, period, work) {
    if (activity.stopping || jobs.has(name) || now() - (last.get(name) ?? -Infinity) < period) return;
    last.set(name, now());
    const job = Promise.resolve().then(() => activity.stopping ? undefined : work())
      .catch((error) => s.log(name + ': ' + error.message))
      .finally(() => jobs.delete(name));
    jobs.set(name, activity.track(job));
  }
  async function tick() {
    if (activity.stopping) return;
    for (const W of s.WALLETS) {
      if (!s.WALLET_LEASE.active.has(W.addr) && (s.RECOVERY.get(W.addr) || s.PROJECT_BUDGET.pendingEntries(W.addr).length)) {
        activity.count++;
        try { if (s.RECOVERY.get(W.addr)) await s.recoverWallet(W); else await s.recoverContractMints(W); }
        catch (error) { s.log('Recovery pending ' + W.name + ': ' + error.message); }
        finally { activity.count--; }
      }
    }
    if (activity.stopping) return;
    const head = parseInt(await s.rpc('eth_blockNumber', []), 16);
    if (!Number.isSafeInteger(head) || head <= 0) throw new Error('Invalid chain head');
    await s.scanNew(head);
    if (activity.stopping) return;
    const fast = Object.values(s.S.tokens).some((st) => st.openAt && now() - st.openAt < s.RULE.fastMin * 60000 && st.stage !== 9 && !st.done);
    schedule('holdings', fast ? 1000 : 5000, () => s.holdings(head, false));
    schedule('flap', 30000, s.flapAgentWatch);
    schedule('tosh', 60000, s.toshWatch);
    schedule('gas', 600000, s.lowBnbWatch);
    schedule('approvals', 600000, s.flapApprovalWatch);
    schedule('daily', 60000, s.dailyReport);
    schedule('prune', 3600000, s.pruneState);
    schedule('aidrop', 120000, () => s.aidropWatch(head));
    for (let k = 0; k < 3; k++) schedule('paid-' + k, 15000, () => s.paidLoop('hot', k));
    schedule('sweep', 60000, s.progressSweep);
    schedule('paid-rest', 60000, () => s.paidLoop('rest'));
    if (now() - (s.S.smartAt || 0) > 6 * 3600000) schedule('smart', 6 * 3600000, async () => { s.S.smartAt = now(); await s.buildSmart(); });
    schedule('manual', 5000, s.manualMints);
    schedule('heat', 20000, s.heatWatch);
    schedule('free-progress', 300000, s.freeProgWatch);
    if (now() - (s.S.nftVolAt || 0) > 12 * 3600000) schedule('nft', 12 * 3600000, async () => { s.S.nftVolAt = now(); await s.nftVolWatch(); });
    if (s.socialPoll) schedule('social', 60000, s.socialPoll);
    if (s.inscriptionPoll) schedule('inscriptions', 20000, s.inscriptionPoll);
    schedule('login', 600000, s.loginCheck);
    schedule('hold-report', 60000, async () => {
      const local = new Date(now() + 8 * 3600000), hour = local.getUTCHours(), key = local.toISOString().slice(0, 10) + '-' + hour;
      if ((hour === 1 || hour === 13) && s.S.holdRepAt !== key) { s.S.holdRepAt = key; s.save(); await s.holdReport(); }
    });
    lastLoop = now(); s.save(); heartbeat();
    if ((s.S.scanLag || 0) > 400 && now() - (s.S.lagAlert || 0) > 3600000) { s.S.lagAlert = now(); await s.tg('⚠️ 新合约扫描落后 ' + s.S.scanLag + ' 个区块，需检查节点'); }
  }
  async function run() {
    schedule('commands', Infinity, s.tgCmdLoop);
    while (!activity.stopping) {
      if (stopped()) { activity.stop(); break; }
      try { await tick(); } catch (error) { s.log('Loop: ' + error.message); }
      if (!activity.stopping) await sleep(intervalMs);
    }
  }
  return { tick, run, lastLoopAt: () => lastLoop, jobs: () => [...jobs.keys()] };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { mintRiskDecision } from '../mint-risk-policy.mjs';
const project = '0x' + '2'.repeat(40), developer = '0x' + '3'.repeat(40), wallet = '0x' + '1'.repeat(40);

test('blacklist and three deployments reject even with complete evidence and high progress', () => {
  const clear = { developer, code: '0x6001', deploymentCoverageComplete: true, rugHistoryVerified: true, progress: 1, forced: true };
  assert.match(mintRiskDecision({ ...clear, blacklisted: true }), /黑名單/);
  assert.match(mintRiskDecision({ ...clear, serial: true }), /部署至少三次/);
  assert.equal(mintRiskDecision(clear), '');
});

test('incomplete 24-hour or developer history is not treated as safety clearance', () => {
  const base = { developer, code: '0x6001', deploymentCoverageComplete: true, rugHistoryVerified: true };
  assert.match(mintRiskDecision({ ...base, deploymentCoverageComplete: false }), /24 小時/);
  assert.match(mintRiskDecision({ ...base, rugHistoryVerified: false }), /歷史 rug/);
  assert.match(mintRiskDecision({ ...base, developer: '' }), /部署者/);
});

test('real watcher execution path blocks mint and new grant but permits a zero approval for cleanup', async () => {
  const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function enforceMintRisk('), end = source.indexOf('\nasync function previewExec(', start);
  let submissions = 0;
  const ctx = vm.createContext({
    S: { depFrom: { [project]: developer }, black: { [developer]: { why: 'known rug' } } },
    mintRiskDecision, isSerial: () => false, codeOf: async () => '0x6001', fullCode: async () => '0x6001',
    WALLET_LEASE: { run: async (_wallet, fn) => fn() }, RECOVERY: { get: () => null },
    PROJECT_BUDGET: { pendingEntries: () => [], max: 1_200_000n }, INFLIGHT: 0, FORCE: new Set(),
    contractPrincipal: async () => ({ project, ceiling: 0n }), mintMetadata: () => ({ kind: 'permission' }),
    adoptConfirmed: async () => {}, recordFeeReceipt: async () => {}, rpc: async () => {}, sleep: async () => {},
    executeGuarded: async () => { submissions++; return { result: { j: { data: { txHash: '0x' + 'a'.repeat(64) } } }, receipt: {} }; },
  });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.entry = submitContract;', ctx);
  const W = { addr: wallet, name: 'test.ai', baw: async () => {} };
  await assert.rejects(ctx.entry(W, project, '0x12345678', 0n, 'id', {}), /黑名單/);
  const grant = '0x095ea7b3' + project.slice(2).padStart(64, '0') + '1'.padStart(64, '0');
  const revoke = '0x095ea7b3' + project.slice(2).padStart(64, '0') + '0'.repeat(64);
  await assert.rejects(ctx.entry(W, '0x' + '4'.repeat(40), grant, 0n, 'id', {}), /黑名單/);
  assert.equal(submissions, 0);
  // Exercise the actual watcher's 24-hour deployment counter, not a mock.
  const counterStart = source.indexOf('function codePrint('), counterEnd = source.indexOf('\n// ---------- 第三層', counterStart);
  vm.runInContext(source.slice(counterStart, counterEnd), ctx);
  ctx.S.black = {}; ctx.S.fps = { '4:60016001': [Date.now(), Date.now(), Date.now()] };
  await assert.rejects(ctx.entry(W, project, '0x12345678', 0n, 'id', {}), /部署至少三次/);
  assert.equal(submissions, 0);
  await ctx.entry(W, '0x' + '4'.repeat(40), revoke, 0n, 'id', {});
  assert.equal(submissions, 1);
});

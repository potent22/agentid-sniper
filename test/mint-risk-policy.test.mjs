import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectRisk } from '../src/modules/project-risk.mjs';
import { createTransactions } from '../src/modules/transactions.mjs';
import { createChainValues } from '../src/modules/chain-values.mjs';
import { ProjectBudget } from '../project-budget.mjs';
import { RecoveryJournal, WalletLease } from '../recovery-journal.mjs';
import { Activity } from '../src/runtime/activity.mjs';
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

test('real execution path blocks blacklist, serial deployments and missing evidence; zero approval can clean up', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'risk-execution-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let submissions = 0;
  const txHash = '0x' + 'a'.repeat(64), values = createChainValues({});
  const S = { tokens: {}, depFrom: { [project]: developer }, black: { [developer]: { why: 'known rug' } } };
  const CONFIG = { timeZone: 'Asia/Shanghai' };
  const risk = createProjectRisk({ ...values, S, CONFIG, codeOf: async () => '0x6001', fullCode: async () => '0x6001', RISK: {} });
  const tx = createTransactions({ ...values, S, CONFIG, STATE: join(dir, 'state.json'),
    PROJECT_BUDGET: new ProjectBudget(join(dir, 'budget.json'), 1200000n), RECOVERY: new RecoveryJournal(join(dir, 'recovery.json')), WALLET_LEASE: new WalletLease(),
    activity: new Activity(), FORCE: new Set([project]), enforceMintRisk: risk.enforceMintRisk,
    wallet: { call: async () => { submissions++; return { j: { data: { txHash } } }; } },
    sleep: async () => {}, rpc: async (method, params) => {
      if (method === 'eth_getBlockByNumber') return { number: params[0], timestamp: '0x69000000' };
      if (method === 'eth_getTransactionReceipt') return { transactionHash: txHash, from: wallet, blockNumber: '0x1', status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [] };
      throw new Error('Unexpected RPC ' + method);
    },
  });
  const W = { addr: wallet, name: 'test.ai' };
  const grant = '0x095ea7b3' + values.wa(project) + values.w(1n), revoke = '0x095ea7b3' + values.wa(project) + values.w(0n);
  await assert.rejects(tx.submitContract(W, project, '0x12345678', 0n, 'id', {}), /黑名單/);
  await assert.rejects(tx.submitContract(W, values.USDT, grant, 0n, 'id', {}), /黑名單/);
  S.black = {}; risk.noteDeploy('0x6001'); risk.noteDeploy('0x6001'); risk.noteDeploy('0x6001');
  await assert.rejects(tx.submitContract(W, project, '0x12345678', 0n, 'id', {}), /部署至少三次/);
  S.fps = {};
  await assert.rejects(tx.submitContract(W, project, '0x12345678', 0n, 'id', {}), /24 小時/);
  assert.equal(submissions, 0);
  await tx.submitContract(W, values.USDT, revoke, 0n, 'id', { balanceChanges: [] });
  assert.equal(submissions, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareFeeEvent, feeDay } from '../receipt-fees.mjs';
import { applyOnce } from '../execution-state.mjs';
import { executeGuarded } from '../guarded-contract-executor.mjs';
import { ProjectBudget } from '../project-budget.mjs';
const wallet = '0x' + '1'.repeat(40), project = '0x' + '2'.repeat(40), hash = '0x' + 'a'.repeat(64);
const receipt = { transactionHash: hash, from: wallet, status: '0x0', blockNumber: '0x2', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00' };
const block = { number: '0x2', timestamp: '0x' + Math.floor(Date.parse('2026-11-01T16:00:00Z') / 1000).toString(16) };

test('reverted gas is exact, separate from principal, idempotent and uses the on-chain Shanghai day', async () => {
  const event = await prepareFeeEvent({ wallet, project, metadata: { kind: 'mint' }, receipt, rpc: async () => block });
  const state = { tokens: {} }; applyOnce(state, event, () => {}); applyOnce(state, event, () => {});
  assert.equal(event.walletGasWei, '21000000000000'); assert.equal(event.day, '2026-11-02');
  assert.equal(state.feeDays[event.day][wallet].failedProjects[project], 1);
  assert.equal(state.feeDays[event.day][wallet].gasWei, '21000000000000');
  assert.equal(feeDay(Date.parse('2026-11-01T15:59:59Z')), '2026-11-01');
});

test('missing fee data fails closed; an identified external payer is recorded explicitly', async () => {
  const opts = { wallet, project, receipt, rpc: async () => block };
  await assert.rejects(prepareFeeEvent({ ...opts, receipt: { ...receipt, effectiveGasPrice: undefined } }), /effectiveGasPrice/);
  await assert.rejects(prepareFeeEvent({ ...opts, rpc: async () => ({ ...block, number: '0x3' }) }), /區塊不符/);
  const event = await prepareFeeEvent({ ...opts, receipt: { ...receipt, from: project } });
  assert.equal(event.paidByWallet, false); assert.equal(event.walletGasWei, '0'); assert.equal(event.transactionFeeWei, '21000000000000');
});

test('crash after reverted-gas commit but before principal settlement recovers without duplicate gas or another send', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gas-recovery-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'budget.json'), state = { tokens: {} }; let sends = 0;
  const rpc = async (method) => method === 'eth_getTransactionReceipt' ? receipt : block;
  const recordReceipt = async (options) => applyOnce(state, await prepareFeeEvent({ ...options, rpc }), () => {});
  let budget = new ProjectBudget(path, 5_000_000n);
  budget.settle = () => { throw new Error('crash before settlement'); };
  const options = { budget, wallet, project, ceiling: 3_000_000n, metadata: { kind: 'mint' }, rpc, sleep: async () => {}, recordReceipt,
    submit: async () => { sends++; return { j: { success: true, data: { txHash: hash } } }; } };
  await assert.rejects(executeGuarded(options), /crash/);
  budget = new ProjectBudget(path, 5_000_000n);
  await assert.rejects(executeGuarded({ ...options, budget, recoverOnly: true }), /鏈上失敗/);
  assert.equal(sends, 1); assert.equal(budget.pending(wallet, project), null);
  assert.equal(state.feeDays['2026-11-02'][wallet].gasWei, '21000000000000');
  assert.equal(state.feeDays['2026-11-02'][wallet].failedProjects[project], 1);
});

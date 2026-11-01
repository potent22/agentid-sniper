import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectBudget } from '../project-budget.mjs';
import { executeGuarded } from '../guarded-contract-executor.mjs';

const wallet = '0x' + '1'.repeat(40), project = '0x' + '2'.repeat(40), txHash = '0x' + 'a'.repeat(64);
const receipt = { transactionHash: txHash, blockNumber: '0x2', status: '0x1' };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'executor-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'budget.json'); let sends = 0;
  const args = { budget: new ProjectBudget(path, 5_000_000n), wallet, project, ceiling: 3_000_000n,
    sleep: async () => {}, attempts: 1, rpc: async () => receipt,
    submit: async () => { sends++; return { j: { success: true, data: { txHash } } }; } };
  return { args, path, sends: () => sends };
}

test('confirmed principal accumulates; over-budget request never reaches wallet', async (t) => {
  const f = fixture(t); await executeGuarded(f.args);
  await assert.rejects(executeGuarded(f.args), /exceeded/);
  assert.equal(f.sends(), 1);
});

test('timeout persists across restart; recovery does not resubmit', async (t) => {
  const f = fixture(t);
  await assert.rejects(executeGuarded({ ...f.args, rpc: async () => null }), /逾時/);
  const budget = new ProjectBudget(f.path, 5_000_000n);
  assert.equal(budget.pending(wallet, project).txHash, txHash);
  await assert.rejects(executeGuarded({ ...f.args, budget }), /先前交易成功/);
  assert.equal(f.sends(), 1);
  assert.equal(budget.pending(wallet, project), null);
  await assert.rejects(executeGuarded({ ...f.args, budget }), /exceeded/);
});

test('missing hash blocks restart and overlapping requests', async (t) => {
  const f = fixture(t);
  await assert.rejects(executeGuarded({ ...f.args, submit: async () => ({ j: { success: true } }) }), /雜湊/);
  await assert.rejects(executeGuarded({ ...f.args, budget: new ProjectBudget(f.path, 5_000_000n) }), /人工核實/);
  assert.equal(f.sends(), 0);
});

test('confirmed revert consumes no principal; gas remains outside this ledger', async (t) => {
  const f = fixture(t);
  await assert.rejects(executeGuarded({ ...f.args, rpc: async () => ({ ...receipt, status: '0x0' }) }), /鏈上失敗/);
  assert.equal(f.args.budget.pending(wallet, project), null);
  await executeGuarded(f.args); assert.equal(f.sends(), 2);
});

test('concurrent entry for the same project cannot submit twice', async (t) => {
  const f = fixture(t); let finish;
  const first = executeGuarded({ ...f.args, submit: () => new Promise((r) => { finish = r; }) });
  await assert.rejects(executeGuarded(f.args), /人工核實/);
  finish({ j: { success: true, data: { txHash } } }); await first;
  assert.equal(f.sends(), 0);
});

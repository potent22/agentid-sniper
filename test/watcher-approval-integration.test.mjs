import { prepareFeeEvent, feeDay } from '../receipt-fees.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { RecoveryJournal, WalletLease } from '../recovery-journal.mjs';
import { ProjectBudget } from '../project-budget.mjs';
import { executeGuarded } from '../guarded-contract-executor.mjs';
import { contractPrincipal } from '../contract-principal.mjs';
import { withApproval } from '../approval-workflow.mjs';
import { cleanupApproval } from '../approval-cleanup.mjs';
import { mintMetadata, prepareMintEvent } from '../mint-recovery.mjs';
import { applyOnce, writeState } from '../execution-state.mjs';
import { waitForReceipt } from '../transaction-receipt.mjs';

const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('async function readAllowance('), source.indexOf('\n/* 使用者 10/31 10:49'))
  + '\n' + source.slice(source.indexOf('async function recordFeeReceipt('), source.indexOf('\nasync function poolOut('));
const wallet = '0x' + '1'.repeat(40), spender = '0x' + '2'.repeat(40), token = '0x55d398326f99059ff775485246999027b3197955';

async function fixture(t, { workFails = false, cleanupFails = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-approval-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let allowance = 0n, sends = 0; const previews = new Map(), receipts = new Map();
  const journal = new RecoveryJournal(join(dir, 'recovery.json'));
  const ctx = vm.createContext({
    CONFIG: { timeZone: 'Asia/Shanghai' }, prepareFeeEvent, feeDay,
    mintRiskDecision: () => '', isSerial: () => false, codeOf: async () => '0x6001', fullCode: async () => '0x6001',
    INFLIGHT: 0, RECOVERY: journal, WALLET_LEASE: new WalletLease(),
    PROJECT_BUDGET: new ProjectBudget(join(dir, 'budget.json'), 1_200_000n),
    S: { tokens: {} }, STATE: join(dir, 'state.json'), mintMetadata, prepareMintEvent, applyOnce, writeState, FORCE: new Set(), tokStr: () => 'TOKEN', call: async () => '0x',
    contractPrincipal, executeGuarded, withApproval, cleanupApproval, waitForReceipt,
    USDT: token, wa: (a) => a.slice(2).toLowerCase().padStart(64, '0'), w: (v) => BigInt(v).toString(16).padStart(64, '0'),
    bnbUsd: async () => 700, sleep: async () => {}, flapGuard: () => '', riskAfter: () => {}, riskBlock: async () => '',
    rpc: async (method, params) => method === 'eth_getBlockByNumber' ? { number: params[0], timestamp: '0x' + Math.floor(Date.parse('2026-11-01T00:00:00Z') / 1000).toString(16) } : method === 'eth_call' ? '0x' + allowance.toString(16).padStart(64, '0') : receipts.get(params[0]),
  });
  vm.runInContext(functions + '\nglobalThis.api = { approvedMint, previewExec, recoverWallet };', ctx);
  const W = { addr: wallet, name: 'test.ai', baw: async (args) => {
    if (args[1] === 'preview') {
      const data = args[args.indexOf('--inputData') + 1]; const approval = data.startsWith('0x095ea7b3');
      const id = String(previews.size + 1); previews.set(id, data);
      const balanceChanges = approval ? [] : [{ owner: wallet, contractAddress: token, change: '-' + (7n * 10n ** 17n) }, { owner: wallet, contractAddress: spender, tokenType: 'Erc20', change: '1' }];
      return { j: { success: true, data: { requestId: id, simulationResult: { balanceChanges, allowanceChanges: approval ? [{ spender }] : [] } } } };
    }
    assert.equal(args[1], 'execute'); sends++;
    const data = previews.get(args[args.indexOf('--requestId') + 1]);
    const hash = '0x' + sends.toString(16).padStart(64, '0');
    const approval = data.startsWith('0x095ea7b3'), amount = approval ? BigInt('0x' + data.slice(74)) : null;
    const failed = cleanupFails && approval && amount === 0n;
    if (!failed) { if (approval) allowance = amount; else allowance -= 7n * 10n ** 17n; }
    receipts.set(hash, { transactionHash: hash, blockNumber: '0x1', from: wallet, gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', status: failed ? '0x0' : '0x1', logs: approval ? [] : [{ address: spender, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(64), '0x' + wallet.slice(2).padStart(64, '0')], data: '0x' + '1'.padStart(64, '0') }] });
    return { j: { success: true, data: { txHash: hash } } };
  } };
  const run = () => ctx.api.approvedMint(W, token, spender, 1n * 10n ** 18n, async () => {
    if (workFails) throw new Error('mint failed before submission');
    return ctx.api.previewExec(W, spender, '0x12345678', 0n, () => '');
  });
  return { run, journal, allowance: () => allowance, sends: () => sends, api: ctx.api, W,
    restart: () => { ctx.RECOVERY = new RecoveryJournal(join(dir, 'recovery.json')); },
    allowCleanup: () => { cleanupFails = false; } };
}

test('actual watcher approval -> mint -> revoke verifies leftover zero', async (t) => {
  const f = await fixture(t); const result = await f.run();
  assert.ok(result.receipt); assert.equal(f.sends(), 3); assert.equal(f.allowance(), 0n); assert.equal(f.journal.get(wallet), null);
});

test('actual watcher cleans up when mint work fails', async (t) => {
  const f = await fixture(t, { workFails: true });
  await assert.rejects(f.run(), /mint failed/);
  assert.equal(f.sends(), 2); assert.equal(f.allowance(), 0n); assert.equal(f.journal.get(wallet), null);
});

test('actual watcher blocks a second grant after failed cleanup', async (t) => {
  const f = await fixture(t, { cleanupFails: true });
  await assert.rejects(f.run(), /清理未完成/); assert.equal(f.sends(), 3); assert.notEqual(f.allowance(), 0n);
  await assert.rejects(f.run(), /待恢復/); assert.equal(f.sends(), 3); assert.equal(f.journal.get(wallet).phase, 'cleanup');
});

test('actual watcher resumes only cleanup after restart, without reminting', async (t) => {
  const f = await fixture(t, { cleanupFails: true });
  await assert.rejects(f.run(), /清理未完成/);
  f.restart(); f.allowCleanup();
  await f.api.recoverWallet(f.W);
  assert.equal(f.sends(), 4); assert.equal(f.allowance(), 0n); assert.equal(f.journal.get(wallet), null);
});

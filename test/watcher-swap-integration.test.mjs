import { prepareFeeEvent, feeDay } from '../receipt-fees.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { ProjectBudget } from '../project-budget.mjs';
import { RecoveryJournal, WalletLease } from '../recovery-journal.mjs';
import { guardedSwap, waitForOrder, discoverApprovals } from '../swap-recovery.mjs';
import { applyOnce, writeState, strategyKey, tokenNet } from '../execution-state.mjs';

const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('async function recordFeeReceipt('), source.indexOf('async function adoptConfirmed(')) + source.slice(source.indexOf('async function finishSwap('), source.indexOf('\n/* 使用者 10/31 10:49'));
const wallet = '0x' + '1'.repeat(40), native = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', usdt = '0x55d398326f99059ff775485246999027b3197955';
const txHash = '0x' + 'a'.repeat(64);
function fixture(t, sale = false) {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-swap-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'recovery.json'); let sends = 0, state = 'FINISHED', blockReads = 0;
  const journal = new RecoveryJournal(path);
  const statePath = join(dir, 'state.json'); let failWrite = false;
  const token = usdt, receiver = '0x' + '2'.repeat(40);
  let sold = 100n;
  const order = { orderId: '123', chain: '56', fromToken: sale ? token : native, toToken: sale ? native : usdt, status: state, txHash, toTokenActualQty: '3.1', refund: sale ? [] : [{ amount: '0.0001', symbol: 'BNB' }] };
  const ctx = vm.createContext({
    PROJECT_BUDGET: new ProjectBudget(join(dir, 'budget.json'), 5_000_000n),
    S: { tokens: {}, dyn: [] }, STATE: statePath, applyOnce, strategyKey, tokenNet, wa: (a) => a.slice(2).padStart(64, '0'),
    writeState: (path, data) => { if (failWrite && data.trades?.length) throw new Error('disk full'); writeState(path, data); },
    CONFIG: { timeZone: 'Asia/Shanghai' }, prepareFeeEvent, feeDay,
    INFLIGHT: 0, RECOVERY: journal, WALLET_LEASE: new WalletLease(), guardedSwap, discoverApprovals,
    waitForOrder: (id, options) => waitForOrder(id, { ...options, attempts: 1 }), sleep: async () => {},
    rpc: async (method, params) => {
      if (method === 'eth_getBlockByNumber') return { number: params[0], timestamp: '0x' + Math.floor(Date.parse('2026-11-01T00:00:00Z') / 1000).toString(16) };
      if (method === 'eth_blockNumber') return ++blockReads === 1 ? '0x10' : '0x12';
      if (method === 'eth_getTransactionCount') return '0x1';
      if (method === 'eth_getLogs') return [];
      if (method === 'eth_call') return '0x' + (1000n - sold).toString(16).padStart(64, '0');
      assert.equal(method, 'eth_getTransactionReceipt');
      return { transactionHash: txHash, from: wallet, gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', blockNumber: '0x11', status: '0x1', logs: sale ? [{ address: token, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + wallet.slice(2).padStart(64, '0'), '0x' + receiver.slice(2).padStart(64, '0')], data: '0x' + sold.toString(16).padStart(64, '0') }] : [] };
    },
  });
  vm.runInContext(functions + '\nglobalThis.api = { swapConfirmed, recoverWallet };', ctx);
  const W = { addr: wallet, baw: async (args) => {
    assert.equal(args[0], 'market-order');
    if (args[1] === 'swap') { sends++; return { j: { success: true, data: { orderId: '123' } } }; }
    assert.equal(args[1], 'list'); assert.equal(args[3], '123');
    return { j: { success: true, data: { list: [{ ...order, status: state, txHash: state === 'FAILED' ? null : txHash }] } } };
  } };
  const args = ['market-order', 'swap', '--fromToken', order.fromToken, '--toToken', order.toToken, '--binanceChainId', '56', '--fromTokenQty', '0.004'];
  return { journal, sends: () => sends, state: (s) => { state = s; }, swap: () => ctx.api.swapConfirmed(W, args, sale ? { purpose: 'sale', token, requestedRaw: '100', sym: 'TOKEN', walletName: 'test.ai', bnbPrice: 700, effect: { mark: 'back', moonPend: true }, strategyState: { done2: [], hist: [], stage: 0 } } : { purpose: 'funding' }),
    failWrite: (v) => { failWrite = v; }, partial: () => { sold = 30n; }, stateData: () => ctx.S,
    recover: () => ctx.api.recoverWallet(W), restart: () => { ctx.RECOVERY = new RecoveryJournal(path); ctx.WALLET_LEASE = new WalletLease(); try { ctx.S = JSON.parse(readFileSync(statePath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; } } };
}

test('actual watcher swap waits for terminal order and retains actual fill/refund', async (t) => {
  const f = fixture(t); const result = await f.swap();
  assert.equal(result.j.success, true); assert.equal(result.j.data.toTokenActualQty, '3.1');
  assert.equal(result.j.data.refund[0].amount, '0.0001'); assert.equal(f.sends(), 1); assert.equal(f.journal.get(wallet), null);
});

test('actual watcher resumes an old funding order without reswapping', async (t) => {
  const f = fixture(t); f.state('PENDING');
  await assert.rejects(f.swap(), /待核實/); f.restart(); f.state('FINISHED');
  await f.recover(); assert.equal(f.sends(), 1); assert.equal(f.journal.get(wallet), null);
  await f.recover(); assert.equal(f.sends(), 1);
});

test('actual watcher reports terminal failed order as failed', async (t) => {
  const f = fixture(t); f.state('FAILED');
  assert.equal((await f.swap()).j.success, false); assert.equal(f.journal.get(wallet), null);
});

test('sale confirmed before a state write failure is adopted once after restart', async (t) => {
  const f = fixture(t, true); f.failWrite(true);
  await assert.rejects(f.swap(), /disk full/);
  assert.equal(f.sends(), 1); assert.equal(f.stateData().trades?.length || 0, 0);
  assert.ok(f.journal.get(wallet).terminal);
  f.restart(); f.failWrite(false); await f.recover();
  const state = f.stateData(), position = state.tokens[strategyKey(wallet, usdt)];
  assert.equal(state.trades.length, 1); assert.deepEqual([...position.done2], ['back']); assert.equal(position.moonPend, true);
  assert.equal(position.lastBal, '900'); assert.equal(f.journal.get(wallet), null); assert.equal(f.sends(), 1);
  f.restart(); await f.recover(); assert.equal(f.stateData().trades.length, 1);
});

test('crash after state commit but before journal acknowledgment does not double-account or resell', async (t) => {
  const f = fixture(t, true); f.journal.clear = () => { throw new Error('crash before acknowledgment'); };
  await assert.rejects(f.swap(), /acknowledgment/);
  assert.equal(f.stateData().trades.length, 1); f.restart(); await f.recover();
  assert.equal(f.sends(), 1); assert.equal(f.stateData().trades.length, 1);
  assert.deepEqual([...f.stateData().tokens[strategyKey(wallet, usdt)].done2], ['back']);
});

test('partial sale records actual outgoing tokens and pauses only that position', async (t) => {
  const f = fixture(t, true); f.partial(); await f.swap();
  const state = f.stateData(), position = state.tokens[strategyKey(wallet, usdt)];
  assert.equal(state.trades[0].soldRaw, '30'); assert.equal(position.lastBal, '970');
  assert.match(position.review, /部分成交/); assert.equal(position.done2.length, 0); assert.equal(f.journal.get(wallet), null);
});

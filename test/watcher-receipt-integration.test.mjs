import { prepareFeeEvent, feeDay } from '../receipt-fees.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { ProjectBudget } from '../project-budget.mjs';
import { executeGuarded } from '../guarded-contract-executor.mjs';
import { mintMetadata, prepareMintEvent } from '../mint-recovery.mjs';
import { applyOnce, writeState } from '../execution-state.mjs';
import { contractPrincipal } from '../contract-principal.mjs';
import { RecoveryJournal, WalletLease } from '../recovery-journal.mjs';

// Exercise the actual watcher entry point without starting its main loop,
// network fetches or real wallet CLI. The next declaration bounds the function.
const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function recordFeeReceipt(');
const end = source.indexOf('\nasync function poolOut(', start);
const tx = '0x' + 'a'.repeat(64), address = '0x' + '1'.repeat(40);

async function run(receipts, { value = 0n, entry = 'previewExec' } = {}) {
  let sends = 0, reads = 0;
  const dir = mkdtempSync(join(tmpdir(), 'watcher-integration-'));
  const ctx = vm.createContext({
    CONFIG: { timeZone: 'Asia/Shanghai' }, prepareFeeEvent, feeDay,
    mintRiskDecision: () => '', isSerial: () => false, codeOf: async () => '0x6001', fullCode: async () => '0x6001',
    INFLIGHT: 0, flapGuard: () => '', riskAfter: () => {},
    PROJECT_BUDGET: new ProjectBudget(join(dir, 'budget.json'), 1_200_000n),
    RECOVERY: new RecoveryJournal(join(dir, 'recovery.json')), WALLET_LEASE: new WalletLease(),
    mintMetadata, prepareMintEvent, applyOnce, writeState, STATE: join(dir, 'state.json'), FORCE: new Set(), tokStr: () => 'TOKEN', call: async () => '0x',
    contractPrincipal, executeGuarded: (args) => executeGuarded({ ...args, attempts: 3 }),
    USDT: '0x55d398326f99059ff775485246999027b3197955',
    wa: (a) => a.slice(2).padStart(64, '0'), bnbUsd: async () => 700,
    PAID: { maxUsd: 1.2 }, GO_PCT: 0.8, AG_MIN: 150,
    S: { tokens: {}, paid: { [address]: { agents: 150 } }, feeRefund: { [address]: 1 } },
    serialDev: async () => '', upgradeable: async () => false,
    freeProgress: async () => 1, riskBlock: async () => '',
    CANDS: [['mint', '0x12345678']], freshDeadline: (d) => d,
    sleep: async () => {},
    rpc: async (method, params) => {
      if (method === 'eth_getBlockByNumber') return { number: params[0], timestamp: '0x' + Math.floor(Date.parse('2026-11-01T00:00:00Z') / 1000).toString(16) };
      if (method === 'eth_call') {
        if (params[0].data.startsWith('0x6352211e')) return '0x' + address.slice(2).padStart(64, '0');
        return '0x' + (params[0].data.startsWith('0x70a08231') ? '1' : '0').padStart(64, '0');
      }
      if (method === 'eth_getBalance') return '0x2386f26fc10000';
      reads++; const receipt = receipts.shift() ?? null;
      if (receipt) Object.assign(receipt, { from: address, gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00' });
      if (receipt) receipt.logs = [{ address, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(64), '0x' + address.slice(2).padStart(64, '0'), ...(entry === 'autoMint' ? ['0x' + '1'.padStart(64, '0')] : [])], data: entry === 'autoMint' ? '0x' : '0x' + '1'.padStart(64, '0') }];
      return receipt;
    },
  });
  const autoStart = source.indexOf('async function autoMint(c,');
  const autoEnd = source.indexOf('\n// ---------- AIDROP', autoStart);
  vm.runInContext(source.slice(start, end) + '\n' + source.slice(autoStart, autoEnd) + `\nglobalThis.entry = ${entry};`, ctx);
  const W = { addr: address, name: 'test.ai', baw: async (args) => {
    if (args[1] === 'preview') return { j: { success: true, data: { requestId: 'request', simulationResult: { balanceChanges: [{ owner: address, contractAddress: address, tokenType: entry === 'autoMint' ? 'Erc721' : 'Erc20', change: '1' }] } } } };
    assert.equal(args[1], 'execute'); sends++;
    return { j: { success: true, data: { txHash: tx } } };
  } };
  try {
    const result = entry === 'autoMint' ? await ctx.entry(address, 'mint', { ...W, name: 'test.ai' }, value) : await ctx.entry(W, address, '0x', value, () => '');
    return { result, sends, reads, budget: ctx.PROJECT_BUDGET.read() };
  }
  catch (error) { return { error, sends, reads }; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('actual previewExec waits for its own successful receipt', async () => {
  const receipt = { transactionHash: tx, status: '0x1', blockNumber: '0x2' };
  const { result, sends, reads } = await run([null, receipt]);
  assert.equal(result.tx, tx); assert.equal(result.receipt, receipt);
  assert.equal(sends, 1); assert.equal(reads, 2);
});

test('actual paid autoMint uses the durable budget and confirms its receipt', async () => {
  const receipt = { transactionHash: tx, status: '0x1', blockNumber: '0x2' };
  const { result, sends, budget } = await run([receipt], { value: 1_000_000_000_000_000n, entry: 'autoMint' });
  assert.match(result, /已自動鑄造/); assert.equal(sends, 1);
  assert.equal(budget.projects[`${address}:${address}`].spent, '700000');
});

test('actual paid autoMint rejects over-budget value before submitting', async () => {
  const { result, sends } = await run([], { value: 8_000_000_000_000_000n, entry: 'autoMint' });
  assert.match(result, /上限/); assert.equal(sends, 0);
});

test('actual previewExec throws on failed or unknown outcome without resending', async () => {
  for (const receipts of [[{ transactionHash: tx, status: '0x0', blockNumber: '0x2' }], []]) {
    const { result, error, sends } = await run(receipts);
    assert.equal(result, undefined); assert.ok(error); assert.equal(sends, 1);
  }
});

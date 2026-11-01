import { prepareFeeEvent, feeDay } from '../receipt-fees.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { ProjectBudget } from '../project-budget.mjs';
import { RecoveryJournal, WalletLease } from '../recovery-journal.mjs';
import { executeGuarded } from '../guarded-contract-executor.mjs';
import { contractPrincipal } from '../contract-principal.mjs';
import { mintMetadata, prepareMintEvent } from '../mint-recovery.mjs';
import { applyOnce, writeState } from '../execution-state.mjs';

const source = readFileSync(new URL('../watch.mjs', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('async function recordFeeReceipt('), source.indexOf('\nasync function poolOut('));
const wallet = '0x' + '1'.repeat(40), token = '0x' + '2'.repeat(40), project = '0x' + '3'.repeat(40), txHash = '0x' + 'a'.repeat(64);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mint-adoption-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'state.json'), budgetPath = join(dir, 'budget.json');
  let sends = 0, failWrite = false, proofReads = 0;
  const ctx = vm.createContext({
    CONFIG: { timeZone: 'Asia/Shanghai' }, prepareFeeEvent, feeDay,
    mintRiskDecision: () => '', isSerial: () => false, codeOf: async () => '0x6001', fullCode: async () => '0x6001',
    INFLIGHT: 0, S: { tokens: {} }, STATE: statePath, FORCE: new Set(),
    PROJECT_BUDGET: new ProjectBudget(budgetPath, 1_200_000n), RECOVERY: new RecoveryJournal(join(dir, 'recovery.json')), WALLET_LEASE: new WalletLease(),
    mintMetadata, prepareMintEvent, applyOnce, executeGuarded, contractPrincipal,
    writeState: (p, data) => { if (failWrite && data.mintExecutions) throw new Error('disk full'); writeState(p, data); },
    USDT: '0x55d398326f99059ff775485246999027b3197955', wa: (a) => a.slice(2).padStart(64, '0'), bnbUsd: async () => 700,
    tokStr: () => 'TOKEN', call: async () => '0x', flapGuard: () => '', riskAfter: () => {}, riskBlock: async () => '', sleep: async () => {},
    rpc: async (method, params) => {
      if (method === 'eth_getBlockByNumber') return { number: params[0], timestamp: '0x' + Math.floor(Date.parse('2026-11-01T00:00:00Z') / 1000).toString(16) };
      if (method === 'eth_call') {
        if (params[0].data.startsWith('0x70a08231')) { proofReads++; return '0x' + '32'.padStart(64, '0'); }
        return '0x' + '0'.repeat(64);
      }
      assert.equal(method, 'eth_getTransactionReceipt');
      return { transactionHash: txHash, from: wallet, gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', status: '0x1', blockNumber: '0x2', logs: [{ address: token,
        topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(64), '0x' + wallet.slice(2).padStart(64, '0')], data: '0x' + '32'.padStart(64, '0') }] };
    },
  });
  vm.runInContext(functions + '\nglobalThis.api = { previewExec, recoverContractMints };', ctx);
  const W = { addr: wallet, name: 'test.ai', baw: async (args) => {
    if (args[1] === 'preview') return { j: { success: true, data: { requestId: 'req', simulationResult: { balanceChanges: [{ owner: wallet, contractAddress: token, tokenType: 'Erc20', change: '50' }] } } } };
    assert.equal(args[1], 'execute'); sends++; return { j: { success: true, data: { txHash } } };
  } };
  return { run: () => ctx.api.previewExec(W, project, '0x12345678', 1_000_000_000_000_000n, () => ''),
    recover: () => ctx.api.recoverContractMints(W), data: () => ctx.S, budget: () => ctx.PROJECT_BUDGET,
    sends: () => sends, proofReads: () => proofReads, failWrite: (v) => { failWrite = v; },
    failSettle: () => { ctx.PROJECT_BUDGET.settle = () => { throw new Error('crash before budget settlement'); }; },
    restart: () => { ctx.PROJECT_BUDGET = new ProjectBudget(budgetPath, 1_200_000n); ctx.WALLET_LEASE = new WalletLease(); try { ctx.S = JSON.parse(readFileSync(statePath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; ctx.S = { tokens: {} }; } } };
}

test('confirmed mint survives failure before holdings write; restart adopts without reminting', async (t) => {
  const f = fixture(t); f.failWrite(true); await assert.rejects(f.run(), /disk full/);
  assert.equal(f.sends(), 1); assert.equal(f.budget().pending(wallet, project).metadata.expected[0].token, token);
  f.restart(); f.failWrite(false); await f.recover();
  assert.equal(f.sends(), 1); assert.equal(f.data().dyn.length, 1); assert.equal(f.data().dyn[0].cost, 0.7);
  assert.equal(f.data().paid[project].done['test.ai'], 'minted'); assert.equal(f.budget().pending(wallet, project), null);
});

test('crash after holdings write but before budget settlement cannot double-count holdings or cost', async (t) => {
  const f = fixture(t); f.failSettle(); await assert.rejects(f.run(), /budget settlement/);
  assert.equal(f.data().dyn[0].cost, 0.7); const reads = f.proofReads();
  f.restart(); await f.recover();
  assert.equal(f.sends(), 1); assert.equal(f.data().dyn.length, 1); assert.equal(f.data().dyn[0].cost, 0.7);
  assert.equal(Object.keys(f.data().mintExecutions).length, 1); assert.equal(f.proofReads(), reads);
  f.restart(); await f.recover(); assert.equal(f.sends(), 1);
});

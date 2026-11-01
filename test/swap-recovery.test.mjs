import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecoveryJournal, WalletLease } from '../recovery-journal.mjs';
import { guardedSwap, waitForOrder, discoverApprovals } from '../swap-recovery.mjs';
const wallet = '0x' + '1'.repeat(40), txHash = '0x' + 'a'.repeat(64);
const receipt = { transactionHash: txHash, status: '0x1', blockNumber: '0x3' };
const order = { orderId: '123', status: 'FINISHED', txHash, toTokenActualQty: '0.01', refund: [{ amount: '0.1', symbol: 'USDT' }] };
const response = (o) => ({ j: { success: true, data: { list: [o] } } });
test('order submission is not completion; pending is polled, partial-fill data preserved', async () => {
  let reads = 0;
  const result = await waitForOrder('123', { lookup: async () => response(++reads === 1 ? { ...order, status: 'PENDING' } : order), rpc: async () => receipt, sleep: async () => {} });
  assert.equal(reads, 2); assert.equal(result.order, order); assert.equal(result.failed, false);
});
test('failed, missing, malformed and unknown orders never count as success', async () => {
  const options = { lookup: async () => response({ ...order, status: 'FAILED', txHash: null }), rpc: async () => receipt, sleep: async () => {}, attempts: 1 };
  assert.equal((await waitForOrder('123', options)).failed, true);
  await assert.rejects(waitForOrder('123', { ...options, lookup: async () => response({ ...order, orderId: 'different' }) }), /待核實/);
  await assert.rejects(waitForOrder('123', { ...options, lookup: async () => response({ ...order, toTokenActualQty: null }) }), /實際收到/);
  await assert.rejects(waitForOrder('123', { ...options, lookup: async () => response({ ...order, status: 'PENDING' }) }), /待核實/);
});
test('lost order id or timeout remains durable; restarting never submits another swap', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'swap-journal-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'recovery.json'); let sends = 0;
  const options = { journal: new RecoveryJournal(path), lease: new WalletLease(), wallet, args: [], getBlock: async () => '0x1',
    submit: async () => { sends++; return { j: { success: true, data: { orderId: '123' } } }; },
    finish: async () => { throw new Error('order pending'); } };
  await assert.rejects(guardedSwap(options), /pending/);
  assert.equal(new RecoveryJournal(path).get(wallet).orderId, '123');
  await assert.rejects(guardedSwap({ ...options, journal: new RecoveryJournal(path) }), /待恢復/);
  assert.equal(sends, 1);
});
test('discovers ERC20 spender changes in the operation block range; rejects nonstandard events', async () => {
  const token = '0x' + '2'.repeat(40), spender = '0x' + '3'.repeat(40);
  const rpc = async (method, [filter]) => {
    assert.equal(method, 'eth_getLogs'); assert.equal(filter.fromBlock, '0x1'); assert.equal(filter.toBlock, '0x3');
    return [{ address: token, transactionHash: txHash, topics: [...filter.topics, '0x' + spender.slice(2).padStart(64, '0')], data: '0x' + '0'.repeat(63) + '1' }];
  };
  assert.deepEqual(await discoverApprovals({ rpc, wallet, fromBlock: '0x1', toBlock: '0x3' }), [{ token, spender, txHashes: [txHash] }]);
  await assert.rejects(discoverApprovals({ wallet, fromBlock: '0x1', toBlock: '0x3', rpc: async () => [{ topics: [] }] }), /unsupported/);
});

test('restricted public log RPC falls back to complete block receipts without narrowing token coverage', async () => {
  const blockHash = '0x' + 'b'.repeat(64), secondHash = '0x' + 'c'.repeat(64);
  const spender = '0x' + '3'.repeat(40), tokens = ['0x' + '4'.repeat(40), '0x' + '5'.repeat(40)];
  const rpc = async (method, [arg]) => {
    if (method === 'eth_getLogs') throw new Error('Please specify an address in your request');
    if (method === 'eth_getBlockByNumber') return { number: arg, hash: blockHash, transactions: [txHash, secondHash] };
    assert.equal(method, 'eth_getBlockReceipts');
    return [txHash, secondHash].map((hash, index) => ({ blockNumber: arg, blockHash, transactionHash: hash, transactionIndex: '0x' + index,
      logs: [{ address: tokens[index], blockNumber: arg, blockHash, transactionHash: hash,
        topics: ['0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925', '0x' + wallet.slice(2).padStart(64, '0'), '0x' + spender.slice(2).padStart(64, '0')], data: '0x' + '1'.padStart(64, '0') }] }));
  };
  const result = await discoverApprovals({ rpc, wallet, fromBlock: '0x1', toBlock: '0x1' });
  assert.deepEqual(result.map((x) => x.token), tokens);
});

test('receipt fallback fails closed on incomplete blocks or excessive ranges', async () => {
  const rpc = async (method, [arg]) => {
    if (method === 'eth_getLogs') throw new Error('log limit');
    if (method === 'eth_getBlockByNumber') return { number: arg, hash: '0x' + 'b'.repeat(64), transactions: [txHash] };
    return [];
  };
  await assert.rejects(discoverApprovals({ rpc, wallet, fromBlock: '0x1', toBlock: '0x1' }), /incomplete/);
  await assert.rejects(discoverApprovals({ rpc, wallet, fromBlock: '0x1', toBlock: '0x100' }), /range/);
});

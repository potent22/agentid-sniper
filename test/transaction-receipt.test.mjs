import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForReceipt } from '../transaction-receipt.mjs';

const tx = '0x' + 'a'.repeat(64);
const ok = { transactionHash: tx, status: '0x1', blockNumber: '0x123' };
const sleep = async () => {};

test('RPC errors and pending receipts do not imply failure or trigger a resend', async () => {
  let reads = 0;
  const result = await waitForReceipt(tx, { sleep, attempts: 3, rpc: async (method, params) => {
    assert.equal(method, 'eth_getTransactionReceipt'); assert.deepEqual(params, [tx]);
    if (++reads === 1) throw new Error('RPC unavailable');
    return reads === 2 ? null : ok;
  } });
  assert.equal(result, ok); assert.equal(reads, 3);
});

test('reverted, malformed and missing receipts never report success', async () => {
  await assert.rejects(waitForReceipt(tx, { sleep, rpc: async () => ({ ...ok, status: '0x0' }) }), /鏈上失敗/);
  await assert.rejects(waitForReceipt(tx, { sleep, rpc: async () => ({ ...ok, transactionHash: '0x' + 'b'.repeat(64) }) }), /結果不明/);
  await assert.rejects(waitForReceipt(tx, { sleep, rpc: async () => ({ ...ok, blockNumber: null }) }), /結果不明/);
  await assert.rejects(waitForReceipt(tx, { sleep, attempts: 2, rpc: async () => null }), /逾時/);
  let calls = 0;
  await assert.rejects(waitForReceipt('', { sleep, rpc: async () => { calls++; } }), /結果不明/);
  assert.equal(calls, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mintMetadata, prepareMintEvent } from '../mint-recovery.mjs';
import { applyOnce } from '../execution-state.mjs';
const wallet = '0x' + '1'.repeat(40), token = '0x' + '2'.repeat(40), project = '0x' + '3'.repeat(40), txHash = '0x' + 'a'.repeat(64);
const topic = (a) => '0x' + a.slice(2).padStart(64, '0');
const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const expected = (type) => mintMetadata(wallet, 'test.ai', { balanceChanges: [{ owner: wallet, contractAddress: token, tokenType: type, change: '1' }] });
const receipt = { transactionHash: txHash, status: '0x1', blockNumber: '0x2', logs: [{ address: token, topics: [transfer, topic('0x' + '0'.repeat(40)), topic(wallet)], data: '0x' + '32'.padStart(64, '0') }] };

test('ERC20 holdings require receipt net inflow and a balance read at the confirmed block', async () => {
  const pending = { metadata: expected('Erc20'), ceiling: '2500000' };
  const event = await prepareMintEvent({ wallet, project, pending, receipt, rpc: async (method, params) => {
    assert.equal(method, 'eth_call'); assert.equal(params[1], '0x2');
    return '0x' + '64'.padStart(64, '0');
  } });
  assert.equal(event.tokens[0].receivedRaw, '50'); assert.equal(event.tokens[0].confirmedBalanceRaw, '100');
  const state = { tokens: {} }; applyOnce(state, event, () => {}); applyOnce(state, event, () => {});
  assert.equal(state.dyn.length, 1); assert.equal(state.dyn[0].cost, 2.5);
  assert.equal(Object.keys(state.mintExecutions).length, 1); assert.equal(state.paid[project].done['test.ai'], 'minted');
});

test('a simulation or unrelated wallet holding alone cannot prove a successful mint', async () => {
  await assert.rejects(prepareMintEvent({ wallet, project, pending: { metadata: expected('Erc20'), ceiling: '0' }, receipt: { ...receipt, logs: [] }, rpc: async () => '0x' + 'f'.repeat(64) }), /positive net/);
  const sentAway = { ...receipt.logs[0], topics: [transfer, topic(wallet), topic(project)] };
  await assert.rejects(prepareMintEvent({ wallet, project, pending: { metadata: expected('Erc20'), ceiling: '0' }, receipt: { ...receipt, logs: [...receipt.logs, sentAway] }, rpc: async () => '0x' + 'f'.repeat(64) }), /positive net/);
});

test('ERC721 ownership needs transfer proof and matching ownerOf; unsupported assets stop before submission', async () => {
  const nftReceipt = { ...receipt, logs: [{ ...receipt.logs[0], topics: [...receipt.logs[0].topics, '0x' + '9'.padStart(64, '0')], data: '0x' }] };
  const options = { wallet, project, pending: { metadata: expected('Erc721'), ceiling: '0' }, receipt: nftReceipt, rpc: async () => topic(wallet) };
  const event = await prepareMintEvent(options);
  assert.deepEqual(event.nftProof, [{ token, ids: ['9'] }]);
  await assert.rejects(prepareMintEvent({ ...options, rpc: async () => topic(project) }), /mismatch/);
  assert.throws(() => expected('Erc1155'), /unsupported/);
});

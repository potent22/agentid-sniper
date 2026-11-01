import test from 'node:test';
import assert from 'node:assert/strict';
import { contractPrincipal } from '../contract-principal.mjs';

const wallet = '0x' + '1'.repeat(40), to = '0x' + '2'.repeat(40);
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const base = { wallet, to, data: '0x', value: 0n, sim: { balanceChanges: [] }, allowance: async () => 0n, bnbPriceMicros: async () => 700_000_000n, max: 5_000_000n };
test('counts maximum BNB value plus USDT allowance and rounds up', async () => {
  const result = await contractPrincipal({ ...base, value: 4_000_000_000_000_000n, allowance: async () => 2n * 10n ** 18n });
  assert.equal(result.ceiling, 4_800_000n);
  await assert.rejects(contractPrincipal({ ...base, value: 5_000_000_000_000_000n, allowance: async () => 2n * 10n ** 18n }), /exceeded/);
  assert.equal((await contractPrincipal({ ...base, allowance: async () => 1n })).ceiling, 1n);
});
test('rejects unavailable price, malformed simulation and unbounded token debit', async () => {
  await assert.rejects(contractPrincipal({ ...base, value: 1n, bnbPriceMicros: async () => 0n }), /unavailable/);
  await assert.rejects(contractPrincipal({ ...base, sim: null }), /missing/);
  await assert.rejects(contractPrincipal({ ...base, sim: { balanceChanges: [{ owner: wallet, contractAddress: USDT, change: '-1' }] } }), /bounded/);
  await assert.rejects(contractPrincipal({ ...base, sim: { balanceChanges: [{ owner: wallet, contractAddress: to, change: '-1' }] } }), /unexpected/);
});
test('USDT approvals are capped, do not spend principal and bind to the spender', async () => {
  const data = '0x095ea7b3' + to.slice(2).padStart(64, '0') + (5n * 10n ** 18n).toString(16).padStart(64, '0');
  assert.deepEqual(await contractPrincipal({ ...base, to: USDT, data }), { project: to, ceiling: 0n });
  await assert.rejects(contractPrincipal({ ...base, to: USDT, data, value: 1n }), /approval/);
  await assert.rejects(contractPrincipal({ ...base, data }), /approval/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOnce, strategyKey, unitsToDecimal } from '../execution-state.mjs';
const wallet = '0x' + '1'.repeat(40), token = '0x' + '2'.repeat(40), txHash = '0x' + 'a'.repeat(64);
const event = { kind: 'sale', id: 'swap:123', txHash, wallet, orderId: '123', at: '2026-11-01T00:00:00Z',
  received: '0.01', remainingRaw: '100', soldRaw: '50', partial: false,
  metadata: { token, sym: 'TOKEN', walletName: 'test.ai', bnbPrice: 700, effect: { mark: 's10' }, strategyState: { hist: [], done2: [] } } };

test('durable commit precedes live mutation and applying a completed sale is idempotent', () => {
  const key = strategyKey(wallet, token), st = { hist: [], done2: [] }, state = { tokens: { [key]: st } };
  let writes = 0;
  assert.throws(() => applyOnce(state, event, () => { throw new Error('disk full'); }), /disk full/);
  assert.equal(state.trades, undefined); assert.deepEqual(st.done2, []);
  applyOnce(state, event, (snapshot) => { writes++; assert.equal(state.trades, undefined); assert.equal(snapshot.trades.length, 1); });
  assert.equal(state.tokens[key], st); assert.deepEqual(st.done2, ['s10']);
  assert.equal(applyOnce(state, event, () => { writes++; }), false);
  assert.equal(writes, 1); assert.equal(state.trades.length, 1);
  assert.throws(() => applyOnce(state, { ...event, txHash: '0x' + 'b'.repeat(64) }, () => {}), /conflicts/);
});

test('quantities retain raw precision, including zero-decimal and dust tokens', () => {
  assert.equal(unitsToDecimal(1n, 18), '0.000000000000000001');
  assert.equal(unitsToDecimal(123n, 0), '123');
  assert.equal(unitsToDecimal(1234500n, 4), '123.45');
  assert.throws(() => unitsToDecimal(-1n, 18));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectStartup, decimalWei } from '../preflight.mjs';
const wallet = '0x' + '1'.repeat(40), native = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const now = Date.parse('2026-11-01T00:00:00Z');
const config = { wallets: [{ name: 'test.ai', address: wallet }], paid: { maxUsd: 1.2, keepBnb: 0.006 }, telegram: {} };
const data = {
  status: { status: 'CONNECTED' }, address: { addresses: [{ binanceChainId: '56', address: wallet }] },
  'agent-id': { claimed: true, agentId: 'test.ai' }, settings: { devMode: { enabled: true, expiresAt: '2026-11-02T00:00:00Z', balanceExceeded: false }, abnormalTxnHandling: 'AutoReject', tradeAllTokens: false },
  balance: [{ address: native, binanceChainId: '56', balance: '0.01' }],
};
const base = {
  config, now, local: { stopMarker: true, recoveryClear: true, stateReadable: true, riskEvidenceReady: true },
  runCli: async (args) => { assert.equal(args[0], 'wallet'); assert.ok(Object.keys(data).includes(args[1])); return { success: true, data: data[args[1]] }; },
  rpc: async (method) => method === 'eth_chainId' ? '0x38' : '0x1',
};
test('preflight is read-only, preserves wallet policy and distinguishes a stop marker from configuration readiness', async () => {
  const result = await inspectStartup(base);
  assert.equal(result.ready, true); assert.equal(result.executionHeld, true);
  assert.equal(result.walletPolicy.abnormalTxnHandling, 'AutoReject'); assert.equal(result.warnings.length, 2);
  assert.equal(decimalWei('0.000000000000000001'), 1n);
});
test('wrong wallet, expired mode, low gas and outstanding recovery block readiness', async () => {
  const result = await inspectStartup({ ...base, local: { ...base.local, recoveryClear: false },
    runCli: async (args) => ({ success: true, data: args[1] === 'address' ? { addresses: [] } : args[1] === 'balance' ? [{ ...data.balance[0], balance: '0.0005' }] : args[1] === 'settings' ? { devMode: { enabled: false } } : data[args[1]] }) });
  assert.equal(result.ready, false);
  for (const name of ['wallet-address', 'developer-mode', 'gas-reserve', 'recovery-clear']) assert.equal(result.checks.find((x) => x.name === name).ok, false);
});
test('unavailable RPC and missing balance are failures rather than zero/healthy results', async () => {
  const result = await inspectStartup({ ...base, rpc: async () => { throw new Error('unavailable'); }, runCli: async (args) => ({ success: true, data: args[1] === 'balance' ? [] : data[args[1]] }) });
  assert.equal(result.ready, false); assert.equal(result.checks.find((x) => x.name === 'gas-reserve').ok, false);
  assert.ok(result.checks.some((x) => x.name === 'rpc-query' && !x.ok));
});

test('missing historical risk evidence prevents startup even when wallet checks pass', async () => {
  const result = await inspectStartup({ ...base, local: { ...base.local, riskEvidenceReady: false } });
  assert.equal(result.ready, false);
  assert.equal(result.checks.find((x) => x.name === 'mint-risk-evidence').ok, false);
});

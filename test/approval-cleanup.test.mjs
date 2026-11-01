import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupApproval } from '../approval-cleanup.mjs';

test('revokes remaining allowance and verifies the confirmed post-state', async () => {
  let allowance = 10n, revoked = 0;
  const tx = '0x' + '1'.repeat(64);
  const result = await cleanupApproval({
    readAllowance: async () => allowance,
    revoke: async () => { revoked++; return tx; },
    waitReceipt: async () => { allowance = 0n; return { status: '0x1' }; },
  });
  assert.equal(revoked, 1);
  assert.deepEqual(result, { revoked: true, tx, remaining: 0n });
});

test('unknown, failed or ineffective revocations fail closed', async () => {
  const tx = '0x' + '1'.repeat(64);
  await assert.rejects(cleanupApproval({ readAllowance: async () => null }), /could not be verified/);
  await assert.rejects(cleanupApproval({ readAllowance: async () => 1n, revoke: async () => '', waitReceipt: async () => ({ status: '0x1' }) }), /unknown/);
  await assert.rejects(cleanupApproval({ readAllowance: async () => 1n, revoke: async () => tx, waitReceipt: async () => ({ status: '0x0' }) }), /not confirmed/);
  await assert.rejects(cleanupApproval({ readAllowance: async () => 1n, revoke: async () => tx, waitReceipt: async () => ({ status: '0x1' }) }), /still present/);
});

// Callers provide chain-specific read/revoke/receipt functions. No wallet access
// takes place until the caller invokes this function with those dependencies.
export async function cleanupApproval({ readAllowance, revoke, waitReceipt }) {
  const allowance = await readAllowance();
  if (typeof allowance !== 'bigint' || allowance < 0n) throw new Error('allowance could not be verified');
  if (allowance === 0n) return { revoked: false, remaining: 0n };
  const tx = await revoke();
  if (typeof tx !== 'string' || !/^0x[0-9a-f]{64}$/i.test(tx)) throw new Error('revocation transaction is unknown');
  const receipt = await waitReceipt(tx);
  if (!receipt || receipt.status !== '0x1') throw new Error('revocation not confirmed');
  const remaining = await readAllowance();
  if (remaining !== 0n) throw new Error('allowance still present or unknown after revocation');
  return { revoked: true, tx, remaining };
}

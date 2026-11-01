// Language-neutral boundary values for the later Rust implementation.
export const OPERATION_STATES = Object.freeze(['prepared', 'submitted', 'confirmed', 'cleanup', 'completed', 'failed', 'unknown', 'cancelled']);
export function rawAmount(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw new Error('raw amount must be a decimal integer string');
  const amount = BigInt(value);
  if (amount >= 1n << 256n) throw new Error('raw amount exceeds uint256');
  return amount;
}
export function contractIntent({ chainId, wallet, contract, value, inputData }) {
  if (chainId !== '56' || !/^0x[0-9a-f]{40}$/i.test(wallet || '') || !/^0x[0-9a-f]{40}$/i.test(contract || '') || !/^0x([0-9a-f]{2})*$/i.test(inputData || '')) throw new Error('invalid contract intent');
  rawAmount(value);
  return Object.freeze({ schemaVersion: 1, chainId, wallet: wallet.toLowerCase(), contract: contract.toLowerCase(), value, inputData });
}

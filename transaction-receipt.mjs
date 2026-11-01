// Receipt reads only; this helper never broadcasts or retries a transaction.
export async function waitForReceipt(txHash, { rpc, sleep, attempts = 60, intervalMs = 2000, onReceipt = async () => {} }) {
  if (!/^0x[0-9a-f]{64}$/i.test(txHash || '')) throw new Error('結果不明：未取得有效交易雜湊，禁止重送');
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('invalid receipt polling limit');
  for (let i = 0; i < attempts; i++) {
    let receipt;
    try { receipt = await rpc('eth_getTransactionReceipt', [txHash]); } catch { /* RPC errors do not prove failure. */ }
    if (receipt) {
      if (String(receipt.transactionHash).toLowerCase() !== txHash.toLowerCase() || !/^0x[0-9a-f]+$/i.test(receipt.blockNumber || '')) throw new Error('結果不明：交易回執不完整或不符，禁止重送');
      if (['0x0', '0x1'].includes(receipt.status)) {
        await onReceipt(receipt);
        if (receipt.status === '0x1') return receipt;
        const error = new Error(`交易鏈上失敗：${txHash}`); error.receipt = receipt; throw error;
      }
      throw new Error('結果不明：未知交易回執狀態，禁止重送');
    }
    if (i + 1 < attempts) await sleep(intervalMs);
  }
  throw new Error(`結果不明：等待交易回執逾時，禁止重送：${txHash}`);
}

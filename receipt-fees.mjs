const integer = (value, field) => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error(`結果不明：缺少可核實的 ${field}`);
  return BigInt(value);
};
export function feeDay(timestampMs, timeZone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestampMs));
}
export async function prepareFeeEvent({ wallet, project, metadata, receipt, rpc, timeZone = 'Asia/Shanghai' }) {
  if (!/^0x[0-9a-f]{40}$/i.test(wallet) || !/^0x[0-9a-f]{40}$/i.test(receipt.from || '') || !['0x0', '0x1'].includes(receipt.status)) throw new Error('結果不明：費用付款人或回執狀態無法核實');
  const gasUsed = integer(receipt.gasUsed, 'gasUsed'), price = integer(receipt.effectiveGasPrice, 'effectiveGasPrice');
  if (gasUsed === 0n) throw new Error('結果不明：gasUsed 不完整');
  const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
  if (!block || block.number !== receipt.blockNumber || (receipt.blockHash && block.hash !== receipt.blockHash)) throw new Error('結果不明：費用所屬區塊不符');
  const timestamp = integer(block.timestamp, 'block timestamp');
  if (timestamp > 8_640_000_000_000n) throw new Error('invalid block timestamp');
  const paidByWallet = receipt.from.toLowerCase() === wallet.toLowerCase();
  return { kind: 'fee', id: `fee:56:${wallet.toLowerCase()}:${receipt.transactionHash}`, txHash: receipt.transactionHash,
    wallet: wallet.toLowerCase(), payer: receipt.from.toLowerCase(), project, status: receipt.status,
    gasUsed: gasUsed.toString(), effectiveGasPrice: price.toString(), transactionFeeWei: (gasUsed * price).toString(),
    walletGasWei: paidByWallet ? (gasUsed * price).toString() : '0', paidByWallet,
    day: feeDay(Number(timestamp) * 1000, timeZone), blockNumber: receipt.blockNumber,
    mint: metadata?.kind === 'mint', freeMint: metadata?.kind === 'mint' && metadata.freeMint === true };
}

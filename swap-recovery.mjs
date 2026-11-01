import { waitForReceipt } from './transaction-receipt.mjs';

export async function waitForOrder(orderId, { lookup, rpc, sleep, attempts = 30, recordReceipt = async () => {} }) {
  if (typeof orderId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(orderId)) throw new Error('結果不明：缺少有效兌換訂單編號');
  for (let i = 0; i < attempts; i++) {
    let order;
    try {
      const response = await lookup(orderId);
      if (response?.j?.success && Array.isArray(response.j.data?.list)) order = response.j.data.list.find((x) => String(x.orderId) === orderId);
    } catch { /* Query failure is not evidence that the order failed. */ }
    if (order?.status === 'FAILED') {
      if (order.txHash) {
        try { await waitForReceipt(order.txHash, { rpc, sleep, attempts, onReceipt: recordReceipt }); }
        catch (error) { if (error.receipt?.status === '0x0') return { order, receipt: error.receipt, failed: true }; throw error; }
        throw new Error('結果不明：訂單標示失敗但鏈上交易成功，需核對');
      }
      return { order, failed: true };
    }
    if (order?.status === 'FINISHED') {
      const receipt = await waitForReceipt(order.txHash, { rpc, sleep, attempts, onReceipt: recordReceipt });
      if (typeof order.toTokenActualQty !== 'string' || !/^\d+(\.\d+)?$/.test(order.toTokenActualQty) || !/[1-9]/.test(order.toTokenActualQty)) throw new Error('結果不明：訂單缺少實際收到數量');
      return { order, receipt, failed: false };
    }
    if (order && order.status !== 'PENDING') throw new Error('結果不明：未知兌換訂單狀態');
    if (i + 1 < attempts) await sleep(2000);
  }
  throw new Error('結果不明：兌換訂單仍待核實，禁止重複兌換');
}

export async function guardedSwap({ journal, lease, wallet, args, metadata = { purpose: 'funding' }, getBlock, submit, finish }) {
  return lease.run(wallet, async () => {
    journal.begin(wallet, { kind: 'swap', args, metadata, phase: 'prepared', fromBlock: await getBlock() });
    let response;
    try { response = await submit(args); }
    catch { throw new Error('結果不明：兌換送出異常，錢包已暫停'); }
    const orderId = response?.j?.data?.orderId;
    if (typeof orderId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(orderId)) throw new Error('結果不明：兌換未取得訂單編號，錢包已暫停');
    journal.update(wallet, { phase: 'submitted', orderId });
    return finish();
  });
}

const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
async function approvalLogsFromReceipts(rpc, owner, fromBlock, toBlock) {
  const first = BigInt(fromBlock), last = BigInt(toBlock);
  // Public nodes may prohibit unfiltered getLogs. Inspect the same full range
  // through block receipts; never narrow it to a guessed token-address list.
  if (last - first + 1n > 64n) throw new Error('approval discovery range exceeds receipt fallback limit');
  const logs = [];
  for (let number = first; number <= last; number++) {
    const tag = '0x' + number.toString(16);
    const [block, receipts] = await Promise.all([
      rpc('eth_getBlockByNumber', [tag, false]), rpc('eth_getBlockReceipts', [tag]),
    ]);
    if (!block || block.number !== tag || !/^0x[0-9a-f]{64}$/i.test(block.hash || '') || !Array.isArray(block.transactions)
      || !Array.isArray(receipts) || receipts.length !== block.transactions.length) throw new Error('incomplete approval discovery block');
    const indices = new Set();
    for (const receipt of receipts) {
      if (!/^0x[0-9a-f]+$/i.test(receipt.transactionIndex || '')) throw new Error('invalid receipt transaction index');
      const index = Number(BigInt(receipt.transactionIndex));
      if (indices.has(index) || receipt.blockNumber !== tag || receipt.blockHash !== block.hash
        || !/^0x[0-9a-f]{64}$/i.test(receipt.transactionHash || '') || receipt.transactionHash !== block.transactions[index]
        || !Array.isArray(receipt.logs)) throw new Error('incomplete or inconsistent approval discovery receipts');
      indices.add(index);
      for (const log of receipt.logs) {
        if (log.topics?.[0]?.toLowerCase() !== APPROVAL || log.topics?.[1]?.toLowerCase() !== owner) continue;
        if (log.blockHash !== block.hash || log.blockNumber !== tag || log.transactionHash !== receipt.transactionHash) throw new Error('inconsistent approval event receipt');
        logs.push(log);
      }
    }
  }
  return logs;
}
export async function discoverApprovals({ rpc, wallet, fromBlock, toBlock }) {
  if (!/^0x[0-9a-f]+$/i.test(fromBlock || '') || !/^0x[0-9a-f]+$/i.test(toBlock || '') || BigInt(fromBlock) > BigInt(toBlock) || !/^0x[0-9a-f]{40}$/i.test(wallet || '')) throw new Error('invalid approval discovery range');
  const owner = '0x' + wallet.toLowerCase().slice(2).padStart(64, '0');
  let logs;
  try { logs = await rpc('eth_getLogs', [{ fromBlock, toBlock, topics: [APPROVAL, owner] }]); }
  catch { logs = await approvalLogsFromReceipts(rpc, owner, fromBlock, toBlock); }
  if (!Array.isArray(logs)) throw new Error('approval discovery unavailable');
  const pairs = new Map();
  for (const log of logs) {
    if (log.removed || log.topics?.length !== 3 || log.topics[0]?.toLowerCase() !== APPROVAL || log.topics[1]?.toLowerCase() !== owner || !/^0x0{24}[0-9a-f]{40}$/i.test(log.topics[2]) || !/^0x[0-9a-f]{40}$/i.test(log.address) || !/^0x[0-9a-f]{64}$/i.test(log.data || '')) throw new Error('unsupported or inconsistent approval event');
    const token = log.address.toLowerCase(), spender = '0x' + log.topics[2].slice(26).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/i.test(log.transactionHash || '')) throw new Error('approval transaction hash unavailable');
    const key = `${token}:${spender}`, previous = pairs.get(key) || { token, spender, txHashes: [] };
    if (!previous.txHashes.includes(log.transactionHash)) previous.txHashes.push(log.transactionHash);
    pairs.set(key, previous);
  }
  return [...pairs.values()];
}

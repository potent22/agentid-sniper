import { randomUUID } from 'node:crypto';
import { waitForReceipt } from './transaction-receipt.mjs';
import { NotSubmittedError } from './src/domain/errors.mjs';

export async function executeGuarded({ budget, wallet, project, ceiling, metadata = null, applyConfirmed = async () => {}, recordReceipt = async () => {}, recoverOnly = false, submit, rpc, sleep, attempts = 60 }) {
  // Reconcile a prior submission first. Never execute the current request in
  // the same invocation as recovery; callers must not interpret recovery as mint success.
  const pending = budget.pending(wallet, project);
  if (pending) {
    if (!pending.txHash) throw new Error('結果不明：已有未取得雜湊的交易，保留預算，需人工核實');
    let receipt;
    try { receipt = await waitForReceipt(pending.txHash, { rpc, sleep, attempts, onReceipt: (r) => recordReceipt({ wallet, project, metadata: pending.metadata, receipt: r }) }); }
    catch (error) {
      if (error.message.startsWith('交易鏈上失敗：')) budget.settle(wallet, project, pending.id, 0n);
      throw error;
    }
    await applyConfirmed({ wallet, project, pending, receipt });
    budget.settle(wallet, project, pending.id, BigInt(pending.ceiling));
    if (recoverOnly) return { recovered: true, receipt };
    throw new Error(`結果不明：已核實先前交易成功並記帳，本輪不重送：${receipt.transactionHash}`);
  }
  if (recoverOnly) return { recovered: false };
  const id = randomUUID();
  // This write is synchronous and durable; failures prevent any submission.
  budget.reserve(wallet, project, id, ceiling, metadata);
  let result;
  try { result = await submit(); }
  catch (error) {
    // Only our local gateway can prove it never invoked the wallet CLI.
    if (error instanceof NotSubmittedError) { budget.settle(wallet, project, id, 0n); throw error; }
    throw new Error('結果不明：送出發生錯誤，保留預算，禁止重送');
  }
  const txHash = result?.j?.data?.txHash;
  if (!/^0x[0-9a-f]{64}$/i.test(txHash || '')) throw new Error('結果不明：送出未取得有效交易雜湊，保留預算，禁止重送');
  budget.recordTx(wallet, project, id, txHash);
  let receipt;
  try { receipt = await waitForReceipt(txHash, { rpc, sleep, attempts, onReceipt: (r) => recordReceipt({ wallet, project, metadata, receipt: r }) }); }
  catch (error) {
    if (error.message.startsWith('交易鏈上失敗：')) budget.settle(wallet, project, id, 0n);
    throw error;
  }
  // Charge the reserved upper bound, not an optimistic simulated net loss.
  // BNB refunds and unused USDT allowance do not reopen budget automatically.
  await applyConfirmed({ wallet, project, pending: budget.pending(wallet, project), receipt });
  budget.settle(wallet, project, id, ceiling);
  return { result, receipt };
}

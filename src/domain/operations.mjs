// Stable read model over the legacy journals. Missing references mean unknown,
// never failed. Only receipt/adoption code is allowed to complete an operation.
export function pendingOperations({ wallets, budget, recovery }) {
  const result = [];
  for (const wallet of wallets) {
    for (const pending of budget.pendingEntries(wallet)) {
      result.push({ schemaVersion: 1, kind: 'contract', wallet, contract: pending.project,
        operationId: pending.id, state: pending.txHash ? 'submitted' : 'unknown',
        txHash: pending.txHash || null, principalCeilingMicros: pending.ceiling });
    }
    const job = recovery.get(wallet);
    if (!job) continue;
    const state = job.phase === 'cleanup' ? 'cleanup' : job.phase === 'confirmed' ? 'confirmed' : job.kind === 'swap' && job.orderId ? 'submitted' : 'unknown';
    result.push({ schemaVersion: 1, kind: job.kind, wallet, state, phase: job.phase, operationId: job.operationId || null, orderId: job.orderId || null });
  }
  return result;
}

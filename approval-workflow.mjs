export async function withApproval({ journal, lease, wallet, token, spender, grant, work, cleanup }) {
  return lease.run(wallet, async () => {
    journal.begin(wallet, { kind: 'approval', token: token.toLowerCase(), spender: spender.toLowerCase(), phase: 'granting' });
    let result, operationError;
    try {
      await grant();
      journal.update(wallet, { phase: 'using' });
      result = await work();
    } catch (error) { operationError = error; }
    // Cleanup must be confirmed even when the work failed. Unknown grant/mint
    // outcomes make cleanup fail closed through the transaction budget journal.
    try {
      journal.update(wallet, { phase: 'cleanup' });
      await cleanup();
      journal.clear(wallet);
    } catch (error) {
      throw new Error(`結果不明：授權清理未完成，錢包已暫停：${error.message}`, { cause: operationError || error });
    }
    if (operationError) throw operationError;
    return result;
  });
}

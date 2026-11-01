import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecoveryJournal, WalletLease } from '../recovery-journal.mjs';
import { withApproval } from '../approval-workflow.mjs';

const wallet = '0x' + '1'.repeat(40), token = '0x' + '2'.repeat(40), spender = '0x' + '3'.repeat(40);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'recovery.json');
  return { path, journal: new RecoveryJournal(path), lease: new WalletLease(), wallet, token, spender };
}
test('task is durable before grant, and cleanup runs after success and failure', async (t) => {
  for (const fail of [false, true]) {
    const f = fixture(t); let cleaned = 0;
    const task = withApproval({ ...f,
      grant: async () => assert.equal(new RecoveryJournal(f.path).get(wallet).phase, 'granting'),
      work: async () => { assert.equal(f.journal.get(wallet).phase, 'using'); if (fail) throw new Error('mint reverted'); return 'minted'; },
      cleanup: async () => { cleaned++; assert.equal(f.journal.get(wallet).phase, 'cleanup'); },
    });
    if (fail) await assert.rejects(task, /mint reverted/); else assert.equal(await task, 'minted');
    assert.equal(cleaned, 1); assert.equal(f.journal.get(wallet), null);
  }
});
test('cleanup failure blocks a new grant even after restart', async (t) => {
  const f = fixture(t); let grants = 0;
  const options = { ...f, grant: async () => { grants++; }, work: async () => 'minted', cleanup: async () => { throw new Error('RPC down'); } };
  await assert.rejects(withApproval(options), /清理未完成/);
  await assert.rejects(withApproval({ ...options, journal: new RecoveryJournal(f.path) }), /待恢復/);
  assert.equal(grants, 1);
});
test('wallet lease allows nested cleanup but blocks concurrent unrelated work', async () => {
  const lease = new WalletLease(); let release;
  const first = lease.run(wallet, async () => {
    assert.equal(await lease.run(wallet, async () => 'nested'), 'nested');
    await new Promise((r) => { release = r; });
  });
  await new Promise((r) => setImmediate(r));
  await assert.rejects(lease.run(wallet, async () => {}), /另一筆/);
  release(); await first;
  assert.equal(await lease.run(wallet, async () => 'free'), 'free');
});
test('corrupt journal does not become an empty task list', (t) => {
  const f = fixture(t); writeFileSync(f.path, '{}');
  assert.throws(() => f.journal.get(wallet), /invalid/);
});

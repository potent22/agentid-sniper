import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
export function acquireInstanceLock(path, pid = process.pid) {
  // No silent stale-lock deletion. The operator must reconcile a prior instance.
  const fd = openSync(path, 'wx', 0o600);
  const token = `${pid}:${Date.now()}:${Math.random()}`;
  try { writeFileSync(fd, token); } finally { closeSync(fd); }
  return () => { if (readFileSync(path, 'utf8') !== token) throw new Error('instance lock owner changed'); unlinkSync(path); };
}

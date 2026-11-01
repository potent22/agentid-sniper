// Durable conservative per-project budget accounting, in millionths of a USDT.
// This module does not submit transactions or infer their outcomes.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const amount = (v) => {
  if (typeof v !== 'bigint' || v < 0n) throw new Error('amount must be a non-negative bigint');
  return v;
};

export class ProjectBudget {
  constructor(path, maxMicrousd) {
    this.path = path;
    this.max = amount(maxMicrousd);
    if (!this.max) throw new Error('budget must be positive');
  }
  read() {
    if (!existsSync(this.path)) return { version: 1, projects: {} };
    const data = JSON.parse(readFileSync(this.path, 'utf8'));
    if (data.version !== 1 || !data.projects || typeof data.projects !== 'object' || Array.isArray(data.projects)) throw new Error('invalid budget journal');
    for (const [key, record] of Object.entries(data.projects)) {
      const [wallet, project, extra] = key.split(':');
      if (!ADDRESS.test(wallet) || !ADDRESS.test(project) || extra !== undefined || !record || !/^\d+$/.test(record.spent)) throw new Error('invalid budget journal');
      if (record.pending !== null && (!record.pending || !/^[a-zA-Z0-9_-]{1,100}$/.test(record.pending.id) || !/^\d+$/.test(record.pending.ceiling) || (record.pending.txHash != null && !/^0x[0-9a-f]{64}$/i.test(record.pending.txHash)))) throw new Error('invalid budget journal');
    }
    return data;
  }
  save(data) {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(data)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.path);
    const dir = openSync(dirname(this.path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  withLock(fn) {
    mkdirSync(dirname(this.path), { recursive: true });
    const lock = `${this.path}.lock`;
    // A stale lock deliberately blocks all activity until manually reconciled.
    const fd = openSync(lock, 'wx', 0o600);
    try { return fn(); } finally { closeSync(fd); unlinkSync(lock); }
  }
  // One complete project workflow owns the reservation; uncertain outcomes stay
  // reserved across restarts and must be reconciled before another attempt.
  reserve(wallet, project, id, ceiling, metadata = null) {
    const w = String(wallet).toLowerCase(), p = String(project).toLowerCase();
    if (!ADDRESS.test(w) || !ADDRESS.test(p) || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('invalid reservation identity');
    ceiling = amount(ceiling);
    return this.withLock(() => {
    const data = this.read(), key = `${w}:${p}`;
    const record = data.projects[key] ||= { spent: '0', pending: null };
    const spent = BigInt(record.spent);
    if (record.pending) throw new Error('project has unresolved reservation');
    if (spent + ceiling > this.max) throw new Error('project budget exceeded');
    record.pending = { id, ceiling: ceiling.toString(), metadata };
    this.save(data);
    });
  }
  pending(wallet, project) {
    return this.read().projects[`${wallet.toLowerCase()}:${project.toLowerCase()}`]?.pending || null;
  }
  pendingEntries(wallet) {
    const prefix = wallet.toLowerCase() + ':';
    return Object.entries(this.read().projects).filter(([key, record]) => key.startsWith(prefix) && record.pending)
      .map(([key, record]) => ({ project: key.slice(prefix.length), ...record.pending }));
  }
  recordTx(wallet, project, id, txHash) {
    if (!/^0x[0-9a-f]{64}$/i.test(txHash || '')) throw new Error('invalid transaction hash');
    return this.withLock(() => {
      const data = this.read(), record = data.projects[`${wallet.toLowerCase()}:${project.toLowerCase()}`];
      if (!record?.pending || record.pending.id !== id) throw new Error('reservation missing or mismatched');
      record.pending.txHash = txHash;
      this.save(data);
    });
  }
  // Only call after all related transactions and costs have been verified.
  settle(wallet, project, id, actual) {
    return this.withLock(() => {
    const data = this.read(), key = `${String(wallet).toLowerCase()}:${String(project).toLowerCase()}`;
    const record = data.projects[key];
    if (!record?.pending || record.pending.id !== id) throw new Error('reservation missing or mismatched');
    actual = amount(actual);
    if (actual > BigInt(record.pending.ceiling)) throw new Error('actual exceeds reserved ceiling; reconciliation required');
    record.spent = (BigInt(record.spent) + actual).toString();
    record.pending = null;
    this.save(data);
    });
  }
}

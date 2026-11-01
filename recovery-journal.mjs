import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

export class RecoveryJournal {
  constructor(path) { this.path = path; }
  read() {
    if (!existsSync(this.path)) return { version: 1, wallets: {} };
    const data = JSON.parse(readFileSync(this.path, 'utf8'));
    if (data.version !== 1 || !data.wallets || typeof data.wallets !== 'object' || Array.isArray(data.wallets)) throw new Error('invalid recovery journal');
    for (const [wallet, job] of Object.entries(data.wallets)) {
      if (!/^0x[0-9a-f]{40}$/.test(wallet) || !job || !['approval', 'swap'].includes(job.kind)) throw new Error('invalid recovery job');
    }
    return data;
  }
  get(wallet) { return this.read().wallets[wallet.toLowerCase()] || null; }
  mutate(fn) {
    mkdirSync(dirname(this.path), { recursive: true });
    const lock = this.path + '.lock', fd = openSync(lock, 'wx', 0o600);
    try {
      const data = this.read(); fn(data.wallets);
      const tmp = this.path + '.' + process.pid + '.tmp', out = openSync(tmp, 'wx', 0o600);
      try { writeFileSync(out, JSON.stringify(data)); fsyncSync(out); } finally { closeSync(out); }
      renameSync(tmp, this.path);
      const dir = openSync(dirname(this.path), 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  begin(wallet, job) {
    wallet = wallet.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(wallet) || !['approval', 'swap'].includes(job.kind)) throw new Error('invalid recovery identity');
    this.mutate((jobs) => { if (jobs[wallet]) throw new Error('結果不明：錢包有待恢復操作，禁止新交易'); jobs[wallet] = job; });
  }
  update(wallet, patch) {
    this.mutate((jobs) => { if (!jobs[wallet.toLowerCase()]) throw new Error('recovery job missing'); Object.assign(jobs[wallet.toLowerCase()], patch); });
  }
  clear(wallet) { this.mutate((jobs) => { delete jobs[wallet.toLowerCase()]; }); }
}

// Serialize wallet activity across contract calls, approval workflows and swaps.
// Nested calls in the same workflow are allowed; concurrent unrelated work fails.
export class WalletLease {
  context = new AsyncLocalStorage();
  active = new Map();
  async run(wallet, fn) {
    wallet = wallet.toLowerCase();
    const held = this.active.get(wallet);
    if (held && this.context.getStore() === held) return fn();
    if (held) throw new Error('錢包正在處理另一筆操作，本輪跳過');
    const token = {}; this.active.set(wallet, token);
    try { return await this.context.run(token, fn); } finally { this.active.delete(wallet); }
  }
}

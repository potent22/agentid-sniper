import { NotSubmittedError } from '../domain/errors.mjs';
export class Activity {
  count = 0;
  stopping = false;
  tasks = new Set();
  track(promise) {
    const tracked = Promise.resolve(promise);
    this.tasks.add(tracked);
    tracked.then(() => this.tasks.delete(tracked), () => this.tasks.delete(tracked));
    return tracked;
  }
  stop() { this.stopping = true; }
  assertCanSend() {
    if (this.stopping) throw new NotSubmittedError();
  }
  async drain({ sleep, timeoutMs = 240000, now = Date.now }) {
    const deadline = now() + timeoutMs;
    while ((this.count > 0 || this.tasks.size > 0) && now() < deadline) await sleep(100);
    return this.count === 0 && this.tasks.size === 0;
  }
}

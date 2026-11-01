import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectBudget } from '../project-budget.mjs';

const wallet = '0x' + '1'.repeat(40), project = '0x' + '2'.repeat(40);
test('budget survives restart, rejects overspending and unresolved retries', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal.json');
  let budget = new ProjectBudget(path, 5_000_000n);
  budget.reserve(wallet, project, 'first', 3_000_000n);
  budget = new ProjectBudget(path, 5_000_000n);
  assert.throws(() => budget.reserve(wallet, project, 'retry', 1n), /unresolved/);
  assert.throws(() => budget.settle(wallet, project, 'first', 3_000_001n), /reconciliation/);
  assert.equal(JSON.parse(readFileSync(path)).projects[`${wallet}:${project}`].pending.id, 'first');
  budget.settle(wallet, project, 'first', 2_500_000n);
  assert.throws(() => budget.reserve(wallet, project, 'excess', 2_500_001n), /exceeded/);
  budget.reserve(wallet, project, 'second', 2_500_000n);
  budget.settle(wallet, project, 'second', 2_500_000n);
  assert.throws(() => budget.reserve(wallet, project, 'third', 1n), /exceeded/);
});

test('malformed journal or identity fails closed', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal.json'), budget = new ProjectBudget(path, 5_000_000n);
  assert.throws(() => budget.reserve(wallet, 'bad', 'first', 1n), /identity/);
  writeFileSync(path, 'not json');
  assert.throws(() => budget.reserve(wallet, project, 'first', 1n));
});

test('an existing lock prevents concurrent or unreconciled operations', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal.json'), budget = new ProjectBudget(path, 5_000_000n);
  writeFileSync(path + '.lock', 'busy');
  assert.throws(() => budget.reserve(wallet, project, 'first', 1n), /EEXIST/);
});

test('lowering the cap preserves older reservations while preventing new overspend', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal.json');
  new ProjectBudget(path, 5_000_000n).reserve(wallet, project, 'old', 3_000_000n);
  const budget = new ProjectBudget(path, 1_200_000n);
  budget.settle(wallet, project, 'old', 3_000_000n);
  assert.throws(() => budget.reserve(wallet, project, 'new', 1n), /exceeded/);
});

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { writeState } from '../../execution-state.mjs';
import { ProjectBudget } from '../../project-budget.mjs';
import { RecoveryJournal } from '../../recovery-journal.mjs';

// Read-only inspection shared by startup and preflight. A manifest binds the
// authoritative directory to its wallets; later starts require ALL ledgers.
export function inspectStore(dataRoot, config, { initialize = false, migrateLegacy = false } = {}) {
  const directory = realpathSync(dataRoot);
  const paths = Object.fromEntries(['watch_state', 'project_budget', 'recovery', 'runtime_manifest'].map((n) => [n, join(directory, n + '.json')]));
  const identity = { version: 1, dataRoot: directory, wallets: config.wallets.map((w) => w.address).sort() };
  const manifestExists = existsSync(paths.runtime_manifest);
  if (initialize && Object.values(paths).some(existsSync)) throw new Error('Cannot initialize an existing data directory');
  if (manifestExists) {
    const previous = JSON.parse(readFileSync(paths.runtime_manifest, 'utf8'));
    if (JSON.stringify(previous) !== JSON.stringify(identity)) throw new Error('Data root or wallet identity changed; reconcile before startup');
    for (const name of ['watch_state', 'project_budget', 'recovery']) if (!existsSync(paths[name])) throw new Error('Required ledger missing: ' + name);
  } else if (!existsSync(paths.watch_state) && !initialize) {
    throw new Error('Watcher state missing; explicit initialization is required for a NEW installation');
  } else if (!initialize && !migrateLegacy) {
    throw new Error('Legacy state requires an explicit, reconciled migration');
  }
  const state = existsSync(paths.watch_state) ? JSON.parse(readFileSync(paths.watch_state, 'utf8')) : { tokens: {}, lastBlock: 0, seenMints: {}, lastLoginAlert: 0 };
  if (!state || !state.tokens || typeof state.tokens !== 'object' || Array.isArray(state.tokens)) throw new Error('Invalid watcher state');
  const budget = new ProjectBudget(paths.project_budget, BigInt(Math.floor(config.paid.maxUsd * 1e6)));
  const recovery = new RecoveryJournal(paths.recovery);
  const budgetData = budget.read(), recoveryData = recovery.read();
  const legacySpend = Object.entries(state.paidSpend || {}).some(([key, value]) => key === 'day'
    ? typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    : typeof value !== 'number' || !Number.isFinite(value) || value !== 0);
  if (!existsSync(paths.project_budget) && (Object.keys(state.mintExecutions || {}).length || legacySpend || (state.dyn || []).some((t) => t.cost > 0))) throw new Error('Budget missing despite historical principal records');
  if (!existsSync(paths.recovery) && Object.values(budgetData.projects).some((p) => p.pending)) throw new Error('Recovery journal missing with unresolved contract operations');
  for (const entry of Object.values(state.tokens)) delete entry.verified;
  return { paths, identity, manifestExists, state, budget, recovery, budgetData, recoveryData };
}

// Call only while holding the process lock.
export function openStore(dataRoot, config, options = {}) {
  const { paths, identity, manifestExists, state, budget, recovery, budgetData, recoveryData } = inspectStore(dataRoot, config, options);
  // Existing legacy ledgers stay byte-for-byte intact during first migration.
  // Only absent never-used ledgers are initialized, before the manifest commit.
  if (!manifestExists) {
    if (!existsSync(paths.watch_state)) writeState(paths.watch_state, state);
    if (!existsSync(paths.project_budget)) writeState(paths.project_budget, budgetData);
    if (!existsSync(paths.recovery)) writeState(paths.recovery, recoveryData);
    writeState(paths.runtime_manifest, identity);
  }
  return { state, budget, recovery, statePath: paths.watch_state, save: () => writeState(paths.watch_state, state) };
}

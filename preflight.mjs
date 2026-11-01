// Read-only startup inspection. Does not import or start watch.mjs.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeState } from './execution-state.mjs';
import { validateConfig } from './src/domain/config.mjs';
import { inspectStore } from './src/runtime/store.mjs';
const executeFile = promisify(execFile);
const native = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export function decimalWei(value) {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,18})?$/.test(value)) throw new Error('invalid BNB amount');
  const [whole, part = ''] = value.split('.'); return BigInt(whole) * 10n ** 18n + BigInt(part.padEnd(18, '0'));
}
export async function inspectStartup({ config, runCli, rpc, now = Date.now(), local = {} }) {
  const checks = [];
  const check = (name, ok, detail, required = true) => checks.push({ name, ok: Boolean(ok), detail, ...(required ? {} : { required: false }) });
  let configValid = false;
  try { config = validateConfig(config); configValid = config.wallets.length === 1; } catch { /* Report invalid configuration without any network calls. */ }
  const wallet = config.wallets?.[0];
  check('configuration', configValid, 'one wallet; paid principal limit at most 1.2 USDT');
  if (!checks[0].ok) return { ready: false, checks, executionHeld: Boolean(local.stopMarker) };
  const requests = [
    ['status', ['wallet', 'status']], ['address', ['wallet', 'address']], ['identity', ['wallet', 'agent-id']],
    ['settings', ['wallet', 'settings']], ['balance', ['wallet', 'balance', '--binanceChainId', '56', '--symbol', 'BNB']],
  ];
  const responses = {};
  await Promise.all(requests.map(async ([name, args]) => {
    try { const response = await runCli(args); if (!response?.success) throw new Error(response?.error?.message || 'CLI query failed'); responses[name] = response.data; }
    catch (error) { check(name + '-query', false, error.message); }
  }));
  check('connected', responses.status?.status === 'CONNECTED', responses.status?.status || 'unknown');
  const chainAddress = responses.address?.addresses?.find((a) => String(a.binanceChainId) === '56')?.address;
  check('wallet-address', typeof chainAddress === 'string' && chainAddress.toLowerCase() === wallet.address.toLowerCase(), chainAddress || 'unavailable');
  check('agent-id', responses.identity?.claimed === true && responses.identity.agentId?.toLowerCase() === wallet.name.toLowerCase(), responses.identity?.agentId || 'unavailable');
  const mode = responses.settings?.devMode;
  const expiry = typeof mode?.expiresAt === 'number' ? mode.expiresAt * 1000 : Date.parse(mode?.expiresAt || '');
  check('developer-mode', mode?.enabled === true && Number.isFinite(expiry) && expiry > now && mode.balanceExceeded === false, { enabled: mode?.enabled, expiresAt: mode?.expiresAt, balanceExceeded: mode?.balanceExceeded });
  try {
    const bnb = Array.isArray(responses.balance) && responses.balance.find((b) => String(b.address).toLowerCase() === native && String(b.binanceChainId) === '56');
    const balance = decimalWei(bnb?.balance), reserve = decimalWei(String(config.paid?.keepBnb));
    check('gas-reserve', balance > reserve, { balance: bnb.balance, reserve: String(config.paid.keepBnb), unit: 'BNB' });
  } catch { check('gas-reserve', false, 'balance or reserve unavailable'); }
  try {
    const chain = await rpc('eth_chainId', []); check('rpc-chain', chain === '0x38', chain);
    const [latest, pending] = await Promise.all(['latest', 'pending'].map((tag) => rpc('eth_getTransactionCount', [wallet.address, tag])));
    check('wallet-nonce', /^0x[0-9a-f]+$/i.test(latest || '') && /^0x[0-9a-f]+$/i.test(pending || '') && BigInt(latest) === BigInt(pending), { latest, pending });
  } catch (error) { check('rpc-query', false, error.message); }
  check('recovery-clear', local.recoveryClear === true, local.recoveryDetail || 'no pending journals');
  check('state-readable', local.stateReadable === true, local.stateDetail || 'local state validated');
  check('project-budget-scope', true, 'owner accepts 1.2 USDT per wallet and mint contract; multiple contracts are not aggregated');
  check('mint-risk-evidence', local.riskEvidenceReady === true, 'historical deployment coverage and developer rug history are incomplete; owner waived this gate', false);
  check('automatic-swaps', false, 'automated swaps remain paused until Permit2 and other extra permissions can be verified and cleaned up', false);
  return { ready: checks.every((c) => c.ok || c.required === false), executionHeld: Boolean(local.stopMarker), checks,
    warnings: [...(!config.telegram?.botToken || !config.telegram?.chatId ? ['Telegram notifications are not configured.'] : []),
      'Historical deployment coverage and developer rug history remain unverified.',
      'A project using multiple mint contracts has a separate 1.2 USDT limit for each contract.',
      'Automated swaps, including funding and sales, are paused while Permit2 cleanup is unverified.',
      'Routing/permission compatibility remains subject to per-transaction checks; no trade was submitted.'],
    walletPolicy: { abnormalTxnHandling: responses.settings?.abnormalTxnHandling, tradeAllTokens: responses.settings?.tradeAllTokens }, checkedAt: new Date(now).toISOString() };
}

async function main() {
  const dir = dirname(fileURLToPath(import.meta.url)), config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  const local = { stopMarker: existsSync(join(dir, 'WATCH_STOP')), recoveryClear: false, stateReadable: false };
  try {
    const validated = validateConfig(config), { budget, recovery } = inspectStore(join(dir, 'data'), validated);
    local.recoveryClear = !budget.pendingEntries(validated.wallets[0].address).length && !recovery.get(validated.wallets[0].address);
    local.stateReadable = true;
  } catch (error) { local.stateDetail = error.message; local.recoveryDetail = error.message; }
  const runCli = async (args) => JSON.parse((await executeFile('baw', [...args, '--json'], { timeout: 60000, maxBuffer: 4 << 20 })).stdout);
  const urls = config.rpcs?.length ? config.rpcs : ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'];
  const rpc = async (method, params) => {
    for (const url of urls) {
      try {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) });
        const body = await response.json(); if (body.error || body.result == null) throw new Error('RPC unavailable'); return body.result;
      } catch { /* Next read-only provider. */ }
    }
    throw new Error('RPC unavailable');
  };
  const report = await inspectStartup({ config, runCli, rpc, local });
  writeState(join(dir, 'data', 'preflight.json'), report); console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

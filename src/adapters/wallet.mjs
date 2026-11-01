import { execFile } from 'node:child_process';
import { join } from 'node:path';
const mutation = (args) => ['contract-call execute', 'sign-message execute', 'market-order swap', 'approvals revoke', 'auth signin', 'auth verify', 'wallet send'].includes(args.slice(0, 2).join(' '));
const queries = new Set(['contract-call preview', 'market-order list', 'approvals list', 'wallet status', 'wallet settings', 'wallet address', 'wallet agent-id', 'wallet balance']);
export function walletView(gateway, { authentication = false } = {}) {
  return Object.freeze({ call(address, args, timeout) {
    const command = args.slice(0, 2).join(' ');
    if (!queries.has(command) && !(authentication && ['auth signin', 'auth verify'].includes(command))) throw new Error('Wallet capability denied: ' + command);
    return gateway.call(address, args, timeout);
  } });
}
export function createWalletGateway({ wallets, root, activity, executeFile = execFile, executable = 'baw', environment = process.env }) {
  const configured = new Map(wallets.map((w) => [w.address.toLowerCase(), w]));
  return {
    async call(address, args, timeout = 180000) {
      const wallet = configured.get(String(address).toLowerCase());
      if (!wallet || !Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\0'))) throw new Error('invalid wallet command');
      const key = args.slice(0, 2).join(' ');
      if (!queries.has(key) && !mutation(args)) throw new Error('Unsupported wallet command');
      if (mutation(args)) activity.assertCanSend();
      const command = wallet.bawDir ? process.execPath : executable;
      const input = wallet.bawDir ? [join(root, wallet.bawPkg || 'baw2pkg', 'node_modules', '@binance', 'agentic-wallet', 'dist', 'index.js'), ...args, '--json'] : [...args, '--json'];
      const env = wallet.bawDir ? { ...environment, BINANCE_BAW_DIR: join(root, wallet.bawDir), BINANCE_INSTANCE_ID: wallet.instanceId || wallet.name } : environment;
      return activity.track(new Promise((resolve) => executeFile(command, input, { shell: false, env, windowsHide: true, timeout, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
        const text = String(stdout || stderr || error?.message || ''); let parsed = null;
        try { parsed = JSON.parse(text.slice(text.indexOf('{'))); } catch { /* Not an authenticated successful response. */ }
        resolve({ t: text, j: parsed });
      })));
    },
  };
}

import { readFileSync } from 'node:fs';
export const MAX_PRINCIPAL_USDT = 1.2;
export function validateConfig(input) {
  const config = structuredClone(input);
  if (!Array.isArray(config.wallets) || config.wallets.length !== 1) throw new Error('This installation requires exactly one wallet');
  const seen = new Set();
  for (const wallet of config.wallets) {
    if (typeof wallet.name !== 'string' || !wallet.name.trim() || !/^0x[0-9a-f]{40}$/i.test(wallet.address || '')) throw new Error('invalid wallet configuration');
    wallet.address = wallet.address.toLowerCase();
    if (seen.has(wallet.address)) throw new Error('duplicate wallet');
    seen.add(wallet.address);
  }
  if (!Number.isFinite(config.paid?.maxUsd) || config.paid.maxUsd <= 0 || config.paid.maxUsd > MAX_PRINCIPAL_USDT) throw new Error(`paid.maxUsd must be positive and at most ${MAX_PRINCIPAL_USDT}`);
  config.timeZone ||= 'Asia/Shanghai';
  new Intl.DateTimeFormat('en', { timeZone: config.timeZone });
  return config;
}
export const loadConfig = (path) => validateConfig(JSON.parse(readFileSync(path, 'utf8')));

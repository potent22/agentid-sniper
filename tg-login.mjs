import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
let TelegramClient, StringSession;
try { ({ TelegramClient } = req('telegram')); ({ StringSession } = req('telegram/sessions')); }
catch { console.error('Install the optional dependency first: npm install --no-save --package-lock=false telegram@2.26.22'); process.exit(1); }
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async text => (await rl.question(text)).trim();
let client;
try {
  const apiId = Number(await ask('Telegram api_id: ')), apiHash = await ask('Telegram api_hash: ');
  if (!Number.isInteger(apiId) || apiId <= 0 || !/^[0-9a-f]{32}$/i.test(apiHash)) throw new Error('Invalid Telegram API configuration');
  client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
  await client.start({ phoneNumber: () => ask('Phone number: '), phoneCode: () => ask('Telegram login code: '), password: () => ask('Telegram 2FA password: '), onError: () => {} });
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'tg_user.json'), JSON.stringify({ apiId, apiHash, session: client.session.save() }), { mode: 0o600 });
  chmodSync(join(root, 'data', 'tg_user.json'), 0o600);
  console.log('Login saved locally. Enable telegram.monitorGroups in config.json to read groups. Never share data/tg_user.json.');
} finally { rl.close(); if (client) await client.disconnect(); }

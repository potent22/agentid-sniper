import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfiguration } from '../src/modules/configuration.mjs';
import { createDiscovery } from '../src/modules/discovery.mjs';
import { createPaymentRules } from '../src/modules/payment-rules.mjs';
import { createMarketData } from '../src/modules/market-data.mjs';
import { createChainValues } from '../src/modules/chain-values.mjs';
import { createSocial } from '../src/modules/social.mjs';
import { publicV4, readPublicPage } from '../src/adapters/public-web.mjs';
import { createTransactions } from '../src/modules/transactions.mjs';
const values = createChainValues({});
test('entry thresholds persist and stay inside selected ranges', () => {
  const S = {}; let writes = 0;
  const deps = { CONFIG: {}, configuredBudget: 1.2, S, save: () => writes++, random: () => 0.5 };
  const first = createConfiguration(deps), second = createConfiguration({ ...deps, random: () => 0 });
  assert.equal(first.GO_PCT, 0.65); assert.equal(first.AG_MIN, 115);
  assert.equal(second.GO_PCT, first.GO_PCT); assert.equal(second.AG_MIN, first.AG_MIN); assert.equal(writes, 1);
  assert.throws(() => createConfiguration({ ...deps, S: { entryThresholds: { version: 1, progress: 0.1, agents: 1 } } }));
});
test('heat counts verified transaction senders rather than airdrop recipients and resets old counts', async () => {
  const from = '0x' + '1'.repeat(40), recipient = '0x' + '2'.repeat(40), c = '0x' + '3'.repeat(40), hash = '0x' + 'a'.repeat(64);
  const S = { paid: { [c]: { agents: 999 } } }, P = S.paid[c];
  const discovery = createDiscovery({ ...values, S, WALLETS: [], scheduler: {}, call: async () => '0x',
    rpc: async method => method === 'eth_blockNumber' ? '0x10000' : [{ transactionHash: hash, topics: [values.T_TRANSFER, '0x' + recipient.slice(2).padStart(64,'0')], blockNumber: '0xffff' }],
    rpcBatch: async requests => requests.map(q => q.method === 'eth_getTransactionByHash' ? { hash, from, blockNumber: '0xffff' } : '0x' + '1'.padStart(64,'0')) });
  await discovery.heatOf(c, P); assert.equal(P.agents, 1); assert.equal(S.agentsV, 2);
});
test('paid limit detection supports per-transaction caps and rejects unavailable evidence', async () => {
  const selector = values.keccakHex(Buffer.from('maxPerTx()').toString('hex')).slice(0,8);
  const rules = createPaymentRules({ ...values, codeOf: async () => '0x' + selector, fullCode: async (_c, code) => code, call: async () => '0x' + 'a'.padStart(64,'0') });
  assert.equal(await rules.walletLimit('test'), 10);
  assert.equal(await createPaymentRules({ ...values, codeOf: async () => '0x', fullCode: async () => '0x', call: async () => null }).walletLimit('test'), 0);
});
test('unavailable BNB price uses cached or default estimate with a warning', async () => {
  let warnings = 0; const S = { lastBnbUsd: 700 };
  const market = createMarketData({ ...values, S, call: async () => null, tg: async () => warnings++ });
  assert.equal(await market.bnbUsd(), 700); assert.equal(S.bnbPriceEstimated, true); assert.equal(warnings, 1);
  delete S.lastBnbUsd; assert.equal(await market.bnbUsd(), 600);
});
test('Telegram monitor is inert while disabled; inscription discovery only notifies', async () => {
  let notes = 0; const social = createSocial({ ...values, CONFIG: {}, DIR: '/unused', S: {}, activity: { stopping: false }, call: async () => '0x' + '1'.padStart(64,'0'), tg: async () => notes++ });
  await social.socialPoll(); social.noteTransactions(Array.from({length:12},(_,i)=>({ from:'0x'+(i+1).toString(16).padStart(40,'0'),input:'0x'+Buffer.from('data:,{"tick":"example"}').toString('hex') })));
  await social.inscriptionPoll(); await social.inscriptionPoll(); assert.equal(notes, 1); await social.close();
});
test('website discovery refuses private hosts, credentials and non-HTTPS URLs', async () => {
  for (const ip of ['127.0.0.1','10.0.0.1','192.168.1.1','169.254.169.254','172.16.0.1','100.64.0.1']) assert.equal(publicV4(ip), false);
  assert.equal(publicV4('1.1.1.1'), true);
  await assert.rejects(readPublicPage('http://example.com','example.com'));
  const authenticated = new URL('https://example.com');
  authenticated.username = 'fixture-user'; authenticated.password = 'fixture-password';
  await assert.rejects(readPublicPage(authenticated.href,'example.com'));
  await assert.rejects(readPublicPage('https://evil.example','example.com'));
});

test('hot websites require independent mentions and only add verified contracts to tracking', async () => {
  const S = {}, c = '0x' + '3'.repeat(40); let reads = 0;
  const social = createSocial({ ...values, S, CONFIG: {}, DIR:'/unused', activity:{stopping:false}, ts:()=> 'test',
    readPage: async () => { reads++; return '<title>Example</title>' + c; }, rpc:async()=> '0x6001', tg:async()=>{}, log:()=>{} });
  social.noteUrls('https://sample.example', {senderId:1}, 'group1');
  await social.hotUrls(); assert.equal(reads,0);
  social.noteUrls('https://sample.example', {senderId:2}, 'group2');
  await social.hotUrls(); assert.equal(reads,1); assert.equal(S.paid[c].fromUrl,'sample.example');
});

test('paid allowance grants cannot skip the contract-limit gate even when risk checks pass', async () => {
  const wallet = '0x'+'1'.repeat(40), c='0x'+'2'.repeat(40);
  const tx = createTransactions({ ...values, PROJECT_BUDGET:{pendingEntries:()=>[]}, RECOVERY:{get:()=>null},
    WALLET_LEASE:{run:async (_wallet,fn)=>fn()}, enforceMintRisk:async()=>{}, walletLimit:async()=>0 });
  await assert.rejects(tx.submitContract({addr:wallet},values.USDT,'0x095ea7b3'+values.wa(c)+values.w(1n),0n,'test',{}),/限额/);
});

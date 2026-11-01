import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readPublicPage } from '../adapters/public-web.mjs';
export const noLink = (x) => String(x || '').replace(/https?:\/\/\S+|www\.\S+|\b[\w-]+\.(xyz|com|io|org|net|app|online|fun|site|top|cc|me|link|vip|pro|club|live|info)\b\S*/gi, '[連結已移除]').slice(0, 160);
export function createSocial({CONFIG, activity, DIR, S, INFRA, USDT, WBNB, rpc, call, REGISTRY, wa, tokStr, log, tg, ts, sleep, readPage = readPublicPage}) {
const URL_SKIP = /(^|\.)(x\.com|twitter\.com|t\.me|telegram\.(org|me)|binance\.(com|info)|github\.com|dexscreener\.com|bscscan\.com|etherscan\.io|youtube\.com|youtu\.be|google\.com|gmgn\.ai|geckoterminal\.com|coingecko\.com|coinmarketcap\.com|four\.meme|pancakeswap\.finance|medium\.com|discord\.(gg|com)|instagram\.com|tiktok\.com|okx\.com|bitget\.com|debank\.com|dextools\.io|ave\.ai|mirror\.xyz|notion\.(so|site)|gitbook\.io|docs\.google\.com|linktr\.ee|bit\.ly|tinyurl\.com|facebook\.com|reddit\.com|weibo\.com|bilibili\.com|apple\.com|claude\.ai|openai\.com|chatgpt\.com|pump\.fun|flap\.sh|axiom\.trade|bullx\.io|photon-sol\.tinyastro\.io|poocoin\.app|birdeye\.so|solscan\.io|basescan\.org|arbiscan\.io|tronscan\.org|dexview\.com|web3\.okx\.com|debot\.ai|xxyy\.io|binance\.us|bnbchain\.org)$/i;
function noteUrls(t, m, chatId) {
  const urls = [...(t.match(/https?:\/\/[^\s<>"'）)】]+/gi) || [])]; for (const e of m.entities || []) if (e.url) urls.push(e.url);
  for (const d of t.match(/\b[a-z0-9][a-z0-9-]{1,40}\.(xyz|fun|online|io|app|site|ai|top|meme|vip|pro|club|live|link|cc|me|world|tech|finance|money|gg|lol|wtf|bot|agent|net|org|com)\b/gi) || []) urls.push('https://' + d);
  S.urlHits = S.urlHits || {}; const sender = String(m.senderId || m.fromId?.userId || '?');
  for (const u of new Set(urls)) { let host = ''; try { host = new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { continue; } if (!host.includes('.') || URL_SKIP.test(host)) continue;
    const h = (S.urlHits[host] = S.urlHits[host] || { chats: {}, senders: {}, first: Date.now(), url: u }); h.chats[chatId] = Date.now(); h.senders[sender] = Date.now(); }
}
async function siteScan(host, url) { /* 只讀網頁文字：不連錢包、不簽名、不執行網站上的程式；只抓網頁裡列出的合約地址 */
  const get = (u) => readPage(u, host).catch(() => '');
  let html = await get(url.startsWith('https://') ? url : 'https://' + host + '/'); if (!html && url !== 'https://' + host + '/') html = await get('https://' + host + '/');
  let text = html; const title = noLink(((html.match(/<title[^>]*>([^<]{1,80})/i) || [])[1] || '').trim());
  if (!(html.match(/0x[a-fA-F0-9]{40}/g) || []).some((x) => !INFRA.has(x.toLowerCase()))) for (const src of [...new Set([...html.matchAll(/<(?:script|link)[^>]+(?:src|href)=["']([^"']+\.(?:json|js)(?:\?[^"']*)?)["']/gi)].map((x) => x[1]))].sort((x, y) => (y.endsWith('.json') ? 1 : 0) - (x.endsWith('.json') ? 1 : 0)).slice(0, 5)) { /* 網站常把合約地址放在 deployment.json 或主程式檔裡 */ let su = ''; try { su = new URL(src, 'https://' + host + '/').href; } catch { continue; } text += await get(su); }
  const addrs = [...new Set((text.match(/0x[a-fA-F0-9]{40}/g) || []).map((x) => x.toLowerCase()))].filter((a) => !INFRA.has(a) && !/^0x0{40}$/.test(a) && a !== USDT && a !== WBNB).slice(0, 8);
  const cs = []; for (const a of addrs) { const code = ((await rpc('eth_getCode', [a, 'latest']).catch(() => '')) || '').toLowerCase(); if (code.length > 2) cs.push(a); }
  return { title, cs };
}
async function hotUrls() {
  if (!S.urlHits) return; S.urlNoted = S.urlNoted || {};
  for (const [host, h] of Object.entries(S.urlHits)) {
    for (const o of [h.chats, h.senders]) for (const [k, t] of Object.entries(o)) if (Date.now() - t > 86400e3) delete o[k];
    const nc = Object.keys(h.chats).length, ns = Object.keys(h.senders).length; if (!nc && Date.now() - h.first > 86400e3) { delete S.urlHits[host]; continue; }
    if (S.urlNoted[host] || !(nc >= 2 || ns >= 3)) continue; /* 使用者 11/1 18:03：門檻降低，更早發現（安小將湊滿 3 群 5 人時已經快賣完） */ S.urlNoted[host] = ts();
    const { title, cs } = await siteScan(host, h.url).catch(() => ({ title: '', cs: [] }));
    for (const c of cs) { S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: title || host, done: {}, fromUrl: host }; (S.grpHits = S.grpHits || {})[c] = S.grpHits[c] || { chats: {}, first: Date.now(), names: [] }; Object.assign(S.grpHits[c].chats, h.chats); }
    log(`🌐 熱門網址：${host}（${nc} 個群、${ns} 個人在傳）${title ? '「' + title + '」' : ''} → 網站上的合約：${cs.join('、') || '找不到'}`);
    await tg(`🌐 ${nc} 個群、${ns} 個人在傳：${host}${title ? '\n' + title : ''}\n${cs.length ? '網站上的合約（已加入追蹤，打不打照鏈上規則）：\n' + cs.join('\n') : '網站上找不到合約地址（可能要連錢包後才顯示），要看的話手動處理'}`);
  }
  const ks = Object.keys(S.urlHits); if (ks.length > 5000) for (const k of ks.slice(0, ks.length - 5000)) delete S.urlHits[k];
  const kn = Object.keys(S.urlNoted); if (kn.length > 3000) for (const k of kn.slice(0, kn.length - 3000)) delete S.urlNoted[k];
}
let _tgc = null, _tgBusy = false, _tgDialogsAt = 0, _tgDialogs = [];
async function tgGroupWatch() {
  const f = join(DIR, 'data', 'tg_user.json'); if (!CONFIG.telegram?.monitorGroups || activity.stopping || !existsSync(f) || _tgBusy) return; _tgBusy = true;
  try {
    if (!_tgc) { const { createRequire } = await import('module'); const req = createRequire(import.meta.url); const { TelegramClient } = req('telegram'); const { StringSession } = req('telegram/sessions'); const u = JSON.parse(readFileSync(f, 'utf8')); _tgc = new TelegramClient(new StringSession(u.session), u.apiId, u.apiHash, { connectionRetries: 5 }); try { _tgc.setLogLevel('none'); } catch {} await _tgc.connect(); log('TG 群組監控：已連線（只讀）'); }
    if (Date.now() - _tgDialogsAt > 600e3) { _tgDialogs = (await _tgc.getDialogs({ limit: 300 })).filter((d) => d.isGroup || d.isChannel); _tgDialogsAt = Date.now(); try { writeFileSync(join(DIR, 'data', 'tg_groups.txt'), _tgDialogs.map((d) => `${d.isChannel && !d.isGroup ? '頻道' : '群組'}\t${d.entity?.username ? '@' + d.entity.username : '-'}\t${String(d.title || d.name || '').replace(/\s+/g, ' ')}`).join('\n')); } catch {} }
    S.tgLast = S.tgLast || {}; S.grpHits = S.grpHits || {}; let n = 0;
    for (const d of _tgDialogs) {
      if (activity.stopping) break;
      const id = String(d.id); const top = d.message?.id || 0; const last = S.tgLast[id];
      if (last == null) { S.tgLast[id] = top; continue; } /* 第一次只記位置，不回頭讀舊訊息 */
      if (top <= last) continue; if (n++ >= 12) break; /* 每分鐘最多讀 12 個有新訊息的群，慢慢讀 */
      await sleep(1500);
      const msgs = await _tgc.getMessages(d.entity, { limit: 50, minId: last }).catch(() => []);
      let mx = last; for (const m of msgs) { if (m.id > mx) mx = m.id; const t = String(m.message || ''); noteUrls(t, m, id); for (const c of new Set((t.match(/0x[a-fA-F0-9]{40}/g) || []).map((x) => x.toLowerCase()))) { if (INFRA.has(c)) continue; const h = (S.grpHits[c] = S.grpHits[c] || { chats: {}, first: Date.now(), names: [] }); h.chats[id] = Date.now(); const nm = String(d.title || d.name || '').slice(0, 20); if (nm && !h.names.includes(nm)) h.names.push(nm); } }
      S.tgLast[id] = Math.max(mx, top);
    }
    for (const [c, h] of Object.entries(S.grpHits)) {
      for (const [k, t] of Object.entries(h.chats)) if (Date.now() - t > 86400e3) delete h.chats[k];
      const cnt = Object.keys(h.chats).length; if (!cnt && Date.now() - h.first > 86400e3) { delete S.grpHits[c]; continue; }
      if (cnt >= 3 && !h.noted) { h.noted = 1; const code = ((await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || ''); if (code.length <= 2) continue;
        let nm = tokStr(await call(c, '0x95d89b41')) || tokStr(await call(c, '0x06fdde03')) || c.slice(0, 10);
        S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: nm, done: {}, fromGroups: cnt };
        log(`💬 TG 群組熱議：${nm} ${c} 24 小時內有 ${cnt} 個群在討論（${h.names.slice(0, 5).join('、')}），加入追蹤，照鏈上規則決定打不打`);
        await tg(`💬 ${cnt} 個 TG 群在討論：${nm}\n${h.names.slice(0, 5).join('、')}\n${c}\n已加入追蹤，打不打照鏈上規則（進度、Agent ID 錢包數、保本）`); }
    }
    const ks = Object.keys(S.grpHits); if (ks.length > 5000) for (const k of ks.slice(0, ks.length - 5000)) delete S.grpHits[k];
    await hotUrls().catch((e) => log('熱門網址：' + String(e.message || e).slice(0, 80)));
  } catch (e) { log('TG 群組監控：' + String(e.message || e).slice(0, 100)); if (/AUTH_KEY|SESSION|UNREGISTERED|revoked/i.test(String(e.message))) { _tgc = null; if (!S.tgAuthWarn || Date.now() - S.tgAuthWarn > 86400e3) { S.tgAuthWarn = Date.now(); await tg('⚠️ TG 群組監控登入失效了，請重新執行 tg_login.bat（或在工具資料夾執行 node watch.mjs --tg-login）'); } } }
  finally { _tgBusy = false; }
}

const inscriptions = new Map();
function noteTransactions(txs) {
 const now = Date.now();
 for (const t of txs) {
  const input=String(t.input||'');if(!input.startsWith('0x646174613a')||input.length>4000)continue;
  const txt=Buffer.from(input.slice(2),'hex').toString('utf8');const tick=(txt.match(/"tick"\s*:\s*"([^"\n]{1,40})"/i)||[])[1];
  if(!tick)continue;const key=tick.toLowerCase();let row=inscriptions.get(key);if(!row||now-row.at>180000){row={at:now,from:new Set()};inscriptions.set(key,row);}
  if(/^0x[0-9a-f]{40}$/i.test(t.from||''))row.from.add(t.from.toLowerCase());
 }
 for(const[k,v]of inscriptions)if(now-v.at>180000)inscriptions.delete(k);
}
async function inscriptionPoll(){
 S.inscNoted ||= {};
 for(const[key,row]of inscriptions){if(row.from.size<12||S.inscNoted[key])continue;const sample=[...row.from].slice(0,16);let count=0;
 for(const a of sample){const result=await call('0x'+REGISTRY,'0x70a08231'+wa(a));if(/^0x[0-9a-f]{64}$/i.test(result||'')&&BigInt(result)>0n)count++;}
 if(count>=8&&count/sample.length>=0.6){S.inscNoted[key]=Date.now();await tg('🔥 热门 Agent ID 铭文 '+noLink(key)+'：3分钟 '+row.from.size+' 个钱包；仅通知，请手动核实');}}
}
return { noteUrls, hotUrls, siteScan, socialPoll:tgGroupWatch,noteTransactions,inscriptionPoll,close:async()=>{if(_tgc)await _tgc.disconnect();} };
}

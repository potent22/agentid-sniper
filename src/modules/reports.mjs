// Module: reports. Construction is inert; I/O is invoked explicitly.
import { readFileSync } from 'node:fs';
export function createReports(dependencies) {
  const {
    CONFIG,
    LOG,
    PAID,
    S,
    T_TRANSFER,
    UPD,
    USDT,
    WALLETS,
    call,
    cmdStats,
    decStrAt,
    groupProgress,
    log,
    rpc,
    save,
    sleep,
    tg,
    tgSay,
    tokStr,
    ts,
    w,
    wa,
    fetchImpl
  } = dependencies;
  async function freeProgWatch() {
    // 免費項目也看鑄造進度（已鑄造／總量），過 70% 播報到群
    S.freeTrack = S.freeTrack || {};
    for (const [c, F] of Object.entries(S.freeTrack)) {
      if (Date.now() - F.at > 72 * 3600e3 || F.done) {
        delete S.freeTrack[c];
        continue;
      }
      const tsR = await call(c, '0x18160ddd');
      if (!tsR || tsR.length < 66) {
        F.done = 1;
        continue;
      }
      const sup = Number(BigInt(tsR.slice(0, 66)));
      let max = 0;
      for (const sel of ['0xd5abeb01', '0x32cb6b0c', '0x355274ea', '0xe985e367', '0xf1aee5a2']) {
        const r = await call(c, sel);
        if (r && r.length >= 66) {
          const x = Number(BigInt(r.slice(0, 66)));
          if (x > 0 && x >= sup && x < 1e15) {
            max = x;
            break;
          }
        }
      }
      if (!max) {
        F.miss = (F.miss || 0) + 1;
        if (F.miss >= 3) F.done = 1;
        continue;
      } // 讀不到總量的就不追了
      const pct = sup / max,
        prev = F.p;
      F.p = pct;
      if (pct >= 0.7 && (prev != null ? prev < 0.7 : Date.now() - F.at < 3600e3)) {
        const nm = tokStr(await call(c, '0x06fdde03')) || '';
        await groupProgress(c, nm, pct);
      }
      if (pct >= 1) F.done = 1;
      await sleep(100);
    }
  }
  async function lowBnbWatch() {
    /* 新功能：BNB 快不夠付 gas 時提醒（每個錢包 6 小時最多一次） */
    S.lowBnbAt = S.lowBnbAt || {};
    for (const W of WALLETS) {
      const b = Number(BigInt((await rpc('eth_getBalance', [W.addr, 'latest'])) || '0x0')) / 1e18;
      if (b < PAID.keepBnb + 0.02 && Date.now() - (S.lowBnbAt[W.name] || 0) > 6 * 3600e3) {
        S.lowBnbAt[W.name] = Date.now();
        await tg(`⚠️ [${W.name}] BNB 快不夠了：剩 ${b.toFixed(4)} BNB，可能付不出 gas，免費項目也會打不了，請補一點 BNB`);
      }
    }
  }
  function pruneState() {
    /* 審查修正：狀態檔定期瘦身，避免越來越大、越存越慢 */
    const cut = (o, max) => {
      const k = Object.keys(o || {});
      if (k.length > max) for (const x of k.slice(0, k.length - max)) delete o[x];
    };
    cut(S.seenMints, 30000);
    cut(S.g70, 3000);
    cut(S.grpOnce, 5000);
    cut(S.missed, 500);
    cut(S.deployer, 20000);
    if (S.trades?.length > 1000) S.trades = S.trades.slice(-1000);
    for (const st of Object.values(S.tokens || {})) if (st.holders) cut(st.holders, 20000);
  }
  async function dailyReport() {
    /* 新功能：每天晚上 9 點（台北）自動發戰績＋持倉 */
    const tp = new Date(Date.now() + 8 * 3600e3);
    const day = tp.toISOString().slice(0, 10);
    if (tp.getUTCHours() !== 21 || S.dailyAt === day) return;
    S.dailyAt = day;
    save();
    let um = 0;
    try {
      const today = ts().split(/\s/)[0]; /* 審查 11/1：日誌日期是 2026/11/1（沒有補 0），以前比對不到 */
      um = new Set(readFileSync(LOG, 'utf8').split('\n').filter(l => l.startsWith('[' + today) && l.includes('] 打不了 ')).map(l => (l.match(/0x[a-f0-9]{40}/) || [''])[0])).size;
    } catch {}
    const today2 = ts().split(/\s/)[0];
    const ms = Object.entries(S.missed || {}).filter(([, m]) => String(m.at).startsWith(today2)).slice(-8);
    const missTxt = ms.length ? `\n今天快賣完卻沒打到的 ${ms.length} 個：\n` + ms.map(([c, m]) => `· ${m.name}：${m.why}`).join('\n') : '\n今天沒有錯過快賣完的項目';
    await tgSay(`🌙 每日總結（晚上 9 點自動發）${missTxt}\n今天有 ${um} 個項目打不了（要官網簽名、白名單或模擬失敗），只記在紀錄裡${UPD.on ? `\n\n官方群：${UPD.group}` : ''}`);
    await cmdStats().catch(() => {}); /* 持倉總結改由 holdReport 在 1 點／13 點發 */
  }
  const AIDROP_VAULT = (CONFIG.watchVault || '').toLowerCase();
  async function aidropWatch(head) {
    if (!AIDROP_VAULT) return;
    S.aidrop = S.aidrop || {
      topics: {},
      from: head - 2000
    };
    try {
      const logs = await rpc('eth_getLogs', [{
        address: AIDROP_VAULT,
        fromBlock: '0x' + Math.max(S.aidrop.from, head - 4000).toString(16),
        toBlock: '0x' + head.toString(16)
      }]);
      const first = Object.keys(S.aidrop.topics).length === 0;
      let alerted = false;
      for (const l of logs) {
        const t0 = l.topics[0];
        if (['0x8a587a0e', '0xe988651c'].includes(t0.slice(0, 10))) {
          S.aidrop.topics[t0] = 1;
          continue;
        }
        if (!S.aidrop.topics[t0]) {
          S.aidrop.topics[t0] = 1;
          if (!first && !alerted && (alerted = true)) await tg(`📣 AIDROP 金库出现新的链上动作（新事件类型）\n可能是开放领取或开始发放，请自行查看\n交易 ${l.transactionHash}`);
        }
      }
      S.aidrop.from = head + 1;
    } catch {}
  }
  const TOSH_FACTORIES = [['BNB', '0x091d0cbd1e3b7d8b2a6fd8e0795b784eddffb590'], ['USDT', '0x8296fa2d430dcf25233a39cc3306ee503967a6bb']];
  async function toshWatch() {
    S.tosh = S.tosh || {
      counts: {}
    };
    for (const [quote, f] of TOSH_FACTORIES) {
      const r = await call(f, '0x27cca59f');
      if (!r) continue;
      const n = Number(BigInt(r.slice(0, 66)));
      const prev = S.tosh.counts[f];
      if (prev === undefined) {
        S.tosh.counts[f] = n;
        continue;
      } // 第一次只记数量，不通知旧项目
      for (let i = prev; i < n; i++) {
        try {
          const L = await call(f, '0x7b443a76' + w(i));
          const W4 = L.slice(2).match(/.{64}/g);
          const token = '0x' + W4[0].slice(24),
            hook = '0x' + W4[1].slice(24),
            creator = '0x' + W4[2].slice(24),
            createdAt = Number(BigInt('0x' + W4[3]));
          const str = async sel => {
            const h = await call(token, sel);
            try {
              const x = h.slice(2);
              const len = Number(BigInt('0x' + x.slice(64, 128)));
              return Buffer.from(x.slice(128, 128 + len * 2), 'hex').toString('utf8');
            } catch {
              return '?';
            }
          };
          const name = await str('0x06fdde03'),
            sym = await str('0x95d89b41');
          // 创建者以前发过几个（两个工厂都算）
          let byCreator = 0;
          for (const [, f2] of TOSH_FACTORIES) {
            const c2 = await call(f2, '0x27cca59f');
            const n2 = c2 ? Number(BigInt(c2.slice(0, 66))) : 0;
            for (let k = Math.max(0, n2 - 60); k < n2; k++) {
              const L2 = await call(f2, '0x7b443a76' + w(k));
              if (L2 && L2.slice(2).match(/.{64}/g)[2].slice(24) === creator.slice(2)) byCreator++;
            }
          }
          // 官网资料（简介、推特、TG）
          let meta = null;
          try {
            const j = await (await fetchImpl('https://toshx.xyz/api/projects', {
              signal: AbortSignal.timeout(10000)
            })).json();
            meta = (j.data || []).find(p => String(p.token_address).toLowerCase() === token);
          } catch {}
          const raisedRaw = quote === 'BNB' ? await rpc('eth_getBalance', [hook, 'latest']).catch(() => '0x0') : await call(USDT, '0x70a08231' + wa(hook));
          const raised = Number(BigInt(raisedRaw || '0x0')) / 1e18;
          const flags = [];
          if (!meta) flags.push('官网还没有资料（可能是测试盘）');
          if (meta && !meta.twitter) flags.push('没有推特');
          if (meta && !meta.website) flags.push('没有官网');
          if (byCreator > 1) flags.push(`同一个创建者已发过 ${byCreator} 个`);
          if (/test/i.test(name + sym)) flags.push('名字像测试盘');
          const desc = (meta?.description || '').replace(/\s+/g, ' ').slice(0, 220);
          const verdict = flags.length >= 2 ? '🔴 風險偏高，建議觀望' : flags.length === 1 ? '🟡 有疑點，自己再看看' : '🟢 資料齊全，可以考慮';
          // 使用者的規則：發射台上的一般代幣不打，只打平台幣
          const PLATFORM_DEPLOYER = '0x790091e8965ecc1adfa40aa9b95515c6289dce9d'; // TOSH 平台幣的建立者
          const isPlatform = creator.toLowerCase() === PLATFORM_DEPLOYER || /platform token|平台币|平台幣|platform coin/i.test((meta?.description || '') + name);
          if (!isPlatform) {
            log(`ToshX 新项目 ${name}(${sym}) 不是平台币，按规则不通知`);
            continue;
          }
          await tg(`🚀 ToshX 平台幣相關新項目：${name}（$${sym}）\n報價幣：${quote} · 已募到約 ${raised.toFixed(3)} ${quote}\n建立時間：${new Date(createdAt * 1000).toLocaleString('zh-TW', {
            hour12: false,
            timeZone: CONFIG.timeZone || 'Asia/Taipei'
          })}\n${desc ? '簡介：' + desc + '\n' : ''}${meta?.twitter ? 'X：' + meta.twitter + '\n' : ''}${meta?.telegram ? 'TG：' + meta.telegram + '\n' : ''}代幣 ${token}\n分析：${verdict}${flags.length ? '（' + flags.join('、') + '）' : ''}\n規則：每個 Agent ID 一份額度，通常開賣幾分鐘就滿。要打的話手動處理「打 ${sym}」和每個錢包打多少\nhttps://toshx.xyz/launchpad`);
        } catch (e) {
          log('tosh err ' + e.message);
        }
      }
      S.tosh.counts[f] = n;
    }
  }
  const FLAP_READER = '0x18aa6c93f1887a243fdc348c9a77f5136555174a';
  const FLAP_QUOTES = {
    '0x4902c5ebc598265ed2212b559b042de8a5eeec3f': 'BNCB',
    '0x02fca66c1d1afb4e2a7884261eb00f63598a7436': 'NVDAB',
    '0x205812cdbed920aff76c6580abd681a46d11efc7': 'QQQB',
    '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1': 'SPCXB'
  };
  async function flapAgentWatch() {
    S.flapAgent = S.flapAgent || {
      total: null,
      names: {}
    };
    const p0 = await call(FLAP_READER, '0x8f82e165' + w(0) + w(1));
    if (!p0) return;
    const total = Number(BigInt('0x' + p0.slice(2 + 128, 2 + 192)));
    if (S.flapAgent.total === null) {
      S.flapAgent.total = total;
      return;
    }
    for (let i = S.flapAgent.total; i < total; i++) {
      try {
        const pg = await call(FLAP_READER, '0x8f82e165' + w(i) + w(1));
        const W5 = pg.slice(2).match(/.{64}/g);
        const off = Number(BigInt('0x' + W5[0])) / 32;
        const m = '0x' + W5[off + 1].slice(24);
        const st = await call(FLAP_READER, '0x51c023e2' + wa(m));
        const SW = st.slice(2).match(/.{64}/g);
        const t0 = Number(BigInt('0x' + SW[0])) / 32,
          inner = t0 + Number(BigInt('0x' + SW[t0])) / 32;
        const name = decStrAt(st, (inner + Number(BigInt('0x' + SW[inner])) / 32) * 32),
          sym = decStrAt(st, (inner + Number(BigInt('0x' + SW[inner + 1])) / 32) * 32);
        const buyTax = Number(BigInt('0x' + SW[inner + 5])) / 100,
          sellTax = Number(BigInt('0x' + SW[inner + 6])) / 100,
          maxW = Number(BigInt('0x' + SW[inner + 11])) / 100;
        const quote = '0x' + SW[t0 + 1].slice(24);
        const qn = /^0x0{40}$/.test(quote) ? 'BNB' : FLAP_QUOTES[quote] || quote.slice(0, 10);
        const key = (sym || name).toLowerCase();
        const dup = S.flapAgent.names[key];
        S.flapAgent.names[key] = (dup || 0) + 1;
        const flags = [];
        if (buyTax + sellTax > 8) flags.push(`稅偏高 ${buyTax}%/${sellTax}%`);
        if (dup) flags.push('跟風同名（之前已有同名盤）');
        if (/<|script|onerror|http/i.test(name + sym)) flags.push('⚠️ 名稱含可疑程式碼，別在網頁上點');
        const verdict = flags.length >= 2 ? '🔴 建議跳過' : flags.length === 1 ? '🟡 有疑點' : '🟢 首發、稅合理';
        if (!/^(flap|flapx)$/i.test(sym.trim())) {
          log(`Flap Agent 新盘 ${name}(${sym}) 是发射台代币，按规则不通知`);
          continue;
        }
        await tg(`🦋 Flap ID AGENT CURVE 新盤：${name.slice(0, 40)}（${sym.slice(0, 20)}）\n底池：${qn} · 稅 ${buyTax}%/${sellTax}% · 單錢包上限 ${maxW}%\n分析：${verdict}${flags.length ? '（' + flags.join('、') + '）' : ''}\n市場 ${m}\n要打的話手動處理「打 ${sym.slice(0, 20)}」和金額`);
      } catch (e) {
        log('flapAgent err ' + e.message);
      }
    }
    S.flapAgent.total = total;
  }
  const ELEMENT_EX = '0xb3e3dfcb2d9f3dde16d78b9e6eb3538eb32b5ae1';
  const T_721_FILLED = '0x9c248aa1a265aa616f707b979d57f4529bb63a4fc34dc7fc61fdddc18410f74e';
  async function nftVolWatch() {
    S.nftCols = S.nftCols || {};
    S.nftVol = S.nftVol || {};
    if (!S.nftColsBackfilled) {
      // 第一次：從日誌補回之前打到的 NFT 系列
      try {
        for (const l of readFileSync(LOG, 'utf8').split('\n')) {
          if (!l.includes('已自動鑄造') || !l.includes('NFT')) continue;
          const m = l.match(/\] (0x[a-fA-F0-9]{40}) /);
          if (m) S.nftCols[m[1].toLowerCase()] = 1;
        }
      } catch {}
      S.nftColsBackfilled = true;
    }
    const head = parseInt(await rpc('eth_blockNumber', []), 16),
      from = head - 96000; // 約 12 小時
    // 1) Element 成交（一次抓完再按系列分）
    const fills = {};
    for (let b = from; b <= head; b += 10000) {
      const L = await rpc('eth_getLogs', [{
        address: ELEMENT_EX,
        topics: [T_721_FILLED],
        fromBlock: '0x' + b.toString(16),
        toBlock: '0x' + Math.min(b + 9999, head).toString(16)
      }]).catch(() => []);
      for (const l of L || []) {
        const w = l.data.slice(2).match(/.{64}/g) || [];
        const col = '0x' + (w[7] || '').slice(24);
        if (!S.nftCols[col]) continue;
        const isBnb = (w[4] || '').endsWith('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
        const px = Number(BigInt('0x' + (w[5] || '0'))) / 1e18;
        (fills[col] = fills[col] || []).push(isBnb ? px : null);
      }
      await sleep(200);
    }
    // 2) 各系列轉手次數（不含新鑄造）＋我們持有幾張
    for (const col of Object.keys(S.nftCols)) {
      let moves = 0;
      for (let b = from; b <= head; b += 50000) {
        const L = await rpc('eth_getLogs', [{
          address: col,
          topics: [T_TRANSFER],
          fromBlock: '0x' + b.toString(16),
          toBlock: '0x' + Math.min(b + 49999, head).toString(16)
        }]).catch(() => []);
        for (const l of L || []) if (l.topics.length === 4 && !/^0x0+$/.test(l.topics[1])) moves++;
      }
      let held = 0;
      for (const W of WALLETS) {
        const r = await call(col, '0x70a08231' + wa(W.addr));
        if (r && r.length >= 66) held += Number(BigInt(r.slice(0, 66)));
      }
      const f = fills[col] || [],
        prev = S.nftVol[col];
      const px = f.filter(x => x != null),
        vol = px.reduce((a, b) => a + b, 0);
      const hot = held > 0 && px.length >= 3 && vol > 0 && (prev ? px.length >= 2 * (prev.f || 0) : px.length >= 5); // 只看真的有付錢的成交（使用者 15:22：轉來轉去不算）
      if (hot) {
        const name = tokStr(await call(col, '0x06fdde03')) || col.slice(0, 10);
        await tg(`🦋 NFT 成交量變多：${name}\n錢包共持有 ${held} 張\n過去 12 小時 Element 成交 ${f.length} 筆${prev ? '（上次 ' + (prev.f || 0) + ' 筆）' : ''}${px.length ? `，成交價 ${Math.min(...px).toFixed(4)}～${Math.max(...px).toFixed(4)} BNB，合計 ${vol.toFixed(4)} BNB` : ''}\n轉手 ${moves} 次${prev ? '（上次 ' + (prev.t || 0) + ' 次）' : ''}\n${col}\nhttps://element.market/assets/bsc/${col}/1\n要掛單或賣手動處理`);
      }
      S.nftVol[col] = {
        f: f.length,
        t: moves,
        held,
        at: ts()
      };
      await sleep(150);
    }
    log(`NFT 成交量檢查完成：${Object.keys(S.nftCols).length} 個系列`);
  }
  return {
    get freeProgWatch() {
      return freeProgWatch;
    },
    get lowBnbWatch() {
      return lowBnbWatch;
    },
    get pruneState() {
      return pruneState;
    },
    get dailyReport() {
      return dailyReport;
    },
    get aidropWatch() {
      return aidropWatch;
    },
    get toshWatch() {
      return toshWatch;
    },
    get flapAgentWatch() {
      return flapAgentWatch;
    },
    get nftVolWatch() {
      return nftVolWatch;
    }
  };
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJyZWFkRmlsZVN5bmMiLCJjcmVhdGVSZXBvcnRzIiwiZGVwZW5kZW5jaWVzIiwiQ09ORklHIiwiTE9HIiwiUEFJRCIsIlMiLCJUX1RSQU5TRkVSIiwiVVBEIiwiVVNEVCIsIldBTExFVFMiLCJjYWxsIiwiY21kU3RhdHMiLCJkZWNTdHJBdCIsImdyb3VwUHJvZ3Jlc3MiLCJsb2ciLCJycGMiLCJzYXZlIiwic2xlZXAiLCJ0ZyIsInRnU2F5IiwidG9rU3RyIiwidHMiLCJ3Iiwid2EiLCJmZXRjaEltcGwiLCJmcmVlUHJvZ1dhdGNoIiwiZnJlZVRyYWNrIiwiYyIsIkYiLCJPYmplY3QiLCJlbnRyaWVzIiwiRGF0ZSIsIm5vdyIsImF0IiwiZG9uZSIsInRzUiIsImxlbmd0aCIsInN1cCIsIk51bWJlciIsIkJpZ0ludCIsInNsaWNlIiwibWF4Iiwic2VsIiwiciIsIngiLCJtaXNzIiwicGN0IiwicHJldiIsInAiLCJubSIsImxvd0JuYldhdGNoIiwibG93Qm5iQXQiLCJXIiwiYiIsImFkZHIiLCJrZWVwQm5iIiwibmFtZSIsInRvRml4ZWQiLCJwcnVuZVN0YXRlIiwiY3V0IiwibyIsImsiLCJrZXlzIiwic2Vlbk1pbnRzIiwiZzcwIiwiZ3JwT25jZSIsIm1pc3NlZCIsImRlcGxveWVyIiwidHJhZGVzIiwic3QiLCJ2YWx1ZXMiLCJ0b2tlbnMiLCJob2xkZXJzIiwiZGFpbHlSZXBvcnQiLCJ0cCIsImRheSIsInRvSVNPU3RyaW5nIiwiZ2V0VVRDSG91cnMiLCJkYWlseUF0IiwidW0iLCJ0b2RheSIsInNwbGl0IiwiU2V0IiwiZmlsdGVyIiwibCIsInN0YXJ0c1dpdGgiLCJpbmNsdWRlcyIsIm1hcCIsIm1hdGNoIiwic2l6ZSIsInRvZGF5MiIsIm1zIiwibSIsIlN0cmluZyIsIm1pc3NUeHQiLCJ3aHkiLCJqb2luIiwib24iLCJncm91cCIsImNhdGNoIiwiQUlEUk9QX1ZBVUxUIiwid2F0Y2hWYXVsdCIsInRvTG93ZXJDYXNlIiwiYWlkcm9wV2F0Y2giLCJoZWFkIiwiYWlkcm9wIiwidG9waWNzIiwiZnJvbSIsImxvZ3MiLCJhZGRyZXNzIiwiZnJvbUJsb2NrIiwiTWF0aCIsInRvU3RyaW5nIiwidG9CbG9jayIsImZpcnN0IiwiYWxlcnRlZCIsInQwIiwidHJhbnNhY3Rpb25IYXNoIiwiVE9TSF9GQUNUT1JJRVMiLCJ0b3NoV2F0Y2giLCJ0b3NoIiwiY291bnRzIiwicXVvdGUiLCJmIiwibiIsInVuZGVmaW5lZCIsImkiLCJMIiwiVzQiLCJ0b2tlbiIsImhvb2siLCJjcmVhdG9yIiwiY3JlYXRlZEF0Iiwic3RyIiwiaCIsImxlbiIsIkJ1ZmZlciIsInN5bSIsImJ5Q3JlYXRvciIsImYyIiwiYzIiLCJuMiIsIkwyIiwibWV0YSIsImoiLCJzaWduYWwiLCJBYm9ydFNpZ25hbCIsInRpbWVvdXQiLCJqc29uIiwiZGF0YSIsImZpbmQiLCJ0b2tlbl9hZGRyZXNzIiwicmFpc2VkUmF3IiwicmFpc2VkIiwiZmxhZ3MiLCJwdXNoIiwidHdpdHRlciIsIndlYnNpdGUiLCJ0ZXN0IiwiZGVzYyIsImRlc2NyaXB0aW9uIiwicmVwbGFjZSIsInZlcmRpY3QiLCJQTEFURk9STV9ERVBMT1lFUiIsImlzUGxhdGZvcm0iLCJ0b0xvY2FsZVN0cmluZyIsImhvdXIxMiIsInRpbWVab25lIiwidGVsZWdyYW0iLCJlIiwibWVzc2FnZSIsIkZMQVBfUkVBREVSIiwiRkxBUF9RVU9URVMiLCJmbGFwQWdlbnRXYXRjaCIsImZsYXBBZ2VudCIsInRvdGFsIiwibmFtZXMiLCJwMCIsInBnIiwiVzUiLCJvZmYiLCJTVyIsImlubmVyIiwiYnV5VGF4Iiwic2VsbFRheCIsIm1heFciLCJxbiIsImtleSIsImR1cCIsInRyaW0iLCJFTEVNRU5UX0VYIiwiVF83MjFfRklMTEVEIiwibmZ0Vm9sV2F0Y2giLCJuZnRDb2xzIiwibmZ0Vm9sIiwibmZ0Q29sc0JhY2tmaWxsZWQiLCJwYXJzZUludCIsImZpbGxzIiwibWluIiwiY29sIiwiaXNCbmIiLCJlbmRzV2l0aCIsInB4IiwibW92ZXMiLCJoZWxkIiwidm9sIiwicmVkdWNlIiwiYSIsImhvdCIsInQiXSwic291cmNlcyI6WyJyZXBvcnRzLm1qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBNb2R1bGU6IHJlcG9ydHMuIENvbnN0cnVjdGlvbiBpcyBpbmVydDsgSS9PIGlzIGludm9rZWQgZXhwbGljaXRseS5cbmltcG9ydCB7IHJlYWRGaWxlU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVJlcG9ydHMoZGVwZW5kZW5jaWVzKSB7XG4gIGNvbnN0IHsgQ09ORklHLCBMT0csIFBBSUQsIFMsIFRfVFJBTlNGRVIsIFVQRCwgVVNEVCwgV0FMTEVUUywgY2FsbCwgY21kU3RhdHMsIGRlY1N0ckF0LCBncm91cFByb2dyZXNzLCBsb2csIHJwYywgc2F2ZSwgc2xlZXAsIHRnLCB0Z1NheSwgdG9rU3RyLCB0cywgdywgd2EsIGZldGNoSW1wbCB9ID0gZGVwZW5kZW5jaWVzO1xuICBhc3luYyBmdW5jdGlvbiBmcmVlUHJvZ1dhdGNoKCkgeyAvLyDlhY3osrvpoIXnm67kuZ/nnIvpkYTpgKDpgLLluqbvvIjlt7LpkYTpgKDvvI/nuL3ph4/vvInvvIzpgY4gNzAlIOaSreWgseWIsOe+pFxuICAgIFMuZnJlZVRyYWNrID0gUy5mcmVlVHJhY2sgfHwge307XG4gICAgZm9yIChjb25zdCBbYywgRl0gb2YgT2JqZWN0LmVudHJpZXMoUy5mcmVlVHJhY2spKSB7XG4gICAgICBpZiAoRGF0ZS5ub3coKSAtIEYuYXQgPiA3MiAqIDM2MDBlMyB8fCBGLmRvbmUpIHsgZGVsZXRlIFMuZnJlZVRyYWNrW2NdOyBjb250aW51ZTsgfVxuICAgICAgY29uc3QgdHNSID0gYXdhaXQgY2FsbChjLCAnMHgxODE2MGRkZCcpOyBpZiAoIXRzUiB8fCB0c1IubGVuZ3RoIDwgNjYpIHsgRi5kb25lID0gMTsgY29udGludWU7IH0gY29uc3Qgc3VwID0gTnVtYmVyKEJpZ0ludCh0c1Iuc2xpY2UoMCwgNjYpKSk7XG4gICAgICBsZXQgbWF4ID0gMDsgZm9yIChjb25zdCBzZWwgb2YgWycweGQ1YWJlYjAxJywgJzB4MzJjYjZiMGMnLCAnMHgzNTUyNzRlYScsICcweGU5ODVlMzY3JywgJzB4ZjFhZWU1YTInXSkgeyBjb25zdCByID0gYXdhaXQgY2FsbChjLCBzZWwpOyBpZiAociAmJiByLmxlbmd0aCA+PSA2NikgeyBjb25zdCB4ID0gTnVtYmVyKEJpZ0ludChyLnNsaWNlKDAsIDY2KSkpOyBpZiAoeCA+IDAgJiYgeCA+PSBzdXAgJiYgeCA8IDFlMTUpIHsgbWF4ID0geDsgYnJlYWs7IH0gfSB9XG4gICAgICBpZiAoIW1heCkgeyBGLm1pc3MgPSAoRi5taXNzIHx8IDApICsgMTsgaWYgKEYubWlzcyA+PSAzKSBGLmRvbmUgPSAxOyBjb250aW51ZTsgfSAvLyDoroDkuI3liLDnuL3ph4/nmoTlsLHkuI3ov73kuoZcbiAgICAgIGNvbnN0IHBjdCA9IHN1cCAvIG1heCwgcHJldiA9IEYucDsgRi5wID0gcGN0O1xuICAgICAgaWYgKHBjdCA+PSAwLjcgJiYgKHByZXYgIT0gbnVsbCA/IHByZXYgPCAwLjcgOiBEYXRlLm5vdygpIC0gRi5hdCA8IDM2MDBlMykpIHsgY29uc3Qgbm0gPSB0b2tTdHIoYXdhaXQgY2FsbChjLCAnMHgwNmZkZGUwMycpKSB8fCAnJzsgYXdhaXQgZ3JvdXBQcm9ncmVzcyhjLCBubSwgcGN0KTsgfVxuICAgICAgaWYgKHBjdCA+PSAxKSBGLmRvbmUgPSAxO1xuICAgICAgYXdhaXQgc2xlZXAoMTAwKTtcbiAgICB9XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBsb3dCbmJXYXRjaCgpIHsgLyog5paw5Yqf6IO977yaQk5CIOW/q+S4jeWkoOS7mCBnYXMg5pmC5o+Q6YaS77yI5q+P5YCL6Yyi5YyFIDYg5bCP5pmC5pyA5aSa5LiA5qyh77yJICovXG4gICAgUy5sb3dCbmJBdCA9IFMubG93Qm5iQXQgfHwge307XG4gICAgZm9yIChjb25zdCBXIG9mIFdBTExFVFMpIHsgY29uc3QgYiA9IE51bWJlcihCaWdJbnQoKGF3YWl0IHJwYygnZXRoX2dldEJhbGFuY2UnLCBbVy5hZGRyLCAnbGF0ZXN0J10pKSB8fCAnMHgwJykpIC8gMWUxODtcbiAgICAgIGlmIChiIDwgUEFJRC5rZWVwQm5iICsgMC4wMiAmJiBEYXRlLm5vdygpIC0gKFMubG93Qm5iQXRbVy5uYW1lXSB8fCAwKSA+IDYgKiAzNjAwZTMpIHsgUy5sb3dCbmJBdFtXLm5hbWVdID0gRGF0ZS5ub3coKTsgYXdhaXQgdGcoYOKaoO+4jyBbJHtXLm5hbWV9XSBCTkIg5b+r5LiN5aSg5LqG77ya5YmpICR7Yi50b0ZpeGVkKDQpfSBCTkLvvIzlj6/og73ku5jkuI3lh7ogZ2Fz77yM5YWN6LK76aCF55uu5Lmf5pyD5omT5LiN5LqG77yM6KuL6KOc5LiA6bueIEJOQmApOyB9IH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHBydW5lU3RhdGUoKSB7IC8qIOWvqeafpeS/ruato++8mueLgOaFi+aqlOWumuacn+eYpui6q++8jOmBv+WFjei2iuS+hui2iuWkp+OAgei2iuWtmOi2iuaFoiAqL1xuICAgIGNvbnN0IGN1dCA9IChvLCBtYXgpID0+IHsgY29uc3QgayA9IE9iamVjdC5rZXlzKG8gfHwge30pOyBpZiAoay5sZW5ndGggPiBtYXgpIGZvciAoY29uc3QgeCBvZiBrLnNsaWNlKDAsIGsubGVuZ3RoIC0gbWF4KSkgZGVsZXRlIG9beF07IH07XG4gICAgY3V0KFMuc2Vlbk1pbnRzLCAzMDAwMCk7IGN1dChTLmc3MCwgMzAwMCk7IGN1dChTLmdycE9uY2UsIDUwMDApOyBjdXQoUy5taXNzZWQsIDUwMCk7IGN1dChTLmRlcGxveWVyLCAyMDAwMCk7XG4gICAgaWYgKFMudHJhZGVzPy5sZW5ndGggPiAxMDAwKSBTLnRyYWRlcyA9IFMudHJhZGVzLnNsaWNlKC0xMDAwKTtcbiAgICBmb3IgKGNvbnN0IHN0IG9mIE9iamVjdC52YWx1ZXMoUy50b2tlbnMgfHwge30pKSBpZiAoc3QuaG9sZGVycykgY3V0KHN0LmhvbGRlcnMsIDIwMDAwKTtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIGRhaWx5UmVwb3J0KCkgeyAvKiDmlrDlip/og73vvJrmr4/lpKnmmZrkuIogOSDpu57vvIjlj7DljJfvvInoh6rli5XnmbzmiLDnuL7vvIvmjIHlgIkgKi9cbiAgICBjb25zdCB0cCA9IG5ldyBEYXRlKERhdGUubm93KCkgKyA4ICogMzYwMGUzKTsgY29uc3QgZGF5ID0gdHAudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCk7XG4gICAgaWYgKHRwLmdldFVUQ0hvdXJzKCkgIT09IDIxIHx8IFMuZGFpbHlBdCA9PT0gZGF5KSByZXR1cm47IFMuZGFpbHlBdCA9IGRheTsgc2F2ZSgpO1xuICAgIGxldCB1bSA9IDA7IHRyeSB7IGNvbnN0IHRvZGF5ID0gdHMoKS5zcGxpdCgvXFxzLylbMF07IC8qIOWvqeafpSAxMS8x77ya5pel6KqM5pel5pyf5pivIDIwMjYvMTEvMe+8iOaykuacieijnCAw77yJ77yM5Lul5YmN5q+U5bCN5LiN5YiwICovIHVtID0gbmV3IFNldChyZWFkRmlsZVN5bmMoTE9HLCAndXRmOCcpLnNwbGl0KCdcXG4nKS5maWx0ZXIoKGwpID0+IGwuc3RhcnRzV2l0aCgnWycgKyB0b2RheSkgJiYgbC5pbmNsdWRlcygnXSDmiZPkuI3kuoYgJykpLm1hcCgobCkgPT4gKGwubWF0Y2goLzB4W2EtZjAtOV17NDB9LykgfHwgWycnXSlbMF0pKS5zaXplOyB9IGNhdGNoIHt9XG4gICAgY29uc3QgdG9kYXkyID0gdHMoKS5zcGxpdCgvXFxzLylbMF07IGNvbnN0IG1zID0gT2JqZWN0LmVudHJpZXMoUy5taXNzZWQgfHwge30pLmZpbHRlcigoWywgbV0pID0+IFN0cmluZyhtLmF0KS5zdGFydHNXaXRoKHRvZGF5MikpLnNsaWNlKC04KTtcbiAgICBjb25zdCBtaXNzVHh0ID0gbXMubGVuZ3RoID8gYFxcbuS7iuWkqeW/q+izo+WujOWNu+aykuaJk+WIsOeahCAke21zLmxlbmd0aH0g5YCL77yaXFxuYCArIG1zLm1hcCgoW2MsIG1dKSA9PiBgwrcgJHttLm5hbWV977yaJHttLndoeX1gKS5qb2luKCdcXG4nKSA6ICdcXG7ku4rlpKnmspLmnInpjK/pgY7lv6vos6PlroznmoTpoIXnm64nO1xuICAgIGF3YWl0IHRnU2F5KGDwn4yZIOavj+aXpee4vee1kO+8iOaZmuS4iiA5IOm7nuiHquWLleeZvO+8iSR7bWlzc1R4dH1cXG7ku4rlpKnmnIkgJHt1bX0g5YCL6aCF55uu5omT5LiN5LqG77yI6KaB5a6Y57ay57C95ZCN44CB55m95ZCN5Zau5oiW5qih5pOs5aSx5pWX77yJ77yM5Y+q6KiY5Zyo57SA6YyE6KOhJHtVUEQub24gPyBgXFxuXFxu5a6Y5pa5576k77yaJHtVUEQuZ3JvdXB9YCA6ICcnfWApOyBhd2FpdCBjbWRTdGF0cygpLmNhdGNoKCgpID0+IHt9KTsgLyog5oyB5YCJ57i957WQ5pS555SxIGhvbGRSZXBvcnQg5ZyoIDEg6bue77yPMTMg6bue55m8ICovXG4gIH1cblxuICBjb25zdCBBSURST1BfVkFVTFQgPSAoQ09ORklHLndhdGNoVmF1bHQgfHwgJycpLnRvTG93ZXJDYXNlKCk7XG5cbiAgYXN5bmMgZnVuY3Rpb24gYWlkcm9wV2F0Y2goaGVhZCkge1xuICAgIGlmICghQUlEUk9QX1ZBVUxUKSByZXR1cm47XG4gICAgUy5haWRyb3AgPSBTLmFpZHJvcCB8fCB7IHRvcGljczoge30sIGZyb206IGhlYWQgLSAyMDAwIH07XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGxvZ3MgPSBhd2FpdCBycGMoJ2V0aF9nZXRMb2dzJywgW3sgYWRkcmVzczogQUlEUk9QX1ZBVUxULCBmcm9tQmxvY2s6ICcweCcgKyBNYXRoLm1heChTLmFpZHJvcC5mcm9tLCBoZWFkIC0gNDAwMCkudG9TdHJpbmcoMTYpLCB0b0Jsb2NrOiAnMHgnICsgaGVhZC50b1N0cmluZygxNikgfV0pO1xuICAgICAgY29uc3QgZmlyc3QgPSBPYmplY3Qua2V5cyhTLmFpZHJvcC50b3BpY3MpLmxlbmd0aCA9PT0gMDtcbiAgICAgIGxldCBhbGVydGVkID0gZmFsc2U7XG4gICAgICBmb3IgKGNvbnN0IGwgb2YgbG9ncykgeyBjb25zdCB0MCA9IGwudG9waWNzWzBdOyBpZiAoWycweDhhNTg3YTBlJywgJzB4ZTk4ODY1MWMnXS5pbmNsdWRlcyh0MC5zbGljZSgwLCAxMCkpKSB7IFMuYWlkcm9wLnRvcGljc1t0MF0gPSAxOyBjb250aW51ZTsgfSBpZiAoIVMuYWlkcm9wLnRvcGljc1t0MF0pIHsgUy5haWRyb3AudG9waWNzW3QwXSA9IDE7IGlmICghZmlyc3QgJiYgIWFsZXJ0ZWQgJiYgKGFsZXJ0ZWQgPSB0cnVlKSkgYXdhaXQgdGcoYPCfk6MgQUlEUk9QIOmHkeW6k+WHuueOsOaWsOeahOmTvuS4iuWKqOS9nO+8iOaWsOS6i+S7tuexu+Wei++8iVxcbuWPr+iDveaYr+W8gOaUvumihuWPluaIluW8gOWni+WPkeaUvu+8jOivt+iHquihjOafpeeci1xcbuS6pOaYkyAke2wudHJhbnNhY3Rpb25IYXNofWApOyB9IH1cbiAgICAgIFMuYWlkcm9wLmZyb20gPSBoZWFkICsgMTtcbiAgICB9IGNhdGNoIHt9XG4gIH1cblxuICBjb25zdCBUT1NIX0ZBQ1RPUklFUyA9IFtbJ0JOQicsICcweDA5MWQwY2JkMWUzYjdkOGIyYTZmZDhlMDc5NWI3ODRlZGRmZmI1OTAnXSwgWydVU0RUJywgJzB4ODI5NmZhMmQ0MzBkY2YyNTIzM2EzOWNjMzMwNmVlNTAzOTY3YTZiYiddXTtcblxuICBhc3luYyBmdW5jdGlvbiB0b3NoV2F0Y2goKSB7XG4gICAgUy50b3NoID0gUy50b3NoIHx8IHsgY291bnRzOiB7fSB9O1xuICAgIGZvciAoY29uc3QgW3F1b3RlLCBmXSBvZiBUT1NIX0ZBQ1RPUklFUykge1xuICAgICAgY29uc3QgciA9IGF3YWl0IGNhbGwoZiwgJzB4MjdjY2E1OWYnKTsgaWYgKCFyKSBjb250aW51ZTsgY29uc3QgbiA9IE51bWJlcihCaWdJbnQoci5zbGljZSgwLCA2NikpKTtcbiAgICAgIGNvbnN0IHByZXYgPSBTLnRvc2guY291bnRzW2ZdO1xuICAgICAgaWYgKHByZXYgPT09IHVuZGVmaW5lZCkgeyBTLnRvc2guY291bnRzW2ZdID0gbjsgY29udGludWU7IH0gLy8g56ys5LiA5qyh5Y+q6K6w5pWw6YeP77yM5LiN6YCa55+l5pen6aG555uuXG4gICAgICBmb3IgKGxldCBpID0gcHJldjsgaSA8IG47IGkrKykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IEwgPSBhd2FpdCBjYWxsKGYsICcweDdiNDQzYTc2JyArIHcoaSkpOyBjb25zdCBXNCA9IEwuc2xpY2UoMikubWF0Y2goLy57NjR9L2cpO1xuICAgICAgICAgIGNvbnN0IHRva2VuID0gJzB4JyArIFc0WzBdLnNsaWNlKDI0KSwgaG9vayA9ICcweCcgKyBXNFsxXS5zbGljZSgyNCksIGNyZWF0b3IgPSAnMHgnICsgVzRbMl0uc2xpY2UoMjQpLCBjcmVhdGVkQXQgPSBOdW1iZXIoQmlnSW50KCcweCcgKyBXNFszXSkpO1xuICAgICAgICAgIGNvbnN0IHN0ciA9IGFzeW5jIChzZWwpID0+IHsgY29uc3QgaCA9IGF3YWl0IGNhbGwodG9rZW4sIHNlbCk7IHRyeSB7IGNvbnN0IHggPSBoLnNsaWNlKDIpOyBjb25zdCBsZW4gPSBOdW1iZXIoQmlnSW50KCcweCcgKyB4LnNsaWNlKDY0LCAxMjgpKSk7IHJldHVybiBCdWZmZXIuZnJvbSh4LnNsaWNlKDEyOCwgMTI4ICsgbGVuICogMiksICdoZXgnKS50b1N0cmluZygndXRmOCcpOyB9IGNhdGNoIHsgcmV0dXJuICc/JzsgfSB9O1xuICAgICAgICAgIGNvbnN0IG5hbWUgPSBhd2FpdCBzdHIoJzB4MDZmZGRlMDMnKSwgc3ltID0gYXdhaXQgc3RyKCcweDk1ZDg5YjQxJyk7XG4gICAgICAgICAgLy8g5Yib5bu66ICF5Lul5YmN5Y+R6L+H5Yeg5Liq77yI5Lik5Liq5bel5Y6C6YO9566X77yJXG4gICAgICAgICAgbGV0IGJ5Q3JlYXRvciA9IDA7IGZvciAoY29uc3QgWywgZjJdIG9mIFRPU0hfRkFDVE9SSUVTKSB7IGNvbnN0IGMyID0gYXdhaXQgY2FsbChmMiwgJzB4MjdjY2E1OWYnKTsgY29uc3QgbjIgPSBjMiA/IE51bWJlcihCaWdJbnQoYzIuc2xpY2UoMCwgNjYpKSkgOiAwOyBmb3IgKGxldCBrID0gTWF0aC5tYXgoMCwgbjIgLSA2MCk7IGsgPCBuMjsgaysrKSB7IGNvbnN0IEwyID0gYXdhaXQgY2FsbChmMiwgJzB4N2I0NDNhNzYnICsgdyhrKSk7IGlmIChMMiAmJiBMMi5zbGljZSgyKS5tYXRjaCgvLns2NH0vZylbMl0uc2xpY2UoMjQpID09PSBjcmVhdG9yLnNsaWNlKDIpKSBieUNyZWF0b3IrKzsgfSB9XG4gICAgICAgICAgLy8g5a6Y572R6LWE5paZ77yI566A5LuL44CB5o6o54m544CBVEfvvIlcbiAgICAgICAgICBsZXQgbWV0YSA9IG51bGw7IHRyeSB7IGNvbnN0IGogPSBhd2FpdCAoYXdhaXQgZmV0Y2hJbXBsKCdodHRwczovL3Rvc2h4Lnh5ei9hcGkvcHJvamVjdHMnLCB7IHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxMDAwMCkgfSkpLmpzb24oKTsgbWV0YSA9IChqLmRhdGEgfHwgW10pLmZpbmQoKHApID0+IFN0cmluZyhwLnRva2VuX2FkZHJlc3MpLnRvTG93ZXJDYXNlKCkgPT09IHRva2VuKTsgfSBjYXRjaCB7fVxuICAgICAgICAgIGNvbnN0IHJhaXNlZFJhdyA9IHF1b3RlID09PSAnQk5CJyA/IGF3YWl0IHJwYygnZXRoX2dldEJhbGFuY2UnLCBbaG9vaywgJ2xhdGVzdCddKS5jYXRjaCgoKSA9PiAnMHgwJykgOiBhd2FpdCBjYWxsKFVTRFQsICcweDcwYTA4MjMxJyArIHdhKGhvb2spKTtcbiAgICAgICAgICBjb25zdCByYWlzZWQgPSBOdW1iZXIoQmlnSW50KHJhaXNlZFJhdyB8fCAnMHgwJykpIC8gMWUxODtcbiAgICAgICAgICBjb25zdCBmbGFncyA9IFtdO1xuICAgICAgICAgIGlmICghbWV0YSkgZmxhZ3MucHVzaCgn5a6Y572R6L+Y5rKh5pyJ6LWE5paZ77yI5Y+v6IO95piv5rWL6K+V55uY77yJJyk7XG4gICAgICAgICAgaWYgKG1ldGEgJiYgIW1ldGEudHdpdHRlcikgZmxhZ3MucHVzaCgn5rKh5pyJ5o6o54m5Jyk7XG4gICAgICAgICAgaWYgKG1ldGEgJiYgIW1ldGEud2Vic2l0ZSkgZmxhZ3MucHVzaCgn5rKh5pyJ5a6Y572RJyk7XG4gICAgICAgICAgaWYgKGJ5Q3JlYXRvciA+IDEpIGZsYWdzLnB1c2goYOWQjOS4gOS4quWIm+W7uuiAheW3suWPkei/hyAke2J5Q3JlYXRvcn0g5LiqYCk7XG4gICAgICAgICAgaWYgKC90ZXN0L2kudGVzdChuYW1lICsgc3ltKSkgZmxhZ3MucHVzaCgn5ZCN5a2X5YOP5rWL6K+V55uYJyk7XG4gICAgICAgICAgY29uc3QgZGVzYyA9IChtZXRhPy5kZXNjcmlwdGlvbiB8fCAnJykucmVwbGFjZSgvXFxzKy9nLCAnICcpLnNsaWNlKDAsIDIyMCk7XG4gICAgICAgICAgY29uc3QgdmVyZGljdCA9IGZsYWdzLmxlbmd0aCA+PSAyID8gJ/CflLQg6aKo6Zqq5YGP6auY77yM5bu66K2w6KeA5pybJyA6IGZsYWdzLmxlbmd0aCA9PT0gMSA/ICfwn5+hIOacieeWkem7nu+8jOiHquW3seWGjeeci+eciycgOiAn8J+foiDos4fmlpnpvYrlhajvvIzlj6/ku6XogIPmha4nO1xuICAgICAgICAgIC8vIOS9v+eUqOiAheeahOimj+WJh++8mueZvOWwhOWPsOS4iueahOS4gOiIrOS7o+W5o+S4jeaJk++8jOWPquaJk+W5s+WPsOW5o1xuICAgICAgICAgIGNvbnN0IFBMQVRGT1JNX0RFUExPWUVSID0gJzB4NzkwMDkxZTg5NjVlY2MxYWRmYTQwYWE5Yjk1NTE1YzYyODlkY2U5ZCc7IC8vIFRPU0gg5bmz5Y+w5bmj55qE5bu656uL6ICFXG4gICAgICAgICAgY29uc3QgaXNQbGF0Zm9ybSA9IGNyZWF0b3IudG9Mb3dlckNhc2UoKSA9PT0gUExBVEZPUk1fREVQTE9ZRVIgfHwgL3BsYXRmb3JtIHRva2VufOW5s+WPsOW4gXzlubPlj7DluaN8cGxhdGZvcm0gY29pbi9pLnRlc3QoKG1ldGE/LmRlc2NyaXB0aW9uIHx8ICcnKSArIG5hbWUpO1xuICAgICAgICAgIGlmICghaXNQbGF0Zm9ybSkgeyBsb2coYFRvc2hYIOaWsOmhueebriAke25hbWV9KCR7c3ltfSkg5LiN5piv5bmz5Y+w5biB77yM5oyJ6KeE5YiZ5LiN6YCa55+lYCk7IGNvbnRpbnVlOyB9XG4gICAgICAgICAgYXdhaXQgdGcoYPCfmoAgVG9zaFgg5bmz5Y+w5bmj55u46Zec5paw6aCF55uu77yaJHtuYW1lfe+8iCQke3N5bX3vvIlcXG7loLHlg7nluaPvvJoke3F1b3RlfSDCtyDlt7Lli5/liLDntIQgJHtyYWlzZWQudG9GaXhlZCgzKX0gJHtxdW90ZX1cXG7lu7rnq4vmmYLplpPvvJoke25ldyBEYXRlKGNyZWF0ZWRBdCAqIDEwMDApLnRvTG9jYWxlU3RyaW5nKCd6aC1UVycsIHsgaG91cjEyOiBmYWxzZSwgdGltZVpvbmU6IENPTkZJRy50aW1lWm9uZSB8fCAnQXNpYS9UYWlwZWknIH0pfVxcbiR7ZGVzYyA/ICfnsKHku4vvvJonICsgZGVzYyArICdcXG4nIDogJyd9JHttZXRhPy50d2l0dGVyID8gJ1jvvJonICsgbWV0YS50d2l0dGVyICsgJ1xcbicgOiAnJ30ke21ldGE/LnRlbGVncmFtID8gJ1RH77yaJyArIG1ldGEudGVsZWdyYW0gKyAnXFxuJyA6ICcnfeS7o+W5oyAke3Rva2VufVxcbuWIhuaekO+8miR7dmVyZGljdH0ke2ZsYWdzLmxlbmd0aCA/ICfvvIgnICsgZmxhZ3Muam9pbign44CBJykgKyAn77yJJyA6ICcnfVxcbuimj+WJh++8muavj+WAiyBBZ2VudCBJRCDkuIDku73poY3luqbvvIzpgJrluLjplovos6Plub7liIbpkJjlsLHmu7/jgILopoHmiZPnmoToqbHmiYvli5XomZXnkIbjgIzmiZMgJHtzeW1944CN5ZKM5q+P5YCL6Yyi5YyF5omT5aSa5bCRXFxuaHR0cHM6Ly90b3NoeC54eXovbGF1bmNocGFkYCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHsgbG9nKCd0b3NoIGVyciAnICsgZS5tZXNzYWdlKTsgfVxuICAgICAgfVxuICAgICAgUy50b3NoLmNvdW50c1tmXSA9IG47XG4gICAgfVxuICB9XG5cbiAgY29uc3QgRkxBUF9SRUFERVIgPSAnMHgxOGFhNmM5M2YxODg3YTI0M2ZkYzM0OGM5YTc3ZjUxMzY1NTUxNzRhJztcblxuICBjb25zdCBGTEFQX1FVT1RFUyA9IHsgJzB4NDkwMmM1ZWJjNTk4MjY1ZWQyMjEyYjU1OWIwNDJkZThhNWVlZWMzZic6ICdCTkNCJywgJzB4MDJmY2E2NmMxZDFhZmI0ZTJhNzg4NDI2MWViMDBmNjM1OThhNzQzNic6ICdOVkRBQicsICcweDIwNTgxMmNkYmVkOTIwYWZmNzZjNjU4MGFiZDY4MWE0NmQxMWVmYzcnOiAnUVFRQicsICcweGJlOWQxNTY4OTJlNTVlNzE1NGJjZDNjYjBmZWE2NzdmOWQzMTAzZTEnOiAnU1BDWEInIH07XG5cbiAgYXN5bmMgZnVuY3Rpb24gZmxhcEFnZW50V2F0Y2goKSB7XG4gICAgUy5mbGFwQWdlbnQgPSBTLmZsYXBBZ2VudCB8fCB7IHRvdGFsOiBudWxsLCBuYW1lczoge30gfTtcbiAgICBjb25zdCBwMCA9IGF3YWl0IGNhbGwoRkxBUF9SRUFERVIsICcweDhmODJlMTY1JyArIHcoMCkgKyB3KDEpKTsgaWYgKCFwMCkgcmV0dXJuO1xuICAgIGNvbnN0IHRvdGFsID0gTnVtYmVyKEJpZ0ludCgnMHgnICsgcDAuc2xpY2UoMiArIDEyOCwgMiArIDE5MikpKTtcbiAgICBpZiAoUy5mbGFwQWdlbnQudG90YWwgPT09IG51bGwpIHsgUy5mbGFwQWdlbnQudG90YWwgPSB0b3RhbDsgcmV0dXJuOyB9XG4gICAgZm9yIChsZXQgaSA9IFMuZmxhcEFnZW50LnRvdGFsOyBpIDwgdG90YWw7IGkrKykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcGcgPSBhd2FpdCBjYWxsKEZMQVBfUkVBREVSLCAnMHg4ZjgyZTE2NScgKyB3KGkpICsgdygxKSk7IGNvbnN0IFc1ID0gcGcuc2xpY2UoMikubWF0Y2goLy57NjR9L2cpOyBjb25zdCBvZmYgPSBOdW1iZXIoQmlnSW50KCcweCcgKyBXNVswXSkpIC8gMzI7IGNvbnN0IG0gPSAnMHgnICsgVzVbb2ZmICsgMV0uc2xpY2UoMjQpO1xuICAgICAgICBjb25zdCBzdCA9IGF3YWl0IGNhbGwoRkxBUF9SRUFERVIsICcweDUxYzAyM2UyJyArIHdhKG0pKTsgY29uc3QgU1cgPSBzdC5zbGljZSgyKS5tYXRjaCgvLns2NH0vZyk7XG4gICAgICAgIGNvbnN0IHQwID0gTnVtYmVyKEJpZ0ludCgnMHgnICsgU1dbMF0pKSAvIDMyLCBpbm5lciA9IHQwICsgTnVtYmVyKEJpZ0ludCgnMHgnICsgU1dbdDBdKSkgLyAzMjtcbiAgICAgICAgY29uc3QgbmFtZSA9IGRlY1N0ckF0KHN0LCAoaW5uZXIgKyBOdW1iZXIoQmlnSW50KCcweCcgKyBTV1tpbm5lcl0pKSAvIDMyKSAqIDMyKSwgc3ltID0gZGVjU3RyQXQoc3QsIChpbm5lciArIE51bWJlcihCaWdJbnQoJzB4JyArIFNXW2lubmVyICsgMV0pKSAvIDMyKSAqIDMyKTtcbiAgICAgICAgY29uc3QgYnV5VGF4ID0gTnVtYmVyKEJpZ0ludCgnMHgnICsgU1dbaW5uZXIgKyA1XSkpIC8gMTAwLCBzZWxsVGF4ID0gTnVtYmVyKEJpZ0ludCgnMHgnICsgU1dbaW5uZXIgKyA2XSkpIC8gMTAwLCBtYXhXID0gTnVtYmVyKEJpZ0ludCgnMHgnICsgU1dbaW5uZXIgKyAxMV0pKSAvIDEwMDtcbiAgICAgICAgY29uc3QgcXVvdGUgPSAnMHgnICsgU1dbdDAgKyAxXS5zbGljZSgyNCk7IGNvbnN0IHFuID0gL14weDB7NDB9JC8udGVzdChxdW90ZSkgPyAnQk5CJyA6IEZMQVBfUVVPVEVTW3F1b3RlXSB8fCBxdW90ZS5zbGljZSgwLCAxMCk7XG4gICAgICAgIGNvbnN0IGtleSA9IChzeW0gfHwgbmFtZSkudG9Mb3dlckNhc2UoKTsgY29uc3QgZHVwID0gUy5mbGFwQWdlbnQubmFtZXNba2V5XTsgUy5mbGFwQWdlbnQubmFtZXNba2V5XSA9IChkdXAgfHwgMCkgKyAxO1xuICAgICAgICBjb25zdCBmbGFncyA9IFtdOyBpZiAoYnV5VGF4ICsgc2VsbFRheCA+IDgpIGZsYWdzLnB1c2goYOeoheWBj+mrmCAke2J1eVRheH0lLyR7c2VsbFRheH0lYCk7IGlmIChkdXApIGZsYWdzLnB1c2goJ+i3n+miqOWQjOWQje+8iOS5i+WJjeW3suacieWQjOWQjeebpO+8iScpOyBpZiAoLzx8c2NyaXB0fG9uZXJyb3J8aHR0cC9pLnRlc3QobmFtZSArIHN5bSkpIGZsYWdzLnB1c2goJ+KaoO+4jyDlkI3nqLHlkKvlj6/nlpHnqIvlvI/norzvvIzliKXlnKjntrLpoIHkuIrpu54nKTtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IGZsYWdzLmxlbmd0aCA+PSAyID8gJ/CflLQg5bu66K2w6Lez6YGOJyA6IGZsYWdzLmxlbmd0aCA9PT0gMSA/ICfwn5+hIOacieeWkem7nicgOiAn8J+foiDpppbnmbzjgIHnqIXlkIjnkIYnO1xuICAgICAgICBpZiAoIS9eKGZsYXB8ZmxhcHgpJC9pLnRlc3Qoc3ltLnRyaW0oKSkpIHsgbG9nKGBGbGFwIEFnZW50IOaWsOebmCAke25hbWV9KCR7c3ltfSkg5piv5Y+R5bCE5Y+w5Luj5biB77yM5oyJ6KeE5YiZ5LiN6YCa55+lYCk7IGNvbnRpbnVlOyB9XG4gICAgICAgIGF3YWl0IHRnKGDwn6aLIEZsYXAgSUQgQUdFTlQgQ1VSVkUg5paw55uk77yaJHtuYW1lLnNsaWNlKDAsIDQwKX3vvIgke3N5bS5zbGljZSgwLCAyMCl977yJXFxu5bqV5rGg77yaJHtxbn0gwrcg56iFICR7YnV5VGF4fSUvJHtzZWxsVGF4fSUgwrcg5Zau6Yyi5YyF5LiK6ZmQICR7bWF4V30lXFxu5YiG5p6Q77yaJHt2ZXJkaWN0fSR7ZmxhZ3MubGVuZ3RoID8gJ++8iCcgKyBmbGFncy5qb2luKCfjgIEnKSArICfvvIknIDogJyd9XFxu5biC5aC0ICR7bX1cXG7opoHmiZPnmoToqbHmiYvli5XomZXnkIbjgIzmiZMgJHtzeW0uc2xpY2UoMCwgMjApfeOAjeWSjOmHkemhjWApO1xuICAgICAgfSBjYXRjaCAoZSkgeyBsb2coJ2ZsYXBBZ2VudCBlcnIgJyArIGUubWVzc2FnZSk7IH1cbiAgICB9XG4gICAgUy5mbGFwQWdlbnQudG90YWwgPSB0b3RhbDtcbiAgfVxuXG4gIGNvbnN0IEVMRU1FTlRfRVggPSAnMHhiM2UzZGZjYjJkOWYzZGRlMTZkNzhiOWU2ZWIzNTM4ZWIzMmI1YWUxJztcblxuICBjb25zdCBUXzcyMV9GSUxMRUQgPSAnMHg5YzI0OGFhMWEyNjVhYTYxNmY3MDdiOTc5ZDU3ZjQ1MjliYjYzYTRmYzM0ZGM3ZmM2MWZkZGRjMTg0MTBmNzRlJztcblxuICBhc3luYyBmdW5jdGlvbiBuZnRWb2xXYXRjaCgpIHtcbiAgICBTLm5mdENvbHMgPSBTLm5mdENvbHMgfHwge307IFMubmZ0Vm9sID0gUy5uZnRWb2wgfHwge307XG4gICAgaWYgKCFTLm5mdENvbHNCYWNrZmlsbGVkKSB7IC8vIOesrOS4gOasoe+8muW+nuaXpeiqjOijnOWbnuS5i+WJjeaJk+WIsOeahCBORlQg57O75YiXXG4gICAgICB0cnkgeyBmb3IgKGNvbnN0IGwgb2YgcmVhZEZpbGVTeW5jKExPRywgJ3V0ZjgnKS5zcGxpdCgnXFxuJykpIHsgaWYgKCFsLmluY2x1ZGVzKCflt7Loh6rli5XpkYTpgKAnKSB8fCAhbC5pbmNsdWRlcygnTkZUJykpIGNvbnRpbnVlOyBjb25zdCBtID0gbC5tYXRjaCgvXFxdICgweFthLWZBLUYwLTldezQwfSkgLyk7IGlmIChtKSBTLm5mdENvbHNbbVsxXS50b0xvd2VyQ2FzZSgpXSA9IDE7IH0gfSBjYXRjaCB7fVxuICAgICAgUy5uZnRDb2xzQmFja2ZpbGxlZCA9IHRydWU7XG4gICAgfVxuICAgIGNvbnN0IGhlYWQgPSBwYXJzZUludChhd2FpdCBycGMoJ2V0aF9ibG9ja051bWJlcicsIFtdKSwgMTYpLCBmcm9tID0gaGVhZCAtIDk2MDAwOyAvLyDntIQgMTIg5bCP5pmCXG4gICAgLy8gMSkgRWxlbWVudCDmiJDkuqTvvIjkuIDmrKHmipPlrozlho3mjInns7vliJfliIbvvIlcbiAgICBjb25zdCBmaWxscyA9IHt9O1xuICAgIGZvciAobGV0IGIgPSBmcm9tOyBiIDw9IGhlYWQ7IGIgKz0gMTAwMDApIHtcbiAgICAgIGNvbnN0IEwgPSBhd2FpdCBycGMoJ2V0aF9nZXRMb2dzJywgW3sgYWRkcmVzczogRUxFTUVOVF9FWCwgdG9waWNzOiBbVF83MjFfRklMTEVEXSwgZnJvbUJsb2NrOiAnMHgnICsgYi50b1N0cmluZygxNiksIHRvQmxvY2s6ICcweCcgKyBNYXRoLm1pbihiICsgOTk5OSwgaGVhZCkudG9TdHJpbmcoMTYpIH1dKS5jYXRjaCgoKSA9PiBbXSk7XG4gICAgICBmb3IgKGNvbnN0IGwgb2YgTCB8fCBbXSkgeyBjb25zdCB3ID0gbC5kYXRhLnNsaWNlKDIpLm1hdGNoKC8uezY0fS9nKSB8fCBbXTsgY29uc3QgY29sID0gJzB4JyArICh3WzddIHx8ICcnKS5zbGljZSgyNCk7IGlmICghUy5uZnRDb2xzW2NvbF0pIGNvbnRpbnVlOyBjb25zdCBpc0JuYiA9ICh3WzRdIHx8ICcnKS5lbmRzV2l0aCgnZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZScpOyBjb25zdCBweCA9IE51bWJlcihCaWdJbnQoJzB4JyArICh3WzVdIHx8ICcwJykpKSAvIDFlMTg7IChmaWxsc1tjb2xdID0gZmlsbHNbY29sXSB8fCBbXSkucHVzaChpc0JuYiA/IHB4IDogbnVsbCk7IH1cbiAgICAgIGF3YWl0IHNsZWVwKDIwMCk7XG4gICAgfVxuICAgIC8vIDIpIOWQhOezu+WIl+i9ieaJi+asoeaVuO+8iOS4jeWQq+aWsOmRhOmAoO+8ie+8i+aIkeWAkeaMgeacieW5vuW8tVxuICAgIGZvciAoY29uc3QgY29sIG9mIE9iamVjdC5rZXlzKFMubmZ0Q29scykpIHtcbiAgICAgIGxldCBtb3ZlcyA9IDA7XG4gICAgICBmb3IgKGxldCBiID0gZnJvbTsgYiA8PSBoZWFkOyBiICs9IDUwMDAwKSB7IGNvbnN0IEwgPSBhd2FpdCBycGMoJ2V0aF9nZXRMb2dzJywgW3sgYWRkcmVzczogY29sLCB0b3BpY3M6IFtUX1RSQU5TRkVSXSwgZnJvbUJsb2NrOiAnMHgnICsgYi50b1N0cmluZygxNiksIHRvQmxvY2s6ICcweCcgKyBNYXRoLm1pbihiICsgNDk5OTksIGhlYWQpLnRvU3RyaW5nKDE2KSB9XSkuY2F0Y2goKCkgPT4gW10pOyBmb3IgKGNvbnN0IGwgb2YgTCB8fCBbXSkgaWYgKGwudG9waWNzLmxlbmd0aCA9PT0gNCAmJiAhL14weDArJC8udGVzdChsLnRvcGljc1sxXSkpIG1vdmVzKys7IH1cbiAgICAgIGxldCBoZWxkID0gMDsgZm9yIChjb25zdCBXIG9mIFdBTExFVFMpIHsgY29uc3QgciA9IGF3YWl0IGNhbGwoY29sLCAnMHg3MGEwODIzMScgKyB3YShXLmFkZHIpKTsgaWYgKHIgJiYgci5sZW5ndGggPj0gNjYpIGhlbGQgKz0gTnVtYmVyKEJpZ0ludChyLnNsaWNlKDAsIDY2KSkpOyB9XG4gICAgICBjb25zdCBmID0gZmlsbHNbY29sXSB8fCBbXSwgcHJldiA9IFMubmZ0Vm9sW2NvbF07XG4gICAgICBjb25zdCBweCA9IGYuZmlsdGVyKCh4KSA9PiB4ICE9IG51bGwpLCB2b2wgPSBweC5yZWR1Y2UoKGEsIGIpID0+IGEgKyBiLCAwKTtcbiAgICAgIGNvbnN0IGhvdCA9IGhlbGQgPiAwICYmIHB4Lmxlbmd0aCA+PSAzICYmIHZvbCA+IDAgJiYgKHByZXYgPyBweC5sZW5ndGggPj0gMiAqIChwcmV2LmYgfHwgMCkgOiBweC5sZW5ndGggPj0gNSk7IC8vIOWPqueci+ecn+eahOacieS7mOmMoueahOaIkOS6pO+8iOS9v+eUqOiAhSAxNToyMu+8mui9ieS+hui9ieWOu+S4jeeul++8iVxuICAgICAgaWYgKGhvdCkge1xuICAgICAgICBjb25zdCBuYW1lID0gdG9rU3RyKGF3YWl0IGNhbGwoY29sLCAnMHgwNmZkZGUwMycpKSB8fCBjb2wuc2xpY2UoMCwgMTApO1xuICAgICAgICBhd2FpdCB0Zyhg8J+miyBORlQg5oiQ5Lqk6YeP6K6K5aSa77yaJHtuYW1lfVxcbumMouWMheWFseaMgeaciSAke2hlbGR9IOW8tVxcbumBjuWOuyAxMiDlsI/mmYIgRWxlbWVudCDmiJDkuqQgJHtmLmxlbmd0aH0g562GJHtwcmV2ID8gJ++8iOS4iuasoSAnICsgKHByZXYuZiB8fCAwKSArICcg562G77yJJyA6ICcnfSR7cHgubGVuZ3RoID8gYO+8jOaIkOS6pOWDuSAke01hdGgubWluKC4uLnB4KS50b0ZpeGVkKDQpfe+9niR7TWF0aC5tYXgoLi4ucHgpLnRvRml4ZWQoNCl9IEJOQu+8jOWQiOioiCAke3ZvbC50b0ZpeGVkKDQpfSBCTkJgIDogJyd9XFxu6L2J5omLICR7bW92ZXN9IOasoSR7cHJldiA/ICfvvIjkuIrmrKEgJyArIChwcmV2LnQgfHwgMCkgKyAnIOasoe+8iScgOiAnJ31cXG4ke2NvbH1cXG5odHRwczovL2VsZW1lbnQubWFya2V0L2Fzc2V0cy9ic2MvJHtjb2x9LzFcXG7opoHmjpvllq7miJbos6PmiYvli5XomZXnkIZgKTtcbiAgICAgIH1cbiAgICAgIFMubmZ0Vm9sW2NvbF0gPSB7IGY6IGYubGVuZ3RoLCB0OiBtb3ZlcywgaGVsZCwgYXQ6IHRzKCkgfTtcbiAgICAgIGF3YWl0IHNsZWVwKDE1MCk7XG4gICAgfVxuICAgIGxvZyhgTkZUIOaIkOS6pOmHj+aqouafpeWujOaIkO+8miR7T2JqZWN0LmtleXMoUy5uZnRDb2xzKS5sZW5ndGh9IOWAi+ezu+WIl2ApO1xuICB9XG4gIHJldHVybiB7XG4gICAgZ2V0IGZyZWVQcm9nV2F0Y2goKSB7IHJldHVybiBmcmVlUHJvZ1dhdGNoOyB9LFxuICAgIGdldCBsb3dCbmJXYXRjaCgpIHsgcmV0dXJuIGxvd0JuYldhdGNoOyB9LFxuICAgIGdldCBwcnVuZVN0YXRlKCkgeyByZXR1cm4gcHJ1bmVTdGF0ZTsgfSxcbiAgICBnZXQgZGFpbHlSZXBvcnQoKSB7IHJldHVybiBkYWlseVJlcG9ydDsgfSxcbiAgICBnZXQgYWlkcm9wV2F0Y2goKSB7IHJldHVybiBhaWRyb3BXYXRjaDsgfSxcbiAgICBnZXQgdG9zaFdhdGNoKCkgeyByZXR1cm4gdG9zaFdhdGNoOyB9LFxuICAgIGdldCBmbGFwQWdlbnRXYXRjaCgpIHsgcmV0dXJuIGZsYXBBZ2VudFdhdGNoOyB9LFxuICAgIGdldCBuZnRWb2xXYXRjaCgpIHsg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

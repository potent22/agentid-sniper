// Module: project-risk. Construction is inert; I/O is invoked explicitly.
import { feeDay } from '../../receipt-fees.mjs';
import { mintRiskDecision } from '../../mint-risk-policy.mjs';
export function createProjectRisk(dependencies) {
  const {
    CONFIG,
    FACTORY,
    FLAP_BAN,
    FLAP_BLOCK,
    PAID,
    RISK,
    S,
    USDT,
    WALLETS,
    WBNB,
    big,
    call,
    codeOf,
    fullCode,
    log,
    rpc,
    tg,
    tokStr,
    ts,
    w,
    wa
  } = dependencies;
  async function riskNote(c) {
    /* 新功能：看合約有沒有「增發／暫停／黑名單／改稅」這類開發者權限，只提醒不擋 */
    try {
      const code = (await rpc('eth_getCode', [c, 'latest'])) || '';
      if (code.length < 10) return '';
      const has = sels => sels.some(x => code.includes('63' + x));
      const f = [];
      if (has(['40c10f19'])) f.push('可增發');
      if (has(['8456cb59', '02329a29'])) f.push('可暫停交易');
      if (has(['f9f92be4', '44337ea1', '0ecb93c0', '1a895266'])) f.push('有黑名單');
      if (has(['8c0b5e22', 'c0246668', '5342acb4', 'aa4b6fca', '061c82d0'])) f.push('可改稅/限額');
      if (!f.length) return '';
      const ow = await call(c, '0x8da5cb5b');
      if (ow && BigInt(ow.slice(0, 66)) === 0n) return '';
      return '\n⚠️ 合約權限提醒：' + f.join('、') + '（開發者還沒放棄權限）';
    } catch {
      return '';
    }
  }
  async function honeypotCheck(W, t, st, bal) {
    /* 新功能：開池時模擬「把幣轉進池子」（賣出第一步），轉不過去很可能是貔貅 */
    if (st.hpChecked || !st.pair || !/^0x[0-9a-f]{40}$/.test(st.pair) || !(bal > 0n)) return;
    st.hpChecked = 1;
    try {
      await rpc('eth_call', [{
        from: W.addr,
        to: t.addr,
        data: '0xa9059cbb' + wa(st.pair) + w(bal / 100n || 1n)
      }, 'latest']);
    } catch (e) {
      await tg(`⚠️ [${W.name}] ${t.sym} 開池了，但模擬賣出失敗，可能是貔貅（只能買不能賣），自動賣出可能會失敗\n${t.addr}`);
    }
  }
  async function lockNote(c, wAddr) {
    /* 買到的幣現在能不能轉：模擬轉 1 單位到黑洞地址，被擋就提醒（像 aiagentbsc 的白名單鎖）（使用者 10/30 21:44 要補的漏洞） */
    const toks = [...new Set([c, ...(S.dyn || []).filter(t => t.only === wAddr).slice(-3).map(t => t.addr)])];
    for (const t of toks) {
      const dR = await call(t, '0x313ce567');
      if (!(dR && dR.length >= 66)) continue; /* NFT 沒有小數位數，不能用轉代幣的方式測（以前 NFT 會誤報轉不出去） */
      const b = big(await call(t, '0x70a08231' + wa(wAddr)));
      if (!(b > 0n)) continue;
      try {
        await rpc('eth_call', [{
          from: wAddr,
          to: t,
          data: '0xa9059cbb' + wa('0x000000000000000000000000000000000000dead') + w(1n)
        }, 'latest']);
        return '';
      } catch (e) {
        return `\n⚠️ 這個幣現在轉不出去（${String(e.message).slice(0, 40)}）：可能要等開發者開放交易，也可能是貔貅`;
      }
    }
    return '';
  }
  function flapGuard(to, data, sim) {
    if (!FLAP_BAN) return '';
    if (FLAP_BLOCK.has(String(to).toLowerCase())) return '禁止跟 Flap 合約互動';
    const d = String(data || '').toLowerCase();
    if (/^0x(095ea7b3|39509351)/.test(d) && FLAP_BLOCK.has('0x' + d.slice(34, 74))) return '禁止授權給 Flap';
    if ((sim?.allowanceChanges || []).some(a => FLAP_BLOCK.has(String(a.spender).toLowerCase()))) return '會授權給 Flap，禁止';
    return '';
  }
  async function enforceMintRisk(project, knownCode = null) {
    project = String(project).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(project)) throw new Error('無法核實項目合約');
    const developer = String(S.depFrom?.[project] || '').toLowerCase();
    const possibleDevelopers = [developer, String(S.deployer?.[project] || '').toLowerCase()].filter(Boolean);
    const black = Object.keys(S.black || {}).some(address => possibleDevelopers.includes(address.toLowerCase()));
    let code = knownCode;
    if (!code) code = await fullCode(project, await codeOf(project)).catch(() => '');
    const reason = mintRiskDecision({
      developer,
      code,
      blacklisted: black,
      serial: Boolean(code && isSerial(code)),
      // The scanner does not prove uninterrupted 24h coverage; no independent,
      // verified developer rug-history source is wired in. Never infer clearance.
      deploymentCoverageComplete: false,
      rugHistoryVerified: false
    });
    if (reason) throw new Error('風控攔截：' + reason);
  }
  function codePrint(code) {
    const c = (code || '').toLowerCase().replace(/0x/, '');
    return c.length + ':' + c.slice(0, 120) + c.slice(-120);
  }
  function noteDeploy(code) {
    const fp = codePrint(code);
    S.fps = S.fps || {};
    const now = Date.now();
    const arr = (S.fps[fp] || []).filter(t => now - t < 86400e3);
    arr.push(now);
    S.fps[fp] = arr.slice(-20);
    if (Object.keys(S.fps).length > 3000) S.fps = {};
    return arr.length;
  }
  function isSerial(code) {
    const arr = (S.fps || {})[codePrint(code)] || [];
    return arr.filter(t => Date.now() - t < 86400e3).length >= 3;
  }
  async function deployerOf(c) {
    S.deployer = S.deployer || {};
    if (S.deployer[c]) return S.deployer[c];
    const ow = await call(c, '0x8da5cb5b');
    if (ow && ow.length >= 66 && BigInt(ow.slice(0, 66)) > 0n) return S.deployer[c] = '0x' + ow.slice(26, 66);
    return '';
  }
  async function freshWallet(a) {
    // 部署者是不是大約 8 小時內才開始用的新錢包（查不到就當不是）
    try {
      const head = parseInt(await rpc('eth_blockNumber', []), 16);
      const old = await rpc('eth_getTransactionCount', [a, '0x' + (head - 60000).toString(16)]);
      const now = await rpc('eth_getTransactionCount', [a, 'latest']);
      return parseInt(old, 16) === 0 && parseInt(now, 16) < 50;
    } catch {
      return false;
    }
  }
  function noteDev(dep, c) {
    if (!dep) return;
    S.devs = S.devs || {};
    const now = Date.now();
    const arr = (S.devs[dep] || []).filter(x => now - x.t < 86400e3 && x.c !== c);
    arr.push({
      t: now,
      c
    });
    S.devs[dep] = arr.slice(-30);
    if (Object.keys(S.devs).length > 5000) S.devs = {};
    (async () => {
      let n = tokStr(await call(c, '0x95d89b41')) || tokStr(await call(c, '0x06fdde03'));
      if (!n) {
        const tr = await call(c, '0xfc0c546a');
        if (tr && tr.length >= 66 && BigInt(tr.slice(0, 66)) > 0n) n = tokStr(await call('0x' + tr.slice(26, 66), '0x95d89b41'));
      }
      const e = (S.devs[dep] || []).find(x => x.c === c);
      if (e && n) e.n = n;
    })().catch(() => {});
  }
  const devKey = x => String(x.n || S.paid?.[x.c]?.name || x.c).toLowerCase().replace(/\s*\(.*?\)\s*/g, '').replace(/^\$/, '').trim();
  const DEV_MAX = 10;
  function riskDay() {
    const d = feeDay(Date.now(), CONFIG.timeZone || 'Asia/Shanghai');
    if (!S.risk || S.risk.d !== d) S.risk = {
      d,
      spend: {},
      free: {},
      warned: {},
      rev: {}
    };
    const day = S.feeDays?.[d] || {};
    S.risk.spend = {};
    S.risk.free = {};
    S.risk.rev = {};
    for (const W of WALLETS) {
      const fees = day[W.addr];
      if (!fees) continue;
      S.risk.spend[W.name] = Number(BigInt(fees.gasWei)) / 1e18;
      S.risk.free[W.name] = fees.freeProjects;
      for (const [project, count] of Object.entries(fees.failedProjects)) S.risk.rev[project] = (S.risk.rev[project] || 0) + count;
    }
    return S.risk;
  }
  const UPG_SLOTS = ['0x360894a13ba1a3210667c828492db98dca3e2076cc3735a8ce03b6d4d6b6bbc', '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50', '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036a5a723fd8ee048ed3f8c3'];
  async function upgradeable(c) {
    /* 可升級代理合約：項目方事後能把程式（包括保本機制）整個換掉 */S.upg = S.upg || {};
    if (S.upg[c] != null) return !!S.upg[c];
    let u = 0;
    for (const sl of UPG_SLOTS) {
      const v = await rpc('eth_getStorageAt', [c, sl, 'latest']).catch(() => null);
      if (v && /[1-9a-f]/i.test(v.slice(2))) {
        u = 1;
        break;
      }
    }
    S.upg[c] = u;
    return !!u;
  }
  async function nftJunk(c) {
    /* 使用者 11/1 15:03：NFT 的圖片連結是假的或空的（像 ipfs://sniper-test-nft/1）就不打——批量掏手續費的垃圾項目連圖都沒做 */
    S.nftJunk = S.nftJunk || {};
    if (S.nftJunk[c] != null) return S.nftJunk[c];
    const code = ((await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || '').toLowerCase();
    let fc = code;
    try {
      fc = await fullCode(c, code);
    } catch {}
    if (!fc.includes('c87b56dd')) return S.nftJunk[c] = ''; /* 不是 NFT（沒有 tokenURI） */
    const str = r => {
      try {
        const b = Buffer.from(r.slice(2), 'hex');
        const n = Number(BigInt('0x' + b.slice(32, 64).toString('hex')));
        return b.slice(64, 64 + n).toString('utf8').trim();
      } catch {
        return '';
      }
    };
    let uri = null;
    for (const id of [1n, 0n]) {
      const r = await call(c, '0xc87b56dd' + w(id));
      if (r && r.length > 130) {
        uri = str(r);
        break;
      }
      if (r) uri = uri ?? '';
    }
    if (uri == null) return ''; /* 讀不到（可能還沒鑄出任何一個），先不判斷 */
    const ok = /^data:/i.test(uri) || /^https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(uri) || /^ar:\/\/[A-Za-z0-9_-]{30,}/.test(uri) || /^ipfs:\/\/(ipfs\/)?(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})/.test(uri);
    return S.nftJunk[c] = ok ? '' : `NFT 圖片連結是${uri ? '假的（' + uri.slice(0, 40) + '）' : '空的'}`;
  }
  async function riskBlock(W, c, valWei, data, isFree, paid = false) {
    /* 回傳不打的原因；空字串＝可以打 */
    const R = riskDay();
    {
      const nj = await nftJunk(c).catch(() => '');
      if (nj) return nj + '，疑似垃圾項目';
    }
    if ((R.rev[c] || 0) >= RISK.revMax) return `這個合約上鏈失敗 ${R.rev[c]} 次，不再試（避免一直燒 gas）`;
    if (!paid && (R.spend[W.name] || 0) >= RISK.dayBnb) {
      if (!R.warned[W.name]) {
        R.warned[W.name] = 1;
        tg(`⚠️ [${W.name}] 今天手續費＋gas 已花 ${R.spend[W.name].toFixed(4)} BNB，達到每日上限 ${RISK.dayBnb} BNB，今天停止自動打（賣出不受影響）`).catch(() => {});
      }
      return `今天手續費＋gas 已達 ${RISK.dayBnb} BNB 上限`;
    }
    if (isFree && !(R.free[W.name] || []).includes(c) && (R.free[W.name] || []).length >= RISK.freePerDay) return `今天已自動打 ${RISK.freePerDay} 個免費項目，達到上限`;
    const bal = Number(BigInt((await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x0')) || '0x0')) / 1e18;
    if (bal - Number(valWei) / 1e18 < PAID.keepBnb) return `BNB 低於保留額 ${PAID.keepBnb}，只留給賣出用`;
    if (data !== '0x') {
      try {
        const g = await rpc('eth_estimateGas', [{
          from: W.addr,
          to: c,
          data,
          value: '0x' + BigInt(valWei).toString(16)
        }]);
        const gp = await rpc('eth_gasPrice', []);
        const fee = Number(BigInt(g)) * Number(BigInt(gp)) / 1e18;
        if (fee > (paid ? RISK.gasMaxPaid : RISK.gasMax)) return `預估 gas ${fee.toFixed(5)} BNB 太高`;
      } catch {
        return '無法估算 gas，暫停交易';
      }
    }
    return '';
  }
  async function serialDev(c) {
    const dep = (S.depFrom || {})[c];
    if (!dep) return ''; /* 只用「實際送出部署交易的錢包」判斷，不用 owner()（發射台的項目 owner 常是同一個平台，會誤殺） */
    const n = new Set(((S.devs || {})[dep] || []).filter(x => Date.now() - x.t < 86400e3).map(x => x.c)).size;
    return n >= DEV_MAX ? `同一個部署者 ${dep.slice(0, 10)}… 24 小時內部署了 ${n} 個項目` : '';
  }
  function isRepeatDev(dep) {
    return !!dep && new Set(((S.devs || {})[dep] || []).filter(x => Date.now() - x.t < 86400e3).map(devKey)).size >= 3;
  }
  function blacklist(dep, why) {
    if (!dep) return;
    S.black = S.black || {};
    if (!S.black[dep]) {
      S.black[dep] = {
        at: ts(),
        why
      };
      log(`黑名單：${dep}（${why}）`);
    }
  }
  async function repeatDevOk(dep, c, P) {
    const mine = devKey({
      c,
      n: P.name
    });
    const others = ((S.devs || {})[dep] || []).filter(x => x.c !== c);
    if (others.some(x => devKey(x) === mine)) return '同名重新部署';
    for (const x of others) {
      // 他之前的項目有沒有正常開盤（池子還有錢、沒被抽走）
      let tk = x.c;
      const tr = await call(x.c, '0xfc0c546a');
      if (tr && tr.length >= 66 && BigInt(tr.slice(0, 66)) > 0n) tk = '0x' + tr.slice(26, 66);
      for (const q of [WBNB, USDT]) {
        const pr = await call(FACTORY, '0xe6a43905' + wa(tk) + wa(q));
        if (!pr || !(BigInt(pr) > 0n)) continue;
        const rs = await call('0x' + pr.slice(26), '0x0902f1ac');
        if (rs && BigInt('0x' + rs.slice(2, 66)) > 0n && BigInt('0x' + rs.slice(66, 130)) > 0n) return '之前有項目正常開盤';
      }
    }
    return '';
  }
  return {
    get flapGuard() {
      return flapGuard;
    },
    get riskNote() {
      return riskNote;
    },
    get honeypotCheck() {
      return honeypotCheck;
    },
    get lockNote() {
      return lockNote;
    },
    get enforceMintRisk() {
      return enforceMintRisk;
    },
    get noteDeploy() {
      return noteDeploy;
    },
    get isSerial() {
      return isSerial;
    },
    get deployerOf() {
      return deployerOf;
    },
    get freshWallet() {
      return freshWallet;
    },
    get noteDev() {
      return noteDev;
    },
    get upgradeable() {
      return upgradeable;
    },
    get riskBlock() {
      return riskBlock;
    },
    get serialDev() {
      return serialDev;
    },
    get isRepeatDev() {
      return isRepeatDev;
    },
    get blacklist() {
      return blacklist;
    },
    get repeatDevOk() {
      return repeatDevOk;
    }
  };
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJmZWVEYXkiLCJtaW50Umlza0RlY2lzaW9uIiwiY3JlYXRlUHJvamVjdFJpc2siLCJkZXBlbmRlbmNpZXMiLCJDT05GSUciLCJGQUNUT1JZIiwiRkxBUF9CQU4iLCJGTEFQX0JMT0NLIiwiUEFJRCIsIlJJU0siLCJTIiwiVVNEVCIsIldBTExFVFMiLCJXQk5CIiwiYmlnIiwiY2FsbCIsImNvZGVPZiIsImZ1bGxDb2RlIiwibG9nIiwicnBjIiwidGciLCJ0b2tTdHIiLCJ0cyIsInciLCJ3YSIsInJpc2tOb3RlIiwiYyIsImNvZGUiLCJsZW5ndGgiLCJoYXMiLCJzZWxzIiwic29tZSIsIngiLCJpbmNsdWRlcyIsImYiLCJwdXNoIiwib3ciLCJCaWdJbnQiLCJzbGljZSIsImpvaW4iLCJob25leXBvdENoZWNrIiwiVyIsInQiLCJzdCIsImJhbCIsImhwQ2hlY2tlZCIsInBhaXIiLCJ0ZXN0IiwiZnJvbSIsImFkZHIiLCJ0byIsImRhdGEiLCJlIiwibmFtZSIsInN5bSIsImxvY2tOb3RlIiwid0FkZHIiLCJ0b2tzIiwiU2V0IiwiZHluIiwiZmlsdGVyIiwib25seSIsIm1hcCIsImRSIiwiYiIsIlN0cmluZyIsIm1lc3NhZ2UiLCJmbGFwR3VhcmQiLCJzaW0iLCJ0b0xvd2VyQ2FzZSIsImQiLCJhbGxvd2FuY2VDaGFuZ2VzIiwiYSIsInNwZW5kZXIiLCJlbmZvcmNlTWludFJpc2siLCJwcm9qZWN0Iiwia25vd25Db2RlIiwiRXJyb3IiLCJkZXZlbG9wZXIiLCJkZXBGcm9tIiwicG9zc2libGVEZXZlbG9wZXJzIiwiZGVwbG95ZXIiLCJCb29sZWFuIiwiYmxhY2siLCJPYmplY3QiLCJrZXlzIiwiYWRkcmVzcyIsImNhdGNoIiwicmVhc29uIiwiYmxhY2tsaXN0ZWQiLCJzZXJpYWwiLCJpc1NlcmlhbCIsImRlcGxveW1lbnRDb3ZlcmFnZUNvbXBsZXRlIiwicnVnSGlzdG9yeVZlcmlmaWVkIiwiY29kZVByaW50IiwicmVwbGFjZSIsIm5vdGVEZXBsb3kiLCJmcCIsImZwcyIsIm5vdyIsIkRhdGUiLCJhcnIiLCJkZXBsb3llck9mIiwiZnJlc2hXYWxsZXQiLCJoZWFkIiwicGFyc2VJbnQiLCJvbGQiLCJ0b1N0cmluZyIsIm5vdGVEZXYiLCJkZXAiLCJkZXZzIiwibiIsInRyIiwiZmluZCIsImRldktleSIsInBhaWQiLCJ0cmltIiwiREVWX01BWCIsInJpc2tEYXkiLCJ0aW1lWm9uZSIsInJpc2siLCJzcGVuZCIsImZyZWUiLCJ3YXJuZWQiLCJyZXYiLCJkYXkiLCJmZWVEYXlzIiwiZmVlcyIsIk51bWJlciIsImdhc1dlaSIsImZyZWVQcm9qZWN0cyIsImNvdW50IiwiZW50cmllcyIsImZhaWxlZFByb2plY3RzIiwiVVBHX1NMT1RTIiwidXBncmFkZWFibGUiLCJ1cGciLCJ1Iiwic2wiLCJ2IiwibmZ0SnVuayIsImZjIiwic3RyIiwiciIsIkJ1ZmZlciIsInVyaSIsImlkIiwib2siLCJyaXNrQmxvY2siLCJ2YWxXZWkiLCJpc0ZyZWUiLCJSIiwibmoiLCJyZXZNYXgiLCJkYXlCbmIiLCJ0b0ZpeGVkIiwiZnJlZVBlckRheSIsImtlZXBCbmIiLCJnIiwidmFsdWUiLCJncCIsImZlZSIsImdhc01heFBhaWQiLCJnYXNNYXgiLCJzZXJpYWxEZXYiLCJzaXplIiwiaXNSZXBlYXREZXYiLCJibGFja2xpc3QiLCJ3aHkiLCJhdCIsInJlcGVhdERldk9rIiwiUCIsIm1pbmUiLCJvdGhlcnMiLCJ0ayIsInEiLCJwciIsInJzIl0sInNvdXJjZXMiOlsicHJvamVjdC1yaXNrLm1qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBNb2R1bGU6IHByb2plY3Qtcmlzay4gQ29uc3RydWN0aW9uIGlzIGluZXJ0OyBJL08gaXMgaW52b2tlZCBleHBsaWNpdGx5LlxuaW1wb3J0IHsgZmVlRGF5IH0gZnJvbSAnLi4vLi4vcmVjZWlwdC1mZWVzLm1qcyc7XG5pbXBvcnQgeyBtaW50Umlza0RlY2lzaW9uIH0gZnJvbSAnLi4vLi4vbWludC1yaXNrLXBvbGljeS5tanMnO1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVByb2plY3RSaXNrKGRlcGVuZGVuY2llcykge1xuICBjb25zdCB7IENPTkZJRywgRkFDVE9SWSwgRkxBUF9CQU4sIEZMQVBfQkxPQ0ssIFBBSUQsIFJJU0ssIFMsIFVTRFQsIFdBTExFVFMsIFdCTkIsIGJpZywgY2FsbCwgY29kZU9mLCBmdWxsQ29kZSwgbG9nLCBycGMsIHRnLCB0b2tTdHIsIHRzLCB3LCB3YSB9ID0gZGVwZW5kZW5jaWVzO1xuICBhc3luYyBmdW5jdGlvbiByaXNrTm90ZShjKSB7IC8qIOaWsOWKn+iDve+8mueci+WQiOe0hOacieaykuacieOAjOWinueZvO+8j+aaq+WBnO+8j+m7keWQjeWWru+8j+aUueeoheOAjemAmemhnumWi+eZvOiAheasiumZkO+8jOWPquaPkOmGkuS4jeaTiyAqL1xuICAgIHRyeSB7IGNvbnN0IGNvZGUgPSAoYXdhaXQgcnBjKCdldGhfZ2V0Q29kZScsIFtjLCAnbGF0ZXN0J10pKSB8fCAnJzsgaWYgKGNvZGUubGVuZ3RoIDwgMTApIHJldHVybiAnJztcbiAgICAgIGNvbnN0IGhhcyA9IChzZWxzKSA9PiBzZWxzLnNvbWUoKHgpID0+IGNvZGUuaW5jbHVkZXMoJzYzJyArIHgpKTsgY29uc3QgZiA9IFtdO1xuICAgICAgaWYgKGhhcyhbJzQwYzEwZjE5J10pKSBmLnB1c2goJ+WPr+WinueZvCcpO1xuICAgICAgaWYgKGhhcyhbJzg0NTZjYjU5JywgJzAyMzI5YTI5J10pKSBmLnB1c2goJ+WPr+aaq+WBnOS6pOaYkycpO1xuICAgICAgaWYgKGhhcyhbJ2Y5ZjkyYmU0JywgJzQ0MzM3ZWExJywgJzBlY2I5M2MwJywgJzFhODk1MjY2J10pKSBmLnB1c2goJ+aciem7keWQjeWWricpO1xuICAgICAgaWYgKGhhcyhbJzhjMGI1ZTIyJywgJ2MwMjQ2NjY4JywgJzUzNDJhY2I0JywgJ2FhNGI2ZmNhJywgJzA2MWM4MmQwJ10pKSBmLnB1c2goJ+WPr+aUueeohS/pmZDpoY0nKTtcbiAgICAgIGlmICghZi5sZW5ndGgpIHJldHVybiAnJzsgY29uc3Qgb3cgPSBhd2FpdCBjYWxsKGMsICcweDhkYTVjYjViJyk7IGlmIChvdyAmJiBCaWdJbnQob3cuc2xpY2UoMCwgNjYpKSA9PT0gMG4pIHJldHVybiAnJztcbiAgICAgIHJldHVybiAnXFxu4pqg77iPIOWQiOe0hOasiumZkOaPkOmGku+8micgKyBmLmpvaW4oJ+OAgScpICsgJ++8iOmWi+eZvOiAhemChOaykuaUvuajhOasiumZkO+8iSc7XG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfSB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gaG9uZXlwb3RDaGVjayhXLCB0LCBzdCwgYmFsKSB7IC8qIOaWsOWKn+iDve+8mumWi+axoOaZguaooeaTrOOAjOaKiuW5o+i9iemAsuaxoOWtkOOAje+8iOizo+WHuuesrOS4gOatpe+8ie+8jOi9ieS4jemBjuWOu+W+iOWPr+iDveaYr+iylOiyhSAqL1xuICAgIGlmIChzdC5ocENoZWNrZWQgfHwgIXN0LnBhaXIgfHwgIS9eMHhbMC05YS1mXXs0MH0kLy50ZXN0KHN0LnBhaXIpIHx8ICEoYmFsID4gMG4pKSByZXR1cm47IHN0LmhwQ2hlY2tlZCA9IDE7XG4gICAgdHJ5IHsgYXdhaXQgcnBjKCdldGhfY2FsbCcsIFt7IGZyb206IFcuYWRkciwgdG86IHQuYWRkciwgZGF0YTogJzB4YTkwNTljYmInICsgd2Eoc3QucGFpcikgKyB3KGJhbCAvIDEwMG4gfHwgMW4pIH0sICdsYXRlc3QnXSk7IH1cbiAgICBjYXRjaCAoZSkgeyBhd2FpdCB0Zyhg4pqg77iPIFske1cubmFtZX1dICR7dC5zeW19IOmWi+axoOS6hu+8jOS9huaooeaTrOizo+WHuuWkseaVl++8jOWPr+iDveaYr+iylOiyhe+8iOWPquiDveiyt+S4jeiDveizo++8ie+8jOiHquWLleizo+WHuuWPr+iDveacg+WkseaVl1xcbiR7dC5hZGRyfWApOyB9XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBsb2NrTm90ZShjLCB3QWRkcikgeyAvKiDosrfliLDnmoTluaPnj77lnKjog73kuI3og73ovYnvvJrmqKHmk6zovYkgMSDllq7kvY3liLDpu5HmtJ7lnLDlnYDvvIzooqvmk4vlsLHmj5DphpLvvIjlg48gYWlhZ2VudGJzYyDnmoTnmb3lkI3llq7pjpbvvInvvIjkvb/nlKjogIUgMTAvMzAgMjE6NDQg6KaB6KOc55qE5ryP5rSe77yJICovXG4gICAgY29uc3QgdG9rcyA9IFsuLi5uZXcgU2V0KFtjLCAuLi4oUy5keW4gfHwgW10pLmZpbHRlcigodCkgPT4gdC5vbmx5ID09PSB3QWRkcikuc2xpY2UoLTMpLm1hcCgodCkgPT4gdC5hZGRyKV0pXTtcbiAgICBmb3IgKGNvbnN0IHQgb2YgdG9rcykgeyBjb25zdCBkUiA9IGF3YWl0IGNhbGwodCwgJzB4MzEzY2U1NjcnKTsgaWYgKCEoZFIgJiYgZFIubGVuZ3RoID49IDY2KSkgY29udGludWU7IC8qIE5GVCDmspLmnInlsI/mlbjkvY3mlbjvvIzkuI3og73nlKjovYnku6PluaPnmoTmlrnlvI/muKzvvIjku6XliY0gTkZUIOacg+iqpOWgsei9ieS4jeWHuuWOu++8iSAqLyBjb25zdCBiID0gYmlnKGF3YWl0IGNhbGwodCwgJzB4NzBhMDgyMzEnICsgd2Eod0FkZHIpKSk7IGlmICghKGIgPiAwbikpIGNvbnRpbnVlO1xuICAgICAgdHJ5IHsgYXdhaXQgcnBjKCdldGhfY2FsbCcsIFt7IGZyb206IHdBZGRyLCB0bzogdCwgZGF0YTogJzB4YTkwNTljYmInICsgd2EoJzB4MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwZGVhZCcpICsgdygxbikgfSwgJ2xhdGVzdCddKTsgcmV0dXJuICcnOyB9XG4gICAgICBjYXRjaCAoZSkgeyByZXR1cm4gYFxcbuKaoO+4jyDpgJnlgIvluaPnj77lnKjovYnkuI3lh7rljrvvvIgke1N0cmluZyhlLm1lc3NhZ2UpLnNsaWNlKDAsIDQwKX3vvInvvJrlj6/og73opoHnrYnplovnmbzogIXplovmlL7kuqTmmJPvvIzkuZ/lj6/og73mmK/ospTosoVgOyB9IH1cbiAgICByZXR1cm4gJyc7XG4gIH1cblxuICBmdW5jdGlvbiBmbGFwR3VhcmQodG8sIGRhdGEsIHNpbSkge1xuICAgIGlmICghRkxBUF9CQU4pIHJldHVybiAnJztcbiAgICBpZiAoRkxBUF9CTE9DSy5oYXMoU3RyaW5nKHRvKS50b0xvd2VyQ2FzZSgpKSkgcmV0dXJuICfnpoHmraLot58gRmxhcCDlkIjntITkupLli5UnO1xuICAgIGNvbnN0IGQgPSBTdHJpbmcoZGF0YSB8fCAnJykudG9Mb3dlckNhc2UoKTsgaWYgKC9eMHgoMDk1ZWE3YjN8Mzk1MDkzNTEpLy50ZXN0KGQpICYmIEZMQVBfQkxPQ0suaGFzKCcweCcgKyBkLnNsaWNlKDM0LCA3NCkpKSByZXR1cm4gJ+emgeatouaOiOasiue1piBGbGFwJztcbiAgICBpZiAoKHNpbT8uYWxsb3dhbmNlQ2hhbmdlcyB8fCBbXSkuc29tZSgoYSkgPT4gRkxBUF9CTE9DSy5oYXMoU3RyaW5nKGEuc3BlbmRlcikudG9Mb3dlckNhc2UoKSkpKSByZXR1cm4gJ+acg+aOiOasiue1piBGbGFw77yM56aB5q2iJztcbiAgICByZXR1cm4gJyc7XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBlbmZvcmNlTWludFJpc2socHJvamVjdCwga25vd25Db2RlID0gbnVsbCkge1xuICAgIHByb2plY3QgPSBTdHJpbmcocHJvamVjdCkudG9Mb3dlckNhc2UoKTtcbiAgICBpZiAoIS9eMHhbMC05YS1mXXs0MH0kLy50ZXN0KHByb2plY3QpKSB0aHJvdyBuZXcgRXJyb3IoJ+eEoeazleaguOWvpumgheebruWQiOe0hCcpO1xuICAgIGNvbnN0IGRldmVsb3BlciA9IFN0cmluZyhTLmRlcEZyb20/Lltwcm9qZWN0XSB8fCAnJykudG9Mb3dlckNhc2UoKTtcbiAgICBjb25zdCBwb3NzaWJsZURldmVsb3BlcnMgPSBbZGV2ZWxvcGVyLCBTdHJpbmcoUy5kZXBsb3llcj8uW3Byb2plY3RdIHx8ICcnKS50b0xvd2VyQ2FzZSgpXS5maWx0ZXIoQm9vbGVhbik7XG4gICAgY29uc3QgYmxhY2sgPSBPYmplY3Qua2V5cyhTLmJsYWNrIHx8IHt9KS5zb21lKChhZGRyZXNzKSA9PiBwb3NzaWJsZURldmVsb3BlcnMuaW5jbHVkZXMoYWRkcmVzcy50b0xvd2VyQ2FzZSgpKSk7XG4gICAgbGV0IGNvZGUgPSBrbm93bkNvZGU7XG4gICAgaWYgKCFjb2RlKSBjb2RlID0gYXdhaXQgZnVsbENvZGUocHJvamVjdCwgYXdhaXQgY29kZU9mKHByb2plY3QpKS5jYXRjaCgoKSA9PiAnJyk7XG4gICAgY29uc3QgcmVhc29uID0gbWludFJpc2tEZWNpc2lvbih7IGRldmVsb3BlciwgY29kZSwgYmxhY2tsaXN0ZWQ6IGJsYWNrLFxuICAgICAgc2VyaWFsOiBCb29sZWFuKGNvZGUgJiYgaXNTZXJpYWwoY29kZSkpLFxuICAgICAgLy8gVGhlIHNjYW5uZXIgZG9lcyBub3QgcHJvdmUgdW5pbnRlcnJ1cHRlZCAyNGggY292ZXJhZ2U7IG5vIGluZGVwZW5kZW50LFxuICAgICAgLy8gdmVyaWZpZWQgZGV2ZWxvcGVyIHJ1Zy1oaXN0b3J5IHNvdXJjZSBpcyB3aXJlZCBpbi4gTmV2ZXIgaW5mZXIgY2xlYXJhbmNlLlxuICAgICAgZGVwbG95bWVudENvdmVyYWdlQ29tcGxldGU6IGZhbHNlLCBydWdIaXN0b3J5VmVyaWZpZWQ6IGZhbHNlIH0pO1xuICAgIGlmIChyZWFzb24pIHRocm93IG5ldyBFcnJvcign6aKo5o6n5pSU5oiq77yaJyArIHJlYXNvbik7XG4gIH1cblxuICBmdW5jdGlvbiBjb2RlUHJpbnQoY29kZSkgeyBjb25zdCBjID0gKGNvZGUgfHwgJycpLnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvMHgvLCAnJyk7IHJldHVybiBjLmxlbmd0aCArICc6JyArIGMuc2xpY2UoMCwgMTIwKSArIGMuc2xpY2UoLTEyMCk7IH1cblxuICBmdW5jdGlvbiBub3RlRGVwbG95KGNvZGUpIHsgY29uc3QgZnAgPSBjb2RlUHJpbnQoY29kZSk7IFMuZnBzID0gUy5mcHMgfHwge307IGNvbnN0IG5vdyA9IERhdGUubm93KCk7IGNvbnN0IGFyciA9IChTLmZwc1tmcF0gfHwgW10pLmZpbHRlcigodCkgPT4gbm93IC0gdCA8IDg2NDAwZTMpOyBhcnIucHVzaChub3cpOyBTLmZwc1tmcF0gPSBhcnIuc2xpY2UoLTIwKTsgaWYgKE9iamVjdC5rZXlzKFMuZnBzKS5sZW5ndGggPiAzMDAwKSBTLmZwcyA9IHt9OyByZXR1cm4gYXJyLmxlbmd0aDsgfVxuXG4gIGZ1bmN0aW9uIGlzU2VyaWFsKGNvZGUpIHsgY29uc3QgYXJyID0gKFMuZnBzIHx8IHt9KVtjb2RlUHJpbnQoY29kZSldIHx8IFtdOyByZXR1cm4gYXJyLmZpbHRlcigodCkgPT4gRGF0ZS5ub3coKSAtIHQgPCA4NjQwMGUzKS5sZW5ndGggPj0gMzsgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIGRlcGxveWVyT2YoYykge1xuICAgIFMuZGVwbG95ZXIgPSBTLmRlcGxveWVyIHx8IHt9OyBpZiAoUy5kZXBsb3llcltjXSkgcmV0dXJuIFMuZGVwbG95ZXJbY107XG4gICAgY29uc3Qgb3cgPSBhd2FpdCBjYWxsKGMsICcweDhkYTVjYjViJyk7IGlmIChvdyAmJiBvdy5sZW5ndGggPj0gNjYgJiYgQmlnSW50KG93LnNsaWNlKDAsIDY2KSkgPiAwbikgcmV0dXJuIChTLmRlcGxveWVyW2NdID0gJzB4JyArIG93LnNsaWNlKDI2LCA2NikpO1xuICAgIHJldHVybiAnJztcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIGZyZXNoV2FsbGV0KGEpIHsgLy8g6YOo572y6ICF5piv5LiN5piv5aSn57SEIDgg5bCP5pmC5YWn5omN6ZaL5aeL55So55qE5paw6Yyi5YyF77yI5p+l5LiN5Yiw5bCx55W25LiN5piv77yJXG4gICAgdHJ5IHsgY29uc3QgaGVhZCA9IHBhcnNlSW50KGF3YWl0IHJwYygnZXRoX2Jsb2NrTnVtYmVyJywgW10pLCAxNik7IGNvbnN0IG9sZCA9IGF3YWl0IHJwYygnZXRoX2dldFRyYW5zYWN0aW9uQ291bnQnLCBbYSwgJzB4JyArIChoZWFkIC0gNjAwMDApLnRvU3RyaW5nKDE2KV0pOyBjb25zdCBub3cgPSBhd2FpdCBycGMoJ2V0aF9nZXRUcmFuc2FjdGlvbkNvdW50JywgW2EsICdsYXRlc3QnXSk7IHJldHVybiBwYXJzZUludChvbGQsIDE2KSA9PT0gMCAmJiBwYXJzZUludChub3csIDE2KSA8IDUwOyB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XG4gIH1cblxuICBmdW5jdGlvbiBub3RlRGV2KGRlcCwgYykgeyBpZiAoIWRlcCkgcmV0dXJuOyBTLmRldnMgPSBTLmRldnMgfHwge307IGNvbnN0IG5vdyA9IERhdGUubm93KCk7IGNvbnN0IGFyciA9IChTLmRldnNbZGVwXSB8fCBbXSkuZmlsdGVyKCh4KSA9PiBub3cgLSB4LnQgPCA4NjQwMGUzICYmIHguYyAhPT0gYyk7IGFyci5wdXNoKHsgdDogbm93LCBjIH0pOyBTLmRldnNbZGVwXSA9IGFyci5zbGljZSgtMzApOyBpZiAoT2JqZWN0LmtleXMoUy5kZXZzKS5sZW5ndGggPiA1MDAwKSBTLmRldnMgPSB7fTtcbiAgICAoYXN5bmMgKCkgPT4geyBsZXQgbiA9IHRva1N0cihhd2FpdCBjYWxsKGMsICcweDk1ZDg5YjQxJykpIHx8IHRva1N0cihhd2FpdCBjYWxsKGMsICcweDA2ZmRkZTAzJykpOyBpZiAoIW4pIHsgY29uc3QgdHIgPSBhd2FpdCBjYWxsKGMsICcweGZjMGM1NDZhJyk7IGlmICh0ciAmJiB0ci5sZW5ndGggPj0gNjYgJiYgQmlnSW50KHRyLnNsaWNlKDAsIDY2KSkgPiAwbikgbiA9IHRva1N0cihhd2FpdCBjYWxsKCcweCcgKyB0ci5zbGljZSgyNiwgNjYpLCAnMHg5NWQ4OWI0MScpKTsgfSBjb25zdCBlID0gKFMuZGV2c1tkZXBdIHx8IFtdKS5maW5kKCh4KSA9PiB4LmMgPT09IGMpOyBpZiAoZSAmJiBuKSBlLm4gPSBuOyB9KSgpLmNhdGNoKCgpID0+IHt9KTsgfVxuXG4gIGNvbnN0IGRldktleSA9ICh4KSA9PiBTdHJpbmcoeC5uIHx8IFMucGFpZD8uW3guY10/Lm5hbWUgfHwgeC5jKS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1xccypcXCguKj9cXClcXHMqL2csICcnKS5yZXBsYWNlKC9eXFwkLywgJycpLnRyaW0oKTtcblxuICBjb25zdCBERVZfTUFYID0gMTA7XG5cbiAgZnVuY3Rpb24gcmlza0RheSgpIHtcbiAgICBjb25zdCBkID0gZmVlRGF5KERhdGUubm93KCksIENPTkZJRy50aW1lWm9uZSB8fCAnQXNpYS9TaGFuZ2hhaScpO1xuICAgIGlmICghUy5yaXNrIHx8IFMucmlzay5kICE9PSBkKSBTLnJpc2sgPSB7IGQsIHNwZW5kOiB7fSwgZnJlZToge30sIHdhcm5lZDoge30sIHJldjoge30gfTtcbiAgICBjb25zdCBkYXkgPSBTLmZlZURheXM/LltkXSB8fCB7fTtcbiAgICBTLnJpc2suc3BlbmQgPSB7fTsgUy5yaXNrLmZyZWUgPSB7fTsgUy5yaXNrLnJldiA9IHt9O1xuICAgIGZvciAoY29uc3QgVyBvZiBXQUxMRVRTKSB7XG4gICAgICBjb25zdCBmZWVzID0gZGF5W1cuYWRkcl07IGlmICghZmVlcykgY29udGludWU7XG4gICAgICBTLnJpc2suc3BlbmRbVy5uYW1lXSA9IE51bWJlcihCaWdJbnQoZmVlcy5nYXNXZWkpKSAvIDFlMTg7XG4gICAgICBTLnJpc2suZnJlZVtXLm5hbWVdID0gZmVlcy5mcmVlUHJvamVjdHM7XG4gICAgICBmb3IgKGNvbnN0IFtwcm9qZWN0LCBjb3VudF0gb2YgT2JqZWN0LmVudHJpZXMoZmVlcy5mYWlsZWRQcm9qZWN0cykpIFMucmlzay5yZXZbcHJvamVjdF0gPSAoUy5yaXNrLnJldltwcm9qZWN0XSB8fCAwKSArIGNvdW50O1xuICAgIH1cbiAgICByZXR1cm4gUy5yaXNrO1xuICB9XG5cbiAgY29uc3QgVVBHX1NMT1RTID0gWycweDM2MDg5NGExM2JhMWEzMjEwNjY3YzgyODQ5MmRiOThkY2EzZTIwNzZjYzM3MzVhOGNlMDNiNmQ0ZDZiNmJiYycsICcweGEzZjBhZDc0ZTU0MjNhZWJmZDgwZDNlZjQzNDY1NzgzMzVhOWE3MmFlYWVlNTlmZjZjYjM1ODJiMzUxMzNkNTAnLCAnMHg3MDUwYzllMGY0Y2E3NjljNjliZDNhOGVmNzQwYmMzNzkzNGY4ZTJjMDM2YTVhNzIzZmQ4ZWUwNDhlZDNmOGMzJ107XG5cbiAgYXN5bmMgZnVuY3Rpb24gdXBncmFkZWFibGUoYykgeyAvKiDlj6/ljYfntJrku6PnkIblkIjntITvvJrpoIXnm67mlrnkuovlvozog73miornqIvlvI/vvIjljIXmi6zkv53mnKzmqZ/liLbvvInmlbTlgIvmj5vmjokgKi8gUy51cGcgPSBTLnVwZyB8fCB7fTsgaWYgKFMudXBnW2NdICE9IG51bGwpIHJldHVybiAhIVMudXBnW2NdOyBsZXQgdSA9IDA7IGZvciAoY29uc3Qgc2wgb2YgVVBHX1NMT1RTKSB7IGNvbnN0IHYgPSBhd2FpdCBycGMoJ2V0aF9nZXRTdG9yYWdlQXQnLCBbYywgc2wsICdsYXRlc3QnXSkuY2F0Y2goKCkgPT4gbnVsbCk7IGlmICh2ICYmIC9bMS05YS1mXS9pLnRlc3Qodi5zbGljZSgyKSkpIHsgdSA9IDE7IGJyZWFrOyB9IH0gUy51cGdbY10gPSB1OyByZXR1cm4gISF1OyB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gbmZ0SnVuayhjKSB7IC8qIOS9v+eUqOiAhSAxMS8xIDE1OjAz77yaTkZUIOeahOWclueJh+mAo+e1kOaYr+WBh+eahOaIluepuueahO+8iOWDjyBpcGZzOi8vc25pcGVyLXRlc3QtbmZ0LzHvvInlsLHkuI3miZPigJTigJTmibnph4/mjo/miYvnuozosrvnmoTlnoPlnL7poIXnm67pgKPlnJbpg73mspLlgZogKi9cbiAgICBTLm5mdEp1bmsgPSBTLm5mdEp1bmsgfHwge307IGlmIChTLm5mdEp1bmtbY10gIT0gbnVsbCkgcmV0dXJuIFMubmZ0SnVua1tjXTtcbiAgICBjb25zdCBjb2RlID0gKChhd2FpdCBycGMoJ2V0aF9nZXRDb2RlJywgW2MsICdsYXRlc3QnXSkuY2F0Y2goKCkgPT4gJycpKSB8fCAnJykudG9Mb3dlckNhc2UoKTsgbGV0IGZjID0gY29kZTsgdHJ5IHsgZmMgPSBhd2FpdCBmdWxsQ29kZShjLCBjb2RlKTsgfSBjYXRjaCB7fVxuICAgIGlmICghZmMuaW5jbHVkZXMoJ2M4N2I1NmRkJykpIHJldHVybiAoUy5uZnRKdW5rW2NdID0gJycpOyAvKiDkuI3mmK8gTkZU77yI5rKS5pyJIHRva2VuVVJJ77yJICovXG4gICAgY29uc3Qgc3RyID0gKHIpID0+IHsgdHJ5IHsgY29uc3QgYiA9IEJ1ZmZlci5mcm9tKHIuc2xpY2UoMiksICdoZXgnKTsgY29uc3QgbiA9IE51bWJlcihCaWdJbnQoJzB4JyArIGIuc2xpY2UoMzIsIDY0KS50b1N0cmluZygnaGV4JykpKTsgcmV0dXJuIGIuc2xpY2UoNjQsIDY0ICsgbikudG9TdHJpbmcoJ3V0ZjgnKS50cmltKCk7IH0gY2F0Y2ggeyByZXR1cm4gJyc7IH0gfTtcbiAgICBsZXQgdXJpID0gbnVsbDsgZm9yIChjb25zdCBpZCBvZiBbMW4sIDBuXSkgeyBjb25zdCByID0gYXdhaXQgY2FsbChjLCAnMHhjODdiNTZkZCcgKyB3KGlkKSk7IGlmIChyICYmIHIubGVuZ3RoID4gMTMwKSB7IHVyaSA9IHN0cihyKTsgYnJlYWs7IH0gaWYgKHIpIHVyaSA9IHVyaSA/PyAnJzsgfVxuICAgIGlmICh1cmkgPT0gbnVsbCkgcmV0dXJuICcnOyAvKiDoroDkuI3liLDvvIjlj6/og73pgoTmspLpkYTlh7rku7vkvZXkuIDlgIvvvInvvIzlhYjkuI3liKTmlrcgKi9cbiAgICBjb25zdCBvayA9IC9eZGF0YTovaS50ZXN0KHVyaSkgfHwgL15odHRwcz86XFwvXFwvW2EtejAtOS1dKyhcXC5bYS16MC05LV0rKStcXC8vaS50ZXN0KHVyaSkgfHwgL15hcjpcXC9cXC9bQS1aYS16MC05Xy1dezMwLH0vLnRlc3QodXJpKSB8fCAvXmlwZnM6XFwvXFwvKGlwZnNcXC8pPyhRbVsxLTlBLUhKLU5QLVphLWttLXpdezQ0fXxiW2EtejItN117NTAsfSkvLnRlc3QodXJpKTtcbiAgICByZXR1cm4gKFMubmZ0SnVua1tjXSA9IG9rID8gJycgOiBgTkZUIOWclueJh+mAo+e1kOaYryR7dXJpID8gJ+WBh+eahO+8iCcgKyB1cmkuc2xpY2UoMCwgNDApICsgJ++8iScgOiAn56m655qEJ31gKTtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIHJpc2tCbG9jayhXLCBjLCB2YWxXZWksIGRhdGEsIGlzRnJlZSwgcGFpZCA9IGZhbHNlKSB7IC8qIOWbnuWCs+S4jeaJk+eahOWOn+WboO+8m+epuuWtl+S4su+8neWPr+S7peaJkyAqL1xuICAgIGNvbnN0IFIgPSByaXNrRGF5KCk7XG4gICAgeyBjb25zdCBuaiA9IGF3YWl0IG5mdEp1bmsoYykuY2F0Y2goKCkgPT4gJycpOyBpZiAobmopIHJldHVybiBuaiArICfvvIznlpHkvLzlnoPlnL7poIXnm64nOyB9XG4gICAgaWYgKChSLnJldltjXSB8fCAwKSA+PSBSSVNLLnJldk1heCkgcmV0dXJuIGDpgJnlgIvlkIjntITkuIrpj4jlpLHmlZcgJHtSLnJldltjXX0g5qyh77yM5LiN5YaN6Kmm77yI6YG/5YWN5LiA55u054eSIGdhc++8iWA7XG4gICAgaWYgKCFwYWlkICYmIChSLnNwZW5kW1cubmFtZV0gfHwgMCkgPj0gUklTSy5kYXlCbmIpIHsgaWYgKCFSLndhcm5lZFtXLm5hbWVdKSB7IFIud2FybmVkW1cubmFtZV0gPSAxOyB0Zyhg4pqg77iPIFske1cubmFtZX1dIOS7iuWkqeaJi+e6jOiyu++8i2dhcyDlt7LoirEgJHsoUi5zcGVuZFtXLm5hbWVdKS50b0ZpeGVkKDQpfSBCTkLvvIzpgZTliLDmr4/ml6XkuIrpmZAgJHtSSVNLLmRheUJuYn0gQk5C77yM5LuK5aSp5YGc5q2i6Ieq5YuV5omT77yI6LOj5Ye65LiN5Y+X5b2x6Z+/77yJYCkuY2F0Y2goKCkgPT4ge30pOyB9IHJldHVybiBg5LuK5aSp5omL57qM6LK777yLZ2FzIOW3sumBlCAke1JJU0suZGF5Qm5ifSBCTkIg5LiK6ZmQYDsgfVxuICAgIGlmIChpc0ZyZWUgJiYgIShSLmZyZWVbVy5uYW1lXSB8fCBbXSkuaW5jbHVkZXMoYykgJiYgKFIuZnJlZVtXLm5hbWVdIHx8IFtdKS5sZW5ndGggPj0gUklTSy5mcmVlUGVyRGF5KSByZXR1cm4gYOS7iuWkqeW3suiHquWLleaJkyAke1JJU0suZnJlZVBlckRheX0g5YCL5YWN6LK76aCF55uu77yM6YGU5Yiw5LiK6ZmQYDtcbiAgICBjb25zdCBiYWwgPSBOdW1iZXIoQmlnSW50KChhd2FpdCBycGMoJ2V0aF9nZXRCYWxhbmNlJywgW1cuYWRkciwgJ2xhdGVzdCddKS5jYXRjaCgoKSA9PiAnMHgwJykpIHx8ICcweDAnKSkgLyAxZTE4O1xuICAgIGlmIChiYWwgLSBOdW1iZXIodmFsV2VpKSAvIDFlMTggPCBQQUlELmtlZXBCbmIpIHJldHVybiBgQk5CIOS9juaWvOS/neeVmemhjSAke1BBSUQua2VlcEJuYn3vvIzlj6rnlZnntabos6Plh7rnlKhgO1xuICAgIGlmIChkYXRhICE9PSAnMHgnKSB7XG4gICAgICB0cnkgeyBjb25zdCBnID0gYXdhaXQgcnBjKCdldGhfZXN0aW1hdGVHYXMnLCBbeyBmcm9tOiBXLmFkZHIsIHRvOiBjLCBkYXRhLCB2YWx1ZTogJzB4JyArIEJpZ0ludCh2YWxXZWkpLnRvU3RyaW5nKDE2KSB9XSk7IGNvbnN0IGdwID0gYXdhaXQgcnBjKCdldGhfZ2FzUHJpY2UnLCBbXSk7IGNvbnN0IGZlZSA9IChOdW1iZXIoQmlnSW50KGcpKSAqIE51bWJlcihCaWdJbnQoZ3ApKSkgLyAxZTE4OyBpZiAoZmVlID4gKHBhaWQgPyBSSVNLLmdhc01heFBhaWQgOiBSSVNLLmdhc01heCkpIHJldHVybiBg6aCQ5LywIGdhcyAke2ZlZS50b0ZpeGVkKDUpfSBCTkIg5aSq6auYYDsgfVxuICAgICAgY2F0Y2ggeyByZXR1cm4gJ+eEoeazleS8sOeulyBnYXPvvIzmmqvlgZzkuqTmmJMnOyB9XG4gICAgfVxuICAgIHJldHVybiAnJztcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIHNlcmlhbERldihjKSB7IGNvbnN0IGRlcCA9IChTLmRlcEZyb20gfHwge30pW2NdOyBpZiAoIWRlcCkgcmV0dXJuICcnOyAvKiDlj6rnlKjjgIzlr6bpmpvpgIHlh7rpg6jnvbLkuqTmmJPnmoTpjKLljIXjgI3liKTmlrfvvIzkuI3nlKggb3duZXIoKe+8iOeZvOWwhOWPsOeahOmgheebriBvd25lciDluLjmmK/lkIzkuIDlgIvlubPlj7DvvIzmnIPoqqTmrrrvvIkgKi8gY29uc3QgbiA9IG5ldyBTZXQoKChTLmRldnMgfHwge30pW2RlcF0gfHwgW10pLmZpbHRlcigoeCkgPT4gRGF0ZS5ub3coKSAtIHgudCA8IDg2NDAwZTMpLm1hcCgoeCkgPT4geC5jKSkuc2l6ZTsgcmV0dXJuIG4gPj0gREVWX01BWCA/IGDlkIzkuIDlgIvpg6jnvbLogIUgJHtkZXAuc2xpY2UoMCwgMTApfeKApiAyNCDlsI/mmYLlhafpg6jnvbLkuoYgJHtufSDlgIvpoIXnm65gIDogJyc7IH1cblxuICBmdW5jdGlvbiBpc1JlcGVhdERldihkZXApIHsgcmV0dXJuICEhZGVwICYmIG5ldyBTZXQoKChTLmRldnMgfHwge30pW2RlcF0gfHwgW10pLmZpbHRlcigoeCkgPT4gRGF0ZS5ub3coKSAtIHgudCA8IDg2NDAwZTMpLm1hcChkZXZLZXkpKS5zaXplID49IDM7IH1cblxuICBmdW5jdGlvbiBibGFja2xpc3QoZGVwLCB3aHkpIHsgaWYgKCFkZXApIHJldHVybjsgUy5ibGFjayA9IFMuYmxhY2sgfHwge307IGlmICghUy5ibGFja1tkZXBdKSB7IFMuYmxhY2tbZGVwXSA9IHsgYXQ6IHRzKCksIHdoeSB9OyBsb2coYOm7keWQjeWWru+8miR7ZGVwfe+8iCR7d2h5fe+8iWApOyB9IH1cblxuICBhc3luYyBmdW5jdGlvbiByZXBlYXREZXZPayhkZXAsIGMsIFApIHtcbiAgICBjb25zdCBtaW5lID0gZGV2S2V5KHsgYywgbjogUC5uYW1lIH0pO1xuICAgIGNvbnN0IG90aGVycyA9ICgoUy5kZXZzIHx8IHt9KVtkZXBdIHx8IFtdKS5maWx0ZXIoKHgpID0+IHguYyAhPT0gYyk7XG4gICAgaWYgKG90aGVycy5zb21lKCh4KSA9PiBkZXZLZXkoeCkgPT09IG1pbmUpKSByZXR1cm4gJ+WQjOWQjemHjeaWsOmDqOe9sic7XG4gICAgZm9yIChjb25zdCB4IG9mIG90aGVycykgeyAvLyDku5bkuYvliY3nmoTpoIXnm67mnInmspLmnInmraPluLjplovnm6TvvIjmsaDlrZDpgoTmnInpjKLjgIHmspLooqvmir3otbDvvIlcbiAgICAgIGxldCB0ayA9IHguYzsgY29uc3QgdHIgPSBhd2FpdCBjYWxsKHguYywgJzB4ZmMwYzU0NmEnKTsgaWYgKHRyICYmIHRyLmxlbmd0aCA+PSA2NiAmJiBCaWdJbnQodHIuc2xpY2UoMCwgNjYpKSA+IDBuKSB0ayA9ICcweCcgKyB0ci5zbGljZSgyNiwgNjYpO1xuICAgICAgZm9yIChjb25zdCBxIG9mIFtXQk5CLCBVU0RUXSkgeyBjb25zdCBwciA9IGF3YWl0IGNhbGwoRkFDVE9SWSwgJzB4ZTZhNDM5MDUnICsgd2EodGspICsgd2EocSkpOyBpZiAoIXByIHx8ICEoQmlnSW50KHByKSA+IDBuKSkgY29udGludWU7IGNvbnN0IHJzID0gYXdhaXQgY2FsbCgnMHgnICsgcHIuc2xpY2UoMjYpLCAnMHgwOTAyZjFhYycpOyBpZiAocnMgJiYgQmlnSW50KCcweCcgKyBycy5zbGljZSgyLCA2NikpID4gMG4gJiYgQmlnSW50KCcweCcgKyBycy5zbGljZSg2NiwgMTMwKSkgPiAwbikgcmV0dXJuICfkuYvliY3mnInpoIXnm67mraPluLjplovnm6QnOyB9XG4gICAgfVxuICAgIHJldHVybiAnJztcbiAgfVxuICByZXR1cm4ge1xuICAgIGdldCBmbGFwR3VhcmQoKSB7IHJldHVybiBmbGFwR3VhcmQ7IH0sXG4gICAgZ2V0IHJpc2tOb3RlKCkgeyByZXR1cm4gcmlza05vdGU7IH0sXG4gICAgZ2V0IGhvbmV5cG90Q2hlY2soKSB7IHJldHVybiBob25leXBvdENoZWNrOyB9LFxuICAgIGdldCBsb2NrTm90ZSgpIHsgcmV0dXJuIGxvY2tOb3RlOyB9LFxuICAgIGdldCBlbmZvcmNlTWludFJpc2soKSB7IHJldHVybiBlbmZvcmNlTWludFJpc2s7IH0sXG4gICAgZ2V0IG5vdGVEZXBsb3koKSB7IHJldHVybiBub3RlRGVwbG95OyB9LFxuICAgIGdldCBpc1NlcmlhbCgpIHsgcmV0dXJuIGlzU2VyaWFsOyB9LFxuICAgIGdldCBkZXBsb3llck9mKCkgeyByZXR1cm4gZGVwbG95ZXJPZjsgfSxcbiAgICBnZXQgZnJlc2hXYWxsZXQoKSB7IHJldHVybiBmcmVzaFdhbGxldDsgfSxcbiAgICBnZXQgbm90ZURldigpIHsgcmV0dXJuIG5vdGVEZXY7IH0sXG4gICAgZ2V0IHVwZ3JhZGVhYmxlKCkgeyByZXR1cm4gdXBncmFkZWFibGU7IH0sXG4gICAgZ2V0IHJpc2tCbG9jaygpIHsgcmV0dXJuIHJpc2tCbG9jazsgfSxcbiAgICBnZXQgc2VyaWFsRGV2KCkgeyByZXR1cm4gc2VyaWFsRGV2OyB9LFxuICAgIGdldCBpc1JlcGVhdERldigpIHsgcmV0dXJuIGlzUmVwZWF0RGV2OyB9LFxuICAgIGdldCBibGFja2xpc3QoKSB7IHJldHVybiBibGFja2xpc3Q7IH0sXG4gICAgZ2V0IHJlcGVhdERldk9rKCkgeyByZXR1cm4gcmVwZWF0RGV2T2s7IH0sXG4gIH07XG59XG4iXSwibWFwcGluZ3MiOiJBQUFBO0FBQ0EsU0FBU0EsTUFBTSxRQUFRLHdCQUF3QjtBQUMvQyxTQUFTQyxnQkFBZ0IsUUFBUSw0QkFBNEI7QUFDN0QsT0FBTyxTQUFTQyxpQkFBaUJBLENBQUNDLFlBQVksRUFBRTtFQUM5QyxNQUFNO0lBQUVDLE1BQU07SUFBRUMsT0FBTztJQUFFQyxRQUFRO0lBQUVDLFVBQVU7SUFBRUMsSUFBSTtJQUFFQyxJQUFJO0lBQUVDLENBQUM7SUFBRUMsSUFBSTtJQUFFQyxPQUFPO0lBQUVDLElBQUk7SUFBRUMsR0FBRztJQUFFQyxJQUFJO0lBQUVDLE1BQU07SUFBRUMsUUFBUTtJQUFFQyxHQUFHO0lBQUVDLEdBQUc7SUFBRUMsRUFBRTtJQUFFQyxNQUFNO0lBQUVDLEVBQUU7SUFBRUMsQ0FBQztJQUFFQztFQUFHLENBQUMsR0FBR3JCLFlBQVk7RUFDaEssZUFBZXNCLFFBQVFBLENBQUNDLENBQUMsRUFBRTtJQUFFO0lBQzNCLElBQUk7TUFBRSxNQUFNQyxJQUFJLEdBQUcsQ0FBQyxNQUFNUixHQUFHLENB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QUUsWUFBWSxDQUFDO1FBQUUsSUFBSTJJLEVBQUUsSUFBSTVJLE1BQU0sQ0FBQyxJQUFJLEdBQUc0SSxFQUFFLENBQUMzSSxLQUFLLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLEdBQUcsRUFBRSxJQUFJRCxNQUFNLENBQUMsSUFBSSxHQUFHNEksRUFBRSxDQUFDM0ksS0FBSyxDQUFDLEVBQUUsRUFBRSxHQUFHLENBQUMsQ0FBQyxHQUFHLEVBQUUsRUFBRSxPQUFPLFdBQVc7TUFBRTtJQUNoVDtJQUNBLE9BQU8sRUFBRTtFQUNYO0VBQ0EsT0FBTztJQUNMLElBQUk2QixTQUFTQSxDQUFBLEVBQUc7TUFBRSxPQUFPQSxTQUFTO0lBQUUsQ0FBQztJQUNyQyxJQUFJMUMsUUFBUUEsQ0FBQSxFQUFHO01BQUUsT0FBT0EsUUFBUTtJQUFFLENBQUM7SUFDbkMsSUFBSWUsYUFBYUEsQ0FBQSxFQUFHO01BQUUsT0FBT0EsYUFBYTtJQUFFLENBQUM7SUFDN0MsSUFBSWUsUUFBUUEsQ0FBQSxFQUFHO01BQUUsT0FBT0EsUUFBUTtJQUFFLENBQUM7SUFDbkMsSUFBSW1CLGVBQWVBLENBQUEsRUFBRztNQUFFLE9BQU9BLGVBQWU7SUFBRSxDQUFDO0lBQ2pELElBQUlzQixVQUFVQSxDQUFBLEVBQUc7TUFBRSxPQUFPQSxVQUFVO0lBQUUsQ0FBQztJQUN2QyxJQUFJTCxRQUFRQSxDQUFBLEVBQUc7TUFBRSxPQUFPQSxRQUFRO0lBQUUsQ0FBQztJQUNuQyxJQUFJVyxVQUFVQSxDQUFBLEVBQUc7TUFBRSxPQUFPQSxVQUFVO0lBQUUsQ0FBQztJQUN2QyxJQUFJQyxXQUFXQSxDQUFBLEVBQUc7TUFBRSxPQUFPQSxXQUFXO0lBQUUsQ0FBQztJQUN6QyxJQUFJSyxPQUFPQSxDQUFBLEVBQUc7TUFBRSxPQUFPQSxPQUFPO0lBQUUsQ0FBQztJQUNqQyxJQUFJMkIsV0FBV0EsQ0FBQSxFQUFHO01BQUUsT0FBT0EsV0FBVztJQUFFLENBQUM7SUFDekMsSUFBSWEsU0FBU0EsQ0FBQSxFQUFHO01BQUUsT0FBT0EsU0FBUztJQUFFLENBQUM7SUFDckMsSUFBSWdCLFNBQVNBLENBQUEsRUFBRztNQUFFLE9BQU9BLFNBQVM7SUFBRSxDQUFDO0lBQ3JDLElBQUlFLFdBQVdBLENBQUEsRUFBRztNQUFFLE9BQU9BLFdBQVc7SUFBRSxDQUFDO0lBQ3pDLElBQUlDLFNBQVNBLENBQUEsRUFBRztNQUFFLE9BQU9BLFNBQVM7SUFBRSxDQUFDO0lBQ3JDLElBQUlHLFdBQVdBLENBQUEsRUFBRztNQUFFLE9BQU9BLFdBQVc7SUFBRTtFQUMxQyxDQUFDO0FBQ0giLCJpZ25vcmVMaXN0IjpbXX0=

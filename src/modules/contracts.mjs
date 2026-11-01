// Module: contracts. Construction is inert; I/O is invoked explicitly.

export function createContracts(dependencies) {
  const {
    REGISTRY,
    S,
    T_TRANSFER,
    USDT,
    WALLETS,
    WBNB,
    big,
    call,
    log,
    logsRpc,
    rpc,
    w,
    wa
  } = dependencies;
  const CANDS = [['mint()', '0x1249c58b'], ['freeMint()', '0x5b70ea9f'], ['claim()', '0x4e71d92d'], ['mint(1)', '0xa0712d68' + w(1)], ['publicMint()', '0x26092b83'], ['commitFreeMint()', '0x74d04cfc'], ['registerForRewards()', '0x9f92d0dd'], ['freeMint(1)', '0x7c928fe9' + w(1)], ['claim(1)', '0x379607f5' + w(1)], ['mintFree()', '0x8ab53447'], ['claimFree()', '0xf366afc9'], ['agentMint()', '0x1be3587a']];
  async function fullCode(c, code) {
    /* 審查修正（FAGENT 漏掉的原因）：代理合約一律追到背後的真正程式——EIP-1967、Beacon 槽位、程式裡寫死的 Beacon／實作地址、最小代理（EIP-1167） */
    code = String(code || '').toLowerCase();
    if (code.length < 4 || code.length >= 4000 || code.includes(REGISTRY)) return code;
    const add = async a => {
      const x = ((await rpc('eth_getCode', [a, 'latest']).catch(() => '')) || '').toLowerCase();
      code += x;
      return x;
    };
    try {
      const impl = await rpc('eth_getStorageAt', [c, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest']);
      if (impl && BigInt(impl) !== 0n) await add('0x' + impl.slice(-40));
    } catch {}
    try {
      const bc = await rpc('eth_getStorageAt', [c, '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50', 'latest']);
      if (bc && BigInt(bc) !== 0n) {
        const r = await call('0x' + bc.slice(-40), '0x5c60da1b');
        if (r && BigInt(r) !== 0n) await add('0x' + r.slice(-40));
      }
    } catch {}
    const emb0 = [];
    {
      const h = code.replace(/^0x/, '').slice(0, 1200);
      const m1167 = h.match(/^363d3d373d3d3d363d73([0-9a-f]{40})5af4/);
      if (m1167) emb0.push('0x' + m1167[1]);
      for (let i = 0; i + 42 <= h.length; i += 2) {
        const op = h.slice(i, i + 2);
        if (op === '73') {
          emb0.push('0x' + h.slice(i + 2, i + 42));
          i += 40;
        } else if (op === '7f') {
          const wv = h.slice(i + 2, i + 66);
          if (/^0{24}/.test(wv)) emb0.push('0x' + wv.slice(24));
          i += 64;
        } else {
          const n = parseInt(op, 16);
          if (n >= 0x60 && n <= 0x7f) i += (n - 0x5f) * 2;
        }
      }
    } /* 除錯 11/1：以前用字串比對會從錯的位置切（最小代理 363d3d37… 裡的「37 3d」被當成 73），抓不到 bibiai 的實作合約 → 誤判沒有退款機制；改成照位元組逐一解析 */
    const emb = [...new Set(emb0)].filter(a => !/^0x0{40}$/.test(a) && a.length === 42).slice(0, 3);
    for (const a of emb) {
      if (code.includes(REGISTRY)) break;
      const r = await call(a, '0x5c60da1b');
      if (r && r.length >= 66 && BigInt(r.slice(0, 66)) !== 0n) await add('0x' + r.slice(-40));else await add(a);
    }
    return code;
  }
  const NEAR_FREE = [0n, 10n ** 14n, 22n * 10n ** 13n, 3n * 10n ** 14n, 5n * 10n ** 14n, 10n ** 15n];
  async function findFree(from, c, code) {
    for (const [n, d] of CANDS) {
      if (n.includes('@') && !n.endsWith('@' + c.slice(2, 10))) continue;
      if (n.includes('#') && !n.includes('#' + (WALLETS.find(x => x.addr === from)?.name || '?') + '@')) continue;
      if (d.length < 10 || badSel(d) || !code.includes(d.slice(2, 10))) continue; /* 空呼叫（直接轉 0 BNB）不算鑄造 */
      const dd = /重播|熱門函式/.test(n) ? freshDeadline(d) : d;
      for (const v of NEAR_FREE) {
        try {
          await rpc('eth_call', [{
            from,
            to: c,
            data: dd,
            value: '0x' + v.toString(16)
          }, 'latest']);
          return {
            n,
            v
          };
        } catch {}
      }
    }
    const W0 = WALLETS.find(x => x.addr === from); /* 要帶自己 Agent ID 編號的鑄造：mint(編號)、claim(編號) */
    if (W0?.agentId) for (const sel of ['a0712d68', '379607f5', '6a627842']) {
      if (!code.includes(sel)) continue;
      const d = '0x' + sel + W0.agentId,
        n = `帶Agent編號${sel}#${W0.name}@${c.slice(2, 10)}`;
      for (const v of NEAR_FREE) {
        try {
          await rpc('eth_call', [{
            from,
            to: c,
            data: d,
            value: '0x' + v.toString(16)
          }, 'latest']);
          if (!CANDS.some(x => x[0] === n)) CANDS.push([n, d]);
          return {
            n,
            v
          };
        } catch {}
      }
    }
    return null;
  }
  const BAD_SEL = new Set(['0xa9059cbb', '0x095ea7b3', '0x23b872dd', '0x42842e0e', '0xb88d4fde', '0xa22cb465', '0x39509351', '0xd505accf', '0xf242432a', '0x2eb2c2d6']);
  const badSel = d => BAD_SEL.has(String(d || '').slice(0, 10).toLowerCase());
  const fpCache = new Map();
  async function freeProgress(c) {
    /* 免費項目的進度：已鑄造／總量；讀不到回傳 null（30 秒快取） */
    const k = fpCache.get(c);
    if (k && Date.now() - k.t < 30e3) return k.p;
    let p = null;
    const decR = await call(c, '0x313ce567');
    const isErc20 = !!(decR && decR.length >= 66 && BigInt(decR.slice(0, 66)) > 0n && BigInt(decR.slice(0, 66)) <= 36n); /* ERC20 常常一開始就全部發行，用「已發行÷總量」會誤判成 100% */
    const tmR = isErc20 ? null : await call(c, '0xa2309ff8'); /* 除錯 11/1：先看「實際鑄出數」totalMinted；totalSupply 會含項目方預留，SmokeeAgent 才鑄 72 個卻讀成 100% */
    const tsR = isErc20 ? null : tmR && tmR.length >= 66 ? tmR : await call(c, '0x18160ddd');
    if (tsR && tsR.length >= 66) {
      const sup = Number(BigInt(tsR.slice(0, 66)));
      for (const sel of ['0xd5abeb01', '0x32cb6b0c', '0x355274ea', '0xe985e367', '0xf1aee5a2', '0x0f2cdd6c', '0xa0e23ebd']) {
        const r = await call(c, sel);
        if (r && r.length >= 66) {
          const x = Number(BigInt(r.slice(0, 66)));
          if (x > 0 && x >= sup && x < 1e15) {
            p = sup / x;
            break;
          }
        }
      }
    }
    if (p == null) {
      const code = (await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || '';
      const pr = await progressOf(c, code.toLowerCase(), '').catch(() => ({}));
      if (pr.progress > 0) p = pr.progress;
    }
    fpCache.set(c, {
      t: Date.now(),
      p
    });
    return p;
  }
  const codeCache = new Map();
  async function codeOf(a) {
    if (!codeCache.has(a)) codeCache.set(a, ((await rpc('eth_getCode', [a, 'latest']).catch(() => '')) || '').toLowerCase());
    return codeCache.get(a);
  }
  async function readLimit(W, c) {
    const code = ((await codeOf(c)) || '').toLowerCase();
    const has = s => code.includes(s);
    const num = r => r && r.length >= 66 ? BigInt(r.slice(0, 66)) : null;
    const me = wa(W.addr);
    const lim = [];
    for (const s of ['d872e413', 'b399b0bc', 'b0b5230f', '7aa9a9d8']) if (has(s)) {
      const x = num(await call(c, '0x' + s + me));
      if (x != null && x < 1000000n) {
        lim.push(x);
        break;
      }
    }
    let per = null;
    for (const s of ['453c2310', 'b228d925', '0f2cdd6c', 'f516a2e6', '3c8463a1', 'a4183dbe', '6ac8c1b7']) if (has(s)) {
      const x = num(await call(c, '0x' + s));
      if (x != null && x > 0n && x < 1000000n) {
        per = x;
        break;
      }
    }
    if (per == null) for (const s of ['1cee24f5', 'ef23b3a3']) if (has(s)) {
      const x = num(await call(c, '0x' + s + me));
      if (x != null && x > 0n && x < 1000000n) {
        per = x;
        break;
      }
    }
    if (per != null) {
      let mine = 0n;
      for (const s of ['1e7269c5', '3cef28d2', 'dc33e681', 'fddcb5ea', 'f5eb42dc', '7b622c72']) if (has(s)) {
        const x = num(await call(c, '0x' + s + me));
        if (x != null && x < 1000000n) {
          mine = x;
          break;
        }
      }
      lim.push(per > mine ? per - mine : 0n);
    }
    for (const s of ['f968adbe', 'f43a22dc', 'de7fcb1d']) if (has(s)) {
      const x = num(await call(c, '0x' + s));
      if (x != null && x > 0n && x < 1000000n) {
        lim.push(x);
        break;
      }
    }
    return lim.length ? lim.reduce((a, b) => b < a ? b : a) : null;
  }
  async function fitShares(W, c, data, v) {
    // 份數：先讀項目方開放幾份；讀不到再自動降到 5、3、2、1 份試
    const ws = data.slice(10).match(/.{64}/g) || [];
    if (!ws.length) return data;
    let n0 = BigInt('0x' + ws[0]);
    if (n0 < 1n || n0 > 100n) return data;
    const lim = await readLimit(W, c).catch(() => null);
    if (lim != null) {
      if (lim === 0n) throw new Error('這個錢包的額度已經用完');
      if (lim < n0) {
        log(`讀到項目方開放份數 ${lim}，照這個打：${c}`);
        n0 = lim;
      }
    }
    const nOrig = BigInt('0x' + ws[0]);
    for (const n of [n0, ...[5n, 3n, 2n, 1n].filter(x => x < n0)]) {
      const d2 = data.slice(0, 10) + w(n) + ws.slice(1).join('');
      const vv = BigInt(v || 0) * n / nOrig; /* 審查 11/1：份數降了，付的錢也要按比例降（以前照付原本的金額） */
      try {
        await rpc('eth_call', [{
          from: W.addr,
          to: c,
          data: d2,
          value: '0x' + vv.toString(16)
        }, 'latest']);
        if (n !== n0) log(`份數降到 ${n} 份才打得了：${c}`);
        return d2;
      } catch {}
    }
    return data;
  }
  const REFUND_SELS = ['590e1ae3', 'b5545a3c', '278ecde1', '5b7baf64', '110f8874', '16bfe25c', '38e771ab', 'b2d5ae44', 'fa89401a', 'bffa55d5', '68ec0d99', '74c1b1c9', 'b30196e5', 'c033a490', '4c4a386f', 'd233e4eb'];
  const scaleV = (d0, d1, v) => {
    /* 份數從 d0 的第一個參數變成 d1 的，金額按比例調整 */try {
      const a = BigInt('0x' + d0.slice(10, 74)),
        b = BigInt('0x' + d1.slice(10, 74));
      if (a >= 1n && a <= 100n && b >= 1n && b < a) return BigInt(v) * b / a;
    } catch {}
    return BigInt(v);
  };
  async function safeAddrs(W, c, data, v) {
    let ws = data.slice(10).match(/.{64}/g) || [];
    const me = W.addr.slice(2).toLowerCase();
    if (W.agentId) {
      let sw = 0;
      for (let i = 0; i < ws.length; i++) {
        const x = ws[i].toLowerCase();
        if (/^0{24}/.test(x) || BigInt('0x' + x) < 2n ** 128n || x === W.agentId) continue;
        const o = await call('0x' + REGISTRY, '0x6352211e' + x);
        if (o && BigInt(o.slice(0, 66)) > 0n && o.slice(26, 66).toLowerCase() !== me) {
          ws[i] = W.agentId;
          sw = 1;
        }
      }
      if (sw) {
        data = data.slice(0, 10) + ws.join('');
        log(`照抄前把別人的 Agent ID 編號換成自己的：${c}`);
      }
    } /* 照抄的交易帶著別人的 Agent ID 編號 → 換成自己的 */
    const skip = new Set([me, c.slice(2).toLowerCase(), USDT.slice(2).toLowerCase(), WBNB.slice(2).toLowerCase()]);
    const idx = ws.map((x, i) => [x.toLowerCase(), i]).filter(([x]) => /^0{24}[0-9a-f]{40}$/.test(x) && x.slice(24, 32) !== '00000000' && !skip.has(x.slice(24))).map(([, i]) => i);
    if (!idx.length) return data;
    for (const r of [me.padStart(64, '0'), '0'.repeat(64)]) {
      const d2 = data.slice(0, 10) + ws.map((x, i) => idx.includes(i) ? r : x).join('');
      try {
        await rpc('eth_call', [{
          from: W.addr,
          to: c,
          data: d2,
          value: '0x' + BigInt(v || 0).toString(16)
        }, 'latest']);
        log(`照抄前把別人的地址換成${r === '0'.repeat(64) ? '零地址' : '自己的地址'}：${c}`);
        return d2;
      } catch {}
    }
    throw new Error('交易裡有別人的地址，換成自己或零地址都打不了，安全起見不打');
  }
  const SOLD_SELS = ['a2309ff8', 'f4514d2e', '505e05fd', 'cc84efea', '192fc516', '9106d7ba', '67153ab4', 'f3f8a4fd', '06ed0717', '9659867e', '4f02c420', '1f21bfbf'];
  const CAP_SELS = ['d8f93498', 'c65b61ca', '3a98ef39', 'b6b6f0c3', 'cce132d1', 'd5abeb01', '32cb6b0c', '06517a29', '2163837f', 'aa2d9a02', '76c71ca1', '98f1312e', '355274ea', '85e3f997'];
  async function progressOf(c, code, tokAddr) {
    let sold = null,
      cap = null;
    for (const s of SOLD_SELS) {
      if (!code.includes(s)) continue;
      const r = await call(c, '0x' + s);
      if (r && r.length >= 66) {
        sold = Number(BigInt(r.slice(0, 66)));
        break;
      }
    }
    if (sold != null) for (const s of CAP_SELS) {
      if (!code.includes(s)) continue;
      const r = await call(c, '0x' + s);
      if (r && r.length >= 66) {
        const x = Number(BigInt(r.slice(0, 66)));
        if (x > 10 && x >= sold && x < 1e12) {
          cap = x;
          break;
        }
      }
    }
    if (sold != null && cap) return {
      progress: sold / cap,
      sold,
      cap,
      how: '已售／上限'
    };
    S.prog = S.prog || {};
    let pg = S.prog[c];
    const tok = tokAddr || c;
    if (!pg) {
      const head = parseInt(await rpc('eth_blockNumber', []), 16);
      const has = async b => ((await rpc('eth_getCode', [c, '0x' + b.toString(16)]).catch(() => '0x')) || '0x').length > 2;
      let lo = head - 400000,
        hi = head;
      if (await has(lo)) {
        S.prog[c] = {
          none: 1
        };
        return {
          progress: 0,
          sold,
          cap
        };
      }
      while (hi - lo > 1) {
        const m = lo + hi >> 1;
        if (await has(m)) hi = m;else lo = m;
      }
      let init = 0n;
      for (const b of [hi, hi + 1, hi + 5, hi + 20]) {
        const r = await rpc('eth_call', [{
          to: tok,
          data: '0x70a08231' + wa(c)
        }, '0x' + b.toString(16)]).catch(() => null);
        if (r && r.length >= 66 && BigInt(r.slice(0, 66)) > 0n) {
          init = BigInt(r.slice(0, 66));
          break;
        }
      }
      pg = S.prog[c] = init > 0n ? {
        init: init.toString(),
        tok
      } : {
        none: 1
      };
    }
    if (pg.none) return {
      progress: 0,
      sold,
      cap
    };
    const now = big(await call(pg.tok, '0x70a08231' + wa(c)));
    const init = BigInt(pg.init);
    return {
      progress: Number(init - now) / Number(init),
      sold,
      cap,
      how: '鑄造池剩餘'
    };
  }
  function freshDeadline(data) {
    /* 照抄的交易裡如果有「期限」（看起來像時間戳記的數字），換成 15 分鐘後，不然舊交易一定過期失敗（币安无忧 10/31） */
    const now = Math.floor(Date.now() / 1000);
    const ws = data.slice(10).match(/.{64}/g) || [];
    let ch = 0;
    const out = ws.map(x => {
      const v = BigInt('0x' + x);
      if (v > BigInt(now - 30 * 86400) && v < BigInt(now + 30 * 86400)) {
        ch = 1;
        return BigInt(now + 900).toString(16).padStart(64, '0');
      }
      return x;
    });
    return ch ? data.slice(0, 10) + out.join('') : data;
  }
  async function findCapSel(c, code, sold) {
    /* 從合約碼找無參數函式，回傳「像總量」的（大於已售、整百、≤1 千萬），優先 10000 */
    const hex = String(code || '').toLowerCase().replace(/^0x/, '');
    const sels = new Set();
    for (let i = 0; i < hex.length - 10; i += 2) if (hex.slice(i, i + 2) === '63') sels.add(hex.slice(i + 2, i + 10));
    const cand = [];
    for (const sel of [...sels].slice(0, 160)) {
      const r = await call(c, '0x' + sel);
      if (!r || r.length !== 66) continue;
      const v = Number(BigInt(r));
      if (v > sold && v <= 1e7 && v % 100 === 0) cand.push([sel, v]);
    }
    if (!cand.length) return '';
    cand.sort((x, y) => (y[1] === 10000) - (x[1] === 10000) || x[1] - y[1]);
    log(`找到 ${c} 的總量函式 0x${cand[0][0]} = ${cand[0][1]}`);
    return cand[0][0];
  }
  async function learnReplay(c) {
    // 學別人最近成功的鑄造：最常見的函式、要付多少 BNB／USDT、最近有幾個錢包在打
    const head = parseInt(await rpc('eth_blockNumber', []), 16);
    const L = await logsRpc([{
      address: c,
      fromBlock: '0x' + (head - 1500).toString(16),
      toBlock: '0x' + head.toString(16)
    }]).catch(() => rpc('eth_getLogs', [{
      address: c,
      fromBlock: '0x' + (head - 1500).toString(16),
      toBlock: 'latest'
    }]).catch(() => [])); /* 除錯 11/1：預設節點查事件常被限流（limit exceeded）→ 學不到打法；改用多節點輪替 */
    const hs = [...new Set((L || []).map(l => l.transactionHash))].slice(-40);
    const all = (await Promise.all(hs.map(h => rpc('eth_getTransactionByHash', [h]).catch(() => null)))).filter(t => t && t.to && t.to.toLowerCase() === c);
    const txs = all.filter(t => t.input && t.input.length >= 10 && !badSel(t.input) && !t.input.toLowerCase().includes(t.from.slice(2).toLowerCase()));
    {
      /* 除錯 11/1：BNBCAT 這種「直接轉 BNB 就鑄造」的合約，別人的交易沒有呼叫資料，以前學不到 → 進度過 55% 也一直沒打。現在學「大家最常轉的金額」 */
      const plain = all.filter(t => (t.input || '0x') === '0x' && BigInt(t.value || '0x0') > 0n);
      if (plain.length >= 3 && plain.length >= txs.length) {
        const vc = {};
        for (const t of plain) {
          const v = BigInt(t.value).toString();
          vc[v] = (vc[v] || 0) + 1;
        }
        const top = Object.entries(vc).sort((x, y) => y[1] - x[1])[0];
        const hot = new Set(plain.filter(t => parseInt(t.blockNumber, 16) >= head - 400).map(t => t.from.toLowerCase())).size;
        return {
          recv: top[0],
          recvSeen: top[1],
          recvVals: Object.keys(vc),
          hot,
          learned: 1,
          learnedAt: Date.now()
        };
      }
    }
    if (!txs.length) return null;
    const cnt = {};
    for (const t of txs) cnt[t.input.slice(0, 10)] = (cnt[t.input.slice(0, 10)] || 0) + 1;
    const sel = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0];
    const cands = txs.filter(t => t.input.startsWith(sel)).reverse().sort((a, b) => a.input.length - b.input.length); // 優先學最簡單的那種（別人帶了自己的 NFT 編號等額外參數的，照抄會失敗）
    for (const pick of cands.slice(0, 3)) {
      const rc = await rpc('eth_getTransactionReceipt', [pick.hash]).catch(() => null);
      if (!rc || rc.status !== '0x1') continue;
      let payTok = '',
        payAmt = '0';
      for (const l of rc.logs || []) if (l.topics?.[0] === T_TRANSFER && l.topics.length === 3 && ('0x' + l.topics[1].slice(26)).toLowerCase() === pick.from.toLowerCase()) {
        payTok = l.address.toLowerCase();
        payAmt = BigInt(l.data).toString();
        break;
      }
      const hot = new Set(txs.filter(t => parseInt(t.blockNumber, 16) >= head - 400).map(t => t.from.toLowerCase())).size;
      return {
        data: pick.input,
        value: BigInt(pick.value).toString(),
        payTok,
        payAmt,
        hot,
        learned: 1,
        learnedAt: Date.now()
      };
    }
    return null;
  }
  const memoC = new Map();
  const cc = async (to, data, ttl = 600e3) => {
    const k = to + data,
      m = memoC.get(k);
    if (m && Date.now() - m.t < ttl) return m.v;
    const v = await call(to, data);
    memoC.set(k, {
      v,
      t: Date.now()
    });
    if (memoC.size > 20000) memoC.clear();
    return v;
  };
  return {
    get CANDS() {
      return CANDS;
    },
    get NEAR_FREE() {
      return NEAR_FREE;
    },
    get badSel() {
      return badSel;
    },
    get fullCode() {
      return fullCode;
    },
    get codeOf() {
      return codeOf;
    },
    get fitShares() {
      return fitShares;
    },
    get REFUND_SELS() {
      return REFUND_SELS;
    },
    get scaleV() {
      return scaleV;
    },
    get safeAddrs() {
      return safeAddrs;
    },
    get fpCache() {
      return fpCache;
    },
    get freeProgress() {
      return freeProgress;
    },
    get progressOf() {
      return progressOf;
    },
    get freshDeadline() {
      return freshDeadline;
    },
    get findCapSel() {
      return findCapSel;
    },
    get learnReplay() {
      return learnReplay;
    },
    get cc() {
      return cc;
    },
    get findFree() {
      return findFree;
    }
  };
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJjcmVhdGVDb250cmFjdHMiLCJkZXBlbmRlbmNpZXMiLCJSRUdJU1RSWSIsIlMiLCJUX1RSQU5TRkVSIiwiVVNEVCIsIldBTExFVFMiLCJXQk5CIiwiYmlnIiwiY2FsbCIsImxvZyIsImxvZ3NScGMiLCJycGMiLCJ3Iiwid2EiLCJDQU5EUyIsImZ1bGxDb2RlIiwiYyIsImNvZGUiLCJTdHJpbmciLCJ0b0xvd2VyQ2FzZSIsImxlbmd0aCIsImluY2x1ZGVzIiwiYWRkIiwiYSIsIngiLCJjYXRjaCIsImltcGwiLCJCaWdJbnQiLCJzbGljZSIsImJjIiwiciIsImVtYjAiLCJoIiwicmVwbGFjZSIsIm0xMTY3IiwibWF0Y2giLCJwdXNoIiwiaSIsIm9wIiwid3YiLCJ0ZXN0IiwibiIsInBhcnNlSW50IiwiZW1iIiwiU2V0IiwiZmlsdGVyIiwiTkVBUl9GUkVFIiwiZmluZEZyZWUiLCJmcm9tIiwiZCIsImVuZHNXaXRoIiwiZmluZCIsImFkZHIiLCJuYW1lIiwiYmFkU2VsIiwiZGQiLCJmcmVzaERlYWRsaW5lIiwidiIsInRvIiwiZGF0YSIsInZhbHVlIiwidG9TdHJpbmciLCJXMCIsImFnZW50SWQiLCJzZWwiLCJzb21lIiwiQkFEX1NFTCIsImhhcyIsImZwQ2FjaGUiLCJNYXAiLCJmcmVlUHJvZ3Jlc3MiLCJrIiwiZ2V0IiwiRGF0ZSIsIm5vdyIsInQiLCJwIiwiZGVjUiIsImlzRXJjMjAiLCJ0bVIiLCJ0c1IiLCJzdXAiLCJOdW1iZXIiLCJwciIsInByb2dyZXNzT2YiLCJwcm9ncmVzcyIsInNldCIsImNvZGVDYWNoZSIsImNvZGVPZiIsInJlYWRMaW1pdCIsIlciLCJzIiwibnVtIiwibWUiLCJsaW0iLCJwZXIiLCJtaW5lIiwicmVkdWNlIiwiYiIsImZpdFNoYXJlcyIsIndzIiwibjAiLCJFcnJvciIsIm5PcmlnIiwiZDIiLCJqb2luIiwidnYiLCJSRUZVTkRfU0VMUyIsInNjYWxlViIsImQwIiwiZDEiLCJzYWZlQWRkcnMiLCJzdyIsIm8iLCJza2lwIiwiaWR4IiwibWFwIiwicGFkU3RhcnQiLCJyZXBlYXQiLCJTT0xEX1NFTFMiLCJDQVBfU0VMUyIsInRva0FkZHIiLCJzb2xkIiwiY2FwIiwiaG93IiwicHJvZyIsInBnIiwidG9rIiwiaGVhZCIsImxvIiwiaGkiLCJub25lIiwibSIsImluaXQiLCJNYXRoIiwiZmxvb3IiLCJjaCIsIm91dCIsImZpbmRDYXBTZWwiLCJoZXgiLCJzZWxzIiwiY2FuZCIsInNvcnQiLCJ5IiwibGVhcm5SZXBsYXkiLCJMIiwiYWRkcmVzcyIsImZyb21CbG9jayIsInRvQmxvY2siLCJocyIsImwiLCJ0cmFuc2FjdGlvbkhhc2giLCJhbGwiLCJQcm9taXNlIiwidHhzIiwiaW5wdXQiLCJwbGFpbiIsInZjIiwidG9wIiwiT2JqZWN0IiwiZW50cmllcyIsImhvdCIsImJsb2NrTnVtYmVyIiwic2l6ZSIsInJlY3YiLCJyZWN2U2VlbiIsInJlY3ZWYWxzIiwia2V5cyIsImxlYXJuZWQiLCJsZWFybmVkQXQiLCJjbnQiLCJjYW5kcyIsInN0YXJ0c1dpdGgiLCJyZXZlcnNlIiwicGljayIsInJjIiwiaGFzaCIsInN0YXR1cyIsInBheVRvayIsInBheUFtdCIsImxvZ3MiLCJ0b3BpY3MiLCJtZW1vQyIsImNjIiwidHRsIiwiY2xlYXIiXSwic291cmNlcyI6WyJjb250cmFjdHMubWpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIE1vZHVsZTogY29udHJhY3RzLiBDb25zdHJ1Y3Rpb24gaXMgaW5lcnQ7IEkvTyBpcyBpbnZva2VkIGV4cGxpY2l0bHkuXG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVDb250cmFjdHMoZGVwZW5kZW5jaWVzKSB7XG4gIGNvbnN0IHsgUkVHSVNUUlksIFMsIFRfVFJBTlNGRVIsIFVTRFQsIFdBTExFVFMsIFdCTkIsIGJpZywgY2FsbCwgbG9nLCBsb2dzUnBjLCBycGMsIHcsIHdhIH0gPSBkZXBlbmRlbmNpZXM7XG4gIGNvbnN0IENBTkRTID0gW1snbWludCgpJywgJzB4MTI0OWM1OGInXSwgWydmcmVlTWludCgpJywgJzB4NWI3MGVhOWYnXSwgWydjbGFpbSgpJywgJzB4NGU3MWQ5MmQnXSwgWydtaW50KDEpJywgJzB4YTA3MTJkNjgnICsgdygxKV0sIFsncHVibGljTWludCgpJywgJzB4MjYwOTJiODMnXSwgWydjb21taXRGcmVlTWludCgpJywgJzB4NzRkMDRjZmMnXSwgWydyZWdpc3RlckZvclJld2FyZHMoKScsICcweDlmOTJkMGRkJ10sIFsnZnJlZU1pbnQoMSknLCAnMHg3YzkyOGZlOScgKyB3KDEpXSwgWydjbGFpbSgxKScsICcweDM3OTYwN2Y1JyArIHcoMSldLCBbJ21pbnRGcmVlKCknLCAnMHg4YWI1MzQ0NyddLCBbJ2NsYWltRnJlZSgpJywgJzB4ZjM2NmFmYzknXSwgWydhZ2VudE1pbnQoKScsICcweDFiZTM1ODdhJ11dO1xuXG4gIGFzeW5jIGZ1bmN0aW9uIGZ1bGxDb2RlKGMsIGNvZGUpIHsgLyog5a+p5p+l5L+u5q2j77yIRkFHRU5UIOa8j+aOieeahOWOn+WboO+8ie+8muS7o+eQhuWQiOe0hOS4gOW+i+i/veWIsOiDjOW+jOeahOecn+ato+eoi+W8j+KAlOKAlEVJUC0xOTY344CBQmVhY29uIOanveS9jeOAgeeoi+W8j+ijoeWvq+atu+eahCBCZWFjb27vvI/lr6bkvZzlnLDlnYDjgIHmnIDlsI/ku6PnkIbvvIhFSVAtMTE2N++8iSAqL1xuICAgIGNvZGUgPSBTdHJpbmcoY29kZSB8fCAnJykudG9Mb3dlckNhc2UoKTsgaWYgKGNvZGUubGVuZ3RoIDwgNCB8fCBjb2RlLmxlbmd0aCA+PSA0MDAwIHx8IGNvZGUuaW5jbHVkZXMoUkVHSVNUUlkpKSByZXR1cm4gY29kZTtcbiAgICBjb25zdCBhZGQgPSBhc3luYyAoYSkgPT4geyBjb25zdCB4ID0gKChhd2FpdCBycGMoJ2V0aF9nZXRDb2RlJywgW2EsICdsYXRlc3QnXSkuY2F0Y2goKCkgPT4gJycpKSB8fCAnJykudG9Mb3dlckNhc2UoKTsgY29kZSArPSB4OyByZXR1cm4geDsgfTtcbiAgICB0cnkgeyBjb25zdCBpbXBsID0gYXdhaXQgcnBjKCdldGhfZ2V0U3RvcmFnZUF0JywgW2MsICcweDM2MDg5NGExM2JhMWEzMjEwNjY3YzgyODQ5MmRiOThkY2EzZTIwNzZjYzM3MzVhOTIwYTNjYTUwNWQzODJiYmMnLCAnbGF0ZXN0J10pOyBpZiAoaW1wbCAmJiBCaWdJbnQoaW1wbCkgIT09IDBuKSBhd2FpdCBhZGQoJzB4JyArIGltcGwuc2xpY2UoLTQwKSk7IH0gY2F0Y2gge31cbiAgICB0cnkgeyBjb25zdCBiYyA9IGF3YWl0IHJwYygnZXRoX2dldFN0b3JhZ2VBdCcsIFtjLCAnMHhhM2YwYWQ3NGU1NDIzYWViZmQ4MGQzZWY0MzQ2NTc4MzM1YTlhNzJhZWFlZTU5ZmY2Y2IzNTgyYjM1MTMzZDUwJywgJ2xhdGVzdCddKTsgaWYgKGJjICYmIEJpZ0ludChiYykgIT09IDBuKSB7IGNvbnN0IHIgPSBhd2FpdCBjYWxsKCcweCcgKyBiYy5zbGljZSgtNDApLCAnMHg1YzYwZGExYicpOyBpZiAociAmJiBCaWdJbnQocikgIT09IDBuKSBhd2FpdCBhZGQoJzB4JyArIHIuc2xpY2UoLTQwKSk7IH0gfSBjYXRjaCB7fVxuICAgIGNvbnN0IGVtYjAgPSBbXTsgeyBjb25zdCBoID0gY29kZS5yZXBsYWNlKC9eMHgvLCAnJykuc2xpY2UoMCwgMTIwMCk7IGNvbnN0IG0xMTY3ID0gaC5tYXRjaCgvXjM2M2QzZDM3M2QzZDNkMzYzZDczKFswLTlhLWZdezQwfSk1YWY0Lyk7IGlmIChtMTE2NykgZW1iMC5wdXNoKCcweCcgKyBtMTE2N1sxXSk7IGZvciAobGV0IGkgPSAwOyBpICsgNDIgPD0gaC5sZW5ndGg7IGkgKz0gMikgeyBjb25zdCBvcCA9IGguc2xpY2UoaSwgaSArIDIpOyBpZiAob3AgPT09ICc3MycpIHsgZW1iMC5wdXNoKCcweCcgKyBoLnNsaWNlKGkgKyAyLCBpICsgNDIpKTsgaSArPSA0MDsgfSBlbHNlIGlmIChvcCA9PT0gJzdmJykgeyBjb25zdCB3diA9IGguc2xpY2UoaSArIDIsIGkgKyA2Nik7IGlmICgvXjB7MjR9Ly50ZXN0KHd2KSkgZW1iMC5wdXNoKCcweCcgKyB3di5zbGljZSgyNCkpOyBpICs9IDY0OyB9IGVsc2UgeyBjb25zdCBuID0gcGFyc2VJbnQob3AsIDE2KTsgaWYgKG4gPj0gMHg2MCAmJiBuIDw9IDB4N2YpIGkgKz0gKG4gLSAweDVmKSAqIDI7IH0gfSB9IC8qIOmZpOmMryAxMS8x77ya5Lul5YmN55So5a2X5Liy5q+U5bCN5pyD5b6e6Yyv55qE5L2N572u5YiH77yI5pyA5bCP5Luj55CGIDM2M2QzZDM34oCmIOijoeeahOOAjDM3IDNk44CN6KKr55W25oiQIDcz77yJ77yM5oqT5LiN5YiwIGJpYmlhaSDnmoTlr6bkvZzlkIjntIQg4oaSIOiqpOWIpOaykuaciemAgOasvuapn+WItu+8m+aUueaIkOeFp+S9jeWFg+e1hOmAkOS4gOino+aekCAqL1xuICAgIGNvbnN0IGVtYiA9IFsuLi5uZXcgU2V0KGVtYjApXS5maWx0ZXIoKGEpID0+ICEvXjB4MHs0MH0kLy50ZXN0KGEpICYmIGEubGVuZ3RoID09PSA0Mikuc2xpY2UoMCwgMyk7XG4gICAgZm9yIChjb25zdCBhIG9mIGVtYikgeyBpZiAoY29kZS5pbmNsdWRlcyhSRUdJU1RSWSkpIGJyZWFrOyBjb25zdCByID0gYXdhaXQgY2FsbChhLCAnMHg1YzYwZGExYicpOyBpZiAociAmJiByLmxlbmd0aCA+PSA2NiAmJiBCaWdJbnQoci5zbGljZSgwLCA2NikpICE9PSAwbikgYXdhaXQgYWRkKCcweCcgKyByLnNsaWNlKC00MCkpOyBlbHNlIGF3YWl0IGFkZChhKTsgfVxuICAgIHJldHVybiBjb2RlO1xuICB9XG5cbiAgY29uc3QgTkVBUl9GUkVFID0gWzBuLCAxMG4gKiogMTRuLCAyMm4gKiAxMG4gKiogMTNuLCAzbiAqIDEwbiAqKiAxNG4sIDVuICogMTBuICoqIDE0biwgMTBuICoqIDE1bl07XG5cbiAgYXN5bmMgZnVuY3Rpb24gZmluZEZyZWUoZnJvbSwgYywgY29kZSkge1xuICAgIGZvciAoY29uc3QgW24sIGRdIG9mIENBTkRTKSB7IGlmIChuLmluY2x1ZGVzKCdAJykgJiYgIW4uZW5kc1dpdGgoJ0AnICsgYy5zbGljZSgyLCAxMCkpKSBjb250aW51ZTsgaWYgKG4uaW5jbHVkZXMoJyMnKSAmJiAhbi5pbmNsdWRlcygnIycgKyAoV0FMTEVUUy5maW5kKCh4KSA9PiB4LmFkZHIgPT09IGZyb20pPy5uYW1lIHx8ICc/JykgKyAnQCcpKSBjb250aW51ZTsgaWYgKGQubGVuZ3RoIDwgMTAgfHwgYmFkU2VsKGQpIHx8ICFjb2RlLmluY2x1ZGVzKGQuc2xpY2UoMiwgMTApKSkgY29udGludWU7IC8qIOepuuWRvOWPq++8iOebtOaOpei9iSAwIEJOQu+8ieS4jeeul+mRhOmAoCAqLyBjb25zdCBkZCA9IC/ph43mkq1854ax6ZaA5Ye95byPLy50ZXN0KG4pID8gZnJlc2hEZWFkbGluZShkKSA6IGQ7IGZvciAoY29uc3QgdiBvZiBORUFSX0ZSRUUpIHsgdHJ5IHsgYXdhaXQgcnBjKCdldGhfY2FsbCcsIFt7IGZyb20sIHRvOiBjLCBkYXRhOiBkZCwgdmFsdWU6ICcweCcgKyB2LnRvU3RyaW5nKDE2KSB9LCAnbGF0ZXN0J10pOyByZXR1cm4geyBuLCB2IH07IH0gY2F0Y2gge30gfSB9XG4gICAgY29uc3QgVzAgPSBXQUxMRVRTLmZpbmQoKHgpID0+IHguYWRkciA9PT0gZnJvbSk7IC8qIOimgeW4tuiHquW3sSBBZ2VudCBJRCDnt6jomZ/nmoTpkYTpgKDvvJptaW50KOe3qOiZnynjgIFjbGFpbSjnt6jomZ8pICovXG4gICAgaWYgKFcwPy5hZ2VudElkKSBmb3IgKGNvbnN0IHNlbCBvZiBbJ2EwNzEyZDY4JywgJzM3OTYwN2Y1JywgJzZhNjI3ODQyJ10pIHsgaWYgKCFjb2RlLmluY2x1ZGVzKHNlbCkpIGNvbnRpbnVlOyBjb25zdCBkID0gJzB4JyArIHNlbCArIFcwLmFnZW50SWQsIG4gPSBg5bi2QWdlbnTnt6jomZ8ke3NlbH0jJHtXMC5uYW1lfUAke2Muc2xpY2UoMiwgMTApfWA7IGZvciAoY29uc3QgdiBvZiBORUFSX0ZSRUUpIHsgdHJ5IHsgYXdhaXQgcnBjKCdldGhfY2FsbCcsIFt7IGZyb20sIHRvOiBjLCBkYXRhOiBkLCB2YWx1ZTogJzB4JyArIHYudG9TdHJpbmcoMTYpIH0sICdsYXRlc3QnXSk7IGlmICghQ0FORFMuc29tZSgoeCkgPT4geFswXSA9PT0gbikpIENBTkRTLnB1c2goW24sIGRdKTsgcmV0dXJuIHsgbiwgdiB9OyB9IGNhdGNoIHt9IH0gfVxuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgY29uc3QgQkFEX1NFTCA9IG5ldyBTZXQoWycweGE5MDU5Y2JiJywgJzB4MDk1ZWE3YjMnLCAnMHgyM2I4NzJkZCcsICcweDQyODQyZTBlJywgJzB4Yjg4ZDRmZGUnLCAnMHhhMjJjYjQ2NScsICcweDM5NTA5MzUxJywgJzB4ZDUwNWFjY2YnLCAnMHhmMjQyNDMyYScsICcweDJlYjJjMmQ2J10pO1xuXG4gIGNvbnN0IGJhZFNlbCA9IChkKSA9PiBCQURfU0VMLmhhcyhTdHJpbmcoZCB8fCAnJykuc2xpY2UoMCwgMTApLnRvTG93ZXJDYXNlKCkpO1xuXG4gIGNvbnN0IGZwQ2FjaGUgPSBuZXcgTWFwKCk7XG5cbiAgYXN5bmMgZnVuY3Rpb24gZnJlZVByb2dyZXNzKGMpIHsgLyog5YWN6LK76aCF55uu55qE6YCy5bqm77ya5bey6ZGE6YCg77yP57i96YeP77yb6K6A5LiN5Yiw5Zue5YKzIG51bGzvvIgzMCDnp5Llv6vlj5bvvIkgKi9cbiAgICBjb25zdCBrID0gZnBDYWNoZS5nZXQoYyk7IGlmIChrICYmIERhdGUubm93KCkgLSBrLnQgPCAzMGUzKSByZXR1cm4gay5wO1xuICAgIGxldCBwID0gbnVsbDsgY29uc3QgZGVjUiA9IGF3YWl0IGNhbGwoYywgJzB4MzEzY2U1NjcnKTsgY29uc3QgaXNFcmMyMCA9ICEhKGRlY1IgJiYgZGVjUi5sZW5ndGggPj0gNjYgJiYgQmlnSW50KGRlY1Iuc2xpY2UoMCwgNjYpKSA+IDBuICYmIEJpZ0ludChkZWNSLnNsaWNlKDAsIDY2KSkgPD0gMzZuKTsgLyogRVJDMjAg5bi45bi45LiA6ZaL5aeL5bCx5YWo6YOo55m86KGM77yM55So44CM5bey55m86KGMw7fnuL3ph4/jgI3mnIPoqqTliKTmiJAgMTAwJSAqL1xuICAgIGNvbnN0IHRtUiA9IGlzRXJjMjAgPyBudWxsIDogYXdhaXQgY2FsbChjLCAnMHhhMjMwOWZmOCcpOyAvKiDpmaTpjK8gMTEvMe+8muWFiOeci+OAjOWvpumam+mRhOWHuuaVuOOAjXRvdGFsTWludGVk77ybdG90YWxTdXBwbHkg5pyD5ZCr6aCF55uu5pa56aCQ55WZ77yMU21va2VlQWdlbnQg5omN6ZGEIDcyIOWAi+WNu+iugOaIkCAxMDAlICovXG4gICAgY29uc3QgdHNSID0gaXNFcmMyMCA/IG51bGwgOiAodG1SICYmIHRtUi5sZW5ndGggPj0gNjYgPyB0bVIgOiBhd2FpdCBjYWxsKGMsICcweDE4MTYwZGRkJykpO1xuICAgIGlmICh0c1IgJiYgdHNSLmxlbmd0aCA+PSA2NikgeyBjb25zdCBzdXAgPSBOdW1iZXIoQmlnSW50KHRzUi5zbGljZSgwLCA2NikpKTsgZm9yIChjb25zdCBzZWwgb2YgWycweGQ1YWJlYjAxJywgJzB4MzJjYjZiMGMnLCAnMHgzNTUyNzRlYScsICcweGU5ODVlMzY3JywgJzB4ZjFhZWU1YTInLCAnMHgwZjJjZGQ2YycsICcweGEwZTIzZWJkJ10pIHsgY29uc3QgciA9IGF3YWl0IGNhbGwoYywgc2VsKTsgaWYgKHIgJiYgci5sZW5ndGggPj0gNjYpIHsgY29uc3QgeCA9IE51bWJlcihCaWdJbnQoci5zbGljZSgwLCA2NikpKTsgaWYgKHggPiAwICYmIHggPj0gc3VwICYmIHggPCAxZTE1KSB7IHAgPSBzdXAgLyB4OyBicmVhazsgfSB9IH0gfVxuICAgIGlmIChwID09IG51bGwpIHsgY29uc3QgY29kZSA9IChhd2FpdCBycGMoJ2V0aF9nZXRDb2RlJywgW2MsICdsYXRlc3QnXSkuY2F0Y2goKCkgPT4gJycpKSB8fCAnJzsgY29uc3QgcHIgPSBhd2FpdCBwcm9ncmVzc09mKGMsIGNvZGUudG9Mb3dlckNhc2UoKSwgJycpLmNhdGNoKCgpID0+ICh7fSkpOyBpZiAocHIucHJvZ3Jlc3MgPiAwKSBwID0gcHIucHJvZ3Jlc3M7IH1cbiAgICBmcENhY2hlLnNldChjLCB7IHQ6IERhdGUubm93KCksIHAgfSk7IHJldHVybiBwO1xuICB9XG5cbiAgY29uc3QgY29kZUNhY2hlID0gbmV3IE1hcCgpO1xuXG4gIGFzeW5jIGZ1bmN0aW9uIGNvZGVPZihhKSB7IGlmICghY29kZUNhY2hlLmhhcyhhKSkgY29kZUNhY2hlLnNldChhLCAoKGF3YWl0IHJwYygnZXRoX2dldENvZGUnLCBbYSwgJ2xhdGVzdCddKS5jYXRjaCgoKSA9PiAnJykpIHx8ICcnKS50b0xvd2VyQ2FzZSgpKTsgcmV0dXJuIGNvZGVDYWNoZS5nZXQoYSk7IH1cblxuICBhc3luYyBmdW5jdGlvbiByZWFkTGltaXQoVywgYykge1xuICAgIGNvbnN0IGNvZGUgPSAoKGF3YWl0IGNvZGVPZihjKSkgfHwgJycpLnRvTG93ZXJDYXNlKCk7IGNvbnN0IGhhcyA9IChzKSA9PiBjb2RlLmluY2x1ZGVzKHMpOyBjb25zdCBudW0gPSAocikgPT4gKHIgJiYgci5sZW5ndGggPj0gNjYgPyBCaWdJbnQoci5zbGljZSgwLCA2NikpIDogbnVsbCk7IGNvbnN0IG1lID0gd2EoVy5hZGRyKTsgY29uc3QgbGltID0gW107XG4gICAgZm9yIChjb25zdCBzIG9mIFsnZDg3MmU0MTMnLCAnYjM5OWIwYmMnLCAnYjBiNTIzMGYnLCAnN2FhOWE5ZDgnXSkgaWYgKGhhcyhzKSkgeyBjb25zdCB4ID0gbnVtKGF3YWl0IGNhbGwoYywgJzB4JyArIHMgKyBtZSkpOyBpZiAoeCAhPSBudWxsICYmIHggPCAxMDAwMDAwbikgeyBsaW0ucHVzaCh4KTsgYnJlYWs7IH0gfVxuICAgIGxldCBwZXIgPSBudWxsOyBmb3IgKGNvbnN0IHMgb2YgWyc0NTNjMjMxMCcsICdiMjI4ZDkyNScsICcwZjJjZGQ2YycsICdmNTE2YTJlNicsICczYzg0NjNhMScsICdhNDE4M2RiZScsICc2YWM4YzFiNyddKSBpZiAoaGFzKHMpKSB7IGNvbnN0IHggPSBudW0oYXdhaXQgY2FsbChjLCAnMHgnICsgcykpOyBpZiAoeCAhPSBudWxsICYmIHggPiAwbiAmJiB4IDwgMTAwMDAwMG4pIHsgcGVyID0geDsgYnJlYWs7IH0gfVxuICAgIGlmIChwZXIgPT0gbnVsbCkgZm9yIChjb25zdCBzIG9mIFsnMWNlZTI0ZjUnLCAnZWYyM2IzYTMnXSkgaWYgKGhhcyhzKSkgeyBjb25zdCB4ID0gbnVtKGF3YWl0IGNhbGwoYywgJzB4JyArIHMgKyBtZSkpOyBpZiAoeCAhPSBudWxsICYmIHggPiAwbiAmJiB4IDwgMTAwMDAwMG4pIHsgcGVyID0geDsgYnJlYWs7IH0gfVxuICAgIGlmIChwZXIgIT0gbnVsbCkgeyBsZXQgbWluZSA9IDBuOyBmb3IgKGNvbnN0IHMgb2YgWycxZTcyNjljNScsICczY2VmMjhkMicsICdkYzMzZTY4MScsICdmZGRjYjVlYScsICdmNWViNDJkYycsICc3YjYyMmM3MiddKSBpZiAoaGFzKHMpKSB7IGNvbnN0IHggPSBudW0oYXdhaXQgY2FsbChjLCAnMHgnICsgcyArIG1lKSk7IGlmICh4ICE9IG51bGwgJiYgeCA8IDEwMDAwMDBuKSB7IG1pbmUgPSB4OyBicmVhazsgfSB9IGxpbS5wdXNoKHBlciA+IG1pbmUgPyBwZXIgLSBtaW5lIDogMG4pOyB9XG4gICAgZm9yIChjb25zdCBzIG9mIFsnZjk2OGFkYmUnLCAnZjQzYTIyZGMnLCAnZGU3ZmNiMWQnXSkgaWYgKGhhcyhzKSkgeyBjb25zdCB4ID0gbnVtKGF3YWl0IGNhbGwoYywgJzB4JyArIHMpKTsgaWYgKHggIT0gbnVsbCAmJiB4ID4gMG4gJiYgeCA8IDEwMDAwMDBuKSB7IGxpbS5wdXNoKHgpOyBicmVhazsgfSB9XG4gICAgcmV0dXJuIGxpbS5sZW5ndGggPyBsaW0ucmVkdWNlKChhLCBiKSA9PiAoYiA8IGEgPyBiIDogYSkpIDogbnVsbDtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIGZpdFNoYXJlcyhXLCBjLCBkYXRhLCB2KSB7IC8vIOS7veaVuO+8muWFiOiugOmgheebruaWuemWi+aUvuW5vuS7ve+8m+iugOS4jeWIsOWGjeiHquWLlemZjeWIsCA144CBM+OAgTLjgIExIOS7veipplxuICAgIGNvbnN0IHdzID0gZGF0YS5zbGljZSgxMCkubWF0Y2goLy57NjR9L2cpIHx8IFtdOyBpZiAoIXdzLmxlbmd0aCkgcmV0dXJuIGRhdGE7XG4gICAgbGV0IG4wID0gQmlnSW50KCcweCcgKyB3c1swXSk7IGlmIChuMCA8IDFuIHx8IG4wID4gMTAwbikgcmV0dXJuIGRhdGE7XG4gICAgY29uc3QgbGltID0gYXdhaXQgcmVhZExpbWl0KFcsIGMpLmNhdGNoKCgpID0+IG51bGwpO1xuICAgIGlmIChsaW0gIT0gbnVsbCkgeyBpZiAobGltID09PSAwbikgdGhyb3cgbmV3IEVycm9yKCfpgJnlgIvpjKLljIXnmoTpoY3luqblt7LntpPnlKjlrownKTsgaWYgKGxpbSA8IG4wKSB7IGxvZyhg6K6A5Yiw6aCF55uu5pa56ZaL5pS+5Lu95pW4ICR7bGltfe+8jOeFp+mAmeWAi+aJk++8miR7Y31gKTsgbjAgPSBsaW07IH0gfVxuICAgIGNvbnN0IG5PcmlnID0gQmlnSW50KCcweCcgKyB3c1swXSk7XG4gICAgZm9yIChjb25zdCBuIG9mIFtuMCwgLi4uWzVuLCAzbiwgMm4sIDFuXS5maWx0ZXIoKHgpID0+IHggPCBuMCldKSB7XG4gICAgICBjb25zdCBkMiA9IGRhdGEuc2xpY2UoMCwgMTApICsgdyhuKSArIHdzLnNsaWNlKDEpLmpvaW4oJycpOyBjb25zdCB2diA9IChCaWdJbnQodiB8fCAwKSAqIG4pIC8gbk9yaWc7IC8qIOWvqeafpSAxMS8x77ya5Lu95pW46ZmN5LqG77yM5LuY55qE6Yyi5Lmf6KaB5oyJ5q+U5L6L6ZmN77yI5Lul5YmN54Wn5LuY5Y6f5pys55qE6YeR6aGN77yJICovXG4gICAgICB0cnkgeyBhd2FpdCBycGMoJ2V0aF9jYWxsJywgW3sgZnJvbTogVy5hZGRyLCB0bzogYywgZGF0YTogZDIsIHZhbHVlOiAnMHgnICsgdnYudG9TdHJpbmcoMTYpIH0sICdsYXRlc3QnXSk7IGlmIChuICE9PSBuMCkgbG9nKGDku73mlbjpmY3liLAgJHtufSDku73miY3miZPlvpfkuobvvJoke2N9YCk7IHJldHVybiBkMjsgfSBjYXRjaCB7fVxuICAgIH1cbiAgICByZXR1cm4gZGF0YTtcbiAgfVxuXG4gIGNvbnN0IFJFRlVORF9TRUxTID0gWyc1OTBlMWFlMycsICdiNTU0NWEzYycsICcyNzhlY2RlMScsICc1YjdiYWY2NCcsICcxMTBmODg3NCcsICcxNmJmZTI1YycsICczOGU3NzFhYicsICdiMmQ1YWU0NCcsICdmYTg5NDAxYScsICdiZmZhNTVkNScsICc2OGVjMGQ5OScsICc3NGMxYjFjOScsICdiMzAxOTZlNScsICdjMDMzYTQ5MCcsICc0YzRhMzg2ZicsICdkMjMzZTRlYiddO1xuXG4gIGNvbnN0IHNjYWxlViA9IChkMCwgZDEsIHYpID0+IHsgLyog5Lu95pW45b6eIGQwIOeahOesrOS4gOWAi+WPg+aVuOiuiuaIkCBkMSDnmoTvvIzph5HpoY3mjInmr5Tkvovoqr/mlbQgKi8gdHJ5IHsgY29uc3QgYSA9IEJpZ0ludCgnMHgnICsgZDAuc2xpY2UoMTAsIDc0KSksIGIgPSBCaWdJbnQoJzB4JyArIGQxLnNsaWNlKDEwLCA3NCkpOyBpZiAoYSA+PSAxbiAmJiBhIDw9IDEwMG4gJiYgYiA+PSAxbiAmJiBiIDwgYSkgcmV0dXJuIChCaWdJbnQodikgKiBiKSAvIGE7IH0gY2F0Y2gge30gcmV0dXJuIEJpZ0ludCh2KTsgfTtcblxuICBhc3luYyBmdW5jdGlvbiBzYWZlQWRkcnMoVywgYywgZGF0YSwgdikge1xuICAgIGxldCB3cyA9IGRhdGEuc2xpY2UoMTApLm1hdGNoKC8uezY0fS9nKSB8fCBbXTsgY29uc3QgbWUgPSBXLmFkZHIuc2xpY2UoMikudG9Mb3dlckNhc2UoKTtcbiAgICBpZiAoVy5hZ2VudElkKSB7IGxldCBzdyA9IDA7IGZvciAobGV0IGkgPSAwOyBpIDwgd3MubGVuZ3RoOyBpKyspIHsgY29uc3QgeCA9IHdzW2ldLnRvTG93ZXJDYXNlKCk7IGlmICgvXjB7MjR9Ly50ZXN0KHgpIHx8IEJpZ0ludCgnMHgnICsgeCkgPCAybiAqKiAxMjhuIHx8IHggPT09IFcuYWdlbnRJZCkgY29udGludWU7IGNvbnN0IG8gPSBhd2FpdCBjYWxsKCcweCcgKyBSRUdJU1RSWSwgJzB4NjM1MjIxMWUnICsgeCk7IGlmIChvICYmIEJpZ0ludChvLnNsaWNlKDAsIDY2KSkgPiAwbiAmJiBvLnNsaWNlKDI2LCA2NikudG9Mb3dlckNhc2UoKSAhPT0gbWUpIHsgd3NbaV0gPSBXLmFnZW50SWQ7IHN3ID0gMTsgfSB9IGlmIChzdykgeyBkYXRhID0gZGF0YS5zbGljZSgwLCAxMCkgKyB3cy5qb2luKCcnKTsgbG9nKGDnhafmioTliY3miorliKXkurrnmoQgQWdlbnQgSUQg57eo6Jmf5o+b5oiQ6Ieq5bex55qE77yaJHtjfWApOyB9IH0gLyog54Wn5oqE55qE5Lqk5piT5bi26JGX5Yil5Lq655qEIEFnZW50IElEIOe3qOiZnyDihpIg5o+b5oiQ6Ieq5bex55qEICovXG4gICAgY29uc3Qgc2tpcCA9IG5ldyBTZXQoW21lLCBjLnNsaWNlKDIpLnRvTG93ZXJDYXNlKCksIFVTRFQuc2xpY2UoMikudG9Mb3dlckNhc2UoKSwgV0JOQi5zbGljZSgyKS50b0xvd2VyQ2FzZSgpXSk7XG4gICAgY29uc3QgaWR4ID0gd3MubWFwKCh4LCBpKSA9PiBbeC50b0xvd2VyQ2FzZSgpLCBpXSkuZmlsdGVyKChbeF0pID0+IC9eMHsyNH1bMC05YS1mXXs0MH0kLy50ZXN0KHgpICYmIHguc2xpY2UoMjQsIDMyKSAhPT0gJzAwMDAwMDAwJyAmJiAhc2tpcC5oYXMoeC5zbGljZSgyNCkpKS5tYXAoKFssIGldKSA9PiBpKTtcbiAgICBpZiAoIWlkeC5sZW5ndGgpIHJldHVybiBkYXRhO1xuICAgIGZvciAoY29uc3QgciBvZiBbbWUucGFkU3RhcnQoNjQsICcwJyksICcwJy5yZXBlYXQoNjQpXSkge1xuICAgICAgY29uc3QgZDIgPSBkYXRhLnNsaWNlKDAsIDEwKSArIHdzLm1hcCgoeCwgaSkgPT4gKGlkeC5pbmNsdWRlcyhpKSA/IHIgOiB4KSkuam9pbignJyk7XG4gICAgICB0cnkgeyBhd2FpdCBycGMoJ2V0aF9jYWxsJywgW3sgZnJvbTogVy5hZGRyLCB0bzogYywgZGF0YTogZDIsIHZhbHVlOiAnMHgnICsgQmlnSW50KHYgfHwgMCkudG9TdHJpbmcoMTYpIH0sICdsYXRlc3QnXSk7IGxvZyhg54Wn5oqE5YmN5oqK5Yil5Lq655qE5Zyw5Z2A5o+b5oiQJHtyID09PSAnMCcucmVwZWF0KDY0KSA/ICfpm7blnLDlnYAnIDogJ+iHquW3seeahOWcsOWdgCd977yaJHtjfWApOyByZXR1cm4gZDI7IH0gY2F0Y2gge31cbiAgICB9XG4gICAgdGhyb3cgbmV3IEVycm9yKCfkuqTmmJPoo6HmnInliKXkurrnmoTlnLDlnYDvvIzmj5vmiJDoh6rlt7HmiJbpm7blnLDlnYDpg73miZPkuI3kuobvvIzlronlhajotbfopovkuI3miZMnKTtcbiAgfVxuXG4gIGNvbnN0IFNPTERfU0VMUyA9IFsnYTIzMDlmZjgnLCAnZjQ1MTRkMmUnLCAnNTA1ZTA1ZmQnLCAnY2M4NGVmZWEnLCAnMTkyZmM1MTYnLCAnOTEwNmQ3YmEnLCAnNjcxNTNhYjQnLCAnZjNmOGE0ZmQnLCAnMDZlZDA3MTcnLCAnOTY1OTg2N2UnLCAnNGYwMmM0MjAnLCAnMWYyMWJmYmYnXTtcblxuICBjb25zdCBDQVBfU0VMUyA9IFsnZDhmOTM0OTgnLCAnYzY1YjYxY2EnLCAnM2E5OGVmMzknLCAnYjZiNmYwYzMnLCAnY2NlMTMyZDEnLCAnZDVhYmViMDEnLCAnMzJjYjZiMGMnLCAnMDY1MTdhMjknLCAnMjE2MzgzN2YnLCAnYWEyZDlhMDInLCAnNzZjNzFjYTEnLCAnOThmMTMxMmUnLCAnMzU1Mjc0ZWEnLCAnODVlM2Y5OTcnXTtcblxuICBhc3luYyBmdW5jdGlvbiBwcm9ncmVzc09mKGMsIGNvZGUsIHRva0FkZHIpIHtcbiAgICBsZXQgc29sZCA9IG51bGwsIGNhcCA9IG51bGw7XG4gICAgZm9yIChjb25zdCBzIG9mIFNPTERfU0VMUykgeyBpZiAoIWNvZGUuaW5jbHVkZXMocykpIGNvbnRpbnVlOyBjb25zdCByID0gYXdhaXQgY2FsbChjLCAnMHgnICsgcyk7IGlmIChyICYmIHIubGVuZ3RoID49IDY2KSB7IHNvbGQgPSBOdW1iZXIoQmlnSW50KHIuc2xpY2UoMCwgNjYpKSk7IGJyZWFrOyB9IH1cbiAgICBpZiAoc29sZCAhPSBudWxsKSBmb3IgKGNvbnN0IHMgb2YgQ0FQX1NFTFMpIHsgaWYgKCFjb2RlLmluY2x1ZGVzKHMpKSBjb250aW51ZTsgY29uc3QgciA9IGF3YWl0IGNhbGwoYywgJzB4JyArIHMpOyBpZiAociAmJiByLmxlbmd0aCA+PSA2NikgeyBjb25zdCB4ID0gTnVtYmVyKEJpZ0ludChyLnNsaWNlKDAsIDY2KSkpOyBpZiAoeCA+IDEwICYmIHggPj0gc29sZCAmJiB4IDwgMWUxMikgeyBjYXAgPSB4OyBicmVhazsgfSB9IH1cbiAgICBpZiAoc29sZCAhPSBudWxsICYmIGNhcCkgcmV0dXJuIHsgcHJvZ3Jlc3M6IHNvbGQgLyBjYXAsIHNvbGQsIGNhcCwgaG93OiAn5bey5ZSu77yP5LiK6ZmQJyB9O1xuICAgIFMucHJvZyA9IFMucHJvZyB8fCB7fTsgbGV0IHBnID0gUy5wcm9nW2NdO1xuICAgIGNvbnN0IHRvayA9IHRva0FkZHIgfHwgYztcbiAgICBpZiAoIXBnKSB7XG4gICAgICBjb25zdCBoZWFkID0gcGFyc2VJbnQoYXdhaXQgcnBjKCdldGhfYmxvY2tOdW1iZXInLCBbXSksIDE2KTtcbiAgICAgIGNvbnN0IGhhcyA9IGFzeW5jIChiKSA9PiAoKChhd2FpdCBycGMoJ2V0aF9nZXRDb2RlJywgW2MsICcweCcgKyBiLnRvU3RyaW5nKDE2KV0pLmNhdGNoKCgpID0+ICcweCcpKSB8fCAnMHgnKS5sZW5ndGggPiAyKTtcbiAgICAgIGxldCBsbyA9IGhlYWQgLSA0MDAwMDAsIGhpID0gaGVhZDsgaWYgKGF3YWl0IGhhcyhsbykpIHsgUy5wcm9nW2NdID0geyBub25lOiAxIH07IHJldHVybiB7IHByb2dyZXNzOiAwLCBzb2xkLCBjYXAgfTsgfVxuICAgICAgd2hpbGUgKGhpIC0gbG8gPiAxKSB7IGNvbnN0IG0gPSAobG8gKyBoaSkgPj4gMTsgaWYgKGF3YWl0IGhhcyhtKSkgaGkgPSBtOyBlbHNlIGxvID0gbTsgfVxuICAgICAgbGV0IGluaXQgPSAwbjsgZm9yIChjb25zdCBiIG9mIFtoaSwgaGkgKyAxLCBoaSArIDUsIGhpICsgMjBdKSB7IGNvbnN0IHIgPSBhd2FpdCBycGMoJ2V0aF9jYWxsJywgW3sgdG86IHRvaywgZGF0YTogJzB4NzBhMDgyMzEnICsgd2EoYykgfSwgJzB4JyArIGIudG9TdHJpbmcoMTYpXSkuY2F0Y2goKCkgPT4gbnVsbCk7IGlmIChyICYmIHIubGVuZ3RoID49IDY2ICYmIEJpZ0ludChyLnNsaWNlKDAsIDY2KSkgPiAwbikgeyBpbml0ID0gQmlnSW50KHIuc2xpY2UoMCwgNjYpKTsgYnJlYWs7IH0gfVxuICAgICAgcGcgPSBTLnByb2dbY10gPSBpbml0ID4gMG4gPyB7IGluaXQ6IGluaXQudG9TdHJpbmcoKSwgdG9rIH0gOiB7IG5vbmU6IDEgfTtcbiAgICB9XG4gICAgaWYgKHBnLm5vbmUpIHJldHVybiB7IHByb2dyZXNzOiAwLCBzb2xkLCBjYXAgfTtcbiAgICBjb25zdCBub3cgPSBiaWcoYXdhaXQgY2FsbChwZy50b2ssICcweDcwYTA4MjMxJyArIHdhKGMpKSk7XG4gICAgY29uc3QgaW5pdCA9IEJpZ0ludChwZy5pbml0KTsgcmV0dXJuIHsgcHJvZ3Jlc3M6IE51bWJlcihpbml0IC0gbm93KSAvIE51bWJlcihpbml0KSwgc29sZCwgY2FwLCBob3c6ICfpkYTpgKDmsaDlianppJgnIH07XG4gIH1cblxuICBmdW5jdGlvbiBmcmVzaERlYWRsaW5lKGRhdGEpIHsgLyog54Wn5oqE55qE5Lqk5piT6KOh5aaC5p6c5pyJ44CM5pyf6ZmQ44CN77yI55yL6LW35L6G5YOP5pmC6ZaT5oiz6KiY55qE5pW45a2X77yJ77yM5o+b5oiQIDE1IOWIhumQmOW+jO+8jOS4jeeEtuiIiuS6pOaYk+S4gOWumumBjuacn+WkseaVl++8iOW4geWuieaXoOW/pyAxMC8zMe+8iSAqL1xuICAgIGNvbnN0IG5vdyA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApOyBjb25zdCB3cyA9IGRhdGEuc2xpY2UoMTApLm1hdGNoKC8uezY0fS9nKSB8fCBbXTsgbGV0IGNoID0gMDtcbiAgICBjb25zdCBvdXQgPSB3cy5tYXAoKHgpID0+IHsgY29uc3QgdiA9IEJpZ0ludCgnMHgnICsgeCk7IGlmICh2ID4gQmlnSW50KG5vdyAtIDMwICogODY0MDApICYmIHYgPCBCaWdJbnQobm93ICsgMzAgKiA4NjQwMCkpIHsgY2ggPSAxOyByZXR1cm4gKEJpZ0ludChub3cgKyA5MDApKS50b1N0cmluZygxNikucGFkU3RhcnQoNjQsICcwJyk7IH0gcmV0dXJuIHg7IH0pO1xuICAgIHJldHVybiBjaCA/IGRhdGEuc2xpY2UoMCwgMTApICsgb3V0LmpvaW4oJycpIDogZGF0YTtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIGZpbmRDYXBTZWwoYywgY29kZSwgc29sZCkgeyAvKiDlvp7lkIjntITnorzmib7nhKHlj4Pmlbjlh73lvI/vvIzlm57lgrPjgIzlg4/nuL3ph4/jgI3nmoTvvIjlpKfmlrzlt7LllK7jgIHmlbTnmb7jgIHiiaQxIOWNg+iQrO+8ie+8jOWEquWFiCAxMDAwMCAqL1xuICAgIGNvbnN0IGhleCA9IFN0cmluZyhjb2RlIHx8ICcnKS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL14weC8sICcnKTsgY29uc3Qgc2VscyA9IG5ldyBTZXQoKTsgZm9yIChsZXQgaSA9IDA7IGkgPCBoZXgubGVuZ3RoIC0gMTA7IGkgKz0gMikgaWYgKGhleC5zbGljZShpLCBpICsgMikgPT09ICc2MycpIHNlbHMuYWRkKGhleC5zbGljZShpICsgMiwgaSArIDEwKSk7XG4gICAgY29uc3QgY2FuZCA9IFtdOyBmb3IgKGNvbnN0IHNlbCBvZiBbLi4uc2Vsc10uc2xpY2UoMCwgMTYwKSkgeyBjb25zdCByID0gYXdhaXQgY2FsbChjLCAnMHgnICsgc2VsKTsgaWYgKCFyIHx8IHIubGVuZ3RoICE9PSA2NikgY29udGludWU7IGNvbnN0IHYgPSBOdW1iZXIoQmlnSW50KHIpKTsgaWYgKHYgPiBzb2xkICYmIHYgPD0gMWU3ICYmIHYgJSAxMDAgPT09IDApIGNhbmQucHVzaChbc2VsLCB2XSk7IH1cbiAgICBpZiAoIWNhbmQubGVuZ3RoKSByZXR1cm4gJyc7IGNhbmQuc29ydCgoeCwgeSkgPT4gKHlbMV0gPT09IDEwMDAwKSAtICh4WzFdID09PSAxMDAwMCkgfHwgeFsxXSAtIHlbMV0pOyBsb2coYOaJvuWIsCAke2N9IOeahOe4vemHj+WHveW8jyAweCR7Y2FuZFswXVswXX0gPSAke2NhbmRbMF1bMV19YCk7IHJldHVybiBjYW5kWzBdWzBdO1xuICB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gbGVhcm5SZXBsYXkoYykgeyAvLyDlrbjliKXkurrmnIDov5HmiJDlip/nmoTpkYTpgKDvvJrmnIDluLjopovnmoTlh73lvI/jgIHopoHku5jlpJrlsJEgQk5C77yPVVNEVOOAgeacgOi/keacieW5vuWAi+mMouWMheWcqOaJk1xuICAgIGNvbnN0IGhlYWQgPSBwYXJzZUludChhd2FpdCBycGMoJ2V0aF9ibG9ja051bWJlcicsIFtdKSwgMTYpO1xuICAgIGNvbnN0IEwgPSBhd2FpdCBsb2dzUnBjKFt7IGFkZHJlc3M6IGMsIGZyb21CbG9jazogJzB4JyArIChoZWFkIC0gMTUwMCkudG9TdHJpbmcoMTYpLCB0b0Jsb2NrOiAnMHgnICsgaGVhZC50b1N0cmluZygxNikgfV0pLmNhdGNoKCgpID0+IHJwYygnZXRoX2dldExvZ3MnLCBbeyBhZGRyZXNzOiBjLCBmcm9tQmxvY2s6ICcweCcgKyAoaGVhZCAtIDE1MDApLnRvU3RyaW5nKDE2KSwgdG9CbG9jazogJ2xhdGVzdCcgfV0pLmNhdGNoKCgpID0+IFtdKSk7IC8qIOmZpOmMryAxMS8x77ya6aCQ6Kit56+A6bue5p+l5LqL5Lu25bi46KKr6ZmQ5rWB77yIbGltaXQgZXhjZWVkZWTvvInihpIg5a245LiN5Yiw5omT5rOV77yb5pS555So5aSa56+A6bue6Lyq5pu/ICovXG4gICAgY29uc3QgaHMgPSBbLi4ubmV3IFNldCgoTCB8fCBbXSkubWFwKChsKSA9PiBsLnRyYW5zYWN0aW9uSGFzaCkpXS5zbGljZSgtNDApO1xuICAgIGNvbnN0IGFsbCA9IChhd2FpdCBQcm9taXNlLmFsbChocy5tYXAoKGgpID0+IHJwYygnZXRoX2dldFRyYW5zYWN0aW9uQnlIYXNoJywgW2hdKS5jYXRjaCgoKSA9PiBudWxsKSkpKS5maWx0ZXIoKHQpID0+IHQgJiYgdC50byAmJiB0LnRvLnRvTG93ZXJDYXNlKCkgPT09IGMpO1xuICAgIGNvbnN0IHR4cyA9IGFsbC5maWx0ZXIoKHQpID0+IHQuaW5wdXQgJiYgdC5pbnB1dC5sZW5ndGggPj0gMTAgJiYgIWJhZFNlbCh0LmlucHV0KSAmJiAhdC5pbnB1dC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHQuZnJvbS5zbGljZSgyKS50b0xvd2VyQ2FzZSgpKSk7XG4gICAgeyAvKiDpmaTpjK8gMTEvMe+8mkJOQkNBVCDpgJnnqK7jgIznm7TmjqXovYkgQk5CIOWwsemRhOmAoOOAjeeahOWQiOe0hO+8jOWIpeS6uueahOS6pOaYk+aykuacieWRvOWPq+izh+aWme+8jOS7peWJjeWtuOS4jeWIsCDihpIg6YCy5bqm6YGOIDU1JSDkuZ/kuIDnm7TmspLmiZPjgILnj77lnKjlrbjjgIzlpKflrrbmnIDluLjovYnnmoTph5HpoY3jgI0gKi9cbiAgICAgIGNvbnN0IHBsYWluID0gYWxsLmZpbHRlcigodCkgPT4gKHQuaW5wdXQgfHwgJzB4JykgPT09ICcweCcgJiYgQmlnSW50KHQudmFsdWUgfHwgJzB4MCcpID4gMG4pO1xuICAgICAgaWYgKHBsYWluLmxlbmd0aCA+PSAzICYmIHBsYWluLmxlbmd0aCA+PSB0eHMubGVuZ3RoKSB7IGNvbnN0IHZjID0ge307IGZvciAoY29uc3QgdCBvZiBwbGFpbikgeyBjb25zdCB2ID0gQmlnSW50KHQudmFsdWUpLnRvU3RyaW5nKCk7IHZjW3ZdID0gKHZjW3ZdIHx8IDApICsgMTsgfSBjb25zdCB0b3AgPSBPYmplY3QuZW50cmllcyh2Yykuc29ydCgoeCwgeSkgPT4geVsxXSAtIHhbMV0pWzBdOyBjb25zdCBob3QgPSBuZXcgU2V0KHBsYWluLmZpbHRlcigodCkgPT4gcGFyc2VJbnQodC5ibG9ja051bWJlciwgMTYpID49IGhlYWQgLSA0MDApLm1hcCgodCkgPT4gdC5mcm9tLnRvTG93ZXJDYXNlKCkpKS5zaXplOyByZXR1cm4geyByZWN2OiB0b3BbMF0sIHJlY3ZTZWVuOiB0b3BbMV0sIHJlY3ZWYWxzOiBPYmplY3Qua2V5cyh2YyksIGhvdCwgbGVhcm5lZDogMSwgbGVhcm5lZEF0OiBEYXRlLm5vdygpIH07IH1cbiAgICB9XG4gICAgaWYgKCF0eHMubGVuZ3RoKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBjbnQgPSB7fTsgZm9yIChjb25zdCB0IG9mIHR4cykgY250W3QuaW5wdXQuc2xpY2UoMCwgMTApXSA9IChjbnRbdC5pbnB1dC5zbGljZSgwLCAxMCldIHx8IDApICsgMTtcbiAgICBjb25zdCBzZWwgPSBPYmplY3QuZW50cmllcyhjbnQpLnNvcnQoKGEsIGIpID0+IGJbMV0gLSBhWzFdKVswXVswXTtcbiAgICBjb25zdCBjYW5kcyA9IHR4cy5maWx0ZXIoKHQpID0+IHQuaW5wdXQuc3RhcnRzV2l0aChzZWwpKS5yZXZlcnNlKCkuc29ydCgoYSwgYikgPT4gYS5pbnB1dC5sZW5ndGggLSBiLmlucHV0Lmxlbmd0aCk7IC8vIOWEquWFiOWtuOacgOewoeWWrueahOmCo+eoru+8iOWIpeS6uuW4tuS6huiHquW3seeahCBORlQg57eo6Jmf562J6aGN5aSW5Y+D5pW455qE77yM54Wn5oqE5pyD5aSx5pWX77yJXG4gICAgZm9yIChjb25zdCBwaWNrIG9mIGNhbmRzLnNsaWNlKDAsIDMpKSB7XG4gICAgICBjb25zdCByYyA9IGF3YWl0IHJwYygnZXRoX2dldFRyYW5zYWN0aW9uUmVjZWlwdCcsIFtwaWNrLmhhc2hdKS5jYXRjaCgoKSA9PiBudWxsKTsgaWYgKCFyYyB8fCByYy5zdGF0dXMgIT09ICcweDEnKSBjb250aW51ZTtcbiAgICAgIGxldCBwYXlUb2sgPSAnJywgcGF5QW10ID0gJzAnO1xuICAgICAgZm9yIChjb25zdCBsIG9mIHJjLmxvZ3MgfHwgW10pIGlmIChsLnRvcGljcz8uWzBdID09PSBUX1RSQU5TRkVSICYmIGwudG9waWNzLmxlbmd0aCA9PT0gMyAmJiAoJzB4JyArIGwudG9waWNzWzFdLnNsaWNlKDI2KSkudG9Mb3dlckNhc2UoKSA9PT0gcGljay5mcm9tLnRvTG93ZXJDYXNlKCkpIHsgcGF5VG9rID0gbC5hZGRyZXNzLnRvTG93ZXJDYXNlKCk7IHBheUFtdCA9IEJpZ0ludChsLmRhdGEpLnRvU3RyaW5nKCk7IGJyZWFrOyB9XG4gICAgICBjb25zdCBob3QgPSBuZXcgU2V0KHR4cy5maWx0ZXIoKHQpID0+IHBhcnNlSW50KHQuYmxvY2tOdW1iZXIsIDE2KSA+PSBoZWFkIC0gNDAwKS5tYXAoKHQpID0+IHQuZnJvbS50b0xvd2VyQ2FzZSgpKSkuc2l6ZTtcbiAgICAgIHJldHVybiB7IGRhdGE6IHBpY2suaW5wdXQsIHZhbHVlOiBCaWdJbnQocGljay52YWx1ZSkudG9TdHJpbmcoKSwgcGF5VG9rLCBwYXlBbXQsIGhvdCwgbGVhcm5lZDogMSwgbGVhcm5lZEF0OiBEYXRlLm5vdygpIH07XG4gICAgfVxuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgY29uc3QgbWVtb0MgPSBuZXcgTWFwKCk7XG5cbiAgY29uc3QgY2MgPSBhc3luYyAodG8sIGRhdGEsIHR0bCA9IDYwMGUzKSA9PiB7IGNvbnN0IGsgPSB0byArIGRhdGEsIG0gPSBtZW1vQy5nZXQoayk7IGlmIChtICYmIERhdGUubm93KCkgLSBtLnQgPCB0dGwpIHJldHVybiBtLnY7IGNvbnN0IHYgPSBhd2FpdCBjYWxsKHRvLCBkYXRhKTsgbWVtb0Muc2V0KGssIHsgdiwgdDogRGF0ZS5ub3coKSB9KTsgaWYgKG1lbW9DLnNpemUgPiAyMDAwMCkgbWVtb0MuY2xlYXIoKTsgcmV0dXJuIHY7IH07XG4gIHJldHVybiB7XG4gICAgZ2V0IENBTkRTKCkgeyByZXR1cm4gQ0FORFM7IH0sXG4gICAgZ2V0IE5FQVJfRlJFRSgpIHsgcmV0dXJuIE5FQVJfRlJFRTsgfSxcbiAgICBnZXQgYmFkU2VsKCkgeyByZXR1cm4gYmFkU2VsOyB9LFxuICAgIGdldCBmdWxsQ29kZSgpIHsgcmV0dXJuIGZ1bGxDb2RlOyB9LFxuICAgIGdldCBjb2RlT2YoKSB7IHJldHVybiBjb2RlT2Y7IH0sXG4gICAgZ2V0IGZpdFNoYXJlcygpIHsgcmV0dXJuIGZpdFNoYXJlczsgfSxcbiAgICBnZXQgUkVGVU5EX1NFTFMoKSB7IHJldHVybiBSRUZVTkRfU0VMUzsgfSxcbiAgICBnZXQgc2NhbGVWKCkgeyByZXR1cm4gc2NhbGVWOyB9LFxuICAgIGdldCBzYWZlQWRkcnMoKSB7IHJldHVybiBzYWZlQWRkcnM7IH0sXG4gICAgZ2V0IGZwQ2FjaGUoKSB7IHJldHVybiBmcENhY2hlOyB9LFxuICAgIGdldCBmcmVlUHJvZ3Jlc3MoKSB7IHJldHVybiBmcmVlUHJvZ3Jlc3M7IH0sXG4gICAgZ2V0IHByb2dyZXNzT2YoKSB7IHJldHVybiBwcm9ncmVzc09mOyB9LFxuICAgIGdldCBmcmVzaERlYWRsaW5lKCkgeyByZXR1cm4gZnJlc2hEZWFkbGluZTsgfSxcbiAgICBnZXQgZmluZENhcFNlbCgpIHsgcmV0dXJuIGZpbmRDYXBTZWw7IH0sXG4gICAgZ2V0IGxlYXJuUmVwbGF5KCkgeyByZXR1cm4gbGVhcm5SZXBsYXk7IH0sXG4gICAgZ2V0IGNjKCkgeyByZXR1cm4gY2M7IH0sXG4gICAgZ2V0IGZpbmRGcmVlKCkgeyByZXR1cm4gZmluZEZyZWU7IH0sXG4gIH07XG59XG4iXSwibWFwcGluZ3MiOiJBQUFBOztBQUVBLE9BQU8sU0FBU0EsZUFBZUEsQ0FBQ0MsWUFBWSxFQUFFO0VBQzVDLE1BQU07SUFBRUMsUUFBUTtJQUFFQyxDQUFDO0lBQUVDLFVBQVU7SUFBRUMsSUFBSTtJQUFFQyxPQUFPO0lBQUVDLElBQUk7SUFBRUMsR0FBRztJQUFFQyxJQUFJO0lBQUVDLEdBQUc7SUFBRUMsT0FBTztJQUFFQyxHQUFHO0lBQUVDLENBQUM7SUFBRUM7RUFBRyxDQUFDLEdBQUdiLFlBQVk7RUFDMUcsTUFBTWMsS0FBSyxHQUFHLENBQUMsQ0FBQyxRQUFRLEVBQUUsWUFBWSxDQUFDLEVBQUUsQ0FBQyxZQUFZLEVBQUUsWUFBWSxDQUFDLEVBQUUsQ0FBQyxTQUFTLEVBQUUsWUFBWSxDQUFDLEVBQUUsQ0FBQyxTQUFTLEVBQUUsWUFBWSxHQUFHRixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLGNBQWMsRUFBRSxZQUFZLENBQUMsRUFBRSxDQUFDLGtCQUFrQixFQUFFLFlBQVksQ0FBQyxFQUFFLENBQUMsc0JBQXNCLEVBQUUsWUFBWSxDQUFDLEVBQUUsQ0FBQyxhQUFhLEVBQUUsWUFBWSxHQUFHQSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLFVBQVUsRUFBRSxZQUFZLEdBQUdBLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsWUFBWSxFQUFFLFlBQVksQ0FBQyxFQUFFLENBQUMsYUFBYSxFQUFFLFlBQVksQ0FBQyxFQUFFLENBQUMsYUFBYSxFQUFFLFlBQVksQ0FBQyxDQUFDO0VBRXBaLGVBQWVHLFFBQVFBLENBQUNDLENBQUMsRUFBRUMsSUFBSSxFQUFFO0lBQUU7SUFDakNBLElBQUksR0FBR0MsTUFBTSxDQUFDRCxJQUFJLElBQUksRUFBRSxDQUFDLENBQUNFLFdBQVcsQ0FBQyxDQUFDO0lBQUUsSUFBSUYsSUFBSSxDQUFDRyxNQUFNLEdBQUcsQ0FBQyxJQUFJSCxJQUFJLENBQUNHLE1BQU0sSUFBSSxJQUFJLElBQUlILElBQUksQ0FBQ0ksUUFBUSxDQUFDcEIsUUFBUSxDQUFDLEVBQUUsT0FBT2dCLElBQUk7SUFDM0gsTUFBTUssR0FBRyxHQUFHLE1BQU9DLENBQUMsSUFBSztNQUFFLE1BQU1DLENBQUMsR0FBRyxDQUFDLENBQUMsTUFBTWIsR0FBRyxDQUFDLGFBQWEsRUFBRSxDQUFDWSxDQUFDLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQ0UsS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDLEtBQUssRUFBRSxFQUFFTixXQUFXLENBQUMsQ0FBQztNQUFFRixJQUFJLElBQUlPLENBQUM7TUFBRSxPQUFPQSxDQUFDO0lBQUUsQ0FBQztJQUM1SSxJQUFJO01BQUUsTUFBTUUsSUFBSSxHQUFHLE1BQU1mLEdBQUcsQ0FBQyxrQkFBa0IsRUFBRSxDQUFDSyxDQUFDLEVBQUUsb0VBQW9FLEVBQUUsUUFBUSxDQUFDLENBQUM7TUFBRSxJQUFJVSxJQUFJLElBQUlDLE1BQU0sQ0FBQ0QsSUFBSSxDQUFDLEtBQUssRUFBRSxFQUFFLE1BQU1KLEdBQUcsQ0FBQyxJQUFJLEdBQUdJLElBQUksQ0FBQ0UsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUM7SUFBRSxDQUFDLENBQUMsTUFBTSxDQUFDO0lBQ3BOLElBQUk7TUFBRSxNQUFNQyxFQUFFLEdBQUcsTUFBTWxCLEdBQUcsQ0FBQyxrQkFBa0IsRUFBRSxDQUFDSyxDQUFDLEVBQUUsb0VBQW9FLEVBQUUsUUFBUSxDQUFDLENBQUM7TUFBRSxJQUFJYSxFQUFFLElBQUlGLE1BQU0sQ0FBQ0UsRUFBRSxDQUFDLEtBQUssRUFBRSxFQUFFO1FBQUUsTUFBTUMsQ0FBQyxHQUFHLE1BQU10QixJQUFJLENBQUMsSUFBSSxHQUFHcUIsRUFBRSxDQUFDRCxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxZQUFZLENBQUM7UUFBRSxJQUFJRSxDQUFDLElBQUlILE1BQU0sQ0FBQ0csQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLE1BQU1SLEdBQUcsQ0FBQyxJQUFJLEdBQUdRLENBQUMsQ0FBQ0YsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUM7TUFBRTtJQUFFLENBQUMsQ0FBQyxNQUFNLENBQUM7SUFDcFMsTUFBTUcsSUFBSSxHQUFHLEVBQUU7SUFBRTtNQUFFLE1BQU1DLENBQUMsR0FBR2YsSUFBSSxDQUFDZ0IsT0FBTyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQ0wsS0FBSyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUM7TUFBRSxNQUFNTSxLQUFLLEdBQUdGLENBQUMsQ0FBQ0csS0FBSyxDQUFDLHlDQUF5QyxDQUFDO01BQUUsSUFBSUQsS0FBSyxFQUFFSCxJQUFJLENBQUNLLElBQUksQ0FBQyxJQUFJLEdBQUdGLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztNQUFFLEtBQUssSUFBSUcsQ0FBQyxHQUFHLENBQUMsRUFBRUEsQ0FBQyxHQUFHLEVBQUUsSUFBSUwsQ0FBQyxDQUFDWixNQUFNLEVBQUVpQixDQUFDLElBQUksQ0FBQyxFQUFFO1FBQUUsTUFBTUMsRUFBRSxHQUFHTixDQUFDLENBQUNKLEtBQUssQ0FBQ1MsQ0FBQyxFQUFFQSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQUUsSUFBSUMsRUFBRSxLQUFLLElBQUksRUFBRTtVQUFFUCxJQUFJLENBQUNLLElBQUksQ0FBQyxJQUFJLEdBQUdKLENBQUMsQ0FBQ0osS0FBSyxDQUFDUyxDQUFDLEdBQUcsQ0FBQyxFQUFFQSxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUM7VUFBRUEsQ0FBQyxJQUFJLEVBQUU7UUFBRSxDQUFDLE1BQU0sSUFBSUMsRUFBRSxLQUFLLElBQUksRUFBRTtVQUFFLE1BQU1DLEVBQUUsR0FBR1AsQ0FBQyxDQUFDSixLQUFLLENBQUNTLENBQUMsR0FBRyxDQUFDLEVBQUVBLENBQUMsR0FBRyxFQUFFLENBQUM7VUFBRSxJQUFJLFFBQVEsQ0FBQ0csSUFBSSxDQUFDRCxFQUFFLENBQUMsRUFBRVIsSUFBSSxDQUFDSyxJQUFJLENBQUMsSUFBSSxHQUFHRyxFQUFFLENBQUNYLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQztVQUFFUyxDQUFDLElBQUksRUFBRTtRQUFFLENBQUMsTUFBTTtVQUFFLE1BQU1JLENBQUMsR0FBR0MsUUFBUSxDQUFDSixFQUFFLEVBQUUsRUFBRSxDQUFDO1VBQUUsSUFBSUcsQ0FBQyxJQUFJLElBQUksSUFBSUEsQ0FBQyxJQUFJLElBQUksRUFBRUosQ0FBQyxJQUFJLENBQUNJLENBQUMsR0FBRyxJQUFJLElBQUksQ0FBQztRQUFFO01BQUU7SUFBRSxDQUFDLENBQUM7SUFDemhCLE1BQU1FLEdBQUcsR0FBRyxDQUFDLEdBQUcsSUFBSUMsR0FBRyxDQUFDYixJQUFJLENBQUMsQ0FBQyxDQUFDYyxNQUFNLENBQUV0QixDQUFDLElBQUssQ0FBQyxXQUFXLENBQUNpQixJQUFJLENBQUNqQixDQUFDLENBQUMsSUFBSUEsQ0FBQyxDQUFDSCxNQUFNLEtBQUssRUFBRSxDQUFDLENBQUNRLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQ2pHLEtBQUssTUFBTUwsQ0FBQyxJQUFJb0IsR0FBRyxFQUFFO01BQUUsSUFBSTFCLElBQUksQ0FBQ0ksUUFBUSxDQUFDcEIsUUFBUSxDQUFDLEVBQUU7TUFBTyxNQUFNNkIsQ0FBQyxHQUFHLE1BQU10QixJQUFJLENBQUNlLENBQUMsRUFBRSxZQUFZLENBQUM7TUFBRSxJQUFJTyxDQUFDLElBQUlBLENBQUMsQ0FBQ1YsTUFBTSxJQUFJLEVBQUUsSUFBSU8sTUFBTSxDQUFDRyxDQUFDLENBQUNGLEtBQUssQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsTUFBTU4sR0FBRyxDQUFDLElBQUksR0FBR1EsQ0FBQyxDQUFDRixLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEtBQU0sTUFBTU4sR0FBRyxDQUFDQyxDQUFDLENBQUM7SUFBRTtJQUMvTSxPQUFPTixJQUFJO0VBQ2I7RUFFQSxNQUFNNkIsU0FBUyxHQUFHLENBQUMsRUFBRSxFQUFFLEdBQUcsSUFBSSxHQUFHLEVBQUUsR0FBRyxHQUFHLEdBQUcsSUFBSSxHQUFHLEVBQUUsRUFBRSxHQUFHLEdBQUcsSUFBSSxHQUFHLEVBQUUsRUFBRSxHQUFHLEdBQUcsSUFBSSxHQUFHLEVBQUUsR0FBRyxJQUFJLEdBQUcsQ0FBQztFQUVsRyxlQUFlQyxRQUFRQSxDQUFDQyxJQUFJLEVBQUVoQyxDQUFDLEVBQUVDLElBQUksRUFBRTtJQUNyQyxLQUFLLE1BQU0sQ0FBQ3dCLENBQUMsRUFBRVEsQ0FBQyxDQUFDLElBQUluQyxLQUFLLEVBQUU7TUFBRSxJQUFJMkIsQ0FBQyxDQUFDcEIsUUFBUSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUNvQixDQUFDLENBQUNTLFFBQVEsQ0FBQyxHQUFHLEdBQUdsQyxDQUFDLENBQUNZLEtBQUssQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsRUFBRTtNQUFVLElBQUlhLENBQUMsQ0FBQ3BCLFFBQVEsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDb0IsQ0FBQyxDQUFDcEIsUUFBUSxDQUFDLEdBQUcsSUFBSWhCLE9BQU8sQ0FBQzhDLElBQUksQ0FBRTNCLENBQUMsSUFBS0EsQ0FBQyxDQUFDNEIsSUFBSSxLQUFLSixJQUFJLENBQUMsRUFBRUssSUFBSSxJQUFJLEdBQUcsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxFQUFFO01BQVUsSUFBSUosQ0FBQyxDQUFDN0IsTUFBTSxHQUFHLEVBQUUsSUFBSWtDLE1BQU0sQ0FBQ0wsQ0FBQyxDQUFDLElBQUksQ0FBQ2hDLElBQUksQ0FBQ0ksUUFBUSxDQUFDNEIsQ0FBQyxDQUFDckIsS0FBSyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxFQUFFLFNBQVMsQ0FBQztNQUF5QixNQUFNMkIsRUFBRSxHQUFHLFNBQVMsQ0FBQ2YsSUFBSSxDQUFDQyxDQUFDLENBQUMsR0FBR2UsYUFBYSxDQUFDUCxDQUFDLENBQUMsR0FBR0EsQ0FBQztNQUFFLEtBQUssTUFBTVEsQ0FBQyxJQUFJWCxTQUFTLEVBQUU7UUFBRSxJQUFJO1VBQUUsTUFBTW5DLEdBQUcsQ0FBQyxVQUFVLEVBQUUsQ0FBQztZQUFFcUMsSUFBSTtZQUFFVSxFQUFFLEVBQUUxQyxDQUFDO1lBQUUyQyxJQUFJLEVBQUVKLEVBQUU7WUFBRUssS0FBSyxFQUFFLElBQUksR0FBR0gsQ0FBQyxDQUFDSSxRQUFRLENBQUMsRUFBRTtVQUFFLENBQUMsRUFBRSxRQUFRLENBQUMsQ0FBQztVQUFFLE9BQU87WUFBRXBCLENBQUM7WUFBRWdCO1VBQUUsQ0FBQztRQUFFLENBQUMsQ0FBQyxNQUFNLENBQUM7TUFBRTtJQUFFO0lBQ3hnQixNQUFNSyxFQUFFLEdBQUd6RCxPQUFPLENBQUM4QyxJQUFJLENBQUUzQixDQUFDLElBQUtBLENBQUMsQ0FBQzRCLElBQUksS0FBS0osSUFBSSxDQUFDLENBQUMsQ0FBQztJQUNqRCxJQUFJYyxFQUFFLEVBQUVDLE9BQU8sRUFBRSxLQUFLLE1BQU1DLEdBQUcsSUFBSSxDQUFDLFVBQVUsRUFBRSxVQUFVLEVBQUUsVUFBVSxDQUFDLEVBQUU7TUFBRSxJQUFJLENBQUMvQyxJQUFJLENBQUNJLFFBQVEsQ0FBQzJDLEdBQUcsQ0FBQyxFQUFFO01BQVUsTUFBTWYsQ0FBQyxHQUFHLElBQUksR0FBR2UsR0FBRyxHQUFHRixFQUFFLENBQUNDLE9BQU87UUFBRXRCLENBQUMsR0FBRyxXQUFXdUIsR0FBRyxJQUFJRixFQUFFLENBQUNULElBQUksSUFBSXJDLENBQUMsQ0FBQ1ksS0FBSyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsRUFBRTtNQUFFLEtBQUssTUFBTTZCLENBQUMsSUFBSVgsU0FBUyxFQUFFO1FBQUUsSUFBSTtVQUFFLE1BQU1uQyxHQUFHLENBQUMsVUFBVSxFQUFFLENBQUM7WUFBRXFDLElBQUk7WUFBRVUsRUFBRSxFQUFFMUMsQ0FBQztZQUFFMkMsSUFBSSxFQUFFVixDQUFDO1lBQUVXLEtBQUssRUFBRSxJQUFJLEdBQUdILENBQUMsQ0FBQ0ksUUFBUSxDQUFDLEVBQUU7VUFBRSxDQUFDLEVBQUUsUUFBUSxDQUFDLENBQUM7VUFBRSxJQUFJLENBQUMvQyxLQUFLLENBQUNtRCxJQUFJLENBQUV6QyxDQUFDLElBQUtBLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBS2lCLENBQUMsQ0FBQyxFQUFFM0IsS0FBSyxDQUFDc0IsSUFBSSxDQUFDLENBQUNLLENBQUMsRUFBRVEsQ0FBQyxDQUFDLENBQUM7VUFBRSxPQUFPO1lBQUVSLENBQUM7WUFBRWdCO1VBQUUsQ0FBQztRQUFFLENBQUMsQ0FBQyxNQUFNLENBQUM7TUFBRTtJQUFFO0lBQ3haLE9BQU8sSUFBSTtFQUNiO0VBRUEsTUFBTVMsT0FBTyxHQUFHLElBQUl0QixHQUFHLENBQUMsQ0FBQyxZQUFZLEVBQUUsWUFBWSxFQUFFLFlBQVksRUFBRSxZQUFZLEVBQUUsWUFBWSxFQUFFLFlBQVksRUFBRSxZQUFZLEVBQUUsWUFBWSxFQUFFLFlBQVksRUFBRSxZQUFZLENBQUMsQ0FBQztFQUVySyxNQUFNVSxNQUFNLEdBQUlMLENBQUMsSUFBS2lCLE9BQU8sQ0FBQ0MsR0FBRyxDQUFDakQsTUFBTSxDQUFDK0IsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDckIsS0FBSyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQ1QsV0FBVyxDQUFDLENBQUMsQ0FBQztFQUU3RSxNQUFNaUQsT0FBTyxHQUFHLElBQUlDLEdBQUcsQ0FBQyxDQUFDO0VBRXpCLGVBQWVDLFlBQVlBLENBQUN0RCxDQUFDLEVBQUU7SUFBRTtJQUMvQixNQUFNdUQsQ0FBQyxHQUFHSCxPQUFPLENBQUNJLEdBQUcsQ0FBQ3hELENBQUMsQ0FBQztJQUFFLElBQUl1RCxDQUFDLElBQUlFLElBQUksQ0FBQ0MsR0FBRyxDQUFDLENBQUMsR0FBR0gsQ0FBQyxDQUFDSSxDQUFDLEdBQUcsSUFBSSxFQUFFLE9BQU9KLENBQUMsQ0FBQ0ssQ0FBQztJQUN0RSxJQUFJQSxDQUFDLEdBQUcsSUFBSTtJQUFFLE1BQU1DLElBQUksR0FBRyxNQUFNckUsSUFBSSxDQUFDUSxDQUFDLEVBQUUsWUFBWSxDQUFDO0lBQUUsTUFBTThELE9BQU8sR0FBRyxDQUFDLEVBQUVELElBQUksSUFBSUEsSUFBSSxDQUFDekQsTUFBTSxJQUFJLEVBQUUsSUFBSU8sTUFBTSxDQUFDa0QsSUFBSSxDQUFDakQsS0FBSyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxHQUFHLEVBQUUsSUFBSUQsTUFBTSxDQUFDa0QsSUFBSSxDQUFDakQsS0FBSyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxDQUFDLENBQUM7SUFDN0ssTUFBTW1ELEdBQUcsR0FBR0QsT0FBTyxHQUFHLElBQUksR0FBRyxNQUFNdEUsSUFBSSxDQUFDUSxDQUFDLEVBQUUsWUFBWSxDQUFDLENBQUMsQ0FBQztJQUMxRCxNQUFNZ0UsR0FBRyxHQUFHRixPQUFPLEdBQUcsSUFBSSxHQUFJQyxHQUFHLElBQUlBLEdBQUcsQ0FBQzNELE1BQU0sSUFBSSxFQUFFLEdBQUcyRCxHQUFHLEdBQUcsTUFBTXZFLElBQUksQ0FBQ1EsQ0FBQyxFQUFFLFlBQVksQ0FBRTtJQUMxRixJQUFJZ0UsR0FBRyxJQUFJQSxHQUFHLENBQUM1RCxNQUFNLElBQUksRUFBRSxFQUFFO01BQUUsTUFBTTZELEdBQUcsR0FBR0MsTUFBTSxDQUFDdkQsTUFBTSxDQUFDcUQsR0FBRyxDQUFDcEQsS0FBSyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDO01BQUUsS0FBSyxNQUFNb0MsR0FBRyxJQUFJLENBQUMsWUFBWSxFQUFFLFlBQVksRUFBRSxZQUFZLEVBQUUsWUFBWSxFQUFFLFlBQVksRUFBRSxZQUFZLEVBQUUsWUFBWSxDQUFDLEVBQUU7UUFBRSxNQUFNbEMsQ0FBQyxHQUFHLE1BQU10QixJQUFJLENBQUNRLENBQUMsRUFBRWdELEdBQUcsQ0FBQztRQUFFLElBQUlsQyxDQUFDLElBQUlBLENBQUMsQ0FBQ1YsTUFBTSxJQUFJLEVBQUUsRUFBRTtVQUFFLE1BQU1JLENBQUMsR0FBRzBELE1BQU0sQ0FBQ3ZELE1BQU0sQ0FBQ0csQ0FBQyxDQUFDRixLQUFLLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUM7VUFBRSxJQUFJSixDQUFDLEdBQUcsQ0FBQyxJQUFJQSxDQUFDLElBQUl5RCxHQUFHLElBQUl6RCxDQUFDLEdBQUcsSUFBSSxFQUFFO1lBQUVvRCxDQUFDLEdBQUdLLEdBQUcsR0FBR3pELENBQUM7WUFBRTtVQUFPO1FBQUU7TUFBRTtJQUFFO0lBQ3ZXLElBQUlvRCxDQUFDLElBQUksSUFBSSxFQUFFO01BQUUsTUFBTTNELElBQUksR0FBRyxDQUFDLE1BQU1OLEdBQUcsQ0FBQyxhQUFhLEVBQUUsQ0FBQ0ssQ0FBQyxFQUFFLFFBQVEsQ0FBQyxDQUFDLENBQUNTLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQyxLQUFLLEVBQUU7TUFBRSxNQUFNMEQsRUFBRSxHQUFHLE1BQU1DLFVBQVUsQ0FBQ3BFLENBQUMsRUFBRUMsSUFBSSxDQUFDRSxXQUFXLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDTSxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDO01BQUUsSUFBSTBELEVBQUUsQ0FBQ0UsUUFBUSxHQUFHLENBQUMsRUFBRVQsQ0FBQyxHQUFHTyxFQUFFLENBQUNFLFFBQVE7SUFBRTtJQUMvTWpCLE9BQU8sQ0FBQ2tCLEdBQUcsQ0FBQ3RFLENBQUMsRUFBRTtNQUFFMkQsQ0FBQyxFQUFFRixJQUFJLENBQUNDLEdBQUcsQ0FBQyxDQUFDO01BQUVFO0lBQUUsQ0FBQyxDQUFDO0lBQUUsT0FBT0EsQ0FBQztFQUNoRDtFQUVBLE1BQU1XLFNBQVMsR0FBRyxJQUFJbEIsR0FBRyxDQUFDLENBQUM7RUFFM0IsZUFBZW1CLE1BQU1BLENBQUNqRSxDQUFDLEVBQUU7SUFBRSxJQUFJLENBQUNnRSxTQUFTLENBQUNwQixHQUFHLENBQUM1QyxDQUFDLENBQUMsRUFBRWdFLFNBQVMsQ0FBQ0QsR0FBRyxDQUFDL0QsQ0FBQyxFQUFFLENBQUMsQ0FBQyxNQUFNWixHQUFHLENBQUMsYUFBYSxFQUFFLENBQUNZLENBQUMsRUFBRSxRQUFRLENBQUMsQ0FBQyxDQUFDRSxLQUFLLENBQUMsTUFBTSxFQUFFLENBQUMsS0FBSyxFQUFFLEVBQUVOLFdBQVcsQ0FBQyxDQUFDLENBQUM7SUFBRSxPQUFPb0UsU0FBUyxDQUFDZixHQUFHLENBQUNqRCxDQUFDLENBQUM7RUFBRTtFQUU5SyxlQUFla0UsU0FBU0EsQ0FBQ0MsQ0FBQyxFQUFFMUUsQ0FBQyxFQUFFO0lBQzdCLE1BQU1DLElBQUksR0FBRyxDQUFDLENBQUMsTUFBTXVFLE1BQU0sQ0FBQ3hFLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRUcsV0FBVyxDQUFDLENBQUM7SUFBRSxNQUFNZ0QsR0FBRyxHQUFJd0IsQ0FBQyxJQUFLMUUsSUFBSSxDQUFDSSxRQUFRLENBQUNzRSxDQUFDLENBQUM7SUFBRSxNQUFNQyxHQUFHLEdBQUk5RCxDQUFDLElBQU1BLENBQUMsSUFBSUEsQ0FBQyxDQUFDVixNQUFNLElBQUksRUFBRSxHQUFHTyxNQUFNLENBQUNHLENBQUMsQ0FBQ0YsS0FBSyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxHQUFHLElBQUs7SUFBRSxNQUFNaUUsRUFBRSxHQUFHaEYsRUFBRSxDQUFDNkUsQ0FBQyxDQUFDdEMsSUFBSSxDQUFDO0lBQUUsTUFBTTBDLEdBQUcsR0FBRyxFQUFFO0lBQzFNLEtBQUssTUFBTUgsQ0FBQyxJQUFJLENBQUMsVUFBVSxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsVUFBVSxDQUFDLEVBQUUsSUFBSXhCLEdBQUcsQ0FBQ3dCLENBQUMsQ0FBQyxFQUFFO01BQUUsTUFBTW5FLENBQUMsR0FBR29FLEdBQUcsQ0FBQyxNQUFNcEYsSUFBSSxDQUFDUSxDQUFDLEVBQUUsSUFBSSxHQUFHMkUsQ0FBQyxHQUFHRSxFQUFFLENBQUMsQ0FBQztNQUFFLElBQUlyRSxDQUFDLElBQUksSUFBSSxJQUFJQSxDQUFDLEdBQUcsUUFBUSxFQUFFO1FBQUVzRSxHQUFHLENBQUMxRCxJQUFJLENBQUNaLENBQUMsQ0FBQztRQUFFO01BQU87SUFBRTtJQUNwTCxJQUFJdUUsR0FBRyxHQUFHLElBQUk7SUFBRSxLQUFLLE1BQU1KLENBQUMsSUFBSSxDQUFDLFVBQVUsRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLFVBQVUsQ0FBQyxFQUFFLElBQUl4QixHQUFHLENBQUN3QixDQUFDLENBQUMsRUFBRTtNQUFFLE1BQU1uRSxDQUFDLEdBQUdvRSxHQUFHLENBQUMsTUFBTXBGLElBQUksQ0FBQ1EsQ0FBQyxFQUFFLElBQUksR0FBRzJFLENBQUMsQ0FBQyxDQUFDO01BQUUsSUFBSW5FLENBQUMsSUFBSSxJQUFJLElBQUlBLENBQUMsR0FBRyxFQUFFLElBQUlBLENBQUMsR0FBRyxRQUFRLEVBQUU7UUFBRXVFLEdBQUcsR0FBR3ZFLENBQUM7UUFBRTtNQUFPO0lBQUU7SUFDek8sSUFBSXVFLEdBQUcsSUFBSSxJQUFJLEVBQUUsS0FBSyxNQUFNSixDQUFDLElBQUksQ0FBQyxVQUFVLEVBQUUsVUFBVSxDQUFDLEVBQUUsSUFBSXhCLEdBQUcsQ0FBQ3dCLENBQUMsQ0FBQyxFQUFFO01BQUUsTUFBTW5FLENBQUMsR0FBR29FLEdBQUcsQ0FBQyxNQUFNcEYsSUFBSSxDQUFDUSxDQUFDLEVBQUUsSUFBSSxHQUFHMkUsQ0FBQyxHQUFHRSxFQUFFLENBQUMsQ0FBQztNQUFFLElBQUlyRSxDQUFDLElBQUksSUFBSSxJQUFJQSxDQUFDLEdBQUcsRUFBRSxJQUFJQSxDQUFDLEdBQUcsUUFBUSxFQUFFO1FBQUV1RSxHQUFHLEdBQUd2RSxDQUFDO1FBQUU7TUFBTztJQUFFO0lBQ25MLElBQUl1RSxHQUFHLElBQUksSUFBSSxFQUFFO01BQUUsSUFBSUMsSUFBSSxHQUFHLEVBQUU7TUFBRSxLQUFLLE1BQU1MLENBQUMsSUFBSSxDQUFDLFVBQVUsRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsVUFBVSxDQUFDLEVBQUUsSUFBSXhCLEdBQUcsQ0FBQ3dCLENBQUMsQ0FBQyxFQUFFO1FBQUUsTUFBTW5FLENBQUMsR0FBR29FLEdBQUcsQ0FBQyxNQUFNcEYsSUFBSSxDQUFDUSxDQUFDLEVBQUUsSUFBSSxHQUFHMkUsQ0FBQyxHQUFHRSxFQUFFLENBQUMsQ0FBQztRQUFFLElBQUlyRSxDQUFDLElBQUksSUFBSSxJQUFJQSxDQUFDLEdBQUcsUUFBUSxFQUFFO1VBQUV3RSxJQUFJLEdBQUd4RSxDQUFDO1VBQUU7UUFBTztNQUFFO01BQUVzRSxHQUFHLENBQUMxRCxJQUFJLENBQUMyRCxHQUFHLEdBQUdDLElBQUksR0FBR0QsR0FBRyxHQUFHQyxJQUFJLEdBQUcsRUFBRSxDQUFDO0lBQUU7SUFDclIsS0FBSyxNQUFNTCxDQUFDLElBQUksQ0FBQyxVQUFVLEVBQUUsVUFBVSxFQUFFLFVBQVUsQ0FBQyxFQUFFLElBQUl4QixHQUFHLENBQUN3QixDQUFDLENBQUMsRUFBRTtNQUFFLE1BQU1uRSxDQUFDLEdBQUdvRSxHQUFHLENBQUMsTUFBTXBGLElBQUksQ0FBQ1EsQ0FBQyxFQUFFLElBQUksR0FBRzJFLENBQUMsQ0FBQyxDQUFDO01BQUUsSUFBSW5FLENBQUMsSUFBSSxJQUFJLElBQUlBLENBQUMsR0FBRyxFQUFFLElBQUlBLENBQUMsR0FBRyxRQUFRLEVBQUU7UUFBRXNFLEdBQUcsQ0FBQzFELElBQUksQ0FBQ1osQ0FBQyxDQUFDO1FBQUU7TUFBTztJQUFFO0lBQzdLLE9BQU9zRSxHQUFHLENBQUMxRSxNQUFNLEdBQUcwRSxHQUFHLENBQUNHLE1BQU0sQ0FBQyxDQUFDMUUsQ0FBQyxFQUFFMkUsQ0FBQyxLQUFNQSxDQUFDLEdBQUczRSxDQUFDLEdBQUcyRSxDQUFDLEdBQUczRSxDQUFFLENBQUMsR0FBRyxJQUFJO0VBQ2xFO0VBRUEsZUFBZTRFLFNBQVNBLENBQUNULENBQUMsRUFBRTFFLENBQUMsRUFBRTJDLElBQUksRUFBRUYsQ0FBQyxFQUFFO0lBQUU7SUFDeEMsTUFBTTJDLEVBQUUsR0FBR3pDLElBQUksQ0FBQy9CLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQ08sS0FBSyxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUU7SUFBRSxJQUFJLENBQUNpRSxFQUFFLENBQUNoRixNQUFNLEVBQUUsT0FBT3VDLElBQUk7SUFDNUUsSUFBSTBDLEVBQUUsR0FBRzFFLE1BQU0sQ0FBQyxJQUFJLEdBQUd5RSxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFBRSxJQUFJQyxFQUFFLEdBQUcsRUFBRSxJQUFJQSxFQUFFLEdBQUcsSUFBSSxFQUFFLE9BQU8xQyxJQUFJO0lBQ3BFLE1BQU1tQyxHQUFHLEdBQUcsTUFBTUwsU0FBUyxDQUFDQyxDQUFDLEVBQUUxRSxDQUFDLENBQUMsQ0FBQ1MsS0FBSyxDQUFDLE1BQU0sSUFBSSxDQUFDO0lBQ25ELElBQUlxRSxHQUFHLElBQUksSUFBSSxFQUFFO01BQUUsSUFBSUEsR0FBRyxLQUFLLEVBQUUsRUFBRSxNQUFNLElBQUlRLEtBQUssQ0FBQyxhQUFhLENBQUM7TUFBRSxJQUFJUixHQUFHLEdBQUdPLEVBQUUsRUFBRTtRQUFFNUYsR0FBRyxDQUFDLGFBQWFxRixHQUFHLFNBQVM5RSxDQUFDLEVBQUUsQ0FBQztRQUFFcUYsRUFBRSxHQUFHUCxHQUFHO01BQUU7SUFBRTtJQUNsSSxNQUFNUyxLQUFLLEdBQUc1RSxNQUFNLENBQUMsSUFBSSxHQUFHeUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ2xDLEtBQUssTUFBTTNELENBQUMsSUFBSSxDQUFDNEQsRUFBRSxFQUFFLEdBQUcsQ0FBQyxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLENBQUMsQ0FBQ3hELE1BQU0sQ0FBRXJCLENBQUMsSUFBS0EsQ0FBQyxHQUFHNkUsRUFBRSxDQUFDLENBQUMsRUFBRTtNQUMvRCxNQUFNRyxFQUFFLEdBQUc3QyxJQUFJLENBQUMvQixLQUFLLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxHQUFHaEIsQ0FBQyxDQUFDNkIsQ0FBQyxDQUFDLEdBQUcyRCxFQUFFLENBQUN4RSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM2RSxJQUFJLENBQUMsRUFBRSxDQUFDO01BQUUsTUFBTUMsRUFBRSxHQUFJL0UsTUFBTSxDQUFDOEIsQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHaEIsQ0FBQyxHQUFJOEQsS0FBSyxDQUFDLENBQUM7TUFDckcsSUFBSTtRQUFFLE1BQU01RixHQUFHLENBQUMsVUFBVSxFQUFFLENBQUM7VUFBRXFDLElBQUksRUFBRTBDLENBQUMsQ0FBQ3RDLElBQUk7VUFBRU0sRUFBRSxFQUFFMUMsQ0FBQztVQUFFMkMsSUFBSSxFQUFFNkMsRUFBRTtVQUFFNUMsS0FBSyxFQUFFLElBQUksR0FBRzhDLEVBQUUsQ0FBQzdDLFFBQVEsQ0FBQyxFQUFFO1FBQUUsQ0FBQyxFQUFFLFFBQVEsQ0FBQyxDQUFDO1FBQUUsSUFBSXBCLENBQUMsS0FBSzRELEVBQUUsRUFBRTVGLEdBQUcsQ0FBQyxRQUFRZ0MsQ0FBQyxVQUFVekIsQ0FBQyxFQUFFLENBQUM7UUFBRSxPQUFPd0YsRUFBRTtNQUFFLENBQUMsQ0FBQyxNQUFNLENBQUM7SUFDNUs7SUFDQSxPQUFPN0MsSUFBSTtFQUNiO0VBRUEsTUFBTWdELFdBQVcsR0FBRyxDQUFDLFVBQVUsRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLFVBQVUsQ0FBQztFQUVwTixNQUFNQyxNQUFNLEdBQUdBLENBQUNDLEVBQUUsRUFBRUMsRUFBRSxFQUFFckQsQ0FBQyxLQUFLO0lBQUUsa0NBQW1DLElBQUk7TUFBRSxNQUFNbEMsQ0FBQyxHQUFHSSxNQUFNLENBQUMsSUFBSSxHQUFHa0YsRUFBRSxDQUFDakYsS0FBSyxDQUFDLEVBQUUsRUFBRSxFQUFFLENBQUMsQ0FBQztRQUFFc0UsQ0FBQyxHQUFHdkUsTUFBTSxDQUFDLElBQUksR0FBR21GLEVBQUUsQ0FBQ2xGLEtBQUssQ0FBQyxFQUFFLEVBQUUsRUFBRSxDQUFDLENBQUM7TUFBRSxJQUFJTCxDQUFDLElBQUksRUFBRSxJQUFJQSxDQUFDLElBQUksSUFBSSxJQUFJMkUsQ0FBQyxJQUFJLEVBQUUsSUFBSUEsQ0FBQyxHQUFHM0UsQ0FBQyxFQUFFLE9BQVFJLE1BQU0sQ0FBQzhCLENBQUMsQ0FBQyxHQUFHeUMsQ0FBQyxHQUFJM0UsQ0FBQztJQUFFLENBQUMsQ0FBQyxNQUFNLENBQUM7SUFBRSxPQUFPSSxNQUFNLENBQUM4QixDQUFDLENBQUM7RUFBRSxDQUFDO0VBRWpRLGVBQWVzRCxTQUFTQSxDQUFDckIsQ0FBQyxFQUFFMUUsQ0FBQyxFQUFFMkMsSUFBSSxFQUFFRixDQUFDLEVBQUU7SUFDdEMsSUFBSTJDLEVBQUUsR0FBR3pDLElBQUksQ0FBQy9CLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQ08sS0FBSyxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUU7SUFBRSxNQUFNMEQsRUFBRSxHQUFHSCxDQUFDLENBQUN0QyxJQUFJLENBQUN4QixLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUNULFdBQVcsQ0FBQyxDQUFDO0lBQ3ZGLElBQUl1RSxDQUFDLENBQUMzQixPQUFPLEVBQUU7TUFBRSxJQUFJaUQsRUFBRSxHQUFHLENBQUM7TUFBRSxLQUFLLElBQUkzRSxDQUFDLEdBQUcsQ0FBQyxFQUFFQSxDQUFDLEdBQUcrRCxFQUFFLENBQUNoRixNQUFNLEVBQUVpQixDQUFDLEVBQUUsRUFBRTtRQUFFLE1BQU1iLENBQUMsR0FBRzRFLEVBQUUsQ0FBQy9ELENBQUMsQ0FBQyxDQUFDbEIsV0FBVyxDQUFDLENBQUM7UUFBRSxJQUFJLFFBQVEsQ0FBQ3FCLElBQUksQ0FBQ2hCLENBQUMsQ0FBQyxJQUFJRyxNQUFNLENBQUMsSUFBSSxHQUFHSCxDQUFDLENBQUMsR0FBRyxFQUFFLElBQUksSUFBSSxJQUFJQSxDQUFDLEtBQUtrRSxDQUFDLENBQUMzQixPQUFPLEVBQUU7UUFBVSxNQUFNa0QsQ0FBQyxHQUFHLE1BQU16RyxJQUFJLENBQUMsSUFBSSxHQUFHUCxRQUFRLEVBQUUsWUFBWSxHQUFHdUIsQ0FBQyxDQUFDO1FBQUUsSUFBSXlGLENBQUMsSUFBSXRGLE1BQU0sQ0FBQ3NGLENBQUMsQ0FBQ3JGLEtBQUssQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsR0FBRyxFQUFFLElBQUlxRixDQUFDLENBQUNyRixLQUFLLENBQUMsRUFBRSxFQUFFLEVBQUUsQ0FBQyxDQUFDVCxXQUFXLENBQUMsQ0FBQyxLQUFLMEUsRUFBRSxFQUFFO1VBQUVPLEVBQUUsQ0FBQy9ELENBQUMsQ0FBQyxHQUFHcUQsQ0FBQyxDQUFDM0IsT0FBTztVQUFFaUQsRUFBRSxHQUFHLENBQUM7UUFBRTtNQUFFO01BQUUsSUFBSUEsRUFBRSxFQUFFO1FBQUVyRCxJQUFJLEdBQUdBLElBQUksQ0FBQy9CLEtBQUssQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLEdBQUd3RSxFQUFFLENBQUNLLElBQUksQ0FBQyxFQUFFLENBQUM7UUFBRWhHLEdBQUcsQ0FBQyw0QkFBNEJPLENBQUMsRUFBRSxDQUFDO01BQUU7SUFBRSxDQUFDLENBQUM7SUFDMWIsTUFBTWtHLElBQUksR0FBRyxJQUFJdEUsR0FBRyxDQUFDLENBQUNpRCxFQUFFLEVBQUU3RSxDQUFDLENBQUNZLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQ1QsV0FBVyxDQUFDLENBQUMsRUFBRWYsSUFBSSxDQUFDd0IsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDVCxXQUFXLENBQUMsQ0FBQyxFQUFFYixJQUFJLENBQUNzQixLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUNULFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUM5RyxNQUFNZ0csR0FBRyxHQUFHZixFQUFFLENBQUNnQixHQUFHLENBQUMsQ0FBQzVGLENBQUMsRUFBRWEsQ0FBQyxLQUFLLENBQUNiLENBQUMsQ0FBQ0wsV0FBVyxDQUFDLENBQUMsRUFBRWtCLENBQUMsQ0FBQyxDQUFDLENBQUNRLE1BQU0sQ0FBQyxDQUFDLENBQUNyQixDQUFDLENBQUMsS0FBSyxxQkFBcUIsQ0FBQ2dCLElBQUksQ0FBQ2hCLENBQUMsQ0FBQyxJQUFJQSxDQUFDLENBQUNJLEtBQUssQ0FBQyxFQUFFLEVBQUUsRUFBRSxDQUFDLEtBQUssVUFBVSxJQUFJLENBQUNzRixJQUFJLENBQUMvQyxHQUFHLENBQUMzQyxDQUFDLENBQUNJLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUN3RixHQUFHLENBQUMsQ0FBQyxHQUFHL0UsQ0FBQyxDQUFDLEtBQUtBLENBQUMsQ0FBQztJQUMvSyxJQUFJLENBQUM4RSxHQUFHLENBQUMvRixNQUFNLEVBQUUsT0FBT3VDLElBQUk7SUFDNUIsS0FBSyxNQUFNN0IsQ0FBQyxJQUFJLENBQUMrRCxFQUFFLENBQUN3QixRQUFRLENBQUMsRUFBRSxFQUFFLEdBQUcsQ0FBQyxFQUFFLEdBQUcsQ0FBQ0MsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFDLEVBQUU7TUFDdEQsTUFBTWQsRUFBRSxHQUFHN0MsSUFBSSxDQUFDL0IsS0FBSyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsR0FBR3dFLEVBQUUsQ0FBQ2dCLEdBQUcsQ0FBQyxDQUFDNUYsQ0FBQyxFQUFFYSxDQUFDLEtBQU04RSxHQUFHLENBQUM5RixRQUFRLENBQUNnQixDQUFDLENBQUMsR0FBR1AsQ0FBQyxHQUFHTixDQUFFLENBQUMsQ0FBQ2lGLElBQUksQ0FBQyxFQUFFLENBQUM7TUFDbkYsSUFBSTtRQUFFLE1BQU05RixHQUFHLENBQUMsVUFBVSxFQUFFLENBQUM7VUFBRXFDLElBQUksRUFBRTBDLENBQUMsQ0FBQ3RDLElBQUk7VUFBRU0sRUFBRSxFQUFFMUMsQ0FBQztVQUFFMkMsSUFBSSxFQUFFNkMsRUFBRTtVQUFFNUMsS0FBSyxFQUFFLElBQUksR0FBR2pDLE1BQU0sQ0FBQzhCLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQ0ksUUFBUSxDQUFDLEVBQUU7UUFBRSxDQUFDLEVBQUUsUUFBUSxDQUFDLENBQUM7UUFBRXBELEdBQUcsQ0FBQyxjQUFjcUIsQ0FBQyxLQUFLLEdBQUcsQ0FBQ3dGLE1BQU0sQ0FBQyxFQUFFLENBQUMsR0FBRyxLQUFLLEdBQUcsT0FBTyxJQUFJdEcsQ0FBQyxFQUFFLENBQUM7UUFBRSxPQUFPd0YsRUFBRTtNQUFFLENBQUMsQ0FBQyxNQUFNLENBQUM7SUFDL007SUFDQSxNQUFNLElBQUlGLEtBQUssQ0FBQywrQkFBK0IsQ0FBQztFQUNsRDtFQUVBLE1BQU1pQixTQUFTLEdBQUcsQ0FBQyxVQUFVLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLFVBQVUsQ0FBQztFQUVsSyxNQUFNQyxRQUFRLEdBQUcsQ0FBQyxVQUFVLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsVUFBVSxDQUFDO0VBRXpMLGVBQWVwQyxVQUFVQSxDQUFDcEUsQ0FBQyxFQUFFQyxJQUFJLEVBQUV3RyxPQUFPLEVBQUU7SUFDMUMsSUFBSUMsSUFBSSxHQUFHLElBQUk7TUFBRUMsR0FBRyxHQUFHLElBQUk7SUFDM0IsS0FBSyxNQUFNaEMsQ0FBQyxJQUFJNEIsU0FBUyxFQUFFO01BQUUsSUFBSSxDQUFDdEcsSUFBSSxDQUFDSSxRQUFRLENBQUNzRSxDQUFDLENBQUMsRUFBRTtNQUFVLE1BQU03RCxDQUFDLEdBQUcsTUFBTXRCLElBQUksQ0FBQ1EsQ0FBQyxFQUFFLElBQUksR0FBRzJFLENBQUMsQ0FBQztNQUFFLElBQUk3RCxDQUFDLElBQUlBLENBQUMsQ0FBQ1YsTUFBTSxJQUFJLEVBQUUsRUFBRTtRQUFFc0csSUFBSSxHQUFHeEMsTUFBTSxDQUFDdkQsTUFBTSxDQUFDRyxDQUFDLENBQUNGLEtBQUssQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQztRQUFFO01BQU87SUFBRTtJQUM1SyxJQUFJOEYsSUFBSSxJQUFJLElBQUksRUFBRSxLQUFLLE1BQU0vQixDQUFDLElBQUk2QixRQUFRLEVBQUU7TUFBRSxJQUFJLENBQUN2RyxJQUFJLENBQUNJLFFBQVEsQ0FBQ3NFLENBQUMsQ0FBQyxFQUFFO01BQVUsTUFBTTdELENBQUMsR0FBRyxNQUFNdEIsSUFBSSxDQUFDUSxDQUFDLEVBQUUsSUFBSSxHQUFHMkUsQ0FBQyxDQUFDO01BQUUsSUFBSTdELENBQUMsSUFBSUEsQ0FBQyxDQUFDVixNQUFNLElBQUksRUFBRSxFQUFFO1FBQUUsTUFBTUksQ0FBQyxHQUFHMEQsTUFBTSxDQUFDdkQsTUFBTSxDQUFDRyxDQUFDLENBQUNGLEtBQUssQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQztRQUFFLElBQUlKLENBQUMsR0FBRyxFQUFFLElBQUlBLENBQUMsSUFBSWtHLElBQUksSUFBSWxHLENBQUMsR0FBRyxJQUFJLEVBQUU7VUFBRW1HLEdBQUcsR0FBR25HLENBQUM7VUFBRTtRQUFPO01BQUU7SUFBRTtJQUNsUCxJQUFJa0csSUFBSSxJQUFJLElBQUksSUFBSUMsR0FBRyxFQUFFLE9BQU87TUFBRXRDLFFBQVEsRUFBRXFDLElBQUksR0FBR0MsR0FBRztNQUFFRCxJQUFJO01BQUVDLEdBQUc7TUFBRUMsR0FBRyxFQUFFO0lBQVEsQ0FBQztJQUNqRjFILENBQUMsQ0FBQzJILElBQUksR0FBRzNILENBQUMsQ0FBQzJILElBQUksSUFBSSxDQUFDLENBQUM7SUFBRSxJQUFJQyxFQUFFLEdBQUc1SCxDQUFDLENBQUMySCxJQUFJLENBQUM3RyxDQUFDLENBQUM7SUFDekMsTUFBTStHLEdBQUcsR0FBR04sT0FBTyxJQUFJekcsQ0FBQztJQUN4QixJQUFJLENBQUM4RyxFQUFFLEVBQUU7TUFDUCxNQUFNRSxJQUFJLEdBQUd0RixRQUFRLENBQUMsTUFBTS9CLEdBQUcsQ0FBQyxpQkFBaUIsRUFBRSxFQUFFLENBQUMsRUFBRSxFQUFFLENBQUM7TUFDM0QsTUFBTXdELEdBQUcsR0FBRyxNQUFPK0IsQ0FBQyxJQUFNLENBQUMsQ0FBQyxNQUFNdkYsR0FBRyxDQUFDLGFBQWEsRUFBRSxDQUFDSyxDQUFDLEVBQUUsSUFBSSxHQUFHa0YsQ0FBQyxDQUFDckMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQ3BDLEtBQUssQ0FBQyxNQUFNLElBQUksQ0FBQyxLQUFLLElBQUksRUFBRUwsTUFBTSxHQUFHLENBQUU7TUFDeEgsSUFBSTZHLEVBQUUsR0FBR0QsSUFBSSxHQUFHLE1BQU07UUFBRUUsRUFBRSxHQUFHRixJQUFJO01BQUUsSUFBSSxNQUFNN0QsR0FBRyxDQUFDOEQsRUFBRSxDQUFDLEVBQUU7UUFBRS9ILENBQUMsQ0FBQzJILElBQUksQ0FBQzdHLENBQUMsQ0FBQyxHQUFHO1VBQUVtSCxJQUFJLEVBQUU7UUFBRSxDQUFDO1FBQUUsT0FBTztVQUFFOUMsUUFBUSxFQUFFLENBQUM7VUFBRXFDLElBQUk7VUFBRUM7UUFBSSxDQUFDO01BQUU7TUFDcEgsT0FBT08sRUFBRSxHQUFHRCxFQUFFLEdBQUcsQ0FBQyxFQUFFO1FBQUUsTUFBTUcsQ0FBQyxHQUFJSCxFQUFFLEdBQUdDLEVBQUUsSUFBSyxDQUFDO1FBQUUsSUFBSSxNQUFNL0QsR0FBRyxDQUFDaUUsQ0FBQyxDQUFDLEVBQUVGLEVBQUUsR0FBR0UsQ0FBQyxDQUFDLEtBQU1ILEVBQUUsR0FBR0csQ0FBQztNQUFFO01BQ3ZGLElBQUlDLElBQUksR0FBRyxFQUFFO01BQUUsS0FBSyxNQUFNbkMsQ0FBQyxJQUFJLENBQUNnQyxFQUFFLEVBQUVBLEVBQUUsR0FBRyxDQUFDLEVBQUVBLEVBQUUsR0FBRyxDQUFDLEVBQUVBLEVBQUUsR0FBRyxFQUFFLENBQUMsRUFBRTtRQUFFLE1BQU1wRyxDQUFDLEdBQUcsTUFBTW5CLEdBQUcsQ0FBQyxVQUFVLEVBQUUsQ0FBQztVQUFFK0MsRUFBRSxFQUFFcUUsR0FBRztVQUFFcEUsSUFBSSxFQUFFLFlBQVksR0FBRzlDLEVBQUUsQ0FBQ0csQ0FBQztRQUFFLENBQUMsRUFBRSxJQUFJLEdBQUdrRixDQUFDLENBQUNyQyxRQUFRLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDcEMsS0FBSyxDQUFDLE1BQU0sSUFBSSxDQUFDO1FBQUUsSUFBSUssQ0FBQyxJQUFJQSxDQUFDLENBQUNWLE1BQU0sSUFBSSxFQUFFLElBQUlPLE1BQU0sQ0FBQ0csQ0FBQyxDQUFDRixLQUFLLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLEdBQUcsRUFBRSxFQUFFO1VBQUV5RyxJQUFJLEdBQUcxRyxNQUFNLENBQUNHLENBQUMsQ0FBQ0YsS0FBSyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQztVQUFFO1FBQU87TUFBRTtNQUN2UmtHLEVBQUUsR0FBRzVILENBQUMsQ0FBQzJILElBQUksQ0FBQzdHLENBQUMsQ0FBQyxHQUFHcUgsSUFBSSxHQUFHLEVBQUUsR0FBRztRQUFFQSxJQUFJLEVBQUVBLElBQUksQ0FBQ3hFLFFBQVEsQ0FBQyxDQUFDO1FBQUVrRTtNQUFJLENBQUMsR0FBRztRQUFFSSxJQUFJLEVBQUU7TUFBRSxDQUFDO0lBQzNFO0lBQ0EsSUFBSUwsRUFBRSxDQUFDSyxJQUFJLEVBQUUsT0FBTztNQUFFOUMsUUFBUSxFQUFFLENBQUM7TUFBRXFDLElBQUk7TUFBRUM7SUFBSSxDQUFDO0lBQzlDLE1BQU1qRCxHQUFHLEdBQUduRSxHQUFHLENBQUMsTUFBTUMsSUFBSSxDQUFDc0gsRUFBRSxDQUFDQyxHQUFHLEVBQUUsWUFBWSxHQUFHbEgsRUFBRSxDQUFDRyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3pELE1BQU1xSCxJQUFJLEdBQUcxRyxNQUFNLENBQUNtRyxFQUFFLENBQUNPLElBQUksQ0FBQztJQUFFLE9BQU87TUFBRWhELFFBQVEsRUFBRUgsTUFBTSxDQUFDbUQsSUFBSSxHQUFHM0QsR0FBRyxDQUFDLEdBQUdRLE1BQU0sQ0FBQ21ELElBQUksQ0FBQztNQUFFWCxJQUFJO01BQUVDLEdBQUc7TUFBRUMsR0FBRyxFQUFFO0lBQVEsQ0FBQztFQUMvRztFQUVBLFNBQVNwRSxhQUFhQSxDQUFDRyxJQUFJLEVBQUU7SUFBRTtJQUM3QixNQUFNZSxHQUFHLEdBQUc0RCxJQUFJLENBQUNDLEtBQUssQ0FBQzlELElBQUksQ0FBQ0MsR0FBRyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUM7SUFBRSxNQUFNMEIsRUFBRSxHQUFHekMsSUFBSSxDQUFDL0IsS0FBSyxDQUFDLEVBQUUsQ0FBQyxDQUFDTyxLQUFLLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRTtJQUFFLElBQUlxRyxFQUFFLEdBQUcsQ0FBQztJQUN0RyxNQUFNQyxHQUFHLEdBQUdyQyxFQUFFLENBQUNnQixHQUFHLENBQUU1RixDQUFDLElBQUs7TUFBRSxNQUFNaUMsQ0FBQyxHQUFHOUIsTUFBTSxDQUFDLElBQUksR0FBR0gsQ0FBQyxDQUFDO01BQUUsSUFBSWlDLENBQUMsR0FBRzlCLE1BQU0sQ0FBQytDLEdBQUcsR0FBRyxFQUFFLEdBQUcsS0FBSyxDQUFDLElBQUlqQixDQUFDLEdBQUc5QixNQUFNLENBQUMrQyxHQUFHLEdBQUcsRUFBRSxHQUFHLEtBQUssQ0FBQyxFQUFFO1FBQUU4RCxFQUFFLEdBQUcsQ0FBQztRQUFFLE9BQVE3RyxNQUFNLENBQUMrQyxHQUFHLEdBQUcsR0FBRyxDQUFDLENBQUViLFFBQVEsQ0FBQyxFQUFFLENBQUMsQ0FBQ3dELFFBQVEsQ0FBQyxFQUFFLEVBQUUsR0FBRyxDQUFDO01BQUU7TUFBRSxPQUFPN0YsQ0FBQztJQUFFLENBQUMsQ0FBQztJQUM3TSxPQUFPZ0gsRUFBRSxHQUFHN0UsSUFBSSxDQUFDL0IsS0FBSyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsR0FBRzZHLEdBQUcsQ0FBQ2hDLElBQUksQ0FBQyxFQUFFLENBQUMsR0FBRzlDLElBQUk7RUFDckQ7RUFFQSxlQUFlK0UsVUFBVUEsQ0FBQzFILENBQUMsRUFBRUMsSUFBSSxFQUFFeUcsSUFBSSxFQUFFO0lBQUU7SUFDekMsTUFBTWlCLEdBQUcsR0FBR3pILE1BQU0sQ0FBQ0QsSUFBSSxJQUFJLEVBQUUsQ0FBQyxDQUFDRSxXQUFXLENBQUMsQ0FBQyxDQUFDYyxPQUFPLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQztJQUFFLE1BQU0yRyxJQUFJLEdBQUcsSUFBSWhHLEdBQUcsQ0FBQyxDQUFDO0lBQUUsS0FBSyxJQUFJUCxDQUFDLEdBQUcsQ0FBQyxFQUFFQSxDQUFDLEdBQUdzRyxHQUFHLENBQUN2SCxNQUFNLEdBQUcsRUFBRSxFQUFFaUIsQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJc0csR0FBRyxDQUFDL0csS0FBSyxDQUFDUyxDQUFDLEVBQUVBLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxJQUFJLEVBQUV1RyxJQUFJLENBQUN0SCxHQUFHLENBQUNxSCxHQUFHLENBQUMvRyxLQUFLLENBQUNTLENBQUMsR0FBRyxDQUFDLEVBQUVBLENBQUMsR0FBRyxFQUFFLENBQUMsQ0FBQztJQUMxTSxNQUFNd0csSUFBSSxHQUFHLEVBQUU7SUFBRSxLQUFLLE1BQU03RSxHQUFHLElBQUksQ0FBQyxHQUFHNEUsSUFBSSxDQUFDLENBQUNoSCxLQUFLLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxFQUFFO01BQUUsTUFBTUUsQ0FBQyxHQUFHLE1BQU10QixJQUFJLENBQUNRLENBQUMsRUFBRSxJQUFJLEdBQUdnRCxHQUFHLENBQUM7TUFBRSxJQUFJLENBQUNsQyxDQUFDLElBQUlBLENBQUMsQ0FBQ1YsTUFBTSxLQUFLLEVBQUUsRUFBRTtNQUFVLE1BQU1xQyxDQUFDLEdBQUd5QixNQUFNLENBQUN2RCxNQUFNLENBQUNHLENBQUMsQ0FBQyxDQUFDO01BQUUsSUFBSTJCLENBQUMsR0FBR2lFLElBQUksSUFBSWpFLENBQUMsSUFBSSxHQUFHLElBQUlBLENBQUMsR0FBRyxHQUFHLEtBQUssQ0FBQyxFQUFFb0YsSUFBSSxDQUFDekcsSUFBSSxDQUFDLENBQUM0QixHQUFHLEVBQUVQLENBQUMsQ0FBQyxDQUFDO0lBQUU7SUFDck8sSUFBSSxDQUFDb0YsSUFBSSxDQUFDekgsTUFBTSxFQUFFLE9BQU8sRUFBRTtJQUFFeUgsSUFBSSxDQUFDQyxJQUFJLENBQUMsQ0FBQ3RILENBQUMsRUFBRXVILENBQUMsS0FBSyxDQUFDQSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssS0FBSyxLQUFLdkgsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLEtBQUssQ0FBQyxJQUFJQSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUd1SCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFBRXRJLEdBQUcsQ0FBQyxNQUFNTyxDQUFDLFlBQVk2SCxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU1BLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQUUsT0FBT0EsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztFQUMvSztFQUVBLGVBQWVHLFdBQVdBLENBQUNoSSxDQUFDLEVBQUU7SUFBRTtJQUM5QixNQUFNZ0gsSUFBSSxHQUFHdEYsUUFBUSxDQUFDLE1BQU0vQixHQUFHLENBQUMsaUJBQWlCLEVBQUUsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDO0lBQzNELE1BQU1zSSxDQUFDLEdBQUcsTUFBTXZJLE9BQU8sQ0FBQyxDQUFDO01BQUV3SSxPQUFPLEVBQUVsSSxDQUFDO01BQUVtSSxTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUNuQixJQUFJLEdBQUcsSUFBSSxFQUFFbkUsUUFBUSxDQUFDLEVBQUUsQ0FBQztNQUFFdUYsT0FBTyxFQUFFLElBQUksR0FBR3BCLElBQUksQ0FBQ25FLFFBQVEsQ0FBQyxFQUFFO0lBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQ3BDLEtBQUssQ0FBQyxNQUFNZCxHQUFHLENBQUMsYUFBYSxFQUFFLENBQUM7TUFBRXVJLE9BQU8sRUFBRWxJLENBQUM7TUFBRW1JLFNBQVMsRUFBRSxJQUFJLEdBQUcsQ0FBQ25CLElBQUksR0FBRyxJQUFJLEVBQUVuRSxRQUFRLENBQUMsRUFBRSxDQUFDO01BQUV1RixPQUFPLEVBQUU7SUFBUyxDQUFDLENBQUMsQ0FBQyxDQUFDM0gsS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQy9QLE1BQU00SCxFQUFFLEdBQUcsQ0FBQyxHQUFHLElBQUl6RyxHQUFHLENBQUMsQ0FBQ3FHLENBQUMsSUFBSSxFQUFFLEVBQUU3QixHQUFHLENBQUVrQyxDQUFDLElBQUtBLENBQUMsQ0FBQ0MsZUFBZSxDQUFDLENBQUMsQ0FBQyxDQUFDM0gsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQzNFLE1BQU00SCxHQUFHLEdBQUcsQ0FBQyxNQUFNQyxPQUFPLENBQUNELEdBQUcsQ0FBQ0gsRUFBRSxDQUFDakMsR0FBRyxDQUFFcEYsQ0FBQyxJQUFLckIsR0FBRyxDQUFDLDBCQUEwQixFQUFFLENBQUNxQixDQUFDLENBQUMsQ0FBQyxDQUFDUCxLQUFLLENBQUMsTUFBTSxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUVvQixNQUFNLENBQUU4QixDQUFDLElBQUtBLENBQUMsSUFBSUEsQ0FBQyxDQUFDakIsRUFBRSxJQUFJaUIsQ0FBQyxDQUFDakIsRUFBRSxDQUFDdkMsV0FBVyxDQUFDLENBQUMsS0FBS0gsQ0FBQyxDQUFDO0lBQzNKLE1BQU0wSSxHQUFHLEdBQUdGLEdBQUcsQ0FBQzNHLE1BQU0sQ0FBRThCLENBQUMsSUFBS0EsQ0FBQyxDQUFDZ0YsS0FBSyxJQUFJaEYsQ0FBQyxDQUFDZ0YsS0FBSyxDQUFDdkksTUFBTSxJQUFJLEVBQUUsSUFBSSxDQUFDa0MsTUFBTSxDQUFDcUIsQ0FBQyxDQUFDZ0YsS0FBSyxDQUFDLElBQUksQ0FBQ2hGLENBQUMsQ0FBQ2dGLEtBQUssQ0FBQ3hJLFdBQVcsQ0FBQyxDQUFDLENBQUNFLFFBQVEsQ0FBQ3NELENBQUMsQ0FBQzNCLElBQUksQ0FBQ3BCLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQ1QsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3BKO01BQUU7TUFDQSxNQUFNeUksS0FBSyxHQUFHSixHQUFHLENBQUMzRyxNQUFNLENBQUU4QixDQUFDLElBQUssQ0FBQ0EsQ0FBQyxDQUFDZ0YsS0FBSyxJQUFJLElBQUksTUFBTSxJQUFJLElBQUloSSxNQUFNLENBQUNnRCxDQUFDLENBQUNmLEtBQUssSUFBSSxLQUFLLENBQUMsR0FBRyxFQUFFLENBQUM7TUFDNUYsSUFBSWdHLEtBQUssQ0FBQ3hJLE1BQU0sSUFBSSxDQUFDLElBQUl3SSxLQUFLLENBQUN4SSxNQUFNLElBQUlzSSxHQUFHLENBQUN0SSxNQUFNLEVBQUU7UUFBRSxNQUFNeUksRUFBRSxHQUFHLENBQUMsQ0FBQztRQUFFLEtBQUssTUFBTWxGLENBQUMsSUFBSWlGLEtBQUssRUFBRTtVQUFFLE1BQU1uRyxDQUFDLEdBQUc5QixNQUFNLENBQUNnRCxDQUFDLENBQUNmLEtBQUssQ0FBQyxDQUFDQyxRQUFRLENBQUMsQ0FBQztVQUFFZ0csRUFBRSxDQUFDcEcsQ0FBQyxDQUFDLEdBQUcsQ0FBQ29HLEVBQUUsQ0FBQ3BHLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDO1FBQUU7UUFBRSxNQUFNcUcsR0FBRyxHQUFHQyxNQUFNLENBQUNDLE9BQU8sQ0FBQ0gsRUFBRSxDQUFDLENBQUNmLElBQUksQ0FBQyxDQUFDdEgsQ0FBQyxFQUFFdUgsQ0FBQyxLQUFLQSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUd2SCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFBRSxNQUFNeUksR0FBRyxHQUFHLElBQUlySCxHQUFHLENBQUNnSCxLQUFLLENBQUMvRyxNQUFNLENBQUU4QixDQUFDLElBQUtqQyxRQUFRLENBQUNpQyxDQUFDLENBQUN1RixXQUFXLEVBQUUsRUFBRSxDQUFDLElBQUlsQyxJQUFJLEdBQUcsR0FBRyxDQUFDLENBQUNaLEdBQUcsQ0FBRXpDLENBQUMsSUFBS0EsQ0FBQyxDQUFDM0IsSUFBSSxDQUFDN0IsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUNnSixJQUFJO1FBQUUsT0FBTztVQUFFQyxJQUFJLEVBQUVOLEdBQUcsQ0FBQyxDQUFDLENBQUM7VUFBRU8sUUFBUSxFQUFFUCxHQUFHLENBQUMsQ0FBQyxDQUFDO1VBQUVRLFFBQVEsRUFBRVAsTUFBTSxDQUFDUSxJQUFJLENBQUNWLEVBQUUsQ0FBQztVQUFFSSxHQUFHO1VBQUVPLE9BQU8sRUFBRSxDQUFDO1VBQUVDLFNBQVMsRUFBRWhHLElBQUksQ0FBQ0MsR0FBRyxDQUFDO1FBQUUsQ0FBQztNQUFFO0lBQzNjO0lBQ0EsSUFBSSxDQUFDZ0YsR0FBRyxDQUFDdEksTUFBTSxFQUFFLE9BQU8sSUFBSTtJQUM1QixNQUFNc0osR0FBRyxHQUFHLENBQUMsQ0FBQztJQUFFLEtBQUssTUFBTS9GLENBQUMsSUFBSStFLEdBQUcsRUFBRWdCLEdBQUcsQ0FBQy9GLENBQUMsQ0FBQ2dGLEtBQUssQ0FBQy9ILEtBQUssQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsR0FBRyxDQUFDOEksR0FBRyxDQUFDL0YsQ0FBQyxDQUFDZ0YsS0FBSyxDQUFDL0gsS0FBSyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDO0lBQ3JHLE1BQU1vQyxHQUFHLEdBQUcrRixNQUFNLENBQUNDLE9BQU8sQ0FBQ1UsR0FBRyxDQUFDLENBQUM1QixJQUFJLENBQUMsQ0FBQ3ZILENBQUMsRUFBRTJFLENBQUMsS0FBS0EsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHM0UsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ2pFLE1BQU1vSixLQUFLLEdBQUdqQixHQUFHLENBQUM3RyxNQUFNLENBQUU4QixDQUFDLElBQUtBLENBQUMsQ0FBQ2dGLEtBQUssQ0FBQ2lCLFVBQVUsQ0FBQzVHLEdBQUcsQ0FBQyxDQUFDLENBQUM2RyxPQUFPLENBQUMsQ0FBQyxDQUFDL0IsSUFBSSxDQUFDLENBQUN2SCxDQUFDLEVBQUUyRSxDQUFDLEtBQUszRSxDQUFDLENBQUNvSSxLQUFLLENBQUN2SSxNQUFNLEdBQUc4RSxDQUFDLENBQUN5RCxLQUFLLENBQUN2SSxNQUFNLENBQUMsQ0FBQyxDQUFDO0lBQ3BILEtBQUssTUFBTTBKLElBQUksSUFBSUgsS0FBSyxDQUFDL0ksS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsRUFBRTtNQUNwQyxNQUFNbUosRUFBRSxHQUFHLE1BQU1wSyxHQUFHLENBQUMsMkJBQTJCLEVBQUUsQ0FBQ21LLElBQUksQ0FBQ0UsSUFBSSxDQUFDLENBQUMsQ0FBQ3ZKLEtBQUssQ0FBQyxNQUFNLElBQUksQ0FBQztNQUFFLElBQUksQ0FBQ3NKLEVBQUUsSUFBSUEsRUFBRSxDQUFDRSxNQUFNLEtBQUssS0FBSyxFQUFFO01BQ2xILElBQUlDLE1BQU0sR0FBRyxFQUFFO1FBQUVDLE1BQU0sR0FBRyxHQUFHO01BQzdCLEtBQUssTUFBTTdCLENBQUMsSUFBSXlCLEVBQUUsQ0FBQ0ssSUFBSSxJQUFJLEVBQUUsRUFBRSxJQUFJOUIsQ0FBQyxDQUFDK0IsTUFBTSxHQUFHLENBQUMsQ0FBQyxLQUFLbEwsVUFBVSxJQUFJbUosQ0FBQyxDQUFDK0IsTUFBTSxDQUFDakssTUFBTSxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksR0FBR2tJLENBQUMsQ0FBQytCLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQ3pKLEtBQUssQ0FBQyxFQUFFLENBQUMsRUFBRVQsV0FBVyxDQUFDLENBQUMsS0FBSzJKLElBQUksQ0FBQzlILElBQUksQ0FBQzdCLFdBQVcsQ0FBQyxDQUFDLEVBQUU7UUFBRStKLE1BQU0sR0FBRzVCLENBQUMsQ0FBQ0osT0FBTyxDQUFDL0gsV0FBVyxDQUFDLENBQUM7UUFBRWdLLE1BQU0sR0FBR3hKLE1BQU0sQ0FBQzJILENBQUMsQ0FBQzNGLElBQUksQ0FBQyxDQUFDRSxRQUFRLENBQUMsQ0FBQztRQUFFO01BQU87TUFDclAsTUFBTW9HLEdBQUcsR0FBRyxJQUFJckgsR0FBRyxDQUFDOEcsR0FBRyxDQUFDN0csTUFBTSxDQUFFOEIsQ0FBQyxJQUFLakMsUUFBUSxDQUFDaUMsQ0FBQyxDQUFDdUYsV0FBVyxFQUFFLEVBQUUsQ0FBQyxJQUFJbEMsSUFBSSxHQUFHLEdBQUcsQ0FBQyxDQUFDWixHQUFHLENBQUV6QyxDQUFDLElBQUtBLENBQUMsQ0FBQzNCLElBQUksQ0FBQzdCLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDZ0osSUFBSTtNQUN2SCxPQUFPO1FBQUV4RyxJQUFJLEVBQUVtSCxJQUFJLENBQUNuQixLQUFLO1FBQUUvRixLQUFLLEVBQUVqQyxNQUFNLENBQUNtSixJQUFJLENBQUNsSCxLQUFLLENBQUMsQ0FBQ0MsUUFBUSxDQUFDLENBQUM7UUFBRXFILE1BQU07UUFBRUMsTUFBTTtRQUFFbEIsR0FBRztRQUFFTyxPQUFPLEVBQUUsQ0FBQztRQUFFQyxTQUFTLEVBQUVoRyxJQUFJLENBQUNDLEdBQUcsQ0FBQztNQUFFLENBQUM7SUFDM0g7SUFDQSxPQUFPLElBQUk7RUFDYjtFQUVBLE1BQU00RyxLQUFLLEdBQUcsSUFBSWpILEdBQUcsQ0FBQyxDQUFDO0VBRXZCLE1BQU1rSCxFQUFFLEdBQUcsTUFBQUEsQ0FBTzdILEVBQUUsRUFBRUMsSUFBSSxFQUFFNkgsR0FBRyxHQUFHLEtBQUssS0FBSztJQUFFLE1BQU1qSCxDQUFDLEdBQUdiLEVBQUUsR0FBR0MsSUFBSTtNQUFFeUUsQ0FBQyxHQUFHa0QsS0FBSyxDQUFDOUcsR0FBRyxDQUFDRCxDQUFDLENBQUM7SUFBRSxJQUFJNkQsQ0FBQyxJQUFJM0QsSUFBSSxDQUFDQyxHQUFHLENBQUMsQ0FBQyxHQUFHMEQsQ0FBQyxDQUFDekQsQ0FBQyxHQUFHNkcsR0FBRyxFQUFFLE9BQU9wRCxDQUFDLENBQUMzRSxDQUFDO0lBQUUsTUFBTUEsQ0FBQyxHQUFHLE1BQU1qRCxJQUFJLENBQUNrRCxFQUFFLEVBQUVDLElBQUksQ0FBQztJQUFFMkgsS0FBSyxDQUFDaEcsR0FBRyxDQUFDZixDQUFDLEVBQUU7TUFBRWQsQ0FBQztNQUFFa0IsQ0FBQyxFQUFFRixJQUFJLENBQUNDLEdBQUcsQ0FBQztJQUFFLENBQUMsQ0FBQztJQUFFLElBQUk0RyxLQUFLLENBQUNuQixJQUFJLEdBQUcsS0FBSyxFQUFFbUIsS0FBSyxDQUFDRyxLQUFLLENBQUMsQ0FBQztJQUFFLE9BQU9oSSxDQUFDO0VBQUUsQ0FBQztFQUN4UCxPQUFPO0lBQ0wsSUFBSTNDLEtBQUtBLENBQUEsRUFBRztNQUFFLE9BQU9BLEtBQUs7SUFBRSxDQUFDO0lBQzdCLElBQUlnQyxTQUFTQSxDQUFBLEVBQUc7TUFBRSxPQUFPQSxTQUFTO0lBQUUsQ0FBQztJQUNyQyxJQUFJUSxNQUFNQSxDQUFBLEVBQUc7TUFBRSxPQUFPQSxNQUFNO0lBQUUsQ0FBQztJQUMvQixJQUFJdkMsUUFBUUEsQ0FBQSxFQUFHO01BQUUsT0FBT0EsUUFBUTtJQUFFLENBQUM7SUFDbkMsSUFBSXlFLE1BQU1BLENBQUEsRUFBRztNQUFFLE9BQU9BLE1BQU07SUFBRSxDQUFDO0lBQy9CLElBQUlXLFNBQVNBLENBQUEsRUFBRztNQUFFLE9BQU9BLFNBQVM7SUFBRSxDQUFDO0lBQ3JDLElBQUlRLFdBQVdBLENBQUEsRUFBRztNQUFFLE9BQU9BLFdBQVc7SUFBRSxDQUFDO0lBQ3pDLElBQUlDLE1BQU1BLENBQUEsRUFBRztNQUFFLE9BQU9BLE1BQU07SUFBRSxDQUFDO0lBQy9CLElBQUlHLFNBQVNBLENBQUEsRUFBRztNQUFFLE9BQU9BLFNBQVM7SUFBRSxDQUFDO0lBQ3JDLElBQUkzQyxPQUFPQSxDQUFBLEVBQUc7TUFBRSxPQUFPQSxPQUFPO0lBQUUsQ0FBQztJQUNqQyxJQUFJRSxZQUFZQSxDQUFBLEVBQUc7TUFBRSxPQUFPQSxZQUFZO0lBQUUsQ0FBQztJQUMzQyxJQUFJYyxVQUFVQSxDQUFBLEVBQUc7TUFBRSxPQUFPQSxVQUFVO0lBQUUsQ0FBQztJQUN2QyxJQUFJNUIsYUFBYUEsQ0FBQSxFQUFHO01BQUUsT0FBT0EsYUFBYTtJQUFFLENBQUM7SUFDN0MsSUFBSWtGLFVBQVVBLENBQUEsRUFBRztNQUFFLE9BQU9BLFVBQVU7SUFBRSxDQUFDO0lBQ3ZDLElBQUlNLFdBQVdBLENBQUEsRUFBRztNQUFFLE9BQU9BLFdBQVc7SUFBRSxDQUFDO0lBQ3pDLElBQUl1QyxFQUFFQSxDQUFBLEVBQUc7TUFBRSxPQUFPQSxFQUFFO0lBQUUsQ0FBQztJQUN2QixJQUFJeEksUUFBUUEsQ0FBQSxFQUFHO01BQUUsT0FBT0EsUUFBUTtJQUFFO0VBQ3BDLENBQUM7QUFDSCIsImlnbm9yZUxpc3QiOltdfQ==

// Module: market-data. Construction is inert; I/O is invoked explicitly.

export function createMarketData(dependencies) {
  const {
    S = {}, tg = async () => {},
    FACTORY,
    ROUTER,
    T_SWAP,
    T_TRANSFER,
    USD1,
    USDT,
    WBNB,
    call,
    cc,
    rpc,
    w,
    wa,
    fetchImpl
  } = dependencies;
  const XQ = ['0x4902c5ebc598265ed2212b559b042de8a5eeec3f', '0x02fca66c1d1afb4e2a7884261eb00f63598a7436', '0x205812cdbed920aff76c6580abd681a46d11efc7', '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1'];
  const dsCache = new Map();
  async function dexScreener(addr) {
    /* 使用者 10/31 19:55：不管跟什麼幣配對、在哪個 DEX（V2／V3／其他），都要查得到開盤——用 DexScreener 當保險（60 秒快取） */
    const k = dsCache.get(addr);
    if (k && Date.now() - k.t < 60e3) return k.v;
    let v = null;
    try {
      const j = await (await fetchImpl('https://api.dexscreener.com/latest/dex/tokens/' + addr, {
        signal: AbortSignal.timeout(10000)
      })).json();
      const ps = (j.pairs || []).filter(p => p.chainId === 'bsc' && String(p.baseToken?.address || '').toLowerCase() === addr && (p.liquidity?.usd || 0) > 50);
      if (ps.length) {
        ps.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        const p = ps[0];
        v = {
          pair: String(p.pairAddress).toLowerCase(),
          dex: p.dexId + (p.labels?.length ? ' ' + p.labels.join('') : ''),
          quote: p.quoteToken?.symbol || '',
          px: Number(p.priceUsd) || 0,
          liq: p.liquidity?.usd || 0
        };
      }
    } catch {}
    if (!v) v = await geckoPool(addr); /* 除錯 11/1：NOV 的池子開在 PancakeSwap Infinity，DexScreener 一直沒收錄，工具以為沒開盤、也讀不到價格 → 再用 GeckoTerminal 查（Infinity、Uniswap v4、V3 都有） */
    dsCache.set(addr, {
      t: Date.now(),
      v
    });
    return v;
  }
  async function geckoPool(addr) {
    try {
      const j = await (await fetchImpl(`https://api.geckoterminal.com/api/v2/networks/bsc/tokens/${addr}/pools`, {
        headers: {
          accept: 'application/json'
        },
        signal: AbortSignal.timeout(10000)
      })).json();
      const ps = (j.data || []).map(p => {
        const a = p.attributes || {},
          base = String(p.relationships?.base_token?.data?.id || '').toLowerCase().endsWith(addr);
        return {
          id: String(a.address || '').toLowerCase(),
          name: a.name || '',
          dex: String(p.relationships?.dex?.data?.id || 'gecko'),
          px: Number(base ? a.base_token_price_usd : a.quote_token_price_usd) || 0,
          liq: Number(a.reserve_in_usd) || 0
        };
      }).filter(x => x.px > 0 && x.liq > 50).sort((x, y) => y.liq - x.liq);
      if (!ps.length) return null;
      const p = ps[0];
      return {
        pair: /^0x[0-9a-f]{40}$/.test(p.id) ? p.id : 'gt:' + p.id,
        dex: p.dex,
        quote: (p.name.split('/')[1] || '').trim().split(' ')[0],
        px: p.px,
        liq: p.liq
      };
    } catch {
      return null;
    }
  }
  async function poolOpen(tk) {
    /* 有沒有已經開池（任何配對、任何 DEX）：V2 常見報價幣＋DexScreener（審查修正） */
    for (const q of [WBNB, USDT, USD1, ...XQ]) {
      const pr = await cc(FACTORY, '0xe6a43905' + wa(tk) + wa(q), 60e3);
      if (pr && BigInt(pr) > 0n) {
        const rs = await call('0x' + pr.slice(26), '0x0902f1ac');
        if (rs && BigInt('0x' + rs.slice(2, 66)) > 0n) return true;
      }
    }
    return !!(await dexScreener(tk));
  }
  async function findPair(t) {
    for (const q of [USDT, WBNB, USD1, ...XQ]) {
      const r = await call(FACTORY, '0xe6a43905' + wa(t.addr) + wa(q));
      const p = r ? '0x' + r.slice(-40) : null;
      if (!p || /^0x0{40}$/.test(p)) continue;
      const rs = await call(p, '0x0902f1ac');
      if (!rs || BigInt('0x' + rs.slice(2, 66)) === 0n || BigInt('0x' + rs.slice(66, 130)) === 0n) continue; /* 有池子但沒加流動性 = 還沒真的開盤 */
      return {
        pair: p,
        quote: q
      };
    }
    {
      const d = await dexScreener(t.addr);
      if (d) return {
        pair: d.pair,
        ds: 1,
        dex: d.dex,
        quote: d.quote
      };
    } /* V2 的 BNB/USDT/USD1/Flap 報價幣都沒有 → 用 DexScreener 找任何池子 */
    return null;
  }
  async function valueUsd(t, amt) {
    // 全部賣掉約可換多少 USDT
    if (amt <= 0n) return 0;
    let best = null;
    for (const path of [[t.addr, USDT], [t.addr, WBNB, USDT], [t.addr, USD1], ...XQ.flatMap(q => [[t.addr, q, WBNB, USDT], [t.addr, q, USDT]])]) {
      const r = await call(ROUTER, '0xd06ca61f' + w(amt) + w(64) + w(path.length) + path.map(wa).join(''));
      if (r) {
        const x = Number(BigInt('0x' + r.slice(-64))) / 1e18;
        if (best == null || x > best) best = x;
      }
    } // 審查修正：取所有池子裡最好的價格，避免被很小的池子誤判
    if (best != null && best > 0) {
      const d = await dexScreener(t.addr);
      if (d?.px && d.liq > 2000) {
        const dec = await tokDec(t.addr).catch(() => 18);
        const dv = Math.min(Number(amt) / 10 ** dec * d.px * 0.97, d.liq * 0.3);
        if (dv > best * 1.5) best = dv;
      }
    } /* 審查修正：有很小的 V2 池子、但真正的大池子在別處時，用大池子的價格，避免誤判成暴跌而賣掉 */
    if (best == null) {
      const d = await dexScreener(t.addr);
      if (d?.px) {
        const dec = await tokDec(t.addr).catch(() => 18);
        best = Math.min(Number(amt) / 10 ** dec * d.px * 0.97, d.liq * 0.3);
      } /* 小池子：最多估到池子流動性的 3 成，避免高估 */
    } /* 路由算不出來（V3／其他 DEX／其他報價幣）→ 用 DexScreener 價格估，打 97 折當滑價 */
    return best;
  }
  async function flow(t, st, from, to) {
    // 新錢包數、成交筆數
    try {
      const tr = await rpc('eth_getLogs', [{
        address: t.addr,
        topics: [T_TRANSFER],
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + to.toString(16)
      }]);
      st.holders = st.holders || {};
      let fresh = 0;
      for (const l of tr) {
        const toA = '0x' + l.topics[2].slice(26);
        if (!st.holders[toA]) {
          st.holders[toA] = 1;
          fresh++;
        }
      }
      let swaps = 0;
      if (st.pair && /^0x[0-9a-f]{40}$/.test(st.pair)) swaps = (await rpc('eth_getLogs', [{
        address: st.pair,
        topics: [T_SWAP],
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + to.toString(16)
      }])).length;
      return {
        fresh,
        swaps
      };
    } catch {
      return {
        fresh: 0,
        swaps: 0
      };
    }
  }
  const decCache = new Map();
  async function tokDec(a) {
    if (!decCache.has(a)) {
      const result = await call(a, '0x313ce567');
      if (!/^0x[0-9a-f]{64}$/i.test(result || '')) throw new Error('token decimals unavailable');
      const decimals = BigInt(result);
      if (decimals > 36n) throw new Error('unsupported token decimals');
      decCache.set(a, Number(decimals));
    }
    return decCache.get(a);
  }
  async function bnbUsd() {
    let price = 0;
    try {
      const p = await call(FACTORY, '0xe6a43905' + wa(WBNB) + wa(USDT));
      if (p && p.length >= 66) {
        const pair = '0x' + p.slice(-40);
        const r = await call(pair, '0x0902f1ac'), t0 = await call(pair, '0x0dfe1681');
        if (r?.length >= 130 && t0?.length >= 66) {
          const a = BigInt(r.slice(0, 66)), b = BigInt('0x' + r.slice(66, 130));
          if (a > 0n && b > 0n) price = t0.slice(-40).toLowerCase() === WBNB.slice(2) ? Number(b) / Number(a) : Number(a) / Number(b);
        }
      }
    } catch {}
    if (Number.isFinite(price) && price > 50 && price < 100000) { S.lastBnbUsd = price; S.bnbPriceEstimated = false; return price; }
    S.bnbPriceEstimated = true;
    const fallback = S.lastBnbUsd > 50 && S.lastBnbUsd < 100000 ? S.lastBnbUsd : 600;
    if (!S.bnbPriceWarningAt || Date.now() - S.bnbPriceWarningAt > 3600000) {
      S.bnbPriceWarningAt = Date.now(); await tg('⚠️ BNB 现价不可用，暂用估算价格 ' + fallback + ' USDT；成本和美元预算存在估算误差');
    }
    return fallback;
  }
  async function poolOut(amtIn, from, to) {
    // 池子現在買得到多少（沒池子回 0）
    const r = await call(ROUTER, '0xd06ca61f' + w(amtIn) + w(64) + w(2) + wa(from) + wa(to));
    if (!r || r.length < 2 + 64 * 4) return 0n;
    return BigInt('0x' + r.slice(2 + 64 * 3, 2 + 64 * 4));
  }
  return {
    get poolOpen() {
      return poolOpen;
    },
    get findPair() {
      return findPair;
    },
    get valueUsd() {
      return valueUsd;
    },
    get flow() {
      return flow;
    },
    get tokDec() {
      return tokDec;
    },
    get bnbUsd() {
      return bnbUsd;
    },
    get poolOut() {
      return poolOut;
    }
  };
}

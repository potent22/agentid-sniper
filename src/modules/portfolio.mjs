// Module: portfolio. Construction is inert; I/O is invoked explicitly.
import { readFileSync } from 'node:fs';
import { strategyKey, unitsToDecimal } from '../../execution-state.mjs';
export function createPortfolio(dependencies) {
  const {
    LOG,
    ME,
    NATIVE_BNB,
    RULE,
    S,
    TOKENS,
    WALLETS,
    big,
    blacklist,
    bnbUsd,
    call,
    findPair,
    flow,
    honeypotCheck,
    log,
    rpc,
    ruleTxt,
    save,
    swapConfirmed,
    tg,
    tgSay,
    tokDec,
    ts,
    valueUsd,
    wa
  } = dependencies;
  const SELLING = new Set();
  async function sell(t, st, amt, why, W = WALLETS[0], effect = {}) {
    const sk = W.name + '|' + t.addr;
    if (SELLING.has(sk)) return false;
    SELLING.add(sk);
    try {
      return await sellInner(t, st, amt, why, W, effect);
    } finally {
      SELLING.delete(sk);
    } /* 審查修正：同一個幣同時只賣一次（TG 指令和自動賣不會撞） */
  }
  async function sellInner(t, st, amt, why, W, effect) {
    {
      const live = (S.dyn || []).find(x => x.addr === t.addr && x.only === W.addr);
      if (live?.hold && !/指示/.test(why)) {
        log(`${t.sym} 設定為等使用者通知，不自動賣（${why}）`);
        return false;
      }
    } /* 審查修正：以最新設定為準，避免背景用舊清單賣掉（币安无忧 19:56） */
    const dec = await tokDec(t.addr),
      qty = unitsToDecimal(amt, dec);
    if (amt <= 0n) return false;
    const reportingPrice = await bnbUsd();
    if (!Number.isFinite(reportingPrice) || reportingPrice <= 0) throw new Error('賣出記帳報價不可用');
    const metadata = {
      purpose: 'sale',
      walletName: W.name,
      token: t.addr,
      sym: t.sym,
      cost: t.cost || 0,
      why,
      bnbPrice: reportingPrice,
      requestedRaw: amt.toString(),
      strategyState: structuredClone(st),
      effect
    };
    const r = await swapConfirmed(W, ['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', qty, '--fromToken', t.addr, '--toToken', NATIVE_BNB], metadata);
    log(`卖 ${t.sym} ${qty}: ${r.t.slice(0, 600)}`);
    if (!r.j?.success) {
      st.sellFail = (st.sellFail || 0) + 1;
      st.sellFailAt = Date.now();
      const msg = (r.j?.error?.message || r.t).slice(0, 200);
      log(`[${W.name}] ${t.sym} 賣出失敗第 ${st.sellFail} 次：${msg.replace(/\n/g, ' ')}`);
      /* 使用者 10/31 00:35：一直吵。不到 3U 的小額幣賣不掉完全不通知，試 6 次就放棄；值錢的只在第 1 次通知 */
      const small = (st.curV ?? 99) < 3;
      if (small && st.sellFail >= 6) {
        st.stage = 9;
        st.gaveUp = ts();
        log(`[${W.name}] ${t.sym} 只值約 ${(st.curV || 0).toFixed(2)}U，賣了 6 次都失敗，放棄不再賣`);
      }
      if (!small && st.sellFail === 1) await tg(`⚠️ [${W.name}] ${t.sym} 想賣但失敗（${why}）\n${msg}\n之後會自動重試，不再重複通知；賣掉時會發 💰 通知`);
      return false;
    }
    st.sellFail = 0;
    const got = Number(r.j.data.toTokenActualQty),
      px = await bnbUsd().catch(() => 0),
      gotU = got * px;
    const refunds = (r.j.data.refund || []).filter(x => typeof x.amount === 'string' && /^[0-9]+(\.[0-9]+)?$/.test(x.amount) && /[1-9]/.test(x.amount));
    await tg(`💰 [${W.name}] 已賣出 ${t.sym}（${why}）\n數量 ${qty}${got > 0 ? `\n換回 ${got.toFixed(5)} BNB（約 ${gotU.toFixed(2)}U）` : ''}${refunds.length ? '\n部分成交，有退回：' + refunds.map(x => x.amount + ' ' + x.symbol).join('、') : ''}\n交易 ${r.j.data.txHash}\n訂單 ${r.j.data?.orderId || ''}`);
    return true;
  }
  async function holdings(head, onlyFast = false) {
    await Promise.all(WALLETS.map(W => holdW(W, head, onlyFast).catch(e => log('holdings ' + W.name + ' ' + e.message))));
  }
  async function holdW(W, head, onlyFast) {
    // 所有錢包同時跑（速戰：賣單不排隊）
    for (const t0 of TOKENS.concat(S.dyn || [])) {
      if (t0.only && t0.only !== W.addr) continue;
      const t = {
        ...t0,
        cost: t0.only || t0.both || W.addr === ME ? t0.cost : 0
      };
      const dupSym = TOKENS.concat(S.dyn || []).filter(x => (!x.only || x.only === W.addr) && x.sym === t.sym && x.addr !== t.addr).length > 0; /* 審查修正：不同幣同名（像兩個 555、兩個 CIOW）以前共用同一份紀錄，餘額來回跳 */
      const legacyKey = (W.addr === ME ? t.sym : W.name + ':' + t.sym) + (dupSym ? '#' + t.addr.slice(2, 8) : '');
      const key = strategyKey(W.addr, t.addr);
      if (!S.tokens[key] && S.tokens[legacyKey]) S.tokens[key] = structuredClone(S.tokens[legacyKey]);
      const st = S.tokens[key] = S.tokens[key] || {
        hist: [],
        peak: 0,
        peakAt: 0,
        sold: 0
      };
      st.stateKey = key;
      if (st.review) continue;
      if (onlyFast && !(st.openAt && Date.now() - st.openAt < RULE.fastMin * 60e3 && st.stage !== 9 && !st.done)) continue;
      const balR = await call(t.addr, '0x70a08231' + wa(W.addr));
      if (balR == null) continue; /* 查詢失敗不當成 0（以前會一直誤報「收到幣」） */
      const bal = big(balR);
      const prevBal = BigInt(st.lastBal || '0');
      st.lastBal = bal.toString();
      if (bal > prevBal && st.balInit) {
        const v0 = await valueUsd(t, bal - prevBal);
        await tg(`🎁 [${W.name}] 收到 ${t.sym} ${(Number(bal - prevBal) / 1e18).toLocaleString()} 顆${v0 != null ? '，約值 ' + v0.toFixed(2) + 'U' : '（還沒有池子可以報價）'}\n會自動追蹤，到高點就賣`);
      }
      st.balInit = true;
      if (bal === 0n) {
        st.done = true;
        continue;
      }
      if (st.pair && !st.verified && !st.pairDs) {
        const rs = await call(st.pair, '0x0902f1ac');
        if (rs == null) {/* 查詢失敗：先不判斷 */} else if (BigInt('0x' + rs.slice(2, 66)) === 0n) {
          delete st.pair;
          st.checked = true;
        }
        if (rs != null) st.verified = true;
      } // 舊版誤判的空池子清掉
      if (!st.pair) {
        const p = await findPair(t);
        const first = !st.checked;
        st.checked = true;
        if (p) {
          st.pair = p.pair;
          if (p.ds) {
            st.pairDs = 1;
            st.pairInfo = `${p.dex}，跟 ${p.quote} 配對`;
          }
          st.openAt = st.openAt || Date.now();
          st.fromBlock = head - 400;
          if (!first) await honeypotCheck(W, t, st, bal);
          if (!first) await tg(`🚀 ${t.sym} 開池了（${st.pairInfo || 'PancakeSwap'}）\n合約 ${t.addr}\n池子 ${p.pair}\n開始追蹤價格，達到高點會自動賣`);
        } else {
          if (t0.deployer && t0.boughtAt && Date.now() - t0.boughtAt > 48 * 3600e3) blacklist(t0.deployer, `${t.sym} 打完 48 小時還沒開池`);
          continue;
        }
      }
      const v = await valueUsd(t, bal);
      if (v == null) continue;
      st.curV = v;
      // 用「每顆價格」算高點和倍數（審查修正：賣掉一部分後持倉變少，不會再被誤判成暴跌）
      const dec = await tokDec(t.addr);
      const balN = Number(bal) / 10 ** dec || 1e-18;
      const px = v / balN;
      if (!st.qty0 || balN > st.qty0 * 1.0001) st.qty0 = balN; // 原始持有量
      const vFull = px * st.qty0; // 如果還拿著全部，現在值多少（算 3／5／10 倍用）
      const from = Math.max(st.fromBlock || head - 20, head - 2000);
      const f = await flow(t, st, from, head);
      st.fromBlock = head + 1;
      const now = Date.now();
      st.hist.push({
        t: now,
        v,
        fresh: f.fresh,
        swaps: f.swaps
      });
      st.hist = st.hist.filter(h => now - h.t < 20 * 60e3);
      if (v > st.peak) {
        st.peak = v;
        st.peakAt = now;
      }
      if (px > (st.ppeak || 0)) {
        st.ppeak = px;
        st.ppeakAt = now;
      }
      const sum = (a, b, k) => st.hist.filter(h => now - h.t >= a * 1000 && now - h.t < b * 1000).reduce((s, h) => s + h[k], 0);
      const fresh5 = sum(0, 300, 'fresh'),
        swaps5 = sum(0, 300, 'swaps'),
        swapsPrev5 = sum(300, 600, 'swaps');
      if (st.stage == null) st.stage = st.sold >= 2 ? 9 : st.sold === 1 ? 1 : 0; // 舊版狀態換算
      if (st.stage >= 9) {
        st.last = {
          v,
          at: ts()
        };
        continue;
      }
      if (st.sellFail && now - (st.sellFailAt || 0) < Math.min(2, 2 ** (st.sellFail - 1)) * 60e3) {
        st.last = {
          v,
          at: ts()
        };
        continue;
      } // 賣不掉：1、2、4…最多 15 分鐘後再試，不狂重試
      st.notified = st.notified || [];
      if (t.cost > 0 && !t.hold && !t.custom) for (const x of RULE.notifyX) if (vFull >= t.cost * x && !st.notified.includes(x)) {
        st.notified.push(x);
        await tg(`🔥 [${W.name}] ${t.sym} 到 ${x} 倍了！（成本 ${t.cost}U，現在持倉約 ${v.toFixed(2)}U）\n照規則：${ruleTxt()}`);
      }
      if (t.sellNow) {
        if (!st.sellNowDone) {
          await sell(t, st, bal, '你指示全部賣出', W, {
            sellNowDone: true,
            stage: 9
          });
        }
        continue;
      }
      if (!(t.cost > 0) || t.hold) {
        // 免費的、或使用者說先別賣的
        if (!st.basePx) st.basePx = px; // 免費幣以開池後第一個價格當基準
        for (const x of RULE.notifyX) {
          const hit = t.hold && t.cost > 0 ? vFull >= t.cost * x : px >= st.basePx * x; /* 審查 11/1：成本 0 的 hold 幣會一次誤報 5／10／20 倍 */
          if (hit && !st.notified.includes(x)) {
            st.notified.push(x);
            await tg(`🔥 [${W.name}] ${t.hold ? '' : '免費幣 '}${t.sym} 漲到${t.hold ? '成本' : '開池價'}的 ${x} 倍！市值約 ${v.toFixed(2)}U\n${t.hold ? '你說先別賣，要賣在 TG 打「賣 ' + t.sym + '」' : '從最高價回落 50% 會自動全賣；想先賣在 TG 打「賣 ' + t.sym + '」'}`);
          }
        }
        if (st.openAt && now - st.openAt >= 180e3 && px > (st.fpp || 0)) st.fpp = px; // 開盤 3 分鐘後才開始算最高價
        const dropNow = !t.hold && st.fpp > 0 && px < st.fpp * (1 - RULE.drop) && v >= 0.3;
        st.dropHit = dropNow ? (st.dropHit || 0) + 1 : 0; /* 審查 11/1：連續 2 次才算，避免價格來源跳動假崩盤 */
        if (dropNow && st.dropHit >= 2) {
          // 免費幣從最高價回落 50% 全賣
          if (await sell(t, st, bal, `免費幣從最高價回落 50%，全部賣出（約 ${v.toFixed(2)}U）`, W, {
            stage: 9
          })) {
            continue;
          }
        }
        if (t.hold && px < st.ppeak * (1 - RULE.drop) && st.dropWarnedPeak !== st.ppeak) {
          st.dropWarnedPeak = st.ppeak;
          await tg(`⚠️ [${W.name}] ${t.sym} 從最高價回調 50%，現在約 ${v.toFixed(2)}U\n你說先別賣，不會自動賣，要賣在 TG 打「賣 ${t.sym}」`);
        }
        st.last = {
          v,
          at: ts()
        };
        continue;
      }
      if (v < 0.3) {
        st.last = {
          v,
          at: ts()
        };
        continue;
      } // 剩下不到 0.3U 的灰塵不賣（賣了不夠手續費）
      st.done2 = st.done2 || [];
      if (t.custom === 'fist') {
        /* 使用者 10/31 20:39：FISTAGENT 特殊規則——5 倍賣回本錢、10 倍賣 30%、20 倍以上只發 TG 通知，其他自動賣出規則都不用 */
        const xNow = vFull / t.cost;
        if (xNow < 0.5 && !st.done2.includes('cw')) {
          st.done2.push('cw');
          await tg(`⚠️ [${W.name}] FISTAGENT 跌破成本一半了（成本 ${t.cost}U，現在約 ${v.toFixed(2)}U）\n你的設定沒有「暴跌就賣」，不會自動賣；要賣在 TG 打「賣 FISTAGENT」`);
        } /* 除錯 11/1：只有上漲目標的特殊規則沒有任何下跌提醒，NOV 跌 88% 都沒通知 */
        if (xNow >= 5 && !st.done2.includes('f5')) {
          const part = bal * BigInt(Math.max(1, Math.min(100, Math.ceil(t.cost / v * 100)))) / 100n;
          await sell(t, st, part, `FISTAGENT 到 5 倍，賣回本錢 ${t.cost}U（持倉約 ${v.toFixed(2)}U）`, W, {
            mark: 'f5'
          });
        } else if (xNow >= 10 && !st.done2.includes('f10')) {
          await sell(t, st, bal * 30n / 100n, `FISTAGENT 到 10 倍，賣出 30%（持倉約 ${v.toFixed(2)}U）`, W, {
            mark: 'f10'
          });
        } else if (xNow >= 20 && !st.done2.includes('f20')) {
          st.done2.push('f20');
          await tg(`🔥 [${W.name}] FISTAGENT 到 ${Math.floor(xNow)} 倍了！（成本 ${t.cost}U，現在持倉約 ${v.toFixed(2)}U）\n照你的設定 20 倍以上不自動賣，要賣在 TG 打「賣 FISTAGENT」或「賣 FISTAGENT 一半」`);
        }
        st.last = {
          v,
          at: ts()
        };
        continue;
      }
      if (t.custom === 'nova') {
        /* 使用者 10/31 23:18：NOVA 5 倍賣回本錢，10 倍發 TG 通知，不自動賣其他 */
        const xNow = vFull / t.cost;
        if (xNow < 0.5 && !st.done2.includes('cw')) {
          st.done2.push('cw');
          await tg(`⚠️ [${W.name}] NOVA 跌破成本一半了（成本 ${t.cost}U，現在約 ${v.toFixed(2)}U）\n你的設定沒有「暴跌就賣」，不會自動賣；要賣在 TG 打「賣 NOV」`);
        } /* 除錯 11/1：只有上漲目標的特殊規則沒有任何下跌提醒，NOV 跌 88% 都沒通知 */
        if (xNow >= 5 && !st.done2.includes('n5')) {
          const part = bal * BigInt(Math.max(1, Math.min(100, Math.ceil(t.cost / v * 100)))) / 100n;
          await sell(t, st, part, `NOVA 到 5 倍，賣回本錢 ${t.cost}U（持倉約 ${v.toFixed(2)}U）`, W, {
            mark: 'n5'
          });
        } else if (xNow >= 10 && !st.done2.includes('n10')) {
          st.done2.push('n10');
          await tg(`🔥 [${W.name}] NOVA 到 ${Math.floor(xNow)} 倍了！（成本 ${t.cost}U，現在持倉約 ${v.toFixed(2)}U）\n照你的設定不自動賣，要賣在 TG 打「賣 NOV」或「賣 NOV 一半」`);
        }
        st.last = {
          v,
          at: ts()
        };
        continue;
      }
      const backDone = st.done2.includes('back');
      if (backDone && st.moonPend && RULE.moonPct) {
        st.moon = (bal * BigInt(RULE.moonPct) / 100n).toString();
        delete st.moonPend;
        log(`[${W.name}] ${t.sym} 回本後留 ${RULE.moonPct}% 長抱（不自動賣，50／100 倍通知）`);
      }
      const moon = backDone && st.moon ? BigInt(st.moon) : 0n;
      const freeAmt = bal > moon ? bal - moon : 0n;
      if (moon > 0n && freeAmt * 50n <= moon) {
        /* 只剩長抱那份：不自動賣，到 50／100 倍通知 */
        for (const x of RULE.moonNotifyX || []) if (vFull >= t.cost * x && !st.done2.includes('m' + x)) {
          st.done2.push('m' + x);
          await tg(`🔥 [${W.name}] ${t.sym} 長抱那份到 ${x} 倍了！（成本 ${t.cost}U，現在約 ${v.toFixed(2)}U）\n照設定不自動賣，要賣在 TG 打「賣 ${t.sym}」或「賣 ${t.sym} 一半」`);
        }
        st.last = {
          v,
          at: ts()
        };
        continue;
      }
      const crash = backDone ? RULE.crashAfterBack || RULE.crash : RULE.crash; /* 使用者 11/1 13:54：回本前回落 40% 全賣；回本後放寬到 60% */
      const crashNow = st.ppeak > 0 && px < st.ppeak * (1 - crash);
      st.crashHit = crashNow ? (st.crashHit || 0) + 1 : 0; /* 審查 11/1：價格來源偶爾跳到很小的池子會假崩盤 → 要連續 2 次都低於門檻才全賣 */
      if (crashNow && st.crashHit >= 2) {
        await sell(t, st, moon > 0n ? freeAmt : bal, `從最高價回落 ${Math.round(crash * 100)}%，${moon > 0n ? `賣出長抱以外的部分（留 ${RULE.moonPct}% 長抱）` : '全部賣出'}（約 ${v.toFixed(2)}U）`, W, moon > 0n ? {} : {
          stage: 9
        });
      } else if (!backDone && vFull >= t.cost * RULE.backX) {
        const pct = Math.min(100, Math.ceil(t.cost / v * 100 * 1.03));
        await sell(t, st, bal * BigInt(pct) / 100n, `到 ${RULE.backX} 倍，賣 ${pct}% 拿回本錢 ${t.cost}U（持倉約 ${v.toFixed(2)}U）`, W, {
          mark: 'back',
          moonPend: pct < 100
        });
      } else for (const [x, pc] of RULE.steps) {
        if (!st.done2.includes('s' + x) && !(x === 10 && st.done2.includes('h10')) && vFull >= t.cost * x) {
          await sell(t, st, (moon > 0n ? freeAmt : bal) * BigInt(pc) / 100n, `到 ${x} 倍，賣出 ${pc}%${moon > 0n ? '（長抱那份不動）' : ''}（持倉約 ${v.toFixed(2)}U）`, W, {
            mark: 's' + x
          });
          break;
        }
      }
      st.last = {
        v,
        fresh5,
        swaps5,
        swapsPrev5,
        at: ts()
      };
    }
  }
  function findTok(q, W) {
    q = q.toLowerCase();
    return TOKENS.concat(S.dyn || []).find(t => (!t.only || t.only === W.addr) && (t.sym.toLowerCase() === q || t.addr === q));
  }
  async function cmdSell(q, half) {
    const head = parseInt(await rpc('eth_blockNumber', []), 16);
    const jobs = WALLETS.map(async W => {
      const t0 = findTok(q, W);
      if (!t0) return `[${W.name}] 找不到 ${q}`;
      const bal = big(await call(t0.addr, '0x70a08231' + wa(W.addr)));
      if (bal === 0n) return `[${W.name}] 沒有 ${t0.sym}`;
      const dupSym = TOKENS.concat(S.dyn || []).filter(x => (!x.only || x.only === W.addr) && x.sym === t0.sym && x.addr !== t0.addr).length > 0;
      const legacyKey = (W.addr === ME ? t0.sym : W.name + ':' + t0.sym) + (dupSym ? '#' + t0.addr.slice(2, 8) : '');
      const key = strategyKey(W.addr, t0.addr);
      if (!S.tokens[key] && S.tokens[legacyKey]) S.tokens[key] = structuredClone(S.tokens[legacyKey]);
      const st = S.tokens[key] = S.tokens[key] || {
        hist: [],
        peak: 0,
        peakAt: 0,
        sold: 0
      };
      const ok = await sell(t0, st, half ? bal / 2n : bal, half ? '你在 TG 指示賣一半' : '你在 TG 指示全部賣出', W, half ? {} : {
        stage: 9,
        done: true
      });
      return ok ? null : `[${W.name}] ${t0.sym} 賣出失敗`;
    });
    const errs = (await Promise.all(jobs)).filter(Boolean);
    save();
    if (errs.length) await tgSay('⚠️ ' + errs.join('\n'));
    void head;
  }
  async function cmdBalance() {
    const lines = await Promise.all(WALLETS.map(async W => {
      const b = Number(BigInt(await rpc('eth_getBalance', [W.addr, 'latest']))) / 1e18;
      return `${W.name}：${b.toFixed(5)} BNB`;
    }));
    await tgSay('💼 錢包餘額\n' + lines.join('\n'));
  }
  async function cmdHold() {
    const out = [];
    for (const W of WALLETS) for (const t0 of TOKENS.concat(S.dyn || [])) {
      if (t0.only && t0.only !== W.addr) continue;
      const bal = big(await call(t0.addr, '0x70a08231' + wa(W.addr)));
      if (bal === 0n) continue;
      const v = await valueUsd(t0, bal).catch(() => null);
      const line = `[${W.name}] ${t0.sym}：${v == null ? '還沒有池子' : '約 ' + v.toFixed(2) + 'U'}`;
      if (!out.includes(line)) out.push(line);
    }
    await tgSay('📦 還沒賣的幣\n' + (out.length ? out.join('\n') : '沒有') + '\n（NFT 不在這裡，NFT 成交量變多會另外通知）');
  }
  async function holdReport(title = '📦 持倉總結') {
    /* 使用者 11/1 03:19：每 12 小時（凌晨 1 點、下午 1 點；使用者 11/1 03:36 改）發一次持倉總結：成本、現值、倍數、狀態 */
    const rows = [],
      noPool = [],
      dust = [];
    let tc = 0,
      tv = 0;
    for (const W of WALLETS) for (const t0 of TOKENS.concat(S.dyn || [])) {
      if (t0.only && t0.only !== W.addr) continue;
      const bal = big(await call(t0.addr, '0x70a08231' + wa(W.addr)).catch(() => null));
      if (!(bal > 0n)) continue;
      const v = await valueUsd(t0, bal).catch(() => null);
      const wn = W === WALLETS[0] ? 'A' : 'B';
      if (v == null) {
        if (!noPool.includes(t0.sym)) noPool.push(t0.sym);
        continue;
      }
      if (v < 0.3) {
        if (!dust.includes(t0.sym)) dust.push(t0.sym);
        continue;
      }
      const st = (S.tokens || {})[t0.sym] || (S.tokens || {})[W.name + ':' + t0.sym] || {};
      const cost = Number(t0.cost) || 0;
      const x = cost > 0 ? v / cost : 0;
      const status = t0.hold ? '只通知' : t0.custom ? '特殊規則' : (st.done2 || []).includes('back') ? st.moon ? `已回本，含 ${RULE.moonPct}% 長抱` : '已回本，照策略持有' : cost > 0 ? '照策略持有' : '免費幣';
      tc += cost;
      tv += v;
      rows.push({
        v,
        line: `${t0.sym}（錢包${wn}）${cost > 0 ? `成本 ${cost.toFixed(1)}U → ` : ''}約 ${v.toFixed(2)}U${x ? `（${x.toFixed(2)} 倍）` : ''} · ${status}`
      });
    }
    rows.sort((a, b) => b.v - a.v);
    const msg = `${title}（錢包A＝${WALLETS[0]?.name || ''}${WALLETS[1] ? '、錢包B＝' + WALLETS[1].name : ''}）\n${rows.length ? rows.map(r => '· ' + r.line).join('\n') : '目前沒有有價格的持倉'}\n\n有價格的合計：約 ${tv.toFixed(2)}U${tc ? `（付費成本合計 ${tc.toFixed(1)}U）` : ''}${noPool.length ? `\n還沒開池（${noPool.length} 個）：${noPool.slice(0, 20).join('、')}${noPool.length > 20 ? '…' : ''}` : ''}${dust.length ? `\n不到 0.3U 的零頭：${dust.join('、')}` : ''}`;
    await tgSay(msg);
  }
  async function cmdStats() {
    // 免費項目：所有「已自動鑄造」的記錄都算（含一發現就馬上打的），用合約地址去重；「現在開了」那種用名稱對回合約；扣掉早上 0 BNB bug 的假鑄造
    const free = new Set(),
      bog = new Set(),
      paidC = new Set();
    let paid = 0;
    const n2a = {};
    try {
      const lines = readFileSync(LOG, 'utf8').split('\n');
      for (const l of lines) {
        const m = l.match(/(?:專屬合約|項目)：([^|（(\n]+?)\s*(?:（[^|]*）)?\s*\|\s*(0x[a-fA-F0-9]{40})/);
        if (m && !n2a[m[1].trim().toLowerCase()]) n2a[m[1].trim().toLowerCase()] = m[2].toLowerCase();
      }
      for (const l of lines) {
        if (l.includes('🛒')) {
          paid++;
          const c = l.match(/(?<![0-9a-fA-Fx])(0x[a-fA-F0-9]{40})(?![0-9a-fA-F])/);
          if (c) paidC.add(c[1].toLowerCase());
        }
        if (!l.includes('已自動鑄造')) continue;
        const nm = l.match(/項目\s*([^\n（(|]+?)\s*現在開了/);
        let key = '';
        if (nm) key = n2a[nm[1].trim().toLowerCase()] || 'N:' + nm[1].trim().toLowerCase();else {
          const c = l.match(/(?<![0-9a-fA-Fx])(0x[a-fA-F0-9]{40})(?![0-9a-fA-F])/);
          if (c) key = c[1].toLowerCase();
        }
        if (!key) continue;
        (/重播0x(（| \||$)/.test(l) ? bog : free).add(key);
      }
      for (const k of bog) free.delete(k);
    } catch {}
    const tr = S.trades || [],
      by = {};
    for (const x of tr) {
      const k = x.sym;
      by[k] = by[k] || {
        usd: 0,
        n: 0
      };
      by[k].usd += x.usd;
      by[k].n++;
    }
    const px = await bnbUsd().catch(() => 0);
    let tot = 0;
    for (const W of WALLETS) tot += Number(BigInt(await rpc('eth_getBalance', [W.addr, 'latest']))) / 1e18;
    const lines = Object.entries(by).map(([k, v]) => `${k}：賣 ${v.n} 筆，拿回約 ${v.usd.toFixed(2)}U`);
    await tgSay(`📊 戰績\n自動打的免費項目：${free.size} 個\n付費打的：${paidC.size} 個項目（${paid} 筆）\n${lines.length ? '有記錄的賣出：\n' + lines.join('\n') + '\n' : ''}錢包現在共 ${tot.toFixed(4)} BNB（約 ${(tot * px).toFixed(2)}U）`);
  }
  return {
    get holdings() {
      return holdings;
    },
    get cmdSell() {
      return cmdSell;
    },
    get cmdBalance() {
      return cmdBalance;
    },
    get holdReport() {
      return holdReport;
    },
    get cmdStats() {
      return cmdStats;
    }
  };
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJyZWFkRmlsZVN5bmMiLCJzdHJhdGVneUtleSIsInVuaXRzVG9EZWNpbWFsIiwiY3JlYXRlUG9ydGZvbGlvIiwiZGVwZW5kZW5jaWVzIiwiTE9HIiwiTUUiLCJOQVRJVkVfQk5CIiwiUlVMRSIsIlMiLCJUT0tFTlMiLCJXQUxMRVRTIiwiYmlnIiwiYmxhY2tsaXN0IiwiYm5iVXNkIiwiY2FsbCIsImZpbmRQYWlyIiwiZmxvdyIsImhvbmV5cG90Q2hlY2siLCJsb2ciLCJycGMiLCJydWxlVHh0Iiwic2F2ZSIsInN3YXBDb25maXJtZWQiLCJ0ZyIsInRnU2F5IiwidG9rRGVjIiwidHMiLCJ2YWx1ZVVzZCIsIndhIiwiU0VMTElORyIsIlNldCIsInNlbGwiLCJ0Iiwic3QiLCJhbXQiLCJ3aHkiLCJXIiwiZWZmZWN0Iiwic2siLCJuYW1lIiwiYWRkciIsImhhcyIsImFkZCIsInNlbGxJbm5lciIsImRlbGV0ZSIsImxpdmUiLCJkeW4iLCJmaW5kIiwieCIsIm9ubHkiLCJob2xkIiwidGVzdCIsInN5bSIsImRlYyIsInF0eSIsInJlcG9ydGluZ1ByaWNlIiwiTnVtYmVyIiwiaXNGaW5pdGUiLCJFcnJvciIsIm1ldGFkYXRhIiwicHVycG9zZSIsIndhbGxldE5hbWUiLCJ0b2tlbiIsImNvc3QiLCJibmJQcmljZSIsInJlcXVlc3RlZFJhdyIsInRvU3RyaW5nIiwic3RyYXRlZ3lTdGF0ZSIsInN0cnVjdHVyZWRDbG9uZSIsInIiLCJzbGljZSIsImoiLCJzdWNjZXNzIiwic2VsbEZhaWwiLCJzZWxsRmFpbEF0IiwiRGF0ZSIsIm5vdyIsIm1zZyIsImVycm9yIiwibWVzc2FnZSIsInJlcGxhY2UiLCJzbWFsbCIsImN1clYiLCJzdGFnZSIsImdhdmVVcCIsInRvRml4ZWQiLCJnb3QiLCJkYXRhIiwidG9Ub2tlbkFjdHVhbFF0eSIsInB4IiwiY2F0Y2giLCJnb3RVIiwicmVmdW5kcyIsInJlZnVuZCIsImZpbHRlciIsImFtb3VudCIsImxlbmd0aCIsIm1hcCIsInN5bWJvbCIsImpvaW4iLCJ0eEhhc2giLCJvcmRlcklkIiwiaG9sZGluZ3MiLCJoZWFkIiwib25seUZhc3QiLCJQcm9taXNlIiwiYWxsIiwiaG9sZFciLCJlIiwidDAiLCJjb25jYXQiLCJib3RoIiwiZHVwU3ltIiwibGVnYWN5S2V5Iiwia2V5IiwidG9rZW5zIiwiaGlzdCIsInBlYWsiLCJwZWFrQXQiLCJzb2xkIiwic3RhdGVLZXkiLCJyZXZpZXciLCJvcGVuQXQiLCJmYXN0TWluIiwiZG9uZSIsImJhbFIiLCJiYWwiLCJwcmV2QmFsIiwiQmlnSW50IiwibGFzdEJhbCIsImJhbEluaXQiLCJ2MCIsInRvTG9jYWxlU3RyaW5nIiwicGFpciIsInZlcmlmaWVkIiwicGFpckRzIiwicnMiLCJjaGVja2VkIiwicCIsImZpcnN0IiwiZHMiLCJwYWlySW5mbyIsImRleCIsInF1b3RlIiwiZnJvbUJsb2NrIiwiZGVwbG95ZXIiLCJib3VnaHRBdCIsInYiLCJiYWxOIiwicXR5MCIsInZGdWxsIiwiZnJvbSIsIk1hdGgiLCJtYXgiLCJmIiwicHVzaCIsImZyZXNoIiwic3dhcHMiLCJoIiwicHBlYWsiLCJwcGVha0F0Iiwic3VtIiwiYSIsImIiLCJrIiwicmVkdWNlIiwicyIsImZyZXNoNSIsInN3YXBzNSIsInN3YXBzUHJldjUiLCJsYXN0IiwiYXQiLCJtaW4iLCJub3RpZmllZCIsImN1c3RvbSIsIm5vdGlmeVgiLCJpbmNsdWRlcyIsInNlbGxOb3ciLCJzZWxsTm93RG9uZSIsImJhc2VQeCIsImhpdCIsImZwcCIsImRyb3BOb3ciLCJkcm9wIiwiZHJvcEhpdCIsImRyb3BXYXJuZWRQZWFrIiwiZG9uZTIiLCJ4Tm93IiwicGFydCIsImNlaWwiLCJtYXJrIiwiZmxvb3IiLCJiYWNrRG9uZSIsIm1vb25QZW5kIiwibW9vblBjdCIsIm1vb24iLCJmcmVlQW10IiwibW9vbk5vdGlmeVgiLCJjcmFzaCIsImNyYXNoQWZ0ZXJCYWNrIiwiY3Jhc2hOb3ciLCJjcmFzaEhpdCIsInJvdW5kIiwiYmFja1giLCJwY3QiLCJwYyIsInN0ZXBzIiwiZmluZFRvayIsInEiLCJ0b0xvd2VyQ2FzZSIsImNtZFNlbGwiLCJoYWxmIiwicGFyc2VJbnQiLCJqb2JzIiwib2siLCJlcnJzIiwiQm9vbGVhbiIsImNtZEJhbGFuY2UiLCJsaW5lcyIsImNtZEhvbGQiLCJvdXQiLCJsaW5lIiwiaG9sZFJlcG9ydCIsInRpdGxlIiwicm93cyIsIm5vUG9vbCIsImR1c3QiLCJ0YyIsInR2Iiwid24iLCJzdGF0dXMiLCJzb3J0IiwiY21kU3RhdHMiLCJmcmVlIiwiYm9nIiwicGFpZEMiLCJwYWlkIiwibjJhIiwic3BsaXQiLCJsIiwibSIsIm1hdGNoIiwidHJpbSIsImMiLCJubSIsInRyIiwidHJhZGVzIiwiYnkiLCJ1c2QiLCJuIiwidG90IiwiT2JqZWN0IiwiZW50cmllcyIsInNpemUiXSwic291cmNlcyI6WyJwb3J0Zm9saW8ubWpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIE1vZHVsZTogcG9ydGZvbGlvLiBDb25zdHJ1Y3Rpb24gaXMgaW5lcnQ7IEkvTyBpcyBpbnZva2VkIGV4cGxpY2l0bHkuXG5pbXBvcnQgeyByZWFkRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IHN0cmF0ZWd5S2V5LCB1bml0c1RvRGVjaW1hbCB9IGZyb20gJy4uLy4uL2V4ZWN1dGlvbi1zdGF0ZS5tanMnO1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVBvcnRmb2xpbyhkZXBlbmRlbmNpZXMpIHtcbiAgY29uc3QgeyBMT0csIE1FLCBOQVRJVkVfQk5CLCBSVUxFLCBTLCBUT0tFTlMsIFdBTExFVFMsIGJpZywgYmxhY2tsaXN0LCBibmJVc2QsIGNhbGwsIGZpbmRQYWlyLCBmbG93LCBob25leXBvdENoZWNrLCBsb2csIHJwYywgcnVsZVR4dCwgc2F2ZSwgc3dhcENvbmZpcm1lZCwgdGcsIHRnU2F5LCB0b2tEZWMsIHRzLCB2YWx1ZVVzZCwgd2EgfSA9IGRlcGVuZGVuY2llcztcbiAgY29uc3QgU0VMTElORyA9IG5ldyBTZXQoKTtcblxuICBhc3luYyBmdW5jdGlvbiBzZWxsKHQsIHN0LCBhbXQsIHdoeSwgVyA9IFdBTExFVFNbMF0sIGVmZmVjdCA9IHt9KSB7XG4gICAgY29uc3Qgc2sgPSBXLm5hbWUgKyAnfCcgKyB0LmFkZHI7IGlmIChTRUxMSU5HLmhhcyhzaykpIHJldHVybiBmYWxzZTsgU0VMTElORy5hZGQoc2spOyB0cnkgeyByZXR1cm4gYXdhaXQgc2VsbElubmVyKHQsIHN0LCBhbXQsIHdoeSwgVywgZWZmZWN0KTsgfSBmaW5hbGx5IHsgU0VMTElORy5kZWxldGUoc2spOyB9IC8qIOWvqeafpeS/ruato++8muWQjOS4gOWAi+W5o+WQjOaZguWPquizo+S4gOasoe+8iFRHIOaMh+S7pOWSjOiHquWLleizo+S4jeacg+aSnu+8iSAqL1xuICB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gc2VsbElubmVyKHQsIHN0LCBhbXQsIHdoeSwgVywgZWZmZWN0KSB7XG4gICAgeyBjb25zdCBsaXZlID0gKFMuZHluIHx8IFtdKS5maW5kKCh4KSA9PiB4LmFkZHIgPT09IHQuYWRkciAmJiB4Lm9ubHkgPT09IFcuYWRkcik7IGlmIChsaXZlPy5ob2xkICYmICEv5oyH56S6Ly50ZXN0KHdoeSkpIHsgbG9nKGAke3Quc3ltfSDoqK3lrprngrrnrYnkvb/nlKjogIXpgJrnn6XvvIzkuI3oh6rli5Xos6PvvIgke3doeX3vvIlgKTsgcmV0dXJuIGZhbHNlOyB9IH0gLyog5a+p5p+l5L+u5q2j77ya5Lul5pyA5paw6Kit5a6a54K65rqW77yM6YG/5YWN6IOM5pmv55So6IiK5riF5Zau6LOj5o6J77yI5biB5a6J5peg5b+nIDE5OjU277yJICovXG4gICAgY29uc3QgZGVjID0gYXdhaXQgdG9rRGVjKHQuYWRkciksIHF0eSA9IHVuaXRzVG9EZWNpbWFsKGFtdCwgZGVjKTtcbiAgICBpZiAoYW10IDw9IDBuKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgcmVwb3J0aW5nUHJpY2UgPSBhd2FpdCBibmJVc2QoKTtcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShyZXBvcnRpbmdQcmljZSkgfHwgcmVwb3J0aW5nUHJpY2UgPD0gMCkgdGhyb3cgbmV3IEVycm9yKCfos6Plh7roqJjluLPloLHlg7nkuI3lj6/nlKgnKTtcbiAgICBjb25zdCBtZXRhZGF0YSA9IHsgcHVycG9zZTogJ3NhbGUnLCB3YWxsZXROYW1lOiBXLm5hbWUsIHRva2VuOiB0LmFkZHIsIHN5bTogdC5zeW0sIGNvc3Q6IHQuY29zdCB8fCAwLFxuICAgICAgd2h5LCBibmJQcmljZTogcmVwb3J0aW5nUHJpY2UsIHJlcXVlc3RlZFJhdzogYW10LnRvU3RyaW5nKCksIHN0cmF0ZWd5U3RhdGU6IHN0cnVjdHVyZWRDbG9uZShzdCksIGVmZmVjdCB9O1xuICAgIGNvbnN0IHIgPSBhd2FpdCBzd2FwQ29uZmlybWVkKFcsIFsnbWFya2V0LW9yZGVyJywgJ3N3YXAnLCAnLS1iaW5hbmNlQ2hhaW5JZCcsICc1NicsICctLWZyb21Ub2tlblF0eScsIHF0eSwgJy0tZnJvbVRva2VuJywgdC5hZGRyLCAnLS10b1Rva2VuJywgTkFUSVZFX0JOQl0sIG1ldGFkYXRhKTtcbiAgICBsb2coYOWNliAke3Quc3ltfSAke3F0eX06ICR7ci50LnNsaWNlKDAsIDYwMCl9YCk7XG4gICAgaWYgKCFyLmo/LnN1Y2Nlc3MpIHsgc3Quc2VsbEZhaWwgPSAoc3Quc2VsbEZhaWwgfHwgMCkgKyAxOyBzdC5zZWxsRmFpbEF0ID0gRGF0ZS5ub3coKTsgY29uc3QgbXNnID0gKHIuaj8uZXJyb3I/Lm1lc3NhZ2UgfHwgci50KS5zbGljZSgwLCAyMDApOyBsb2coYFske1cubmFtZX1dICR7dC5zeW19IOizo+WHuuWkseaVl+esrCAke3N0LnNlbGxGYWlsfSDmrKHvvJoke21zZy5yZXBsYWNlKC9cXG4vZywgJyAnKX1gKTtcbiAgICAgIC8qIOS9v+eUqOiAhSAxMC8zMSAwMDozNe+8muS4gOebtOWQteOAguS4jeWIsCAzVSDnmoTlsI/poY3luaPos6PkuI3mjonlrozlhajkuI3pgJrnn6XvvIzoqaYgNiDmrKHlsLHmlL7mo4TvvJvlgLzpjKLnmoTlj6rlnKjnrKwgMSDmrKHpgJrnn6UgKi9cbiAgICAgIGNvbnN0IHNtYWxsID0gKHN0LmN1clYgPz8gOTkpIDwgMztcbiAgICAgIGlmIChzbWFsbCAmJiBzdC5zZWxsRmFpbCA+PSA2KSB7IHN0LnN0YWdlID0gOTsgc3QuZ2F2ZVVwID0gdHMoKTsgbG9nKGBbJHtXLm5hbWV9XSAke3Quc3ltfSDlj6rlgLzntIQgJHsoc3QuY3VyViB8fCAwKS50b0ZpeGVkKDIpfVXvvIzos6PkuoYgNiDmrKHpg73lpLHmlZfvvIzmlL7mo4TkuI3lho3os6NgKTsgfVxuICAgICAgaWYgKCFzbWFsbCAmJiBzdC5zZWxsRmFpbCA9PT0gMSkgYXdhaXQgdGcoYOKaoO+4jyBbJHtXLm5hbWV9XSAke3Quc3ltfSDmg7Pos6PkvYblpLHmlZfvvIgke3doeX3vvIlcXG4ke21zZ31cXG7kuYvlvozmnIPoh6rli5Xph43oqabvvIzkuI3lho3ph43opIfpgJrnn6XvvJvos6PmjonmmYLmnIPnmbwg8J+SsCDpgJrnn6VgKTtcbiAgICAgIHJldHVybiBmYWxzZTsgfVxuICAgIHN0LnNlbGxGYWlsID0gMDtcbiAgICBjb25zdCBnb3QgPSBOdW1iZXIoci5qLmRhdGEudG9Ub2tlbkFjdHVhbFF0eSksIHB4ID0gYXdhaXQgYm5iVXNkKCkuY2F0Y2goKCkgPT4gMCksIGdvdFUgPSBnb3QgKiBweDtcbiAgICBjb25zdCByZWZ1bmRzID0gKHIuai5kYXRhLnJlZnVuZCB8fCBbXSkuZmlsdGVyKCh4KSA9PiB0eXBlb2YgeC5hbW91bnQgPT09ICdzdHJpbmcnICYmIC9eWzAtOV0rKFxcLlswLTldKyk/JC8udGVzdCh4LmFtb3VudCkgJiYgL1sxLTldLy50ZXN0KHguYW1vdW50KSk7XG4gICAgYXdhaXQgdGcoYPCfkrAgWyR7Vy5uYW1lfV0g5bey6LOj5Ye6ICR7dC5zeW1977yIJHt3aHl977yJXFxu5pW46YePICR7cXR5fSR7Z290ID4gMCA/IGBcXG7mj5vlm54gJHtnb3QudG9GaXhlZCg1KX0gQk5C77yI57SEICR7Z290VS50b0ZpeGVkKDIpfVXvvIlgIDogJyd9JHtyZWZ1bmRzLmxlbmd0aCA/ICdcXG7pg6jliIbmiJDkuqTvvIzmnInpgIDlm57vvJonICsgcmVmdW5kcy5tYXAoKHgpID0+IHguYW1vdW50ICsgJyAnICsgeC5zeW1ib2wpLmpvaW4oJ+OAgScpIDogJyd9XFxu5Lqk5piTICR7ci5qLmRhdGEudHhIYXNofVxcbuioguWWriAke3Iuai5kYXRhPy5vcmRlcklkIHx8ICcnfWApO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gaG9sZGluZ3MoaGVhZCwgb25seUZhc3QgPSBmYWxzZSkge1xuICAgIGF3YWl0IFByb21pc2UuYWxsKFdBTExFVFMubWFwKChXKSA9PiBob2xkVyhXLCBoZWFkLCBvbmx5RmFzdCkuY2F0Y2goKGUpID0+IGxvZygnaG9sZGluZ3MgJyArIFcubmFtZSArICcgJyArIGUubWVzc2FnZSkpKSk7XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBob2xkVyhXLCBoZWFkLCBvbmx5RmFzdCkgeyAvLyDmiYDmnInpjKLljIXlkIzmmYLot5HvvIjpgJ/miLDvvJros6Pllq7kuI3mjpLpmorvvIlcbiAgICBmb3IgKGNvbnN0IHQwIG9mIFRPS0VOUy5jb25jYXQoUy5keW4gfHwgW10pKSB7XG4gICAgICBpZiAodDAub25seSAmJiB0MC5vbmx5ICE9PSBXLmFkZHIpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgdCA9IHsgLi4udDAsIGNvc3Q6ICh0MC5vbmx5IHx8IHQwLmJvdGggfHwgVy5hZGRyID09PSBNRSkgPyB0MC5jb3N0IDogMCB9O1xuICAgICAgY29uc3QgZHVwU3ltID0gVE9LRU5TLmNvbmNhdChTLmR5biB8fCBbXSkuZmlsdGVyKCh4KSA9PiAoIXgub25seSB8fCB4Lm9ubHkgPT09IFcuYWRkcikgJiYgeC5zeW0gPT09IHQuc3ltICYmIHguYWRkciAhPT0gdC5hZGRyKS5sZW5ndGggPiAwOyAvKiDlr6nmn6Xkv67mraPvvJrkuI3lkIzluaPlkIzlkI3vvIjlg4/lhanlgIsgNTU144CB5YWp5YCLIENJT1fvvInku6XliY3lhbHnlKjlkIzkuIDku73ntIDpjITvvIzppJjpoY3kvoblm57ot7MgKi9cbiAgICAgIGNvbnN0IGxlZ2FjeUtleSA9IChXLmFkZHIgPT09IE1FID8gdC5zeW0gOiBXLm5hbWUgKyAnOicgKyB0LnN5bSkgKyAoZHVwU3ltID8gJyMnICsgdC5hZGRyLnNsaWNlKDIsIDgpIDogJycpO1xuICAgICAgY29uc3Qga2V5ID0gc3RyYXRlZ3lLZXkoVy5hZGRyLCB0LmFkZHIpO1xuICAgICAgaWYgKCFTLnRva2Vuc1trZXldICYmIFMudG9rZW5zW2xlZ2FjeUtleV0pIFMudG9rZW5zW2tleV0gPSBzdHJ1Y3R1cmVkQ2xvbmUoUy50b2tlbnNbbGVnYWN5S2V5XSk7XG4gICAgICBjb25zdCBzdCA9IChTLnRva2Vuc1trZXldID0gUy50b2tlbnNba2V5XSB8fCB7IGhpc3Q6IFtdLCBwZWFrOiAwLCBwZWFrQXQ6IDAsIHNvbGQ6IDAgfSk7XG4gICAgICBzdC5zdGF0ZUtleSA9IGtleTtcbiAgICAgIGlmIChzdC5yZXZpZXcpIGNvbnRpbnVlO1xuICAgICAgaWYgKG9ubHlGYXN0ICYmICEoc3Qub3BlbkF0ICYmIERhdGUubm93KCkgLSBzdC5vcGVuQXQgPCBSVUxFLmZhc3RNaW4gKiA2MGUzICYmIHN0LnN0YWdlICE9PSA5ICYmICFzdC5kb25lKSkgY29udGludWU7XG4gICAgICBjb25zdCBiYWxSID0gYXdhaXQgY2FsbCh0LmFkZHIsICcweDcwYTA4MjMxJyArIHdhKFcuYWRkcikpOyBpZiAoYmFsUiA9PSBudWxsKSBjb250aW51ZTsgLyog5p+l6Kmi5aSx5pWX5LiN55W25oiQIDDvvIjku6XliY3mnIPkuIDnm7ToqqTloLHjgIzmlLbliLDluaPjgI3vvIkgKi8gY29uc3QgYmFsID0gYmlnKGJhbFIpO1xuICAgICAgY29uc3QgcHJldkJhbCA9IEJpZ0ludChzdC5sYXN0QmFsIHx8ICcwJyk7IHN0Lmxhc3RCYWwgPSBiYWwudG9TdHJpbmcoKTtcbiAgICAgIGlmIChiYWwgPiBwcmV2QmFsICYmIHN0LmJhbEluaXQpIHsgY29uc3QgdjAgPSBhd2FpdCB2YWx1ZVVzZCh0LCBiYWwgLSBwcmV2QmFsKTsgYXdhaXQgdGcoYPCfjoEgWyR7Vy5uYW1lfV0g5pS25YiwICR7dC5zeW19ICR7KE51bWJlcihiYWwgLSBwcmV2QmFsKSAvIDFlMTgpLnRvTG9jYWxlU3RyaW5nKCl9IOmhhiR7djAgIT0gbnVsbCA/ICfvvIzntITlgLwgJyArIHYwLnRvRml4ZWQoMikgKyAnVScgOiAn77yI6YKE5rKS5pyJ5rGg5a2Q5Y+v5Lul5aCx5YO577yJJ31cXG7mnIPoh6rli5Xov73ouaTvvIzliLDpq5jpu57lsLHos6NgKTsgfVxuICAgICAgc3QuYmFsSW5pdCA9IHRydWU7XG4gICAgICBpZiAoYmFsID09PSAwbikgeyBzdC5kb25lID0gdHJ1ZTsgY29udGludWU7IH1cbiAgICAgIGlmIChzdC5wYWlyICYmICFzdC52ZXJpZmllZCAmJiAhc3QucGFpckRzKSB7IGNvbnN0IHJzID0gYXdhaXQgY2FsbChzdC5wYWlyLCAnMHgwOTAyZjFhYycpOyBpZiAocnMgPT0gbnVsbCkgeyAvKiDmn6XoqaLlpLHmlZfvvJrlhYjkuI3liKTmlrcgKi8gfSBlbHNlIGlmIChCaWdJbnQoJzB4JyArIHJzLnNsaWNlKDIsIDY2KSkgPT09IDBuKSB7IGRlbGV0ZSBzdC5wYWlyOyBzdC5jaGVja2VkID0gdHJ1ZTsgfSBpZiAocnMgIT0gbnVsbCkgc3QudmVyaWZpZWQgPSB0cnVlOyB9IC8vIOiIiueJiOiqpOWIpOeahOepuuaxoOWtkOa4heaOiVxuICAgICAgaWYgKCFzdC5wYWlyKSB7XG4gICAgICAgIGNvbnN0IHAgPSBhd2FpdCBmaW5kUGFpcih0KTtcbiAgICAgICAgY29uc3QgZmlyc3QgPSAhc3QuY2hlY2tlZDsgc3QuY2hlY2tlZCA9IHRydWU7XG4gICAgICAgIGlmIChwKSB7IHN0LnBhaXIgPSBwLnBhaXI7IGlmIChwLmRzKSB7IHN0LnBhaXJEcyA9IDE7IHN0LnBhaXJJbmZvID0gYCR7cC5kZXh977yM6LefICR7cC5xdW90ZX0g6YWN5bCNYDsgfSBzdC5vcGVuQXQgPSBzdC5vcGVuQXQgfHwgRGF0ZS5ub3coKTsgc3QuZnJvbUJsb2NrID0gaGVhZCAtIDQwMDsgaWYgKCFmaXJzdCkgYXdhaXQgaG9uZXlwb3RDaGVjayhXLCB0LCBzdCwgYmFsKTsgaWYgKCFmaXJzdCkgYXdhaXQgdGcoYPCfmoAgJHt0LnN5bX0g6ZaL5rGg5LqG77yIJHtzdC5wYWlySW5mbyB8fCAnUGFuY2FrZVN3YXAnfe+8iVxcbuWQiOe0hCAke3QuYWRkcn1cXG7msaDlrZAgJHtwLnBhaXJ9XFxu6ZaL5aeL6L+96Lmk5YO55qC877yM6YGU5Yiw6auY6bue5pyD6Ieq5YuV6LOjYCk7IH1cbiAgICAgICAgZWxzZSB7IGlmICh0MC5kZXBsb3llciAmJiB0MC5ib3VnaHRBdCAmJiBEYXRlLm5vdygpIC0gdDAuYm91Z2h0QXQgPiA0OCAqIDM2MDBlMykgYmxhY2tsaXN0KHQwLmRlcGxveWVyLCBgJHt0LnN5bX0g5omT5a6MIDQ4IOWwj+aZgumChOaykumWi+axoGApOyBjb250aW51ZTsgfVxuICAgICAgfVxuICAgICAgY29uc3QgdiA9IGF3YWl0IHZhbHVlVXNkKHQsIGJhbCk7IGlmICh2ID09IG51bGwpIGNvbnRpbnVlOyBzdC5jdXJWID0gdjtcbiAgICAgIC8vIOeUqOOAjOavj+mhhuWDueagvOOAjeeul+mrmOm7nuWSjOWAjeaVuO+8iOWvqeafpeS/ruato++8muizo+aOieS4gOmDqOWIhuW+jOaMgeWAieiuiuWwke+8jOS4jeacg+WGjeiiq+iqpOWIpOaIkOaatOi3jO+8iVxuICAgICAgY29uc3QgZGVjID0gYXdhaXQgdG9rRGVjKHQuYWRkcik7IGNvbnN0IGJhbE4gPSBOdW1iZXIoYmFsKSAvIDEwICoqIGRlYyB8fCAxZS0xODsgY29uc3QgcHggPSB2IC8gYmFsTjtcbiAgICAgIGlmICghc3QucXR5MCB8fCBiYWxOID4gc3QucXR5MCAqIDEuMDAwMSkgc3QucXR5MCA9IGJhbE47IC8vIOWOn+Wni+aMgeaciemHj1xuICAgICAgY29uc3QgdkZ1bGwgPSBweCAqIHN0LnF0eTA7IC8vIOWmguaenOmChOaLv+iRl+WFqOmDqO+8jOePvuWcqOWAvOWkmuWwke+8iOeulyAz77yPNe+8jzEwIOWAjeeUqO+8iVxuICAgICAgY29uc3QgZnJvbSA9IE1hdGgubWF4KHN0LmZyb21CbG9jayB8fCBoZWFkIC0gMjAsIGhlYWQgLSAyMDAwKTsgY29uc3QgZiA9IGF3YWl0IGZsb3codCwgc3QsIGZyb20sIGhlYWQpOyBzdC5mcm9tQmxvY2sgPSBoZWFkICsgMTtcbiAgICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7IHN0Lmhpc3QucHVzaCh7IHQ6IG5vdywgdiwgZnJlc2g6IGYuZnJlc2gsIHN3YXBzOiBmLnN3YXBzIH0pOyBzdC5oaXN0ID0gc3QuaGlzdC5maWx0ZXIoKGgpID0+IG5vdyAtIGgudCA8IDIwICogNjBlMyk7XG4gICAgICBpZiAodiA+IHN0LnBlYWspIHsgc3QucGVhayA9IHY7IHN0LnBlYWtBdCA9IG5vdzsgfVxuICAgICAgaWYgKHB4ID4gKHN0LnBwZWFrIHx8IDApKSB7IHN0LnBwZWFrID0gcHg7IHN0LnBwZWFrQXQgPSBub3c7IH1cbiAgICAgIGNvbnN0IHN1bSA9IChhLCBiLCBrKSA9PiBzdC5oaXN0LmZpbHRlcigoaCkgPT4gbm93IC0gaC50ID49IGEgKiAxMDAwICYmIG5vdyAtIGgudCA8IGIgKiAxMDAwKS5yZWR1Y2UoKHMsIGgpID0+IHMgKyBoW2tdLCAwKTtcbiAgICAgIGNvbnN0IGZyZXNoNSA9IHN1bSgwLCAzMDAsICdmcmVzaCcpLCBzd2FwczUgPSBzdW0oMCwgMzAwLCAnc3dhcHMnKSwgc3dhcHNQcmV2NSA9IHN1bSgzMDAsIDYwMCwgJ3N3YXBzJyk7XG4gICAgICBpZiAoc3Quc3RhZ2UgPT0gbnVsbCkgc3Quc3RhZ2UgPSBzdC5zb2xkID49IDIgPyA5IDogc3Quc29sZCA9PT0gMSA/IDEgOiAwOyAvLyDoiIrniYjni4DmhYvmj5vnrpdcbiAgICAgIGlmIChzdC5zdGFnZSA+PSA5KSB7IHN0Lmxhc3QgPSB7IHYsIGF0OiB0cygpIH07IGNvbnRpbnVlOyB9XG4gICAgICBpZiAoc3Quc2VsbEZhaWwgJiYgbm93IC0gKHN0LnNlbGxGYWlsQXQgfHwgMCkgPCBNYXRoLm1pbigyLCAyICoqIChzdC5zZWxsRmFpbCAtIDEpKSAqIDYwZTMpIHsgc3QubGFzdCA9IHsgdiwgYXQ6IHRzKCkgfTsgY29udGludWU7IH0gLy8g6LOj5LiN5o6J77yaMeOAgTLjgIE04oCm5pyA5aSaIDE1IOWIhumQmOW+jOWGjeippu+8jOS4jeeLgumHjeipplxuICAgICAgc3Qubm90aWZpZWQgPSBzdC5ub3RpZmllZCB8fCBbXTtcbiAgICAgIGlmICh0LmNvc3QgPiAwICYmICF0LmhvbGQgJiYgIXQuY3VzdG9tKSBmb3IgKGNvbnN0IHggb2YgUlVMRS5ub3RpZnlYKSBpZiAodkZ1bGwgPj0gdC5jb3N0ICogeCAmJiAhc3Qubm90aWZpZWQuaW5jbHVkZXMoeCkpIHsgc3Qubm90aWZpZWQucHVzaCh4KTsgYXdhaXQgdGcoYPCflKUgWyR7Vy5uYW1lfV0gJHt0LnN5bX0g5YiwICR7eH0g5YCN5LqG77yB77yI5oiQ5pysICR7dC5jb3N0fVXvvIznj77lnKjmjIHlgInntIQgJHt2LnRvRml4ZWQoMil9Ve+8iVxcbueFp+imj+WJh++8miR7cnVsZVR4dCgpfWApOyB9XG4gICAgICBpZiAodC5zZWxsTm93KSB7IGlmICghc3Quc2VsbE5vd0RvbmUpIHsgYXdhaXQgc2VsbCh0LCBzdCwgYmFsLCAn5L2g5oyH56S65YWo6YOo6LOj5Ye6JywgVywgeyBzZWxsTm93RG9uZTogdHJ1ZSwgc3RhZ2U6IDkgfSk7IH0gY29udGludWU7IH1cbiAgICAgIGlmICghKHQuY29zdCA+IDApIHx8IHQuaG9sZCkgeyAvLyDlhY3osrvnmoTjgIHmiJbkvb/nlKjogIXoqqrlhYjliKXos6PnmoRcbiAgICAgICAgaWYgKCFzdC5iYXNlUHgpIHN0LmJhc2VQeCA9IHB4OyAvLyDlhY3osrvluaPku6XplovmsaDlvoznrKzkuIDlgIvlg7nmoLznlbbln7rmupZcbiAgICAgICAgZm9yIChjb25zdCB4IG9mIFJVTEUubm90aWZ5WCkgeyBjb25zdCBoaXQgPSB0LmhvbGQgJiYgdC5jb3N0ID4gMCA/IHZGdWxsID49IHQuY29zdCAqIHggOiBweCA+PSBzdC5iYXNlUHggKiB4OyAvKiDlr6nmn6UgMTEvMe+8muaIkOacrCAwIOeahCBob2xkIOW5o+acg+S4gOasoeiqpOWgsSA177yPMTDvvI8yMCDlgI0gKi8gaWYgKGhpdCAmJiAhc3Qubm90aWZpZWQuaW5jbHVkZXMoeCkpIHsgc3Qubm90aWZpZWQucHVzaCh4KTsgYXdhaXQgdGcoYPCflKUgWyR7Vy5uYW1lfV0gJHt0LmhvbGQgPyAnJyA6ICflhY3osrvluaMgJ30ke3Quc3ltfSDmvLLliLAke3QuaG9sZCA/ICfmiJDmnKwnIDogJ+mWi+axoOWDuSd955qEICR7eH0g5YCN77yB5biC5YC857SEICR7di50b0ZpeGVkKDIpfVVcXG4ke3QuaG9sZCA/ICfkvaDoqqrlhYjliKXos6PvvIzopoHos6PlnKggVEcg5omT44CM6LOjICcgKyB0LnN5bSArICfjgI0nIDogJ+W+nuacgOmrmOWDueWbnuiQvSA1MCUg5pyD6Ieq5YuV5YWo6LOj77yb5oOz5YWI6LOj5ZyoIFRHIOaJk+OAjOizoyAnICsgdC5zeW0gKyAn44CNJ31gKTsgfSB9XG4gICAgICAgIGlmIChzdC5vcGVuQXQgJiYgbm93IC0gc3Qub3BlbkF0ID49IDE4MGUzICYmIHB4ID4gKHN0LmZwcCB8fCAwKSkgc3QuZnBwID0gcHg7IC8vIOmWi+ebpCAzIOWIhumQmOW+jOaJjemWi+Wni+eul+acgOmrmOWDuVxuICAgICAgICBjb25zdCBkcm9wTm93ID0gIXQuaG9sZCAmJiBzdC5mcHAgPiAwICYmIHB4IDwgc3QuZnBwICogKDEgLSBSVUxFLmRyb3ApICYmIHYgPj0gMC4zOyBzdC5kcm9wSGl0ID0gZHJvcE5vdyA/IChzdC5kcm9wSGl0IHx8IDApICsgMSA6IDA7IC8qIOWvqeafpSAxMS8x77ya6YCj57qMIDIg5qyh5omN566X77yM6YG/5YWN5YO55qC85L6G5rqQ6Lez5YuV5YGH5bSp55ukICovXG4gICAgICAgIGlmIChkcm9wTm93ICYmIHN0LmRyb3BIaXQgPj0gMikgeyAvLyDlhY3osrvluaPlvp7mnIDpq5jlg7nlm57okL0gNTAlIOWFqOizo1xuICAgICAgICAgIGlmIChhd2FpdCBzZWxsKHQsIHN0LCBiYWwsIGDlhY3osrvluaPlvp7mnIDpq5jlg7nlm57okL0gNTAl77yM5YWo6YOo6LOj5Ye677yI57SEICR7di50b0ZpeGVkKDIpfVXvvIlgLCBXLCB7IHN0YWdlOiA5IH0pKSB7IGNvbnRpbnVlOyB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHQuaG9sZCAmJiBweCA8IHN0LnBwZWFrICogKDEgLSBSVUxFLmRyb3ApICYmIHN0LmRyb3BXYXJuZWRQZWFrICE9PSBzdC5wcGVhaykgeyBzdC5kcm9wV2FybmVkUGVhayA9IHN0LnBwZWFrOyBhd2FpdCB0Zyhg4pqg77iPIFske1cubmFtZX1dICR7dC5zeW19IOW+nuacgOmrmOWDueWbnuiqvyA1MCXvvIznj77lnKjntIQgJHt2LnRvRml4ZWQoMil9VVxcbuS9oOiqquWFiOWIpeizo++8jOS4jeacg+iHquWLleizo++8jOimgeizo+WcqCBURyDmiZPjgIzos6MgJHt0LnN5bX3jgI1gKTsgfVxuICAgICAgICBzdC5sYXN0ID0geyB2LCBhdDogdHMoKSB9OyBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmICh2IDwgMC4zKSB7IHN0Lmxhc3QgPSB7IHYsIGF0OiB0cygpIH07IGNvbnRpbnVlOyB9IC8vIOWJqeS4i+S4jeWIsCAwLjNVIOeahOeBsOWhteS4jeizo++8iOizo+S6huS4jeWkoOaJi+e6jOiyu++8iVxuICAgICAgc3QuZG9uZTIgPSBzdC5kb25lMiB8fCBbXTtcbiAgICAgIGlmICh0LmN1c3RvbSA9PT0gJ2Zpc3QnKSB7IC8qIOS9v+eUqOiAhSAxMC8zMSAyMDozOe+8mkZJU1RBR0VOVCDnibnmroropo/liYfigJTigJQ1IOWAjeizo+WbnuacrOmMouOAgTEwIOWAjeizoyAzMCXjgIEyMCDlgI3ku6XkuIrlj6rnmbwgVEcg6YCa55+l77yM5YW25LuW6Ieq5YuV6LOj5Ye66KaP5YmH6YO95LiN55SoICovXG4gICAgICAgIGNvbnN0IHhOb3cgPSB2RnVsbCAvIHQuY29zdDtcbiAgICAgICAgaWYgKHhOb3cgPCAwLjUgJiYgIXN0LmRvbmUyLmluY2x1ZGVzKCdjdycpKSB7IHN0LmRvbmUyLnB1c2goJ2N3Jyk7IGF3YWl0IHRnKGDimqDvuI8gWyR7Vy5uYW1lfV0gRklTVEFHRU5UIOi3jOegtOaIkOacrOS4gOWNiuS6hu+8iOaIkOacrCAke3QuY29zdH1V77yM54++5Zyo57SEICR7di50b0ZpeGVkKDIpfVXvvIlcXG7kvaDnmoToqK3lrprmspLmnInjgIzmmrTot4zlsLHos6PjgI3vvIzkuI3mnIPoh6rli5Xos6PvvJvopoHos6PlnKggVEcg5omT44CM6LOjIEZJU1RBR0VOVOOAjWApOyB9IC8qIOmZpOmMryAxMS8x77ya5Y+q5pyJ5LiK5ryy55uu5qiZ55qE54m55q6K6KaP5YmH5rKS5pyJ5Lu75L2V5LiL6LeM5o+Q6YaS77yMTk9WIOi3jCA4OCUg6YO95rKS6YCa55+lICovXG4gICAgICAgIGlmICh4Tm93ID49IDUgJiYgIXN0LmRvbmUyLmluY2x1ZGVzKCdmNScpKSB7IGNvbnN0IHBhcnQgPSAoYmFsICogQmlnSW50KE1hdGgubWF4KDEsIE1hdGgubWluKDEwMCwgTWF0aC5jZWlsKCh0LmNvc3QgLyB2KSAqIDEwMCkpKSkpIC8gMTAwbjsgYXdhaXQgc2VsbCh0LCBzdCwgcGFydCwgYEZJU1RBR0VOVCDliLAgNSDlgI3vvIzos6Plm57mnKzpjKIgJHt0LmNvc3R9Ve+8iOaMgeWAiee0hCAke3YudG9GaXhlZCgyKX1V77yJYCwgVywgeyBtYXJrOiAnZjUnIH0pOyB9XG4gICAgICAgIGVsc2UgaWYgKHhOb3cgPj0gMTAgJiYgIXN0LmRvbmUyLmluY2x1ZGVzKCdmMTAnKSkgeyBhd2FpdCBzZWxsKHQsIHN0LCAoYmFsICogMzBuKSAvIDEwMG4sIGBGSVNUQUdFTlQg5YiwIDEwIOWAje+8jOizo+WHuiAzMCXvvIjmjIHlgInntIQgJHt2LnRvRml4ZWQoMil9Ve+8iWAsIFcsIHsgbWFyazogJ2YxMCcgfSk7IH1cbiAgICAgICAgZWxzZSBpZiAoeE5vdyA+PSAyMCAmJiAhc3QuZG9uZTIuaW5jbHVkZXMoJ2YyMCcpKSB7IHN0LmRvbmUyLnB1c2goJ2YyMCcpOyBhd2FpdCB0Zyhg8J+UpSBbJHtXLm5hbWV9XSBGSVNUQUdFTlQg5YiwICR7TWF0aC5mbG9vcih4Tm93KX0g5YCN5LqG77yB77yI5oiQ5pysICR7dC5jb3N0fVXvvIznj77lnKjmjIHlgInntIQgJHt2LnRvRml4ZWQoMil9Ve+8iVxcbueFp+S9oOeahOioreWumiAyMCDlgI3ku6XkuIrkuI3oh6rli5Xos6PvvIzopoHos6PlnKggVEcg5omT44CM6LOjIEZJU1RBR0VOVOOAjeaIluOAjOizoyBGSVNUQUdFTlQg5LiA5Y2K44CNYCk7IH1cbiAgICAgICAgc3QubGFzdCA9IHsgdiwgYXQ6IHRzKCkgfTsgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAodC5jdXN0b20gPT09ICdub3ZhJykgeyAvKiDkvb/nlKjogIUgMTAvMzEgMjM6MTjvvJpOT1ZBIDUg5YCN6LOj5Zue5pys6Yyi77yMMTAg5YCN55m8IFRHIOmAmuefpe+8jOS4jeiHquWLleizo+WFtuS7liAqL1xuICAgICAgICBjb25zdCB4Tm93ID0gdkZ1bGwgLyB0LmNvc3Q7XG4gICAgICAgIGlmICh4Tm93IDwgMC41ICYmICFzdC5kb25lMi5pbmNsdWRlcygnY3cnKSkgeyBzdC5kb25lMi5wdXNoKCdjdycpOyBhd2FpdCB0Zyhg4pqg77iPIFske1cubmFtZX1dIE5PVkEg6LeM56C05oiQ5pys5LiA5Y2K5LqG77yI5oiQ5pysICR7dC5jb3N0fVXvvIznj77lnKjntIQgJHt2LnRvRml4ZWQoMil9Ve+8iVxcbuS9oOeahOioreWumuaykuacieOAjOaatOi3jOWwseizo+OAje+8jOS4jeacg+iHquWLleizo++8m+imgeizo+WcqCBURyDmiZPjgIzos6MgTk9W44CNYCk7IH0gLyog6Zmk6YyvIDExLzHvvJrlj6rmnInkuIrmvLLnm67mqJnnmoTnibnmroropo/liYfmspLmnInku7vkvZXkuIvot4zmj5DphpLvvIxOT1Yg6LeMIDg4JSDpg73mspLpgJrnn6UgKi9cbiAgICAgICAgaWYgKHhOb3cgPj0gNSAmJiAhc3QuZG9uZTIuaW5jbHVkZXMoJ241JykpIHsgY29uc3QgcGFydCA9IChiYWwgKiBCaWdJbnQoTWF0aC5tYXgoMSwgTWF0aC5taW4oMTAwLCBNYXRoLmNlaWwoKHQuY29zdCAvIHYpICogMTAwKSkpKSkgLyAxMDBuOyBhd2FpdCBzZWxsKHQsIHN0LCBwYXJ0LCBgTk9WQSDliLAgNSDlgI3vvIzos6Plm57mnKzpjKIgJHt0LmNvc3R9Ve+8iOaMgeWAiee0hCAke3YudG9GaXhlZCgyKX1V77yJYCwgVywgeyBtYXJrOiAnbjUnIH0pOyB9XG4gICAgICAgIGVsc2UgaWYgKHhOb3cgPj0gMTAgJiYgIXN0LmRvbmUyLmluY2x1ZGVzKCduMTAnKSkgeyBzdC5kb25lMi5wdXNoKCduMTAnKTsgYXdhaXQgdGcoYPCflKUgWyR7Vy5uYW1lfV0gTk9WQSDliLAgJHtNYXRoLmZsb29yKHhOb3cpfSDlgI3kuobvvIHvvIjmiJDmnKwgJHt0LmNvc3R9Ve+8jOePvuWcqOaMgeWAiee0hCAke3YudG9GaXhlZCgyKX1V77yJXFxu54Wn5L2g55qE6Kit5a6a5LiN6Ieq5YuV6LOj77yM6KaB6LOj5ZyoIFRHIOaJk+OAjOizoyBOT1bjgI3miJbjgIzos6MgTk9WIOS4gOWNiuOAjWApOyB9XG4gICAgICAgIHN0Lmxhc3QgPSB7IHYsIGF0OiB0cygpIH07IGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgYmFja0RvbmUgPSBzdC5kb25lMi5pbmNsdWRlcygnYmFjaycpO1xuICAgICAgaWYgKGJhY2tEb25lICYmIHN0Lm1vb25QZW5kICYmIFJVTEUubW9vblBjdCkgeyBzdC5tb29uID0gKChiYWwgKiBCaWdJbnQoUlVMRS5tb29uUGN0KSkgLyAxMDBuKS50b1N0cmluZygpOyBkZWxldGUgc3QubW9vblBlbmQ7IGxvZyhgWyR7Vy5uYW1lfV0gJHt0LnN5bX0g5Zue5pys5b6M55WZICR7UlVMRS5tb29uUGN0fSUg6ZW35oqx77yI5LiN6Ieq5YuV6LOj77yMNTDvvI8xMDAg5YCN6YCa55+l77yJYCk7IH1cbiAgICAgIGNvbnN0IG1vb24gPSBiYWNrRG9uZSAmJiBzdC5tb29uID8gQmlnSW50KHN0Lm1vb24pIDogMG47IGNvbnN0IGZyZWVBbXQgPSBiYWwgPiBtb29uID8gYmFsIC0gbW9vbiA6IDBuO1xuICAgICAgaWYgKG1vb24gPiAwbiAmJiBmcmVlQW10ICogNTBuIDw9IG1vb24pIHsgLyog5Y+q5Ymp6ZW35oqx6YKj5Lu977ya5LiN6Ieq5YuV6LOj77yM5YiwIDUw77yPMTAwIOWAjemAmuefpSAqL1xuICAgICAgICBmb3IgKGNvbnN0IHggb2YgUlVMRS5tb29uTm90aWZ5WCB8fCBbXSkgaWYgKHZGdWxsID49IHQuY29zdCAqIHggJiYgIXN0LmRvbmUyLmluY2x1ZGVzKCdtJyArIHgpKSB7IHN0LmRvbmUyLnB1c2goJ20nICsgeCk7IGF3YWl0IHRnKGDwn5SlIFske1cubmFtZX1dICR7dC5zeW19IOmVt+aKsemCo+S7veWIsCAke3h9IOWAjeS6hu+8ge+8iOaIkOacrCAke3QuY29zdH1V77yM54++5Zyo57SEICR7di50b0ZpeGVkKDIpfVXvvIlcXG7nhafoqK3lrprkuI3oh6rli5Xos6PvvIzopoHos6PlnKggVEcg5omT44CM6LOjICR7dC5zeW1944CN5oiW44CM6LOjICR7dC5zeW19IOS4gOWNiuOAjWApOyB9XG4gICAgICAgIHN0Lmxhc3QgPSB7IHYsIGF0OiB0cygpIH07IGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgY3Jhc2ggPSBiYWNrRG9uZSA/IChSVUxFLmNyYXNoQWZ0ZXJCYWNrIHx8IFJVTEUuY3Jhc2gpIDogUlVMRS5jcmFzaDsgLyog5L2/55So6ICFIDExLzEgMTM6NTTvvJrlm57mnKzliY3lm57okL0gNDAlIOWFqOizo++8m+WbnuacrOW+jOaUvuWvrOWIsCA2MCUgKi9cbiAgICAgIGNvbnN0IGNyYXNoTm93ID0gc3QucHBlYWsgPiAwICYmIHB4IDwgc3QucHBlYWsgKiAoMSAtIGNyYXNoKTsgc3QuY3Jhc2hIaXQgPSBjcmFzaE5vdyA/IChzdC5jcmFzaEhpdCB8fCAwKSArIDEgOiAwOyAvKiDlr6nmn6UgMTEvMe+8muWDueagvOS+hua6kOWBtueIvui3s+WIsOW+iOWwj+eahOaxoOWtkOacg+WBh+W0qeebpCDihpIg6KaB6YCj57qMIDIg5qyh6YO95L2O5pa86ZaA5qq75omN5YWo6LOjICovXG4gICAgICBpZiAoY3Jhc2hOb3cgJiYgc3QuY3Jhc2hIaXQgPj0gMikge1xuICAgICAgICBhd2FpdCBzZWxsKHQsIHN0LCBtb29uID4gMG4gPyBmcmVlQW10IDogYmFsLCBg5b6e5pyA6auY5YO55Zue6JC9ICR7TWF0aC5yb3VuZChjcmFzaCAqIDEwMCl9Je+8jCR7bW9vbiA+IDBuID8gYOizo+WHuumVt+aKseS7peWklueahOmDqOWIhu+8iOeVmSAke1JVTEUubW9vblBjdH0lIOmVt+aKse+8iWAgOiAn5YWo6YOo6LOj5Ye6J33vvIjntIQgJHt2LnRvRml4ZWQoMil9Ve+8iWAsIFcsIG1vb24gPiAwbiA/IHt9IDogeyBzdGFnZTogOSB9KTtcbiAgICAgIH0gZWxzZSBpZiAoIWJhY2tEb25lICYmIHZGdWxsID49IHQuY29zdCAqIFJVTEUuYmFja1gpIHtcbiAgICAgICAgY29uc3QgcGN0ID0gTWF0aC5taW4oMTAwLCBNYXRoLmNlaWwoKHQuY29zdCAvIHYpICogMTAwICogMS4wMykpO1xuICAgICAgICBhd2FpdCBzZWxsKHQsIHN0LCAoYmFsICogQmlnSW50KHBjdCkpIC8gMTAwbiwgYOWIsCAke1JVTEUuYmFja1h9IOWAje+8jOizoyAke3BjdH0lIOaLv+WbnuacrOmMoiAke3QuY29zdH1V77yI5oyB5YCJ57SEICR7di50b0ZpeGVkKDIpfVXvvIlgLCBXLCB7IG1hcms6ICdiYWNrJywgbW9vblBlbmQ6IHBjdCA8IDEwMCB9KTtcbiAgICAgIH0gZWxzZSBmb3IgKGNvbnN0IFt4LCBwY10gb2YgUlVMRS5zdGVwcykge1xuICAgICAgICBpZiAoIXN0LmRvbmUyLmluY2x1ZGVzKCdzJyArIHgpICYmICEoeCA9PT0gMTAgJiYgc3QuZG9uZTIuaW5jbHVkZXMoJ2gxMCcpKSAmJiB2RnVsbCA+PSB0LmNvc3QgKiB4KSB7IGF3YWl0IHNlbGwodCwgc3QsICgobW9vbiA+IDBuID8gZnJlZUFtdCA6IGJhbCkgKiBCaWdJbnQocGMpKSAvIDEwMG4sIGDliLAgJHt4fSDlgI3vvIzos6Plh7ogJHtwY30lJHttb29uID4gMG4gPyAn77yI6ZW35oqx6YKj5Lu95LiN5YuV77yJJyA6ICcnfe+8iOaMgeWAiee0hCAke3YudG9GaXhlZCgyKX1V77yJYCwgVywgeyBtYXJrOiAncycgKyB4IH0pOyBicmVhazsgfVxuICAgICAgfVxuICAgICAgc3QubGFzdCA9IHsgdiwgZnJlc2g1LCBzd2FwczUsIHN3YXBzUHJldjUsIGF0OiB0cygpIH07XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gZmluZFRvayhxLCBXKSB7XG4gICAgcSA9IHEudG9Mb3dlckNhc2UoKTtcbiAgICByZXR1cm4gVE9LRU5TLmNvbmNhdChTLmR5biB8fCBbXSkuZmluZCgodCkgPT4gKCF0Lm9ubHkgfHwgdC5vbmx5ID09PSBXLmFkZHIpICYmICh0LnN5bS50b0xvd2VyQ2FzZSgpID09PSBxIHx8IHQuYWRkciA9PT0gcSkpO1xuICB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gY21kU2VsbChxLCBoYWxmKSB7XG4gICAgY29uc3QgaGVhZCA9IHBhcnNlSW50KGF3YWl0IHJwYygnZXRoX2Jsb2NrTnVtYmVyJywgW10pLCAxNik7XG4gICAgY29uc3Qgam9icyA9IFdBTExFVFMubWFwKGFzeW5jIChXKSA9PiB7XG4gICAgICBjb25zdCB0MCA9IGZpbmRUb2socSwgVyk7IGlmICghdDApIHJldHVybiBgWyR7Vy5uYW1lfV0g5om+5LiN5YiwICR7cX1gO1xuICAgICAgY29uc3QgYmFsID0gYmlnKGF3YWl0IGNhbGwodDAuYWRkciwgJzB4NzBhMDgyMzEnICsgd2EoVy5hZGRyKSkpOyBpZiAoYmFsID09PSAwbikgcmV0dXJuIGBbJHtXLm5hbWV9XSDmspLmnIkgJHt0MC5zeW19YDtcbiAgICAgIGNvbnN0IGR1cFN5bSA9IFRPS0VOUy5jb25jYXQoUy5keW4gfHwgW10pLmZpbHRlcigoeCkgPT4gKCF4Lm9ubHkgfHwgeC5vbmx5ID09PSBXLmFkZHIpICYmIHguc3ltID09PSB0MC5zeW0gJiYgeC5hZGRyICE9PSB0MC5hZGRyKS5sZW5ndGggPiAwO1xuICAgICAgY29uc3QgbGVnYWN5S2V5ID0gKFcuYWRkciA9PT0gTUUgPyB0MC5zeW0gOiBXLm5hbWUgKyAnOicgKyB0MC5zeW0pICsgKGR1cFN5bSA/ICcjJyArIHQwLmFkZHIuc2xpY2UoMiwgOCkgOiAnJyk7XG4gICAgICBjb25zdCBrZXkgPSBzdHJhdGVneUtleShXLmFkZHIsIHQwLmFkZHIpO1xuICAgICAgaWYgKCFTLnRva2Vuc1trZXldICYmIFMudG9rZW5zW2xlZ2FjeUtleV0pIFMudG9rZW5zW2tleV0gPSBzdHJ1Y3R1cmVkQ2xvbmUoUy50b2tlbnNbbGVnYWN5S2V5XSk7XG4gICAgICBjb25zdCBzdCA9IChTLnRva2Vuc1trZXldID0gUy50b2tlbnNba2V5XSB8fCB7IGhpc3Q6IFtdLCBwZWFrOiAwLCBwZWFrQXQ6IDAsIHNvbGQ6IDAgfSk7XG4gICAgICBjb25zdCBvayA9IGF3YWl0IHNlbGwodDAsIHN0LCBoYWxmID8gYmFsIC8gMm4gOiBiYWwsIGhhbGYgPyAn5L2g5ZyoIFRHIOaMh+ekuuizo+S4gOWNiicgOiAn5L2g5ZyoIFRHIOaMh+ekuuWFqOmDqOizo+WHuicsIFcsIGhhbGYgPyB7fSA6IHsgc3RhZ2U6IDksIGRvbmU6IHRydWUgfSk7XG4gICAgICByZXR1cm4gb2sgPyBudWxsIDogYFske1cubmFtZX1dICR7dDAuc3ltfSDos6Plh7rlpLHmlZdgO1xuICAgIH0pO1xuICAgIGNvbnN0IGVycnMgPSAoYXdhaXQgUHJvbWlzZS5hbGwoam9icykpLmZpbHRlcihCb29sZWFuKTsgc2F2ZSgpO1xuICAgIGlmIChlcnJzLmxlbmd0aCkgYXdhaXQgdGdTYXkoJ+KaoO+4jyAnICsgZXJycy5qb2luKCdcXG4nKSk7XG4gICAgdm9pZCBoZWFkO1xuICB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gY21kQmFsYW5jZSgpIHtcbiAgICBjb25zdCBsaW5lcyA9IGF3YWl0IFByb21pc2UuYWxsKFdBTExFVFMubWFwKGFzeW5jIChXKSA9PiB7IGNvbnN0IGIgPSBOdW1iZXIoQmlnSW50KGF3YWl0IHJwYygnZXRoX2dldEJhbGFuY2UnLCBbVy5hZGRyLCAnbGF0ZXN0J10pKSkgLyAxZTE4OyByZXR1cm4gYCR7Vy5uYW1lfe+8miR7Yi50b0ZpeGVkKDUpfSBCTkJgOyB9KSk7XG4gICAgYXdhaXQgdGdTYXkoJ/Cfkrwg6Yyi5YyF6aSY6aGNXFxuJyArIGxpbmVzLmpvaW4oJ1xcbicpKTtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIGNtZEhvbGQoKSB7XG4gICAgY29uc3Qgb3V0ID0gW107XG4gICAgZm9yIChjb25zdCBXIG9mIFdBTExFVFMpIGZvciAoY29uc3QgdDAgb2YgVE9LRU5TLmNvbmNhdChTLmR5biB8fCBbXSkpIHtcbiAgICAgIGlmICh0MC5vbmx5ICYmIHQwLm9ubHkgIT09IFcuYWRkcikgY29udGludWU7XG4gICAgICBjb25zdCBiYWwgPSBiaWcoYXdhaXQgY2FsbCh0MC5hZGRyLCAnMHg3MGEwODIzMScgKyB3YShXLmFkZHIpKSk7IGlmIChiYWwgPT09IDBuKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHYgPSBhd2FpdCB2YWx1ZVVzZCh0MCwgYmFsKS5jYXRjaCgoKSA9PiBudWxsKTsgY29uc3QgbGluZSA9IGBbJHtXLm5hbWV9XSAke3QwLnN5bX3vvJoke3YgPT0gbnVsbCA/ICfpgoTmspLmnInmsaDlrZAnIDogJ+e0hCAnICsgdi50b0ZpeGVkKDIpICsgJ1UnfWA7XG4gICAgICBpZiAoIW91dC5pbmNsdWRlcyhsaW5lKSkgb3V0LnB1c2gobGluZSk7XG4gICAgfVxuICAgIGF3YWl0IHRnU2F5KCfwn5OmIOmChOaykuizo+eahOW5o1xcbicgKyAob3V0Lmxlbmd0aCA/IG91dC5qb2luKCdcXG4nKSA6ICfmspLmnIknKSArICdcXG7vvIhORlQg5LiN5Zyo6YCZ6KOh77yMTkZUIOaIkOS6pOmHj+iuiuWkmuacg+WPpuWklumAmuefpe+8iScpO1xuICB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gaG9sZFJlcG9ydCh0aXRsZSA9ICfwn5OmIOaMgeWAiee4vee1kCcpIHsgLyog5L2/55So6ICFIDExLzEgMDM6MTnvvJrmr48gMTIg5bCP5pmC77yI5YeM5pmoIDEg6bue44CB5LiL5Y2IIDEg6bue77yb5L2/55So6ICFIDExLzEgMDM6MzYg5pS577yJ55m85LiA5qyh5oyB5YCJ57i957WQ77ya5oiQ5pys44CB54++5YC844CB5YCN5pW444CB54uA5oWLICovXG4gICAgY29uc3Qgcm93cyA9IFtdLCBub1Bvb2wgPSBbXSwgZHVzdCA9IFtdOyBsZXQgdGMgPSAwLCB0diA9IDA7XG4gICAgZm9yIChjb25zdCBXIG9mIFdBTExFVFMpIGZvciAoY29uc3QgdDAgb2YgVE9LRU5TLmNvbmNhdChTLmR5biB8fCBbXSkpIHtcbiAgICAgIGlmICh0MC5vbmx5ICYmIHQwLm9ubHkgIT09IFcuYWRkcikgY29udGludWU7XG4gICAgICBjb25zdCBiYWwgPSBiaWcoYXdhaXQgY2FsbCh0MC5hZGRyLCAnMHg3MGEwODIzMScgKyB3YShXLmFkZHIpKS5jYXRjaCgoKSA9PiBudWxsKSk7IGlmICghKGJhbCA+IDBuKSkgY29udGludWU7XG4gICAgICBjb25zdCB2ID0gYXdhaXQgdmFsdWVVc2QodDAsIGJhbCkuY2F0Y2goKCkgPT4gbnVsbCk7IGNvbnN0IHduID0gVyA9PT0gV0FMTEVUU1swXSA/ICdBJyA6ICdCJztcbiAgICAgIGlmICh2ID09IG51bGwpIHsgaWYgKCFub1Bvb2wuaW5jbHVkZXModDAuc3ltKSkgbm9Qb29sLnB1c2godDAuc3ltKTsgY29udGludWU7IH1cbiAgICAgIGlmICh2IDwgMC4zKSB7IGlmICghZHVzdC5pbmNsdWRlcyh0MC5zeW0pKSBkdXN0LnB1c2godDAuc3ltKTsgY29udGludWU7IH1cbiAgICAgIGNvbnN0IHN0ID0gKFMudG9rZW5zIHx8IHt9KVt0MC5zeW1dIHx8IChTLnRva2VucyB8fCB7fSlbVy5uYW1lICsgJzonICsgdDAuc3ltXSB8fCB7fTsgY29uc3QgY29zdCA9IE51bWJlcih0MC5jb3N0KSB8fCAwOyBjb25zdCB4ID0gY29zdCA+IDAgPyB2IC8gY29zdCA6IDA7XG4gICAgICBjb25zdCBzdGF0dXMgPSB0MC5ob2xkID8gJ+WPqumAmuefpScgOiB0MC5jdXN0b20gPyAn54m55q6K6KaP5YmHJyA6IChzdC5kb25lMiB8fCBbXSkuaW5jbHVkZXMoJ2JhY2snKSA/IChzdC5tb29uID8gYOW3suWbnuacrO+8jOWQqyAke1JVTEUubW9vblBjdH0lIOmVt+aKsWAgOiAn5bey5Zue5pys77yM54Wn562W55Wl5oyB5pyJJykgOiBjb3N0ID4gMCA/ICfnhafnrZbnlaXmjIHmnIknIDogJ+WFjeiyu+W5oyc7XG4gICAgICB0YyArPSBjb3N0OyB0diArPSB2OyByb3dzLnB1c2goeyB2LCBsaW5lOiBgJHt0MC5zeW1977yI6Yyi5YyFJHt3bn3vvIkke2Nvc3QgPiAwID8gYOaIkOacrCAke2Nvc3QudG9GaXhlZCgxKX1VIOKGkiBgIDogJyd957SEICR7di50b0ZpeGVkKDIpfVUke3ggPyBg77yIJHt4LnRvRml4ZWQoMil9IOWAje+8iWAgOiAnJ30gwrcgJHtzdGF0dXN9YCB9KTtcbiAgICB9XG4gICAgcm93cy5zb3J0KChhLCBiKSA9PiBiLnYgLSBhLnYpO1xuICAgIGNvbnN0IG1zZyA9IGAke3RpdGxlfe+8iOmMouWMhUHvvJ0ke1dBTExFVFNbMF0/Lm5hbWUgfHwgJyd9JHtXQUxMRVRTWzFdID8gJ+OAgemMouWMhULvvJ0nICsgV0FMTEVUU1sxXS5uYW1lIDogJyd977yJXFxuJHtyb3dzLmxlbmd0aCA/IHJvd3MubWFwKChyKSA9PiAnwrcgJyArIHIubGluZSkuam9pbignXFxuJykgOiAn55uu5YmN5rKS5pyJ5pyJ5YO55qC855qE5oyB5YCJJ31cXG5cXG7mnInlg7nmoLznmoTlkIjoqIjvvJrntIQgJHt0di50b0ZpeGVkKDIpfVUke3RjID8gYO+8iOS7mOiyu+aIkOacrOWQiOioiCAke3RjLnRvRml4ZWQoMSl9Ve+8iWAgOiAnJ30ke25vUG9vbC5sZW5ndGggPyBgXFxu6YKE5rKS6ZaL5rGg77yIJHtub1Bvb2wubGVuZ3RofSDlgIvvvInvvJoke25vUG9vbC5zbGljZSgwLCAyMCkuam9pbign44CBJyl9JHtub1Bvb2wubGVuZ3RoID4gMjAgPyAn4oCmJyA6ICcnfWAgOiAnJ30ke2R1c3QubGVuZ3RoID8gYFxcbuS4jeWIsCAwLjNVIOeahOmbtumgre+8miR7ZHVzdC5qb2luKCfjgIEnKX1gIDogJyd9YDtcbiAgICBhd2FpdCB0Z1NheShtc2cpO1xuICB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gY21kU3RhdHMoKSB7XG4gICAgLy8g5YWN6LK76aCF55uu77ya5omA5pyJ44CM5bey6Ieq5YuV6ZGE6YCg44CN55qE6KiY6YyE6YO9566X77yI5ZCr5LiA55m854++5bCx6aas5LiK5omT55qE77yJ77yM55So5ZCI57SE5Zyw5Z2A5Y676YeN77yb44CM54++5Zyo6ZaL5LqG44CN6YKj56iu55So5ZCN56ix5bCN5Zue5ZCI57SE77yb5omj5o6J5pep5LiKIDAgQk5CIGJ1ZyDnmoTlgYfpkYTpgKBcbiAgICBjb25zdCBmcmVlID0gbmV3IFNldCgpLCBib2cgPSBuZXcgU2V0KCksIHBhaWRDID0gbmV3IFNldCgpOyBsZXQgcGFpZCA9IDA7IGNvbnN0IG4yYSA9IHt9O1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBsaW5lcyA9IHJlYWRGaWxlU3luYyhMT0csICd1dGY4Jykuc3BsaXQoJ1xcbicpO1xuICAgICAgZm9yIChjb25zdCBsIG9mIGxpbmVzKSB7IGNvbnN0IG0gPSBsLm1hdGNoKC8oPzrlsIjlsazlkIjntIR86aCF55uuKe+8mihbXnzvvIgoXFxuXSs/KVxccyooPzrvvIhbXnxdKu+8iSk/XFxzKlxcfFxccyooMHhbYS1mQS1GMC05XXs0MH0pLyk7IGlmIChtICYmICFuMmFbbVsxXS50cmltKCkudG9Mb3dlckNhc2UoKV0pIG4yYVttWzFdLnRyaW0oKS50b0xvd2VyQ2FzZSgpXSA9IG1bMl0udG9Mb3dlckNhc2UoKTsgfVxuICAgICAgZm9yIChjb25zdCBsIG9mIGxpbmVzKSB7XG4gICAgICAgIGlmIChsLmluY2x1ZGVzKCfwn5uSJykpIHsgcGFpZCsrOyBjb25zdCBjID0gbC5tYXRjaCgvKD88IVswLTlhLWZBLUZ4XSkoMHhbYS1mQS1GMC05XXs0MH0pKD8hWzAtOWEtZkEtRl0pLyk7IGlmIChjKSBwYWlkQy5hZGQoY1sxXS50b0xvd2VyQ2FzZSgpKTsgfVxuICAgICAgICBpZiAoIWwuaW5jbHVkZXMoJ+W3suiHquWLlemRhOmAoCcpKSBjb250aW51ZTtcbiAgICAgICAgY29uc3Qgbm0gPSBsLm1hdGNoKC/poIXnm65cXHMqKFteXFxu77yIKHxdKz8pXFxzKuePvuWcqOmWi+S6hi8pOyBsZXQga2V5ID0gJyc7XG4gICAgICAgIGlmIChubSkga2V5ID0gbjJhW25tWzFdLnRyaW0oKS50b0xvd2VyQ2FzZSgpXSB8fCAnTjonICsgbm1bMV0udHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gICAgICAgIGVsc2UgeyBjb25zdCBjID0gbC5tYXRjaCgvKD88IVswLTlhLWZBLUZ4XSkoMHhbYS1mQS1GMC05XXs0MH0pKD8hWzAtOWEtZkEtRl0pLyk7IGlmIChjKSBrZXkgPSBjWzFdLnRvTG93ZXJDYXNlKCk7IH1cbiAgICAgICAgaWYgKCFrZXkpIGNvbnRpbnVlO1xuICAgICAgICAoL+mHjeaSrTB4KO+8iHwgXFx8fCQpLy50ZXN0KGwpID8gYm9nIDogZnJlZSkuYWRkKGtleSk7XG4gICAgICB9XG4gICAgICBmb3IgKGNvbnN0IGsgb2YgYm9nKSBmcmVlLmRlbGV0ZShrKTtcbiAgICB9IGNhdGNoIHt9XG4gICAgY29uc3QgdHIgPSBTLnRyYWRlcyB8fCBbXSwgYnkgPSB7fTtcbiAgICBmb3IgKGNvbnN0IHggb2YgdHIpIHsgY29uc3QgayA9IHguc3ltOyBieVtrXSA9IGJ5W2tdIHx8IHsgdXNkOiAwLCBuOiAwIH07IGJ5W2tdLnVzZCArPSB4LnVzZDsgYnlba10ubisrOyB9XG4gICAgY29uc3QgcHggPSBhd2FpdCBibmJVc2QoKS5jYXRjaCgoKSA9PiAwKTsgbGV0IHRvdCA9IDA7IGZvciAoY29uc3QgVyBvZiBXQUxMRVRTKSB0b3QgKz0gTnVtYmVyKEJpZ0ludChhd2FpdCBycGMoJ2V0aF9nZXRCYWxhbmNlJywgW1cuYWRkciwgJ2xhdGVzdCddKSkpIC8gMWUxODtcbiAgICBjb25zdCBsaW5lcyA9IE9iamVjdC5lbnRyaWVzKGJ5KS5tYXAoKFtrLCB2XSkgPT4gYCR7a33vvJros6MgJHt2Lm59IOethu+8jOaLv+Wbnue0hCAke3YudXNkLnRvRml4ZWQoMil9VWApO1xuICAgIGF3YWl0IHRnU2F5KGDwn5OKIOaIsOe4vlxcbuiHquWLleaJk+eahOWFjeiyu+mgheebru+8miR7ZnJlZS5zaXplfSDlgItcXG7ku5josrvmiZPnmoTvvJoke3BhaWRDLnNpemV9IOWAi+mgheebru+8iCR7cGFpZH0g562G77yJXFxuJHtsaW5lcy5sZW5ndGggPyAn5pyJ6KiY6YyE55qE6LOj5Ye677yaXFxuJyArIGxpbmVzLmpvaW4oJ1xcbicpICsgJ1xcbicgOiAnJ33pjKLljIXnj77lnKjlhbEgJHt0b3QudG9GaXhlZCg0KX0gQk5C77yI57SEICR7KHRvdCAqIHB4KS50b0ZpeGVkKDIpfVXvvIlgKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGdldCBob2xkaW5ncygpIHsgcmV0dXJuIGhvbGRpbmdzOyB9LFxuICAgIGdldCBjbWRTZWxsKCkgeyByZXR1cm4gY21kU2VsbDsgfSxcbiAgICBnZXQgY21kQmFsYW5jZSgpIHsgcmV0dXJuIGNtZEJhbGFuY2U7IH0sXG4gICAgZ2V0IGhvbGRSZXBvcnQoKSB7IHJldHVybiBob2xkUmVwb3J0OyB9LFxuICAgIGdldCBjbWRTdGF0cygpIHsgcmV0dXJuIGNtZFN0YXRzOyB9LFxuICB9O1xufVxuIl0sIm1hcHBpbmdzIjoiQUFBQTtBQUNBLFNBQVNBLFlBQVksUUFBUSxTQUFTO0FBQ3RDLFNBQVNDLFdBQVcs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

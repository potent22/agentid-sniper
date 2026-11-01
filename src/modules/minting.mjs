// Module: minting. Construction is inert; I/O is invoked explicitly.
import { feeDay } from '../../receipt-fees.mjs';
export function createMinting(dependencies) {
  const {
    activity,
    AG_MIN,
    CANDS,
    CONFIG,
    FACTORY,
    FORCE,
    GO_PCT,
    HOT,
    INFRA,
    NATIVE_BNB,
    PAID,
    REFUND_SELS,
    S,
    T_TRANSFER,
    USDT,
    WALLETS,
    WBNB,
    approvedMint,
    badSel,
    big,
    bnbUsd,
    call,
    cc,
    codeOf,
    deployerOf,
    enforceMintRisk,
    findCapSel,
    findFree,
    fitShares,
    flapGuard,
    fpCache,
    freeProgress,
    freshDeadline,
    freshWallet,
    fullCode,
    groupProgress,
    isRepeatDev,
    isSerial,
    learnReplay,
    log,
    noteDev,
    poolOpen,
    poolOut,
    previewExec,
    progressOf,
    repeatDevOk,
    riskBlock,
    rpc,
    ruleTxt,
    safeAddrs,
    scaleV,
    serialDev,
    sleep,
    submitContract,
    swapConfirmed,
    tg,
    tokStr,
    ts,
    upgradeable,
    w,
    wa,
    wallet,
    defer
  } = dependencies;
  const MQ = new Map();
  const freeNoted = new Map();
  function noteFree(c, W, name = '') {
    const first = !freeNoted.has(c);
    if (first) freeNoted.set(c, new Set());
    freeNoted.get(c).add(W.name);
    if (first) defer(async () => {
      const ok = freeNoted.get(c) || new Set();
      freeNoted.delete(c);
      const nm = name || tokStr(await call(c, '0x06fdde03')) || c.slice(0, 10);
      await tg(`🆓 打了免費項目：${nm}（${WALLETS.map(x => x.name + (ok.has(x.name) ? ' ✅' : ' ❌')).join('、')}）\n${c}`).catch(() => {});
    }, 150e3);
  }
  const MQK = new Set();
  function queueMint(c, fname, W, v) {
    if (activity.stopping) return 'Stopping';
    const qk = c + '|' + W.name;
    if (MQK.has(qk)) return '⏳ 已在排隊中';
    if (S.paid?.[c]?.done?.[W.name] && S.paid[c].done[W.name] !== 'pool-open') return '✅ 這個錢包已經打過';
    MQK.add(qk);
    const prev = MQ.get(W.name) || Promise.resolve();
    const job = prev.then(() => activity.stopping ? 'Stopping' : autoMintMax(c, fname, W, v)).finally(() => MQK.delete(qk)).then(async m => {
      if (m.startsWith('🤖') || m.includes('結果不明')) {
        S.paid = S.paid || {};
        if (!S.paid[c]) S.paid[c] = {
          at: Date.now(),
          name: '',
          done: {}
        };
        S.paid[c].done[W.name] = m.startsWith('🤖') ? 'free' : 'unknown';
      } else if (!m.startsWith('⏸') && !m.startsWith('✅')) {
        S.paid = S.paid || {};
        if (!S.paid[c]) S.paid[c] = {
          at: Date.now(),
          name: '',
          done: {},
          waitHot: 1
        };
      } /* 審查 11/1：第一次就失敗（預演失敗、BNB 不夠…）的以前不會再追蹤 */
      log(`[${W.name}] ${c} ${m.replace(/\n/g, ' | ')}`);
      if (m.startsWith('🤖')) {
        S.freeTrack = S.freeTrack || {};
        S.freeTrack[c] = S.freeTrack[c] || {
          at: Date.now()
        };
      }
      if (m.startsWith('🤖')) noteFree(c, W);
    }).catch(e => log(`[${W.name}] 鑄造失敗 ${c} ${e.message}`));
    MQ.set(W.name, activity.track(job));
    return '⏳ 已排入自動鑄造（背景進行）';
  }
  const MAX_REPEAT = 10;
  async function autoMintMax(c, fname, W, val = 0n) {
    const d = Object.fromEntries(CANDS)[fname];
    let first = await autoMint(c, fname, W, val),
      n = first.startsWith('🤖') ? 1 : 0;
    while (!activity.stopping && n > 0 && n < MAX_REPEAT) {
      await sleep(6000);
      // 第一份免費、之後要付一點的（像 QUOGENT）：每次重新找能過的金額（≤0.001 BNB）
      // 防釣魚：只有「完全免費」才連續打；要付手續費的每個項目每個錢包只打 1 份（避免被故意發盤賺手續費）
      let v2 = null;
      try {
        await rpc('eth_call', [{
          from: W.addr,
          to: c,
          data: d,
          value: '0x0'
        }, 'latest']);
        v2 = 0n;
      } catch {}
      if (v2 == null) break;
      const m = await autoMint(c, fname, W, v2);
      if (!m.startsWith('🤖')) break;
      n++;
    }
    return n > 1 ? first + `\n（同一個錢包共打了 ${n} 份）` : first;
  }
  async function progressSweep() {
    /* 使用者 10/31 23:21 查 Pulsepanther 沒打到：追蹤名單 500 多個，一般檢查每輪只看 16 個、一個要 10~30 秒，低進度的項目要 2~3 小時才回頭看一次，10% 直接漲到 100% 都沒發現。改成每分鐘用輕量方式只讀進度（最多 80 個、6 個同時），進度過 45% 就會進快速名單，每 15 秒檢查 */
    const now = Date.now();
    const list = Object.entries(S.paid || {}).filter(([c, P]) => !P.unmintable && (P.progress || 0) < 0.999 && now - (P.at || 0) < 3 * 86400e3 && !WALLETS.every(W => P.done?.[W.name])).sort((x, y) => (x[1].sweepAt || 0) - (y[1].sweepAt || 0)).slice(0, 80);
    let i = 0;
    await Promise.all(Array.from({
      length: 6
    }, async () => {
      while (i < list.length) {
        const [c, P] = list[i++];
        try {
          if (P.progAt && Date.now() - P.progAt < 180e3) {
            P.sweepAt = Date.now();
            continue;
          } /* 除錯：正式檢查 3 分鐘內剛讀過的不覆蓋（避免讀法不同把已賣完的又拉回快速名單、佔名額） */
          let fp = null;
          if (P.soldSel) {
            /* 除錯 11/1：bibiai AGENT ID 用「已售／總量」才讀得到（已售 a2309ff8、總量 a0e23ebd），一般免費讀法讀不到 → 卡在 0% 兩小時沒回頭看，漲到 92% 都不知道 */const sr = await call(c, P.soldSel);
            const sold = sr && sr.length >= 66 ? Number(BigInt(sr.slice(0, 66))) : null;
            if (sold > 0) {
              if (P.capSel === undefined) P.capSel = (await findCapSel(c, await fullCode(c, await codeOf(c)).catch(() => ''), sold).catch(() => '')) || '';
              if (P.capSel) {
                const cr = await call(c, '0x' + P.capSel);
                const cap = cr && cr.length >= 66 ? Number(BigInt(cr.slice(0, 66))) : 0;
                if (cap >= sold && cap > 0) fp = sold / cap;
              }
            }
          }
          if (fp == null) fp = await freeProgress(c);
          P.sweepAt = Date.now();
          if (fp != null && fp > 0) {
            if (fp >= 0.45 && (P.progress || 0) < 0.45 && !P.swLog) {
              P.swLog = 1;
              log(`進度掃描：${P.name || c} 進度 ${Math.round(fp * 100)}%，移到快速檢查`);
            }
            P.progress = fp >= 0.999 && !P.progAt ? 1 : Math.min(fp, 0.99); /* 審查 11/1：免費合約正式檢查不會讀進度，賣完的會永遠卡 99% 佔快速名單 → 直接記 100% */ /* 100% 交給快速檢查用正式讀法確認，避免讀錯就永遠不看 */
          }
        } catch {}
      }
    }));
  }
  async function autoMint(c, fname, W = WALLETS[0], val = 0n) {
    /* 使用者 10/31 19:21：新規則——不管免費還是付費，進度超過 50% 就打，之前的規矩（重複 DEV、黑名單、熱度、手續費上限…）全部不看；只保留貔貅類安全檢查（每筆都模擬、不能授權、不能扣到預期外的資產、Flap 禁止）。讀不到進度的才用熱度判斷 */
    {
      const sd = await serialDev(c);
      if (sd) return `⛔ ${sd}，照規則不打`;
    }
    if (val > 0n) {
      /* 使用者 11/1 14:16：「付手續費的免費」一律當付費——今天被這種小項目掏了約 0.195 BNB；要付錢就必須有保本（退款）機制才打 */
      S.feeRefund = S.feeRefund || {};
      if (S.feeRefund[c] == null) {
        const fc = await fullCode(c, await codeOf(c)).catch(() => '');
        S.feeRefund[c] = REFUND_SELS.some(x => fc.includes(x)) ? 1 : 0;
      }
      if (!S.feeRefund[c]) return `⏸ 要付 ${Number(val) / 1e18} BNB 手續費（不是真的免費），合約沒有保本機制，照規則不打`;
      if (await upgradeable(c).catch(() => false)) return '⏸ 要付手續費，而且是可升級合約（保本機制可能被換掉），照風控不打';
    }
    const fp = await freeProgress(c);
    const agentsN = S.paid?.[c]?.agents || 0; /* 審查 11/1：只算 Agent ID 錢包 */ /* 使用者 10/31 19:45：免費也一樣——進度過 60% 才打；讀不到進度要 100 個以上錢包在打 */
    if (fp != null && fp < GO_PCT) {
      /* 使用者 11/1 02:37：門檻 60% */S.paid = S.paid || {};
      if (!S.paid[c]) S.paid[c] = {
        at: Date.now(),
        name: '',
        done: {},
        waitHot: 1
      };
      return `⏸ 進度 ${Math.floor(fp * 100)}%，還沒到 ${Math.round(GO_PCT * 100)}%，先追蹤，到了就打`;
    }
    if (fp != null && agentsN < AG_MIN) {
      S.paid = S.paid || {};
      if (!S.paid[c]) S.paid[c] = {
        at: Date.now(),
        name: '',
        done: {},
        waitHot: 1
      };
      return `⏸ 進度 ${Math.floor(fp * 100)}% 夠了，但只有 ${agentsN} 個 Agent ID 錢包在打（要 ${AG_MIN} 個以上，防項目方自己灌進度），先追蹤`;
    }
    if (fp == null && agentsN >= AG_MIN) {
      let tk = c;
      const tr0 = await call(c, '0xfc0c546a');
      if (tr0 && tr0.length >= 66 && BigInt(tr0.slice(0, 66)) > 0n) tk = '0x' + tr0.slice(26, 66);
      if (await poolOpen(tk)) return '⏸ 讀不到進度、已經開池，不鑄造（鑄造通常比市價貴）';
    }
    if (fp == null && agentsN < AG_MIN) {
      S.paid = S.paid || {};
      if (!S.paid[c]) S.paid[c] = {
        at: Date.now(),
        name: '',
        done: {},
        waitHot: 1
      };
      return `⏸ 讀不到進度，目前 ${agentsN} 個錢包在打，要 ${AG_MIN} 個以上才打，先追蹤`;
    }
    if (val > 0n && Number(val) / 1e18 * ((await bnbUsd().catch(() => 0)) || 700) > PAID.maxUsd) return `⏸ 手續費超過 ${PAID.maxUsd}U 上限，沒有鑄`;
    let d = Object.fromEntries(CANDS)[fname];
    if (d && /重播|熱門函式/.test(fname)) d = freshDeadline(d); /* 照抄的免費鑄造也換新期限 */
    const today = feeDay(Date.now(), CONFIG.timeZone || 'Asia/Shanghai');
    if (S.mintDay !== today) {
      S.mintDay = today;
      S.mintCount = 0;
    }
    S.mintCnt = S.mintCnt && S.mintCnt.d === today ? S.mintCnt : {
      d: today
    };
    if ((S.mintCnt[W.name] || 0) >= 1000) return '⏸ 這個錢包今天自動鑄已達 1000 筆上限，沒有鑄';
    const bnb = BigInt((await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x0')) || '0x0');
    if (bnb < 5n * 10n ** 14n) return '⚠️ BNB 不夠付 gas（< 0.0005），沒有鑄';
    {
      const rb = await riskBlock(W, c, val, d, val === 0n);
      if (rb) return '⏸ 風控：' + rb + '，沒有鑄';
    }
    const p = await wallet.call(W.addr, ['contract-call', 'preview', '--binanceChainId', '56', '--from', W.addr, '--to', c, '--value', val.toString(), '--inputData', d]);
    const sim = p.j?.data?.simulationResult,
      rid = p.j?.data?.requestId;
    if (!p.j?.success || !rid) return '❌ 預演失敗，沒有鑄：' + (p.j?.error?.message || '').slice(0, 120);
    {
      const fg = flapGuard(c, d, sim);
      if (fg) return '⛔ ' + fg + '，沒有鑄';
    }
    const losing = (sim?.balanceChanges || []).filter(b => String(b.owner).toLowerCase() === W.addr && Number(b.change) < 0 && !(String(b.contractAddress).toLowerCase().startsWith('0xeeee') && -Number(b.change) <= Number(val) && val > 0n)); /* 風控：扣的 BNB 不能比說好的多 */
    if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length || losing.length) return '⚠️ 預演顯示有授權或會扣你的資產，安全起見沒有鑄';
    if (!(sim?.balanceChanges || []).some(b => String(b.owner).toLowerCase() === W.addr && (Number(b.change) > 0 || /Erc721|Erc1155/i.test(b.tokenType || '') && !(Number(b.change) < 0)))) return '⚪ 預演顯示拿不到東西（可能鑄給別人或淨額為 0），沒有鑄';
    let x;
    try {
      const confirmed = await submitContract(W, c, d, val, rid, sim);
      x = confirmed.result;
    } catch (e) {
      return `⚠️ ${e.message}`;
    }
    S.mintCount++;
    S.mintCnt[W.name] = (S.mintCnt[W.name] || 0) + 1;
    const got = (sim?.balanceChanges || []).filter(b => String(b.owner).toLowerCase() === W.addr).map(b => b.tokenType === 'Erc721' ? 'NFT ×1' : b.tokenType + ' +' + b.change).join('、');
    return `🤖 已自動鑄造 ${fname}${got ? '（' + got + '）' : ''}${fname.startsWith('commit') ? '\n（這種是兩步式，還要 reveal 才拿到，手動處理）' : ''}\n交易 ${x.j.data?.txHash || x.j.data?.orderId || ''}`;
  }
  const gotTok = (sim, W) => (sim?.balanceChanges || []).filter(b => String(b.owner).toLowerCase() === W.addr && Number(b.change) > 0).reduce((a, b) => a + Number(b.change), 0);
  const heatTier = P => (P.agents || 0) >= 200 || (P.burst || 0) >= 30 ? 2 : (P.agents || 0) >= 100 || (P.burst || 0) >= 15 ? 1 : 0;
  function markUnmintable(c, P, sym, progress, why = '要官網簽名或白名單') {
    P.lastReason = why; // 達到進場條件但我們打不了：標記不再重試，通知使用者一次
    if (P.unmintable) return;
    P.unmintable = ts();
    P.unmintableAt = Date.now();
    log(`打不了 ${c}（${sym}）：${why}`);
    if (false && (heatTier(P) >= 1 || (progress || 0) >= 0.4 && (progress || 0) < 0.95)) tg(`⚠️ ${sym || P.name || '新項目'} 達到進場條件（累計 ${P.agents || 0} 個代理人${progress > 0 ? '，進度約 ' + Math.round(progress * 100) + '%' : ''}），但工具打不了：${why}。要的話請手動\n${c}`).catch(() => {});
  }
  function noteFail(c, P, sym, progress) {
    P.cf = (P.cf || 0) + 1;
    if (P.cf >= 8) markUnmintable(c, P, sym, progress, '模擬鑄造一直失敗，可能已賣完、要官網簽名、白名單或已關閉');
  }
  const busyP = new Set();
  async function paidLoop(mode = 'all', shard = null) {
    if (S.umReset !== 3) {
      S.umReset = 3;
      for (const P of Object.values(S.paid || {})) {
        if (P.unmintable) {
          delete P.unmintable;
          P.fail = 0;
          P.cf = 0;
          if (P.replay?.learned) delete P.replay;
        }
      }
    } // 新版一次性：之前標記打不了的重新試
    S.paid = S.paid || {};
    S.dyn = S.dyn || [];
    S.paidSpend = S.paidSpend || {};
    if (S.missed && !S.missedClean1) {
      S.missedClean1 = 1;
      for (const [k, m] of Object.entries(S.missed)) if (String(m.why || '').includes('保本')) delete S.missed[k];
    } /* 照規則不打的不算錯過 */
    if (S.refundReset !== 1) {
      S.refundReset = 1;
      for (const P of Object.values(S.paid)) {
        delete P.refundOk;
        delete P.noRefundLog;
      }
    } /* 除錯 11/1：代理合約解析修正後，重新判斷一次有沒有退款機制 */
    const today = feeDay(Date.now(), CONFIG.timeZone || 'Asia/Shanghai');
    if (S.paidSpend.day !== today) S.paidSpend = {
      day: today
    };
    let price = 0;
    if (!S.forceDone) S.forceDone = {
      '0xc7d563a7bd5af3de83567a67058b3eb9f285149e': 1
    }; // VARC 早上已經打完
    for (const c of FORCE) if (S.forceDone[c] && S.paid[c]) delete S.paid[c];
    for (const c of FORCE) if (!S.paid[c] && !S.forceDone[c]) S.paid[c] = {
      at: Date.now(),
      name: '',
      done: {}
    }; // 審查修正：手動指定的項目打完就不再加回來重打
    if (!S.migrated2) {
      S.migrated2 = 1;
      for (const c of Object.keys(S.seenMints || {})) {
        if (S.paid[c]) continue;
        const cd = await codeOf(c);
        if (cd.includes('e38fd349') && cd.includes('68bce8cd') || cd.includes('725c4058') && cd.includes('94bf804d')) {
          S.paid[c] = {
            at: Date.now(),
            name: '',
            done: {}
          };
          log('補登付費追蹤 ' + c);
        }
      }
    }
    // 進度 ≥40% 的（快滿的）每輪都看，不跟其他一百多個排隊；其餘輪流，每輪補到 16 個
    const all = Object.entries(S.paid);
    const hotP = all.filter(([c, P]) => FORCE.has(c) || ((P.progress || 0) >= 0.45 || (fpCache.get(c)?.p || 0) >= 0.45 || !(P.progress > 0) && Math.max(P.agents || 0, HOT.get(c)?.from.size || 0) >= 70) && (P.progress || 0) < 0.999 && !P.unmintable).filter(([c, P]) => !WALLETS.every(W => P.done[W.name])).sort((a, b) => (b[1].progress || 0) - (a[1].progress || 0) || (b[1].agents || 0) - (a[1].agents || 0)).slice(0, 12); /* 使用者 10/31 20:29：快速檢查只看快到門檻的（進度 ≥45%，或讀不到進度但已 70 個以上錢包），最多 12 個，避免越來越慢 */
    // 快速檢查（mode='hot'）每 15 秒只看快滿／很熱的；一般檢查（mode='rest'）另外在背景約每分鐘輪流看其他的，互不拖慢
    const rest = mode === 'hot' ? [] : all.filter(e => !hotP.includes(e)).sort((a, b) => (a[1].lastTry || 0) - (b[1].lastTry || 0)).slice(0, 16);
    const ents = mode === 'rest' ? rest : mode === 'hot' ? shard == null ? hotP : hotP.filter((e, i) => i % 3 === shard) : hotP.concat(rest); /* 快速檢查分 3 組同時跑（審查修正：一個一個查要 1 分多鐘） */
    for (const [c, P] of ents) {
      if (INFRA.has(c)) {
        delete S.paid[c];
        continue;
      } // Agent ID 登記合約本身不是項目（註冊 .ai 身份），不打
      if (busyP.has(c)) continue;
      busyP.add(c);
      const tE = Date.now();
      try {
        P.lastTry = Date.now();
        if (WALLETS.every(W => P.done[W.name])) {
          if (FORCE.has(c)) {
            S.forceDone = S.forceDone || {};
            S.forceDone[c] = 1;
          }
          delete S.paid[c];
          continue;
        }
        if (Date.now() - P.at > PAID.maxAgeH * 3600e3) {
          delete S.paid[c];
          continue;
        }
        const code = await codeOf(c);
        try {
          await enforceMintRisk(c, await fullCode(c, code));
        } catch (e) {
          P.lastReason = e.message;
          log(`跳過 ${c}：${e.message}`);
          continue;
        }
        // 發現時還沒開的「免費」鑄造：之後每分鐘重試，一開就自動打
        const fcd = (P.progress || 0) >= GO_PCT - 0.02 || Math.max(P.agents || 0, HOT.get(c)?.from.size || 0) >= 70 ? 20e3 : 120e3; /* 除錯 11/1：快到 60% 的免費項目改成 20 秒重試一次（之前固定 2 分鐘，0xa69adf 在這 2 分鐘內從 63% 賣完） */
        if (Date.now() - (P.freeTryAt || 0) > fcd && !((P.progress || 0) > 0 && P.progress < GO_PCT - 0.02 && Date.now() - (P.freeTryAt || 0) < 600e3)) {
          /* 優化 11/1：進度讀得到且還沒到 58% 的免費項目，不用每 2 分鐘模擬一次（一晚 850 次白跑、還害節點限流）；改成 10 分鐘看一次，快到門檻才密集重試 */P.freeTryAt = Date.now();
          for (const W of WALLETS) {
            if (P.done[W.name]) continue;
            {
              const ff = await findFree(W.addr, c, code);
              if (!ff || P.qAt?.[W.name] > Date.now() - (fcd - 5e3)) continue;
              P.qAt = P.qAt || {};
              P.qAt[W.name] = Date.now();
              queueMint(c, ff.n, W, ff.v);
              log(`[${W.name}] 之前還沒開的 ${P.name || c} 現在開了（免費），排入鑄造`);
            }
          }
        }
        let kind = code.includes('e38fd349') && code.includes('68bce8cd') ? 'bnb' : code.includes('725c4058') && code.includes('94bf804d') ? 'usdt' : null;
        let unit = 0n; // 一般 NFT：mint(數量) 付「單價 × 數量」BNB（像 Sentient Syndicate 的 PRICE）
        if (!kind && code.includes('a0712d68')) for (const sel of ['8d859f3e', 'a035b1fe', '6817c76c', '13faede6', '817b1cd2']) {
          if (!code.includes(sel)) continue;
          const r = await cc(c, '0x' + sel);
          if (r && r.length >= 66 && BigInt(r.slice(0, 66)) > 0n) {
            unit = BigInt(r.slice(0, 66));
            kind = 'gen';
            break;
          }
        }
        if (!kind && P.recvValue) kind = 'recv';
        if (P.replay && badSel(P.replay.data)) delete P.replay;
        if (!kind && P.replay?.data) kind = 'replay'; // 少見的鑄造函式：照別人的呼叫內容與金額打

        if (!kind || kind === 'replay') P.needLearn = 1; // 看不懂的合約：交給背景的熱度監測去學別人的打法，這裡不等
        if (!kind) continue;
        if (P.unmintable && P.unmintableAt && Date.now() - P.unmintableAt > 30 * 60e3 && (P.umN || 0) < 2) {
          P.umN = (P.umN || 0) + 1;
          delete P.unmintable;
          P.fail = 0;
          P.cf = 0;
        } // 30 分鐘後再試，最多再試 2 次（避免付 USDT 的項目每半小時換一次 USDT 又失敗）
        if (P.unmintable && !FORCE.has(c)) continue;
        let soldR = await call(c, kind === 'bnb' ? '0xa2309ff8' : kind === 'gen' ? '0x18160ddd' : '0x192fc516');
        if (!(soldR && soldR.length >= 66) && (kind === 'replay' || kind === 'recv')) {
          if (P.soldSel) soldR = await call(c, P.soldSel);else for (const sel of ['0x02c7e7af', '0xa2309ff8', '0x9106d7ba', '0xf4514d2e', '0x505e05fd', '0x3a98ef39']) {
            const r = await cc(c, sel, 60e3);
            if (r && r.length >= 66) {
              soldR = r;
              P.soldSel = sel;
              break;
            }
          }
        }
        const sold = soldR && soldR.length >= 66 ? Number(BigInt(soldR.slice(0, 66))) : null;
        let cap = null;
        {
          const r = await cc(c, '0xa0e23ebd');
          if (r && r.length >= 66 && sold != null) {
            const x = Number(BigInt(r.slice(0, 66)));
            if (x >= 1000 && x <= 1e7 && x % 100 === 0) cap = Math.max(x, sold);
          }
        }
        if (!cap) for (const sel of ['0xd8f93498', '0xcef6feda', '0x29b80536', '0xd5abeb01', '0x32cb6b0c', '0x355274ea', '0x3a1d8d3a', '0xf1aee5a2', '0x85e3f997']) {
          const r = await cc(c, sel);
          if (r && r.length >= 66) {
            const x = Number(BigInt(r.slice(0, 66)));
            if (x > 0 && sold != null && x >= sold && x < 1e12) {
              cap = x;
              break;
            }
          }
        }
        if (!cap && sold != null && sold > 0) {
          /* 審查 11/1：bibiai 發射台的總量函式不在常見清單（a0e23ebd=10000）→ 讀不到進度 → 被當成「讀不到＋很多人打」在 4% 就可能買；改成自動從合約裡找「總量」函式並記住 */
          if (P.capSel === undefined) P.capSel = (await findCapSel(c, code, sold).catch(() => '')) || '';
          if (P.capSel) {
            const r = await cc(c, '0x' + P.capSel, 600e3);
            if (r && r.length >= 66) {
              const x = Number(BigInt(r.slice(0, 66)));
              if (x > 0 && x < 1e9) cap = Math.max(x, sold);
            }
          } /* 已售超過總量＝賣完（AID 賣到 10246／10000 時被讀成 0.23%） */
        }
        let tokAddr0 = '';
        {
          const tr0 = await cc(c, '0xfc0c546a', 3600e3);
          if (tr0 && tr0.length >= 66 && BigInt(tr0.slice(0, 66)) > 0n) tokAddr0 = '0x' + tr0.slice(26, 66);
        }
        let progress = cap && sold != null ? sold / cap : 0,
          how = '已售／上限';
        if (!(progress > 0)) {
          const pr = await progressOf(c, code, tokAddr0);
          progress = pr.progress || 0;
          how = pr.how || '';
        }
        /* 使用者 10/31 19:02：進度合理性檢查（币安人 把總量讀成 100 倍，進度 32% 被讀成 0.3%，別人打到我們沒打到）：讀到的進度很低、但已經很多人打 → 判定讀錯，改用庫存算法；還是不合理就當作讀不到，交給熱度規則 */
        if (progress > 0 && progress < 0.03 && !(how === '已售／上限' && cap && (kind === 'bnb' && cap === 10000 || (P.agents || 0) >= 20 && cap / Math.max(P.agents || 1, 1) <= 1000)) /* 審查 11/1：總量跟參與人數相比合理（平均每人 ≤1000 份）就相信「已售／上限」，只有總量大到不合理（像幣安人讀大 100 倍）才判讀錯 */ /* 除錯 11/1：BNB 報價型固定 1 萬份就開池，「已售／1 萬」是準的；BNLAI 已售 201 份＝2% 被誤判成讀錯，當成讀不到＋很多人打就花了 14U */ && ((P.agents || 0) >= 50 || (sold || 0) >= 1000 || (HOT.get(c)?.from.size || 0) >= 15)) {
          const pr = await progressOf(c, code, tokAddr0).catch(() => ({}));
          if (pr.progress >= 0.03) {
            progress = pr.progress;
            how = pr.how || '庫存';
          } else {
            if (!P.progBad) {
              P.progBad = 1;
              log(`進度看起來讀錯了：${c} 讀到 ${(progress * 100).toFixed(2)}% 但已有 ${P.agents || 0} 個代理人在打，改用熱度規則判斷`);
            }
            progress = 0;
            how = '讀不到（數字不合理）';
          }
        }
        const prevProg = P.progress;
        P.progress = progress;
        P.progAt = Date.now();
        if (progress >= 0.95 && !P.noRefundLog && !P.serialLog && !String(P.lastReason || '').includes('保本') && !WALLETS.some(W => P.done[W.name] && !['pool-open', 'fail', 'unknown'].includes(P.done[W.name]))) {
          /* 照規則不打（沒有保本）的不算錯過 */S.missed = S.missed || {};
          if (!S.missed[c]) {
            S.missed[c] = {
              name: P.name || c.slice(0, 10),
              at: ts(),
              why: P.lastReason || (P.unmintable ? '打不了' : '還沒找到能打的方式')
            };
            log(`錯過 ${c}（${S.missed[c].name}）：進度已 ${Math.round(progress * 100)}%，我們沒打到，原因：${S.missed[c].why}`);
          }
        } /* 讓自己更聰明：記下快賣完卻沒打到的項目和原因，每晚總結列出來，方便找出要補的漏洞 */
        if (progress >= 0.7 && progress <= 1 && (prevProg != null ? prevProg < 0.7 : Date.now() - P.at < 6 * 3600e3)) groupProgress(c, P.name, progress).catch(() => {});
        {
          const now = Date.now();
          P.ph = (P.ph || []).filter(x => now - x.t < 15 * 60e3);
          if (!P.ph.length || now - P.ph[P.ph.length - 1].t > 10e3) P.ph.push({
            t: now,
            p: progress
          });
        }
        price = price || (await bnbUsd());
        const forced = FORCE.has(c);
        const tier = heatTier(P),
          needPct = GO_PCT; /* 使用者 11/1 02:37：全部改回進度超過 60% 才打（付費還要有保本機制） */
        const crowdGo = !(progress > 0) && (P.agents || 0) >= AG_MIN; /* 審查 11/1：只算持有 Agent ID 的錢包（熱度名單含一般地址，可能被機器人灌） */ /* 使用者 10/31 19:45：讀不到進度 → 100 個以上錢包在打就打 */
        if (!forced && !(progress >= needPct || crowdGo)) continue;
        {
          const sd = await serialDev(c);
          if (sd) {
            if (!P.serialLog) {
              P.serialLog = 1;
              P.lastReason = sd + '，照規則不打';
              if (S.missed?.[c]) delete S.missed[c];
              log(`跳過 ${P.name || c}：${sd}，照規則不打`);
            }
            continue;
          }
        }
        {
          /* 使用者 11/1 01:56：風險變大了——付費項目一定要有保本機制（打不滿可以退款），沒有就不打。看合約（含代理背後的實作）有沒有退款函式 */
          const paying = !(kind === 'replay' && !(BigInt(P.replay?.value || '0') > 0n) && !P.replay?.payTok);
          if (paying && P.refundOk == null) {
            const fc = await fullCode(c, code).catch(() => code);
            P.refundOk = REFUND_SELS.some(x => fc.includes(x)) ? 1 : 0;
          } /* 代理合約要看背後的實作 */
          if (paying && !P.refundOk) {
            if (!P.noRefundLog) {
              P.noRefundLog = 1;
              P.lastReason = '沒有保本（退款）機制，照規則不打';
              if (S.missed?.[c]) delete S.missed[c];
              log(`跳過 ${P.name || c}：付費項目沒有保本（退款）機制，照規則不打`);
            }
            continue;
          }
          if (paying && (await upgradeable(c).catch(() => true))) {
            if (!P.upgLog) {
              P.upgLog = 1;
              P.lastReason = '可升級合約，保本機制可能被換掉，照風控不打';
              log(`跳過 ${P.name || c}：可升級代理合約（項目方能事後換掉保本機制），照風控不打`);
            }
            continue;
          }
        }
        const gate = forced || progress >= GO_PCT && (P.agents || 0) >= AG_MIN || crowdGo;
        if (!gate) continue;
        if (!forced && !P.goLogged) {
          P.goLogged = 1;
          log(`進場 ${c}：${progress >= GO_PCT ? '進度過 ' + Math.round(GO_PCT * 100) + '%' : '讀不到進度、' + AG_MIN + ' 個以上錢包在打'}（累計 ${P.agents || 0} 個代理人、3 分鐘 ${P.burst || 0} 個），進度 ${progress > 0 ? Math.round(progress * 100) + '%' : '讀不到'}`);
        }
        // 防釣魚：① 同款合約 24 小時內被部署 3 次以上（批量發盤）不打 ② 進度要是很多人打出來的（至少 20 個不同錢包），不是項目方自己刷的
        {
          const dep = P.deployer !== undefined ? P.deployer : await deployerOf(c);
          P.deployer = dep;
          if (dep && !(S.devs?.[dep] || []).some(x => x.c === c)) noteDev(dep, c);
          if (dep && S.black?.[dep]) {
            if (!P.blackLogged) {
              P.blackLogged = 1;
              log(`跳過 ${c}：部署者 ${dep} 在黑名單（${S.black[dep].why}）`);
            }
            continue;
          }
          if (dep && P.fresh == null) P.fresh = await freshWallet(dep);
          if (P.fresh) {
            if (!P.freshLogged) {
              P.freshLogged = 1;
              log(`跳過 ${c}：部署者 ${dep} 是剛建立的新錢包`);
            }
            continue;
          }
          // 錢流：合約裡幾乎沒留 BNB、也還沒開池 → 錢多半直接流進項目方錢包，要求更多人打過（40 個）才算可信
          if (P.drain == null) {
            const cb = Number(BigInt((await rpc('eth_getBalance', [c, 'latest']).catch(() => '0x0')) || '0x0')) / 1e18;
            const pr = tokAddr0 || c;
            const pair = await call(FACTORY, '0xe6a43905' + wa(pr) + wa(WBNB));
            P.drain = cb < 0.01 && !(pair && BigInt(pair) > 0n);
          }
          P.needW = 0;
          if (isRepeatDev(dep)) {
            if (P.repeatOk == null || Date.now() - (P.repeatAt || 0) > 600e3) {
              P.repeatOk = await repeatDevOk(dep, c, P);
              P.repeatAt = Date.now();
            }
            if (!P.repeatOk) {
              if (P.drain) {
                if (!P.devLogged) {
                  P.devLogged = 1;
                  log(`跳過 ${c}：重複 DEV ${dep}，沒有開盤紀錄，而且錢直接流走`);
                }
                continue;
              }
              P.needW = 40;
            } else if (!P.devLogged) {
              P.devLogged = 1;
              log(`重複 DEV ${dep} 但照打 ${c}（${P.repeatOk}）`);
            }
          }
        }
        // 使用者定：只打新的 → 兩天前就部署的老合約不打
        {
          if (P.old == null) {
            const head = parseInt(await rpc('eth_blockNumber', []), 16);
            const o = await rpc('eth_getCode', [c, '0x' + (head - 400000).toString(16)]).catch(() => '0x');
            P.old = !!o && o.length > 2;
          }
          if (P.old) {
            for (const W of WALLETS) P.done[W.name] = P.done[W.name] || 'old';
            continue;
          }
        }
        // 已經開池交易的項目不再自動鑄造（鑄造≈用市價買，不划算）
        if (!forced && !(progress >= GO_PCT)) {
          const tk = tokAddr0 || c;
          if (await poolOpen(tk)) {
            if (!P.poolSkipLog) {
              P.poolSkipLog = 1;
              log(`跳過 ${c}：已經開池交易，讀不到進度時不在開池後鑄（之後讀到進度 ≥80% 仍會打）`);
            }
            continue;
          }
        } /* 審查 11/1：以前會直接標記完成並刪掉，讀錯一次就永遠不打 */
        if (isSerial(code)) {
          if (!P.serialLogged) {
            P.serialLogged = 1;
            log(`跳過 ${c}：同款合約 24 小時內部署 3 次以上，疑似批量發盤`);
          }
          continue;
        }
        {
          const need = Math.max(P.drain ? 40 : 20, P.needW || 0);
          const seen = Math.max(P.wallets || 0, HOT.get(c)?.from.size || 0, P.agents || 0); /* 熱度算到的 Agent ID 錢包數也算（USDT 鑄造、幣先鎖住的項目沒有轉帳紀錄可數） */
          if (seen < need) {
            if (Date.now() - (P.wAt || 0) < 60e3) continue;
            P.wAt = Date.now();
            const r = await rpc('eth_getLogs', [{
              address: tokAddr0 || c,
              fromBlock: '0x' + (parseInt(await rpc('eth_blockNumber', []), 16) - 3000).toString(16),
              toBlock: 'latest',
              topics: [T_TRANSFER]
            }]).catch(() => []);
            const uniq = new Set((r || []).map(l => l.topics[2])).size;
            P.wallets = Math.max(P.wallets || 0, uniq);
            if (uniq < need) continue;
          }
        } // 還沒到 80%（或讀不到進度）→ 先不打，之後每分鐘再看
        let tokAddr = '';
        const tr = await cc(c, '0xfc0c546a', 3600e3);
        if (tr && tr.length >= 66) tokAddr = '0x' + tr.slice(26, 66);
        const sym = tokAddr ? tokStr(await cc(tokAddr, '0x95d89b41', 3600e3)) || P.name || c.slice(0, 8) : P.name || c.slice(0, 8);
        await Promise.all(WALLETS.map(async W => {
          if (P.done[W.name]) return;
          {
            const rb = await riskBlock(W, c, 0n, '0x', false, true).catch(() => '風控檢查失敗');
            if (rb) {
              if (P.riskLog !== rb) {
                P.riskLog = rb;
                log(`[${W.name}] 風控暫停 ${P.name || c}：${rb}`);
              }
              return;
            }
          }
          try {
            price = price || (await bnbUsd());
            const spent = S.paidSpend[W.name] || 0;
            const bal = Number(BigInt((await rpc('eth_getBalance', [W.addr, 'latest'])) || '0x0')) / 1e18;
            let n = 10,
              costWei = 0n;
            if (kind === 'replay' && P.replay.payTok) {
              // 付 USDT 的鑄造（像 BITO）：換 USDT → 授權 → 照別人的方式打，份數放大到預算內最多 10 份
              if (P.replay.payTok !== USDT) {
                if (!P.payTokLogged) {
                  P.payTokLogged = 1;
                  log(`跳過 ${c}：要付的代幣不是 USDT（${P.replay.payTok}）`);
                }
                return;
              }
              if (Date.now() - (P.replay.learnedAt || 0) > 90e3) {
                const lr = await learnReplay(c).catch(() => null);
                if (lr) P.replay = {
                  ...P.replay,
                  ...lr
                };
              }
              let data = freshDeadline(P.replay.data),
                need = BigInt(P.replay.payAmt || '0');
              const ws = data.slice(10).match(/.{64}/g) || [];
              if (ws.length === 3 && need > 0n) {
                const n0 = BigInt('0x' + ws[0]),
                  mx = BigInt('0x' + ws[2]);
                if (n0 > 0n && n0 <= 100n && mx >= need && mx <= need * 12n / 10n) {
                  const unit = need / n0;
                  let nn = 10n;
                  while (nn > 1n && Number(unit * nn) / 1e18 * 1.05 > PAID.maxUsd) nn--;
                  const mp = unit * nn * 105n / 100n;
                  data = data.slice(0, 10) + w(nn) + ws[1] + w(mp);
                  need = mp;
                }
              }
              if (!(need > 0n) || Number(need) / 1e18 > PAID.maxUsd) return;
              let ub = big(await call(USDT, '0x70a08231' + wa(W.addr)));
              if (ub < need) {
                const nb = Number(need - ub) / 1e18 * 1.04 / price;
                if (nb > bal - PAID.keepBnb) return;
                const sw = await swapConfirmed(W, ['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', nb.toFixed(6), '--fromToken', NATIVE_BNB, '--toToken', USDT]);
                if (!sw.j?.success) throw new Error('BNB 換 USDT 失敗 ' + (sw.j?.error?.message || sw.t).slice(0, 100));
                for (let i = 0; i < 30 && ub < need; i++) {
                  await sleep(3000);
                  ub = big(await call(USDT, '0x70a08231' + wa(W.addr)));
                }
                if (ub < need) throw new Error('USDT 沒到帳');
              }
              const v = BigInt(P.replay.value || '0');
              if (v > 0n && (Number(v) / 1e18 * 1.005 > bal - PAID.keepBnb || Number(need) / 1e18 + Number(v) / 1e18 * price > PAID.maxUsd)) return; /* 審查修正：付 USDT 的同時若還要附 BNB，也要算進預算 */
              const r = await approvedMint(W, USDT, c, need, async () => {
                try {
                  data = await safeAddrs(W, c, data, v);
                  data = await fitShares(W, c, data, v);
                } catch (e) {
                  if (/額度|quota|已打滿/.test(e.message)) P.done[W.name] = 'full';else noteFail(c, P, sym, progress);
                  throw e;
                }
                return previewExec(W, c, data, v, sim => {
                  const mine = (sim?.balanceChanges || []).filter(b => String(b.owner).toLowerCase() === W.addr);
                  if (sim?.authorityChanges?.length) return '有權限變化';
                  const out = mine.filter(b => Number(b.change) < 0);
                  if (out.some(b => {
                    const a = String(b.contractAddress).toLowerCase();
                    return a !== USDT && !a.startsWith('0xeeee');
                  })) return '會扣到 USDT/BNB 以外的資產';
                  if (out.filter(b => String(b.contractAddress).toLowerCase() === USDT).reduce((a, b) => a - Number(b.change), 0) > Number(need) * 1.01) return '扣的 USDT 超過預算';
                  return '';
                });
              });
              const paidU = (r.sim?.balanceChanges || []).filter(b => String(b.owner).toLowerCase() === W.addr && String(b.contractAddress).toLowerCase() === USDT && Number(b.change) < 0).reduce((a, b) => a - Number(b.change), 0) / 1e18;
              const usd = paidU > 0 ? paidU : Number(need) / 1e18;
              S.paidSpend[W.name] = spent + usd / price;
              P.done[W.name] = 'minted'; /* 記實際扣掉的 USDT */
              await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}（照別人的方式，付 USDT）\n花約 ${usd.toFixed(2)} USDT · ${progress > 0 ? '進度約 ' + Math.round(progress * 100) + '%' : '最近 ' + (P.replay.hot || 0) + ' 個錢包在打'}\n${c}\n交易 ${r.tx}`);
              return;
            }
            if (kind === 'replay') {
              if (Date.now() - (P.replay.learnedAt || 0) > 90e3) {
                const lr = await learnReplay(c).catch(() => null);
                if (lr) P.replay = {
                  ...P.replay,
                  ...lr
                };
              } /* 用最新的別人交易（價格參數要新） */
              let v = BigInt(P.replay.value || '0');
              let vb = Number(v) / 1e18;
              if (price && vb * price > PAID.maxUsd && P.replay.data) {
                /* 審查 11/1：學到的金額超過 20U 時，第一個參數是份數就按比例降份數＋金額，不再直接放棄 */
                const w0 = P.replay.data.slice(10, 74);
                const n0 = w0.length === 64 ? Number(BigInt('0x' + w0)) : 0;
                if (n0 >= 2 && n0 <= 100) {
                  const n1 = Math.floor(PAID.maxUsd / (vb * price) * n0);
                  if (n1 >= 1) {
                    v = v * BigInt(n1) / BigInt(n0);
                    vb = Number(v) / 1e18;
                    P.replay = {
                      ...P.replay,
                      data: P.replay.data.slice(0, 10) + n1.toString(16).padStart(64, '0') + P.replay.data.slice(74),
                      value: v.toString()
                    };
                    log(`照抄金額超過預算，份數 ${n0}→${n1}：${c}`);
                  }
                }
              }
              if (!price || vb * price > PAID.maxUsd || vb * 1.005 > bal - PAID.keepBnb) return;
              let rdata = freshDeadline(P.replay.data);
              try {
                rdata = await safeAddrs(W, c, rdata, v);
                const rd0 = rdata;
                rdata = await fitShares(W, c, rdata, v);
                v = scaleV(rd0, rdata, v);
                vb = Number(v) / 1e18;
              } catch (e) {
                if (/額度|quota|已打滿/.test(e?.message || '')) P.done[W.name] = 'full';else noteFail(c, P, sym, progress);
                return;
              } /* 審查修正：付 BNB 的照抄也要換掉別人的地址、自動調份數 */
              {
                /* 使用者 10/31 19:16「用這種邏輯去優化」：照抄失敗時不馬上放棄——先換最新樣本再試，再試「價格上限 +2%」（只在交易內容裡有跟付款金額一樣的上限數字時） */
                const ok = async (d, val) => {
                  try {
                    await rpc('eth_call', [{
                      from: W.addr,
                      to: c,
                      data: d,
                      value: '0x' + val.toString(16)
                    }, 'latest']);
                    return true;
                  } catch {
                    return false;
                  }
                };
                let good = await ok(rdata, v);
                if (!good) {
                  const lr = await learnReplay(c).catch(() => null);
                  if (lr?.data) {
                    P.replay = {
                      ...P.replay,
                      ...lr
                    };
                    const v2 = BigInt(lr.value || '0');
                    let d2 = freshDeadline(lr.data);
                    let v2s = v2;
                    try {
                      d2 = await safeAddrs(W, c, d2, v2);
                      const dd = d2;
                      d2 = await fitShares(W, c, d2, v2);
                      v2s = scaleV(dd, d2, v2);
                    } catch {}
                    if (Number(v2s) / 1e18 * price <= PAID.maxUsd && Number(v2s) / 1e18 * 1.005 <= bal - PAID.keepBnb && (await ok(d2, v2s))) /* 審查 11/1：重新學到的金額也要在 20U 預算和餘額內 */{
                        rdata = d2;
                        v = v2s;
                        vb = Number(v) / 1e18;
                        good = true;
                      }
                  }
                }
                if (!good && v > 0n) for (const pct of [102n, 105n, 110n, 120n, 135n]) {
                  /* 除錯 11/1：AID 價格從 0.0204 漲到 0.022（+8%），舊的只試 +2% → 合約回 MAX_COST 打不了；改成 +2%～+35% 一路試，金額在 20U 預算與餘額內 */
                  const vU = v * pct / 100n;
                  if (Number(vU) / 1e18 * price > PAID.maxUsd || Number(vU) / 1e18 * 1.005 > bal - PAID.keepBnb) break;
                  const ws = rdata.slice(10).match(/.{64}/g) || [];
                  let hit = 0;
                  const d3 = rdata.slice(0, 10) + ws.map(x => {
                    const y = BigInt('0x' + x);
                    if (y > 0n && y * 1000n >= v * 995n && y * 1000n <= v * 1005n) {
                      hit = 1;
                      return vU.toString(16).padStart(64, '0');
                    }
                    return x;
                  }).join('');
                  if (await ok(hit ? d3 : rdata, vU)) {
                    rdata = hit ? d3 : rdata;
                    v = vU;
                    vb = Number(v) / 1e18;
                    good = true;
                    log(`照抄時金額 +${pct - 100n}% 才過：${c}`);
                    P.replay = {
                      ...P.replay,
                      data: rdata,
                      value: v.toString()
                    };
                    break;
                  }
                }
                if (!good) {
                  noteFail(c, P, sym, progress);
                  return;
                } /* 審查 11/1：一次失敗就標打不了 → 改成累計 8 次 */
              }
              const r = await previewExec(W, c, rdata, v, sim => {
                const mine = (sim?.balanceChanges || []).filter(b => String(b.owner).toLowerCase() === W.addr);
                if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
                const out = mine.filter(b => Number(b.change) < 0);
                if (out.some(b => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(v) * 1.01) return '會扣到 BNB 以外或超過金額';
                if (!mine.some(b => Number(b.change) > 0)) return '模擬沒拿到東西';
                return '';
              });
              S.paidSpend[W.name] = spent + vb;
              P.done[W.name] = 'minted';
              if (!(v > 0n)) {
                noteFree(c, W, sym);
                return;
              }
              await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}（照別人的鑄造方式）\n花 ${vb.toFixed(4)} BNB（約 ${(vb * price).toFixed(1)}U）· 進度約 ${Math.round(progress * 100)}%\n${c}\n交易 ${r.tx}`);
              return;
            }
            if (kind === 'recv') {
              let v = BigInt(P.recvValue);
              if (price && Number(v) / 1e18 * price > PAID.maxUsd) {
                /* 除錯 11/1：大家最常轉的金額超過 20U 預算（BNBCAT 10 份＝0.03 BNB≈21U）時，改用別人轉過、在預算內最大的金額，不再直接放棄 */
                const ok = (P.recvVals || []).map(x => BigInt(x)).filter(x => Number(x) / 1e18 * price <= PAID.maxUsd).sort((x, y) => x > y ? -1 : 1);
                if (ok.length) v = ok[0];
              }
              const vb = Number(v) / 1e18;
              if (!price || vb * price > PAID.maxUsd || vb * 1.005 > bal - PAID.keepBnb) return;
              try {
                await rpc('eth_call', [{
                  from: W.addr,
                  to: c,
                  value: '0x' + v.toString(16)
                }, 'latest']);
              } catch {
                noteFail(c, P, sym, progress);
                if ((P.cf || 0) >= 3) {
                  delete P.recvValue;
                  delete P.replay;
                  P.needLearn = 1;
                }
                return;
              } /* 審查 11/1：轉 BNB 金額可能學錯，失敗幾次就重學 */ // 不能鑄（沒資格、已打過、額度滿）
              const r = await previewExec(W, c, '0x', v, sim => {
                const mine = (sim?.balanceChanges || []).filter(b => String(b.owner).toLowerCase() === W.addr);
                if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
                const out = mine.filter(b => Number(b.change) < 0);
                if (out.some(b => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(v) * 1.01) return '會扣到 BNB 以外或超過金額';
                if (!mine.some(b => Number(b.change) > 0)) return '模擬沒拿到代幣';
                return '';
              });
              S.paidSpend[W.name] = spent + vb;
              P.done[W.name] = 'minted';
              await tg(`🛒 [${W.name}] 自動打了「轉 BNB 鑄造」項目：${sym}\n轉 ${vb} BNB（約 ${(vb * price).toFixed(1)}U，${P.recvSeen} 個錢包都轉這個金額）· 進度約 ${Math.round(progress * 100)}%（${how}）\n${c}\n交易 ${r.tx}`);
              return;
            }
            if (kind === 'gen') {
              let data = '';
              for (; n >= 1; n--) {
                costWei = unit * BigInt(n);
                if (Number(costWei) / 1e18 * 1.005 > bal - PAID.keepBnb || !price || Number(costWei) / 1e18 * price > PAID.maxUsd) continue;
                data = '0xa0712d68' + w(n);
                try {
                  await rpc('eth_call', [{
                    from: W.addr,
                    to: c,
                    data,
                    value: '0x' + costWei.toString(16)
                  }, 'latest']);
                  break;
                } catch {}
              }
              if (n < 1) {
                noteFail(c, P, sym, progress);
                return;
              }
              const r = await previewExec(W, c, data, costWei, sim => {
                const mine = (sim?.balanceChanges || []).filter(b => String(b.owner).toLowerCase() === W.addr);
                if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
                const out = mine.filter(b => Number(b.change) < 0);
                if (out.some(b => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(costWei) * 1.01) return '會扣到 BNB 以外或超過價格';
                if (!mine.some(b => Number(b.change) > 0)) return '模擬沒拿到東西';
                return '';
              });
              const vb = Number(costWei) / 1e18;
              S.paidSpend[W.name] = spent + vb;
              P.done[W.name] = 'minted';
              await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}\n${n} 份，花 ${vb.toFixed(4)} BNB（約 ${(vb * price).toFixed(1)}U）· 進度約 ${Math.round(progress * 100)}%（${sold ?? '?'}／${cap ?? '?'}）\n${c}\n交易 ${r.tx}`);
              return;
            }
            if (kind === 'bnb') {
              for (; n >= 1; n--) {
                const q = await call(c, '0x68bce8cd' + w(n));
                costWei = q ? BigInt(q.slice(0, 66)) : 0n;
                if (costWei > 0n && Number(costWei) / 1e18 * 1.005 <= bal - PAID.keepBnb && price && Number(costWei) / 1e18 * 1.005 * price <= PAID.maxUsd) break;
              } // 買得起的最多份數（留 gas）
              if (n < 1) {
                P.lastReason = `每份太貴，超過 ${PAID.maxUsd}U 預算`;
                return;
              } // 太貴：先不打（進度到 85% 後上限會放寬到 25U，會再檢查）
              const v = costWei * 1005n / 1000n,
                vb = Number(v) / 1e18;
              if (spent + vb > PAID.maxBnbPerDay || bal - vb < PAID.keepBnb) return;
              const data = '0xe38fd349' + w(n) + wa('0x0000000000000000000000000000000000000000') + w(v);
              try {
                await rpc('eth_call', [{
                  from: W.addr,
                  to: c,
                  data,
                  value: '0x' + v.toString(16)
                }, 'latest']);
              } catch {
                noteFail(c, P, sym, progress);
                return;
              } // 還沒開或沒資格
              const pool = tokAddr ? Number(await poolOut(v, WBNB, tokAddr)) : 0;
              const r = await previewExec(W, c, data, v, sim => {
                if (pool > 0 && gotTok(sim, W) < pool * 1.1) log(`注意：${c} 已開池，鑄造沒有比池子便宜（新規則：進度 ≥80% 照打）`);
                const mine = (sim?.balanceChanges || []).filter(b => String(b.owner).toLowerCase() === W.addr);
                if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
                const out = mine.filter(b => Number(b.change) < 0);
                if (out.some(b => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(v) * 1.01) return '會扣到 BNB 以外的資產或超過報價';
                if (!mine.some(b => Number(b.change) > 0)) return '模擬沒拿到代幣';
                return '';
              }, async () => {
                const q2 = await call(c, '0x68bce8cd' + w(n));
                const c2 = q2 ? BigInt(q2.slice(0, 66)) : 0n;
                return c2 > costWei * 105n / 100n ? '價格剛剛漲了超過 5%' : '';
              }); /* 新功能：送出前再查一次價格 */
              S.paidSpend[W.name] = spent + vb;
              P.done[W.name] = 'minted';
              const usd = vb * price;
              await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}\n${n} 份，花 ${vb.toFixed(4)} BNB（約 ${usd.toFixed(1)}U）· 已售 ${sold ?? '?'} 份 · 進度約 ${Math.round(progress * 100)}%\n${c}\n交易 ${r.tx}\n已加入監控：${ruleTxt()}`);
            } else {
              for (; n >= 1; n--) {
                const q = await call(c, '0x725c4058' + w(n));
                costWei = q ? BigInt(q.slice(0, 66)) : 0n;
                if (costWei > 0n && price && Number(costWei) / 1e18 * 1.03 / price <= bal - PAID.keepBnb && Number(costWei) / 1e18 <= PAID.maxUsd) break;
              }
              if (n < 1) {
                P.lastReason = `每份太貴，超過 ${PAID.maxUsd}U 預算`;
                return;
              } // 太貴：先不打（進度到 85% 後上限會放寬到 25U，會再檢查）
              const cu = Number(costWei) / 1e18,
                needBnb = cu * 1.03 / price;
              if (!price || spent + needBnb > PAID.maxBnbPerDay || bal - needBnb < PAID.keepBnb) return;
              const data = '0x94bf804d' + w(n) + wa('0x0000000000000000000000000000000000000000');
              let ub = big(await call(USDT, '0x70a08231' + wa(W.addr)));
              if (ub < costWei) {
                const sw = await swapConfirmed(W, ['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', needBnb.toFixed(6), '--fromToken', NATIVE_BNB, '--toToken', USDT]);
                if (!sw.j?.success) throw new Error('BNB 換 USDT 失敗 ' + (sw.j?.error?.message || sw.t).slice(0, 100));
                for (let i = 0; i < 30 && ub < costWei; i++) {
                  await sleep(3000);
                  ub = big(await call(USDT, '0x70a08231' + wa(W.addr)));
                }
                if (ub < costWei) throw new Error('USDT 沒到帳');
              }
              const pool = tokAddr ? Number(await poolOut(costWei, USDT, tokAddr)) : 0;
              const r = await approvedMint(W, USDT, c, costWei, () => previewExec(W, c, data, 0n, sim => {
                if (pool > 0 && gotTok(sim, W) < pool * 1.1) log(`注意：${c} 已開池，鑄造沒有比池子便宜（新規則：進度 ≥80% 照打）`);
                const mine = (sim?.balanceChanges || []).filter(b => String(b.owner).toLowerCase() === W.addr);
                const out = mine.filter(b => Number(b.change) < 0);
                if (out.some(b => String(b.contractAddress).toLowerCase() !== USDT) || out.reduce((a, b) => a - Number(b.change), 0) > Number(costWei) * 1.01) return '會扣到 USDT 以外或超過報價';
                if (!mine.some(b => Number(b.change) > 0)) return '模擬沒拿到代幣';
                return '';
              }, async () => {
                const q2 = await call(c, '0x725c4058' + w(n));
                const c2 = q2 ? BigInt(q2.slice(0, 66)) : 0n;
                return c2 > costWei * 105n / 100n ? '價格剛剛漲了超過 5%' : '';
              })); /* 新功能：送出前再查一次價格 */
              S.paidSpend[W.name] = spent + needBnb;
              P.done[W.name] = 'minted';
              await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}\n${n} 份，花 ${cu.toFixed(2)} USDT（由 BNB 換）· 已售 ${sold ?? '?'} 份 · 進度約 ${Math.round(progress * 100)}%\n${c}\n交易 ${r.tx}\n已加入監控：${ruleTxt()}`);
            }
          } catch (e) {
            if (e.message.includes('結果不明')) {
              P.done[W.name] = 'unknown';
              log(`paid ${c} ${W.name} ${e.message}`);
              await tg(`⚠️ [${W.name}] ${sym} 送出結果不明（逾時），為避免重打已停止，請到錢包確認有沒有打到\n${c}`);
              return;
            }
            if (e.message.includes('已開池')) {
              P.done[W.name] = 'pool-cheaper';
              log(`paid ${c} ${W.name} ${e.message}`);
              return;
            }
            if (/價格剛剛漲了/.test(e.message)) {
              log(`paid ${c} ${W.name} ${e.message}（下一輪再打）`);
              return;
            }
            P.failW = P.failW || {};
            P.failW[W.name] = (P.failW[W.name] || 0) + 1;
            P.fail = (P.fail || 0) + 1;
            log(`paid ${c} ${W.name} ${e.message}`);
            if (kind === 'replay' && P.fail >= 6) {
              markUnmintable(c, P, sym, progress, '照別人的方式預演一直失敗');
              return;
            } /* 審查 11/1：照抄型 2 次失敗就放棄太快、價格變動不算失敗、失敗按錢包算 */
            if (P.failW[W.name] >= 6) {
              P.done[W.name] = 'fail';
              await tg(`⚠️ [${W.name}] 付費項目 ${sym} 自動打失敗，已放棄：${e.message.slice(0, 150)}\n${c}`);
            }
          }
        }));
      } finally {
        busyP.delete(c);
        const dt = Date.now() - tE;
        if (dt > 10e3) log(`檢查 ${c} 花了 ${Math.round(dt / 1000)} 秒（${mode}）`);
      }
    }
  }
  return {
    get autoMint() {
      return autoMint;
    },
    get queueMint() {
      return queueMint;
    },
    get progressSweep() {
      return progressSweep;
    },
    get heatTier() {
      return heatTier;
    },
    get paidLoop() {
      return paidLoop;
    }
  };
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJmZWVEYXkiLCJjcmVhdGVNaW50aW5nIiwiZGVwZW5kZW5jaWVzIiwiYWN0aXZpdHkiLCJBR19NSU4iLCJDQU5EUyIsIkNPTkZJRyIsIkZBQ1RPUlkiLCJGT1JDRSIsIkdPX1BDVCIsIkhPVCIsIklORlJBIiwiTkFUSVZFX0JOQiIsIlBBSUQiLCJSRUZVTkRfU0VMUyIsIlMiLCJUX1RSQU5TRkVSIiwiVVNEVCIsIldBTExFVFMiLCJXQk5CIiwiYXBwcm92ZWRNaW50IiwiYmFkU2VsIiwiYmlnIiwiYm5iVXNkIiwiY2FsbCIsImNjIiwiY29kZU9mIiwiZGVwbG95ZXJPZiIsImVuZm9yY2VNaW50UmlzayIsImZpbmRDYXBTZWwiLCJmaW5kRnJlZSIsImZpdFNoYXJlcyIsImZsYXBHdWFyZCIsImZwQ2FjaGUiLCJmcmVlUHJvZ3Jlc3MiLCJmcmVzaERlYWRsaW5lIiwiZnJlc2hXYWxsZXQiLCJmdWxsQ29kZSIsImdyb3VwUHJvZ3Jlc3MiLCJpc1JlcGVhdERldiIsImlzU2VyaWFsIiwibGVhcm5SZXBsYXkiLCJsb2ciLCJub3RlRGV2IiwicG9vbE9wZW4iLCJwb29sT3V0IiwicHJldmlld0V4ZWMiLCJwcm9ncmVzc09mIiwicmVwZWF0RGV2T2siLCJyaXNrQmxvY2siLCJycGMiLCJydWxlVHh0Iiwic2FmZUFkZHJzIiwic2NhbGVWIiwic2VyaWFsRGV2Iiwic2xlZXAiLCJzdWJtaXRDb250cmFjdCIsInN3YXBDb25maXJtZWQiLCJ0ZyIsInRva1N0ciIsInRzIiwidXBncmFkZWFibGUiLCJ3Iiwid2EiLCJ3YWxsZXQiLCJkZWZlciIsIk1RIiwiTWFwIiwiZnJlZU5vdGVkIiwibm90ZUZyZWUiLCJjIiwiVyIsIm5hbWUiLCJmaXJzdCIsImhhcyIsInNldCIsIlNldCIsImdldCIsImFkZCIsIm9rIiwiZGVsZXRlIiwibm0iLCJzbGljZSIsIm1hcCIsIngiLCJqb2luIiwiY2F0Y2giLCJNUUsiLCJxdWV1ZU1pbnQiLCJmbmFtZSIsInYiLCJzdG9wcGluZyIsInFrIiwicGFpZCIsImRvbmUiLCJwcmV2IiwiUHJvbWlzZSIsInJlc29sdmUiLCJqb2IiLCJ0aGVuIiwiYXV0b01pbnRNYXgiLCJmaW5hbGx5IiwibSIsInN0YXJ0c1dpdGgiLCJpbmNsdWRlcyIsImF0IiwiRGF0ZSIsIm5vdyIsIndhaXRIb3QiLCJyZXBsYWNlIiwiZnJlZVRyYWNrIiwiZSIsIm1lc3NhZ2UiLCJ0cmFjayIsIk1BWF9SRVBFQVQiLCJ2YWwiLCJkIiwiT2JqZWN0IiwiZnJvbUVudHJpZXMiLCJhdXRvTWludCIsIm4iLCJ2MiIsImZyb20iLCJhZGRyIiwidG8iLCJkYXRhIiwidmFsdWUiLCJwcm9ncmVzc1N3ZWVwIiwibGlzdCIsImVudHJpZXMiLCJmaWx0ZXIiLCJQIiwidW5taW50YWJsZSIsInByb2dyZXNzIiwiZXZlcnkiLCJzb3J0IiwieSIsInN3ZWVwQXQiLCJpIiwiYWxsIiwiQXJyYXkiLCJsZW5ndGgiLCJwcm9nQXQiLCJmcCIsInNvbGRTZWwiLCJzciIsInNvbGQiLCJOdW1iZXIiLCJCaWdJbnQiLCJjYXBTZWwiLCJ1bmRlZmluZWQiLCJjciIsImNhcCIsInN3TG9nIiwiTWF0aCIsInJvdW5kIiwibWluIiwic2QiLCJmZWVSZWZ1bmQiLCJmYyIsInNvbWUiLCJhZ2VudHNOIiwiYWdlbnRzIiwiZmxvb3IiLCJ0ayIsInRyMCIsIm1heFVzZCIsInRlc3QiLCJ0b2RheSIsInRpbWVab25lIiwibWludERheSIsIm1pbnRDb3VudCIsIm1pbnRDbnQiLCJibmIiLCJyYiIsInAiLCJ0b1N0cmluZyIsInNpbSIsImoiLCJzaW11bGF0aW9uUmVzdWx0IiwicmlkIiwicmVxdWVzdElkIiwic3VjY2VzcyIsImVycm9yIiwiZmciLCJsb3NpbmciLCJiYWxhbmNlQ2hhbmdlcyIsImIiLCJTdHJpbmciLCJvd25lciIsInRvTG93ZXJDYXNlIiwiY2hhbmdlIiwiY29udHJhY3RBZGRyZXNzIiwiYWxsb3dhbmNlQ2hhbmdlcyIsImF1dGhvcml0eUNoYW5nZXMiLCJ0b2tlblR5cGUiLCJjb25maXJtZWQiLCJyZXN1bHQiLCJnb3QiLCJ0eEhhc2giLCJvcmRlcklkIiwiZ290VG9rIiwicmVkdWNlIiwiYSIsImhlYXRUaWVyIiwiYnVyc3QiLCJtYXJrVW5taW50YWJsZSIsInN5bSIsIndoeSIsImxhc3RSZWFzb24iLCJ1bm1pbnRhYmxlQXQiLCJub3RlRmFpbCIsImNmIiwiYnVzeVAiLCJwYWlkTG9vcCIsIm1vZGUiLCJzaGFyZCIsInVtUmVzZXQiLCJ2YWx1ZXMiLCJmYWlsIiwicmVwbGF5IiwibGVhcm5lZCIsImR5biIsInBhaWRTcGVuZCIsIm1pc3NlZCIsIm1pc3NlZENsZWFuMSIsImsiLCJyZWZ1bmRSZXNldCIsInJlZnVuZE9rIiwibm9SZWZ1bmRMb2ciLCJkYXkiLCJwcmljZSIsImZvcmNlRG9uZSIsIm1pZ3JhdGVkMiIsImtleXMiLCJzZWVuTWludHMiLCJjZCIsImhvdFAiLCJtYXgiLCJzaXplIiwicmVzdCIsImxhc3RUcnkiLCJlbnRzIiwiY29uY2F0IiwidEUiLCJtYXhBZ2VIIiwiY29kZSIsImZjZCIsImZyZWVUcnlBdCIsImZmIiwicUF0Iiwia2luZCIsInVuaXQiLCJzZWwiLCJyIiwicmVjdlZhbHVlIiwibmVlZExlYXJuIiwidW1OIiwic29sZFIiLCJ0b2tBZGRyMCIsImhvdyIsInByIiwicHJvZ0JhZCIsInRvRml4ZWQiLCJwcmV2UHJvZyIsInNlcmlhbExvZyIsInBoIiwidCIsInB1c2giLCJmb3JjZWQiLCJ0aWVyIiwibmVlZFBjdCIsImNyb3dkR28iLCJwYXlpbmciLCJwYXlUb2siLCJ1cGdMb2ciLCJnYXRlIiwiZ29Mb2dnZWQiLCJkZXAiLCJkZXBsb3llciIsImRldnMiLCJibGFjayIsImJsYWNrTG9nZ2VkIiwiZnJlc2giLCJmcmVzaExvZ2dlZCIsImRyYWluIiwiY2IiLCJwYWlyIiwibmVlZFciLCJyZXBlYXRPayIsInJlcGVhdEF0IiwiZGV2TG9nZ2VkIiwib2xkIiwiaGVhZCIsInBhcnNlSW50IiwibyIsInBvb2xTa2lwTG9nIiwic2VyaWFsTG9nZ2VkIiwibmVlZCIsInNlZW4iLCJ3YWxsZXRzIiwid0F0IiwiYWRkcmVzcyIsImZyb21CbG9jayIsInRvQmxvY2siLCJ0b3BpY3MiLCJ1bmlxIiwibCIsInRva0FkZHIiLCJ0ciIsInJpc2tMb2ciLCJzcGVudCIsImJhbCIsImNvc3RXZWkiLCJwYXlUb2tMb2dnZWQiLCJsZWFybmVkQXQiLCJsciIsInBheUFtdCIsIndzIiwibWF0Y2giLCJuMCIsIm14Iiwibm4iLCJtcCIsInViIiwibmIiLCJrZWVwQm5iIiwic3ciLCJFcnJvciIsIm1pbmUiLCJvdXQiLCJwYWlkVSIsInVzZCIsImhvdCIsInR4IiwidmIiLCJ3MCIsIm4xIiwicGFkU3RhcnQiLCJyZGF0YSIsInJkMCIsImdvb2QiLCJkMiIsInYycyIsImRkIiwicGN0IiwidlUiLCJoaXQiLCJkMyIsInJlY3ZWYWxzIiwicmVjdlNlZW4iLCJxIiwibWF4Qm5iUGVyRGF5IiwicG9vbCIsInEyIiwiYzIiLCJjdSIsIm5lZWRCbmIiLCJmYWlsVyIsImR0Il0sInNvdXJjZXMiOlsibWludGluZy5tanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gTW9kdWxlOiBtaW50aW5nLiBDb25zdHJ1Y3Rpb24gaXMgaW5lcnQ7IEkvTyBpcyBpbnZva2VkIGV4cGxpY2l0bHkuXG5pbXBvcnQgeyBmZWVEYXkgfSBmcm9tICcuLi8uLi9yZWNlaXB0LWZlZXMubWpzJztcbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVNaW50aW5nKGRlcGVuZGVuY2llcykge1xuICBjb25zdCB7IGFjdGl2aXR5LCBBR19NSU4sIENBTkRTLCBDT05GSUcsIEZBQ1RPUlksIEZPUkNFLCBHT19QQ1QsIEhPVCwgSU5GUkEsIE5BVElWRV9CTkIsIFBBSUQsIFJFRlVORF9TRUxTLCBTLCBUX1RSQU5TRkVSLCBVU0RULCBXQUxMRVRTLCBXQk5CLCBhcHByb3ZlZE1pbnQsIGJhZFNlbCwgYmlnLCBibmJVc2QsIGNhbGwsIGNjLCBjb2RlT2YsIGRlcGxveWVyT2YsIGVuZm9yY2VNaW50UmlzaywgZmluZENhcFNlbCwgZmluZEZyZWUsIGZpdFNoYXJlcywgZmxhcEd1YXJkLCBmcENhY2hlLCBmcmVlUHJvZ3Jlc3MsIGZyZXNoRGVhZGxpbmUsIGZyZXNoV2FsbGV0LCBmdWxsQ29kZSwgZ3JvdXBQcm9ncmVzcywgaXNSZXBlYXREZXYsIGlzU2VyaWFsLCBsZWFyblJlcGxheSwgbG9nLCBub3RlRGV2LCBwb29sT3BlbiwgcG9vbE91dCwgcHJldmlld0V4ZWMsIHByb2dyZXNzT2YsIHJlcGVhdERldk9rLCByaXNrQmxvY2ssIHJwYywgcnVsZVR4dCwgc2FmZUFkZHJzLCBzY2FsZVYsIHNlcmlhbERldiwgc2xlZXAsIHN1Ym1pdENvbnRyYWN0LCBzd2FwQ29uZmlybWVkLCB0ZywgdG9rU3RyLCB0cywgdXBncmFkZWFibGUsIHcsIHdhLCB3YWxsZXQsIGRlZmVyIH0gPSBkZXBlbmRlbmNpZXM7XG4gIGNvbnN0IE1RID0gbmV3IE1hcCgpO1xuXG4gIGNvbnN0IGZyZWVOb3RlZCA9IG5ldyBNYXAoKTtcblxuICBmdW5jdGlvbiBub3RlRnJlZShjLCBXLCBuYW1lID0gJycpIHsgY29uc3QgZmlyc3QgPSAhZnJlZU5vdGVkLmhhcyhjKTsgaWYgKGZpcnN0KSBmcmVlTm90ZWQuc2V0KGMsIG5ldyBTZXQoKSk7IGZyZWVOb3RlZC5nZXQoYykuYWRkKFcubmFtZSk7IGlmIChmaXJzdCkgZGVmZXIoYXN5bmMgKCkgPT4geyBjb25zdCBvayA9IGZyZWVOb3RlZC5nZXQoYykgfHwgbmV3IFNldCgpOyBmcmVlTm90ZWQuZGVsZXRlKGMpOyBjb25zdCBubSA9IG5hbWUgfHwgdG9rU3RyKGF3YWl0IGNhbGwoYywgJzB4MDZmZGRlMDMnKSkgfHwgYy5zbGljZSgwLCAxMCk7IGF3YWl0IHRnKGDwn4aTIOaJk+S6huWFjeiyu+mgheebru+8miR7bm1977yIJHtXQUxMRVRTLm1hcCgoeCkgPT4geC5uYW1lICsgKG9rLmhhcyh4Lm5hbWUpID8gJyDinIUnIDogJyDinYwnKSkuam9pbign44CBJyl977yJXFxuJHtjfWApLmNhdGNoKCgpID0+IHt9KTsgfSwgMTUwZTMpOyB9XG5cbiAgY29uc3QgTVFLID0gbmV3IFNldCgpO1xuXG4gIGZ1bmN0aW9uIHF1ZXVlTWludChjLCBmbmFtZSwgVywgdikge1xuICAgIGlmIChhY3Rpdml0eS5zdG9wcGluZykgcmV0dXJuICdTdG9wcGluZyc7XG4gICAgY29uc3QgcWsgPSBjICsgJ3wnICsgVy5uYW1lOyBpZiAoTVFLLmhhcyhxaykpIHJldHVybiAn4o+zIOW3suWcqOaOkumaiuS4rSc7IGlmIChTLnBhaWQ/LltjXT8uZG9uZT8uW1cubmFtZV0gJiYgUy5wYWlkW2NdLmRvbmVbVy5uYW1lXSAhPT0gJ3Bvb2wtb3BlbicpIHJldHVybiAn4pyFIOmAmeWAi+mMouWMheW3sue2k+aJk+mBjic7XG4gICAgTVFLLmFkZChxayk7XG4gICAgY29uc3QgcHJldiA9IE1RLmdldChXLm5hbWUpIHx8IFByb21pc2UucmVzb2x2ZSgpO1xuICAgIGNvbnN0IGpvYiA9IHByZXYudGhlbigoKSA9PiBhY3Rpdml0eS5zdG9wcGluZyA/ICdTdG9wcGluZycgOiBhdXRvTWludE1heChjLCBmbmFtZSwgVywgdikpLmZpbmFsbHkoKCkgPT4gTVFLLmRlbGV0ZShxaykpLnRoZW4oYXN5bmMgKG0pID0+IHsgaWYgKG0uc3RhcnRzV2l0aCgn8J+klicpIHx8IG0uaW5jbHVkZXMoJ+e1kOaenOS4jeaYjicpKSB7IFMucGFpZCA9IFMucGFpZCB8fCB7fTsgaWYgKCFTLnBhaWRbY10pIFMucGFpZFtjXSA9IHsgYXQ6IERhdGUubm93KCksIG5hbWU6ICcnLCBkb25lOiB7fSB9OyBTLnBhaWRbY10uZG9uZVtXLm5hbWVdID0gbS5zdGFydHNXaXRoKCfwn6SWJykgPyAnZnJlZScgOiAndW5rbm93bic7IH0gZWxzZSBpZiAoIW0uc3RhcnRzV2l0aCgn4o+4JykgJiYgIW0uc3RhcnRzV2l0aCgn4pyFJykpIHsgUy5wYWlkID0gUy5wYWlkIHx8IHt9OyBpZiAoIVMucGFpZFtjXSkgUy5wYWlkW2NdID0geyBhdDogRGF0ZS5ub3coKSwgbmFtZTogJycsIGRvbmU6IHt9LCB3YWl0SG90OiAxIH07IH0gLyog5a+p5p+lIDExLzHvvJrnrKzkuIDmrKHlsLHlpLHmlZfvvIjpoJDmvJTlpLHmlZfjgIFCTkIg5LiN5aSg4oCm77yJ55qE5Lul5YmN5LiN5pyD5YaN6L+96LmkICovIGxvZyhgWyR7Vy5uYW1lfV0gJHtjfSAke20ucmVwbGFjZSgvXFxuL2csICcgfCAnKX1gKTsgaWYgKG0uc3RhcnRzV2l0aCgn8J+klicpKSB7IFMuZnJlZVRyYWNrID0gUy5mcmVlVHJhY2sgfHwge307IFMuZnJlZVRyYWNrW2NdID0gUy5mcmVlVHJhY2tbY10gfHwgeyBhdDogRGF0ZS5ub3coKSB9OyB9IGlmIChtLnN0YXJ0c1dpdGgoJ/CfpJYnKSkgbm90ZUZyZWUoYywgVyk7IH0pLmNhdGNoKChlKSA9PiBsb2coYFske1cubmFtZX1dIOmRhOmAoOWkseaVlyAke2N9ICR7ZS5tZXNzYWdlfWApKTtcbiAgICBNUS5zZXQoVy5uYW1lLCBhY3Rpdml0eS50cmFjayhqb2IpKTtcbiAgICByZXR1cm4gJ+KPsyDlt7LmjpLlhaXoh6rli5XpkYTpgKDvvIjog4zmma/pgLLooYzvvIknO1xuICB9XG5cbiAgY29uc3QgTUFYX1JFUEVBVCA9IDEwO1xuXG4gIGFzeW5jIGZ1bmN0aW9uIGF1dG9NaW50TWF4KGMsIGZuYW1lLCBXLCB2YWwgPSAwbikge1xuICAgIGNvbnN0IGQgPSBPYmplY3QuZnJvbUVudHJpZXMoQ0FORFMpW2ZuYW1lXTsgbGV0IGZpcnN0ID0gYXdhaXQgYXV0b01pbnQoYywgZm5hbWUsIFcsIHZhbCksIG4gPSBmaXJzdC5zdGFydHNXaXRoKCfwn6SWJykgPyAxIDogMDtcbiAgICB3aGlsZSAoIWFjdGl2aXR5LnN0b3BwaW5nICYmIG4gPiAwICYmIG4gPCBNQVhfUkVQRUFUKSB7XG4gICAgICBhd2FpdCBzbGVlcCg2MDAwKTtcbiAgICAgIC8vIOesrOS4gOS7veWFjeiyu+OAgeS5i+W+jOimgeS7mOS4gOm7nueahO+8iOWDjyBRVU9HRU5U77yJ77ya5q+P5qyh6YeN5paw5om+6IO96YGO55qE6YeR6aGN77yI4omkMC4wMDEgQk5C77yJXG4gICAgICAvLyDpmLLph6PprZrvvJrlj6rmnInjgIzlrozlhajlhY3osrvjgI3miY3pgKPnuozmiZPvvJvopoHku5jmiYvnuozosrvnmoTmr4/lgIvpoIXnm67mr4/lgIvpjKLljIXlj6rmiZMgMSDku73vvIjpgb/lhY3ooqvmlYXmhI/nmbznm6Tos7rmiYvnuozosrvvvIlcbiAgICAgIGxldCB2MiA9IG51bGw7IHRyeSB7IGF3YWl0IHJwYygnZXRoX2NhbGwnLCBbeyBmcm9tOiBXLmFkZHIsIHRvOiBjLCBkYXRhOiBkLCB2YWx1ZTogJzB4MCcgfSwgJ2xhdGVzdCddKTsgdjIgPSAwbjsgfSBjYXRjaCB7fVxuICAgICAgaWYgKHYyID09IG51bGwpIGJyZWFrO1xuICAgICAgY29uc3QgbSA9IGF3YWl0IGF1dG9NaW50KGMsIGZuYW1lLCBXLCB2Mik7IGlmICghbS5zdGFydHNXaXRoKCfwn6SWJykpIGJyZWFrOyBuKys7XG4gICAgfVxuICAgIHJldHVybiBuID4gMSA/IGZpcnN0ICsgYFxcbu+8iOWQjOS4gOWAi+mMouWMheWFseaJk+S6hiAke259IOS7ve+8iWAgOiBmaXJzdDtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIHByb2dyZXNzU3dlZXAoKSB7IC8qIOS9v+eUqOiAhSAxMC8zMSAyMzoyMSDmn6UgUHVsc2VwYW50aGVyIOaykuaJk+WIsO+8mui/vei5pOWQjeWWriA1MDAg5aSa5YCL77yM5LiA6Iis5qqi5p+l5q+P6Lyq5Y+q55yLIDE2IOWAi+OAgeS4gOWAi+imgSAxMH4zMCDnp5LvvIzkvY7pgLLluqbnmoTpoIXnm67opoEgMn4zIOWwj+aZguaJjeWbnumgreeci+S4gOasoe+8jDEwJSDnm7TmjqXmvLLliLAgMTAwJSDpg73mspLnmbznj77jgILmlLnmiJDmr4/liIbpkJjnlKjovJXph4/mlrnlvI/lj6roroDpgLLluqbvvIjmnIDlpJogODAg5YCL44CBNiDlgIvlkIzmmYLvvInvvIzpgLLluqbpgY4gNDUlIOWwseacg+mAsuW/q+mAn+WQjeWWru+8jOavjyAxNSDnp5LmqqLmn6UgKi9cbiAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpOyBjb25zdCBsaXN0ID0gT2JqZWN0LmVudHJpZXMoUy5wYWlkIHx8IHt9KS5maWx0ZXIoKFtjLCBQXSkgPT4gIVAudW5taW50YWJsZSAmJiAoUC5wcm9ncmVzcyB8fCAwKSA8IDAuOTk5ICYmIG5vdyAtIChQLmF0IHx8IDApIDwgMyAqIDg2NDAwZTMgJiYgIVdBTExFVFMuZXZlcnkoKFcpID0+IFAuZG9uZT8uW1cubmFtZV0pKS5zb3J0KCh4LCB5KSA9PiAoeFsxXS5zd2VlcEF0IHx8IDApIC0gKHlbMV0uc3dlZXBBdCB8fCAwKSkuc2xpY2UoMCwgODApO1xuICAgIGxldCBpID0gMDsgYXdhaXQgUHJvbWlzZS5hbGwoQXJyYXkuZnJvbSh7IGxlbmd0aDogNiB9LCBhc3luYyAoKSA9PiB7IHdoaWxlIChpIDwgbGlzdC5sZW5ndGgpIHsgY29uc3QgW2MsIFBdID0gbGlzdFtpKytdOyB0cnkgeyBpZiAoUC5wcm9nQXQgJiYgRGF0ZS5ub3coKSAtIFAucHJvZ0F0IDwgMTgwZTMpIHsgUC5zd2VlcEF0ID0gRGF0ZS5ub3coKTsgY29udGludWU7IH0gLyog6Zmk6Yyv77ya5q2j5byP5qqi5p+lIDMg5YiG6ZCY5YWn5Ymb6K6A6YGO55qE5LiN6KaG6JOL77yI6YG/5YWN6K6A5rOV5LiN5ZCM5oqK5bey6LOj5a6M55qE5Y+I5ouJ5Zue5b+r6YCf5ZCN5Zau44CB5L2U5ZCN6aGN77yJICovIGxldCBmcCA9IG51bGw7IGlmIChQLnNvbGRTZWwpIHsgLyog6Zmk6YyvIDExLzHvvJpiaWJpYWkgQUdFTlQgSUQg55So44CM5bey5ZSu77yP57i96YeP44CN5omN6K6A5b6X5Yiw77yI5bey5ZSuIGEyMzA5ZmY444CB57i96YePIGEwZTIzZWJk77yJ77yM5LiA6Iis5YWN6LK76K6A5rOV6K6A5LiN5YiwIOKGkiDljaHlnKggMCUg5YWp5bCP5pmC5rKS5Zue6aCt55yL77yM5ryy5YiwIDkyJSDpg73kuI3nn6XpgZMgKi8gY29uc3Qgc3IgPSBhd2FpdCBjYWxsKGMsIFAuc29sZFNlbCk7IGNvbnN0IHNvbGQgPSBzciAmJiBzci5sZW5ndGggPj0gNjYgPyBOdW1iZXIoQmlnSW50KHNyLnNsaWNlKDAsIDY2KSkpIDogbnVsbDsgaWYgKHNvbGQgPiAwKSB7IGlmIChQLmNhcFNlbCA9PT0gdW5kZWZpbmVkKSBQLmNhcFNlbCA9IChhd2FpdCBmaW5kQ2FwU2VsKGMsIGF3YWl0IGZ1bGxDb2RlKGMsIGF3YWl0IGNvZGVPZihjKSkuY2F0Y2goKCkgPT4gJycpLCBzb2xkKS5jYXRjaCgoKSA9PiAnJykpIHx8ICcnOyBpZiAoUC5jYXBTZWwpIHsgY29uc3QgY3IgPSBhd2FpdCBjYWxsKGMsICcweCcgKyBQLmNhcFNlbCk7IGNvbnN0IGNhcCA9IGNyICYmIGNyLmxlbmd0aCA+PSA2NiA/IE51bWJlcihCaWdJbnQoY3Iuc2xpY2UoMCwgNjYpKSkgOiAwOyBpZiAoY2FwID49IHNvbGQgJiYgY2FwID4gMCkgZnAgPSBzb2xkIC8gY2FwOyB9IH0gfVxuICAgICAgICBpZiAoZnAgPT0gbnVsbCkgZnAgPSBhd2FpdCBmcmVlUHJvZ3Jlc3MoYyk7IFAuc3dlZXBBdCA9IERhdGUubm93KCk7IGlmIChmcCAhPSBudWxsICYmIGZwID4gMCkgeyBpZiAoZnAgPj0gMC40NSAmJiAoUC5wcm9ncmVzcyB8fCAwKSA8IDAuNDUgJiYgIVAuc3dMb2cpIHsgUC5zd0xvZyA9IDE7IGxvZyhg6YCy5bqm5o6D5o+P77yaJHtQLm5hbWUgfHwgY30g6YCy5bqmICR7TWF0aC5yb3VuZChmcCAqIDEwMCl9Je+8jOenu+WIsOW/q+mAn+aqouafpWApOyB9IFAucHJvZ3Jlc3MgPSBmcCA+PSAwLjk5OSAmJiAhUC5wcm9nQXQgPyAxIDogTWF0aC5taW4oZnAsIDAuOTkpOyAvKiDlr6nmn6UgMTEvMe+8muWFjeiyu+WQiOe0hOato+W8j+aqouafpeS4jeacg+iugOmAsuW6pu+8jOizo+WujOeahOacg+awuOmBoOWNoSA5OSUg5L2U5b+r6YCf5ZCN5ZauIOKGkiDnm7TmjqXoqJggMTAwJSAqLyAvKiAxMDAlIOS6pOe1puW/q+mAn+aqouafpeeUqOato+W8j+iugOazleeiuuiqje+8jOmBv+WFjeiugOmMr+WwseawuOmBoOS4jeeciyAqLyB9IH0gY2F0Y2gge30gfSB9KSk7XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBhdXRvTWludChjLCBmbmFtZSwgVyA9IFdBTExFVFNbMF0sIHZhbCA9IDBuKSB7XG4gICAgLyog5L2/55So6ICFIDEwLzMxIDE5OjIx77ya5paw6KaP5YmH4oCU4oCU5LiN566h5YWN6LK76YKE5piv5LuY6LK777yM6YCy5bqm6LaF6YGOIDUwJSDlsLHmiZPvvIzkuYvliY3nmoTopo/nn6nvvIjph43opIcgREVW44CB6buR5ZCN5Zau44CB54ax5bqm44CB5omL57qM6LK75LiK6ZmQ4oCm77yJ5YWo6YOo5LiN55yL77yb5Y+q5L+d55WZ6LKU6LKF6aGe5a6J5YWo5qqi5p+l77yI5q+P562G6YO95qih5pOs44CB5LiN6IO95o6I5qyK44CB5LiN6IO95omj5Yiw6aCQ5pyf5aSW55qE6LOH55Si44CBRmxhcCDnpoHmraLvvInjgILoroDkuI3liLDpgLLluqbnmoTmiY3nlKjnhrHluqbliKTmlrcgKi9cbiAgICB7IGNvbnN0IHNkID0gYXdhaXQgc2VyaWFsRGV2KGMpOyBpZiAoc2QpIHJldHVybiBg4puUICR7c2R977yM54Wn6KaP5YmH5LiN5omTYDsgfVxuICAgIGlmICh2YWwgPiAwbikgeyAvKiDkvb/nlKjogIUgMTEvMSAxNDoxNu+8muOAjOS7mOaJi+e6jOiyu+eahOWFjeiyu+OAjeS4gOW+i+eVtuS7mOiyu+KAlOKAlOS7iuWkqeiiq+mAmeeoruWwj+mgheebruaOj+S6hue0hCAwLjE5NSBCTkLvvJvopoHku5jpjKLlsLHlv4XpoIjmnInkv53mnKzvvIjpgIDmrL7vvInmqZ/liLbmiY3miZMgKi9cbiAgICAgIFMuZmVlUmVmdW5kID0gUy5mZWVSZWZ1bmQgfHwge307IGlmIChTLmZlZVJlZnVuZFtjXSA9PSBudWxsKSB7IGNvbnN0IGZjID0gYXdhaXQgZnVsbENvZGUoYywgYXdhaXQgY29kZU9mKGMpKS5jYXRjaCgoKSA9PiAnJyk7IFMuZmVlUmVmdW5kW2NdID0gUkVGVU5EX1NFTFMuc29tZSgoeCkgPT4gZmMuaW5jbHVkZXMoeCkpID8gMSA6IDA7IH1cbiAgICAgIGlmICghUy5mZWVSZWZ1bmRbY10pIHJldHVybiBg4o+4IOimgeS7mCAke051bWJlcih2YWwpIC8gMWUxOH0gQk5CIOaJi+e6jOiyu++8iOS4jeaYr+ecn+eahOWFjeiyu++8ie+8jOWQiOe0hOaykuacieS/neacrOapn+WItu+8jOeFp+imj+WJh+S4jeaJk2A7XG4gICAgICBpZiAoYXdhaXQgdXBncmFkZWFibGUoYykuY2F0Y2goKCkgPT4gZmFsc2UpKSByZXR1cm4gJ+KPuCDopoHku5jmiYvnuozosrvvvIzogIzkuJTmmK/lj6/ljYfntJrlkIjntITvvIjkv53mnKzmqZ/liLblj6/og73ooqvmj5vmjonvvInvvIznhafpoqjmjqfkuI3miZMnO1xuICAgIH1cbiAgICBjb25zdCBmcCA9IGF3YWl0IGZyZWVQcm9ncmVzcyhjKTtcbiAgICBjb25zdCBhZ2VudHNOID0gUy5wYWlkPy5bY10/LmFnZW50cyB8fCAwOyAvKiDlr6nmn6UgMTEvMe+8muWPqueulyBBZ2VudCBJRCDpjKLljIUgKi8gLyog5L2/55So6ICFIDEwLzMxIDE5OjQ177ya5YWN6LK75Lmf5LiA5qij4oCU4oCU6YCy5bqm6YGOIDYwJSDmiY3miZPvvJvoroDkuI3liLDpgLLluqbopoEgMTAwIOWAi+S7peS4iumMouWMheWcqOaJkyAqL1xuICAgIGlmIChmcCAhPSBudWxsICYmIGZwIDwgR09fUENUKSB7IC8qIOS9v+eUqOiAhSAxMS8xIDAyOjM377ya6ZaA5qq7IDYwJSAqLyBTLnBhaWQgPSBTLnBhaWQgfHwge307IGlmICghUy5wYWlkW2NdKSBTLnBhaWRbY10gPSB7IGF0OiBEYXRlLm5vdygpLCBuYW1lOiAnJywgZG9uZToge30sIHdhaXRIb3Q6IDEgfTsgcmV0dXJuIGDij7gg6YCy5bqmICR7TWF0aC5mbG9vcihmcCAqIDEwMCl9Je+8jOmChOaykuWIsCAke01hdGgucm91bmQoR09fUENUICogMTAwKX0l77yM5YWI6L+96Lmk77yM5Yiw5LqG5bCx5omTYDsgfVxuICAgIGlmIChmcCAhPSBudWxsICYmIGFnZW50c04gPCBBR19NSU4pIHsgUy5wYWlkID0gUy5wYWlkIHx8IHt9OyBpZiAoIVMucGFpZFtjXSkgUy5wYWlkW2NdID0geyBhdDogRGF0ZS5ub3coKSwgbmFtZTogJycsIGRvbmU6IHt9LCB3YWl0SG90OiAxIH07IHJldHVybiBg4o+4IOmAsuW6piAke01hdGguZmxvb3IoZnAgKiAxMDApfSUg5aSg5LqG77yM5L2G5Y+q5pyJICR7YWdlbnRzTn0g5YCLIEFnZW50IElEIOmMouWMheWcqOaJk++8iOimgSAke0FHX01JTn0g5YCL5Lul5LiK77yM6Ziy6aCF55uu5pa56Ieq5bex54GM6YCy5bqm77yJ77yM5YWI6L+96LmkYDsgfVxuICAgIGlmIChmcCA9PSBudWxsICYmIGFnZW50c04gPj0gQUdfTUlOKSB7IGxldCB0ayA9IGM7IGNvbnN0IHRyMCA9IGF3YWl0IGNhbGwoYywgJzB4ZmMwYzU0NmEnKTsgaWYgKHRyMCAmJiB0cjAubGVuZ3RoID49IDY2ICYmIEJpZ0ludCh0cjAuc2xpY2UoMCwgNjYpKSA+IDBuKSB0ayA9ICcweCcgKyB0cjAuc2xpY2UoMjYsIDY2KTsgaWYgKGF3YWl0IHBvb2xPcGVuKHRrKSkgcmV0dXJuICfij7gg6K6A5LiN5Yiw6YCy5bqm44CB5bey57aT6ZaL5rGg77yM5LiN6ZGE6YCg77yI6ZGE6YCg6YCa5bi45q+U5biC5YO56LK077yJJzsgfVxuICAgIGlmIChmcCA9PSBudWxsICYmIGFnZW50c04gPCBBR19NSU4pIHsgUy5wYWlkID0gUy5wYWlkIHx8IHt9OyBpZiAoIVMucGFpZFtjXSkgUy5wYWlkW2NdID0geyBhdDogRGF0ZS5ub3coKSwgbmFtZTogJycsIGRvbmU6IHt9LCB3YWl0SG90OiAxIH07IHJldHVybiBg4o+4IOiugOS4jeWIsOmAsuW6pu+8jOebruWJjSAke2FnZW50c059IOWAi+mMouWMheWcqOaJk++8jOimgSAke0FHX01JTn0g5YCL5Lul5LiK5omN5omT77yM5YWI6L+96LmkYDsgfVxuICAgIGlmICh2YWwgPiAwbiAmJiAoTnVtYmVyKHZhbCkgLyAxZTE4KSAqICgoYXdhaXQgYm5iVXNkKCkuY2F0Y2goKCkgPT4gMCkpIHx8IDcwMCkgPiBQQUlELm1heFVzZCkgcmV0dXJuIGDij7gg5omL57qM6LK76LaF6YGOICR7UEFJRC5tYXhVc2R9VSDkuIrpmZDvvIzmspLmnInpkYRgO1xuICAgIGxldCBkID0gT2JqZWN0LmZyb21FbnRyaWVzKENBTkRTKVtmbmFtZV07IGlmIChkICYmIC/ph43mkq1854ax6ZaA5Ye95byPLy50ZXN0KGZuYW1lKSkgZCA9IGZyZXNoRGVhZGxpbmUoZCk7IC8qIOeFp+aKhOeahOWFjeiyu+mRhOmAoOS5n+aPm+aWsOacn+mZkCAqL1xuICAgIGNvbnN0IHRvZGF5ID0gZmVlRGF5KERhdGUubm93KCksIENPTkZJRy50aW1lWm9uZSB8fCAnQXNpYS9TaGFuZ2hhaScpOyBpZiAoUy5taW50RGF5ICE9PSB0b2RheSkgeyBTLm1pbnREYXkgPSB0b2RheTsgUy5taW50Q291bnQgPSAwOyB9XG4gICAgUy5taW50Q250ID0gUy5taW50Q250ICYmIFMubWludENudC5kID09PSB0b2RheSA/IFMubWludENudCA6IHsgZDogdG9kYXkgfTsgaWYgKChTLm1pbnRDbnRbVy5uYW1lXSB8fCAwKSA+PSAxMDAwKSByZXR1cm4gJ+KPuCDpgJnlgIvpjKLljIXku4rlpKnoh6rli5XpkYTlt7LpgZQgMTAwMCDnrYbkuIrpmZDvvIzmspLmnInpkYQnO1xuICAgIGNvbnN0IGJuYiA9IEJpZ0ludCgoYXdhaXQgcnBjKCdldGhfZ2V0QmFsYW5jZScsIFtXLmFkZHIsICdsYXRlc3QnXSkuY2F0Y2goKCkgPT4gJzB4MCcpKSB8fCAnMHgwJyk7XG4gICAgaWYgKGJuYiA8IDVuICogMTBuICoqIDE0bikgcmV0dXJuICfimqDvuI8gQk5CIOS4jeWkoOS7mCBnYXPvvIg8IDAuMDAwNe+8ie+8jOaykuaciemRhCc7XG4gICAgeyBjb25zdCByYiA9IGF3YWl0IHJpc2tCbG9jayhXLCBjLCB2YWwsIGQsIHZhbCA9PT0gMG4pOyBpZiAocmIpIHJldHVybiAn4o+4IOmiqOaOp++8micgKyByYiArICfvvIzmspLmnInpkYQnOyB9XG4gICAgY29uc3QgcCA9IGF3YWl0IHdhbGxldC5jYWxsKFcuYWRkciwgWydjb250cmFjdC1jYWxsJywgJ3ByZXZpZXcnLCAnLS1iaW5hbmNlQ2hhaW5JZCcsICc1NicsICctLWZyb20nLCBXLmFkZHIsICctLXRvJywgYywgJy0tdmFsdWUnLCB2YWwudG9TdHJpbmcoKSwgJy0taW5wdXREYXRhJywgZF0pO1xuICAgIGNvbnN0IHNpbSA9IHAuaj8uZGF0YT8uc2ltdWxhdGlvblJlc3VsdCwgcmlkID0gcC5qPy5kYXRhPy5yZXF1ZXN0SWQ7XG4gICAgaWYgKCFwLmo/LnN1Y2Nlc3MgfHwgIXJpZCkgcmV0dXJuICfinYwg6aCQ5ryU5aSx5pWX77yM5rKS5pyJ6ZGE77yaJyArIChwLmo/LmVycm9yPy5tZXNzYWdlIHx8ICcnKS5zbGljZSgwLCAxMjApO1xuICAgIHsgY29uc3QgZmcgPSBmbGFwR3VhcmQoYywgZCwgc2ltKTsgaWYgKGZnKSByZXR1cm4gJ+KblCAnICsgZmcgKyAn77yM5rKS5pyJ6ZGEJzsgfVxuICAgIGNvbnN0IGxvc2luZyA9IChzaW0/LmJhbGFuY2VDaGFuZ2VzIHx8IFtdKS5maWx0ZXIoKGIpID0+IFN0cmluZyhiLm93bmVyKS50b0xvd2VyQ2FzZSgpID09PSBXLmFkZHIgJiYgTnVtYmVyKGIuY2hhbmdlKSA8IDAgJiYgIShTdHJpbmcoYi5jb250cmFjdEFkZHJlc3MpLnRvTG93ZXJDYXNlKCkuc3RhcnRzV2l0aCgnMHhlZWVlJykgJiYgLU51bWJlcihiLmNoYW5nZSkgPD0gTnVtYmVyKHZhbCkgJiYgdmFsID4gMG4pKTsgLyog6aKo5o6n77ya5omj55qEIEJOQiDkuI3og73mr5Toqqrlpb3nmoTlpJogKi9cbiAgICBpZiAoc2ltPy5hbGxvd2FuY2VDaGFuZ2VzPy5sZW5ndGggfHwgc2ltPy5hdXRob3JpdHlDaGFuZ2VzPy5sZW5ndGggfHwgbG9zaW5nLmxlbmd0aCkgcmV0dXJuICfimqDvuI8g6aCQ5ryU6aGv56S65pyJ5o6I5qyK5oiW5pyD5omj5L2g55qE6LOH55Si77yM5a6J5YWo6LW36KaL5rKS5pyJ6ZGEJztcbiAgICBpZiAoIShzaW0/LmJhbGFuY2VDaGFuZ2VzIHx8IFtdKS5zb21lKChiKSA9PiBTdHJpbmcoYi5vd25lcikudG9Mb3dlckNhc2UoKSA9PT0gVy5hZGRyICYmIChOdW1iZXIoYi5jaGFuZ2UpID4gMCB8fCAoL0VyYzcyMXxFcmMxMTU1L2kudGVzdChiLnRva2VuVHlwZSB8fCAnJykgJiYgIShOdW1iZXIoYi5jaGFuZ2UpIDwgMCkpKSkpIHJldHVybiAn4pqqIOmgkOa8lOmhr+ekuuaLv+S4jeWIsOadseilv++8iOWPr+iDvemRhOe1puWIpeS6uuaIlua3qOmhjeeCuiAw77yJ77yM5rKS5pyJ6ZGEJztcbiAgICBsZXQgeDtcbiAgICB0cnkgeyBjb25zdCBjb25maXJtZWQgPSBhd2FpdCBzdWJtaXRDb250cmFjdChXLCBjLCBkLCB2YWwsIHJpZCwgc2ltKTsgeCA9IGNvbmZpcm1lZC5yZXN1bHQ7IH1cbiAgICBjYXRjaCAoZSkgeyByZXR1cm4gYOKaoO+4jyAke2UubWVzc2FnZX1gOyB9XG4gICAgUy5taW50Q291bnQrKzsgUy5taW50Q250W1cubmFtZV0gPSAoUy5taW50Q250W1cubmFtZV0gfHwgMCkgKyAxO1xuICAgIGNvbnN0IGdvdCA9IChzaW0/LmJhbGFuY2VDaGFuZ2VzIHx8IFtdKS5maWx0ZXIoKGIpID0+IFN0cmluZyhiLm93bmVyKS50b0xvd2VyQ2FzZSgpID09PSBXLmFkZHIpLm1hcCgoYikgPT4gKGIudG9rZW5UeXBlID09PSAnRXJjNzIxJyA/ICdORlQgw5cxJyA6IGIudG9rZW5UeXBlICsgJyArJyArIGIuY2hhbmdlKSkuam9pbign44CBJyk7XG4gICAgcmV0dXJuIGDwn6SWIOW3suiHquWLlemRhOmAoCAke2ZuYW1lfSR7Z290ID8gJ++8iCcgKyBnb3QgKyAn77yJJyA6ICcnfSR7Zm5hbWUuc3RhcnRzV2l0aCgnY29tbWl0JykgPyAnXFxu77yI6YCZ56iu5piv5YWp5q2l5byP77yM6YKE6KaBIHJldmVhbCDmiY3mi7/liLDvvIzmiYvli5XomZXnkIbvvIknIDogJyd9XFxu5Lqk5piTICR7eC5qLmRhdGE/LnR4SGFzaCB8fCB4LmouZGF0YT8ub3JkZXJJZCB8fCAnJ31gO1xuICB9XG5cbiAgY29uc3QgZ290VG9rID0gKHNpbSwgVykgPT4gKHNpbT8uYmFsYW5jZUNoYW5nZXMgfHwgW10pLmZpbHRlcigoYikgPT4gU3RyaW5nKGIub3duZXIpLnRvTG93ZXJDYXNlKCkgPT09IFcuYWRkciAmJiBOdW1iZXIoYi5jaGFuZ2UpID4gMCkucmVkdWNlKChhLCBiKSA9PiBhICsgTnVtYmVyKGIuY2hhbmdlKSwgMCk7XG5cbiAgY29uc3QgaGVhdFRpZXIgPSAoUCkgPT4gKChQLmFnZW50cyB8fCAwKSA+PSAyMDAgfHwgKFAuYnVyc3QgfHwgMCkgPj0gMzAgPyAyIDogKFAuYWdlbnRzIHx8IDApID49IDEwMCB8fCAoUC5idXJzdCB8fCAwKSA+PSAxNSA/IDEgOiAwKTtcblxuICBmdW5jdGlvbiBtYXJrVW5taW50YWJsZShjLCBQLCBzeW0sIHByb2dyZXNzLCB3aHkgPSAn6KaB5a6Y57ay57C95ZCN5oiW55m95ZCN5ZauJykgeyBQLmxhc3RSZWFzb24gPSB3aHk7IC8vIOmBlOWIsOmAsuWgtOaineS7tuS9huaIkeWAkeaJk+S4jeS6hu+8muaomeiomOS4jeWGjemHjeippu+8jOmAmuefpeS9v+eUqOiAheS4gOasoVxuICAgIGlmIChQLnVubWludGFibGUpIHJldHVybjsgUC51bm1pbnRhYmxlID0gdHMoKTsgUC51bm1pbnRhYmxlQXQgPSBEYXRlLm5vdygpO1xuICAgIGxvZyhg5omT5LiN5LqGICR7Y33vvIgke3N5bX3vvInvvJoke3doeX1gKTtcbiAgICBpZiAoZmFsc2UgJiYgKGhlYXRUaWVyKFApID49IDEgfHwgKChwcm9ncmVzcyB8fCAwKSA+PSAwLjQgJiYgKHByb2dyZXNzIHx8IDApIDwgMC45NSkpKSB0Zyhg4pqg77iPICR7c3ltIHx8IFAubmFtZSB8fCAn5paw6aCF55uuJ30g6YGU5Yiw6YCy5aC05qKd5Lu277yI57Sv6KiIICR7UC5hZ2VudHMgfHwgMH0g5YCL5Luj55CG5Lq6JHtwcm9ncmVzcyA+IDAgPyAn77yM6YCy5bqm57SEICcgKyBNYXRoLnJvdW5kKHByb2dyZXNzICogMTAwKSArICclJyA6ICcnfe+8ie+8jOS9huW3peWFt+aJk+S4jeS6hu+8miR7d2h5feOAguimgeeahOipseiri+aJi+WLlVxcbiR7Y31gKS5jYXRjaCgoKSA9PiB7fSk7XG4gIH1cblxuICBmdW5jdGlvbiBub3RlRmFpbChjLCBQLCBzeW0sIHByb2dyZXNzKSB7IFAuY2YgPSAoUC5jZiB8fCAwKSArIDE7IGlmIChQLmNmID49IDgpIG1hcmtVbm1pbnRhYmxlKGMsIFAsIHN5bSwgcHJvZ3Jlc3MsICfmqKHmk6zpkYTpgKDkuIDnm7TlpLHmlZfvvIzlj6/og73lt7Los6PlrozjgIHopoHlrpjntrLnsL3lkI3jgIHnmb3lkI3llq7miJblt7Lpl5zploknKTsgfVxuXG4gIGNvbnN0IGJ1c3lQID0gbmV3IFNldCgpO1xuXG4gIGFzeW5jIGZ1bmN0aW9uIHBhaWRMb29wKG1vZGUgPSAnYWxsJywgc2hhcmQgPSBudWxsKSB7XG4gICAgaWYgKFMudW1SZXNldCAhPT0gMykgeyBTLnVtUmVzZXQgPSAzOyBmb3IgKGNvbnN0IFAgb2YgT2JqZWN0LnZhbHVlcyhTLnBhaWQgfHwge30pKSB7IGlmIChQLnVubWludGFibGUpIHsgZGVsZXRlIFAudW5taW50YWJsZTsgUC5mYWlsID0gMDsgUC5jZiA9IDA7IGlmIChQLnJlcGxheT8ubGVhcm5lZCkgZGVsZXRlIFAucmVwbGF5OyB9IH0gfSAvLyDmlrDniYjkuIDmrKHmgKfvvJrkuYvliY3mqJnoqJjmiZPkuI3kuobnmoTph43mlrDoqaZcbiAgICBTLnBhaWQgPSBTLnBhaWQgfHwge307IFMuZHluID0gUy5keW4gfHwgW107IFMucGFpZFNwZW5kID0gUy5wYWlkU3BlbmQgfHwge307XG4gICAgaWYgKFMubWlzc2VkICYmICFTLm1pc3NlZENsZWFuMSkgeyBTLm1pc3NlZENsZWFuMSA9IDE7IGZvciAoY29uc3QgW2ssIG1dIG9mIE9iamVjdC5lbnRyaWVzKFMubWlzc2VkKSkgaWYgKFN0cmluZyhtLndoeSB8fCAnJykuaW5jbHVkZXMoJ+S/neacrCcpKSBkZWxldGUgUy5taXNzZWRba107IH0gLyog54Wn6KaP5YmH5LiN5omT55qE5LiN566X6Yyv6YGOICovXG4gICAgaWYgKFMucmVmdW5kUmVzZXQgIT09IDEpIHsgUy5yZWZ1bmRSZXNldCA9IDE7IGZvciAoY29uc3QgUCBvZiBPYmplY3QudmFsdWVzKFMucGFpZCkpIHsgZGVsZXRlIFAucmVmdW5kT2s7IGRlbGV0ZSBQLm5vUmVmdW5kTG9nOyB9IH0gLyog6Zmk6YyvIDExLzHvvJrku6PnkIblkIjntITop6PmnpDkv67mraPlvozvvIzph43mlrDliKTmlrfkuIDmrKHmnInmspLmnInpgIDmrL7mqZ/liLYgKi9cbiAgICBjb25zdCB0b2RheSA9IGZlZURheShEYXRlLm5vdygpLCBDT05GSUcudGltZVpvbmUgfHwgJ0FzaWEvU2hhbmdoYWknKTsgaWYgKFMucGFpZFNwZW5kLmRheSAhPT0gdG9kYXkpIFMucGFpZFNwZW5kID0geyBkYXk6IHRvZGF5IH07XG4gICAgbGV0IHByaWNlID0gMDtcbiAgICBpZiAoIVMuZm9yY2VEb25lKSBTLmZvcmNlRG9uZSA9IHsgJzB4YzdkNTYzYTdiZDVhZjNkZTgzNTY3YTY3MDU4YjNlYjlmMjg1MTQ5ZSc6IDEgfTsgLy8gVkFSQyDml6nkuIrlt7LntpPmiZPlroxcbiAgICBmb3IgKGNvbnN0IGMgb2YgRk9SQ0UpIGlmIChTLmZvcmNlRG9uZVtjXSAmJiBTLnBhaWRbY10pIGRlbGV0ZSBTLnBhaWRbY107XG4gICAgZm9yIChjb25zdCBjIG9mIEZPUkNFKSBpZiAoIVMucGFpZFtjXSAmJiAhUy5mb3JjZURvbmVbY10pIFMucGFpZFtjXSA9IHsgYXQ6IERhdGUubm93KCksIG5hbWU6ICcnLCBkb25lOiB7fSB9OyAvLyDlr6nmn6Xkv67mraPvvJrmiYvli5XmjIflrprnmoTpoIXnm67miZPlrozlsLHkuI3lho3liqDlm57kvobph43miZNcbiAgICBpZiAoIVMubWlncmF0ZWQyKSB7IFMubWlncmF0ZWQyID0gMTsgZm9yIChjb25zdCBjIG9mIE9iamVjdC5rZXlzKFMuc2Vlbk1pbnRzIHx8IHt9KSkgeyBpZiAoUy5wYWlkW2NdKSBjb250aW51ZTsgY29uc3QgY2QgPSBhd2FpdCBjb2RlT2YoYyk7IGlmICgoY2QuaW5jbHVkZXMoJ2UzOGZkMzQ5JykgJiYgY2QuaW5jbHVkZXMoJzY4YmNlOGNkJykpIHx8IChjZC5pbmNsdWRlcygnNzI1YzQwNTgnKSAmJiBjZC5pbmNsdWRlcygnOTRiZjgwNGQnKSkpIHsgUy5wYWlkW2NdID0geyBhdDogRGF0ZS5ub3coKSwgbmFtZTogJycsIGRvbmU6IHt9IH07IGxvZygn6KOc55m75LuY6LK76L+96LmkICcgKyBjKTsgfSB9IH1cbiAgICAvLyDpgLLluqYg4omlNDAlIOeahO+8iOW/q+a7v+eahO+8ieavj+i8qumDveeci++8jOS4jei3n+WFtuS7luS4gOeZvuWkmuWAi+aOkumaiu+8m+WFtumkmOi8qua1ge+8jOavj+i8quijnOWIsCAxNiDlgItcbiAgICBjb25zdCBhbGwgPSBPYmplY3QuZW50cmllcyhTLnBhaWQpO1xuXG4gICAgY29uc3QgaG90UCA9IGFsbC5maWx0ZXIoKFtjLCBQXSkgPT4gRk9SQ0UuaGFzKGMpIHx8ICgoKFAucHJvZ3Jlc3MgfHwgMCkgPj0gMC40NSB8fCAoZnBDYWNoZS5nZXQoYyk/LnAgfHwgMCkgPj0gMC40NSB8fCAoIShQLnByb2dyZXNzID4gMCkgJiYgTWF0aC5tYXgoUC5hZ2VudHMgfHwgMCwgSE9ULmdldChjKT8uZnJvbS5zaXplIHx8IDApID49IDcwKSkgJiYgKFAucHJvZ3Jlc3MgfHwgMCkgPCAwLjk5OSAmJiAhUC51bm1pbnRhYmxlKSkuZmlsdGVyKChbYywgUF0pID0+ICFXQUxMRVRTLmV2ZXJ5KChXKSA9PiBQLmRvbmVbVy5uYW1lXSkpLnNvcnQoKGEsIGIpID0+IChiWzFdLnByb2dyZXNzIHx8IDApIC0gKGFbMV0ucHJvZ3Jlc3MgfHwgMCkgfHwgKGJbMV0uYWdlbnRzIHx8IDApIC0gKGFbMV0uYWdlbnRzIHx8IDApKS5zbGljZSgwLCAxMik7IC8qIOS9v+eUqOiAhSAxMC8zMSAyMDoyOe+8muW/q+mAn+aqouafpeWPqueci+W/q+WIsOmWgOaqu+eahO+8iOmAsuW6piDiiaU0NSXvvIzmiJboroDkuI3liLDpgLLluqbkvYblt7IgNzAg5YCL5Lul5LiK6Yyi5YyF77yJ77yM5pyA5aSaIDEyIOWAi++8jOmBv+WFjei2iuS+hui2iuaFoiAqL1xuICAgIC8vIOW/q+mAn+aqouafpe+8iG1vZGU9J2hvdCfvvInmr48gMTUg56eS5Y+q55yL5b+r5ru/77yP5b6I54ax55qE77yb5LiA6Iis5qqi5p+l77yIbW9kZT0ncmVzdCfvvInlj6blpJblnKjog4zmma/ntITmr4/liIbpkJjovKrmtYHnnIvlhbbku5bnmoTvvIzkupLkuI3mi5bmhaJcbiAgICBjb25zdCByZXN0ID0gbW9kZSA9PT0gJ2hvdCcgPyBbXSA6IGFsbC5maWx0ZXIoKGUpID0+ICFob3RQLmluY2x1ZGVzKGUpKS5zb3J0KChhLCBiKSA9PiAoYVsxXS5sYXN0VHJ5IHx8IDApIC0gKGJbMV0ubGFzdFRyeSB8fCAwKSkuc2xpY2UoMCwgMTYpO1xuICAgIGNvbnN0IGVudHMgPSBtb2RlID09PSAncmVzdCcgPyByZXN0IDogbW9kZSA9PT0gJ2hvdCcgPyAoc2hhcmQgPT0gbnVsbCA/IGhvdFAgOiBob3RQLmZpbHRlcigoZSwgaSkgPT4gaSAlIDMgPT09IHNoYXJkKSkgOiBob3RQLmNvbmNhdChyZXN0KTsgLyog5b+r6YCf5qqi5p+l5YiGIDMg57WE5ZCM5pmC6LeR77yI5a+p5p+l5L+u5q2j77ya5LiA5YCL5LiA5YCL5p+l6KaBIDEg5YiG5aSa6ZCY77yJICovXG4gICAgZm9yIChjb25zdCBbYywgUF0gb2YgZW50cykge1xuICAgICAgaWYgKElORlJBLmhhcyhjKSkgeyBkZWxldGUgUy5wYWlkW2NdOyBjb250aW51ZTsgfSAvLyBBZ2VudCBJRCDnmbvoqJjlkIjntITmnKzouqvkuI3mmK/poIXnm67vvIjoqLvlhoogLmFpIOi6q+S7ve+8ie+8jOS4jeaJk1xuICAgICAgaWYgKGJ1c3lQLmhhcyhjKSkgY29udGludWU7IGJ1c3lQLmFkZChjKTsgY29uc3QgdEUgPSBEYXRlLm5vdygpO1xuICAgICAgdHJ5IHtcbiAgICAgIFAubGFzdFRyeSA9IERhdGUubm93KCk7IGlmIChXQUxMRVRTLmV2ZXJ5KChXKSA9PiBQLmRvbmVbVy5uYW1lXSkpIHsgaWYgKEZPUkNFLmhhcyhjKSkgeyBTLmZvcmNlRG9uZSA9IFMuZm9yY2VEb25lIHx8IHt9OyBTLmZvcmNlRG9uZVtjXSA9IDE7IH0gZGVsZXRlIFMucGFpZFtjXTsgY29udGludWU7IH1cbiAgICAgIGlmIChEYXRlLm5vdygpIC0gUC5hdCA+IFBBSUQubWF4QWdlSCAqIDM2MDBlMykgeyBkZWxldGUgUy5wYWlkW2NdOyBjb250aW51ZTsgfVxuICAgICAgY29uc3QgY29kZSA9IGF3YWl0IGNvZGVPZihjKTtcbiAgICAgIHRyeSB7IGF3YWl0IGVuZm9yY2VNaW50UmlzayhjLCBhd2FpdCBmdWxsQ29kZShjLCBjb2RlKSk7IH0gY2F0Y2ggKGUpIHsgUC5sYXN0UmVhc29uID0gZS5tZXNzYWdlOyBsb2coYOi3s+mBjiAke2N977yaJHtlLm1lc3NhZ2V9YCk7IGNvbnRpbnVlOyB9XG4gICAgICAvLyDnmbznj77mmYLpgoTmspLplovnmoTjgIzlhY3osrvjgI3pkYTpgKDvvJrkuYvlvozmr4/liIbpkJjph43oqabvvIzkuIDplovlsLHoh6rli5XmiZNcbiAgICAgIGNvbnN0IGZjZCA9IChQLnByb2dyZXNzIHx8IDApID49IEdPX1BDVCAtIDAuMDIgfHwgTWF0aC5tYXgoUC5hZ2VudHMgfHwgMCwgSE9ULmdldChjKT8uZnJvbS5zaXplIHx8IDApID49IDcwID8gMjBlMyA6IDEyMGUzOyAvKiDpmaTpjK8gMTEvMe+8muW/q+WIsCA2MCUg55qE5YWN6LK76aCF55uu5pS55oiQIDIwIOenkumHjeippuS4gOasoe+8iOS5i+WJjeWbuuWumiAyIOWIhumQmO+8jDB4YTY5YWRmIOWcqOmAmSAyIOWIhumQmOWFp+W+niA2MyUg6LOj5a6M77yJICovXG4gICAgICBpZiAoRGF0ZS5ub3coKSAtIChQLmZyZWVUcnlBdCB8fCAwKSA+IGZjZCAmJiAhKChQLnByb2dyZXNzIHx8IDApID4gMCAmJiBQLnByb2dyZXNzIDwgR09fUENUIC0gMC4wMiAmJiBEYXRlLm5vdygpIC0gKFAuZnJlZVRyeUF0IHx8IDApIDwgNjAwZTMpKSB7IC8qIOWEquWMliAxMS8x77ya6YCy5bqm6K6A5b6X5Yiw5LiU6YKE5rKS5YiwIDU4JSDnmoTlhY3osrvpoIXnm67vvIzkuI3nlKjmr48gMiDliIbpkJjmqKHmk6zkuIDmrKHvvIjkuIDmmZogODUwIOasoeeZvei3keOAgemChOWus+evgOm7numZkOa1ge+8ie+8m+aUueaIkCAxMCDliIbpkJjnnIvkuIDmrKHvvIzlv6vliLDploDmqrvmiY3lr4bpm4bph43oqaYgKi8gUC5mcmVlVHJ5QXQgPSBEYXRlLm5vdygpOyBmb3IgKGNvbnN0IFcgb2YgV0FMTEVUUykgeyBpZiAoUC5kb25lW1cubmFtZV0pIGNvbnRpbnVlOyB7IGNvbnN0IGZmID0gYXdhaXQgZmluZEZyZWUoVy5hZGRyLCBjLCBjb2RlKTsgaWYgKCFmZiB8fCBQLnFBdD8uW1cubmFtZV0gPiBEYXRlLm5vdygpIC0gKGZjZCAtIDVlMykpIGNvbnRpbnVlOyBQLnFBdCA9IFAucUF0IHx8IHt9OyBQLnFBdFtXLm5hbWVdID0gRGF0ZS5ub3coKTsgcXVldWVNaW50KGMsIGZmLm4sIFcsIGZmLnYpOyBsb2coYFske1cubmFtZX1dIOS5i+WJjemChOaykumWi+eahCAke1AubmFtZSB8fCBjfSDnj77lnKjplovkuobvvIjlhY3osrvvvInvvIzmjpLlhaXpkYTpgKBgKTsgfSB9IH1cbiAgICAgIGxldCBraW5kID0gY29kZS5pbmNsdWRlcygnZTM4ZmQzNDknKSAmJiBjb2RlLmluY2x1ZGVzKCc2OGJjZThjZCcpID8gJ2JuYicgOiBjb2RlLmluY2x1ZGVzKCc3MjVjNDA1OCcpICYmIGNvZGUuaW5jbHVkZXMoJzk0YmY4MDRkJykgPyAndXNkdCcgOiBudWxsO1xuICAgICAgbGV0IHVuaXQgPSAwbjsgLy8g5LiA6IisIE5GVO+8mm1pbnQo5pW46YePKSDku5jjgIzllq7lg7kgw5cg5pW46YeP44CNQk5C77yI5YOPIFNlbnRpZW50IFN5bmRpY2F0ZSDnmoQgUFJJQ0XvvIlcbiAgICAgIGlmICgha2luZCAmJiBjb2RlLmluY2x1ZGVzKCdhMDcxMmQ2OCcpKSBmb3IgKGNvbnN0IHNlbCBvZiBbJzhkODU5ZjNlJywgJ2EwMzViMWZlJywgJzY4MTdjNzZjJywgJzEzZmFlZGU2JywgJzgxN2IxY2QyJ10pIHsgaWYgKCFjb2RlLmluY2x1ZGVzKHNlbCkpIGNvbnRpbnVlOyBjb25zdCByID0gYXdhaXQgY2MoYywgJzB4JyArIHNlbCk7IGlmIChyICYmIHIubGVuZ3RoID49IDY2ICYmIEJpZ0ludChyLnNsaWNlKDAsIDY2KSkgPiAwbikgeyB1bml0ID0gQmlnSW50KHIuc2xpY2UoMCwgNjYpKTsga2luZCA9ICdnZW4nOyBicmVhazsgfSB9XG4gICAgICBpZiAoIWtpbmQgJiYgUC5yZWN2VmFsdWUpIGtpbmQgPSAncmVjdic7XG4gICAgICBpZiAoUC5yZXBsYXkgJiYgYmFkU2VsKFAucmVwbGF5LmRhdGEpKSBkZWxldGUgUC5yZXBsYXk7XG4gICAgICBpZiAoIWtpbmQgJiYgUC5yZXBsYXk/LmRhdGEpIGtpbmQgPSAncmVwbGF5JzsgLy8g5bCR6KaL55qE6ZGE6YCg5Ye95byP77ya54Wn5Yil5Lq655qE5ZG85Y+r5YWn5a656IiH6YeR6aGN5omTXG5cbiAgICAgIGlmICgha2luZCB8fCBraW5kID09PSAncmVwbGF5JykgUC5uZWVkTGVhcm4gPSAxOyAvLyDnnIvkuI3mh4LnmoTlkIjntITvvJrkuqTntabog4zmma/nmoTnhrHluqbnm6PmuKzljrvlrbjliKXkurrnmoTmiZPms5XvvIzpgJnoo6HkuI3nrYlcbiAgICAgIGlmICgha2luZCkgY29udGludWU7XG4gICAgICBpZiAoUC51bm1pbnRhYmxlICYmIFAudW5taW50YWJsZUF0ICYmIERhdGUubm93KCkgLSBQLnVubWludGFibGVBdCA+IDMwICogNjBlMyAmJiAoUC51bU4gfHwgMCkgPCAyKSB7IFAudW1OID0gKFAudW1OIHx8IDApICsgMTsgZGVsZXRlIFAudW5taW50YWJsZTsgUC5mYWlsID0gMDsgUC5jZiA9IDA7IH0gLy8gMzAg5YiG6ZCY5b6M5YaN6Kmm77yM5pyA5aSa5YaN6KmmIDIg5qyh77yI6YG/5YWN5LuYIFVTRFQg55qE6aCF55uu5q+P5Y2K5bCP5pmC5o+b5LiA5qyhIFVTRFQg5Y+I5aSx5pWX77yJXG4gICAgICBpZiAoUC51bm1pbnRhYmxlICYmICFGT1JDRS5oYXMoYykpIGNvbnRpbnVlO1xuICAgICAgbGV0IHNvbGRSID0gYXdhaXQgY2FsbChjLCBraW5kID09PSAnYm5iJyA/ICcweGEyMzA5ZmY4JyA6IGtpbmQgPT09ICdnZW4nID8gJzB4MTgxNjBkZGQnIDogJzB4MTkyZmM1MTYnKTtcbiAgICAgIGlmICghKHNvbGRSICYmIHNvbGRSLmxlbmd0aCA+PSA2NikgJiYgKGtpbmQgPT09ICdyZXBsYXknIHx8IGtpbmQgPT09ICdyZWN2JykpIHsgaWYgKFAuc29sZFNlbCkgc29sZFIgPSBhd2FpdCBjYWxsKGMsIFAuc29sZFNlbCk7IGVsc2UgZm9yIChjb25zdCBzZWwgb2YgWycweDAyYzdlN2FmJywgJzB4YTIzMDlmZjgnLCAnMHg5MTA2ZDdiYScsICcweGY0NTE0ZDJlJywgJzB4NTA1ZTA1ZmQnLCAnMHgzYTk4ZWYzOSddKSB7IGNvbnN0IHIgPSBhd2FpdCBjYyhjLCBzZWwsIDYwZTMpOyBpZiAociAmJiByLmxlbmd0aCA+PSA2NikgeyBzb2xkUiA9IHI7IFAuc29sZFNlbCA9IHNlbDsgYnJlYWs7IH0gfSB9XG4gICAgICBjb25zdCBzb2xkID0gc29sZFIgJiYgc29sZFIubGVuZ3RoID49IDY2ID8gTnVtYmVyKEJpZ0ludChzb2xkUi5zbGljZSgwLCA2NikpKSA6IG51bGw7XG4gICAgICBsZXQgY2FwID0gbnVsbDsgeyBjb25zdCByID0gYXdhaXQgY2MoYywgJzB4YTBlMjNlYmQnKTsgaWYgKHIgJiYgci5sZW5ndGggPj0gNjYgJiYgc29sZCAhPSBudWxsKSB7IGNvbnN0IHggPSBOdW1iZXIoQmlnSW50KHIuc2xpY2UoMCwgNjYpKSk7IGlmICh4ID49IDEwMDAgJiYgeCA8PSAxZTcgJiYgeCAlIDEwMCA9PT0gMCkgY2FwID0gTWF0aC5tYXgoeCwgc29sZCk7IH0gfSBpZiAoIWNhcCkgZm9yIChjb25zdCBzZWwgb2YgWycweGQ4ZjkzNDk4JywgJzB4Y2VmNmZlZGEnLCAnMHgyOWI4MDUzNicsICcweGQ1YWJlYjAxJywgJzB4MzJjYjZiMGMnLCAnMHgzNTUyNzRlYScsICcweDNhMWQ4ZDNhJywgJzB4ZjFhZWU1YTInLCAnMHg4NWUzZjk5NyddKSB7IGNvbnN0IHIgPSBhd2FpdCBjYyhjLCBzZWwpOyBpZiAociAmJiByLmxlbmd0aCA+PSA2NikgeyBjb25zdCB4ID0gTnVtYmVyKEJpZ0ludChyLnNsaWNlKDAsIDY2KSkpOyBpZiAoeCA+IDAgJiYgc29sZCAhPSBudWxsICYmIHggPj0gc29sZCAmJiB4IDwgMWUxMikgeyBjYXAgPSB4OyBicmVhazsgfSB9IH1cbiAgICAgIGlmICghY2FwICYmIHNvbGQgIT0gbnVsbCAmJiBzb2xkID4gMCkgeyAvKiDlr6nmn6UgMTEvMe+8mmJpYmlhaSDnmbzlsITlj7DnmoTnuL3ph4/lh73lvI/kuI3lnKjluLjopovmuIXllq7vvIhhMGUyM2ViZD0xMDAwMO+8ieKGkiDoroDkuI3liLDpgLLluqYg4oaSIOiiq+eVtuaIkOOAjOiugOS4jeWIsO+8i+W+iOWkmuS6uuaJk+OAjeWcqCA0JSDlsLHlj6/og73osrfvvJvmlLnmiJDoh6rli5Xlvp7lkIjntIToo6Hmib7jgIznuL3ph4/jgI3lh73lvI/kuKboqJjkvY8gKi9cbiAgICAgICAgaWYgKFAuY2FwU2VsID09PSB1bmRlZmluZWQpIFAuY2FwU2VsID0gYXdhaXQgZmluZENhcFNlbChjLCBjb2RlLCBzb2xkKS5jYXRjaCgoKSA9PiAnJykgfHwgJyc7XG4gICAgICAgIGlmIChQLmNhcFNlbCkgeyBjb25zdCByID0gYXdhaXQgY2MoYywgJzB4JyArIFAuY2FwU2VsLCA2MDBlMyk7IGlmIChyICYmIHIubGVuZ3RoID49IDY2KSB7IGNvbnN0IHggPSBOdW1iZXIoQmlnSW50KHIuc2xpY2UoMCwgNjYpKSk7IGlmICh4ID4gMCAmJiB4IDwgMWU5KSBjYXAgPSBNYXRoLm1heCh4LCBzb2xkKTsgfSB9IC8qIOW3suWUrui2hemBjue4vemHj++8neizo+WujO+8iEFJRCDos6PliLAgMTAyNDbvvI8xMDAwMCDmmYLooqvoroDmiJAgMC4yMyXvvIkgKi9cbiAgICAgIH1cbiAgICAgIGxldCB0b2tBZGRyMCA9ICcnOyB7IGNvbnN0IHRyMCA9IGF3YWl0IGNjKGMsICcweGZjMGM1NDZhJywgMzYwMGUzKTsgaWYgKHRyMCAmJiB0cjAubGVuZ3RoID49IDY2ICYmIEJpZ0ludCh0cjAuc2xpY2UoMCwgNjYpKSA+IDBuKSB0b2tBZGRyMCA9ICcweCcgKyB0cjAuc2xpY2UoMjYsIDY2KTsgfVxuICAgICAgbGV0IHByb2dyZXNzID0gY2FwICYmIHNvbGQgIT0gbnVsbCA/IHNvbGQgLyBjYXAgOiAwLCBob3cgPSAn5bey5ZSu77yP5LiK6ZmQJztcbiAgICAgIGlmICghKHByb2dyZXNzID4gMCkpIHsgY29uc3QgcHIgPSBhd2FpdCBwcm9ncmVzc09mKGMsIGNvZGUsIHRva0FkZHIwKTsgcHJvZ3Jlc3MgPSBwci5wcm9ncmVzcyB8fCAwOyBob3cgPSBwci5ob3cgfHwgJyc7IH1cbiAgICAgIC8qIOS9v+eUqOiAhSAxMC8zMSAxOTowMu+8mumAsuW6puWQiOeQhuaAp+aqouafpe+8iOW4geWuieS6uiDmiornuL3ph4/oroDmiJAgMTAwIOWAje+8jOmAsuW6piAzMiUg6KKr6K6A5oiQIDAuMyXvvIzliKXkurrmiZPliLDmiJHlgJHmspLmiZPliLDvvInvvJroroDliLDnmoTpgLLluqblvojkvY7jgIHkvYblt7LntpPlvojlpJrkurrmiZMg4oaSIOWIpOWumuiugOmMr++8jOaUueeUqOW6q+WtmOeul+azle+8m+mChOaYr+S4jeWQiOeQhuWwseeVtuS9nOiugOS4jeWIsO+8jOS6pOe1pueGseW6puimj+WJhyAqL1xuICAgICAgaWYgKHByb2dyZXNzID4gMCAmJiBwcm9ncmVzcyA8IDAuMDMgJiYgIShob3cgPT09ICflt7LllK7vvI/kuIrpmZAnICYmIGNhcCAmJiAoa2luZCA9PT0gJ2JuYicgJiYgY2FwID09PSAxMDAwMCB8fCAoKFAuYWdlbnRzIHx8IDApID49IDIwICYmIGNhcCAvIE1hdGgubWF4KFAuYWdlbnRzIHx8IDEsIDEpIDw9IDEwMDApKSkgLyog5a+p5p+lIDExLzHvvJrnuL3ph4/ot5/lj4PoiIfkurrmlbjnm7jmr5TlkIjnkIbvvIjlubPlnYfmr4/kurog4omkMTAwMCDku73vvInlsLHnm7jkv6HjgIzlt7LllK7vvI/kuIrpmZDjgI3vvIzlj6rmnInnuL3ph4/lpKfliLDkuI3lkIjnkIbvvIjlg4/luaPlronkurroroDlpKcgMTAwIOWAje+8ieaJjeWIpOiugOmMryAqLyAvKiDpmaTpjK8gMTEvMe+8mkJOQiDloLHlg7nlnovlm7rlrpogMSDokKzku73lsLHplovmsaDvvIzjgIzlt7LllK7vvI8xIOiQrOOAjeaYr+a6lueahO+8m0JOTEFJIOW3suWUriAyMDEg5Lu977ydMiUg6KKr6Kqk5Yik5oiQ6K6A6Yyv77yM55W25oiQ6K6A5LiN5Yiw77yL5b6I5aSa5Lq65omT5bCx6Iqx5LqGIDE0VSAqLyAmJiAoKFAuYWdlbnRzIHx8IDApID49IDUwIHx8IChzb2xkIHx8IDApID49IDEwMDAgfHwgKEhPVC5nZXQoYyk/LmZyb20uc2l6ZSB8fCAwKSA+PSAxNSkpIHtcbiAgICAgICAgY29uc3QgcHIgPSBhd2FpdCBwcm9ncmVzc09mKGMsIGNvZGUsIHRva0FkZHIwKS5jYXRjaCgoKSA9PiAoe30pKTtcbiAgICAgICAgaWYgKHByLnByb2dyZXNzID49IDAuMDMpIHsgcHJvZ3Jlc3MgPSBwci5wcm9ncmVzczsgaG93ID0gcHIuaG93IHx8ICfluqvlrZgnOyB9XG4gICAgICAgIGVsc2UgeyBpZiAoIVAucHJvZ0JhZCkgeyBQLnByb2dCYWQgPSAxOyBsb2coYOmAsuW6pueci+i1t+S+huiugOmMr+S6hu+8miR7Y30g6K6A5YiwICR7KHByb2dyZXNzICogMTAwKS50b0ZpeGVkKDIpfSUg5L2G5bey5pyJICR7UC5hZ2VudHMgfHwgMH0g5YCL5Luj55CG5Lq65Zyo5omT77yM5pS555So54ax5bqm6KaP5YmH5Yik5pa3YCk7IH0gcHJvZ3Jlc3MgPSAwOyBob3cgPSAn6K6A5LiN5Yiw77yI5pW45a2X5LiN5ZCI55CG77yJJzsgfVxuICAgICAgfVxuICAgICAgY29uc3QgcHJldlByb2cgPSBQLnByb2dyZXNzOyBQLnByb2dyZXNzID0gcHJvZ3Jlc3M7IFAucHJvZ0F0ID0gRGF0ZS5ub3coKTtcbiAgICAgIGlmIChwcm9ncmVzcyA+PSAwLjk1ICYmICFQLm5vUmVmdW5kTG9nICYmICFQLnNlcmlhbExvZyAmJiAhU3RyaW5nKFAubGFzdFJlYXNvbiB8fCAnJykuaW5jbHVkZXMoJ+S/neacrCcpICYmICFXQUxMRVRTLnNvbWUoKFcpID0+IFAuZG9uZVtXLm5hbWVdICYmICFbJ3Bvb2wtb3BlbicsICdmYWlsJywgJ3Vua25vd24nXS5pbmNsdWRlcyhQLmRvbmVbVy5uYW1lXSkpKSB7IC8qIOeFp+imj+WJh+S4jeaJk++8iOaykuacieS/neacrO+8ieeahOS4jeeul+mMr+mBjiAqLyBTLm1pc3NlZCA9IFMubWlzc2VkIHx8IHt9OyBpZiAoIVMubWlzc2VkW2NdKSB7IFMubWlzc2VkW2NdID0geyBuYW1lOiBQLm5hbWUgfHwgYy5zbGljZSgwLCAxMCksIGF0OiB0cygpLCB3aHk6IFAubGFzdFJlYXNvbiB8fCAoUC51bm1pbnRhYmxlID8gJ+aJk+S4jeS6hicgOiAn6YKE5rKS5om+5Yiw6IO95omT55qE5pa55byPJykgfTsgbG9nKGDpjK/pgY4gJHtjfe+8iCR7Uy5taXNzZWRbY10ubmFtZX3vvInvvJrpgLLluqblt7IgJHtNYXRoLnJvdW5kKHByb2dyZXNzICogMTAwKX0l77yM5oiR5YCR5rKS5omT5Yiw77yM5Y6f5Zug77yaJHtTLm1pc3NlZFtjXS53aHl9YCk7IH0gfSAvKiDorpPoh6rlt7Hmm7TogbDmmI7vvJroqJjkuIvlv6vos6PlrozljbvmspLmiZPliLDnmoTpoIXnm67lkozljp/lm6DvvIzmr4/mmZrnuL3ntZDliJflh7rkvobvvIzmlrnkvr/mib7lh7ropoHoo5znmoTmvI/mtJ4gKi9cbiAgICAgIGlmIChwcm9ncmVzcyA+PSAwLjcgJiYgcHJvZ3Jlc3MgPD0gMSAmJiAocHJldlByb2cgIT0gbnVsbCA/IHByZXZQcm9nIDwgMC43IDogRGF0ZS5ub3coKSAtIFAuYXQgPCA2ICogMzYwMGUzKSkgZ3JvdXBQcm9ncmVzcyhjLCBQLm5hbWUsIHByb2dyZXNzKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICB7IGNvbnN0IG5vdyA9IERhdGUubm93KCk7IFAucGggPSAoUC5waCB8fCBbXSkuZmlsdGVyKCh4KSA9PiBub3cgLSB4LnQgPCAxNSAqIDYwZTMpOyBpZiAoIVAucGgubGVuZ3RoIHx8IG5vdyAtIFAucGhbUC5waC5sZW5ndGggLSAxXS50ID4gMTBlMykgUC5waC5wdXNoKHsgdDogbm93LCBwOiBwcm9ncmVzcyB9KTsgfVxuICAgICAgcHJpY2UgPSBwcmljZSB8fCAoYXdhaXQgYm5iVXNkKCkpO1xuICAgICAgY29uc3QgZm9yY2VkID0gRk9SQ0UuaGFzKGMpO1xuXG4gICAgICBjb25zdCB0aWVyID0gaGVhdFRpZXIoUCksIG5lZWRQY3QgPSBHT19QQ1Q7IC8qIOS9v+eUqOiAhSAxMS8xIDAyOjM377ya5YWo6YOo5pS55Zue6YCy5bqm6LaF6YGOIDYwJSDmiY3miZPvvIjku5josrvpgoTopoHmnInkv53mnKzmqZ/liLbvvIkgKi9cbiAgICAgIGNvbnN0IGNyb3dkR28gPSAhKHByb2dyZXNzID4gMCkgJiYgKFAuYWdlbnRzIHx8IDApID49IEFHX01JTjsgLyog5a+p5p+lIDExLzHvvJrlj6rnrpfmjIHmnIkgQWdlbnQgSUQg55qE6Yyi5YyF77yI54ax5bqm5ZCN5Zau5ZCr5LiA6Iis5Zyw5Z2A77yM5Y+v6IO96KKr5qmf5Zmo5Lq654GM77yJICovIC8qIOS9v+eUqOiAhSAxMC8zMSAxOTo0Ne+8muiugOS4jeWIsOmAsuW6piDihpIgMTAwIOWAi+S7peS4iumMouWMheWcqOaJk+WwseaJkyAqL1xuICAgICAgaWYgKCFmb3JjZWQgJiYgIShwcm9ncmVzcyA+PSBuZWVkUGN0IHx8IGNyb3dkR28pKSBjb250aW51ZTtcbiAgICAgIHsgY29uc3Qgc2QgPSBhd2FpdCBzZXJpYWxEZXYoYyk7IGlmIChzZCkgeyBpZiAoIVAuc2VyaWFsTG9nKSB7IFAuc2VyaWFsTG9nID0gMTsgUC5sYXN0UmVhc29uID0gc2QgKyAn77yM54Wn6KaP5YmH5LiN5omTJzsgaWYgKFMubWlzc2VkPy5bY10pIGRlbGV0ZSBTLm1pc3NlZFtjXTsgbG9nKGDot7PpgY4gJHtQLm5hbWUgfHwgY33vvJoke3Nkfe+8jOeFp+imj+WJh+S4jeaJk2ApOyB9IGNvbnRpbnVlOyB9IH1cbiAgICAgIHsgLyog5L2/55So6ICFIDExLzEgMDE6NTbvvJrpoqjpmqrororlpKfkuobigJTigJTku5josrvpoIXnm67kuIDlrpropoHmnInkv53mnKzmqZ/liLbvvIjmiZPkuI3mu7/lj6/ku6XpgIDmrL7vvInvvIzmspLmnInlsLHkuI3miZPjgILnnIvlkIjntITvvIjlkKvku6PnkIbog4zlvoznmoTlr6bkvZzvvInmnInmspLmnInpgIDmrL7lh73lvI8gKi9cbiAgICAgICAgY29uc3QgcGF5aW5nID0gIShraW5kID09PSAncmVwbGF5JyAmJiAhKEJpZ0ludChQLnJlcGxheT8udmFsdWUgfHwgJzAnKSA+IDBuKSAmJiAhUC5yZXBsYXk/LnBheVRvayk7XG4gICAgICAgIGlmIChwYXlpbmcgJiYgUC5yZWZ1bmRPayA9PSBudWxsKSB7IGNvbnN0IGZjID0gYXdhaXQgZnVsbENvZGUoYywgY29kZSkuY2F0Y2goKCkgPT4gY29kZSk7IFAucmVmdW5kT2sgPSBSRUZVTkRfU0VMUy5zb21lKCh4KSA9PiBmYy5pbmNsdWRlcyh4KSkgPyAxIDogMDsgfSAvKiDku6PnkIblkIjntITopoHnnIvog4zlvoznmoTlr6bkvZwgKi9cbiAgICAgICAgaWYgKHBheWluZyAmJiAhUC5yZWZ1bmRPaykgeyBpZiAoIVAubm9SZWZ1bmRMb2cpIHsgUC5ub1JlZnVuZExvZyA9IDE7IFAubGFzdFJlYXNvbiA9ICfmspLmnInkv53mnKzvvIjpgIDmrL7vvInmqZ/liLbvvIznhafopo/liYfkuI3miZMnOyBpZiAoUy5taXNzZWQ/LltjXSkgZGVsZXRlIFMubWlzc2VkW2NdOyBsb2coYOi3s+mBjiAke1AubmFtZSB8fCBjfe+8muS7mOiyu+mgheebruaykuacieS/neacrO+8iOmAgOasvu+8ieapn+WItu+8jOeFp+imj+WJh+S4jeaJk2ApOyB9IGNvbnRpbnVlOyB9XG4gICAgICAgIGlmIChwYXlpbmcgJiYgYXdhaXQgdXBncmFkZWFibGUoYykuY2F0Y2goKCkgPT4gdHJ1ZSkpIHsgaWYgKCFQLnVwZ0xvZykgeyBQLnVwZ0xvZyA9IDE7IFAubGFzdFJlYXNvbiA9ICflj6/ljYfntJrlkIjntITvvIzkv53mnKzmqZ/liLblj6/og73ooqvmj5vmjonvvIznhafpoqjmjqfkuI3miZMnOyBsb2coYOi3s+mBjiAke1AubmFtZSB8fCBjfe+8muWPr+WNh+e0muS7o+eQhuWQiOe0hO+8iOmgheebruaWueiDveS6i+W+jOaPm+aOieS/neacrOapn+WItu+8ie+8jOeFp+miqOaOp+S4jeaJk2ApOyB9IGNvbnRpbnVlOyB9XG4gICAgICB9XG4gICAgICBjb25zdCBnYXRlID0gZm9yY2VkIHx8IChwcm9ncmVzcyA+PSBHT19QQ1QgJiYgKFAuYWdlbnRzIHx8IDApID49IEFHX01JTikgfHwgY3Jvd2RHbztcbiAgICAgIGlmICghZ2F0ZSkgY29udGludWU7XG4gICAgICBpZiAoIWZvcmNlZCAmJiAhUC5nb0xvZ2dlZCkgeyBQLmdvTG9nZ2VkID0gMTsgbG9nKGDpgLLloLQgJHtjfe+8miR7cHJvZ3Jlc3MgPj0gR09fUENUID8gJ+mAsuW6pumBjiAnICsgTWF0aC5yb3VuZChHT19QQ1QgKiAxMDApICsgJyUnIDogJ+iugOS4jeWIsOmAsuW6puOAgScgKyBBR19NSU4gKyAnIOWAi+S7peS4iumMouWMheWcqOaJkyd977yI57Sv6KiIICR7UC5hZ2VudHMgfHwgMH0g5YCL5Luj55CG5Lq644CBMyDliIbpkJggJHtQLmJ1cnN0IHx8IDB9IOWAi++8ie+8jOmAsuW6piAke3Byb2dyZXNzID4gMCA/IE1hdGgucm91bmQocHJvZ3Jlc3MgKiAxMDApICsgJyUnIDogJ+iugOS4jeWIsCd9YCk7IH1cbiAgICAgIC8vIOmYsumHo+mtmu+8muKRoCDlkIzmrL7lkIjntIQgMjQg5bCP5pmC5YWn6KKr6YOo572yIDMg5qyh5Lul5LiK77yI5om56YeP55m855uk77yJ5LiN5omTIOKRoSDpgLLluqbopoHmmK/lvojlpJrkurrmiZPlh7rkvobnmoTvvIjoh7PlsJEgMjAg5YCL5LiN5ZCM6Yyi5YyF77yJ77yM5LiN5piv6aCF55uu5pa56Ieq5bex5Yi355qEXG4gICAgICB7IGNvbnN0IGRlcCA9IFAuZGVwbG95ZXIgIT09IHVuZGVmaW5lZCA/IFAuZGVwbG95ZXIgOiBhd2FpdCBkZXBsb3llck9mKGMpOyBQLmRlcGxveWVyID0gZGVwO1xuICAgICAgICBpZiAoZGVwICYmICEoUy5kZXZzPy5bZGVwXSB8fCBbXSkuc29tZSgoeCkgPT4geC5jID09PSBjKSkgbm90ZURldihkZXAsIGMpO1xuICAgICAgICBpZiAoZGVwICYmIFMuYmxhY2s/LltkZXBdKSB7IGlmICghUC5ibGFja0xvZ2dlZCkgeyBQLmJsYWNrTG9nZ2VkID0gMTsgbG9nKGDot7PpgY4gJHtjfe+8mumDqOe9suiAhSAke2RlcH0g5Zyo6buR5ZCN5Zau77yIJHtTLmJsYWNrW2RlcF0ud2h5fe+8iWApOyB9IGNvbnRpbnVlOyB9XG4gICAgICAgIGlmIChkZXAgJiYgUC5mcmVzaCA9PSBudWxsKSBQLmZyZXNoID0gYXdhaXQgZnJlc2hXYWxsZXQoZGVwKTtcbiAgICAgICAgaWYgKFAuZnJlc2gpIHsgaWYgKCFQLmZyZXNoTG9nZ2VkKSB7IFAuZnJlc2hMb2dnZWQgPSAxOyBsb2coYOi3s+mBjiAke2N977ya6YOo572y6ICFICR7ZGVwfSDmmK/liZvlu7rnq4vnmoTmlrDpjKLljIVgKTsgfSBjb250aW51ZTsgfVxuICAgICAgICAvLyDpjKLmtYHvvJrlkIjntIToo6Hlub7kuY7mspLnlZkgQk5C44CB5Lmf6YKE5rKS6ZaL5rGgIOKGkiDpjKLlpJrljYrnm7TmjqXmtYHpgLLpoIXnm67mlrnpjKLljIXvvIzopoHmsYLmm7TlpJrkurrmiZPpgY7vvIg0MCDlgIvvvInmiY3nrpflj6/kv6FcbiAgICAgICAgaWYgKFAuZHJhaW4gPT0gbnVsbCkgeyBjb25zdCBjYiA9IE51bWJlcihCaWdJbnQoKGF3YWl0IHJwYygnZXRoX2dldEJhbGFuY2UnLCBbYywgJ2xhdGVzdCddKS5jYXRjaCgoKSA9PiAnMHgwJykpIHx8ICcweDAnKSkgLyAxZTE4OyBjb25zdCBwciA9IHRva0FkZHIwIHx8IGM7IGNvbnN0IHBhaXIgPSBhd2FpdCBjYWxsKEZBQ1RPUlksICcweGU2YTQzOTA1JyArIHdhKHByKSArIHdhKFdCTkIpKTsgUC5kcmFpbiA9IGNiIDwgMC4wMSAmJiAhKHBhaXIgJiYgQmlnSW50KHBhaXIpID4gMG4pOyB9XG5cbiAgICAgICAgUC5uZWVkVyA9IDA7XG4gICAgICAgIGlmIChpc1JlcGVhdERldihkZXApKSB7XG4gICAgICAgICAgaWYgKFAucmVwZWF0T2sgPT0gbnVsbCB8fCBEYXRlLm5vdygpIC0gKFAucmVwZWF0QXQgfHwgMCkgPiA2MDBlMykgeyBQLnJlcGVhdE9rID0gYXdhaXQgcmVwZWF0RGV2T2soZGVwLCBjLCBQKTsgUC5yZXBlYXRBdCA9IERhdGUubm93KCk7IH1cbiAgICAgICAgICBpZiAoIVAucmVwZWF0T2spIHsgaWYgKFAuZHJhaW4pIHsgaWYgKCFQLmRldkxvZ2dlZCkgeyBQLmRldkxvZ2dlZCA9IDE7IGxvZyhg6Lez6YGOICR7Y33vvJrph43opIcgREVWICR7ZGVwfe+8jOaykuaciemWi+ebpOe0gOmMhO+8jOiAjOS4lOmMouebtOaOpea1gei1sGApOyB9IGNvbnRpbnVlOyB9IFAubmVlZFcgPSA0MDsgfVxuICAgICAgICAgIGVsc2UgaWYgKCFQLmRldkxvZ2dlZCkgeyBQLmRldkxvZ2dlZCA9IDE7IGxvZyhg6YeN6KSHIERFViAke2RlcH0g5L2G54Wn5omTICR7Y33vvIgke1AucmVwZWF0T2t977yJYCk7IH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgLy8g5L2/55So6ICF5a6a77ya5Y+q5omT5paw55qEIOKGkiDlhanlpKnliY3lsLHpg6jnvbLnmoTogIHlkIjntITkuI3miZNcbiAgICAgIHsgaWYgKFAub2xkID09IG51bGwpIHsgY29uc3QgaGVhZCA9IHBhcnNlSW50KGF3YWl0IHJwYygnZXRoX2Jsb2NrTnVtYmVyJywgW10pLCAxNik7IGNvbnN0IG8gPSBhd2FpdCBycGMoJ2V0aF9nZXRDb2RlJywgW2MsICcweCcgKyAoaGVhZCAtIDQwMDAwMCkudG9TdHJpbmcoMTYpXSkuY2F0Y2goKCkgPT4gJzB4Jyk7IFAub2xkID0gISFvICYmIG8ubGVuZ3RoID4gMjsgfSBpZiAoUC5vbGQpIHsgZm9yIChjb25zdCBXIG9mIFdBTExFVFMpIFAuZG9uZVtXLm5hbWVdID0gUC5kb25lW1cubmFtZV0gfHwgJ29sZCc7IGNvbnRpbnVlOyB9IH1cbiAgICAgIC8vIOW3sue2k+mWi+axoOS6pOaYk+eahOmgheebruS4jeWGjeiHquWLlemRhOmAoO+8iOmRhOmAoOKJiOeUqOW4guWDueiyt++8jOS4jeWIkueul++8iVxuICAgICAgaWYgKCFmb3JjZWQgJiYgIShwcm9ncmVzcyA+PSBHT19QQ1QpKSB7IGNvbnN0IHRrID0gdG9rQWRkcjAgfHwgYzsgaWYgKGF3YWl0IHBvb2xPcGVuKHRrKSkgeyBpZiAoIVAucG9vbFNraXBMb2cpIHsgUC5wb29sU2tpcExvZyA9IDE7IGxvZyhg6Lez6YGOICR7Y33vvJrlt7LntpPplovmsaDkuqTmmJPvvIzoroDkuI3liLDpgLLluqbmmYLkuI3lnKjplovmsaDlvozpkYTvvIjkuYvlvozoroDliLDpgLLluqYg4omlODAlIOS7jeacg+aJk++8iWApOyB9IGNvbnRpbnVlOyB9IH0gLyog5a+p5p+lIDExLzHvvJrku6XliY3mnIPnm7TmjqXmqJnoqJjlrozmiJDkuKbliKrmjonvvIzoroDpjK/kuIDmrKHlsLHmsLjpgaDkuI3miZMgKi9cbiAgICAgIGlmIChpc1NlcmlhbChjb2RlKSkgeyBpZiAoIVAuc2VyaWFsTG9nZ2VkKSB7IFAuc2VyaWFsTG9nZ2VkID0gMTsgbG9nKGDot7PpgY4gJHtjfe+8muWQjOasvuWQiOe0hCAyNCDlsI/mmYLlhafpg6jnvbIgMyDmrKHku6XkuIrvvIznlpHkvLzmibnph4/nmbznm6RgKTsgfSBjb250aW51ZTsgfVxuICAgICAgeyBjb25zdCBuZWVkID0gTWF0aC5tYXgoUC5kcmFpbiA/IDQwIDogMjAsIFAubmVlZFcgfHwgMCk7IGNvbnN0IHNlZW4gPSBNYXRoLm1heChQLndhbGxldHMgfHwgMCwgSE9ULmdldChjKT8uZnJvbS5zaXplIHx8IDAsIFAuYWdlbnRzIHx8IDApOyAvKiDnhrHluqbnrpfliLDnmoQgQWdlbnQgSUQg6Yyi5YyF5pW45Lmf566X77yIVVNEVCDpkYTpgKDjgIHluaPlhYjpjpbkvY/nmoTpoIXnm67mspLmnInovYnluLPntIDpjITlj6/mlbjvvIkgKi8gaWYgKHNlZW4gPCBuZWVkKSB7IGlmIChEYXRlLm5vdygpIC0gKFAud0F0IHx8IDApIDwgNjBlMykgY29udGludWU7IFAud0F0ID0gRGF0ZS5ub3coKTsgY29uc3QgciA9IGF3YWl0IHJwYygnZXRoX2dldExvZ3MnLCBbeyBhZGRyZXNzOiB0b2tBZGRyMCB8fCBjLCBmcm9tQmxvY2s6ICcweCcgKyAocGFyc2VJbnQoYXdhaXQgcnBjKCdldGhfYmxvY2tOdW1iZXInLCBbXSksIDE2KSAtIDMwMDApLnRvU3RyaW5nKDE2KSwgdG9CbG9jazogJ2xhdGVzdCcsIHRvcGljczogW1RfVFJBTlNGRVJdIH1dKS5jYXRjaCgoKSA9PiBbXSk7IGNvbnN0IHVuaXEgPSBuZXcgU2V0KChyIHx8IFtdKS5tYXAoKGwpID0+IGwudG9waWNzWzJdKSkuc2l6ZTsgUC53YWxsZXRzID0gTWF0aC5tYXgoUC53YWxsZXRzIHx8IDAsIHVuaXEpOyBpZiAodW5pcSA8IG5lZWQpIGNvbnRpbnVlOyB9IH0gLy8g6YKE5rKS5YiwIDgwJe+8iOaIluiugOS4jeWIsOmAsuW6pu+8ieKGkiDlhYjkuI3miZPvvIzkuYvlvozmr4/liIbpkJjlho3nnItcbiAgICAgIGxldCB0b2tBZGRyID0gJyc7IGNvbnN0IHRyID0gYXdhaXQgY2MoYywgJzB4ZmMwYzU0NmEnLCAzNjAwZTMpOyBpZiAodHIgJiYgdHIubGVuZ3RoID49IDY2KSB0b2tBZGRyID0gJzB4JyArIHRyLnNsaWNlKDI2LCA2Nik7XG4gICAgICBjb25zdCBzeW0gPSB0b2tBZGRyID8gdG9rU3RyKGF3YWl0IGNjKHRva0FkZHIsICcweDk1ZDg5YjQxJywgMzYwMGUzKSkgfHwgUC5uYW1lIHx8IGMuc2xpY2UoMCwgOCkgOiBQLm5hbWUgfHwgYy5zbGljZSgwLCA4KTtcbiAgICAgIGF3YWl0IFByb21pc2UuYWxsKFdBTExFVFMubWFwKGFzeW5jIChXKSA9PiB7XG4gICAgICAgIGlmIChQLmRvbmVbVy5uYW1lXSkgcmV0dXJuO1xuICAgICAgICB7IGNvbnN0IHJiID0gYXdhaXQgcmlza0Jsb2NrKFcsIGMsIDBuLCAnMHgnLCBmYWxzZSwgdHJ1ZSkuY2F0Y2goKCkgPT4gJ+miqOaOp+aqouafpeWkseaVlycpOyBpZiAocmIpIHsgaWYgKFAucmlza0xvZyAhPT0gcmIpIHsgUC5yaXNrTG9nID0gcmI7IGxvZyhgWyR7Vy5uYW1lfV0g6aKo5o6n5pqr5YGcICR7UC5uYW1lIHx8IGN977yaJHtyYn1gKTsgfSByZXR1cm47IH0gfVxuICAgICAgICB0cnkge1xuICAgICAgICAgIHByaWNlID0gcHJpY2UgfHwgKGF3YWl0IGJuYlVzZCgpKTtcbiAgICAgICAgICBjb25zdCBzcGVudCA9IFMucGFpZFNwZW5kW1cubmFtZV0gfHwgMDtcbiAgICAgICAgICBjb25zdCBiYWwgPSBOdW1iZXIoQmlnSW50KChhd2FpdCBycGMoJ2V0aF9nZXRCYWxhbmNlJywgW1cuYWRkciwgJ2xhdGVzdCddKSkgfHwgJzB4MCcpKSAvIDFlMTg7XG4gICAgICAgICAgbGV0IG4gPSAxMCwgY29zdFdlaSA9IDBuO1xuICAgICAgICAgIGlmIChraW5kID09PSAncmVwbGF5JyAmJiBQLnJlcGxheS5wYXlUb2spIHsgLy8g5LuYIFVTRFQg55qE6ZGE6YCg77yI5YOPIEJJVE/vvInvvJrmj5sgVVNEVCDihpIg5o6I5qyKIOKGkiDnhafliKXkurrnmoTmlrnlvI/miZPvvIzku73mlbjmlL7lpKfliLDpoJDnrpflhafmnIDlpJogMTAg5Lu9XG4gICAgICAgICAgICBpZiAoUC5yZXBsYXkucGF5VG9rICE9PSBVU0RUKSB7IGlmICghUC5wYXlUb2tMb2dnZWQpIHsgUC5wYXlUb2tMb2dnZWQgPSAxOyBsb2coYOi3s+mBjiAke2N977ya6KaB5LuY55qE5Luj5bmj5LiN5pivIFVTRFTvvIgke1AucmVwbGF5LnBheVRva33vvIlgKTsgfSByZXR1cm47IH1cbiAgICAgICAgICAgIGlmIChEYXRlLm5vdygpIC0gKFAucmVwbGF5LmxlYXJuZWRBdCB8fCAwKSA+IDkwZTMpIHsgY29uc3QgbHIgPSBhd2FpdCBsZWFyblJlcGxheShjKS5jYXRjaCgoKSA9PiBudWxsKTsgaWYgKGxyKSBQLnJlcGxheSA9IHsgLi4uUC5yZXBsYXksIC4uLmxyIH07IH1cbiAgICAgICAgICAgIGxldCBkYXRhID0gZnJlc2hEZWFkbGluZShQLnJlcGxheS5kYXRhKSwgbmVlZCA9IEJpZ0ludChQLnJlcGxheS5wYXlBbXQgfHwgJzAnKTsgY29uc3Qgd3MgPSBkYXRhLnNsaWNlKDEwKS5tYXRjaCgvLns2NH0vZykgfHwgW107XG4gICAgICAgICAgICBpZiAod3MubGVuZ3RoID09PSAzICYmIG5lZWQgPiAwbikgeyBjb25zdCBuMCA9IEJpZ0ludCgnMHgnICsgd3NbMF0pLCBteCA9IEJpZ0ludCgnMHgnICsgd3NbMl0pOyBpZiAobjAgPiAwbiAmJiBuMCA8PSAxMDBuICYmIG14ID49IG5lZWQgJiYgbXggPD0gKG5lZWQgKiAxMm4pIC8gMTBuKSB7IGNvbnN0IHVuaXQgPSBuZWVkIC8gbjA7IGxldCBubiA9IDEwbjsgd2hpbGUgKG5uID4gMW4gJiYgKE51bWJlcih1bml0ICogbm4pIC8gMWUxOCkgKiAxLjA1ID4gUEFJRC5tYXhVc2QpIG5uLS07IGNvbnN0IG1wID0gKHVuaXQgKiBubiAqIDEwNW4pIC8gMTAwbjsgZGF0YSA9IGRhdGEuc2xpY2UoMCwgMTApICsgdyhubikgKyB3c1sxXSArIHcobXApOyBuZWVkID0gbXA7IH0gfVxuICAgICAgICAgICAgaWYgKCEobmVlZCA+IDBuKSB8fCBOdW1iZXIobmVlZCkgLyAxZTE4ID4gUEFJRC5tYXhVc2QpIHJldHVybjtcbiAgICAgICAgICAgIGxldCB1YiA9IGJpZyhhd2FpdCBjYWxsKFVTRFQsICcweDcwYTA4MjMxJyArIHdhKFcuYWRkcikpKTtcbiAgICAgICAgICAgIGlmICh1YiA8IG5lZWQpIHsgY29uc3QgbmIgPSAoKE51bWJlcihuZWVkIC0gdWIpIC8gMWUxOCkgKiAxLjA0KSAvIHByaWNlOyBpZiAobmIgPiBiYWwgLSBQQUlELmtlZXBCbmIpIHJldHVybjsgY29uc3Qgc3cgPSBhd2FpdCBzd2FwQ29uZmlybWVkKFcsIFsnbWFya2V0LW9yZGVyJywgJ3N3YXAnLCAnLS1iaW5hbmNlQ2hhaW5JZCcsICc1NicsICctLWZyb21Ub2tlblF0eScsIG5iLnRvRml4ZWQoNiksICctLWZyb21Ub2tlbicsIE5BVElWRV9CTkIsICctLXRvVG9rZW4nLCBVU0RUXSk7IGlmICghc3cuaj8uc3VjY2VzcykgdGhyb3cgbmV3IEVycm9yKCdCTkIg5o+bIFVTRFQg5aSx5pWXICcgKyAoc3cuaj8uZXJyb3I/Lm1lc3NhZ2UgfHwgc3cudCkuc2xpY2UoMCwgMTAwKSk7IGZvciAobGV0IGkgPSAwOyBpIDwgMzAgJiYgdWIgPCBuZWVkOyBpKyspIHsgYXdhaXQgc2xlZXAoMzAwMCk7IHViID0gYmlnKGF3YWl0IGNhbGwoVVNEVCwgJzB4NzBhMDgyMzEnICsgd2EoVy5hZGRyKSkpOyB9IGlmICh1YiA8IG5lZWQpIHRocm93IG5ldyBFcnJvcignVVNEVCDmspLliLDluLMnKTsgfVxuICAgICAgICAgICAgY29uc3QgdiA9IEJpZ0ludChQLnJlcGxheS52YWx1ZSB8fCAnMCcpOyBpZiAodiA+IDBuICYmICgoTnVtYmVyKHYpIC8gMWUxOCkgKiAxLjAwNSA+IGJhbCAtIFBBSUQua2VlcEJuYiB8fCBOdW1iZXIobmVlZCkgLyAxZTE4ICsgKE51bWJlcih2KSAvIDFlMTgpICogcHJpY2UgPiBQQUlELm1heFVzZCkpIHJldHVybjsgLyog5a+p5p+l5L+u5q2j77ya5LuYIFVTRFQg55qE5ZCM5pmC6Iul6YKE6KaB6ZmEIEJOQu+8jOS5n+imgeeul+mAsumgkOeulyAqL1xuICAgICAgICAgICAgY29uc3QgciA9IGF3YWl0IGFwcHJvdmVkTWludChXLCBVU0RULCBjLCBuZWVkLCBhc3luYyAoKSA9PiB7IHRyeSB7IGRhdGEgPSBhd2FpdCBzYWZlQWRkcnMoVywgYywgZGF0YSwgdik7IGRhdGEgPSBhd2FpdCBmaXRTaGFyZXMoVywgYywgZGF0YSwgdik7IH0gY2F0Y2ggKGUpIHsgaWYgKC/poY3luqZ8cXVvdGF85bey5omT5ru/Ly50ZXN0KGUubWVzc2FnZSkpIFAuZG9uZVtXLm5hbWVdID0gJ2Z1bGwnOyBlbHNlIG5vdGVGYWlsKGMsIFAsIHN5bSwgcHJvZ3Jlc3MpOyB0aHJvdyBlOyB9IHJldHVybiBwcmV2aWV3RXhlYyhXLCBjLCBkYXRhLCB2LCAoc2ltKSA9PiB7XG4gICAgICAgICAgICAgIGNvbnN0IG1pbmUgPSAoc2ltPy5iYWxhbmNlQ2hhbmdlcyB8fCBbXSkuZmlsdGVyKChiKSA9PiBTdHJpbmcoYi5vd25lcikudG9Mb3dlckNhc2UoKSA9PT0gVy5hZGRyKTtcbiAgICAgICAgICAgICAgaWYgKHNpbT8uYXV0aG9yaXR5Q2hhbmdlcz8ubGVuZ3RoKSByZXR1cm4gJ+acieasiumZkOiuiuWMlic7XG4gICAgICAgICAgICAgIGNvbnN0IG91dCA9IG1pbmUuZmlsdGVyKChiKSA9PiBOdW1iZXIoYi5jaGFuZ2UpIDwgMCk7IGlmIChvdXQuc29tZSgoYikgPT4geyBjb25zdCBhID0gU3RyaW5nKGIuY29udHJhY3RBZGRyZXNzKS50b0xvd2VyQ2FzZSgpOyByZXR1cm4gYSAhPT0gVVNEVCAmJiAhYS5zdGFydHNXaXRoKCcweGVlZWUnKTsgfSkpIHJldHVybiAn5pyD5omj5YiwIFVTRFQvQk5CIOS7peWklueahOizh+eUoic7XG4gICAgICAgICAgICAgIGlmIChvdXQuZmlsdGVyKChiKSA9PiBTdHJpbmcoYi5jb250cmFjdEFkZHJlc3MpLnRvTG93ZXJDYXNlKCkgPT09IFVTRFQpLnJlZHVjZSgoYSwgYikgPT4gYSAtIE51bWJlcihiLmNoYW5nZSksIDApID4gTnVtYmVyKG5lZWQpICogMS4wMSkgcmV0dXJuICfmiaPnmoQgVVNEVCDotoXpgY7poJDnrpcnOyByZXR1cm4gJyc7XG4gICAgICAgICAgICB9KTsgfSk7XG4gICAgICAgICAgICBjb25zdCBwYWlkVSA9IChyLnNpbT8uYmFsYW5jZUNoYW5nZXMgfHwgW10pLmZpbHRlcigoYikgPT4gU3RyaW5nKGIub3duZXIpLnRvTG93ZXJDYXNlKCkgPT09IFcuYWRkciAmJiBTdHJpbmcoYi5jb250cmFjdEFkZHJlc3MpLnRvTG93ZXJDYXNlKCkgPT09IFVTRFQgJiYgTnVtYmVyKGIuY2hhbmdlKSA8IDApLnJlZHVjZSgoYSwgYikgPT4gYSAtIE51bWJlcihiLmNoYW5nZSksIDApIC8gMWUxODsgY29uc3QgdXNkID0gcGFpZFUgPiAwID8gcGFpZFUgOiBOdW1iZXIobmVlZCkgLyAxZTE4OyBTLnBhaWRTcGVuZFtXLm5hbWVdID0gc3BlbnQgKyB1c2QgLyBwcmljZTsgUC5kb25lW1cubmFtZV0gPSAnbWludGVkJzsgLyog6KiY5a+m6Zqb5omj5o6J55qEIFVTRFQgKi9cbiAgICAgICAgICAgIGF3YWl0IHRnKGDwn5uSIFske1cubmFtZX1dIOiHquWLleaJk+S6huS7mOiyuyBBZ2VudCBJRCDpoIXnm67vvJoke3N5bX3vvIjnhafliKXkurrnmoTmlrnlvI/vvIzku5ggVVNEVO+8iVxcbuiKsee0hCAke3VzZC50b0ZpeGVkKDIpfSBVU0RUIMK3ICR7cHJvZ3Jlc3MgPiAwID8gJ+mAsuW6pue0hCAnICsgTWF0aC5yb3VuZChwcm9ncmVzcyAqIDEwMCkgKyAnJScgOiAn5pyA6L+RICcgKyAoUC5yZXBsYXkuaG90IHx8IDApICsgJyDlgIvpjKLljIXlnKjmiZMnfVxcbiR7Y31cXG7kuqTmmJMgJHtyLnR4fWApO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoa2luZCA9PT0gJ3JlcGxheScpIHtcbiAgICAgICAgICAgIGlmIChEYXRlLm5vdygpIC0gKFAucmVwbGF5LmxlYXJuZWRBdCB8fCAwKSA+IDkwZTMpIHsgY29uc3QgbHIgPSBhd2FpdCBsZWFyblJlcGxheShjKS5jYXRjaCgoKSA9PiBudWxsKTsgaWYgKGxyKSBQLnJlcGxheSA9IHsgLi4uUC5yZXBsYXksIC4uLmxyIH07IH0gLyog55So5pyA5paw55qE5Yil5Lq65Lqk5piT77yI5YO55qC85Y+D5pW46KaB5paw77yJICovXG4gICAgICAgICAgICBsZXQgdiA9IEJpZ0ludChQLnJlcGxheS52YWx1ZSB8fCAnMCcpOyBsZXQgdmIgPSBOdW1iZXIodikgLyAxZTE4O1xuICAgICAgICAgICAgaWYgKHByaWNlICYmIHZiICogcHJpY2UgPiBQQUlELm1heFVzZCAmJiBQLnJlcGxheS5kYXRhKSB7IC8qIOWvqeafpSAxMS8x77ya5a245Yiw55qE6YeR6aGN6LaF6YGOIDIwVSDmmYLvvIznrKzkuIDlgIvlj4PmlbjmmK/ku73mlbjlsLHmjInmr5TkvovpmY3ku73mlbjvvIvph5HpoY3vvIzkuI3lho3nm7TmjqXmlL7mo4QgKi9cbiAgICAgICAgICAgICAgY29uc3QgdzAgPSBQLnJlcGxheS5kYXRhLnNsaWNlKDEwLCA3NCk7IGNvbnN0IG4wID0gdzAubGVuZ3RoID09PSA2NCA/IE51bWJlcihCaWdJbnQoJzB4JyArIHcwKSkgOiAwO1xuICAgICAgICAgICAgICBpZiAobjAgPj0gMiAmJiBuMCA8PSAxMDApIHsgY29uc3QgbjEgPSBNYXRoLmZsb29yKChQQUlELm1heFVzZCAvICh2YiAqIHByaWNlKSkgKiBuMCk7IGlmIChuMSA+PSAxKSB7IHYgPSAodiAqIEJpZ0ludChuMSkpIC8gQmlnSW50KG4wKTsgdmIgPSBOdW1iZXIodikgLyAxZTE4OyBQLnJlcGxheSA9IHsgLi4uUC5yZXBsYXksIGRhdGE6IFAucmVwbGF5LmRhdGEuc2xpY2UoMCwgMTApICsgbjEudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDY0LCAnMCcpICsgUC5yZXBsYXkuZGF0YS5zbGljZSg3NCksIHZhbHVlOiB2LnRvU3RyaW5nKCkgfTsgbG9nKGDnhafmioTph5HpoY3otoXpgY7poJDnrpfvvIzku73mlbggJHtuMH3ihpIke24xfe+8miR7Y31gKTsgfSB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIXByaWNlIHx8IHZiICogcHJpY2UgPiBQQUlELm1heFVzZCB8fCB2YiAqIDEuMDA1ID4gYmFsIC0gUEFJRC5rZWVwQm5iKSByZXR1cm47XG4gICAgICAgICAgICBsZXQgcmRhdGEgPSBmcmVzaERlYWRsaW5lKFAucmVwbGF5LmRhdGEpOyB0cnkgeyByZGF0YSA9IGF3YWl0IHNhZmVBZGRycyhXLCBjLCByZGF0YSwgdik7IGNvbnN0IHJkMCA9IHJkYXRhOyByZGF0YSA9IGF3YWl0IGZpdFNoYXJlcyhXLCBjLCByZGF0YSwgdik7IHYgPSBzY2FsZVYocmQwLCByZGF0YSwgdik7IHZiID0gTnVtYmVyKHYpIC8gMWUxODsgfSBjYXRjaCAoZSkgeyBpZiAoL+mhjeW6pnxxdW90YXzlt7LmiZPmu78vLnRlc3QoZT8ubWVzc2FnZSB8fCAnJykpIFAuZG9uZVtXLm5hbWVdID0gJ2Z1bGwnOyBlbHNlIG5vdGVGYWlsKGMsIFAsIHN5bSwgcHJvZ3Jlc3MpOyByZXR1cm47IH0gLyog5a+p5p+l5L+u5q2j77ya5LuYIEJOQiDnmoTnhafmioTkuZ/opoHmj5vmjonliKXkurrnmoTlnLDlnYDjgIHoh6rli5Xoqr/ku73mlbggKi9cbiAgICAgICAgICAgIHsgLyog5L2/55So6ICFIDEwLzMxIDE5OjE244CM55So6YCZ56iu6YKP6Lyv5Y675YSq5YyW44CN77ya54Wn5oqE5aSx5pWX5pmC5LiN6aas5LiK5pS+5qOE4oCU4oCU5YWI5o+b5pyA5paw5qij5pys5YaN6Kmm77yM5YaN6Kmm44CM5YO55qC85LiK6ZmQICsyJeOAje+8iOWPquWcqOS6pOaYk+WFp+Wuueijoeaciei3n+S7mOasvumHkemhjeS4gOaoo+eahOS4iumZkOaVuOWtl+aZgu+8iSAqL1xuICAgICAgICAgICAgICBjb25zdCBvayA9IGFzeW5jIChkLCB2YWwpID0+IHsgdHJ5IHsgYXdhaXQgcnBjKCdldGhfY2FsbCcsIFt7IGZyb206IFcuYWRkciwgdG86IGMsIGRhdGE6IGQsIHZhbHVlOiAnMHgnICsgdmFsLnRvU3RyaW5nKDE2KSB9LCAnbGF0ZXN0J10pOyByZXR1cm4gdHJ1ZTsgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfSB9O1xuICAgICAgICAgICAgICBsZXQgZ29vZCA9IGF3YWl0IG9rKHJkYXRhLCB2KTtcbiAgICAgICAgICAgICAgaWYgKCFnb29kKSB7IGNvbnN0IGxyID0gYXdhaXQgbGVhcm5SZXBsYXkoYykuY2F0Y2goKCkgPT4gbnVsbCk7IGlmIChscj8uZGF0YSkgeyBQLnJlcGxheSA9IHsgLi4uUC5yZXBsYXksIC4uLmxyIH07IGNvbnN0IHYyID0gQmlnSW50KGxyLnZhbHVlIHx8ICcwJyk7IGxldCBkMiA9IGZyZXNoRGVhZGxpbmUobHIuZGF0YSk7IGxldCB2MnMgPSB2MjsgdHJ5IHsgZDIgPSBhd2FpdCBzYWZlQWRkcnMoVywgYywgZDIsIHYyKTsgY29uc3QgZGQgPSBkMjsgZDIgPSBhd2FpdCBmaXRTaGFyZXMoVywgYywgZDIsIHYyKTsgdjJzID0gc2NhbGVWKGRkLCBkMiwgdjIpOyB9IGNhdGNoIHt9IGlmICgoTnVtYmVyKHYycykgLyAxZTE4KSAqIHByaWNlIDw9IFBBSUQubWF4VXNkICYmIChOdW1iZXIodjJzKSAvIDFlMTgpICogMS4wMDUgPD0gYmFsIC0gUEFJRC5rZWVwQm5iICYmIGF3YWl0IG9rKGQyLCB2MnMpKSAvKiDlr6nmn6UgMTEvMe+8mumHjeaWsOWtuOWIsOeahOmHkemhjeS5n+imgeWcqCAyMFUg6aCQ566X5ZKM6aSY6aGN5YWnICovIHsgcmRhdGEgPSBkMjsgdiA9IHYyczsgdmIgPSBOdW1iZXIodikgLyAxZTE4OyBnb29kID0gdHJ1ZTsgfSB9IH1cbiAgICAgICAgICAgICAgaWYgKCFnb29kICYmIHYgPiAwbikgZm9yIChjb25zdCBwY3Qgb2YgWzEwMm4sIDEwNW4sIDExMG4sIDEyMG4sIDEzNW5dKSB7IC8qIOmZpOmMryAxMS8x77yaQUlEIOWDueagvOW+niAwLjAyMDQg5ryy5YiwIDAuMDIy77yIKzgl77yJ77yM6IiK55qE5Y+q6KmmICsyJSDihpIg5ZCI57SE5ZueIE1BWF9DT1NUIOaJk+S4jeS6hu+8m+aUueaIkCArMiXvvZ4rMzUlIOS4gOi3r+ippu+8jOmHkemhjeWcqCAyMFUg6aCQ566X6IiH6aSY6aGN5YWnICovXG4gICAgICAgICAgICAgICAgY29uc3QgdlUgPSAodiAqIHBjdCkgLyAxMDBuOyBpZiAoKE51bWJlcih2VSkgLyAxZTE4KSAqIHByaWNlID4gUEFJRC5tYXhVc2QgfHwgKE51bWJlcih2VSkgLyAxZTE4KSAqIDEuMDA1ID4gYmFsIC0gUEFJRC5rZWVwQm5iKSBicmVhaztcbiAgICAgICAgICAgICAgICBjb25zdCB3cyA9IHJkYXRhLnNsaWNlKDEwKS5tYXRjaCgvLns2NH0vZykgfHwgW107IGxldCBoaXQgPSAwOyBjb25zdCBkMyA9IHJkYXRhLnNsaWNlKDAsIDEwKSArIHdzLm1hcCgoeCkgPT4geyBjb25zdCB5ID0gQmlnSW50KCcweCcgKyB4KTsgaWYgKHkgPiAwbiAmJiB5ICogMTAwMG4gPj0gdiAqIDk5NW4gJiYgeSAqIDEwMDBuIDw9IHYgKiAxMDA1bikgeyBoaXQgPSAxOyByZXR1cm4gdlUudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDY0LCAnMCcpOyB9IHJldHVybiB4OyB9KS5qb2luKCcnKTtcbiAgICAgICAgICAgICAgICBpZiAoYXdhaXQgb2soaGl0ID8gZDMgOiByZGF0YSwgdlUpKSB7IHJkYXRhID0gaGl0ID8gZDMgOiByZGF0YTsgdiA9IHZVOyB2YiA9IE51bWJlcih2KSAvIDFlMTg7IGdvb2QgPSB0cnVlOyBsb2coYOeFp+aKhOaZgumHkemhjSArJHtwY3QgLSAxMDBufSUg5omN6YGO77yaJHtjfWApOyBQLnJlcGxheSA9IHsgLi4uUC5yZXBsYXksIGRhdGE6IHJkYXRhLCB2YWx1ZTogdi50b1N0cmluZygpIH07IGJyZWFrOyB9XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgaWYgKCFnb29kKSB7IG5vdGVGYWlsKGMsIFAsIHN5bSwgcHJvZ3Jlc3MpOyByZXR1cm47IH0gLyog5a+p5p+lIDExLzHvvJrkuIDmrKHlpLHmlZflsLHmqJnmiZPkuI3kuoYg4oaSIOaUueaIkOe0r+ioiCA4IOasoSAqL1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgciA9IGF3YWl0IHByZXZpZXdFeGVjKFcsIGMsIHJkYXRhLCB2LCAoc2ltKSA9PiB7XG4gICAgICAgICAgICAgIGNvbnN0IG1pbmUgPSAoc2ltPy5iYWxhbmNlQ2hhbmdlcyB8fCBbXSkuZmlsdGVyKChiKSA9PiBTdHJpbmcoYi5vd25lcikudG9Mb3dlckNhc2UoKSA9PT0gVy5hZGRyKTtcbiAgICAgICAgICAgICAgaWYgKHNpbT8uYWxsb3dhbmNlQ2hhbmdlcz8ubGVuZ3RoIHx8IHNpbT8uYXV0aG9yaXR5Q2hhbmdlcz8ubGVuZ3RoKSByZXR1cm4gJ+acieaOiOasiuiuiuWMlic7XG4gICAgICAgICAgICAgIGNvbnN0IG91dCA9IG1pbmUuZmlsdGVyKChiKSA9PiBOdW1iZXIoYi5jaGFuZ2UpIDwgMCk7IGlmIChvdXQuc29tZSgoYikgPT4gIVN0cmluZyhiLmNvbnRyYWN0QWRkcmVzcykudG9Mb3dlckNhc2UoKS5zdGFydHNXaXRoKCcweGVlZWUnKSkgfHwgb3V0LnJlZHVjZSgoYSwgYikgPT4gYSAtIE51bWJlcihiLmNoYW5nZSksIDApID4gTnVtYmVyKHYpICogMS4wMSkgcmV0dXJuICfmnIPmiaPliLAgQk5CIOS7peWkluaIlui2hemBjumHkemhjSc7XG4gICAgICAgICAgICAgIGlmICghbWluZS5zb21lKChiKSA9PiBOdW1iZXIoYi5jaGFuZ2UpID4gMCkpIHJldHVybiAn5qih5pOs5rKS5ou/5Yiw5p2x6KW/JzsgcmV0dXJuICcnO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBTLnBhaWRTcGVuZFtXLm5hbWVdID0gc3BlbnQgKyB2YjsgUC5kb25lW1cubmFtZV0gPSAnbWludGVkJztcbiAgICAgICAgICAgIGlmICghKHYgPiAwbikpIHsgbm90ZUZyZWUoYywgVywgc3ltKTsgcmV0dXJuOyB9XG4gICAgICAgICAgICBhd2FpdCB0Zyhg8J+bkiBbJHtXLm5hbWV9XSDoh6rli5XmiZPkuobku5josrsgQWdlbnQgSUQg6aCF55uu77yaJHtzeW1977yI54Wn5Yil5Lq655qE6ZGE6YCg5pa55byP77yJXFxu6IqxICR7dmIudG9GaXhlZCg0KX0gQk5C77yI57SEICR7KHZiICogcHJpY2UpLnRvRml4ZWQoMSl9Ve+8icK3IOmAsuW6pue0hCAke01hdGgucm91bmQocHJvZ3Jlc3MgKiAxMDApfSVcXG4ke2N9XFxu5Lqk5piTICR7ci50eH1gKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGtpbmQgPT09ICdyZWN2Jykge1xuICAgICAgICAgICAgbGV0IHYgPSBCaWdJbnQoUC5yZWN2VmFsdWUpO1xuICAgICAgICAgICAgaWYgKHByaWNlICYmIChOdW1iZXIodikgLyAxZTE4KSAqIHByaWNlID4gUEFJRC5tYXhVc2QpIHsgLyog6Zmk6YyvIDExLzHvvJrlpKflrrbmnIDluLjovYnnmoTph5HpoY3otoXpgY4gMjBVIOmgkOeul++8iEJOQkNBVCAxMCDku73vvJ0wLjAzIEJOQuKJiDIxVe+8ieaZgu+8jOaUueeUqOWIpeS6uui9iemBjuOAgeWcqOmgkOeul+WFp+acgOWkp+eahOmHkemhje+8jOS4jeWGjeebtOaOpeaUvuajhCAqL1xuICAgICAgICAgICAgICBjb25zdCBvayA9IChQLnJlY3ZWYWxzIHx8IFtdKS5tYXAoKHgpID0+IEJpZ0ludCh4KSkuZmlsdGVyKCh4KSA9PiAoTnVtYmVyKHgpIC8gMWUxOCkgKiBwcmljZSA8PSBQQUlELm1heFVzZCkuc29ydCgoeCwgeSkgPT4gKHggPiB5ID8gLTEgOiAxKSk7IGlmIChvay5sZW5ndGgpIHYgPSBva1swXTsgfVxuICAgICAgICAgICAgY29uc3QgdmIgPSBOdW1iZXIodikgLyAxZTE4O1xuICAgICAgICAgICAgaWYgKCFwcmljZSB8fCB2YiAqIHByaWNlID4gUEFJRC5tYXhVc2QgfHwgdmIgKiAxLjAwNSA+IGJhbCAtIFBBSUQua2VlcEJuYikgcmV0dXJuO1xuICAgICAgICAgICAgdHJ5IHsgYXdhaXQgcnBjKCdldGhfY2FsbCcsIFt7IGZyb206IFcuYWRkciwgdG86IGMsIHZhbHVlOiAnMHgnICsgdi50b1N0cmluZygxNikgfSwgJ2xhdGVzdCddKTsgfSBjYXRjaCB7IG5vdGVGYWlsKGMsIFAsIHN5bSwgcHJvZ3Jlc3MpOyBpZiAoKFAuY2YgfHwgMCkgPj0gMykgeyBkZWxldGUgUC5yZWN2VmFsdWU7IGRlbGV0ZSBQLnJlcGxheTsgUC5uZWVkTGVhcm4gPSAxOyB9IHJldHVybjsgfSAvKiDlr6nmn6UgMTEvMe+8mui9iSBCTkIg6YeR6aGN5Y+v6IO95a246Yyv77yM5aSx5pWX5bm+5qyh5bCx6YeN5a24ICovIC8vIOS4jeiDvemRhO+8iOaykuizh+agvOOAgeW3suaJk+mBjuOAgemhjeW6pua7v++8iVxuICAgICAgICAgICAgY29uc3QgciA9IGF3YWl0IHByZXZpZXdFeGVjKFcsIGMsICcweCcsIHYsIChzaW0pID0+IHtcbiAgICAgICAgICAgICAgY29uc3QgbWluZSA9IChzaW0/LmJhbGFuY2VDaGFuZ2VzIHx8IFtdKS5maWx0ZXIoKGIpID0+IFN0cmluZyhiLm93bmVyKS50b0xvd2VyQ2FzZSgpID09PSBXLmFkZHIpO1xuICAgICAgICAgICAgICBpZiAoc2ltPy5hbGxvd2FuY2VDaGFuZ2VzPy5sZW5ndGggfHwgc2ltPy5hdXRob3JpdHlDaGFuZ2VzPy5sZW5ndGgpIHJldHVybiAn5pyJ5o6I5qyK6K6K5YyWJztcbiAgICAgICAgICAgICAgY29uc3Qgb3V0ID0gbWluZS5maWx0ZXIoKGIpID0+IE51bWJlcihiLmNoYW5nZSkgPCAwKTsgaWYgKG91dC5zb21lKChiKSA9PiAhU3RyaW5nKGIuY29udHJhY3RBZGRyZXNzKS50b0xvd2VyQ2FzZSgpLnN0YXJ0c1dpdGgoJzB4ZWVlZScpKSB8fCBvdXQucmVkdWNlKChhLCBiKSA9PiBhIC0gTnVtYmVyKGIuY2hhbmdlKSwgMCkgPiBOdW1iZXIodikgKiAxLjAxKSByZXR1cm4gJ+acg+aJo+WIsCBCTkIg5Lul5aSW5oiW6LaF6YGO6YeR6aGNJztcbiAgICAgICAgICAgICAgaWYgKCFtaW5lLnNvbWUoKGIpID0+IE51bWJlcihiLmNoYW5nZSkgPiAwKSkgcmV0dXJuICfmqKHmk6zmspLmi7/liLDku6PluaMnOyByZXR1cm4gJyc7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIFMucGFpZFNwZW5kW1cubmFtZV0gPSBzcGVudCArIHZiOyBQLmRvbmVbVy5uYW1lXSA9ICdtaW50ZWQnO1xuICAgICAgICAgICAgYXdhaXQgdGcoYPCfm5IgWyR7Vy5uYW1lfV0g6Ieq5YuV5omT5LqG44CM6L2JIEJOQiDpkYTpgKDjgI3poIXnm67vvJoke3N5bX1cXG7ovYkgJHt2Yn0gQk5C77yI57SEICR7KHZiICogcHJpY2UpLnRvRml4ZWQoMSl9Ve+8jCR7UC5yZWN2U2Vlbn0g5YCL6Yyi5YyF6YO96L2J6YCZ5YCL6YeR6aGN77yJwrcg6YCy5bqm57SEICR7TWF0aC5yb3VuZChwcm9ncmVzcyAqIDEwMCl9Je+8iCR7aG93fe+8iVxcbiR7Y31cXG7kuqTmmJMgJHtyLnR4fWApO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoa2luZCA9PT0gJ2dlbicpIHtcbiAgICAgICAgICAgIGxldCBkYXRhID0gJyc7XG4gICAgICAgICAgICBmb3IgKDsgbiA+PSAxOyBuLS0pIHsgY29zdFdlaSA9IHVuaXQgKiBCaWdJbnQobik7IGlmICgoTnVtYmVyKGNvc3RXZWkpIC8gMWUxOCkgKiAxLjAwNSA+IGJhbCAtIFBBSUQua2VlcEJuYiB8fCAhcHJpY2UgfHwgKE51bWJlcihjb3N0V2VpKSAvIDFlMTgpICogcHJpY2UgPiBQQUlELm1heFVzZCkgY29udGludWU7IGRhdGEgPSAnMHhhMDcxMmQ2OCcgKyB3KG4pOyB0cnkgeyBhd2FpdCBycGMoJ2V0aF9jYWxsJywgW3sgZnJvbTogVy5hZGRyLCB0bzogYywgZGF0YSwgdmFsdWU6ICcweCcgKyBjb3N0V2VpLnRvU3RyaW5nKDE2KSB9LCAnbGF0ZXN0J10pOyBicmVhazsgfSBjYXRjaCB7fSB9XG4gICAgICAgICAgICBpZiAobiA8IDEpIHsgbm90ZUZhaWwoYywgUCwgc3ltLCBwcm9ncmVzcyk7IHJldHVybjsgfVxuICAgICAgICAgICAgY29uc3QgciA9IGF3YWl0IHByZXZpZXdFeGVjKFcsIGMsIGRhdGEsIGNvc3RXZWksIChzaW0pID0+IHtcbiAgICAgICAgICAgICAgY29uc3QgbWluZSA9IChzaW0/LmJhbGFuY2VDaGFuZ2VzIHx8IFtdKS5maWx0ZXIoKGIpID0+IFN0cmluZyhiLm93bmVyKS50b0xvd2VyQ2FzZSgpID09PSBXLmFkZHIpO1xuICAgICAgICAgICAgICBpZiAoc2ltPy5hbGxvd2FuY2VDaGFuZ2VzPy5sZW5ndGggfHwgc2ltPy5hdXRob3JpdHlDaGFuZ2VzPy5sZW5ndGgpIHJldHVybiAn5pyJ5o6I5qyK6K6K5YyWJztcbiAgICAgICAgICAgICAgY29uc3Qgb3V0ID0gbWluZS5maWx0ZXIoKGIpID0+IE51bWJlcihiLmNoYW5nZSkgPCAwKTsgaWYgKG91dC5zb21lKChiKSA9PiAhU3RyaW5nKGIuY29udHJhY3RBZGRyZXNzKS50b0xvd2VyQ2FzZSgpLnN0YXJ0c1dpdGgoJzB4ZWVlZScpKSB8fCBvdXQucmVkdWNlKChhLCBiKSA9PiBhIC0gTnVtYmVyKGIuY2hhbmdlKSwgMCkgPiBOdW1iZXIoY29zdFdlaSkgKiAxLjAxKSByZXR1cm4gJ+acg+aJo+WIsCBCTkIg5Lul5aSW5oiW6LaF6YGO5YO55qC8JztcbiAgICAgICAgICAgICAgaWYgKCFtaW5lLnNvbWUoKGIpID0+IE51bWJlcihiLmNoYW5nZSkgPiAwKSkgcmV0dXJuICfmqKHmk6zmspLmi7/liLDmnbHopb8nOyByZXR1cm4gJyc7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGNvbnN0IHZiID0gTnVtYmVyKGNvc3RXZWkpIC8gMWUxODsgUy5wYWlkU3BlbmRbVy5uYW1lXSA9IHNwZW50ICsgdmI7IFAuZG9uZVtXLm5hbWVdID0gJ21pbnRlZCc7XG4gICAgICAgICAgICBhd2FpdCB0Zyhg8J+bkiBbJHtXLm5hbWV9XSDoh6rli5XmiZPkuobku5josrsgQWdlbnQgSUQg6aCF55uu77yaJHtzeW19XFxuJHtufSDku73vvIzoirEgJHt2Yi50b0ZpeGVkKDQpfSBCTkLvvIjntIQgJHsodmIgKiBwcmljZSkudG9GaXhlZCgxKX1V77yJwrcg6YCy5bqm57SEICR7TWF0aC5yb3VuZChwcm9ncmVzcyAqIDEwMCl9Je+8iCR7c29sZCA/PyAnPyd977yPJHtjYXAgPz8gJz8nfe+8iVxcbiR7Y31cXG7kuqTmmJMgJHtyLnR4fWApO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoa2luZCA9PT0gJ2JuYicpIHtcbiAgICAgICAgICAgIGZvciAoOyBuID49IDE7IG4tLSkgeyBjb25zdCBxID0gYXdhaXQgY2FsbChjLCAnMHg2OGJjZThjZCcgKyB3KG4pKTsgY29zdFdlaSA9IHEgPyBCaWdJbnQocS5zbGljZSgwLCA2NikpIDogMG47IGlmIChjb3N0V2VpID4gMG4gJiYgKE51bWJlcihjb3N0V2VpKSAvIDFlMTgpICogMS4wMDUgPD0gYmFsIC0gUEFJRC5rZWVwQm5iICYmIHByaWNlICYmIChOdW1iZXIoY29zdFdlaSkgLyAxZTE4KSAqIDEuMDA1ICogcHJpY2UgPD0gUEFJRC5tYXhVc2QpIGJyZWFrOyB9IC8vIOiyt+W+l+i1t+eahOacgOWkmuS7veaVuO+8iOeVmSBnYXPvvIlcbiAgICAgICAgICAgIGlmIChuIDwgMSkgeyBQLmxhc3RSZWFzb24gPSBg5q+P5Lu95aSq6LK077yM6LaF6YGOICR7UEFJRC5tYXhVc2R9VSDpoJDnrpdgOyByZXR1cm47IH0gLy8g5aSq6LK077ya5YWI5LiN5omT77yI6YCy5bqm5YiwIDg1JSDlvozkuIrpmZDmnIPmlL7lr6zliLAgMjVV77yM5pyD5YaN5qqi5p+l77yJXG4gICAgICAgICAgICBjb25zdCB2ID0gKGNvc3RXZWkgKiAxMDA1bikgLyAxMDAwbiwgdmIgPSBOdW1iZXIodikgLyAxZTE4O1xuICAgICAgICAgICAgaWYgKHNwZW50ICsgdmIgPiBQQUlELm1heEJuYlBlckRheSB8fCBiYWwgLSB2YiA8IFBBSUQua2VlcEJuYikgcmV0dXJuO1xuICAgICAgICAgICAgY29uc3QgZGF0YSA9ICcweGUzOGZkMzQ5JyArIHcobikgKyB3YSgnMHgwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwJykgKyB3KHYpO1xuICAgICAgICAgICAgdHJ5IHsgYXdhaXQgcnBjKCdldGhfY2FsbCcsIFt7IGZyb206IFcuYWRkciwgdG86IGMsIGRhdGEsIHZhbHVlOiAnMHgnICsgdi50b1N0cmluZygxNikgfSwgJ2xhdGVzdCddKTsgfSBjYXRjaCB7IG5vdGVGYWlsKGMsIFAsIHN5bSwgcHJvZ3Jlc3MpOyByZXR1cm47IH0gLy8g6YKE5rKS6ZaL5oiW5rKS6LOH5qC8XG4gICAgICAgICAgICBjb25zdCBwb29sID0gdG9rQWRkciA/IE51bWJlcihhd2FpdCBwb29sT3V0KHYsIFdCTkIsIHRva0FkZHIpKSA6IDA7XG4gICAgICAgICAgICBjb25zdCByID0gYXdhaXQgcHJldmlld0V4ZWMoVywgYywgZGF0YSwgdiwgKHNpbSkgPT4ge1xuICAgICAgICAgICAgICBpZiAocG9vbCA+IDAgJiYgZ290VG9rKHNpbSwgVykgPCBwb29sICogMS4xKSBsb2coYOazqOaEj++8miR7Y30g5bey6ZaL5rGg77yM6ZGE6YCg5rKS5pyJ5q+U5rGg5a2Q5L6/5a6c77yI5paw6KaP5YmH77ya6YCy5bqmIOKJpTgwJSDnhafmiZPvvIlgKTtcbiAgICAgICAgICAgICAgY29uc3QgbWluZSA9IChzaW0/LmJhbGFuY2VDaGFuZ2VzIHx8IFtdKS5maWx0ZXIoKGIpID0+IFN0cmluZyhiLm93bmVyKS50b0xvd2VyQ2FzZSgpID09PSBXLmFkZHIpO1xuICAgICAgICAgICAgICBpZiAoc2ltPy5hbGxvd2FuY2VDaGFuZ2VzPy5sZW5ndGggfHwgc2ltPy5hdXRob3JpdHlDaGFuZ2VzPy5sZW5ndGgpIHJldHVybiAn5pyJ5o6I5qyK6K6K5YyWJztcbiAgICAgICAgICAgICAgY29uc3Qgb3V0ID0gbWluZS5maWx0ZXIoKGIpID0+IE51bWJlcihiLmNoYW5nZSkgPCAwKTsgaWYgKG91dC5zb21lKChiKSA9PiAhU3RyaW5nKGIuY29udHJhY3RBZGRyZXNzKS50b0xvd2VyQ2FzZSgpLnN0YXJ0c1dpdGgoJzB4ZWVlZScpKSB8fCBvdXQucmVkdWNlKChhLCBiKSA9PiBhIC0gTnVtYmVyKGIuY2hhbmdlKSwgMCkgPiBOdW1iZXIodikgKiAxLjAxKSByZXR1cm4gJ+acg+aJo+WIsCBCTkIg5Lul5aSW55qE6LOH55Si5oiW6LaF6YGO5aCx5YO5JztcbiAgICAgICAgICAgICAgaWYgKCFtaW5lLnNvbWUoKGIpID0+IE51bWJlcihiLmNoYW5nZSkgPiAwKSkgcmV0dXJuICfmqKHmk6zmspLmi7/liLDku6PluaMnOyByZXR1cm4gJyc7XG4gICAgICAgICAgICB9LCBhc3luYyAoKSA9PiB7IGNvbnN0IHEyID0gYXdhaXQgY2FsbChjLCAnMHg2OGJjZThjZCcgKyB3KG4pKTsgY29uc3QgYzIgPSBxMiA/IEJpZ0ludChxMi5zbGljZSgwLCA2NikpIDogMG47IHJldHVybiBjMiA+IChjb3N0V2VpICogMTA1bikgLyAxMDBuID8gJ+WDueagvOWJm+WJm+a8suS6hui2hemBjiA1JScgOiAnJzsgfSk7IC8qIOaWsOWKn+iDve+8mumAgeWHuuWJjeWGjeafpeS4gOasoeWDueagvCAqL1xuICAgICAgICAgICAgUy5wYWlkU3BlbmRbVy5uYW1lXSA9IHNwZW50ICsgdmI7IFAuZG9uZVtXLm5hbWVdID0gJ21pbnRlZCc7XG4gICAgICAgICAgICBjb25zdCB1c2QgPSB2YiAqIHByaWNlO1xuICAgICAgICAgICAgYXdhaXQgdGcoYPCfm5IgWyR7Vy5uYW1lfV0g6Ieq5YuV5omT5LqG5LuY6LK7IEFnZW50IElEIOmgheebru+8miR7c3ltfVxcbiR7bn0g5Lu977yM6IqxICR7dmIudG9GaXhlZCg0KX0gQk5C77yI57SEICR7dXNkLnRvRml4ZWQoMSl9Ve+8icK3IOW3suWUriAke3NvbGQgPz8gJz8nfSDku70gwrcg6YCy5bqm57SEICR7TWF0aC5yb3VuZChwcm9ncmVzcyAqIDEwMCl9JVxcbiR7Y31cXG7kuqTmmJMgJHtyLnR4fVxcbuW3suWKoOWFpeebo+aOp++8miR7cnVsZVR4dCgpfWApO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBmb3IgKDsgbiA+PSAxOyBuLS0pIHsgY29uc3QgcSA9IGF3YWl0IGNhbGwoYywgJzB4NzI1YzQwNTgnICsgdyhuKSk7IGNvc3RXZWkgPSBxID8gQmlnSW50KHEuc2xpY2UoMCwgNjYpKSA6IDBuOyBpZiAoY29zdFdlaSA+IDBuICYmIHByaWNlICYmICgoTnVtYmVyKGNvc3RXZWkpIC8gMWUxOCkgKiAxLjAzKSAvIHByaWNlIDw9IGJhbCAtIFBBSUQua2VlcEJuYiAmJiBOdW1iZXIoY29zdFdlaSkgLyAxZTE4IDw9IFBBSUQubWF4VXNkKSBicmVhazsgfVxuICAgICAgICAgICAgaWYgKG4gPCAxKSB7IFAubGFzdFJlYXNvbiA9IGDmr4/ku73lpKrosrTvvIzotoXpgY4gJHtQQUlELm1heFVzZH1VIOmgkOeul2A7IHJldHVybjsgfSAvLyDlpKrosrTvvJrlhYjkuI3miZPvvIjpgLLluqbliLAgODUlIOW+jOS4iumZkOacg+aUvuWvrOWIsCAyNVXvvIzmnIPlho3mqqLmn6XvvIlcbiAgICAgICAgICAgIGNvbnN0IGN1ID0gTnVtYmVyKGNvc3RXZWkpIC8gMWUxOCwgbmVlZEJuYiA9IChjdSAqIDEuMDMpIC8gcHJpY2U7XG4gICAgICAgICAgICBpZiAoIXByaWNlIHx8IHNwZW50ICsgbmVlZEJuYiA+IFBBSUQubWF4Qm5iUGVyRGF5IHx8IGJhbCAtIG5lZWRCbmIgPCBQQUlELmtlZXBCbmIpIHJldHVybjtcbiAgICAgICAgICAgIGNvbnN0IGRhdGEgPSAnMHg5NGJmODA0ZCcgKyB3KG4pICsgd2EoJzB4MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCcpO1xuICAgICAgICAgICAgbGV0IHViID0gYmlnKGF3YWl0IGNhbGwoVVNEVCwgJzB4NzBhMDgyMzEnICsgd2EoVy5hZGRyKSkpO1xuICAgICAgICAgICAgaWYgKHViIDwgY29zdFdlaSkge1xuICAgICAgICAgICAgICBjb25zdCBzdyA9IGF3YWl0IHN3YXBDb25maXJtZWQoVywgWydtYXJrZXQtb3JkZXInLCAnc3dhcCcsICctLWJpbmFuY2VDaGFpbklkJywgJzU2JywgJy0tZnJvbVRva2VuUXR5JywgbmVlZEJuYi50b0ZpeGVkKDYpLCAnLS1mcm9tVG9rZW4nLCBOQVRJVkVfQk5CLCAnLS10b1Rva2VuJywgVVNEVF0pO1xuICAgICAgICAgICAgICBpZiAoIXN3Lmo/LnN1Y2Nlc3MpIHRocm93IG5ldyBFcnJvcignQk5CIOaPmyBVU0RUIOWkseaVlyAnICsgKHN3Lmo/LmVycm9yPy5tZXNzYWdlIHx8IHN3LnQpLnNsaWNlKDAsIDEwMCkpO1xuICAgICAgICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDMwICYmIHViIDwgY29zdFdlaTsgaSsrKSB7IGF3YWl0IHNsZWVwKDMwMDApOyB1YiA9IGJpZyhhd2FpdCBjYWxsKFVTRFQsICcweDcwYTA4MjMxJyArIHdhKFcuYWRkcikpKTsgfVxuICAgICAgICAgICAgICBpZiAodWIgPCBjb3N0V2VpKSB0aHJvdyBuZXcgRXJyb3IoJ1VTRFQg5rKS5Yiw5bizJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBwb29sID0gdG9rQWRkciA/IE51bWJlcihhd2FpdCBwb29sT3V0KGNvc3RXZWksIFVTRFQsIHRva0FkZHIpKSA6IDA7XG4gICAgICAgICAgICBjb25zdCByID0gYXdhaXQgYXBwcm92ZWRNaW50KFcsIFVTRFQsIGMsIGNvc3RXZWksICgpID0+IHByZXZpZXdFeGVjKFcsIGMsIGRhdGEsIDBuLCAoc2ltKSA9PiB7XG4gICAgICAgICAgICAgIGlmIChwb29sID4gMCAmJiBnb3RUb2soc2ltLCBXKSA8IHBvb2wgKiAxLjEpIGxvZyhg5rOo5oSP77yaJHtjfSDlt7LplovmsaDvvIzpkYTpgKDmspLmnInmr5TmsaDlrZDkvr/lrpzvvIjmlrDopo/liYfvvJrpgLLluqYg4omlODAlIOeFp+aJk++8iWApO1xuICAgICAgICAgICAgICBjb25zdCBtaW5lID0gKHNpbT8uYmFsYW5jZUNoYW5nZXMgfHwgW10pLmZpbHRlcigoYikgPT4gU3RyaW5nKGIub3duZXIpLnRvTG93ZXJDYXNlKCkgPT09IFcuYWRkcik7XG4gICAgICAgICAgICAgIGNvbnN0IG91dCA9IG1pbmUuZmlsdGVyKChiKSA9PiBOdW1iZXIoYi5jaGFuZ2UpIDwgMCk7IGlmIChvdXQuc29tZSgoYikgPT4gU3RyaW5nKGIuY29udHJhY3RBZGRyZXNzKS50b0xvd2VyQ2FzZSgpICE9PSBVU0RUKSB8fCBvdXQucmVkdWNlKChhLCBiKSA9PiBhIC0gTnVtYmVyKGIuY2hhbmdlKSwgMCkgPiBOdW1iZXIoY29zdFdlaSkgKiAxLjAxKSByZXR1cm4gJ+acg+aJo+WIsCBVU0RUIOS7peWkluaIlui2hemBjuWgseWDuSc7XG4gICAgICAgICAgICAgIGlmICghbWluZS5zb21lKChiKSA9PiBOdW1iZXIoYi5jaGFuZ2UpID4gMCkpIHJldHVybiAn5qih5pOs5rKS5ou/5Yiw5Luj5bmjJzsgcmV0dXJuICcnO1xuICAgICAgICAgICAgfSwgYXN5bmMgKCkgPT4geyBjb25zdCBxMiA9IGF3YWl0IGNhbGwoYywgJzB4NzI1YzQwNTgnICsgdyhuKSk7IGNvbnN0IGMyID0gcTIgPyBCaWdJbnQocTIuc2xpY2UoMCwgNjYpKSA6IDBuOyByZXR1cm4gYzIgPiAoY29zdFdlaSAqIDEwNW4pIC8gMTAwbiA/ICflg7nmoLzliZvliZvmvLLkuobotoXpgY4gNSUnIDogJyc7IH0pKTsgLyog5paw5Yqf6IO977ya6YCB5Ye65YmN5YaN5p+l5LiA5qyh5YO55qC8ICovXG4gICAgICAgICAgICBTLnBhaWRTcGVuZFtXLm5hbWVdID0gc3BlbnQgKyBuZWVkQm5iOyBQLmRvbmVbVy5uYW1lXSA9ICdtaW50ZWQnO1xuICAgICAgICAgICAgYXdhaXQgdGcoYPCfm5IgWyR7Vy5uYW1lfV0g6Ieq5YuV5omT5LqG5LuY6LK7IEFnZW50IElEIOmgheebru+8miR7c3ltfVxcbiR7bn0g5Lu977yM6IqxICR7Y3UudG9GaXhlZCgyKX0gVVNEVO+8iOeUsSBCTkIg5o+b77yJwrcg5bey5ZSuICR7c29sZCA/PyAnPyd9IOS7vSDCtyDpgLLluqbntIQgJHtNYXRoLnJvdW5kKHByb2dyZXNzICogMTAwKX0lXFxuJHtjfVxcbuS6pOaYkyAke3IudHh9XFxu5bey5Yqg5YWl55uj5o6n77yaJHtydWxlVHh0KCl9YCk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIChlKSB7IGlmIChlLm1lc3NhZ2UuaW5jbHVkZXMoJ+e1kOaenOS4jeaYjicpKSB7IFAuZG9uZVtXLm5hbWVdID0gJ3Vua25vd24nOyBsb2coYHBhaWQgJHtjfSAke1cubmFtZX0gJHtlLm1lc3NhZ2V9YCk7IGF3YWl0IHRnKGDimqDvuI8gWyR7Vy5uYW1lfV0gJHtzeW19IOmAgeWHuue1kOaenOS4jeaYju+8iOmAvuaZgu+8ie+8jOeCuumBv+WFjemHjeaJk+W3suWBnOatou+8jOiri+WIsOmMouWMheeiuuiqjeacieaykuacieaJk+WIsFxcbiR7Y31gKTsgcmV0dXJuOyB9IGlmIChlLm1lc3NhZ2UuaW5jbHVkZXMoJ+W3sumWi+axoCcpKSB7IFAuZG9uZVtXLm5hbWVdID0gJ3Bvb2wtY2hlYXBlcic7IGxvZyhgcGFpZCAke2N9ICR7Vy5uYW1lfSAke2UubWVzc2FnZX1gKTsgcmV0dXJuOyB9IGlmICgv5YO55qC85Ymb5Ymb5ryy5LqGLy50ZXN0KGUubWVzc2FnZSkpIHsgbG9nKGBwYWlkICR7Y30gJHtXLm5hbWV9ICR7ZS5tZXNzYWdlfe+8iOS4i+S4gOi8quWGjeaJk++8iWApOyByZXR1cm47IH0gUC5mYWlsVyA9IFAuZmFpbFcgfHwge307IFAuZmFpbFdbVy5uYW1lXSA9IChQLmZhaWxXW1cubmFtZV0gfHwgMCkgKyAxOyBQLmZhaWwgPSAoUC5mYWlsIHx8IDApICsgMTsgbG9nKGBwYWlkICR7Y30gJHtXLm5hbWV9ICR7ZS5tZXNzYWdlfWApOyBpZiAoa2luZCA9PT0gJ3JlcGxheScgJiYgUC5mYWlsID49IDYpIHsgbWFya1VubWludGFibGUoYywgUCwgc3ltLCBwcm9ncmVzcywgJ+eFp+WIpeS6uueahOaWueW8j+mgkOa8lOS4gOebtOWkseaVlycpOyByZXR1cm47IH0gLyog5a+p5p+lIDExLzHvvJrnhafmioTlnosgMiDmrKHlpLHmlZflsLHmlL7mo4TlpKrlv6vjgIHlg7nmoLzororli5XkuI3nrpflpLHmlZfjgIHlpLHmlZfmjInpjKLljIXnrpcgKi8gaWYgKFAuZmFpbFdbVy5uYW1lXSA+PSA2KSB7IFAuZG9uZVtXLm5hbWVdID0gJ2ZhaWwnOyBhd2FpdCB0Zyhg4pqg77iPIFske1cubmFtZX1dIOS7mOiyu+mgheebriAke3N5bX0g6Ieq5YuV5omT5aSx5pWX77yM5bey5pS+5qOE77yaJHtlLm1lc3NhZ2Uuc2xpY2UoMCwgMTUwKX1cXG4ke2N9YCk7IH0gfVxuICAgICAgfSkpO1xuICAgICAgfSBmaW5hbGx5IHsgYnVzeVAuZGVsZXRlKGMpOyBjb25zdCBkdCA9IERhdGUubm93KCkgLSB0RTsgaWYgKGR0ID4gMTBlMykgbG9nKGDmqqLmn6UgJHtjfSDoirHkuoYgJHtNYXRoLnJvdW5kKGR0IC8gMTAwMCl9IOenku+8iCR7bW9kZX3vvIlgKTsgfVxuICAgIH1cbiAgfVxuICByZXR1cm4ge1xuICAgIGdldCBhdXRvTWludCgpIHsgcmV0dXJuIGF1dG9NaW50OyB9LFxuICAgIGdldCBxdWV1ZU1pbnQoKSB7IHJldHVybiBxdWV1ZU1pbnQ7IH0sXG4gICAgZ2V0IHByb2dyZXNzU3dlZXAoKSB7IHJldHVybiBwcm9ncmVzc1N3ZWVwOyB9LFxuICAgIGdldCBoZWF0VGllcigpIHsgcmV0dXJuIGhlYXRUaWVyOyB9LFxuICAgIGdldCBwYWlkTG9vcCgpIHsgcmV0dXJuIHBhaWRMb29wOyB9LFxuICB9O1xufVxuIl0sIm1hcHBpbmdzIjoiQUFBQTtBQUNBLFNBQVNBLE1BQU0sUUFBUSx3QkFBd0I7QUFDL0MsT0FBTyxTQUFTQyxhQUFhQSxDQUFDQyxZQUFZLEVBQUU7RUFDMUMsTUFBTTtJQUFFQyxRQUFRO0lBQUVDLE1BQU07SUFBRUMsS0FBSztJQUFFQyxNQUFNO0lBQUVDLE9BQU87SUFBRUMsS0FBSztJQUFFQyxNQUFNO0lBQUVDLEdBQUc7SUFBRUMsS0FBSztJQUFFQyxVQUFVO0lBQUVDLElBQUk7SUFBRUMsV0FBVztJQUFFQyxDQUFDO0lBQUVDLFVBQVU7SUFBRUMsSUFBSTtJQUFFQyxPQUFPO0lBQUVDLElBQUk7SUFBRUMsWUFBWTtJQUFFQyxNQUFNO0lBQUVDLEdBQUc7SUFBRUMsTUFBTTtJQUFFQyxJQUFJO0lBQUVDLEVBQUU7SUFBRUMsTUFBTTtJQUFFQyxVQUFVO0lBQUVDLGVBQWU7SUFBRUMsVUFBVTtJQUFFQyxRQUFRO0lBQUVDLFNBQVM7SUFBRUMsU0FBUztJQUFFQyxPQUFPO0lBQUVDLFlBQVk7SUFBRUMsYUFBYTtJQUFFQyxXQUFXO0lBQUVDLFFBQVE7SUFBRUMsYUFBYTtJQUFFQyxXQUFXO0lBQUVDLFFBQVE7SUFBRUMsV0FB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

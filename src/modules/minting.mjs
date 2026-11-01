// Module: minting. Construction is inert; I/O is invoked explicitly.
import { feeDay } from '../../receipt-fees.mjs';
export function createMinting(dependencies) {
  const {
    activity,
    AG_MIN,
    walletLimit = async () => 0,
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
      /* 使用者 11/1 14:16：「付手續費的免費」一律當付費——今天被這種小項目掏了約 0.195 BNB；付费须核实每钱包或每笔限额 */
      if (!(await walletLimit(c))) return '⏸ 付费合约未核实每钱包或每笔限额';
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
    const hotP = all.filter(([c, P]) => FORCE.has(c) || ((Object.keys(S.grpHits?.[c]?.chats || {}).length >= 2 || P.fromUrl) || (P.progress || 0) >= 0.45 || (fpCache.get(c)?.p || 0) >= 0.45 || !(P.progress > 0) && Math.max(P.agents || 0, HOT.get(c)?.from.size || 0) >= 70) && (P.progress || 0) < 0.999 && !P.unmintable).filter(([c, P]) => !WALLETS.every(W => P.done[W.name])).sort((a, b) => (b[1].progress || 0) - (a[1].progress || 0) || (b[1].agents || 0) - (a[1].agents || 0)).slice(0, 12); /* 使用者 10/31 20:29：快速檢查只看快到門檻的（進度 ≥45%，或讀不到進度但已 70 個以上錢包），最多 12 個，避免越來越慢 */
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
          needPct = GO_PCT; /* 使用者 11/1 02:37：全部改回進度超過 60% 才打（付费还需核实铸造限额） */
        const crowdGo = !(progress > 0) && (P.agents || 0) >= AG_MIN; /* 審查 11/1：只算持有 Agent ID 的錢包（熱度名單含一般地址，可能被機器人灌） */ /* 使用者 10/31 19:45：讀不到進度 → 100 個以上錢包在打就打 */
        if (!forced && !((progress >= needPct && (P.agents || 0) >= AG_MIN) || crowdGo)) continue;
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
          /* 使用者 11/1 01:56：風險變大了——付费项目须读取每钱包或每笔上限；不再以退款函数为必要条件 */
          const paying = !(kind === 'replay' && !(BigInt(P.replay?.value || '0') > 0n) && !P.replay?.payTok);
          if (paying && !(await walletLimit(c))) {
            P.lastReason = '未核实每钱包或每笔铸造限额'; continue;
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
                if (!good && v > 0n) for (const pct of [102n, 105n, 110n, 120n]) {
                  /* 除錯 11/1：AID 價格從 0.0204 漲到 0.022（+8%），舊的只試 +2% → 合約回 MAX_COST 打不了；改成 +2%～+20% 一路試，金額在 20U 預算與餘額內 */
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

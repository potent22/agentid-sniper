// Module: discovery. Construction is inert; I/O is invoked explicitly.

export function createDiscovery(dependencies) {
  const {
    activity,
    CANDS,
    INFRA,
    ME,
    NEAR_FREE,
    REGISTRY,
    RPCS,
    S,
    T_TRANSFER,
    WALLETS,
    badSel,
    call,
    findFree,
    fullCode,
    heatTier,
    keccakHex,
    learnReplay,
    log,
    logsRpc,
    noteDeploy,
    noteDev,
    queueMint,
    rpc,
    rpcBatch,
    scheduler,
    tg,
    tokStr,
    ts,
    wa,
    fetchImpl
  } = dependencies;
  const DEPLOYERS = ['0x4e59b44847b379578588920ca78fbf26c0b4956c', '0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed', '0x0000000000ffe8b47b3e2130213b802212439497', '0x914d7fec6aac8cd542e72bca78b30650d45643d7'];
  const WINNERS = ['0x8e6442663a4f8c50b6132c68d42a30e7dfe4ae15', '0x04fd77c2f97d044b3c719282fd0a0568f4254afa', '0x415aac3e46264c046d103c994a1da71f05c547f9', '0x171f264f938d55d968afc5d6b133c4157a61f05f'];
  let SMART = new Set(S.smart || []);
  async function buildSmart() {
    const head = parseInt(await rpc('eth_blockNumber', []), 16);
    const cnt = {};
    for (const a of WINNERS) {
      try {
        const has = async b => ((await rpc('eth_getCode', [a, '0x' + b.toString(16)]).catch(() => '0x')) || '0x').length > 2;
        let lo = head - 400000,
          hi = head;
        if (await has(lo)) continue;
        while (hi - lo > 1) {
          const m = lo + hi >> 1;
          if (await has(m)) hi = m;else lo = m;
        }
        const tos = [];
        for (let f = hi; f < Math.min(head, hi + 60000) && tos.length < 300; f += 3000) {
          const logs = await rpc('eth_getLogs', [{
            address: a,
            fromBlock: '0x' + f.toString(16),
            toBlock: '0x' + (f + 2999).toString(16),
            topics: [T_TRANSFER, '0x' + '0'.repeat(64)]
          }]).catch(() => []);
          for (const l of logs || []) {
            const t = '0x' + l.topics[2].slice(26);
            if (!tos.includes(t)) tos.push(t);
            if (tos.length >= 300) break;
          }
        }
        for (const t of tos) cnt[t] = (cnt[t] || 0) + 1;
      } catch (e) {
        log('smart ' + a + ' ' + e.message);
      }
    }
    for (const W of WALLETS) delete cnt[W.addr];
    const list = Object.entries(cnt).filter(([, c]) => c >= 2).map(([t]) => t);
    if (list.length) {
      SMART = new Set(list);
      S.smart = list;
      S.smartAt = Date.now();
      log(`聰明錢包名單更新：${list.length} 個`);
    }
  }
  const HOT = new Map(),
    hotChecked = new Map();
  function countHot(txs) {
    const now = Date.now();
    if (!SMART.size && S.smart?.length) SMART = new Set(S.smart);
    for (const t of txs) {
      const recv = (t.input || '0x') === '0x' && BigInt(t.value || '0x0') > 0n; // 直接轉 BNB 就鑄（像 BNBS）
      if (!t.to || (t.input || '').length > 2 + 8 + 64 * 4 || BigInt(t.value || '0x0') > 2n * 10n ** 17n) continue; // 鑄造常要付 BNB（QUOGENT 0.0005、灯笼镇 0.0125–0.1），≤0.2 BNB 的呼叫都算
      if (/^0x(a9059cbb|095ea7b3|23b872dd|d0e30db0|2e1a7d4d|39509351|a457c2d7)/.test(t.input || '')) continue; // 轉帳、授權、存取這類不是鑄造 // 只看短呼叫、≤0.001 BNB 的（鑄造的樣子）
      const k = t.to.toLowerCase();
      let h = HOT.get(k);
      if (!h) {
        h = {
          from: new Set(),
          at: now,
          sel: new Map()
        };
        HOT.set(k, h);
      }
      if (now - h.at > 180e3) {
        h.from.clear();
        h.at = now;
        h.sel.clear();
        h.smart = new Set();
        h.vals = new Map();
      }
      if (SMART.has(t.from.toLowerCase())) (h.smart = h.smart || new Set()).add(t.from.toLowerCase());
      h.from.add(t.from.toLowerCase());
      const sl = (t.input || '').slice(0, 10);
      h.sel.set(sl, (h.sel.get(sl) || 0) + 1);
      if (recv) {
        h.vals = h.vals || new Map();
        const vv = BigInt(t.value).toString();
        h.vals.set(vv, (h.vals.get(vv) || 0) + 1);
      }
    }
    if (HOT.size > 20000) for (const [k, h] of HOT) if (now - h.at > 180e3) HOT.delete(k);
  }
  const MINTS = new Map(),
    mintChecked = new Map();
  const ZERO32 = '0x' + '0'.repeat(64);
  async function mintLogs(from, to) {
    // 1) drpc 支援不帶地址的 getLogs（最省流量）
    try {
      const r = await (await fetchImpl('https://bsc.drpc.org', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getLogs',
          params: [{
            fromBlock: '0x' + from.toString(16),
            toBlock: '0x' + to.toString(16),
            topics: [T_TRANSFER, ZERO32]
          }]
        }),
        signal: AbortSignal.timeout(10000)
      })).json();
      if (Array.isArray(r.result)) return r.result;
    } catch {}
    // 2) 退而求其次：抓整個區塊的收據自己過濾
    const out = [],
      nodes = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io', 'https://bsc-rpc.publicnode.com'];
    await Promise.all(Array.from({
      length: to - from + 1
    }, (_, i) => from + i).map(async (b, i) => {
      for (let k = 0; k < nodes.length; k++) {
        try {
          const r = await (await fetchImpl(nodes[(i + k) % nodes.length], {
            method: 'POST',
            headers: {
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'eth_getBlockReceipts',
              params: ['0x' + b.toString(16)]
            }),
            signal: AbortSignal.timeout(12000)
          })).json();
          if (Array.isArray(r.result)) {
            for (const rc of r.result) for (const l of rc.logs || []) if (l.topics?.[0] === T_TRANSFER && l.topics[1] === ZERO32 && l.topics[2]) out.push(l);
            return;
          }
        } catch {}
      }
    }));
    return out;
  }
  async function mintScan(head) {
    if (!S.mintBlock || head - S.mintBlock > 300) S.mintBlock = head - 5;
    const to = Math.min(head, S.mintBlock + 60);
    if (to <= S.mintBlock) return;
    const logs = await mintLogs(S.mintBlock + 1, to);
    S.mintBlock = to;
    const now = Date.now();
    for (const l of logs) {
      const a = l.address.toLowerCase();
      let m = MINTS.get(a);
      if (!m) {
        m = {
          at: now,
          to: new Set(),
          txs: []
        };
        MINTS.set(a, m);
      }
      if (now - m.at > 1800e3) {
        m.at = now;
        m.to.clear();
        m.txs = [];
      } // 30 分鐘內累計（慢熱的項目也抓得到）
      m.to.add('0x' + l.topics[2].slice(26));
      if (m.txs.length < 8) m.txs.push(l.transactionHash);
    }
    if (MINTS.size > 30000) for (const [k, m] of MINTS) if (now - m.at > 1800e3) MINTS.delete(k);
    for (const [a, m] of MINTS) {
      if (m.to.size < 6 || mintChecked.has(a) && m.to.size < mintChecked.get(a) * 2 || S.seenMints[a]) continue; // 沒過的，等人數翻倍再看一次 // 6 個不同錢包被鑄到就檢查（QUOGENT 開打頭 15 分鐘只有十幾個錢包）
      mintChecked.set(a, m.to.size);
      if (mintChecked.size > 20000) mintChecked.delete(mintChecked.keys().next().value);
      await checkMinted(a, m).catch(e => log('mintScan ' + a + ' ' + e.message));
    }
  }
  const CLAIM = new Set();
  async function checkMinted(tok, m) {
    // 找出大家實際呼叫的合約（鑄造合約可能跟代幣合約不同）
    const txs = (await Promise.all(m.txs.slice(0, 6).map(h => rpc('eth_getTransactionByHash', [h]).catch(() => null)))).filter(Boolean);
    const cnt = {};
    for (const t of txs) if (t.to) cnt[t.to.toLowerCase()] = (cnt[t.to.toLowerCase()] || 0) + 1;
    const target = Object.entries(cnt).sort((x, y) => y[1] - x[1])[0]?.[0];
    if (!target) return;
    if (S.seenMints[target] || S.seenMints[tok] || CLAIM.has(target)) return;
    CLAIM.add(target); // 審查修正：同一個合約只讓一個流程處理，避免重複打
    // 是不是 Agent ID 專屬：合約碼有登記合約，或鑄到的錢包六成以上有 .ai 身份
    let code = ((await rpc('eth_getCode', [target, 'latest']).catch(() => '')) || '').toLowerCase();
    code = await fullCode(target, code);
    const tcode = tok === target ? code : ((await rpc('eth_getCode', [tok, 'latest']).catch(() => '')) || '').toLowerCase();
    let gated = code.includes(REGISTRY) || tcode.includes(REGISTRY),
      share = 0;
    if (!gated) {
      // 沒寫 Agent ID 檢查的：只看兩天內新部署的合約（排除 LP、老代幣這類每天都在鑄的）
      const head = parseInt(await rpc('eth_blockNumber', []), 16);
      const old = (await rpc('eth_getCode', [tok, '0x' + (head - 400000).toString(16)]).catch(() => '0x')) || '0x';
      if (old.length > 2) return;
      const sample = [...m.to].slice(0, 12);
      let n = 0;
      for (const x of sample) {
        const r = await call('0x' + REGISTRY, '0x70a08231' + wa(x));
        if (r && BigInt(r.slice(0, 66)) > 0n) n++;
      }
      share = n / sample.length;
      if (n < 4 || share < 0.6) return;
      gated = true;
    }
    if (INFRA.has(target) || INFRA.has(tok)) return; // Agent ID 登記合約本身不是項目
    S.seenMints[target] = ts();
    S.seenMints[tok] = ts();
    const name = tokStr(await call(tok, '0x06fdde03')) || tokStr(await call(target, '0x06fdde03'));
    // 先試常見免費函式；不行就「照別人的呼叫內容重播」（不含別人地址的才重播）
    let minted = '';
    const sampleTx = txs.find(t => t.to && t.to.toLowerCase() === target);
    for (const W of WALLETS) {
      let ff = await findFree(W.addr, target, code);
      if (!ff && sampleTx && sampleTx.input.length >= 10 && !badSel(sampleTx.input) && !sampleTx.input.toLowerCase().includes(sampleTx.from.slice(2).toLowerCase())) {
        for (const v of NEAR_FREE) {
          try {
            await rpc('eth_call', [{
              from: W.addr,
              to: target,
              data: sampleTx.input,
              value: '0x' + v.toString(16)
            }, 'latest']);
            const nm = '重播' + sampleTx.input.slice(0, 10) + '@' + target.slice(2, 10);
            if (!CANDS.some(c => c[0] === nm)) CANDS.push([nm, sampleTx.input]);
            ff = {
              n: nm,
              v
            };
            break;
          } catch {}
        }
      }
      if (ff) minted += `[${W.name}] ` + queueMint(target, ff.n, W, ff.v) + '\n';
    }
    if (!minted) {
      S.paid = S.paid || {};
      const val = sampleTx ? BigInt(sampleTx.value || '0x0') : 0n;
      const noAddr = sampleTx && !sampleTx.input.toLowerCase().includes(sampleTx.from.slice(2).toLowerCase());
      S.paid[target] = {
        at: Date.now(),
        name,
        done: {},
        wallets: m.to.size,
        ...((sampleTx?.input || '0x') === '0x' && val > 0n ? {
          recvValue: val.toString(),
          recvSeen: m.to.size
        } : {}),
        ...(noAddr && sampleTx.input !== '0x' && !badSel(sampleTx.input) ? {
          replay: {
            data: sampleTx.input,
            value: val.toString()
          }
        } : {})
      };
    }
    await tg(`🔥 發現正在被鑄造的 Agent ID 項目${name ? '：' + name : ''}（3 分鐘內鑄給 ${m.to.size} 個錢包${share ? `，${Math.round(share * 100)}% 有 .ai 身份` : ''}）\n${target}\n${minted || '⚪ 不是免費的 → 已加入追蹤：進度超過 80% 且 150 個以上 Agent ID 錢包在打（讀不到進度也要 150 個以上）且每個錢包 ≤1.2U 會自動打'}`);
  }
  async function hotScan() {
    for (const [c, h] of HOT) {
      if (INFRA.has(c) || CLAIM.has(c)) continue;
      if (h.from.size < 12 && (h.smart?.size || 0) < 2 || S.seenMints[c] || hotChecked.has(c)) continue;
      CLAIM.add(c);
      hotChecked.set(c, Date.now());
      if (hotChecked.size > 5000) hotChecked.delete(hotChecked.keys().next().value);
      let code = ((await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || '').toLowerCase();
      code = await fullCode(c, code);
      let viaAgents = 0;
      if (!code.includes(REGISTRY)) {
        // 合約碼裡沒有 Agent ID 登記合約（可能用後端簽名驗證，像灯笼镇、Silicon Dreamers）→ 改看「打它的人是不是大多持有 Agent ID」
        if (code.length < 4) continue;
        const head = parseInt(await rpc('eth_blockNumber', []), 16);
        const old = (await rpc('eth_getCode', [c, '0x' + (head - 400000).toString(16)]).catch(() => '0x')) || '0x';
        if (old.length > 2) continue; // 兩天前就存在的老合約不算新項目
        const sample = [...h.from].slice(0, 16);
        let n = 0;
        for (const a of sample) {
          const r = await call('0x' + REGISTRY, '0x70a08231' + wa(a));
          if (r && BigInt(r.slice(0, 66)) > 0n) n++;
        }
        if (n < 8 || n / sample.length < 0.6) continue;
        viaAgents = n / sample.length;
      }
      S.seenMints[c] = ts();
      const name = tokStr(await call(c, '0x06fdde03'));
      // 熱門呼叫的函式也加入候選（不在 CANDS 裡的鑄造函式名）
      const topSel = [...h.sel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      let minted = '';
      for (const W of WALLETS) {
        let ff = await findFree(W.addr, c, code);
        if (!ff && topSel && topSel.length === 10 && !badSel(topSel)) for (const v of NEAR_FREE) {
          try {
            await rpc('eth_call', [{
              from: W.addr,
              to: c,
              data: topSel,
              value: '0x' + v.toString(16)
            }, 'latest']);
            {
              const nm = '熱門函式' + topSel + '@' + c.slice(2, 10);
              if (!CANDS.some(x => x[0] === nm)) CANDS.push([nm, topSel]);
              ff = {
                n: nm,
                v
              };
            }
            break;
          } catch {}
        }
        if (ff) minted += `[${W.name}] ` + queueMint(c, ff.n, W, ff.v) + '\n';
      }
      if (!minted) {
        S.paid = S.paid || {};
        // 轉 BNB 就鑄的：取大家最常轉的金額當「一份的價格」（至少 10 筆一樣才算數）
        const top = [...(h.vals || new Map()).entries()].sort((a, b) => b[1] - a[1])[0];
        S.paid[c] = {
          at: Date.now(),
          name,
          done: {},
          wallets: h.from.size,
          ...(top && top[1] >= 2 ? {
            recvValue: top[0],
            recvSeen: top[1]
          } : {})
        };
      }
      await tg(`🔥 發現正在被搶打的 Agent ID 項目${name ? '：' + name : ''}${viaAgents ? `（合約沒寫 Agent ID 檢查，但打它的錢包 ${Math.round(viaAgents * 100)}% 持有 .ai 身份，可能是後端簽名驗證）` : ''}（3 分鐘內 ${h.from.size} 個錢包${h.smart?.size ? '，其中聰明錢包 ' + h.smart.size + ' 個' : ''}）\n${c}\n${minted || '⚪ 不是免費的 → 已加入追蹤：進度超過 80% 且 150 個以上 Agent ID 錢包在打（讀不到進度也要 150 個以上）且每個錢包 ≤1.2U 會自動打'}\nhttps://bscscan.com/address/${c}`);
    }
  }
  const BG = [];
  let bgRun = 0;
  function bgJob(fn) {
    if (!activity.stopping) {
      BG.push(fn);
      pumpBG();
    }
  }
  function pumpBG() {
    while (!activity.stopping && bgRun < 3 && BG.length) {
      const f = BG.shift();
      bgRun++;
      activity.track(f().catch(e => log('bg ' + e.message)).finally(() => {
        bgRun--;
        pumpBG();
      }));
    }
  }
  async function scanNew(head) {
    if (!S.lastBlock) S.lastBlock = head - 5;
    if (head - S.lastBlock > 1500) {
      log(`掃描落後太多（${head - S.lastBlock} 塊），跳到最新`);
      S.lastBlock = head - 200;
    }
    // BSC 現在約 0.45 秒一個區塊（每分鐘 ~130 塊），以前一次只掃 40 塊會越落越後（曾落後 2.5 小時）→ 改成多節點並行抓
    const to = Math.min(head, S.lastBlock + 400);
    const nums = [];
    for (let b = S.lastBlock + 1; b <= to; b++) nums.push(b);
    const blocks = new Map();
    let idx = 0;
    const fetchBlk = async b => {
      for (let k = 0; k < RPCS.length; k++) {
        const u = RPCS[(b + k) % RPCS.length];
        try {
          const r = await (await fetchImpl(u, {
            method: 'POST',
            headers: {
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'eth_getBlockByNumber',
              params: ['0x' + b.toString(16), true]
            }),
            signal: AbortSignal.timeout(15000)
          })).json();
          if (r.result) return r.result;
        } catch {}
      }
      return null;
    };
    await Promise.all(Array.from({
      length: 24
    }, async () => {
      while (idx < nums.length) {
        const b = nums[idx++];
        const blk = await fetchBlk(b);
        if (blk) {
          countHot(blk.transactions);
        }
        if (blk) blocks.set(b, blk.transactions.filter(t => !t.to || (t.input || '').length > 2000 && ((t.input || '').toLowerCase().includes(REGISTRY) || DEPLOYERS.includes(t.to.toLowerCase()))));else blocks.set(b, null);
      }
    }));
    let done = S.lastBlock;
    for (const b of nums) {
      if (blocks.get(b) == null) break;
      done = b;
    }
    if (done === S.lastBlock && nums.length) {
      log('scan 抓區塊失敗 ' + nums[0]);
      return;
    }
    S.scanLag = head - done;
    for (let b = S.lastBlock + 1; b <= done; b++) {
      for (const tx of blocks.get(b) || []) {
        // 新合約有三種出生方式：①直接部署 ②透過 CREATE2 部署器（灯笼镇就是這種）③由別的工廠合約建立
        const inp = (tx.input || '').toLowerCase();
        if (tx.to && !(inp.length > 2000 && (inp.includes(REGISTRY) || DEPLOYERS.includes(tx.to.toLowerCase())))) continue;
        let cs = [];
        try {
          if (!tx.to) {
            const rc = await rpc('eth_getTransactionReceipt', [tx.hash]);
            if (rc?.contractAddress) cs = [rc.contractAddress.toLowerCase()];
          } else if (tx.to.toLowerCase() === '0x4e59b44847b379578588920ca78fbf26c0b4956c') {
            const salt = inp.slice(2, 66),
              init = inp.slice(66);
            cs = ['0x' + keccakHex('ff' + tx.to.slice(2).toLowerCase() + salt + keccakHex(init)).slice(24)];
          } else {
            const rc = await rpc('eth_getTransactionReceipt', [tx.hash]);
            if (rc?.status !== '0x1') continue;
            const as = [...new Set((rc.logs || []).map(l => l.address.toLowerCase()))];
            for (const a of as) {
              const before = await rpc('eth_getCode', [a, '0x' + (b - 1).toString(16)]).catch(() => '0x');
              if (!before || before === '0x') cs.push(a);
            }
          }
        } catch {
          continue;
        }
        for (const c of cs) try {
          if (S.seenMints[c]) continue;
          let code = (await rpc('eth_getCode', [c, 'latest'])) || '';
          code = await fullCode(c, code); /* 代理合約（各種寫法）都追到背後真正的程式 */
          if (!code.toLowerCase().includes(REGISTRY) && !code.includes('9f92d0dd')) continue;
          S.seenMints[c] = ts();
          noteDeploy(code);
          S.deployer = S.deployer || {};
          S.deployer[c] = (tx.from || '').toLowerCase();
          S.depFrom = S.depFrom || {};
          S.depFrom[c] = S.deployer[c];
          noteDev(S.deployer[c], c);
          bgJob(async () => {
            const ok = [];
            {
              const ff = await findFree(ME, c, code);
              if (ff) ok.push(ff.n + (ff.v > 0n ? `（付 ${Number(ff.v) / 1e18} BNB 手續費）` : ''));
            }
            const str = r => {
              try {
                const h = r.slice(2);
                const len = Number(BigInt('0x' + h.slice(64, 128)));
                return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8');
              } catch {
                return '';
              }
            };
            let name = str(await call(c, '0x06fdde03'));
            if (!name) for (const sel of ['0xfc0c546a']) {
              const r = await call(c, sel);
              if (r && r.length >= 66 && BigInt(r.slice(0, 66)) > 0n) {
                const ta = '0x' + r.slice(26, 66);
                const n2 = str(await call(ta, '0x06fdde03')),
                  s2 = str(await call(ta, '0x95d89b41'));
                if (n2) {
                  name = `${n2}${s2 ? ' ($' + s2 + ')' : ''}`;
                  break;
                }
              }
            }
            const lc = code.toLowerCase();
            const pay = lc.includes('55d398326f99059ff775485246999027b3197955') ? '要付 USDT' : lc.includes('8ac76a51cc950d9822d68b83fe1ad97b32cd580d') ? '要付 USDC' : '可能要付 BNB';
            const factoryLike = ['27cca59f', '7d38bb0d', '1737a4bd'].some(x => code.includes(x)) || /(6c61756e6368|666163746f7279)/.test(code.toLowerCase());
            if (factoryLike) await tg(`🏗 發現疑似新的 Agent ID 發射台／工廠合約${name ? '：' + name : ''}\n${c}\n可能是像 ToshX、Flap Agent 這種平台，可以自己到 BscScan 查看`);
            let minted = '';
            for (const W of WALLETS) {
              const ff = await findFree(W.addr, c, code);
              const f = ff?.n;
              if (f) minted += `[${W.name}] ` + queueMint(c, f, W, ff.v) + '\n';
            }
            if (!ok.length) {
              S.paid = S.paid || {};
              S.paid[c] = {
                at: Date.now(),
                name,
                done: {}
              };
            }
            await tg(`🆕 發現新的 Agent ID 專屬合約${name ? '：' + name : ''}\n${c}\n${ok.length ? '✅ 模擬免費可鑄：' + ok.join('、') + '\n' + minted : `⚪ 現在不是免費的（${pay}，或還沒開）→ 已加入追蹤：\n· 免費 → 進度超過 80% 且 150 個以上 Agent ID 錢包在打 → 自動打\n· 要付任何手續費 → 當付費：另外還要合約有保本機制（或讀不到進度但很多人在打）且每個錢包 ≤1.2U → 自動打`}\nhttps://bscscan.com/address/${c}`);
          }); // 背景處理新合約（模擬、鑄造、通知），掃描不用等
        } catch {}
      }
    }
    if (!scheduler._hsBusy) {
      scheduler._hsBusy = true;
      hotScan().catch(e => log('hotScan ' + e.message)).finally(() => {
        scheduler._hsBusy = false;
      });
    }
    if (!scheduler._msBusy) {
      scheduler._msBusy = true;
      mintScan(done).catch(e => log('mintScan ' + e.message)).finally(() => {
        scheduler._msBusy = false;
      });
    }
    {
      /* 代理合約掃描：被限流就換節點；全部被限流先暫停 30 秒，之後從沒掃到的區塊補掃，不跳過 */
      S.proxyFrom = S.proxyFrom || S.lastBlock + 1;
      if (done - S.proxyFrom > 3000) S.proxyFrom = done - 3000;
      if (Date.now() > (scheduler._proxyPause || 0)) {
        const to = Math.min(done, S.proxyFrom + 500);
        try {
          await proxyScan(S.proxyFrom, to);
          S.proxyFrom = to + 1;
          scheduler._proxyFails = 0;
        } catch (e) {
          scheduler._proxyFails = (scheduler._proxyFails || 0) + 1;
          scheduler._proxyPause = Date.now() + 30e3;
          if (scheduler._proxyFails === 1 || scheduler._proxyFails % 20 === 0) log(`proxyScan 所有節點都被限流（第 ${scheduler._proxyFails} 次），暫停 30 秒後補掃：${e.message.slice(0, 80)}`);
        }
      }
    }
    S.lastBlock = done;
  }
  const T_BEACON_UP = '0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e';
  const T_UPGRADED = '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b';
  const implCache = new Map();
  const VAULT_FACTORIES = ['0x90497450f2a706f1951b5bdda52b4e5d16f34c06'];
  async function proxyScan(from, to) {
    if (to < from) return;
    // 公用節點不允許不帶地址的 getLogs，所以盯 Flap 金庫工廠：它每建一個新金庫就有事件，再從那筆交易收據找新代理合約
    const fl = await logsRpc([{
      address: VAULT_FACTORIES,
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + to.toString(16)
    }]);
    const txs = [...new Set((fl || []).map(l => l.transactionHash))];
    const logs = [];
    for (const h of txs) {
      const rc = await rpc('eth_getTransactionReceipt', [h]).catch(() => null);
      for (const l of rc?.logs || []) if (l.topics[0] === T_BEACON_UP || l.topics[0] === T_UPGRADED) logs.push(l);
    }
    for (const l of logs) {
      const c = l.address.toLowerCase();
      if (S.seenMints[c]) continue;
      let impl = '0x' + l.topics[1].slice(26);
      if (l.topics[0] === T_BEACON_UP) {
        const r = await call(impl, '0x5c60da1b');
        if (!r) continue;
        impl = '0x' + r.slice(-40);
      }
      if (!implCache.has(impl)) {
        const code = (await rpc('eth_getCode', [impl, 'latest']).catch(() => '')) || '';
        implCache.set(impl, code);
        if (implCache.size > 500) implCache.delete(implCache.keys().next().value);
      }
      const code = implCache.get(impl);
      if (!code.toLowerCase().includes(REGISTRY) && !code.includes('9f92d0dd')) continue;
      S.seenMints[c] = ts();
      let minted = '';
      for (const W of WALLETS) {
        const ff = await findFree(W.addr, c, code);
        const f = ff?.n;
        if (f) minted += `[${W.name}] ` + queueMint(c, f, W, ff.v) + '\n';
      }
      await tg(`🧩 發現工廠建立的 Agent ID 合約（代理合約，像 AIDROP 那種）\n${c}\n${minted || '⚪ 目前模擬不能免費參加（可能要付費或還沒開）'}`);
    }
  }
  const agentCache = new Map();
  async function heatOf(c, P) {
    // 算熱度：最近約 2.5 小時有幾個不同的 Agent ID 錢包參與鑄造，其中最近 3 分鐘幾個
    const head = parseInt(await rpc('eth_blockNumber', []), 16);
    let tok = '';
    const tr = await call(c, '0xfc0c546a');
    if (tr && tr.length >= 66 && BigInt(tr.slice(0, 66)) > 0n) tok = '0x' + tr.slice(26, 66).toLowerCase();
    const last = new Map();
    const skip = new Set([c, tok, '0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);
    const span = P.heatAt ? 6000 : 20000; // 第一次看約 2.5 小時，之後只看最近約 45 分鐘（累計數取最大值）
    for (let b = head - span; b <= head; b += 10000) {
      const q = [{
        address: tok ? [c, tok] : c,
        fromBlock: '0x' + b.toString(16),
        toBlock: '0x' + Math.min(b + 9999, head).toString(16)
      }];
      const L = await rpc('eth_getLogs', q).catch(() => logsRpc(q).catch(() => [])); /* 除錯 11/1：預設節點限流時改用多節點，熱度（參與人數）才算得準 */
      for (const l of L || []) for (const t of (l.topics || []).slice(1)) {
        if (!/^0x0{24}[0-9a-f]{40}$/i.test(t) || t.slice(26, 34) === '00000000') continue;
        const a = ('0x' + t.slice(26)).toLowerCase();
        if (skip.has(a)) continue;
        const bn = parseInt(l.blockNumber, 16);
        if (!last.has(a) || last.get(a) < bn) last.set(a, bn);
      }
    }
    const unknown = [...last.keys()].filter(a => !agentCache.has(a)).slice(0, 400);
    if (unknown.length) {
      const res = await rpcBatch(unknown.map(a => ({
        method: 'eth_call',
        params: [{
          to: '0x' + REGISTRY,
          data: '0x70a08231' + wa(a)
        }, 'latest']
      })));
      unknown.forEach((a, i) => {
        if (res[i] !== undefined) agentCache.set(a, !!res[i] && res[i].length >= 66 && BigInt(res[i].slice(0, 66)) > 0n);
      });
    }
    let agents = 0,
      burst = 0;
    for (const [a, bn] of last) if (agentCache.get(a)) {
      agents++;
      if (bn >= head - 400) burst++;
    }
    P.agents = Math.max(P.agents || 0, agents);
    P.burst = burst;
    P.heatAt = Date.now();
  }
  const hk = P => (P.heatAt || 0) + (heatTier(P) >= 1 || (P.progress || 0) >= 0.2 ? 0 : 540e3);
  async function heatWatch() {
    // 背景：替追蹤中的付費項目算熱度，看不懂的合約順便學別人的打法（不拖慢 15 秒的快速檢查）
    const ents = Object.entries(S.paid || {}).filter(([c, P]) => !INFRA.has(c) && !P.unmintable && (P.progress || 0) < 0.999 && !WALLETS.every(W => P.done?.[W.name])).sort((a, b) => (b[1].needLearn && (b[1].progress || 0) >= 0.45) - (a[1].needLearn && (a[1].progress || 0) >= 0.45) || hk(a[1]) - hk(b[1])).slice(0, 8); // 快滿或很熱的約每分鐘更新，其他約 10 分鐘；快到門檻又還不會打的排最前面（除錯 11/1：BNBCAT 57% 一直排不到）
    for (const [c, P] of ents) {
      try {
        await heatOf(c, P).catch(e => log('heat ' + c + ' ' + e.message)); /* 除錯 11/1：算熱度被節點限流時，學打法也跟著被跳過 → 分開處理 */
        if (P.needLearn && (!P.replay || Date.now() - (P.replay.learnedAt || 0) > 120e3) && (heatTier(P) >= 1 || (P.progress || 0) >= 0.2 || (P.agents || 0) >= 20)) {
          const lr = await learnReplay(c).catch(() => null);
          if (lr?.recv) {
            P.recvValue = lr.recv;
            P.recvSeen = lr.recvSeen;
            P.recvVals = lr.recvVals;
            P.replay = {
              hot: lr.hot,
              learnedAt: lr.learnedAt
            };
            delete P.needLearn;
            log(`學到 ${P.name || c} 的打法：直接轉 ${Number(BigInt(lr.recv)) / 1e18} BNB 就鑄造（${lr.recvSeen} 筆）`);
          } else if (lr) P.replay = lr;
        }
      } catch (e) {
        log('heat ' + c + ' ' + e.message);
      }
    }
  }
  return {
    get buildSmart() {
      return buildSmart;
    },
    get HOT() {
      return HOT;
    },
    get scanNew() {
      return scanNew;
    },
    get heatWatch() {
      return heatWatch;
    }
  };
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJjcmVhdGVEaXNjb3ZlcnkiLCJkZXBlbmRlbmNpZXMiLCJhY3Rpdml0eSIsIkNBTkRTIiwiSU5GUkEiLCJNRSIsIk5FQVJfRlJFRSIsIlJFR0lTVFJZIiwiUlBDUyIsIlMiLCJUX1RSQU5TRkVSIiwiV0FMTEVUUyIsImJhZFNlbCIsImNhbGwiLCJmaW5kRnJlZSIsImZ1bGxDb2RlIiwiaGVhdFRpZXIiLCJrZWNjYWtIZXgiLCJsZWFyblJlcGxheSIsImxvZyIsImxvZ3NScGMiLCJub3RlRGVwbG95Iiwibm90ZURldiIsInF1ZXVlTWludCIsInJwYyIsInJwY0JhdGNoIiwic2NoZWR1bGVyIiwidGciLCJ0b2tTdHIiLCJ0cyIsIndhIiwiZmV0Y2hJbXBsIiwiREVQTE9ZRVJTIiwiV0lOTkVSUyIsIlNNQVJUIiwiU2V0Iiwic21hcnQiLCJidWlsZFNtYXJ0IiwiaGVhZCIsInBhcnNlSW50IiwiY250IiwiYSIsImhhcyIsImIiLCJ0b1N0cmluZyIsImNhdGNoIiwibGVuZ3RoIiwibG8iLCJoaSIsIm0iLCJ0b3MiLCJmIiwiTWF0aCIsIm1pbiIsImxvZ3MiLCJhZGRyZXNzIiwiZnJvbUJsb2NrIiwidG9CbG9jayIsInRvcGljcyIsInJlcGVhdCIsImwiLCJ0Iiwic2xpY2UiLCJpbmNsdWRlcyIsInB1c2giLCJlIiwibWVzc2FnZSIsIlciLCJhZGRyIiwibGlzdCIsIk9iamVjdCIsImVudHJpZXMiLCJmaWx0ZXIiLCJjIiwibWFwIiwic21hcnRBdCIsIkRhdGUiLCJub3ciLCJIT1QiLCJNYXAiLCJob3RDaGVja2VkIiwiY291bnRIb3QiLCJ0eHMiLCJzaXplIiwicmVjdiIsImlucHV0IiwiQmlnSW50IiwidmFsdWUiLCJ0byIsInRlc3QiLCJrIiwidG9Mb3dlckNhc2UiLCJoIiwiZ2V0IiwiZnJvbSIsImF0Iiwic2VsIiwic2V0IiwiY2xlYXIiLCJ2YWxzIiwiYWRkIiwic2wiLCJ2diIsImRlbGV0ZSIsIk1JTlRTIiwibWludENoZWNrZWQiLCJaRVJPMzIiLCJtaW50TG9ncyIsInIiLCJtZXRob2QiLCJoZWFkZXJzIiwiYm9keSIsIkpTT04iLCJzdHJpbmdpZnkiLCJqc29ucnBjIiwiaWQiLCJwYXJhbXMiLCJzaWduYWwiLCJBYm9ydFNpZ25hbCIsInRpbWVvdXQiLCJqc29uIiwiQXJyYXkiLCJpc0FycmF5IiwicmVzdWx0Iiwib3V0Iiwibm9kZXMiLCJQcm9taXNlIiwiYWxsIiwiXyIsImkiLCJyYyIsIm1pbnRTY2FuIiwibWludEJsb2NrIiwidHJhbnNhY3Rpb25IYXNoIiwic2Vlbk1pbnRzIiwia2V5cyIsIm5leHQiLCJjaGVja01pbnRlZCIsIkNMQUlNIiwidG9rIiwiQm9vbGVhbiIsInRhcmdldCIsInNvcnQiLCJ4IiwieSIsImNvZGUiLCJ0Y29kZSIsImdhdGVkIiwic2hhcmUiLCJvbGQiLCJzYW1wbGUiLCJuIiwibmFtZSIsIm1pbnRlZCIsInNhbXBsZVR4IiwiZmluZCIsImZmIiwidiIsImRhdGEiLCJubSIsInNvbWUiLCJwYWlkIiwidmFsIiwibm9BZGRyIiwiZG9uZSIsIndhbGxldHMiLCJyZWN2VmFsdWUiLCJyZWN2U2VlbiIsInJlcGxheSIsInJvdW5kIiwiaG90U2NhbiIsInZpYUFnZW50cyIsInRvcFNlbCIsInRvcCIsIkJHIiwiYmdSdW4iLCJiZ0pvYiIsImZuIiwic3RvcHBpbmciLCJwdW1wQkciLCJzaGlmdCIsInRyYWNrIiwiZmluYWxseSIsInNjYW5OZXciLCJsYXN0QmxvY2siLCJudW1zIiwiYmxvY2tzIiwiaWR4IiwiZmV0Y2hCbGsiLCJ1IiwiYmxrIiwidHJhbnNhY3Rpb25zIiwic2NhbkxhZyIsInR4IiwiaW5wIiwiY3MiLCJoYXNoIiwiY29udHJhY3RBZGRyZXNzIiwic2FsdCIsImluaXQiLCJzdGF0dXMiLCJhcyIsImJlZm9yZSIsImRlcGxveWVyIiwiZGVwRnJvbSIsIm9rIiwiTnVtYmVyIiwic3RyIiwibGVuIiwiQnVmZmVyIiwidGEiLCJuMiIsInMyIiwibGMiLCJwYXkiLCJmYWN0b3J5TGlrZSIsImpvaW4iLCJfaHNCdXN5IiwiX21zQnVzeSIsInByb3h5RnJvbSIsIl9wcm94eVBhdXNlIiwicHJveHlTY2FuIiwiX3Byb3h5RmFpbHMiLCJUX0JFQUNPTl9VUCIsIlRfVVBHUkFERUQiLCJpbXBsQ2FjaGUiLCJWQVVMVF9GQUNUT1JJRVMiLCJmbCIsImltcGwiLCJhZ2VudENhY2hlIiwiaGVhdE9mIiwiUCIsInRyIiwibGFzdCIsInNraXAiLCJzcGFuIiwiaGVhdEF0IiwicSIsIkwiLCJibiIsImJsb2NrTnVtYmVyIiwidW5rbm93biIsInJlcyIsImZvckVhY2giLCJ1bmRlZmluZWQiLCJhZ2VudHMiLCJidXJzdCIsIm1heCIsImhrIiwicHJvZ3Jlc3MiLCJoZWF0V2F0Y2giLCJlbnRzIiwidW5taW50YWJsZSIsImV2ZXJ5IiwibmVlZExlYXJuIiwibGVhcm5lZEF0IiwibHIiLCJyZWN2VmFscyIsImhvdCJdLCJzb3VyY2VzIjpbImRpc2NvdmVyeS5tanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gTW9kdWxlOiBkaXNjb3ZlcnkuIENvbnN0cnVjdGlvbiBpcyBpbmVydDsgSS9PIGlzIGludm9rZWQgZXhwbGljaXRseS5cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZURpc2NvdmVyeShkZXBlbmRlbmNpZXMpIHtcbiAgY29uc3QgeyBhY3Rpdml0eSwgQ0FORFMsIElORlJBLCBNRSwgTkVBUl9GUkVFLCBSRUdJU1RSWSwgUlBDUywgUywgVF9UUkFOU0ZFUiwgV0FMTEVUUywgYmFkU2VsLCBjYWxsLCBmaW5kRnJlZSwgZnVsbENvZGUsIGhlYXRUaWVyLCBrZWNjYWtIZXgsIGxlYXJuUmVwbGF5LCBsb2csIGxvZ3NScGMsIG5vdGVEZXBsb3ksIG5vdGVEZXYsIHF1ZXVlTWludCwgcnBjLCBycGNCYXRjaCwgc2NoZWR1bGVyLCB0ZywgdG9rU3RyLCB0cywgd2EsIGZldGNoSW1wbCB9ID0gZGVwZW5kZW5jaWVzO1xuICBjb25zdCBERVBMT1lFUlMgPSBbJzB4NGU1OWI0NDg0N2IzNzk1Nzg1ODg5MjBjYTc4ZmJmMjZjMGI0OTU2YycsICcweGJhNWVkMDk5NjMzZDNiMzEzZTRkNWY3YmRjMTMwNWQzYzI4YmE1ZWQnLCAnMHgwMDAwMDAwMDAwZmZlOGI0N2IzZTIxMzAyMTNiODAyMjEyNDM5NDk3JywgJzB4OTE0ZDdmZWM2YWFjOGNkNTQyZTcyYmNhNzhiMzA2NTBkNDU2NDNkNyddO1xuXG4gIGNvbnN0IFdJTk5FUlMgPSBbJzB4OGU2NDQyNjYzYTRmOGM1MGI2MTMyYzY4ZDQyYTMwZTdkZmU0YWUxNScsICcweDA0ZmQ3N2MyZjk3ZDA0NGIzYzcxOTI4MmZkMGEwNTY4ZjQyNTRhZmEnLCAnMHg0MTVhYWMzZTQ2MjY0YzA0NmQxMDNjOTk0YTFkYTcxZjA1YzU0N2Y5JywgJzB4MTcxZjI2NGY5MzhkNTVkOTY4YWZjNWQ2YjEzM2M0MTU3YTYxZjA1ZiddO1xuXG4gIGxldCBTTUFSVCA9IG5ldyBTZXQoUy5zbWFydCB8fCBbXSk7XG5cbiAgYXN5bmMgZnVuY3Rpb24gYnVpbGRTbWFydCgpIHtcbiAgICBjb25zdCBoZWFkID0gcGFyc2VJbnQoYXdhaXQgcnBjKCdldGhfYmxvY2tOdW1iZXInLCBbXSksIDE2KTsgY29uc3QgY250ID0ge307XG4gICAgZm9yIChjb25zdCBhIG9mIFdJTk5FUlMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGhhcyA9IGFzeW5jIChiKSA9PiAoKChhd2FpdCBycGMoJ2V0aF9nZXRDb2RlJywgW2EsICcweCcgKyBiLnRvU3RyaW5nKDE2KV0pLmNhdGNoKCgpID0+ICcweCcpKSB8fCAnMHgnKS5sZW5ndGggPiAyKTtcbiAgICAgICAgbGV0IGxvID0gaGVhZCAtIDQwMDAwMCwgaGkgPSBoZWFkOyBpZiAoYXdhaXQgaGFzKGxvKSkgY29udGludWU7XG4gICAgICAgIHdoaWxlIChoaSAtIGxvID4gMSkgeyBjb25zdCBtID0gKGxvICsgaGkpID4+IDE7IGlmIChhd2FpdCBoYXMobSkpIGhpID0gbTsgZWxzZSBsbyA9IG07IH1cbiAgICAgICAgY29uc3QgdG9zID0gW107XG4gICAgICAgIGZvciAobGV0IGYgPSBoaTsgZiA8IE1hdGgubWluKGhlYWQsIGhpICsgNjAwMDApICYmIHRvcy5sZW5ndGggPCAzMDA7IGYgKz0gMzAwMCkge1xuICAgICAgICAgIGNvbnN0IGxvZ3MgPSBhd2FpdCBycGMoJ2V0aF9nZXRMb2dzJywgW3sgYWRkcmVzczogYSwgZnJvbUJsb2NrOiAnMHgnICsgZi50b1N0cmluZygxNiksIHRvQmxvY2s6ICcweCcgKyAoZiArIDI5OTkpLnRvU3RyaW5nKDE2KSwgdG9waWNzOiBbVF9UUkFOU0ZFUiwgJzB4JyArICcwJy5yZXBlYXQoNjQpXSB9XSkuY2F0Y2goKCkgPT4gW10pO1xuICAgICAgICAgIGZvciAoY29uc3QgbCBvZiBsb2dzIHx8IFtdKSB7IGNvbnN0IHQgPSAnMHgnICsgbC50b3BpY3NbMl0uc2xpY2UoMjYpOyBpZiAoIXRvcy5pbmNsdWRlcyh0KSkgdG9zLnB1c2godCk7IGlmICh0b3MubGVuZ3RoID49IDMwMCkgYnJlYWs7IH1cbiAgICAgICAgfVxuICAgICAgICBmb3IgKGNvbnN0IHQgb2YgdG9zKSBjbnRbdF0gPSAoY250W3RdIHx8IDApICsgMTtcbiAgICAgIH0gY2F0Y2ggKGUpIHsgbG9nKCdzbWFydCAnICsgYSArICcgJyArIGUubWVzc2FnZSk7IH1cbiAgICB9XG4gICAgZm9yIChjb25zdCBXIG9mIFdBTExFVFMpIGRlbGV0ZSBjbnRbVy5hZGRyXTtcbiAgICBjb25zdCBsaXN0ID0gT2JqZWN0LmVudHJpZXMoY250KS5maWx0ZXIoKFssIGNdKSA9PiBjID49IDIpLm1hcCgoW3RdKSA9PiB0KTtcbiAgICBpZiAobGlzdC5sZW5ndGgpIHsgU01BUlQgPSBuZXcgU2V0KGxpc3QpOyBTLnNtYXJ0ID0gbGlzdDsgUy5zbWFydEF0ID0gRGF0ZS5ub3coKTsgbG9nKGDogbDmmI7pjKLljIXlkI3llq7mm7TmlrDvvJoke2xpc3QubGVuZ3RofSDlgItgKTsgfVxuICB9XG5cbiAgY29uc3QgSE9UID0gbmV3IE1hcCgpLCBob3RDaGVja2VkID0gbmV3IE1hcCgpO1xuXG4gIGZ1bmN0aW9uIGNvdW50SG90KHR4cykge1xuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7IGlmICghU01BUlQuc2l6ZSAmJiBTLnNtYXJ0Py5sZW5ndGgpIFNNQVJUID0gbmV3IFNldChTLnNtYXJ0KTtcbiAgICBmb3IgKGNvbnN0IHQgb2YgdHhzKSB7XG4gICAgICBjb25zdCByZWN2ID0gKHQuaW5wdXQgfHwgJzB4JykgPT09ICcweCcgJiYgQmlnSW50KHQudmFsdWUgfHwgJzB4MCcpID4gMG47IC8vIOebtOaOpei9iSBCTkIg5bCx6ZGE77yI5YOPIEJOQlPvvIlcbiAgICAgIGlmICghdC50byB8fCAodC5pbnB1dCB8fCAnJykubGVuZ3RoID4gMiArIDggKyA2NCAqIDQgfHwgQmlnSW50KHQudmFsdWUgfHwgJzB4MCcpID4gMm4gKiAxMG4gKiogMTduKSBjb250aW51ZTsgLy8g6ZGE6YCg5bi46KaB5LuYIEJOQu+8iFFVT0dFTlQgMC4wMDA144CB54Gv56y86ZWHIDAuMDEyNeKAkzAuMe+8ie+8jOKJpDAuMiBCTkIg55qE5ZG85Y+r6YO9566XXG4gICAgICBpZiAoL14weChhOTA1OWNiYnwwOTVlYTdiM3wyM2I4NzJkZHxkMGUzMGRiMHwyZTFhN2Q0ZHwzOTUwOTM1MXxhNDU3YzJkNykvLnRlc3QodC5pbnB1dCB8fCAnJykpIGNvbnRpbnVlOyAvLyDovYnluLPjgIHmjojmrIrjgIHlrZjlj5bpgJnpoZ7kuI3mmK/pkYTpgKAgLy8g5Y+q55yL55+t5ZG85Y+r44CB4omkMC4wMDEgQk5CIOeahO+8iOmRhOmAoOeahOaoo+WtkO+8iVxuICAgICAgY29uc3QgayA9IHQudG8udG9Mb3dlckNhc2UoKTsgbGV0IGggPSBIT1QuZ2V0KGspOyBpZiAoIWgpIHsgaCA9IHsgZnJvbTogbmV3IFNldCgpLCBhdDogbm93LCBzZWw6IG5ldyBNYXAoKSB9OyBIT1Quc2V0KGssIGgpOyB9XG4gICAgICBpZiAobm93IC0gaC5hdCA+IDE4MGUzKSB7IGguZnJvbS5jbGVhcigpOyBoLmF0ID0gbm93OyBoLnNlbC5jbGVhcigpOyBoLnNtYXJ0ID0gbmV3IFNldCgpOyBoLnZhbHMgPSBuZXcgTWFwKCk7IH1cbiAgICAgIGlmIChTTUFSVC5oYXModC5mcm9tLnRvTG93ZXJDYXNlKCkpKSAoaC5zbWFydCA9IGguc21hcnQgfHwgbmV3IFNldCgpKS5hZGQodC5mcm9tLnRvTG93ZXJDYXNlKCkpO1xuICAgICAgaC5mcm9tLmFkZCh0LmZyb20udG9Mb3dlckNhc2UoKSk7IGNvbnN0IHNsID0gKHQuaW5wdXQgfHwgJycpLnNsaWNlKDAsIDEwKTsgaC5zZWwuc2V0KHNsLCAoaC5zZWwuZ2V0KHNsKSB8fCAwKSArIDEpOyBpZiAocmVjdikgeyBoLnZhbHMgPSBoLnZhbHMgfHwgbmV3IE1hcCgpOyBjb25zdCB2diA9IEJpZ0ludCh0LnZhbHVlKS50b1N0cmluZygpOyBoLnZhbHMuc2V0KHZ2LCAoaC52YWxzLmdldCh2dikgfHwgMCkgKyAxKTsgfVxuICAgIH1cbiAgICBpZiAoSE9ULnNpemUgPiAyMDAwMCkgZm9yIChjb25zdCBbaywgaF0gb2YgSE9UKSBpZiAobm93IC0gaC5hdCA+IDE4MGUzKSBIT1QuZGVsZXRlKGspO1xuICB9XG5cbiAgY29uc3QgTUlOVFMgPSBuZXcgTWFwKCksIG1pbnRDaGVja2VkID0gbmV3IE1hcCgpO1xuXG4gIGNvbnN0IFpFUk8zMiA9ICcweCcgKyAnMCcucmVwZWF0KDY0KTtcblxuICBhc3luYyBmdW5jdGlvbiBtaW50TG9ncyhmcm9tLCB0bykge1xuICAgIC8vIDEpIGRycGMg5pSv5o+05LiN5bi25Zyw5Z2A55qEIGdldExvZ3PvvIjmnIDnnIHmtYHph4/vvIlcbiAgICB0cnkgeyBjb25zdCByID0gYXdhaXQgKGF3YWl0IGZldGNoSW1wbCgnaHR0cHM6Ly9ic2MuZHJwYy5vcmcnLCB7IG1ldGhvZDogJ1BPU1QnLCBoZWFkZXJzOiB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBqc29ucnBjOiAnMi4wJywgaWQ6IDEsIG1ldGhvZDogJ2V0aF9nZXRMb2dzJywgcGFyYW1zOiBbeyBmcm9tQmxvY2s6ICcweCcgKyBmcm9tLnRvU3RyaW5nKDE2KSwgdG9CbG9jazogJzB4JyArIHRvLnRvU3RyaW5nKDE2KSwgdG9waWNzOiBbVF9UUkFOU0ZFUiwgWkVSTzMyXSB9XSB9KSwgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDEwMDAwKSB9KSkuanNvbigpOyBpZiAoQXJyYXkuaXNBcnJheShyLnJlc3VsdCkpIHJldHVybiByLnJlc3VsdDsgfSBjYXRjaCB7fVxuICAgIC8vIDIpIOmAgOiAjOaxguWFtuasoe+8muaKk+aVtOWAi+WNgOWhiueahOaUtuaTmuiHquW3semBjua/vlxuICAgIGNvbnN0IG91dCA9IFtdLCBub2RlcyA9IFsnaHR0cHM6Ly9ic2MtZGF0YXNlZWQuYm5iY2hhaW4ub3JnJywgJ2h0dHBzOi8vYnNjLWRhdGFzZWVkMS5kZWZpYml0LmlvJywgJ2h0dHBzOi8vYnNjLWRhdGFzZWVkMS5uaW5pY29pbi5pbycsICdodHRwczovL2JzYy1ycGMucHVibGljbm9kZS5jb20nXTtcbiAgICBhd2FpdCBQcm9taXNlLmFsbChBcnJheS5mcm9tKHsgbGVuZ3RoOiB0byAtIGZyb20gKyAxIH0sIChfLCBpKSA9PiBmcm9tICsgaSkubWFwKGFzeW5jIChiLCBpKSA9PiB7XG4gICAgICBmb3IgKGxldCBrID0gMDsgayA8IG5vZGVzLmxlbmd0aDsgaysrKSB7IHRyeSB7IGNvbnN0IHIgPSBhd2FpdCAoYXdhaXQgZmV0Y2hJbXBsKG5vZGVzWyhpICsgaykgJSBub2Rlcy5sZW5ndGhdLCB7IG1ldGhvZDogJ1BPU1QnLCBoZWFkZXJzOiB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBqc29ucnBjOiAnMi4wJywgaWQ6IDEsIG1ldGhvZDogJ2V0aF9nZXRCbG9ja1JlY2VpcHRzJywgcGFyYW1zOiBbJzB4JyArIGIudG9TdHJpbmcoMTYpXSB9KSwgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDEyMDAwKSB9KSkuanNvbigpOyBpZiAoQXJyYXkuaXNBcnJheShyLnJlc3VsdCkpIHsgZm9yIChjb25zdCByYyBvZiByLnJlc3VsdCkgZm9yIChjb25zdCBsIG9mIHJjLmxvZ3MgfHwgW10pIGlmIChsLnRvcGljcz8uWzBdID09PSBUX1RSQU5TRkVSICYmIGwudG9waWNzWzFdID09PSBaRVJPMzIgJiYgbC50b3BpY3NbMl0pIG91dC5wdXNoKGwpOyByZXR1cm47IH0gfSBjYXRjaCB7fSB9XG4gICAgfSkpO1xuICAgIHJldHVybiBvdXQ7XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBtaW50U2NhbihoZWFkKSB7XG4gICAgaWYgKCFTLm1pbnRCbG9jayB8fCBoZWFkIC0gUy5taW50QmxvY2sgPiAzMDApIFMubWludEJsb2NrID0gaGVhZCAtIDU7XG4gICAgY29uc3QgdG8gPSBNYXRoLm1pbihoZWFkLCBTLm1pbnRCbG9jayArIDYwKTsgaWYgKHRvIDw9IFMubWludEJsb2NrKSByZXR1cm47XG4gICAgY29uc3QgbG9ncyA9IGF3YWl0IG1pbnRMb2dzKFMubWludEJsb2NrICsgMSwgdG8pOyBTLm1pbnRCbG9jayA9IHRvO1xuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgZm9yIChjb25zdCBsIG9mIGxvZ3MpIHtcbiAgICAgIGNvbnN0IGEgPSBsLmFkZHJlc3MudG9Mb3dlckNhc2UoKTsgbGV0IG0gPSBNSU5UUy5nZXQoYSk7IGlmICghbSkgeyBtID0geyBhdDogbm93LCB0bzogbmV3IFNldCgpLCB0eHM6IFtdIH07IE1JTlRTLnNldChhLCBtKTsgfVxuICAgICAgaWYgKG5vdyAtIG0uYXQgPiAxODAwZTMpIHsgbS5hdCA9IG5vdzsgbS50by5jbGVhcigpOyBtLnR4cyA9IFtdOyB9IC8vIDMwIOWIhumQmOWFp+e0r+ioiO+8iOaFoueGseeahOmgheebruS5n+aKk+W+l+WIsO+8iVxuICAgICAgbS50by5hZGQoJzB4JyArIGwudG9waWNzWzJdLnNsaWNlKDI2KSk7IGlmIChtLnR4cy5sZW5ndGggPCA4KSBtLnR4cy5wdXNoKGwudHJhbnNhY3Rpb25IYXNoKTtcbiAgICB9XG4gICAgaWYgKE1JTlRTLnNpemUgPiAzMDAwMCkgZm9yIChjb25zdCBbaywgbV0gb2YgTUlOVFMpIGlmIChub3cgLSBtLmF0ID4gMTgwMGUzKSBNSU5UUy5kZWxldGUoayk7XG4gICAgZm9yIChjb25zdCBbYSwgbV0gb2YgTUlOVFMpIHtcbiAgICAgIGlmIChtLnRvLnNpemUgPCA2IHx8IChtaW50Q2hlY2tlZC5oYXMoYSkgJiYgbS50by5zaXplIDwgbWludENoZWNrZWQuZ2V0KGEpICogMikgfHwgUy5zZWVuTWludHNbYV0pIGNvbnRpbnVlOyAvLyDmspLpgY7nmoTvvIznrYnkurrmlbjnv7vlgI3lho3nnIvkuIDmrKEgLy8gNiDlgIvkuI3lkIzpjKLljIXooqvpkYTliLDlsLHmqqLmn6XvvIhRVU9HRU5UIOmWi+aJk+mgrSAxNSDliIbpkJjlj6rmnInljYHlub7lgIvpjKLljIXvvIlcbiAgICAgIG1pbnRDaGVja2VkLnNldChhLCBtLnRvLnNpemUpOyBpZiAobWludENoZWNrZWQuc2l6ZSA+IDIwMDAwKSBtaW50Q2hlY2tlZC5kZWxldGUobWludENoZWNrZWQua2V5cygpLm5leHQoKS52YWx1ZSk7XG4gICAgICBhd2FpdCBjaGVja01pbnRlZChhLCBtKS5jYXRjaCgoZSkgPT4gbG9nKCdtaW50U2NhbiAnICsgYSArICcgJyArIGUubWVzc2FnZSkpO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IENMQUlNID0gbmV3IFNldCgpO1xuXG4gIGFzeW5jIGZ1bmN0aW9uIGNoZWNrTWludGVkKHRvaywgbSkge1xuICAgIC8vIOaJvuWHuuWkp+WutuWvpumam+WRvOWPq+eahOWQiOe0hO+8iOmRhOmAoOWQiOe0hOWPr+iDvei3n+S7o+W5o+WQiOe0hOS4jeWQjO+8iVxuICAgIGNvbnN0IHR4cyA9IChhd2FpdCBQcm9taXNlLmFsbChtLnR4cy5zbGljZSgwLCA2KS5tYXAoKGgpID0+IHJwYygnZXRoX2dldFRyYW5zYWN0aW9uQnlIYXNoJywgW2hdKS5jYXRjaCgoKSA9PiBudWxsKSkpKS5maWx0ZXIoQm9vbGVhbik7XG4gICAgY29uc3QgY250ID0ge307IGZvciAoY29uc3QgdCBvZiB0eHMpIGlmICh0LnRvKSBjbnRbdC50by50b0xvd2VyQ2FzZSgpXSA9IChjbnRbdC50by50b0xvd2VyQ2FzZSgpXSB8fCAwKSArIDE7XG4gICAgY29uc3QgdGFyZ2V0ID0gT2JqZWN0LmVudHJpZXMoY250KS5zb3J0KCh4LCB5KSA9PiB5WzFdIC0geFsxXSlbMF0/LlswXTsgaWYgKCF0YXJnZXQpIHJldHVybjtcbiAgICBpZiAoUy5zZWVuTWludHNbdGFyZ2V0XSB8fCBTLnNlZW5NaW50c1t0b2tdIHx8IENMQUlNLmhhcyh0YXJnZXQpKSByZXR1cm47IENMQUlNLmFkZCh0YXJnZXQpOyAvLyDlr6nmn6Xkv67mraPvvJrlkIzkuIDlgIvlkIjntITlj6rorpPkuIDlgIvmtYHnqIvomZXnkIbvvIzpgb/lhY3ph43opIfmiZNcbiAgICAvLyDmmK/kuI3mmK8gQWdlbnQgSUQg5bCI5bGs77ya5ZCI57SE56K85pyJ55m76KiY5ZCI57SE77yM5oiW6ZGE5Yiw55qE6Yyi5YyF5YWt5oiQ5Lul5LiK5pyJIC5haSDouqvku71cbiAgICBsZXQgY29kZSA9ICgoYXdhaXQgcnBjKCdldGhfZ2V0Q29kZScsIFt0YXJnZXQsICdsYXRlc3QnXSkuY2F0Y2goKCkgPT4gJycpKSB8fCAnJykudG9Mb3dlckNhc2UoKTtcbiAgICBjb2RlID0gYXdhaXQgZnVsbENvZGUodGFyZ2V0LCBjb2RlKTtcbiAgICBjb25zdCB0Y29kZSA9IHRvayA9PT0gdGFyZ2V0ID8gY29kZSA6ICgoYXdhaXQgcnBjKCdldGhfZ2V0Q29kZScsIFt0b2ssICdsYXRlc3QnXSkuY2F0Y2goKCkgPT4gJycpKSB8fCAnJykudG9Mb3dlckNhc2UoKTtcbiAgICBsZXQgZ2F0ZWQgPSBjb2RlLmluY2x1ZGVzKFJFR0lTVFJZKSB8fCB0Y29kZS5pbmNsdWRlcyhSRUdJU1RSWSksIHNoYXJlID0gMDtcbiAgICBpZiAoIWdhdGVkKSB7XG4gICAgICAvLyDmspLlr6sgQWdlbnQgSUQg5qqi5p+l55qE77ya5Y+q55yL5YWp5aSp5YWn5paw6YOo572y55qE5ZCI57SE77yI5o6S6ZmkIExQ44CB6ICB5Luj5bmj6YCZ6aGe5q+P5aSp6YO95Zyo6ZGE55qE77yJXG4gICAgICBjb25zdCBoZWFkID0gcGFyc2VJbnQoYXdhaXQgcnBjKCdldGhfYmxvY2tOdW1iZXInLCBbXSksIDE2KTtcbiAgICAgIGNvbnN0IG9sZCA9IChhd2FpdCBycGMoJ2V0aF9nZXRDb2RlJywgW3RvaywgJzB4JyArIChoZWFkIC0gNDAwMDAwKS50b1N0cmluZygxNildKS5jYXRjaCgoKSA9PiAnMHgnKSkgfHwgJzB4JztcbiAgICAgIGlmIChvbGQubGVuZ3RoID4gMikgcmV0dXJuO1xuICAgICAgY29uc3Qgc2FtcGxlID0gWy4uLm0udG9dLnNsaWNlKDAsIDEyKTsgbGV0IG4gPSAwO1xuICAgICAgZm9yIChjb25zdCB4IG9mIHNhbXBsZSkgeyBjb25zdCByID0gYXdhaXQgY2FsbCgnMHgnICsgUkVHSVNUUlksICcweDcwYTA4MjMxJyArIHdhKHgpKTsgaWYgKHIgJiYgQmlnSW50KHIuc2xpY2UoMCwgNjYpKSA+IDBuKSBuKys7IH1cbiAgICAgIHNoYXJlID0gbiAvIHNhbXBsZS5sZW5ndGg7IGlmIChuIDwgNCB8fCBzaGFyZSA8IDAuNikgcmV0dXJuO1xuICAgICAgZ2F0ZWQgPSB0cnVlO1xuICAgIH1cbiAgICBpZiAoSU5GUkEuaGFzKHRhcmdldCkgfHwgSU5GUkEuaGFzKHRvaykpIHJldHVybjsgLy8gQWdlbnQgSUQg55m76KiY5ZCI57SE5pys6Lqr5LiN5piv6aCF55uuXG4gICAgUy5zZWVuTWludHNbdGFyZ2V0XSA9IHRzKCk7IFMuc2Vlbk1pbnRzW3Rva10gPSB0cygpO1xuICAgIGNvbnN0IG5hbWUgPSB0b2tTdHIoYXdhaXQgY2FsbCh0b2ssICcweDA2ZmRkZTAzJykpIHx8IHRva1N0cihhd2FpdCBjYWxsKHRhcmdldCwgJzB4MDZmZGRlMDMnKSk7XG4gICAgLy8g5YWI6Kmm5bi46KaL5YWN6LK75Ye95byP77yb5LiN6KGM5bCx44CM54Wn5Yil5Lq655qE5ZG85Y+r5YWn5a656YeN5pKt44CN77yI5LiN5ZCr5Yil5Lq65Zyw5Z2A55qE5omN6YeN5pKt77yJXG4gICAgbGV0IG1pbnRlZCA9ICcnO1xuICAgIGNvbnN0IHNhbXBsZVR4ID0gdHhzLmZpbmQoKHQpID0+IHQudG8gJiYgdC50by50b0xvd2VyQ2FzZSgpID09PSB0YXJnZXQpO1xuICAgIGZvciAoY29uc3QgVyBvZiBXQUxMRVRTKSB7XG4gICAgICBsZXQgZmYgPSBhd2FpdCBmaW5kRnJlZShXLmFkZHIsIHRhcmdldCwgY29kZSk7XG4gICAgICBpZiAoIWZmICYmIHNhbXBsZVR4ICYmIHNhbXBsZVR4LmlucHV0Lmxlbmd0aCA+PSAxMCAmJiAhYmFkU2VsKHNhbXBsZVR4LmlucHV0KSAmJiAhc2FtcGxlVHguaW5wdXQudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhzYW1wbGVUeC5mcm9tLnNsaWNlKDIpLnRvTG93ZXJDYXNlKCkpKSB7XG4gICAgICAgIGZvciAoY29uc3QgdiBvZiBORUFSX0ZSRUUpIHsgdHJ5IHsgYXdhaXQgcnBjKCdldGhfY2FsbCcsIFt7IGZyb206IFcuYWRkciwgdG86IHRhcmdldCwgZGF0YTogc2FtcGxlVHguaW5wdXQsIHZhbHVlOiAnMHgnICsgdi50b1N0cmluZygxNikgfSwgJ2xhdGVzdCddKTsgY29uc3Qgbm0gPSAn6YeN5pKtJyArIHNhbXBsZVR4LmlucHV0LnNsaWNlKDAsIDEwKSArICdAJyArIHRhcmdldC5zbGljZSgyLCAxMCk7IGlmICghQ0FORFMuc29tZSgoYykgPT4gY1swXSA9PT0gbm0pKSBDQU5EUy5wdXNoKFtubSwgc2FtcGxlVHguaW5wdXRdKTsgZmYgPSB7IG46IG5tLCB2IH07IGJyZWFrOyB9IGNhdGNoIHt9IH1cbiAgICAgIH1cbiAgICAgIGlmIChmZikgbWludGVkICs9IGBbJHtXLm5hbWV9XSBgICsgcXVldWVNaW50KHRhcmdldCwgZmYubiwgVywgZmYudikgKyAnXFxuJztcbiAgICB9XG4gICAgaWYgKCFtaW50ZWQpIHtcbiAgICAgIFMucGFpZCA9IFMucGFpZCB8fCB7fTtcbiAgICAgIGNvbnN0IHZhbCA9IHNhbXBsZVR4ID8gQmlnSW50KHNhbXBsZVR4LnZhbHVlIHx8ICcweDAnKSA6IDBuO1xuICAgICAgY29uc3Qgbm9BZGRyID0gc2FtcGxlVHggJiYgIXNhbXBsZVR4LmlucHV0LnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoc2FtcGxlVHguZnJvbS5zbGljZSgyKS50b0xvd2VyQ2FzZSgpKTtcbiAgICAgIFMucGFpZFt0YXJnZXRdID0geyBhdDogRGF0ZS5ub3coKSwgbmFtZSwgZG9uZToge30sIHdhbGxldHM6IG0udG8uc2l6ZSwgLi4uKChzYW1wbGVUeD8uaW5wdXQgfHwgJzB4JykgPT09ICcweCcgJiYgdmFsID4gMG4gPyB7IHJlY3ZWYWx1ZTogdmFsLnRvU3RyaW5nKCksIHJlY3ZTZWVuOiBtLnRvLnNpemUgfSA6IHt9KSwgLi4uKG5vQWRkciAmJiBzYW1wbGVUeC5pbnB1dCAhPT0gJzB4JyAmJiAhYmFkU2VsKHNhbXBsZVR4LmlucHV0KSA/IHsgcmVwbGF5OiB7IGRhdGE6IHNhbXBsZVR4LmlucHV0LCB2YWx1ZTogdmFsLnRvU3RyaW5nKCkgfSB9IDoge30pIH07XG4gICAgfVxuICAgIGF3YWl0IHRnKGDwn5SlIOeZvOePvuato+WcqOiiq+mRhOmAoOeahCBBZ2VudCBJRCDpoIXnm64ke25hbWUgPyAn77yaJyArIG5hbWUgOiAnJ33vvIgzIOWIhumQmOWFp+mRhOe1piAke20udG8uc2l6ZX0g5YCL6Yyi5YyFJHtzaGFyZSA/IGDvvIwke01hdGgucm91bmQoc2hhcmUgKiAxMDApfSUg5pyJIC5haSDouqvku71gIDogJyd977yJXFxuJHt0YXJnZXR9XFxuJHttaW50ZWQgfHwgJ+KaqiDkuI3mmK/lhY3osrvnmoQg4oaSIOW3suWKoOWFpei/vei5pO+8mumAsuW6pui2hemBjiA4MCUg5LiUIDE1MCDlgIvku6XkuIogQWdlbnQgSUQg6Yyi5YyF5Zyo5omT77yI6K6A5LiN5Yiw6YCy5bqm5Lmf6KaBIDE1MCDlgIvku6XkuIrvvInkuJTmr4/lgIvpjKLljIUg4omkMS4yVSDmnIPoh6rli5XmiZMnfWApO1xuICB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gaG90U2NhbigpIHtcbiAgICBmb3IgKGNvbnN0IFtjLCBoXSBvZiBIT1QpIHtcbiAgICAgIGlmIChJTkZSQS5oYXMoYykgfHwgQ0xBSU0uaGFzKGMpKSBjb250aW51ZTtcbiAgICAgIGlmICgoaC5mcm9tLnNpemUgPCAxMiAmJiAoaC5zbWFydD8uc2l6ZSB8fCAwKSA8IDIpIHx8IFMuc2Vlbk1pbnRzW2NdIHx8IGhvdENoZWNrZWQuaGFzKGMpKSBjb250aW51ZTtcbiAgICAgIENMQUlNLmFkZChjKTsgaG90Q2hlY2tlZC5zZXQoYywgRGF0ZS5ub3coKSk7IGlmIChob3RDaGVja2VkLnNpemUgPiA1MDAwKSBob3RDaGVja2VkLmRlbGV0ZShob3RDaGVja2VkLmtleXMoKS5uZXh0KCkudmFsdWUpO1xuICAgICAgbGV0IGNvZGUgPSAoKGF3YWl0IHJwYygnZXRoX2dldENvZGUnLCBbYywgJ2xhdGVzdCddKS5jYXRjaCgoKSA9PiAnJykpIHx8ICcnKS50b0xvd2VyQ2FzZSgpO1xuICAgICAgY29kZSA9IGF3YWl0IGZ1bGxDb2RlKGMsIGNvZGUpO1xuICAgICAgbGV0IHZpYUFnZW50cyA9IDA7XG4gICAgICBpZiAoIWNvZGUuaW5jbHVkZXMoUkVHSVNUUlkpKSB7XG4gICAgICAgIC8vIOWQiOe0hOeivOijoeaykuaciSBBZ2VudCBJRCDnmbvoqJjlkIjntITvvIjlj6/og73nlKjlvoznq6/nsL3lkI3pqZforYnvvIzlg4/nga/nrLzplYfjgIFTaWxpY29uIERyZWFtZXJz77yJ4oaSIOaUueeci+OAjOaJk+Wug+eahOS6uuaYr+S4jeaYr+Wkp+WkmuaMgeaciSBBZ2VudCBJROOAjVxuICAgICAgICBpZiAoY29kZS5sZW5ndGggPCA0KSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgaGVhZCA9IHBhcnNlSW50KGF3YWl0IHJwYygnZXRoX2Jsb2NrTnVtYmVyJywgW10pLCAxNik7XG4gICAgICAgIGNvbnN0IG9sZCA9IChhd2FpdCBycGMoJ2V0aF9nZXRDb2RlJywgW2MsICcweCcgKyAoaGVhZCAtIDQwMDAwMCkudG9TdHJpbmcoMTYpXSkuY2F0Y2goKCkgPT4gJzB4JykpIHx8ICcweCc7XG4gICAgICAgIGlmIChvbGQubGVuZ3RoID4gMikgY29udGludWU7IC8vIOWFqeWkqeWJjeWwseWtmOWcqOeahOiAgeWQiOe0hOS4jeeul+aWsOmgheebrlxuICAgICAgICBjb25zdCBzYW1wbGUgPSBbLi4uaC5mcm9tXS5zbGljZSgwLCAxNik7IGxldCBuID0gMDtcbiAgICAgICAgZm9yIChjb25zdCBhIG9mIHNhbXBsZSkgeyBjb25zdCByID0gYXdhaXQgY2FsbCgnMHgnICsgUkVHSVNUUlksICcweDcwYTA4MjMxJyArIHdhKGEpKTsgaWYgKHIgJiYgQmlnSW50KHIuc2xpY2UoMCwgNjYpKSA+IDBuKSBuKys7IH1cbiAgICAgICAgaWYgKG4gPCA4IHx8IG4gLyBzYW1wbGUubGVuZ3RoIDwgMC42KSBjb250aW51ZTtcbiAgICAgICAgdmlhQWdlbnRzID0gbiAvIHNhbXBsZS5sZW5ndGg7XG4gICAgICB9XG4gICAgICBTLnNlZW5NaW50c1tjXSA9IHRzKCk7XG4gICAgICBjb25zdCBuYW1lID0gdG9rU3RyKGF3YWl0IGNhbGwoYywgJzB4MDZmZGRlMDMnKSk7XG4gICAgICAvLyDnhrHploDlkbzlj6vnmoTlh73lvI/kuZ/liqDlhaXlgJnpgbjvvIjkuI3lnKggQ0FORFMg6KOh55qE6ZGE6YCg5Ye95byP5ZCN77yJXG4gICAgICBjb25zdCB0b3BTZWwgPSBbLi4uaC5zZWwuZW50cmllcygpXS5zb3J0KChhLCBiKSA9PiBiWzFdIC0gYVsxXSlbMF0/LlswXTtcbiAgICAgIGxldCBtaW50ZWQgPSAnJztcbiAgICAgIGZvciAoY29uc3QgVyBvZiBXQUxMRVRTKSB7XG4gICAgICAgIGxldCBmZiA9IGF3YWl0IGZpbmRGcmVlKFcuYWRkciwgYywgY29kZSk7XG4gICAgICAgIGlmICghZmYgJiYgdG9wU2VsICYmIHRvcFNlbC5sZW5ndGggPT09IDEwICYmICFiYWRTZWwodG9wU2VsKSkgZm9yIChjb25zdCB2IG9mIE5FQVJfRlJFRSkgeyB0cnkgeyBhd2FpdCBycGMoJ2V0aF9jYWxsJywgW3sgZnJvbTogVy5hZGRyLCB0bzogYywgZGF0YTogdG9wU2VsLCB2YWx1ZTogJzB4JyArIHYudG9TdHJpbmcoMTYpIH0sICdsYXRlc3QnXSk7IHsgY29uc3Qgbm0gPSAn54ax6ZaA5Ye95byPJyArIHRvcFNlbCArICdAJyArIGMuc2xpY2UoMiwgMTApOyBpZiAoIUNBTkRTLnNvbWUoKHgpID0+IHhbMF0gPT09IG5tKSkgQ0FORFMucHVzaChbbm0sIHRvcFNlbF0pOyBmZiA9IHsgbjogbm0sIHYgfTsgfSBicmVhazsgfSBjYXRjaCB7fSB9XG4gICAgICAgIGlmIChmZikgbWludGVkICs9IGBbJHtXLm5hbWV9XSBgICsgcXVldWVNaW50KGMsIGZmLm4sIFcsIGZmLnYpICsgJ1xcbic7XG4gICAgICB9XG4gICAgICBpZiAoIW1pbnRlZCkge1xuICAgICAgICBTLnBhaWQgPSBTLnBhaWQgfHwge307XG4gICAgICAgIC8vIOi9iSBCTkIg5bCx6ZGE55qE77ya5Y+W5aSn5a625pyA5bi46L2J55qE6YeR6aGN55W244CM5LiA5Lu955qE5YO55qC844CN77yI6Iez5bCRIDEwIOethuS4gOaoo+aJjeeul+aVuO+8iVxuICAgICAgICBjb25zdCB0b3AgPSBbLi4uKGgudmFscyB8fCBuZXcgTWFwKCkpLmVudHJpZXMoKV0uc29ydCgoYSwgYikgPT4gYlsxXSAtIGFbMV0pWzBdO1xuICAgICAgICBTLnBhaWRbY10gPSB7IGF0OiBEYXRlLm5vdygpLCBuYW1lLCBkb25lOiB7fSwgd2FsbGV0czogaC5mcm9tLnNpemUsIC4uLih0b3AgJiYgdG9wWzFdID49IDIgPyB7IHJlY3ZWYWx1ZTogdG9wWzBdLCByZWN2U2VlbjogdG9wWzFdIH0gOiB7fSkgfTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHRnKGDwn5SlIOeZvOePvuato+WcqOiiq+aQtuaJk+eahCBBZ2VudCBJRCDpoIXnm64ke25hbWUgPyAn77yaJyArIG5hbWUgOiAnJ30ke3ZpYUFnZW50cyA/IGDvvIjlkIjntITmspLlr6sgQWdlbnQgSUQg5qqi5p+l77yM5L2G5omT5a6D55qE6Yyi5YyFICR7TWF0aC5yb3VuZCh2aWFBZ2VudHMgKiAxMDApfSUg5oyB5pyJIC5haSDouqvku73vvIzlj6/og73mmK/lvoznq6/nsL3lkI3pqZforYnvvIlgIDogJyd977yIMyDliIbpkJjlhacgJHtoLmZyb20uc2l6ZX0g5YCL6Yyi5YyFJHtoLnNtYXJ0Py5zaXplID8gJ++8jOWFtuS4reiBsOaYjumMouWMhSAnICsgaC5zbWFydC5zaXplICsgJyDlgIsnIDogJyd977yJXFxuJHtjfVxcbiR7bWludGVkIHx8ICfimqog5LiN5piv5YWN6LK755qEIOKGkiDlt7LliqDlhaXov73ouaTvvJrpgLLluqbotoXpgY4gODAlIOS4lCAxNTAg5YCL5Lul5LiKIEFnZW50IElEIOmMouWMheWcqOaJk++8iOiugOS4jeWIsOmAsuW6puS5n+imgSAxNTAg5YCL5Lul5LiK77yJ5LiU5q+P5YCL6Yyi5YyFIOKJpDEuMlUg5pyD6Ieq5YuV5omTJ31cXG5odHRwczovL2JzY3NjYW4uY29tL2FkZHJlc3MvJHtjfWApO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IEJHID0gW107XG5cbiAgbGV0IGJnUnVuID0gMDtcblxuICBmdW5jdGlvbiBiZ0pvYihmbikgeyBpZiAoIWFjdGl2aXR5LnN0b3BwaW5nKSB7IEJHLnB1c2goZm4pOyBwdW1wQkcoKTsgfSB9XG5cbiAgZnVuY3Rpb24gcHVtcEJHKCkgeyB3aGlsZSAoIWFjdGl2aXR5LnN0b3BwaW5nICYmIGJnUnVuIDwgMyAmJiBCRy5sZW5ndGgpIHsgY29uc3QgZiA9IEJHLnNoaWZ0KCk7IGJnUnVuKys7IGFjdGl2aXR5LnRyYWNrKGYoKS5jYXRjaCgoZSkgPT4gbG9nKCdiZyAnICsgZS5tZXNzYWdlKSkuZmluYWxseSgoKSA9PiB7IGJnUnVuLS07IHB1bXBCRygpOyB9KSk7IH0gfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIHNjYW5OZXcoaGVhZCkge1xuICAgIGlmICghUy5sYXN0QmxvY2spIFMubGFzdEJsb2NrID0gaGVhZCAtIDU7XG4gICAgaWYgKGhlYWQgLSBTLmxhc3RCbG9jayA+IDE1MDApIHsgbG9nKGDmjoPmj4/okL3lvozlpKrlpJrvvIgke2hlYWQgLSBTLmxhc3RCbG9ja30g5aGK77yJ77yM6Lez5Yiw5pyA5pawYCk7IFMubGFzdEJsb2NrID0gaGVhZCAtIDIwMDsgfVxuICAgIC8vIEJTQyDnj77lnKjntIQgMC40NSDnp5LkuIDlgIvljYDloYrvvIjmr4/liIbpkJggfjEzMCDloYrvvInvvIzku6XliY3kuIDmrKHlj6rmjoMgNDAg5aGK5pyD6LaK6JC96LaK5b6M77yI5pu+6JC95b6MIDIuNSDlsI/mmYLvvInihpIg5pS55oiQ5aSa56+A6bue5Lim6KGM5oqTXG4gICAgY29uc3QgdG8gPSBNYXRoLm1pbihoZWFkLCBTLmxhc3RCbG9jayArIDQwMCk7XG4gICAgY29uc3QgbnVtcyA9IFtdOyBmb3IgKGxldCBiID0gUy5sYXN0QmxvY2sgKyAxOyBiIDw9IHRvOyBiKyspIG51bXMucHVzaChiKTtcbiAgICBjb25zdCBibG9ja3MgPSBuZXcgTWFwKCk7IGxldCBpZHggPSAwO1xuICAgIGNvbnN0IGZldGNoQmxrID0gYXN5bmMgKGIpID0+IHsgZm9yIChsZXQgayA9IDA7IGsgPCBSUENTLmxlbmd0aDsgaysrKSB7IGNvbnN0IHUgPSBSUENTWyhiICsgaykgJSBSUENTLmxlbmd0aF07IHRyeSB7IGNvbnN0IHIgPSBhd2FpdCAoYXdhaXQgZmV0Y2hJbXBsKHUsIHsgbWV0aG9kOiAnUE9TVCcsIGhlYWRlcnM6IHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9LCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGpzb25ycGM6ICcyLjAnLCBpZDogMSwgbWV0aG9kOiAnZXRoX2dldEJsb2NrQnlOdW1iZXInLCBwYXJhbXM6IFsnMHgnICsgYi50b1N0cmluZygxNiksIHRydWVdIH0pLCBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoMTUwMDApIH0pKS5qc29uKCk7IGlmIChyLnJlc3VsdCkgcmV0dXJuIHIucmVzdWx0OyB9IGNhdGNoIHt9IH0gcmV0dXJuIG51bGw7IH07XG4gICAgYXdhaXQgUHJvbWlzZS5hbGwoQXJyYXkuZnJvbSh7IGxlbmd0aDogMjQgfSwgYXN5bmMgKCkgPT4geyB3aGlsZSAoaWR4IDwgbnVtcy5sZW5ndGgpIHsgY29uc3QgYiA9IG51bXNbaWR4KytdOyBjb25zdCBibGsgPSBhd2FpdCBmZXRjaEJsayhiKTsgaWYgKGJsaykgeyBjb3VudEhvdChibGsudHJhbnNhY3Rpb25zKTsgfSBpZiAoYmxrKSBibG9ja3Muc2V0KGIsIGJsay50cmFuc2FjdGlvbnMuZmlsdGVyKCh0KSA9PiAhdC50byB8fCAoKHQuaW5wdXQgfHwgJycpLmxlbmd0aCA+IDIwMDAgJiYgKCh0LmlucHV0IHx8ICcnKS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFJFR0lTVFJZKSB8fCBERVBMT1lFUlMuaW5jbHVkZXModC50by50b0xvd2VyQ2FzZSgpKSkpKSk7IGVsc2UgYmxvY2tzLnNldChiLCBudWxsKTsgfSB9KSk7XG4gICAgbGV0IGRvbmUgPSBTLmxhc3RCbG9jaztcbiAgICBmb3IgKGNvbnN0IGIgb2YgbnVtcykgeyBpZiAoYmxvY2tzLmdldChiKSA9PSBudWxsKSBicmVhazsgZG9uZSA9IGI7IH1cbiAgICBpZiAoZG9uZSA9PT0gUy5sYXN0QmxvY2sgJiYgbnVtcy5sZW5ndGgpIHsgbG9nKCdzY2FuIOaKk+WNgOWhiuWkseaVlyAnICsgbnVtc1swXSk7IHJldHVybjsgfVxuICAgIFMuc2NhbkxhZyA9IGhlYWQgLSBkb25lO1xuICAgIGZvciAobGV0IGIgPSBTLmxhc3RCbG9jayArIDE7IGIgPD0gZG9uZTsgYisrKSB7XG4gICAgICBmb3IgKGNvbnN0IHR4IG9mIGJsb2Nrcy5nZXQoYikgfHwgW10pIHtcbiAgICAgICAgLy8g5paw5ZCI57SE5pyJ5LiJ56iu5Ye655Sf5pa55byP77ya4pGg55u05o6l6YOo572yIOKRoemAj+mBjiBDUkVBVEUyIOmDqOe9suWZqO+8iOeBr+esvOmVh+WwseaYr+mAmeeoru+8ieKRoueUseWIpeeahOW3peW7oOWQiOe0hOW7uueri1xuICAgICAgICBjb25zdCBpbnAgPSAodHguaW5wdXQgfHwgJycpLnRvTG93ZXJDYXNlKCk7XG4gICAgICAgIGlmICh0eC50byAmJiAhKGlucC5sZW5ndGggPiAyMDAwICYmIChpbnAuaW5jbHVkZXMoUkVHSVNUUlkpIHx8IERFUExPWUVSUy5pbmNsdWRlcyh0eC50by50b0xvd2VyQ2FzZSgpKSkpKSBjb250aW51ZTtcbiAgICAgICAgbGV0IGNzID0gW107XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgaWYgKCF0eC50bykgeyBjb25zdCByYyA9IGF3YWl0IHJwYygnZXRoX2dldFRyYW5zYWN0aW9uUmVjZWlwdCcsIFt0eC5oYXNoXSk7IGlmIChyYz8uY29udHJhY3RBZGRyZXNzKSBjcyA9IFtyYy5jb250cmFjdEFkZHJlc3MudG9Mb3dlckNhc2UoKV07IH1cbiAgICAgICAgICBlbHNlIGlmICh0eC50by50b0xvd2VyQ2FzZSgpID09PSAnMHg0ZTU5YjQ0ODQ3YjM3OTU3ODU4ODkyMGNhNzhmYmYyNmMwYjQ5NTZjJykgeyBjb25zdCBzYWx0ID0gaW5wLnNsaWNlKDIsIDY2KSwgaW5pdCA9IGlucC5zbGljZSg2Nik7IGNzID0gWycweCcgKyBrZWNjYWtIZXgoJ2ZmJyArIHR4LnRvLnNsaWNlKDIpLnRvTG93ZXJDYXNlKCkgKyBzYWx0ICsga2VjY2FrSGV4KGluaXQpKS5zbGljZSgyNCldOyB9XG4gICAgICAgICAgZWxzZSB7IGNvbnN0IHJjID0gYXdhaXQgcnBjKCdldGhfZ2V0VHJhbnNhY3Rpb25SZWNlaXB0JywgW3R4Lmhhc2hdKTsgaWYgKHJjPy5zdGF0dXMgIT09ICcweDEnKSBjb250aW51ZTsgY29uc3QgYXMgPSBbLi4ubmV3IFNldCgocmMubG9ncyB8fCBbXSkubWFwKChsKSA9PiBsLmFkZHJlc3MudG9Mb3dlckNhc2UoKSkpXTsgZm9yIChjb25zdCBhIG9mIGFzKSB7IGNvbnN0IGJlZm9yZSA9IGF3YWl0IHJwYygnZXRoX2dldENvZGUnLCBbYSwgJzB4JyArIChiIC0gMSkudG9TdHJpbmcoMTYpXSkuY2F0Y2goKCkgPT4gJzB4Jyk7IGlmICghYmVmb3JlIHx8IGJlZm9yZSA9PT0gJzB4JykgY3MucHVzaChhKTsgfSB9XG4gICAgICAgIH0gY2F0Y2ggeyBjb250aW51ZTsgfVxuICAgICAgICBmb3IgKGNvbnN0IGMgb2YgY3MpIHRyeSB7XG4gICAgICAgICAgaWYgKFMuc2Vlbk1pbnRzW2NdKSBjb250aW51ZTtcbiAgICAgICAgICBsZXQgY29kZSA9IChhd2FpdCBycGMoJ2V0aF9nZXRDb2RlJywgW2MsICdsYXRlc3QnXSkpIHx8ICcnO1xuICAgICAgICAgIGNvZGUgPSBhd2FpdCBmdWxsQ29kZShjLCBjb2RlKTsgLyog5Luj55CG5ZCI57SE77yI5ZCE56iu5a+r5rOV77yJ6YO96L+95Yiw6IOM5b6M55yf5q2j55qE56iL5byPICovXG4gICAgICAgICAgaWYgKCFjb2RlLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoUkVHSVNUUlkpICYmICFjb2RlLmluY2x1ZGVzKCc5ZjkyZDBkZCcpKSBjb250aW51ZTtcbiAgICAgICAgICBTLnNlZW5NaW50c1tjXSA9IHRzKCk7IG5vdGVEZXBsb3koY29kZSk7IFMuZGVwbG95ZXIgPSBTLmRlcGxveWVyIHx8IHt9OyBTLmRlcGxveWVyW2NdID0gKHR4LmZyb20gfHwgJycpLnRvTG93ZXJDYXNlKCk7IFMuZGVwRnJvbSA9IFMuZGVwRnJvbSB8fCB7fTsgUy5kZXBGcm9tW2NdID0gUy5kZXBsb3llcltjXTsgbm90ZURldihTLmRlcGxveWVyW2NdLCBjKTtcbiAgICAgICAgICBiZ0pvYihhc3luYyAoKSA9PiB7XG4gICAgICAgICAgY29uc3Qgb2sgPSBbXTtcbiAgICAgICAgICB7IGNvbnN0IGZmID0gYXdhaXQgZmluZEZyZWUoTUUsIGMsIGNvZGUpOyBpZiAoZmYpIG9rLnB1c2goZmYubiArIChmZi52ID4gMG4gPyBg77yI5LuYICR7TnVtYmVyKGZmLnYpIC8gMWUxOH0gQk5CIOaJi+e6jOiyu++8iWAgOiAnJykpOyB9XG4gICAgICAgICAgY29uc3Qgc3RyID0gKHIpID0+IHsgdHJ5IHsgY29uc3QgaCA9IHIuc2xpY2UoMik7IGNvbnN0IGxlbiA9IE51bWJlcihCaWdJbnQoJzB4JyArIGguc2xpY2UoNjQsIDEyOCkpKTsgcmV0dXJuIEJ1ZmZlci5mcm9tKGguc2xpY2UoMTI4LCAxMjggKyBsZW4gKiAyKSwgJ2hleCcpLnRvU3RyaW5nKCd1dGY4Jyk7IH0gY2F0Y2ggeyByZXR1cm4gJyc7IH0gfTtcbiAgICAgICAgICBsZXQgbmFtZSA9IHN0cihhd2FpdCBjYWxsKGMsICcweDA2ZmRkZTAzJykpO1xuICAgICAgICAgIGlmICghbmFtZSkgZm9yIChjb25zdCBzZWwgb2YgWycweGZjMGM1NDZhJ10pIHsgY29uc3QgciA9IGF3YWl0IGNhbGwoYywgc2VsKTsgaWYgKHIgJiYgci5sZW5ndGggPj0gNjYgJiYgQmlnSW50KHIuc2xpY2UoMCwgNjYpKSA+IDBuKSB7IGNvbnN0IHRhID0gJzB4JyArIHIuc2xpY2UoMjYsIDY2KTsgY29uc3QgbjIgPSBzdHIoYXdhaXQgY2FsbCh0YSwgJzB4MDZmZGRlMDMnKSksIHMyID0gc3RyKGF3YWl0IGNhbGwodGEsICcweDk1ZDg5YjQxJykpOyBpZiAobjIpIHsgbmFtZSA9IGAke24yfSR7czIgPyAnICgkJyArIHMyICsgJyknIDogJyd9YDsgYnJlYWs7IH0gfSB9XG4gICAgICAgICAgY29uc3QgbGMgPSBjb2RlLnRvTG93ZXJDYXNlKCk7XG4gICAgICAgICAgY29uc3QgcGF5ID0gbGMuaW5jbHVkZXMoJzU1ZDM5ODMyNmY5OTA1OWZmNzc1NDg1MjQ2OTk5MDI3YjMxOTc5NTUnKSA/ICfopoHku5ggVVNEVCcgOiBsYy5pbmNsdWRlcygnOGFjNzZhNTFjYzk1MGQ5ODIyZDY4YjgzZmUxYWQ5N2IzMmNkNTgwZCcpID8gJ+imgeS7mCBVU0RDJyA6ICflj6/og73opoHku5ggQk5CJztcbiAgICAgICAgICBjb25zdCBmYWN0b3J5TGlrZSA9IFsnMjdjY2E1OWYnLCAnN2QzOGJiMGQnLCAnMTczN2E0YmQnXS5zb21lKCh4KSA9PiBjb2RlLmluY2x1ZGVzKHgpKSB8fCAvKDZjNjE3NTZlNjM2OHw2NjYxNjM3NDZmNzI3OSkvLnRlc3QoY29kZS50b0xvd2VyQ2FzZSgpKTtcbiAgICAgICAgICBpZiAoZmFjdG9yeUxpa2UpIGF3YWl0IHRnKGDwn4+XIOeZvOePvueWkeS8vOaWsOeahCBBZ2VudCBJRCDnmbzlsITlj7DvvI/lt6Xlu6DlkIjntIQke25hbWUgPyAn77yaJyArIG5hbWUgOiAnJ31cXG4ke2N9XFxu5Y+v6IO95piv5YOPIFRvc2hY44CBRmxhcCBBZ2VudCDpgJnnqK7lubPlj7DvvIzlj6/ku6Xoh6rlt7HliLAgQnNjU2NhbiDmn6XnnItgKTtcbiAgICAgICAgICBsZXQgbWludGVkID0gJyc7XG4gICAgICAgICAgZm9yIChjb25zdCBXIG9mIFdBTExFVFMpIHsgY29uc3QgZmYgPSBhd2FpdCBmaW5kRnJlZShXLmFkZHIsIGMsIGNvZGUpOyBjb25zdCBmID0gZmY/Lm47IGlmIChmKSBtaW50ZWQgKz0gYFske1cubmFtZX1dIGAgKyBxdWV1ZU1pbnQoYywgZiwgVywgZmYudikgKyAnXFxuJzsgfVxuICAgICAgICAgIGlmICghb2subGVuZ3RoKSB7IFMucGFpZCA9IFMucGFpZCB8fCB7fTsgUy5wYWlkW2NdID0geyBhdDogRGF0ZS5ub3coKSwgbmFtZSwgZG9uZToge30gfTsgfVxuICAgICAgICAgIGF3YWl0IHRnKGDwn4aVIOeZvOePvuaWsOeahCBBZ2VudCBJRCDlsIjlsazlkIjntIQke25hbWUgPyAn77yaJyArIG5hbWUgOiAnJ31cXG4ke2N9XFxuJHtvay5sZW5ndGggPyAn4pyFIOaooeaTrOWFjeiyu+WPr+mRhO+8micgKyBvay5qb2luKCfjgIEnKSArICdcXG4nICsgbWludGVkIDogYOKaqiDnj77lnKjkuI3mmK/lhY3osrvnmoTvvIgke3BheX3vvIzmiJbpgoTmspLplovvvInihpIg5bey5Yqg5YWl6L+96Lmk77yaXFxuwrcg5YWN6LK7IOKGkiDpgLLluqbotoXpgY4gODAlIOS4lCAxNTAg5YCL5Lul5LiKIEFnZW50IElEIOmMouWMheWcqOaJkyDihpIg6Ieq5YuV5omTXFxuwrcg6KaB5LuY5Lu75L2V5omL57qM6LK7IOKGkiDnlbbku5josrvvvJrlj6blpJbpgoTopoHlkIjntITmnInkv53mnKzmqZ/liLbvvIjmiJboroDkuI3liLDpgLLluqbkvYblvojlpJrkurrlnKjmiZPvvInkuJTmr4/lgIvpjKLljIUg4omkMS4yVSDihpIg6Ieq5YuV5omTYH1cXG5odHRwczovL2JzY3NjYW4uY29tL2FkZHJlc3MvJHtjfWApO1xuICAgICAgICAgIH0pOyAvLyDog4zmma/omZXnkIbmlrDlkIjntITvvIjmqKHmk6zjgIHpkYTpgKDjgIHpgJrnn6XvvInvvIzmjoPmj4/kuI3nlKjnrYlcbiAgICAgICAgfSBjYXRjaCB7fVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmICghc2NoZWR1bGVyLl9oc0J1c3kpIHsgc2NoZWR1bGVyLl9oc0J1c3kgPSB0cnVlOyBob3RTY2FuKCkuY2F0Y2goKGUpID0+IGxvZygnaG90U2NhbiAnICsgZS5tZXNzYWdlKSkuZmluYWxseSgoKSA9PiB7IHNjaGVkdWxlci5faHNCdXN5ID0gZmFsc2U7IH0pOyB9XG4gICAgaWYgKCFzY2hlZHVsZXIuX21zQnVzeSkgeyBzY2hlZHVsZXIuX21zQnVzeSA9IHRydWU7IG1pbnRTY2FuKGRvbmUpLmNhdGNoKChlKSA9PiBsb2coJ21pbnRTY2FuICcgKyBlLm1lc3NhZ2UpKS5maW5hbGx5KCgpID0+IHsgc2NoZWR1bGVyLl9tc0J1c3kgPSBmYWxzZTsgfSk7IH1cbiAgICB7IC8qIOS7o+eQhuWQiOe0hOaOg+aPj++8muiiq+mZkOa1geWwseaPm+evgOm7nu+8m+WFqOmDqOiiq+mZkOa1geWFiOaaq+WBnCAzMCDnp5LvvIzkuYvlvozlvp7mspLmjoPliLDnmoTljYDloYroo5zmjoPvvIzkuI3ot7PpgY4gKi9cbiAgICAgIFMucHJveHlGcm9tID0gUy5wcm94eUZyb20gfHwgUy5sYXN0QmxvY2sgKyAxOyBpZiAoZG9uZSAtIFMucHJveHlGcm9tID4gMzAwMCkgUy5wcm94eUZyb20gPSBkb25lIC0gMzAwMDtcbiAgICAgIGlmIChEYXRlLm5vdygpID4gKHNjaGVkdWxlci5fcHJveHlQYXVzZSB8fCAwKSkgeyBjb25zdCB0byA9IE1hdGgubWluKGRvbmUsIFMucHJveHlGcm9tICsgNTAwKTsgdHJ5IHsgYXdhaXQgcHJveHlTY2FuKFMucHJveHlGcm9tLCB0byk7IFMucHJveHlGcm9tID0gdG8gKyAxOyBzY2hlZHVsZXIuX3Byb3h5RmFpbHMgPSAwOyB9IGNhdGNoIChlKSB7IHNjaGVkdWxlci5fcHJveHlGYWlscyA9IChzY2hlZHVsZXIuX3Byb3h5RmFpbHMgfHwgMCkgKyAxOyBzY2hlZHVsZXIuX3Byb3h5UGF1c2UgPSBEYXRlLm5vdygpICsgMzBlMzsgaWYgKHNjaGVkdWxlci5fcHJveHlGYWlscyA9PT0gMSB8fCBzY2hlZHVsZXIuX3Byb3h5RmFpbHMgJSAyMCA9PT0gMCkgbG9nKGBwcm94eVNjYW4g5omA5pyJ56+A6bue6YO96KKr6ZmQ5rWB77yI56ysICR7c2NoZWR1bGVyLl9wcm94eUZhaWxzfSDmrKHvvInvvIzmmqvlgZwgMzAg56eS5b6M6KOc5o6D77yaJHtlLm1lc3NhZ2Uuc2xpY2UoMCwgODApfWApOyB9IH1cbiAgICB9XG4gICAgUy5sYXN0QmxvY2sgPSBkb25lO1xuICB9XG5cbiAgY29uc3QgVF9CRUFDT05fVVAgPSAnMHgxY2YzYjAzYTZjZjE5ZmEyYmFiYTRkZjE0OGU5ZGNhYmVkZWE3ZjhhNWMwNzg0MGUyMDdlNWMwODliZTk1ZDNlJztcblxuICBjb25zdCBUX1VQR1JBREVEID0gJzB4YmM3Y2Q3NWEyMGVlMjdmZDlhZGViYWIzMjA0MWY3NTUyMTRkYmM2YmZmYTkwY2MwMjI1YjM5ZGEyZTVjMmQzYic7XG5cbiAgY29uc3QgaW1wbENhY2hlID0gbmV3IE1hcCgpO1xuXG4gIGNvbnN0IFZBVUxUX0ZBQ1RPUklFUyA9IFsnMHg5MDQ5NzQ1MGYyYTcwNmYxOTUxYjViZGRhNTJiNGU1ZDE2ZjM0YzA2J107XG5cbiAgYXN5bmMgZnVuY3Rpb24gcHJveHlTY2FuKGZyb20sIHRvKSB7XG4gICAgaWYgKHRvIDwgZnJvbSkgcmV0dXJuO1xuICAgIC8vIOWFrOeUqOevgOm7nuS4jeWFgeioseS4jeW4tuWcsOWdgOeahCBnZXRMb2dz77yM5omA5Lul55uvIEZsYXAg6YeR5bqr5bel5bug77ya5a6D5q+P5bu65LiA5YCL5paw6YeR5bqr5bCx5pyJ5LqL5Lu277yM5YaN5b6e6YKj562G5Lqk5piT5pS25pOa5om+5paw5Luj55CG5ZCI57SEXG4gICAgY29uc3QgZmwgPSBhd2FpdCBsb2dzUnBjKFt7IGFkZHJlc3M6IFZBVUxUX0ZBQ1RPUklFUywgZnJvbUJsb2NrOiAnMHgnICsgZnJvbS50b1N0cmluZygxNiksIHRvQmxvY2s6ICcweCcgKyB0by50b1N0cmluZygxNikgfV0pO1xuICAgIGNvbnN0IHR4cyA9IFsuLi5uZXcgU2V0KChmbCB8fCBbXSkubWFwKChsKSA9PiBsLnRyYW5zYWN0aW9uSGFzaCkpXTtcbiAgICBjb25zdCBsb2dzID0gW107XG4gICAgZm9yIChjb25zdCBoIG9mIHR4cykgeyBjb25zdCByYyA9IGF3YWl0IHJwYygnZXRoX2dldFRyYW5zYWN0aW9uUmVjZWlwdCcsIFtoXSkuY2F0Y2goKCkgPT4gbnVsbCk7IGZvciAoY29uc3QgbCBvZiByYz8ubG9ncyB8fCBbXSkgaWYgKGwudG9waWNzWzBdID09PSBUX0JFQUNPTl9VUCB8fCBsLnRvcGljc1swXSA9PT0gVF9VUEdSQURFRCkgbG9ncy5wdXNoKGwpOyB9XG4gICAgZm9yIChjb25zdCBsIG9mIGxvZ3MpIHtcbiAgICAgIGNvbnN0IGMgPSBsLmFkZHJlc3MudG9Mb3dlckNhc2UoKTsgaWYgKFMuc2Vlbk1pbnRzW2NdKSBjb250aW51ZTtcbiAgICAgIGxldCBpbXBsID0gJzB4JyArIGwudG9waWNzWzFdLnNsaWNlKDI2KTtcbiAgICAgIGlmIChsLnRvcGljc1swXSA9PT0gVF9CRUFDT05fVVApIHsgY29uc3QgciA9IGF3YWl0IGNhbGwoaW1wbCwgJzB4NWM2MGRhMWInKTsgaWYgKCFyKSBjb250aW51ZTsgaW1wbCA9ICcweCcgKyByLnNsaWNlKC00MCk7IH1cbiAgICAgIGlmICghaW1wbENhY2hlLmhhcyhpbXBsKSkgeyBjb25zdCBjb2RlID0gKGF3YWl0IHJwYygnZXRoX2dldENvZGUnLCBbaW1wbCwgJ2xhdGVzdCddKS5jYXRjaCgoKSA9PiAnJykpIHx8ICcnOyBpbXBsQ2FjaGUuc2V0KGltcGwsIGNvZGUpOyBpZiAoaW1wbENhY2hlLnNpemUgPiA1MDApIGltcGxDYWNoZS5kZWxldGUoaW1wbENhY2hlLmtleXMoKS5uZXh0KCkudmFsdWUpOyB9XG4gICAgICBjb25zdCBjb2RlID0gaW1wbENhY2hlLmdldChpbXBsKTtcbiAgICAgIGlmICghY29kZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFJFR0lTVFJZKSAmJiAhY29kZS5pbmNsdWRlcygnOWY5MmQwZGQnKSkgY29udGludWU7XG4gICAgICBTLnNlZW5NaW50c1tjXSA9IHRzKCk7XG4gICAgICBsZXQgbWludGVkID0gJyc7XG4gICAgICBmb3IgKGNvbnN0IFcgb2YgV0FMTEVUUykgeyBjb25zdCBmZiA9IGF3YWl0IGZpbmRGcmVlKFcuYWRkciwgYywgY29kZSk7IGNvbnN0IGYgPSBmZj8ubjsgaWYgKGYpIG1pbnRlZCArPSBgWyR7Vy5uYW1lfV0gYCArIHF1ZXVlTWludChjLCBmLCBXLCBmZi52KSArICdcXG4nOyB9XG4gICAgICBhd2FpdCB0Zyhg8J+nqSDnmbznj77lt6Xlu6Dlu7rnq4vnmoQgQWdlbnQgSUQg5ZCI57SE77yI5Luj55CG5ZCI57SE77yM5YOPIEFJRFJPUCDpgqPnqK7vvIlcXG4ke2N9XFxuJHttaW50ZWQgfHwgJ+KaqiDnm67liY3mqKHmk6zkuI3og73lhY3osrvlj4PliqDvvIjlj6/og73opoHku5josrvmiJbpgoTmspLplovvvIknfWApO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGFnZW50Q2FjaGUgPSBuZXcgTWFwKCk7XG5cbiAgYXN5bmMgZnVuY3Rpb24gaGVhdE9mKGMsIFApIHsgLy8g566X54ax5bqm77ya5pyA6L+R57SEIDIuNSDlsI/mmYLmnInlub7lgIvkuI3lkIznmoQgQWdlbnQgSUQg6Yyi5YyF5Y+D6IiH6ZGE6YCg77yM5YW25Lit5pyA6L+RIDMg5YiG6ZCY5bm+5YCLXG4gICAgY29uc3QgaGVhZCA9IHBhcnNlSW50KGF3YWl0IHJwYygnZXRoX2Jsb2NrTnVtYmVyJywgW10pLCAxNik7IGxldCB0b2sgPSAnJzsgY29uc3QgdHIgPSBhd2FpdCBjYWxsKGMsICcweGZjMGM1NDZhJyk7IGlmICh0ciAmJiB0ci5sZW5ndGggPj0gNjYgJiYgQmlnSW50KHRyLnNsaWNlKDAsIDY2KSkgPiAwbikgdG9rID0gJzB4JyArIHRyLnNsaWNlKDI2LCA2NikudG9Mb3dlckNhc2UoKTtcbiAgICBjb25zdCBsYXN0ID0gbmV3IE1hcCgpOyBjb25zdCBza2lwID0gbmV3IFNldChbYywgdG9rLCAnMHgwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwJywgJzB4MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwZGVhZCddKTtcbiAgICBjb25zdCBzcGFuID0gUC5oZWF0QXQgPyA2MDAwIDogMjAwMDA7IC8vIOesrOS4gOasoeeci+e0hCAyLjUg5bCP5pmC77yM5LmL5b6M5Y+q55yL5pyA6L+R57SEIDQ1IOWIhumQmO+8iOe0r+ioiOaVuOWPluacgOWkp+WAvO+8iVxuICAgIGZvciAobGV0IGIgPSBoZWFkIC0gc3BhbjsgYiA8PSBoZWFkOyBiICs9IDEwMDAwKSB7XG4gICAgICBjb25zdCBxID0gW3sgYWRkcmVzczogdG9rID8gW2MsIHRva10gOiBjLCBmcm9tQmxvY2s6ICcweCcgKyBiLnRvU3RyaW5nKDE2KSwgdG9CbG9jazogJzB4JyArIE1hdGgubWluKGIgKyA5OTk5LCBoZWFkKS50b1N0cmluZygxNikgfV07IGNvbnN0IEwgPSBhd2FpdCBycGMoJ2V0aF9nZXRMb2dzJywgcSkuY2F0Y2goKCkgPT4gbG9nc1JwYyhxKS5jYXRjaCgoKSA9PiBbXSkpOyAvKiDpmaTpjK8gMTEvMe+8mumgkOioreevgOm7numZkOa1geaZguaUueeUqOWkmuevgOm7nu+8jOeGseW6pu+8iOWPg+iIh+S6uuaVuO+8ieaJjeeul+W+l+a6liAqL1xuICAgICAgZm9yIChjb25zdCBsIG9mIEwgfHwgW10pIGZvciAoY29uc3QgdCBvZiAobC50b3BpY3MgfHwgW10pLnNsaWNlKDEpKSB7IGlmICghL14weDB7MjR9WzAtOWEtZl17NDB9JC9pLnRlc3QodCkgfHwgdC5zbGljZSgyNiwgMzQpID09PSAnMDAwMDAwMDAnKSBjb250aW51ZTsgY29uc3QgYSA9ICgnMHgnICsgdC5zbGljZSgyNikpLnRvTG93ZXJDYXNlKCk7IGlmIChza2lwLmhhcyhhKSkgY29udGludWU7IGNvbnN0IGJuID0gcGFyc2VJbnQobC5ibG9ja051bWJlciwgMTYpOyBpZiAoIWxhc3QuaGFzKGEpIHx8IGxhc3QuZ2V0KGEpIDwgYm4pIGxhc3Quc2V0KGEsIGJuKTsgfVxuICAgIH1cbiAgICBjb25zdCB1bmtub3duID0gWy4uLmxhc3Qua2V5cygpXS5maWx0ZXIoKGEpID0+ICFhZ2VudENhY2hlLmhhcyhhKSkuc2xpY2UoMCwgNDAwKTtcbiAgICBpZiAodW5rbm93bi5sZW5ndGgpIHsgY29uc3QgcmVzID0gYXdhaXQgcnBjQmF0Y2godW5rbm93bi5tYXAoKGEpID0+ICh7IG1ldGhvZDogJ2V0aF9jYWxsJywgcGFyYW1zOiBbeyB0bzogJzB4JyArIFJFR0lTVFJZLCBkYXRhOiAnMHg3MGEwODIzMScgKyB3YShhKSB9LCAnbGF0ZXN0J10gfSkpKTsgdW5rbm93bi5mb3JFYWNoKChhLCBpKSA9PiB7IGlmIChyZXNbaV0gIT09IHVuZGVmaW5lZCkgYWdlbnRDYWNoZS5zZXQoYSwgISFyZXNbaV0gJiYgcmVzW2ldLmxlbmd0aCA+PSA2NiAmJiBCaWdJbnQocmVzW2ldLnNsaWNlKDAsIDY2KSkgPiAwbik7IH0pOyB9XG4gICAgbGV0IGFnZW50cyA9IDAsIGJ1cnN0ID0gMDsgZm9yIChjb25zdCBbYSwgYm5dIG9mIGxhc3QpIGlmIChhZ2VudENhY2hlLmdldChhKSkgeyBhZ2VudHMrKzsgaWYgKGJuID49IGhlYWQgLSA0MDApIGJ1cnN0Kys7IH1cbiAgICBQLmFnZW50cyA9IE1hdGgubWF4KFAuYWdlbnRzIHx8IDAsIGFnZW50cyk7IFAuYnVyc3QgPSBidXJzdDsgUC5oZWF0QXQgPSBEYXRlLm5vdygpO1xuICB9XG5cbiAgY29uc3QgaGsgPSAoUCkgPT4gKFAuaGVhdEF0IHx8IDApICsgKGhlYXRUaWVyKFApID49IDEgfHwgKFAucHJvZ3Jlc3MgfHwgMCkgPj0gMC4yID8gMCA6IDU0MGUzKTtcblxuICBhc3luYyBmdW5jdGlvbiBoZWF0V2F0Y2goKSB7IC8vIOiDjOaZr++8muabv+i/vei5pOS4reeahOS7mOiyu+mgheebrueul+eGseW6pu+8jOeci+S4jeaHgueahOWQiOe0hOmghuS+v+WtuOWIpeS6uueahOaJk+azle+8iOS4jeaLluaFoiAxNSDnp5LnmoTlv6vpgJ/mqqLmn6XvvIlcbiAgICBjb25zdCBlbnRzID0gT2JqZWN0LmVudHJpZXMoUy5wYWlkIHx8IHt9KS5maWx0ZXIoKFtjLCBQXSkgPT4gIUlORlJBLmhhcyhjKSAmJiAhUC51bm1pbnRhYmxlICYmIChQLnByb2dyZXNzIHx8IDApIDwgMC45OTkgJiYgIVdBTExFVFMuZXZlcnkoKFcpID0+IFAuZG9uZT8uW1cubmFtZV0pKVxuICAgICAgLnNvcnQoKGEsIGIpID0+ICgoYlsxXS5uZWVkTGVhcm4gJiYgKGJbMV0ucHJvZ3Jlc3MgfHwgMCkgPj0gMC40NSkgLSAoYVsxXS5uZWVkTGVhcm4gJiYgKGFbMV0ucHJvZ3Jlc3MgfHwgMCkgPj0gMC40NSkpIHx8IGhrKGFbMV0pIC0gaGsoYlsxXSkpLnNsaWNlKDAsIDgpOyAvLyDlv6vmu7/miJblvojnhrHnmoTntITmr4/liIbpkJjmm7TmlrDvvIzlhbbku5bntIQgMTAg5YiG6ZCY77yb5b+r5Yiw6ZaA5qq75Y+I6YKE5LiN5pyD5omT55qE5o6S5pyA5YmN6Z2i77yI6Zmk6YyvIDExLzHvvJpCTkJDQVQgNTclIOS4gOebtOaOkuS4jeWIsO+8iVxuICAgIGZvciAoY29uc3QgW2MsIFBdIG9mIGVudHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGhlYXRPZihjLCBQKS5jYXRjaCgoZSkgPT4gbG9nKCdoZWF0ICcgKyBjICsgJyAnICsgZS5tZXNzYWdlKSk7IC8qIOmZpOmMryAxMS8x77ya566X54ax5bqm6KKr56+A6bue6ZmQ5rWB5pmC77yM5a245omT5rOV5Lmf6Lef6JGX6KKr6Lez6YGOIOKGkiDliIbplovomZXnkIYgKi9cbiAgICAgICAgaWYgKFAubmVlZExlYXJuICYmICghUC5yZXBsYXkgfHwgRGF0ZS5ub3coKSAtIChQLnJlcGxheS5sZWFybmVkQXQgfHwgMCkgPiAxMjBlMykgJiYgKGhlYXRUaWVyKFApID49IDEgfHwgKFAucHJvZ3Jlc3MgfHwgMCkgPj0gMC4yIHx8IChQLmFnZW50cyB8fCAwKSA+PSAyMCkpIHsgY29uc3QgbHIgPSBhd2FpdCBsZWFyblJlcGxheShjKS5jYXRjaCgoKSA9PiBudWxsKTsgaWYgKGxyPy5yZWN2KSB7IFAucmVjdlZhbHVlID0gbHIucmVjdjsgUC5yZWN2U2VlbiA9IGxyLnJlY3ZTZWVuOyBQLnJlY3ZWYWxzID0gbHIucmVjdlZhbHM7IFAucmVwbGF5ID0geyBob3Q6IGxyLmhvdCwgbGVhcm5lZEF0OiBsci5sZWFybmVkQXQgfTsgZGVsZXRlIFAubmVlZExlYXJuOyBsb2coYOWtuOWIsCAke1AubmFtZSB8fCBjfSDnmoTmiZPms5XvvJrnm7TmjqXovYkgJHtOdW1iZXIoQmlnSW50KGxyLnJlY3YpKSAvIDFlMTh9IEJOQiDlsLHpkYTpgKDvvIgke2xyLnJlY3ZTZWVufSDnrYbvvIlgKTsgfSBlbHNlIGlmIChscikgUC5yZXBsYXkgPSBscjsgfVxuICAgICAgfSBjYXRjaCAoZSkgeyBsb2coJ2hlYXQgJyArIGMgKyAnICcgKyBlLm1lc3NhZ2UpOyB9XG4gICAgfVxuICB9XG4gIHJldHVybiB7XG4gICAgZ2V0IGJ1aWxkU21hcnQoKSB7IHJldHVybiBidWlsZFNtYXJ0OyB9LFxuICAgIGdldCBIT1QoKSB7IHJldHVybiBIT1Q7IH0sXG4gICAgZ2V0IHNjYW5OZXcoKSB7IHJldHVybiBzY2FuTmV3OyB9LFxuICAgIGdldCBoZWF0V2F0Y2goKSB7IHJldHVybiBoZWF0V2F0Y2g7IH0sXG4gIH07XG59XG4iXSwibWFwcGluZ3MiOiJBQUFBOztBQUVBLE9BQU8sU0FBU0EsZUFBZUEsQ0FBQ0MsWUFBWSxFQUFFO0VBQzVDLE1BQU07SUFBRUMsUUFBUTtJQUFFQyxLQUFLO0lBQUVDLEtBQUs7SUFBRUMsRUFBRTtJQUFFQyxTQUFTO0lBQUVDLFFBQVE7SUFBRUMsSUFBSTtJQUFFQyxDQUFDO0lBQUVDLFVBQVU7SUFBRUMsT0FBTztJQUFFQyxNQUFNO0lBQUVDLElBQUk7SUFBRUMsUUFBUTtJQUFFQyxRQUFRO0lBQUVDLFFBQVE7SUFBRUMsU0FBUztJQUFFQyxXQUFXO0lBQUVDLEdBQUc7SUFBRUMsT0FBTztJQUFFQyxVQUFVO0lBQUVDLE9BQU87SUFBRUMsU0FBUztJQUFFQyxHQUFHO0lBQUVDLFFBQVE7SUFBRUMsU0FBUztJQUFFQyxFQUFFO0lBQUVDLE1BQU07SUFBRUMsRUFBRTtJQUFFQyxFQUFFO0lBQUVDO0VBQVUsQ0FBQyxHQUFHOUIsWUFBWTtFQUNqUixNQUFNK0IsU0FBUyxHQUFHLENBQUMsNENBQTRDLEVBQUUsNENBQTRDLEVBQUUsNENBQTRDLEVBQUUsNENBQTRDLENBQUM7RUFFMU0sTUFBTUMsT0FBTyxHQUFHLENBQUMsNENBQTRDLEVBQUUsNENBQTRDLEVBQUUsNENBQTRDLEVBQUUsNENBQTRDLENBQUM7RUFFeE0sSUFBSUMsS0FBSyxHQUFHLElBQUlDLEdBQUcsQ0FBQzFCLENBQUMsQ0FBQzJCLEtBQUssSUFBSSxFQUFFLENBQUM7RUFFbEMsZUFBZUMsVUFBVUEsQ0FB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

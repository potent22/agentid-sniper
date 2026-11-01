// Module: discovery. Construction is inert; I/O is invoked explicitly.

export function createDiscovery(dependencies) {
  const {
    activity, noteTransactions = () => {},
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
    if (S.agentsV !== 2) { for (const entry of Object.values(S.paid || {})) { delete entry.agents; delete entry.heatAt; } S.agentsV = 2; }

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
    noteTransactions(txs);
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
      const hashes = [...new Set((L || []).map(l => l.transactionHash).filter(h => /^0x[0-9a-f]{64}$/i.test(h || '')))];
      const txs = await rpcBatch(hashes.map(h => ({ method: 'eth_getTransactionByHash', params: [h] })));
      hashes.forEach((hash, i) => {
        const tx = txs[i]; if (!tx || String(tx.hash).toLowerCase() !== hash.toLowerCase()) return;
        const a = String(tx.from || '').toLowerCase(), bn = parseInt(tx.blockNumber, 16);
        if (!/^0x[0-9a-f]{40}$/.test(a) || skip.has(a) || !Number.isSafeInteger(bn)) return;
        if (!last.has(a) || last.get(a) < bn) last.set(a, bn);
      });
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
    P.agents = agents;
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
    heatOf,
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

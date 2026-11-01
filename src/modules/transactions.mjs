// Module: transactions. Construction is inert; I/O is invoked explicitly.
import { executeGuarded } from '../../guarded-contract-executor.mjs';
import { contractPrincipal } from '../../contract-principal.mjs';
import { withApproval } from '../../approval-workflow.mjs';
import { cleanupApproval } from '../../approval-cleanup.mjs';
import { guardedSwap, waitForOrder, discoverApprovals } from '../../swap-recovery.mjs';
import { waitForReceipt } from '../../transaction-receipt.mjs';
import { applyOnce, writeState, tokenNet } from '../../execution-state.mjs';
import { mintMetadata, prepareMintEvent } from '../../mint-recovery.mjs';
import { prepareFeeEvent } from '../../receipt-fees.mjs';
import { contractIntent } from '../domain/contracts.mjs';
export function createTransactions(dependencies) {
  const {
    CONFIG,
    walletLimit = async () => 0,
    FORCE,
    PROJECT_BUDGET,
    RECOVERY,
    S,
    STATE,
    USDT,
    WALLET_LEASE,
    activity,
    bnbUsd,
    call,
    enforceMintRisk,
    flapGuard,
    riskBlock,
    rpc,
    sleep,
    tokStr,
    w,
    wa,
    wallet
  } = dependencies;
  // Automated swaps may create Permit2-internal allowances that the current
  // recovery journal cannot discover and verify. Keep them disabled until a
  // route adapter can prove all permissions are cleaned up.
  const assertSwapAllowed = dependencies.assertSwapAllowed || (async () => {
    throw new Error('自动兑换暂停：尚不能核实 Permit2 等授权的完整清理');
  });
  const persistState = dependencies.persistState || writeState;
  async function revokePermission(W, token, spender, type = 'approve') {
    if (type !== 'approve') throw new Error('Non-ERC20 permission cleanup requires a verified adapter');
    activity.count++;
    try {
      return await WALLET_LEASE.run(W.addr, async () => {
        RECOVERY.begin(W.addr, {
          kind: 'approval',
          token: token.toLowerCase(),
          spender: spender.toLowerCase(),
          phase: 'cleanup'
        });
        await cleanupSpender(W, token, spender);
        RECOVERY.clear(W.addr);
        return {
          j: {
            success: true
          },
          t: 'Allowance verified zero'
        };
      });
    } finally {
      activity.count--;
    }
  }
  async function readAllowance(W, token, spender) {
    const result = await rpc('eth_call', [{
      to: token,
      data: '0xdd62ed3e' + wa(W.addr) + wa(spender)
    }, 'latest']);
    if (!/^0x[0-9a-f]{64}$/i.test(result || '')) throw new Error('allowance unavailable');
    return BigInt(result);
  }
  async function cleanupSpender(W, token, spender) {
    const pending = PROJECT_BUDGET.pending(W.addr, spender);
    if (pending) {
      try {
        await executeGuarded({
          budget: PROJECT_BUDGET,
          wallet: W.addr,
          project: spender,
          ceiling: 0n,
          rpc,
          sleep,
          applyConfirmed: adoptConfirmed,
          recordReceipt: recordFeeReceipt,
          submit: async () => {
            throw new Error('recovery must never submit');
          }
        });
      } catch (error) {
        if (!error.message.includes('已核實先前交易成功並記帳') && !error.message.startsWith('交易鏈上失敗：')) throw error;
      }
    }
    let confirmed;
    return cleanupApproval({
      readAllowance: () => readAllowance(W, token, spender),
      revoke: async () => {
        confirmed = await previewExec(W, token, '0x095ea7b3' + wa(spender) + w(0), 0n, () => '');
        return confirmed.tx;
      },
      waitReceipt: async hash => confirmed?.receipt || waitForReceipt(hash, {
        rpc,
        sleep
      })
    });
  }
  async function approvedMint(W, token, spender, amount, work) {
    activity.count++;
    try {
      return await withApproval({
        journal: RECOVERY,
        lease: WALLET_LEASE,
        wallet: W.addr,
        token,
        spender,
        grant: () => previewExec(W, token, '0x095ea7b3' + wa(spender) + w(amount), 0n, () => ''),
        work,
        cleanup: () => cleanupSpender(W, token, spender)
      });
    } finally {
      activity.count--;
    }
  }
  async function finishSwap(W, recovering = false) {
    const job = RECOVERY.get(W.addr);
    if (job?.kind !== 'swap' || !job.orderId) throw new Error('結果不明：兌換訂單無編號，需人工核實');
    const terminal = job.terminal || (await waitForOrder(job.orderId, {
      lookup: id => wallet.call(W.addr, ['market-order', 'list', '--orderId', id]),
      rpc,
      sleep,
      recordReceipt: receipt => recordFeeReceipt({
        wallet: W.addr,
        project: job.args[job.args.indexOf('--fromToken') + 1],
        metadata: {
          kind: 'swap'
        },
        receipt
      })
    }));
    if (terminal.receipt) await recordFeeReceipt({
      wallet: W.addr,
      project: job.args[job.args.indexOf('--fromToken') + 1],
      metadata: {
        kind: 'swap'
      },
      receipt: terminal.receipt
    });
    RECOVERY.update(W.addr, {
      terminal,
      phase: 'confirmed'
    });
    const value = flag => job.args[job.args.indexOf(flag) + 1];
    for (const [field, flag] of [['fromToken', '--fromToken'], ['toToken', '--toToken']]) {
      if (String(terminal.order[field]).toLowerCase() !== String(value(flag)).toLowerCase()) throw new Error('結果不明：訂單幣種不符');
    }
    const headBlock = await rpc('eth_blockNumber', []);
    const toBlock = job.approvalToBlock || terminal.receipt?.blockNumber || headBlock;
    RECOVERY.update(W.addr, {
      approvalToBlock: toBlock
    });
    if (terminal.receipt && BigInt(headBlock) < BigInt(terminal.receipt.blockNumber)) throw new Error('結果不明：節點尚未同步到兌換回執，保留清理任務');
    const nonces = await Promise.all(['latest', 'pending'].map(tag => rpc('eth_getTransactionCount', [W.addr, tag])));
    if (nonces.some(n => !/^0x[0-9a-f]+$/i.test(n || '')) || BigInt(nonces[0]) !== BigInt(nonces[1])) throw new Error('結果不明：錢包仍有待處理交易，保留清理任務');
    const approvals = await discoverApprovals({
      rpc,
      wallet: W.addr,
      fromBlock: job.fromBlock,
      toBlock
    });
    RECOVERY.update(W.addr, {
      phase: 'cleanup',
      approvals
    });
    for (const approval of approvals) {
      for (const hash of approval.txHashes) await waitForReceipt(hash, {
        rpc,
        sleep,
        onReceipt: receipt => recordFeeReceipt({
          wallet: W.addr,
          project: approval.spender,
          metadata: {
            kind: 'permission'
          },
          receipt
        })
      });
      await cleanupSpender(W, approval.token, approval.spender);
    }
    if (!terminal.failed) {
      const metadata = job.metadata;
      if (!metadata || !['sale', 'funding'].includes(metadata.purpose)) throw new Error('已確認兌換，但缺少策略計劃，需人工核對');
      const event = {
        id: `swap:${W.addr}:${job.orderId}`,
        txHash: terminal.order.txHash,
        kind: metadata.purpose,
        wallet: W.addr,
        orderId: job.orderId,
        metadata,
        at: terminal.order.updatedTime || new Date().toISOString()
      };
      if (metadata.purpose === 'sale') {
        const sold = -tokenNet(terminal.receipt, W.addr, metadata.token),
          requested = BigInt(metadata.requestedRaw);
        if (sold <= 0n || sold > requested) throw new Error('已確認兌換，但無法核實實際賣出量，需人工核對');
        const remaining = await rpc('eth_call', [{
          to: metadata.token,
          data: '0x70a08231' + wa(W.addr)
        }, 'latest']);
        if (!/^0x[0-9a-f]{64}$/i.test(remaining || '')) throw new Error('賣出後餘額無法核實');
        const refund = (terminal.order.refund || []).filter(x => typeof x.amount === 'string' && /^[0-9]+(\.[0-9]+)?$/.test(x.amount) && /[1-9]/.test(x.amount));
        Object.assign(event, {
          soldRaw: sold.toString(),
          remainingRaw: BigInt(remaining).toString(),
          received: terminal.order.toTokenActualQty,
          refund,
          partial: sold !== requested || refund.length > 0
        });
      }
      applyOnce(S, event, state => persistState(STATE, state));
    }
    RECOVERY.clear(W.addr);
    if (terminal.failed) return {
      j: {
        success: false,
        error: {
          message: '兌換訂單已確認失敗'
        }
      },
      t: '兌換訂單已確認失敗'
    };
    return {
      j: {
        success: true,
        data: terminal.order
      },
      t: JSON.stringify(terminal.order)
    };
  }
  async function swapConfirmed(W, args, metadata = {
    purpose: 'funding'
  }) {
    await assertSwapAllowed({ wallet: W.addr, args, metadata });
    if (PROJECT_BUDGET.pendingEntries(W.addr).length) throw new Error('結果不明：合約交易仍待恢復，禁止兌換');
    activity.count++;
    try {
      return await guardedSwap({
        journal: RECOVERY,
        lease: WALLET_LEASE,
        wallet: W.addr,
        args,
        metadata,
        getBlock: () => rpc('eth_blockNumber', []),
        submit: a => wallet.call(W.addr, a),
        finish: () => finishSwap(W)
      });
    } finally {
      activity.count--;
    }
  }
  async function recoverWallet(W) {
    return WALLET_LEASE.run(W.addr, async () => {
      const job = RECOVERY.get(W.addr);
      if (!job) return;
      if (job.kind === 'swap') {
        await finishSwap(W, true);
        return;
      }
      await cleanupSpender(W, job.token, job.spender);
      RECOVERY.clear(W.addr);
    });
  }
  async function recordFeeReceipt({
    wallet,
    project,
    metadata,
    receipt
  }) {
    const id = `fee:56:${wallet.toLowerCase()}:${receipt.transactionHash}`;
    if (S.appliedExecutions?.[id]) return;
    const event = await prepareFeeEvent({
      wallet,
      project,
      metadata,
      receipt,
      rpc,
      timeZone: CONFIG.timeZone || 'Asia/Shanghai'
    });
    applyOnce(S, event, state => persistState(STATE, state));
  }
  async function adoptConfirmed({
    wallet,
    project,
    pending,
    receipt
  }) {
    if (pending.metadata?.kind === 'permission') return;
    const id = `mint:${wallet}:${receipt.transactionHash}`;
    if (S.appliedExecutions?.[id]) {
      if (S.appliedExecutions[id] !== receipt.transactionHash) throw new Error('mint execution identity conflict');
      return;
    }
    const event = await prepareMintEvent({
      wallet,
      project,
      pending,
      receipt,
      rpc,
      symbol: async token => tokStr(await call(token, '0x95d89b41')) || token.slice(0, 10)
    });
    applyOnce(S, event, state => persistState(STATE, state));
  }
  async function recoverContractMints(W) {
    return WALLET_LEASE.run(W.addr, async () => {
      for (const pending of PROJECT_BUDGET.pendingEntries(W.addr)) {
        await executeGuarded({
          budget: PROJECT_BUDGET,
          wallet: W.addr,
          project: pending.project,
          ceiling: 0n,
          recoverOnly: true,
          applyConfirmed: adoptConfirmed,
          recordReceipt: recordFeeReceipt,
          rpc,
          sleep,
          submit: async () => {
            throw new Error('recovery must not submit');
          }
        });
      }
    });
  }
  async function submitContract(W, to, data, valueWei, requestId, sim) {
    contractIntent({
      chainId: '56',
      wallet: W.addr,
      contract: to,
      value: valueWei.toString(),
      inputData: data
    });
    return WALLET_LEASE.run(W.addr, async () => {
      const job = RECOVERY.get(W.addr);
      const target = String(to).toLowerCase();
      if (PROJECT_BUDGET.pendingEntries(W.addr).some(p => p.project !== target && p.project !== (job?.spender || '') && p.project !== (/^0x095ea7b3[0-9a-f]{128}$/i.test(data || '') ? '0x' + data.slice(34, 74).toLowerCase() : ''))) throw new Error('結果不明：錢包有其他未確認交易，禁止新交易');
      const approval = /^0x095ea7b3[0-9a-f]{128}$/i.test(data || '');
      const revoking = approval && BigInt('0x' + data.slice(74)) === 0n;
      if (!revoking) await enforceMintRisk(approval ? '0x' + data.slice(34, 74).toLowerCase() : target);
      if (approval && !revoking && !(await walletLimit('0x' + data.slice(34, 74).toLowerCase()))) throw new Error('未核实付费合约铸造限额');
      if (approval && !revoking && !(job?.kind === 'approval' && job.token === target && job.spender === '0x' + data.slice(34, 74).toLowerCase())) throw new Error('授權必須由可恢復的清理流程管理');
      if (job && !revoking && !(job.kind === 'approval' && (target === job.spender || approval))) throw new Error('結果不明：錢包有待清理操作，禁止新交易');
      activity.count++;
      try {
        const bound = await contractPrincipal({
          wallet: W.addr,
          to,
          data,
          value: valueWei,
          sim,
          max: PROJECT_BUDGET.max,
          allowance: async spender => {
            const result = await rpc('eth_call', [{
              to: USDT,
              data: '0xdd62ed3e' + wa(W.addr) + wa(spender)
            }, 'latest']);
            if (!/^0x[0-9a-f]{64}$/i.test(result || '')) throw new Error('USDT allowance unavailable');
            return BigInt(result);
          },
          bnbPriceMicros: async () => {
            const price = await bnbUsd();
            if (!Number.isFinite(price) || price <= 0) throw new Error('BNB price unavailable');
            return BigInt(Math.ceil(price * 1e6));
          }
        });
        if (!approval && bound.ceiling > 0n && !(await walletLimit(target))) throw new Error('未核实付费合约铸造限额');
        if (!approval) {
          const reason = await riskBlock(W, target, valueWei, data, bound.ceiling === 0n, bound.ceiling > 0n);
          if (reason) throw new Error('風控攔截：' + reason);
        }
        return await executeGuarded({
          budget: PROJECT_BUDGET,
          wallet: W.addr,
          ...bound,
          rpc,
          sleep,
          metadata: {
            ...mintMetadata(W.addr, W.name, sim, {
              permission: approval,
              hold: FORCE.has(target)
            }),
            bnbPriceEstimated: Boolean(S.bnbPriceEstimated), freeMint: !approval && bound.ceiling === 0n
          },
          applyConfirmed: adoptConfirmed,
          recordReceipt: recordFeeReceipt,
          submit: () => wallet.call(W.addr, ['contract-call', 'execute', '--requestId', requestId])
        });
      } finally {
        activity.count--;
      }
    });
  }
  async function previewExec(W, to, data, valueWei, check, recheck = null) {
    const intent = contractIntent({
      chainId: '56',
      wallet: W.addr,
      contract: to,
      value: valueWei.toString(),
      inputData: data
    });
    const p = await wallet.call(W.addr, ['contract-call', 'preview', '--binanceChainId', '56', '--from', intent.wallet, '--to', intent.contract, '--value', intent.value, '--inputData', intent.inputData]);
    const sim = p.j?.data?.simulationResult,
      rid = p.j?.data?.requestId;
    if (!p.j?.success || !rid) throw new Error('預演失敗 ' + (p.j?.error?.message || p.t).slice(0, 120));
    const fg = flapGuard(to, data, sim);
    if (fg) throw new Error('預演不安全：' + fg);
    const why = check(sim);
    if (why) throw new Error('預演不安全：' + why);
    {
      const outBnb = (sim?.balanceChanges || []).filter(b => String(b.owner).toLowerCase() === W.addr && String(b.contractAddress || '').toLowerCase().startsWith('0xeeee') && Number(b.change) < 0).reduce((a, b) => a - Number(b.change), 0);
      if (outBnb > Number(valueWei) * 1.0000001 + 1) throw new Error('預演不安全：會扣的 BNB 比說好的多（風控）');
    }
    if (recheck) {
      const r2 = await recheck();
      if (r2) throw new Error('送出前再確認不通過：' + r2);
    } // 送出前再確認價格（審查建議 5）
    const {
      result: x,
      receipt
    } = await submitContract(W, to, data, valueWei, rid, sim);
    return {
      tx: x.j.data.txHash,
      sim,
      receipt
    };
  }
  return {
    revokePermission,
    readAllowance,
    cleanupSpender,
    approvedMint,
    finishSwap,
    swapConfirmed,
    recoverWallet,
    recordFeeReceipt,
    adoptConfirmed,
    recoverContractMints,
    submitContract,
    previewExec
  };
}

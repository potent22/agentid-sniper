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
            freeMint: !approval && bound.ceiling === 0n
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJleGVjdXRlR3VhcmRlZCIsImNvbnRyYWN0UHJpbmNpcGFsIiwid2l0aEFwcHJvdmFsIiwiY2xlYW51cEFwcHJvdmFsIiwiZ3VhcmRlZFN3YXAiLCJ3YWl0Rm9yT3JkZXIiLCJkaXNjb3ZlckFwcHJvdmFscyIsIndhaXRGb3JSZWNlaXB0IiwiYXBwbHlPbmNlIiwid3JpdGVTdGF0ZSIsInRva2VuTmV0IiwibWludE1ldGFkYXRhIiwicHJlcGFyZU1pbnRFdmVudCIsInByZXBhcmVGZWVFdmVudCIsImNvbnRyYWN0SW50ZW50IiwiY3JlYXRlVHJhbnNhY3Rpb25zIiwiZGVwZW5kZW5jaWVzIiwiQ09ORklHIiwiRk9SQ0UiLCJQUk9KRUNUX0JVREdFVCIsIlJFQ09WRVJZIiwiUyIsIlNUQVRFIiwiVVNEVCIsIldBTExFVF9MRUFTRSIsImFjdGl2aXR5IiwiYm5iVXNkIiwiY2FsbCIsImVuZm9yY2VNaW50UmlzayIsImZsYXBHdWFyZCIsInJpc2tCbG9jayIsInJwYyIsInNsZWVwIiwidG9rU3RyIiwidyIsIndhIiwid2FsbGV0IiwicGVyc2lzdFN0YXRlIiwicmV2b2tlUGVybWlzc2lvbiIsIlciLCJ0b2tlbiIsInNwZW5kZXIiLCJ0eXBlIiwiRXJyb3IiLCJjb3VudCIsInJ1biIsImFkZHIiLCJiZWdpbiIsImtpbmQiLCJ0b0xvd2VyQ2FzZSIsInBoYXNlIiwiY2xlYW51cFNwZW5kZXIiLCJjbGVhciIsImoiLCJzdWNjZXNzIiwidCIsInJlYWRBbGxvd2FuY2UiLCJyZXN1bHQiLCJ0byIsImRhdGEiLCJ0ZXN0IiwiQmlnSW50IiwicGVuZGluZyIsImJ1ZGdldCIsInByb2plY3QiLCJjZWlsaW5nIiwiYXBwbHlDb25maXJtZWQiLCJhZG9wdENvbmZpcm1lZCIsInJlY29yZFJlY2VpcHQiLCJyZWNvcmRGZWVSZWNlaXB0Iiwic3VibWl0IiwiZXJyb3IiLCJtZXNzYWdlIiwiaW5jbHVkZXMiLCJzdGFydHNXaXRoIiwiY29uZmlybWVkIiwicmV2b2tlIiwicHJldmlld0V4ZWMiLCJ0eCIsIndhaXRSZWNlaXB0IiwiaGFzaCIsInJlY2VpcHQiLCJhcHByb3ZlZE1pbnQiLCJhbW91bnQiLCJ3b3JrIiwiam91cm5hbCIsImxlYXNlIiwiZ3JhbnQiLCJjbGVhbnVwIiwiZmluaXNoU3dhcCIsInJlY292ZXJpbmciLCJqb2IiLCJnZXQiLCJvcmRlcklkIiwidGVybWluYWwiLCJsb29rdXAiLCJpZCIsImFyZ3MiLCJpbmRleE9mIiwibWV0YWRhdGEiLCJ1cGRhdGUiLCJ2YWx1ZSIsImZsYWciLCJmaWVsZCIsIlN0cmluZyIsIm9yZGVyIiwiaGVhZEJsb2NrIiwidG9CbG9jayIsImFwcHJvdmFsVG9CbG9jayIsImJsb2NrTnVtYmVyIiwibm9uY2VzIiwiUHJvbWlzZSIsImFsbCIsIm1hcCIsInRhZyIsInNvbWUiLCJuIiwiYXBwcm92YWxzIiwiZnJvbUJsb2NrIiwiYXBwcm92YWwiLCJ0eEhhc2hlcyIsIm9uUmVjZWlwdCIsImZhaWxlZCIsInB1cnBvc2UiLCJldmVudCIsInR4SGFzaCIsImF0IiwidXBkYXRlZFRpbWUiLCJEYXRlIiwidG9JU09TdHJpbmciLCJzb2xkIiwicmVxdWVzdGVkIiwicmVxdWVzdGVkUmF3IiwicmVtYWluaW5nIiwicmVmdW5kIiwiZmlsdGVyIiwieCIsIk9iamVjdCIsImFzc2lnbiIsInNvbGRSYXciLCJ0b1N0cmluZyIsInJlbWFpbmluZ1JhdyIsInJlY2VpdmVkIiwidG9Ub2tlbkFjdHVhbFF0eSIsInBhcnRpYWwiLCJsZW5ndGgiLCJzdGF0ZSIsIkpTT04iLCJzdHJpbmdpZnkiLCJzd2FwQ29uZmlybWVkIiwicGVuZGluZ0VudHJpZXMiLCJnZXRCbG9jayIsImEiLCJmaW5pc2giLCJyZWNvdmVyV2FsbGV0IiwidHJhbnNhY3Rpb25IYXNoIiwiYXBwbGllZEV4ZWN1dGlvbnMiLCJ0aW1lWm9uZSIsInN5bWJvbCIsInNsaWNlIiwicmVjb3ZlckNvbnRyYWN0TWludHMiLCJyZWNvdmVyT25seSIsInN1Ym1pdENvbnRyYWN0IiwidmFsdWVXZWkiLCJyZXF1ZXN0SWQiLCJzaW0iLCJjaGFpbklkIiwiY29udHJhY3QiLCJpbnB1dERhdGEiLCJ0YXJnZXQiLCJwIiwicmV2b2tpbmciLCJib3VuZCIsIm1heCIsImFsbG93YW5jZSIsImJuYlByaWNlTWljcm9zIiwicHJpY2UiLCJOdW1iZXIiLCJpc0Zpbml0ZSIsIk1hdGgiLCJjZWlsIiwicmVhc29uIiwibmFtZSIsInBlcm1pc3Npb24iLCJob2xkIiwiaGFzIiwiZnJlZU1pbnQiLCJjaGVjayIsInJlY2hlY2siLCJpbnRlbnQiLCJzaW11bGF0aW9uUmVzdWx0IiwicmlkIiwiZmciLCJ3aHkiLCJvdXRCbmIiLCJiYWxhbmNlQ2hhbmdlcyIsImIiLCJvd25lciIsImNvbnRyYWN0QWRkcmVzcyIsImNoYW5nZSIsInJlZHVjZSIsInIyIl0sInNvdXJjZXMiOlsidHJhbnNhY3Rpb25zLm1qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBNb2R1bGU6IHRyYW5zYWN0aW9ucy4gQ29uc3RydWN0aW9uIGlzIGluZXJ0OyBJL08gaXMgaW52b2tlZCBleHBsaWNpdGx5LlxuaW1wb3J0IHsgZXhlY3V0ZUd1YXJkZWQgfSBmcm9tICcuLi8uLi9ndWFyZGVkLWNvbnRyYWN0LWV4ZWN1dG9yLm1qcyc7XG5pbXBvcnQgeyBjb250cmFjdFByaW5jaXBhbCB9IGZyb20gJy4uLy4uL2NvbnRyYWN0LXByaW5jaXBhbC5tanMnO1xuaW1wb3J0IHsgd2l0aEFwcHJvdmFsIH0gZnJvbSAnLi4vLi4vYXBwcm92YWwtd29ya2Zsb3cubWpzJztcbmltcG9ydCB7IGNsZWFudXBBcHByb3ZhbCB9IGZyb20gJy4uLy4uL2FwcHJvdmFsLWNsZWFudXAubWpzJztcbmltcG9ydCB7IGd1YXJkZWRTd2FwLCB3YWl0Rm9yT3JkZXIsIGRpc2NvdmVyQXBwcm92YWxzIH0gZnJvbSAnLi4vLi4vc3dhcC1yZWNvdmVyeS5tanMnO1xuaW1wb3J0IHsgd2FpdEZvclJlY2VpcHQgfSBmcm9tICcuLi8uLi90cmFuc2FjdGlvbi1yZWNlaXB0Lm1qcyc7XG5pbXBvcnQgeyBhcHBseU9uY2UsIHdyaXRlU3RhdGUsIHRva2VuTmV0IH0gZnJvbSAnLi4vLi4vZXhlY3V0aW9uLXN0YXRlLm1qcyc7XG5pbXBvcnQgeyBtaW50TWV0YWRhdGEsIHByZXBhcmVNaW50RXZlbnQgfSBmcm9tICcuLi8uLi9taW50LXJlY292ZXJ5Lm1qcyc7XG5pbXBvcnQgeyBwcmVwYXJlRmVlRXZlbnQgfSBmcm9tICcuLi8uLi9yZWNlaXB0LWZlZXMubWpzJztcbmltcG9ydCB7IGNvbnRyYWN0SW50ZW50IH0gZnJvbSAnLi4vZG9tYWluL2NvbnRyYWN0cy5tanMnO1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVRyYW5zYWN0aW9ucyhkZXBlbmRlbmNpZXMpIHtcbiAgY29uc3QgeyBDT05GSUcsIEZPUkNFLCBQUk9KRUNUX0JVREdFVCwgUkVDT1ZFUlksIFMsIFNUQVRFLCBVU0RULCBXQUxMRVRfTEVBU0UsIGFjdGl2aXR5LCBibmJVc2QsIGNhbGwsIGVuZm9yY2VNaW50UmlzaywgZmxhcEd1YXJkLCByaXNrQmxvY2ssIHJwYywgc2xlZXAsIHRva1N0ciwgdywgd2EsIHdhbGxldCB9ID0gZGVwZW5kZW5jaWVzO1xuICBjb25zdCBwZXJzaXN0U3RhdGUgPSBkZXBlbmRlbmNpZXMucGVyc2lzdFN0YXRlIHx8IHdyaXRlU3RhdGU7XG4gIGFzeW5jIGZ1bmN0aW9uIHJldm9rZVBlcm1pc3Npb24oVywgdG9rZW4sIHNwZW5kZXIsIHR5cGUgPSAnYXBwcm92ZScpIHtcbiAgICBpZiAodHlwZSAhPT0gJ2FwcHJvdmUnKSB0aHJvdyBuZXcgRXJyb3IoJ05vbi1FUkMyMCBwZXJtaXNzaW9uIGNsZWFudXAgcmVxdWlyZXMgYSB2ZXJpZmllZCBhZGFwdGVyJyk7XG4gICAgYWN0aXZpdHkuY291bnQrKztcbiAgICB0cnkgeyByZXR1cm4gYXdhaXQgV0FMTEVUX0xFQVNFLnJ1bihXLmFkZHIsIGFzeW5jICgpID0+IHtcbiAgICAgIFJFQ09WRVJZLmJlZ2luKFcuYWRkciwgeyBraW5kOiAnYXBwcm92YWwnLCB0b2tlbjogdG9rZW4udG9Mb3dlckNhc2UoKSwgc3BlbmRlcjogc3BlbmRlci50b0xvd2VyQ2FzZSgpLCBwaGFzZTogJ2NsZWFudXAnIH0pO1xuICAgICAgYXdhaXQgY2xlYW51cFNwZW5kZXIoVywgdG9rZW4sIHNwZW5kZXIpO1xuICAgICAgUkVDT1ZFUlkuY2xlYXIoVy5hZGRyKTtcbiAgICAgIHJldHVybiB7IGo6IHsgc3VjY2VzczogdHJ1ZSB9LCB0OiAnQWxsb3dhbmNlIHZlcmlmaWVkIHplcm8nIH07XG4gICAgfSk7IH0gZmluYWxseSB7IGFjdGl2aXR5LmNvdW50LS07IH1cbiAgfVxuICBhc3luYyBmdW5jdGlvbiByZWFkQWxsb3dhbmNlKFcsIHRva2VuLCBzcGVuZGVyKSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnBjKCdldGhfY2FsbCcsIFt7IHRvOiB0b2tlbiwgZGF0YTogJzB4ZGQ2MmVkM2UnICsgd2EoVy5hZGRyKSArIHdhKHNwZW5kZXIpIH0sICdsYXRlc3QnXSk7XG4gICAgaWYgKCEvXjB4WzAtOWEtZl17NjR9JC9pLnRlc3QocmVzdWx0IHx8ICcnKSkgdGhyb3cgbmV3IEVycm9yKCdhbGxvd2FuY2UgdW5hdmFpbGFibGUnKTtcbiAgICByZXR1cm4gQmlnSW50KHJlc3VsdCk7XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBjbGVhbnVwU3BlbmRlcihXLCB0b2tlbiwgc3BlbmRlcikge1xuICAgIGNvbnN0IHBlbmRpbmcgPSBQUk9KRUNUX0JVREdFVC5wZW5kaW5nKFcuYWRkciwgc3BlbmRlcik7XG4gICAgaWYgKHBlbmRpbmcpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGV4ZWN1dGVHdWFyZGVkKHsgYnVkZ2V0OiBQUk9KRUNUX0JVREdFVCwgd2FsbGV0OiBXLmFkZHIsIHByb2plY3Q6IHNwZW5kZXIsIGNlaWxpbmc6IDBuLCBycGMsIHNsZWVwLCBhcHBseUNvbmZpcm1lZDogYWRvcHRDb25maXJtZWQsIHJlY29yZFJlY2VpcHQ6IHJlY29yZEZlZVJlY2VpcHQsXG4gICAgICAgICAgc3VibWl0OiBhc3luYyAoKSA9PiB7IHRocm93IG5ldyBFcnJvcigncmVjb3ZlcnkgbXVzdCBuZXZlciBzdWJtaXQnKTsgfSB9KTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmICghZXJyb3IubWVzc2FnZS5pbmNsdWRlcygn5bey5qC45a+m5YWI5YmN5Lqk5piT5oiQ5Yqf5Lim6KiY5bizJykgJiYgIWVycm9yLm1lc3NhZ2Uuc3RhcnRzV2l0aCgn5Lqk5piT6Y+I5LiK5aSx5pWX77yaJykpIHRocm93IGVycm9yO1xuICAgICAgfVxuICAgIH1cbiAgICBsZXQgY29uZmlybWVkO1xuICAgIHJldHVybiBjbGVhbnVwQXBwcm92YWwoe1xuICAgICAgcmVhZEFsbG93YW5jZTogKCkgPT4gcmVhZEFsbG93YW5jZShXLCB0b2tlbiwgc3BlbmRlciksXG4gICAgICByZXZva2U6IGFzeW5jICgpID0+IHsgY29uZmlybWVkID0gYXdhaXQgcHJldmlld0V4ZWMoVywgdG9rZW4sICcweDA5NWVhN2IzJyArIHdhKHNwZW5kZXIpICsgdygwKSwgMG4sICgpID0+ICcnKTsgcmV0dXJuIGNvbmZpcm1lZC50eDsgfSxcbiAgICAgIHdhaXRSZWNlaXB0OiBhc3luYyAoaGFzaCkgPT4gY29uZmlybWVkPy5yZWNlaXB0IHx8IHdhaXRGb3JSZWNlaXB0KGhhc2gsIHsgcnBjLCBzbGVlcCB9KSxcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIGFwcHJvdmVkTWludChXLCB0b2tlbiwgc3BlbmRlciwgYW1vdW50LCB3b3JrKSB7XG4gICAgYWN0aXZpdHkuY291bnQrKztcbiAgICB0cnkgeyByZXR1cm4gYXdhaXQgd2l0aEFwcHJvdmFsKHsgam91cm5hbDogUkVDT1ZFUlksIGxlYXNlOiBXQUxMRVRfTEVBU0UsIHdhbGxldDogVy5hZGRyLCB0b2tlbiwgc3BlbmRlcixcbiAgICAgIGdyYW50OiAoKSA9PiBwcmV2aWV3RXhlYyhXLCB0b2tlbiwgJzB4MDk1ZWE3YjMnICsgd2Eoc3BlbmRlcikgKyB3KGFtb3VudCksIDBuLCAoKSA9PiAnJyksXG4gICAgICB3b3JrLCBjbGVhbnVwOiAoKSA9PiBjbGVhbnVwU3BlbmRlcihXLCB0b2tlbiwgc3BlbmRlcikgfSk7IH1cbiAgICBmaW5hbGx5IHsgYWN0aXZpdHkuY291bnQtLTsgfVxuICB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gZmluaXNoU3dhcChXLCByZWNvdmVyaW5nID0gZmFsc2UpIHtcbiAgICBjb25zdCBqb2IgPSBSRUNPVkVSWS5nZXQoVy5hZGRyKTtcbiAgICBpZiAoam9iPy5raW5kICE9PSAnc3dhcCcgfHwgIWpvYi5vcmRlcklkKSB0aHJvdyBuZXcgRXJyb3IoJ+e1kOaenOS4jeaYju+8muWFjOaPm+ioguWWrueEoee3qOiZn++8jOmcgOS6uuW3peaguOWvpicpO1xuICAgIGNvbnN0IHRlcm1pbmFsID0gam9iLnRlcm1pbmFsIHx8IGF3YWl0IHdhaXRGb3JPcmRlcihqb2Iub3JkZXJJZCwge1xuICAgICAgbG9va3VwOiAoaWQpID0+IHdhbGxldC5jYWxsKFcuYWRkciwgWydtYXJrZXQtb3JkZXInLCAnbGlzdCcsICctLW9yZGVySWQnLCBpZF0pLCBycGMsIHNsZWVwLFxuICAgICAgcmVjb3JkUmVjZWlwdDogKHJlY2VpcHQpID0+IHJlY29yZEZlZVJlY2VpcHQoeyB3YWxsZXQ6IFcuYWRkciwgcHJvamVjdDogam9iLmFyZ3Nbam9iLmFyZ3MuaW5kZXhPZignLS1mcm9tVG9rZW4nKSArIDFdLCBtZXRhZGF0YTogeyBraW5kOiAnc3dhcCcgfSwgcmVjZWlwdCB9KSxcbiAgICB9KTtcbiAgICBpZiAodGVybWluYWwucmVjZWlwdCkgYXdhaXQgcmVjb3JkRmVlUmVjZWlwdCh7IHdhbGxldDogVy5hZGRyLCBwcm9qZWN0OiBqb2IuYXJnc1tqb2IuYXJncy5pbmRleE9mKCctLWZyb21Ub2tlbicpICsgMV0sIG1ldGFkYXRhOiB7IGtpbmQ6ICdzd2FwJyB9LCByZWNlaXB0OiB0ZXJtaW5hbC5yZWNlaXB0IH0pO1xuICAgIFJFQ09WRVJZLnVwZGF0ZShXLmFkZHIsIHsgdGVybWluYWwsIHBoYXNlOiAnY29uZmlybWVkJyB9KTtcbiAgICBjb25zdCB2YWx1ZSA9IChmbGFnKSA9PiBqb2IuYXJnc1tqb2IuYXJncy5pbmRleE9mKGZsYWcpICsgMV07XG4gICAgZm9yIChjb25zdCBbZmllbGQsIGZsYWddIG9mIFtbJ2Zyb21Ub2tlbicsICctLWZyb21Ub2tlbiddLCBbJ3RvVG9rZW4nLCAnLS10b1Rva2VuJ11dKSB7XG4gICAgICBpZiAoU3RyaW5nKHRlcm1pbmFsLm9yZGVyW2ZpZWxkXSkudG9Mb3dlckNhc2UoKSAhPT0gU3RyaW5nKHZhbHVlKGZsYWcpKS50b0xvd2VyQ2FzZSgpKSB0aHJvdyBuZXcgRXJyb3IoJ+e1kOaenOS4jeaYju+8muioguWWruW5o+eoruS4jeespicpO1xuICAgIH1cbiAgICBjb25zdCBoZWFkQmxvY2sgPSBhd2FpdCBycGMoJ2V0aF9ibG9ja051bWJlcicsIFtdKTtcbiAgICBjb25zdCB0b0Jsb2NrID0gam9iLmFwcHJvdmFsVG9CbG9jayB8fCB0ZXJtaW5hbC5yZWNlaXB0Py5ibG9ja051bWJlciB8fCBoZWFkQmxvY2s7XG4gICAgUkVDT1ZFUlkudXBkYXRlKFcuYWRkciwgeyBhcHByb3ZhbFRvQmxvY2s6IHRvQmxvY2sgfSk7XG4gICAgaWYgKHRlcm1pbmFsLnJlY2VpcHQgJiYgQmlnSW50KGhlYWRCbG9jaykgPCBCaWdJbnQodGVybWluYWwucmVjZWlwdC5ibG9ja051bWJlcikpIHRocm93IG5ldyBFcnJvcign57WQ5p6c5LiN5piO77ya56+A6bue5bCa5pyq5ZCM5q2l5Yiw5YWM5o+b5Zue5Z+377yM5L+d55WZ5riF55CG5Lu75YuZJyk7XG4gICAgY29uc3Qgbm9uY2VzID0gYXdhaXQgUHJvbWlzZS5hbGwoWydsYXRlc3QnLCAncGVuZGluZyddLm1hcCgodGFnKSA9PiBycGMoJ2V0aF9nZXRUcmFuc2FjdGlvbkNvdW50JywgW1cuYWRkciwgdGFnXSkpKTtcbiAgICBpZiAobm9uY2VzLnNvbWUoKG4pID0+ICEvXjB4WzAtOWEtZl0rJC9pLnRlc3QobiB8fCAnJykpIHx8IEJpZ0ludChub25jZXNbMF0pICE9PSBCaWdJbnQobm9uY2VzWzFdKSkgdGhyb3cgbmV3IEVycm9yKCfntZDmnpzkuI3mmI7vvJrpjKLljIXku43mnInlvoXomZXnkIbkuqTmmJPvvIzkv53nlZnmuIXnkIbku7vli5knKTtcbiAgICBjb25zdCBhcHByb3ZhbHMgPSBhd2FpdCBkaXNjb3ZlckFwcHJvdmFscyh7IHJwYywgd2FsbGV0OiBXLmFkZHIsIGZyb21CbG9jazogam9iLmZyb21CbG9jaywgdG9CbG9jayB9KTtcbiAgICBSRUNPVkVSWS51cGRhdGUoVy5hZGRyLCB7IHBoYXNlOiAnY2xlYW51cCcsIGFwcHJvdmFscyB9KTtcbiAgICBmb3IgKGNvbnN0IGFwcHJvdmFsIG9mIGFwcHJvdmFscykge1xuICAgICAgZm9yIChjb25zdCBoYXNoIG9mIGFwcHJvdmFsLnR4SGFzaGVzKSBhd2FpdCB3YWl0Rm9yUmVjZWlwdChoYXNoLCB7IHJwYywgc2xlZXAsXG4gICAgICAgIG9uUmVjZWlwdDogKHJlY2VpcHQpID0+IHJlY29yZEZlZVJlY2VpcHQoeyB3YWxsZXQ6IFcuYWRkciwgcHJvamVjdDogYXBwcm92YWwuc3BlbmRlciwgbWV0YWRhdGE6IHsga2luZDogJ3Blcm1pc3Npb24nIH0sIHJlY2VpcHQgfSkgfSk7XG4gICAgICBhd2FpdCBjbGVhbnVwU3BlbmRlcihXLCBhcHByb3ZhbC50b2tlbiwgYXBwcm92YWwuc3BlbmRlcik7XG4gICAgfVxuICAgIGlmICghdGVybWluYWwuZmFpbGVkKSB7XG4gICAgICBjb25zdCBtZXRhZGF0YSA9IGpvYi5tZXRhZGF0YTtcbiAgICAgIGlmICghbWV0YWRhdGEgfHwgIVsnc2FsZScsICdmdW5kaW5nJ10uaW5jbHVkZXMobWV0YWRhdGEucHVycG9zZSkpIHRocm93IG5ldyBFcnJvcign5bey56K66KqN5YWM5o+b77yM5L2G57y65bCR562W55Wl6KiI5YqD77yM6ZyA5Lq65bel5qC45bCNJyk7XG4gICAgICBjb25zdCBldmVudCA9IHsgaWQ6IGBzd2FwOiR7Vy5hZGRyfToke2pvYi5vcmRlcklkfWAsIHR4SGFzaDogdGVybWluYWwub3JkZXIudHhIYXNoLFxuICAgICAgICBraW5kOiBtZXRhZGF0YS5wdXJwb3NlLCB3YWxsZXQ6IFcuYWRkciwgb3JkZXJJZDogam9iLm9yZGVySWQsIG1ldGFkYXRhLFxuICAgICAgICBhdDogdGVybWluYWwub3JkZXIudXBkYXRlZFRpbWUgfHwgbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH07XG4gICAgICBpZiAobWV0YWRhdGEucHVycG9zZSA9PT0gJ3NhbGUnKSB7XG4gICAgICAgIGNvbnN0IHNvbGQgPSAtdG9rZW5OZXQodGVybWluYWwucmVjZWlwdCwgVy5hZGRyLCBtZXRhZGF0YS50b2tlbiksIHJlcXVlc3RlZCA9IEJpZ0ludChtZXRhZGF0YS5yZXF1ZXN0ZWRSYXcpO1xuICAgICAgICBpZiAoc29sZCA8PSAwbiB8fCBzb2xkID4gcmVxdWVzdGVkKSB0aHJvdyBuZXcgRXJyb3IoJ+W3sueiuuiqjeWFjOaPm++8jOS9hueEoeazleaguOWvpuWvpumam+izo+WHuumHj++8jOmcgOS6uuW3peaguOWwjScpO1xuICAgICAgICBjb25zdCByZW1haW5pbmcgPSBhd2FpdCBycGMoJ2V0aF9jYWxsJywgW3sgdG86IG1ldGFkYXRhLnRva2VuLCBkYXRhOiAnMHg3MGEwODIzMScgKyB3YShXLmFkZHIpIH0sICdsYXRlc3QnXSk7XG4gICAgICAgIGlmICghL14weFswLTlhLWZdezY0fSQvaS50ZXN0KHJlbWFpbmluZyB8fCAnJykpIHRocm93IG5ldyBFcnJvcign6LOj5Ye65b6M6aSY6aGN54Sh5rOV5qC45a+mJyk7XG4gICAgICAgIGNvbnN0IHJlZnVuZCA9ICh0ZXJtaW5hbC5vcmRlci5yZWZ1bmQgfHwgW10pLmZpbHRlcigoeCkgPT4gdHlwZW9mIHguYW1vdW50ID09PSAnc3RyaW5nJyAmJiAvXlswLTldKyhcXC5bMC05XSspPyQvLnRlc3QoeC5hbW91bnQpICYmIC9bMS05XS8udGVzdCh4LmFtb3VudCkpO1xuICAgICAgICBPYmplY3QuYXNzaWduKGV2ZW50LCB7IHNvbGRSYXc6IHNvbGQudG9TdHJpbmcoKSwgcmVtYWluaW5nUmF3OiBCaWdJbnQocmVtYWluaW5nKS50b1N0cmluZygpLFxuICAgICAgICAgIHJlY2VpdmVkOiB0ZXJtaW5hbC5vcmRlci50b1Rva2VuQWN0dWFsUXR5LCByZWZ1bmQsIHBhcnRpYWw6IHNvbGQgIT09IHJlcXVlc3RlZCB8fCByZWZ1bmQubGVuZ3RoID4gMCB9KTtcbiAgICAgIH1cbiAgICAgIGFwcGx5T25jZShTLCBldmVudCwgKHN0YXRlKSA9PiBwZXJzaXN0U3RhdGUoU1RBVEUsIHN0YXRlKSk7XG4gICAgfVxuICAgIFJFQ09WRVJZLmNsZWFyKFcuYWRkcik7XG4gICAgaWYgKHRlcm1pbmFsLmZhaWxlZCkgcmV0dXJuIHsgajogeyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IHsgbWVzc2FnZTogJ+WFjOaPm+ioguWWruW3sueiuuiqjeWkseaVlycgfSB9LCB0OiAn5YWM5o+b6KiC5Zau5bey56K66KqN5aSx5pWXJyB9O1xuICByZXR1cm4geyBqOiB7IHN1Y2Nlc3M6IHRydWUsIGRhdGE6IHRlcm1pbmFsLm9yZGVyIH0sIHQ6IEpTT04uc3RyaW5naWZ5KHRlcm1pbmFsLm9yZGVyKSB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBzd2FwQ29uZmlybWVkKFcsIGFyZ3MsIG1ldGFkYXRhID0geyBwdXJwb3NlOiAnZnVuZGluZycgfSkge1xuICBpZiAoUFJPSkVDVF9CVURHRVQucGVuZGluZ0VudHJpZXMoVy5hZGRyKS5sZW5ndGgpIHRocm93IG5ldyBFcnJvcign57WQ5p6c5LiN5piO77ya5ZCI57SE5Lqk5piT5LuN5b6F5oGi5b6p77yM56aB5q2i5YWM5o+bJyk7XG4gIGFjdGl2aXR5LmNvdW50Kys7XG4gIHRyeSB7IHJldHVybiBhd2FpdCBndWFyZGVkU3dhcCh7IGpvdXJuYWw6IFJFQ09WRVJZLCBsZWFzZTogV0FMTEVUX0xFQVNFLCB3YWxsZXQ6IFcuYWRkciwgYXJncywgbWV0YWRhdGEsXG4gICAgZ2V0QmxvY2s6ICgpID0+IHJwYygnZXRoX2Jsb2NrTnVtYmVyJywgW10pLCBzdWJtaXQ6IChhKSA9PiB3YWxsZXQuY2FsbChXLmFkZHIsIGEpLCBmaW5pc2g6ICgpID0+IGZpbmlzaFN3YXAoVykgfSk7IH1cbiAgZmluYWxseSB7IGFjdGl2aXR5LmNvdW50LS07IH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVjb3ZlcldhbGxldChXKSB7XG4gIHJldHVybiBXQUxMRVRfTEVBU0UucnVuKFcuYWRkciwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGpvYiA9IFJFQ09WRVJZLmdldChXLmFkZHIpOyBpZiAoIWpvYikgcmV0dXJuO1xuICAgIGlmIChqb2Iua2luZCA9PT0gJ3N3YXAnKSB7XG4gICAgICBhd2FpdCBmaW5pc2hTd2FwKFcsIHRydWUpOyByZXR1cm47XG4gICAgfVxuICAgIGF3YWl0IGNsZWFudXBTcGVuZGVyKFcsIGpvYi50b2tlbiwgam9iLnNwZW5kZXIpO1xuICAgIFJFQ09WRVJZLmNsZWFyKFcuYWRkcik7XG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWNvcmRGZWVSZWNlaXB0KHsgd2FsbGV0LCBwcm9qZWN0LCBtZXRhZGF0YSwgcmVjZWlwdCB9KSB7XG4gIGNvbnN0IGlkID0gYGZlZTo1Njoke3dhbGxldC50b0xvd2VyQ2FzZSgpfToke3JlY2VpcHQudHJhbnNhY3Rpb25IYXNofWA7XG4gIGlmIChTLmFwcGxpZWRFeGVjdXRpb25zPy5baWRdKSByZXR1cm47XG4gIGNvbnN0IGV2ZW50ID0gYXdhaXQgcHJlcGFyZUZlZUV2ZW50KHsgd2FsbGV0LCBwcm9qZWN0LCBtZXRhZGF0YSwgcmVjZWlwdCwgcnBjLCB0aW1lWm9uZTogQ09ORklHLnRpbWVab25lIHx8ICdBc2lhL1NoYW5naGFpJyB9KTtcbiAgYXBwbHlPbmNlKFMsIGV2ZW50LCAoc3RhdGUpID0+IHBlcnNpc3RTdGF0ZShTVEFURSwgc3RhdGUpKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gYWRvcHRDb25maXJtZWQoeyB3YWxsZXQsIHByb2plY3QsIHBlbmRpbmcsIHJlY2VpcHQgfSkge1xuICBpZiAocGVuZGluZy5tZXRhZGF0YT8ua2luZCA9PT0gJ3Blcm1pc3Npb24nKSByZXR1cm47XG4gIGNvbnN0IGlkID0gYG1pbnQ6JHt3YWxsZXR9OiR7cmVjZWlwdC50cmFuc2FjdGlvbkhhc2h9YDtcbiAgaWYgKFMuYXBwbGllZEV4ZWN1dGlvbnM/LltpZF0pIHtcbiAgICBpZiAoUy5hcHBsaWVkRXhlY3V0aW9uc1tpZF0gIT09IHJlY2VpcHQudHJhbnNhY3Rpb25IYXNoKSB0aHJvdyBuZXcgRXJyb3IoJ21pbnQgZXhlY3V0aW9uIGlkZW50aXR5IGNvbmZsaWN0Jyk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGV2ZW50ID0gYXdhaXQgcHJlcGFyZU1pbnRFdmVudCh7IHdhbGxldCwgcHJvamVjdCwgcGVuZGluZywgcmVjZWlwdCwgcnBjLFxuICAgIHN5bWJvbDogYXN5bmMgKHRva2VuKSA9PiB0b2tTdHIoYXdhaXQgY2FsbCh0b2tlbiwgJzB4OTVkODliNDEnKSkgfHwgdG9rZW4uc2xpY2UoMCwgMTApIH0pO1xuICBhcHBseU9uY2UoUywgZXZlbnQsIChzdGF0ZSkgPT4gcGVyc2lzdFN0YXRlKFNUQVRFLCBzdGF0ZSkpO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWNvdmVyQ29udHJhY3RNaW50cyhXKSB7XG4gIHJldHVybiBXQUxMRVRfTEVBU0UucnVuKFcuYWRkciwgYXN5bmMgKCkgPT4ge1xuICAgIGZvciAoY29uc3QgcGVuZGluZyBvZiBQUk9KRUNUX0JVREdFVC5wZW5kaW5nRW50cmllcyhXLmFkZHIpKSB7XG4gICAgICBhd2FpdCBleGVjdXRlR3VhcmRlZCh7IGJ1ZGdldDogUFJPSkVDVF9CVURHRVQsIHdhbGxldDogVy5hZGRyLCBwcm9qZWN0OiBwZW5kaW5nLnByb2plY3QsXG4gICAgICAgIGNlaWxpbmc6IDBuLCByZWNvdmVyT25seTogdHJ1ZSwgYXBwbHlDb25maXJtZWQ6IGFkb3B0Q29uZmlybWVkLCByZWNvcmRSZWNlaXB0OiByZWNvcmRGZWVSZWNlaXB0LCBycGMsIHNsZWVwLFxuICAgICAgICBzdWJtaXQ6IGFzeW5jICgpID0+IHsgdGhyb3cgbmV3IEVycm9yKCdyZWNvdmVyeSBtdXN0IG5vdCBzdWJtaXQnKTsgfSB9KTtcbiAgICB9XG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBzdWJtaXRDb250cmFjdChXLCB0bywgZGF0YSwgdmFsdWVXZWksIHJlcXVlc3RJZCwgc2ltKSB7XG4gIGNvbnRyYWN0SW50ZW50KHsgY2hhaW5JZDogJzU2Jywgd2FsbGV0OiBXLmFkZHIsIGNvbnRyYWN0OiB0bywgdmFsdWU6IHZhbHVlV2VpLnRvU3RyaW5nKCksIGlucHV0RGF0YTogZGF0YSB9KTtcbiAgcmV0dXJuIFdBTExFVF9MRUFTRS5ydW4oVy5hZGRyLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGpvYiA9IFJFQ09WRVJZLmdldChXLmFkZHIpO1xuICBjb25zdCB0YXJnZXQgPSBTdHJpbmcodG8pLnRvTG93ZXJDYXNlKCk7XG4gIGlmIChQUk9KRUNUX0JVREdFVC5wZW5kaW5nRW50cmllcyhXLmFkZHIpLnNvbWUoKHApID0+IHAucHJvamVjdCAhPT0gdGFyZ2V0ICYmIHAucHJvamVjdCAhPT0gKGpvYj8uc3BlbmRlciB8fCAnJykgJiYgcC5wcm9qZWN0ICE9PSAoL14weDA5NWVhN2IzWzAtOWEtZl17MTI4fSQvaS50ZXN0KGRhdGEgfHwgJycpID8gJzB4JyArIGRhdGEuc2xpY2UoMzQsIDc0KS50b0xvd2VyQ2FzZSgpIDogJycpKSkgdGhyb3cgbmV3IEVycm9yKCfntZDmnpzkuI3mmI7vvJrpjKLljIXmnInlhbbku5bmnKrnorroqo3kuqTmmJPvvIznpoHmraLmlrDkuqTmmJMnKTtcbiAgY29uc3QgYXBwcm92YWwgPSAvXjB4MDk1ZWE3YjNbMC05YS1mXXsxMjh9JC9pLnRlc3QoZGF0YSB8fCAnJyk7XG4gIGNvbnN0IHJldm9raW5nID0gYXBwcm92YWwgJiYgQmlnSW50KCcweCcgKyBkYXRhLnNsaWNlKDc0KSkgPT09IDBuO1xuICBpZiAoIXJldm9raW5nKSBhd2FpdCBlbmZvcmNlTWludFJpc2soYXBwcm92YWwgPyAnMHgnICsgZGF0YS5zbGljZSgzNCwgNzQpLnRvTG93ZXJDYXNlKCkgOiB0YXJnZXQpO1xuICBpZiAoYXBwcm92YWwgJiYgIXJldm9raW5nICYmICEoam9iPy5raW5kID09PSAnYXBwcm92YWwnICYmIGpvYi50b2tlbiA9PT0gdGFyZ2V0ICYmIGpvYi5zcGVuZGVyID09PSAnMHgnICsgZGF0YS5zbGljZSgzNCwgNzQpLnRvTG93ZXJDYXNlKCkpKSB0aHJvdyBuZXcgRXJyb3IoJ+aOiOasiuW/hemgiOeUseWPr+aBouW+qeeahOa4heeQhua1geeoi+euoeeQhicpO1xuICBpZiAoam9iICYmICFyZXZva2luZyAmJiAhKGpvYi5raW5kID09PSAnYXBwcm92YWwnICYmICh0YXJnZXQgPT09IGpvYi5zcGVuZGVyIHx8IGFwcHJvdmFsKSkpIHRocm93IG5ldyBFcnJvcign57WQ5p6c5LiN5piO77ya6Yyi5YyF5pyJ5b6F5riF55CG5pON5L2c77yM56aB5q2i5paw5Lqk5piTJyk7XG4gIGFjdGl2aXR5LmNvdW50Kys7XG4gIHRyeSB7XG4gICAgY29uc3QgYm91bmQgPSBhd2FpdCBjb250cmFjdFByaW5jaXBhbCh7XG4gICAgICB3YWxsZXQ6IFcuYWRkciwgdG8sIGRhdGEsIHZhbHVlOiB2YWx1ZVdlaSwgc2ltLCBtYXg6IFBST0pFQ1RfQlVER0VULm1heCxcbiAgICAgIGFsbG93YW5jZTogYXN5bmMgKHNwZW5kZXIpID0+IHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnBjKCdldGhfY2FsbCcsIFt7IHRvOiBVU0RULCBkYXRhOiAnMHhkZDYyZWQzZScgKyB3YShXLmFkZHIpICsgd2Eoc3BlbmRlcikgfSwgJ2xhdGVzdCddKTtcbiAgICAgICAgaWYgKCEvXjB4WzAtOWEtZl17NjR9JC9pLnRlc3QocmVzdWx0IHx8ICcnKSkgdGhyb3cgbmV3IEVycm9yKCdVU0RUIGFsbG93YW5jZSB1bmF2YWlsYWJsZScpO1xuICAgICAgICByZXR1cm4gQmlnSW50KHJlc3VsdCk7XG4gICAgICB9LFxuICAgICAgYm5iUHJpY2VNaWNyb3M6IGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgcHJpY2UgPSBhd2FpdCBibmJVc2QoKTtcbiAgICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUocHJpY2UpIHx8IHByaWNlIDw9IDApIHRocm93IG5ldyBFcnJvcignQk5CIHByaWNlIHVuYXZhaWxhYmxlJyk7XG4gICAgICAgIHJldHVybiBCaWdJbnQoTWF0aC5jZWlsKHByaWNlICogMWU2KSk7XG4gICAgICB9LFxuICAgIH0pO1xuICAgIGlmICghYXBwcm92YWwpIHtcbiAgICAgIGNvbnN0IHJlYXNvbiA9IGF3YWl0IHJpc2tCbG9jayhXLCB0YXJnZXQsIHZhbHVlV2VpLCBkYXRhLCBib3VuZC5jZWlsaW5nID09PSAwbiwgYm91bmQuY2VpbGluZyA+IDBuKTtcbiAgICAgIGlmIChyZWFzb24pIHRocm93IG5ldyBFcnJvcign6aKo5o6n5pSU5oiq77yaJyArIHJlYXNvbik7XG4gICAgfVxuICAgIHJldHVybiBhd2FpdCBleGVjdXRlR3VhcmRlZCh7XG4gICAgICBidWRnZXQ6IFBST0pFQ1RfQlVER0VULCB3YWxsZXQ6IFcuYWRkciwgLi4uYm91bmQsIHJwYywgc2xlZXAsXG4gICAgICBtZXRhZGF0YTogeyAuLi5taW50TWV0YWRhdGEoVy5hZGRyLCBXLm5hbWUsIHNpbSwgeyBwZXJtaXNzaW9uOiBhcHByb3ZhbCwgaG9sZDogRk9SQ0UuaGFzKHRhcmdldCkgfSksIGZyZWVNaW50OiAhYXBwcm92YWwgJiYgYm91bmQuY2VpbGluZyA9PT0gMG4gfSxcbiAgICAgIGFwcGx5Q29uZmlybWVkOiBhZG9wdENvbmZpcm1lZCwgcmVjb3JkUmVjZWlwdDogcmVjb3JkRmVlUmVjZWlwdCxcbiAgICAgIHN1Ym1pdDogKCkgPT4gd2FsbGV0LmNhbGwoVy5hZGRyLCBbJ2NvbnRyYWN0LWNhbGwnLCAnZXhlY3V0ZScsICctLXJlcXVlc3RJZCcsIHJlcXVlc3RJZF0pLFxuICAgIH0pO1xuICB9IGZpbmFsbHkgeyBhY3Rpdml0eS5jb3VudC0tOyB9XG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwcmV2aWV3RXhlYyhXLCB0bywgZGF0YSwgdmFsdWVXZWksIGNoZWNrLCByZWNoZWNrID0gbnVsbCkge1xuICBjb25zdCBpbnRlbnQgPSBjb250cmFjdEludGVudCh7IGNoYWluSWQ6ICc1NicsIHdhbGxldDogVy5hZGRyLCBjb250cmFjdDogdG8sIHZhbHVlOiB2YWx1ZVdlaS50b1N0cmluZygpLCBpbnB1dERhdGE6IGRhdGEgfSk7XG4gIGNvbnN0IHAgPSBhd2FpdCB3YWxsZXQuY2FsbChXLmFkZHIsIFsnY29udHJhY3QtY2FsbCcsICdwcmV2aWV3JywgJy0tYmluYW5jZUNoYWluSWQnLCAnNTYnLCAnLS1mcm9tJywgaW50ZW50LndhbGxldCwgJy0tdG8nLCBpbnRlbnQuY29udHJhY3QsICctLXZhbHVlJywgaW50ZW50LnZhbHVlLCAnLS1pbnB1dERhdGEnLCBpbnRlbnQuaW5wdXREYXRhXSk7XG4gIGNvbnN0IHNpbSA9IHAuaj8uZGF0YT8uc2ltdWxhdGlvblJlc3VsdCwgcmlkID0gcC5qPy5kYXRhPy5yZXF1ZXN0SWQ7XG4gIGlmICghcC5qPy5zdWNjZXNzIHx8ICFyaWQpIHRocm93IG5ldyBFcnJvcign6aCQ5ryU5aSx5pWXICcgKyAocC5qPy5lcnJvcj8ubWVzc2FnZSB8fCBwLnQpLnNsaWNlKDAsIDEyMCkpO1xuICBjb25zdCBmZyA9IGZsYXBHdWFyZCh0bywgZGF0YSwgc2ltKTsgaWYgKGZnKSB0aHJvdyBuZXcgRXJyb3IoJ+mgkOa8lOS4jeWuieWFqO+8micgKyBmZyk7XG4gIGNvbnN0IHdoeSA9IGNoZWNrKHNpbSk7IGlmICh3aHkpIHRocm93IG5ldyBFcnJvcign6aCQ5ryU5LiN5a6J5YWo77yaJyArIHdoeSk7XG4gIHsgY29uc3Qgb3V0Qm5iID0gKHNpbT8uYmFsYW5jZUNoYW5nZXMgfHwgW10pLmZpbHRlcigoYikgPT4gU3RyaW5nKGIub3duZXIpLnRvTG93ZXJDYXNlKCkgPT09IFcuYWRkciAmJiBTdHJpbmcoYi5jb250cmFjdEFkZHJlc3MgfHwgJycpLnRvTG93ZXJDYXNlKCkuc3RhcnRzV2l0aCgnMHhlZWVlJykgJiYgTnVtYmVyKGIuY2hhbmdlKSA8IDApLnJlZHVjZSgoYSwgYikgPT4gYSAtIE51bWJlcihiLmNoYW5nZSksIDApOyBpZiAob3V0Qm5iID4gTnVtYmVyKHZhbHVlV2VpKSAqIDEuMDAwMDAwMSArIDEpIHRocm93IG5ldyBFcnJvcign6aCQ5ryU5LiN5a6J5YWo77ya5pyD5omj55qEIEJOQiDmr5Toqqrlpb3nmoTlpJrvvIjpoqjmjqfvvIknKTsgfVxuICBpZiAocmVjaGVjaykgeyBjb25zdCByMiA9IGF3YWl0IHJlY2hlY2soKTsgaWYgKHIyKSB0aHJvdyBuZXcgRXJyb3IoJ+mAgeWHuuWJjeWGjeeiuuiqjeS4jemAmumBju+8micgKyByMik7IH0gLy8g6YCB5Ye65YmN5YaN56K66KqN5YO55qC877yI5a+p5p+l5bu66K2wIDXvvIlcbiAgY29uc3QgeyByZXN1bHQ6IHgsIHJlY2VpcHQgfSA9IGF3YWl0IHN1Ym1pdENvbnRyYWN0KFcsIHRvLCBkYXRhLCB2YWx1ZVdlaSwgcmlkLCBzaW0pO1xuICByZXR1cm4geyB0eDogeC5qLmRhdGEudHhIYXNoLCBzaW0sIHJlY2VpcHQgfTtcbn1cbiAgcmV0dXJuIHsgcmV2b2tlUGVybWlzc2lvbiwgcmVhZEFsbG93YW5jZSwgY2xlYW51cFNwZW5kZXIsIGFwcHJvdmVkTWludCwgZmluaXNoU3dhcCwgc3dhcENvbmZpcm1lZCwgcmVjb3ZlcldhbGxldCwgcmVjb3JkRmVlUmVjZWlwdCwgYWRvcHRDb25maXJtZWQsIHJlY292ZXJDb250cmFjdE1pbnRzLCBzdWJtaXRDb250cmFjdCwgcHJldmlld0V4ZWMgfTtcbn1cbiJdLCJtYXBwaW5ncyI6IkFBQUE7QUFDQSxTQUFTQSxjQUFjLFFBQVEscUNBQXFDO0FBQ3BFLFNBQVNDLGlC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

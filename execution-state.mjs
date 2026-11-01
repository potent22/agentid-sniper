import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`, fd = openSync(tmp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export const strategyKey = (wallet, token) => `${wallet.toLowerCase()}:${token.toLowerCase()}`;
export function unitsToDecimal(units, decimals) {
  if (typeof units !== 'bigint' || units < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('invalid token quantity');
  if (!decimals) return units.toString();
  const scale = 10n ** BigInt(decimals), fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (units / scale).toString() + (fraction ? '.' + fraction : '');
}

// Prepare and durably save a full state before updating live references. If the
// write fails, the execution journal remains outstanding and live state is intact.
export function applyOnce(state, event, persist) {
  if (!event || typeof event.id !== 'string' || !event.id || !/^0x[0-9a-f]{64}$/i.test(event.txHash || '')) throw new Error('invalid execution event');
  const old = state.appliedExecutions?.[event.id];
  if (old) {
    if (old !== event.txHash) throw new Error('execution identity conflicts with prior transaction');
    return false;
  }
  const next = structuredClone(state);
  next.tokens ||= {}; next.trades ||= []; next.dyn ||= [];
  if (event.kind === 'sale') {
    const m = event.metadata, key = strategyKey(event.wallet, m.token);
    if (!Number.isFinite(m.bnbPrice) || m.bnbPrice <= 0) throw new Error('sale reporting price unavailable');
    const st = next.tokens[key] ||= structuredClone(m.strategyState || { hist: [], sold: 0 });
    st.stateKey = key; st.sellFail = 0; st.lastBal = event.remainingRaw;
    if (event.partial) {
      st.review = '部分成交，需核對剩餘賣出計劃';
    } else {
      const e = m.effect || {};
      for (const field of ['stage', 'done', 'sellNowDone', 'moonPend']) if (e[field] !== undefined) st[field] = e[field];
      if (e.mark) { st.done2 ||= []; if (!st.done2.includes(e.mark)) st.done2.push(e.mark); }
    }
    next.trades.push({ executionId: event.id, txHash: event.txHash, orderId: event.orderId,
      sym: m.sym, w: m.walletName, bnb: Number(event.received), received: event.received,
      usd: Number(event.received) * m.bnbPrice, valuation: 'pre-submission estimate', at: event.at,
      cost: m.cost || 0, why: m.why,
      soldRaw: event.soldRaw, remainingRaw: event.remainingRaw, partial: event.partial, refund: event.refund || [] });
  } else if (event.kind === 'mint') {
    for (const token of event.tokens) {
      const current = next.dyn.find((t) => t.addr === token.addr && t.only === event.wallet);
      if (current) { current.cost = (current.cost || 0) + token.cost; current.costBasis = 'budget-ceiling'; }
      else next.dyn.push({ ...token, only: event.wallet, boughtAt: event.at, costBasis: 'budget-ceiling' });
      const key = strategyKey(event.wallet, token.addr), st = next.tokens[key] ||= { hist: [], peak: 0, peakAt: 0, sold: 0 };
      st.stateKey = key; st.lastBal = token.confirmedBalanceRaw;
      if (st.stage >= 9 || st.done2?.length) st.review = '已有交易後再次取得資產，需核對成本與策略';
    }
    next.nftCols ||= {};
    for (const token of event.nfts) next.nftCols[token] = 1;
    next.mintExecutions ||= {};
    next.mintExecutions[event.id] = { txHash: event.txHash, project: event.project, wallet: event.wallet,
      costMicros: event.costMicros, costBasis: 'budget-ceiling', tokens: event.tokens, nfts: event.nftProof, at: event.at };
    next.paid ||= {}; next.paid[event.project] ||= { at: event.at, name: '', done: {} };
    next.paid[event.project].done ||= {};
    next.paid[event.project].done[event.walletName] = event.costMicros === '0' ? 'free' : 'minted';
  } else if (event.kind === 'fee') {
    next.feeReceipts ||= {}; next.feeReceipts[event.id] = event;
    next.feeDays ||= {}; next.feeDays[event.day] ||= {};
    const day = next.feeDays[event.day][event.wallet] ||= { gasWei: '0', failedProjects: {}, freeProjects: [] };
    day.gasWei = (BigInt(day.gasWei) + BigInt(event.walletGasWei)).toString();
    if (event.mint && event.status === '0x0') day.failedProjects[event.project] = (day.failedProjects[event.project] || 0) + 1;
    if (event.freeMint && event.status === '0x1' && !day.freeProjects.includes(event.project)) day.freeProjects.push(event.project);
  } else if (event.kind !== 'funding') throw new Error('unsupported execution event');
  next.appliedExecutions ||= {}; next.appliedExecutions[event.id] = event.txHash;
  persist(next);
  // Keep references held by the strategy loop valid after the durable commit.
  const tokens = state.tokens ||= {};
  for (const [key, value] of Object.entries(next.tokens)) {
    if (tokens[key]) Object.assign(tokens[key], value); else tokens[key] = value;
  }
  Object.assign(state, next, { tokens });
  return true;
}

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export function tokenNet(receipt, wallet, token) {
  if (!Array.isArray(receipt.logs)) throw new Error('receipt logs unavailable');
  const owner = wallet.toLowerCase().slice(2).padStart(64, '0'); let net = 0n;
  for (const log of receipt.logs) {
    if (String(log.address).toLowerCase() !== token.toLowerCase() || log.topics?.[0]?.toLowerCase() !== TRANSFER) continue;
    if (log.removed || log.topics.length !== 3 || !/^0x[0-9a-f]{64}$/i.test(log.data || '') || !log.topics.slice(1).every((t) => /^0x0{24}[0-9a-f]{40}$/i.test(t))) throw new Error('unsupported token transfer event');
    const value = BigInt(log.data);
    if (log.topics[1].slice(2).toLowerCase() === owner) net -= value;
    if (log.topics[2].slice(2).toLowerCase() === owner) net += value;
  }
  return net;
}

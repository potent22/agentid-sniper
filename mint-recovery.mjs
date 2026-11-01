import { tokenNet } from './execution-state.mjs';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const word = (a) => a.toLowerCase().slice(2).padStart(64, '0');
const uint = (value) => {
  if (!/^0x[0-9a-f]{64}$/i.test(value || '')) throw new Error('confirmed ownership data unavailable');
  return BigInt(value);
};

// Store only expected asset identities, not optimistic simulated quantities.
export function mintMetadata(wallet, walletName, sim, { permission = false, hold = false } = {}) {
  if (permission) return { kind: 'permission' };
  const expected = new Map();
  for (const b of sim?.balanceChanges || []) {
    if (String(b.owner).toLowerCase() !== wallet.toLowerCase()) continue;
    const token = String(b.contractAddress).toLowerCase();
    if (!ADDRESS.test(token) || [NATIVE, USDT, WBNB].includes(token)) continue;
    if (!/^-?\d+$/.test(String(b.change)) || BigInt(b.change) < 0n) continue;
    if (b.tokenType === 'Erc20' && BigInt(b.change) === 0n) continue;
    if (!['Erc20', 'Erc721'].includes(b.tokenType)) throw new Error('unsupported mint asset type; manual verification required');
    if (expected.has(token) && expected.get(token).type !== b.tokenType) throw new Error('conflicting mint asset types');
    expected.set(token, { token, type: b.tokenType });
  }
  if (!expected.size) throw new Error('no verifiable expected mint assets; separate flow required');
  return { kind: 'mint', walletName, expected: [...expected.values()], hold, at: Date.now() };
}

export async function prepareMintEvent({ wallet, project, pending, receipt, rpc, symbol = async (a) => a.slice(0, 10) }) {
  const meta = pending.metadata;
  if (meta?.kind !== 'mint' || !meta.walletName || !Array.isArray(meta.expected) || !meta.expected.length) throw new Error('mint recovery metadata unavailable');
  if (receipt.status !== '0x1' || !Array.isArray(receipt.logs)) throw new Error('confirmed mint receipt unavailable');
  const tokens = [], nfts = [], proof = [];
  for (const asset of meta.expected) {
    if (!ADDRESS.test(asset.token)) throw new Error('invalid expected asset');
    if (asset.type === 'Erc20') {
      const received = tokenNet(receipt, wallet, asset.token);
      if (received <= 0n) throw new Error('expected token receipt does not prove a positive net receipt');
      const balance = uint(await rpc('eth_call', [{ to: asset.token, data: '0x70a08231' + word(wallet) }, receipt.blockNumber]));
      tokens.push({ addr: asset.token, sym: String(await symbol(asset.token)).slice(0, 100), receivedRaw: received.toString(), confirmedBalanceRaw: balance.toString(), hold: meta.hold });
    } else if (asset.type === 'Erc721') {
      const owned = new Map();
      for (const log of receipt.logs) {
        if (String(log.address).toLowerCase() !== asset.token || log.topics?.[0]?.toLowerCase() !== TRANSFER) continue;
        if (log.removed || log.topics.length !== 4 || !log.topics.slice(1, 3).every((x) => /^0x0{24}[0-9a-f]{40}$/i.test(x)) || !/^0x[0-9a-f]{64}$/i.test(log.topics[3])) throw new Error('invalid NFT transfer proof');
        const from = log.topics[1].slice(26).toLowerCase(), to = log.topics[2].slice(26).toLowerCase();
        if (to === wallet.toLowerCase().slice(2) || from === wallet.toLowerCase().slice(2)) owned.set(log.topics[3], to === wallet.toLowerCase().slice(2));
      }
      const ids = [...owned.entries()].filter(([, yes]) => yes).map(([id]) => id);
      if (!ids.length) throw new Error('NFT receipt does not prove ownership');
      for (const id of ids) {
        const owner = await rpc('eth_call', [{ to: asset.token, data: '0x6352211e' + id.slice(2) }, receipt.blockNumber]);
        if (!/^0x0{24}[0-9a-f]{40}$/i.test(owner || '') || owner.slice(26).toLowerCase() !== wallet.toLowerCase().slice(2)) throw new Error('NFT confirmed owner mismatch');
      }
      nfts.push(asset.token); proof.push({ token: asset.token, ids: ids.map((id) => BigInt(id).toString()) });
    } else throw new Error('unsupported mint recovery asset');
  }
  const cost = BigInt(pending.ceiling), share = tokens.length ? cost / BigInt(tokens.length) : 0n;
  tokens.forEach((t, index) => { t.cost = Number(share + (index === 0 ? cost - share * BigInt(tokens.length) : 0n)) / 1e6; });
  return { kind: 'mint', id: `mint:${wallet}:${receipt.transactionHash}`, txHash: receipt.transactionHash,
    wallet, walletName: meta.walletName, project, costMicros: pending.ceiling, tokens, nfts, nftProof: proof, at: meta.at };
}

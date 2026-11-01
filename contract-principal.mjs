const USDT = '0x55d398326f99059ff775485246999027b3197955';
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ceilDiv = (a, b) => (a + b - 1n) / b;
const asUnits = (value) => {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) throw new Error('unverifiable simulation amount');
  return BigInt(value);
};

export async function contractPrincipal({ wallet, to, data, value, sim, allowance, bnbPriceMicros, max }) {
  wallet = wallet.toLowerCase(); to = to.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet) || !/^0x[0-9a-f]{40}$/.test(to) || typeof value !== 'bigint' || value < 0n) throw new Error('invalid contract identity or value');
  if (!sim || !Array.isArray(sim.balanceChanges)) throw new Error('simulation balances missing');
  const approve = /^0x095ea7b3[0-9a-f]{128}$/i.test(data || '');
  if (approve) {
    const spender = '0x' + data.slice(34, 74).toLowerCase();
    const limit = BigInt('0x' + data.slice(74));
    if (value !== 0n || (limit > 0n && to !== USDT) || ceilDiv(limit, 10n ** 12n) > max) throw new Error('approval outside supported budget');
    if (sim.balanceChanges.some((b) => String(b.owner).toLowerCase() === wallet && asUnits(b.change) < 0n)) throw new Error('approval would spend assets');
    if (sim.authorityChanges?.length) throw new Error('unexpected authority change');
    if ((sim.allowanceChanges || []).some((a) => String(a.spender).toLowerCase() !== spender)) throw new Error('unexpected approval spender');
    return { project: spender, ceiling: 0n };
  }
  if (sim.authorityChanges?.length || sim.allowanceChanges?.length) throw new Error('unexpected permission change');
  let simulatedUsdt = 0n, simulatedBnb = 0n;
  for (const b of sim.balanceChanges) {
    if (String(b.owner).toLowerCase() !== wallet) continue;
    const change = asUnits(b.change);
    if (change >= 0n) continue;
    const token = String(b.contractAddress).toLowerCase();
    if (token === USDT) simulatedUsdt -= change;
    else if (token === NATIVE) simulatedBnb -= change;
    else throw new Error('unexpected payment token');
  }
  if (simulatedBnb > value) throw new Error('BNB debit exceeds transaction value');
  const usdt = await allowance(to);
  if (typeof usdt !== 'bigint' || usdt < 0n || simulatedUsdt > usdt) throw new Error('USDT spend cannot be bounded by allowance');
  let native = 0n;
  if (value > 0n) {
    const price = await bnbPriceMicros();
    if (typeof price !== 'bigint' || price <= 0n) throw new Error('BNB price unavailable');
    native = ceilDiv(value * price, 10n ** 18n);
  }
  const ceiling = native + ceilDiv(usdt, 10n ** 12n);
  if (ceiling > max) throw new Error('project budget exceeded');
  return { project: to, ceiling };
}

export function createPaymentRules({ call, codeOf, fullCode, keccakHex }) {
  const names = ['maxPerWallet', 'maxMintPerWallet', 'MAX_PER_WALLET', 'MAX_MINT_PER_WALLET', 'maxPerAddress', 'MAX_PER_ADDRESS', 'maxMintsPerWallet', 'walletLimit', 'mintLimit', 'perWalletLimit', 'maxPerUser', 'maxPerAccount', 'maxMintPerAddress', 'MAX_MINT_PER_ADDRESS', 'maxMintAmountPerWallet', 'maxPerAgent', 'MAX_PER_AGENT', 'maxUnitsPerWallet', 'MAX_UNITS_PER_WALLET', 'maxMintPerAgent', 'quotaPerAgent', 'baseQuota', 'BASE_QUOTA', 'maxPerID', 'perAddressLimit', 'MAX_PER_TX', 'maxPerTx', 'maxMintPerTx', 'MAX_MINT_PER_TX', 'maxMintAmountPerTx', 'maxPerTransaction'];
  async function walletLimit(contract) {
    const code = await fullCode(contract, await codeOf(contract));
    for (const name of names) {
      const selector = keccakHex(Buffer.from(name + '()').toString('hex')).slice(0, 8);
      if (!code.includes(selector)) continue;
      const result = await call(contract, '0x' + selector);
      if (!/^0x[0-9a-f]{64}$/i.test(result || '')) continue;
      const limit = BigInt(result);
      if (limit >= 1n && limit <= 10000n) return Number(limit);
    }
    return 0;
  }
  return { walletLimit };
}

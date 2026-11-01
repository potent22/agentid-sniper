import { createPaymentRules } from './modules/payment-rules.mjs';
import { createChainValues } from './modules/chain-values.mjs';
import { createConfiguration } from './modules/configuration.mjs';
import { createRpc } from './modules/rpc.mjs';
import { createContracts } from './modules/contracts.mjs';
import { createMarketData } from './modules/market-data.mjs';
import { createProjectRisk } from './modules/project-risk.mjs';
import { createNotifications } from './modules/notifications.mjs';
import { createDiscovery } from './modules/discovery.mjs';
import { createMinting } from './modules/minting.mjs';
import { createTransactions } from './modules/transactions.mjs';
import { createPortfolio } from './modules/portfolio.mjs';
import { createReports } from './modules/reports.mjs';
import { createAccount } from './modules/account.mjs';
import { createCommands } from './modules/commands.mjs';
// Only this composition root knows the legacy function graph. Modules receive
// explicit dependencies, never the registry itself. Forwarders resolve cycles
// between notifications, discovery and strategy functions after construction.
export function composeModules(base) {
  const registry = { ...base }, required = new Set();
  const wire = (factory, names) => {
    const deps = {};
    for (const name of names) {
      required.add(name);
      deps[name] = name in registry ? registry[name] : (...args) => {
        if (typeof registry[name] !== 'function') throw new Error('Unresolved module dependency: ' + name);
        return registry[name](...args);
      };
      if (name === 'wallet') deps.wallet = factory === createTransactions ? base.wallet : factory === createAccount ? base.walletSession : base.walletRead;
    }
    const module = factory(deps);
    for (const name of Object.keys(module)) {
      if (name in registry) throw new Error('Duplicate module export: ' + name);
      Object.defineProperty(registry, name, { enumerable: true, get: () => module[name] });
    }
  };
  wire(createChainValues, []);
  wire(createConfiguration, ["CONFIG","configuredBudget","S","save"]);
  wire(createRpc, ["CONFIG","fetchImpl"]);
  wire(createContracts, ["REGISTRY","S","T_TRANSFER","USDT","WALLETS","WBNB","big","call","log","logsRpc","rpc","w","wa"]);
  wire(createPaymentRules, ["call","codeOf","fullCode","keccakHex"]);
  wire(createMarketData, ["S","tg","FACTORY","ROUTER","T_SWAP","T_TRANSFER","USD1","USDT","WBNB","call","cc","rpc","w","wa","fetchImpl"]);
  wire(createProjectRisk, ["CONFIG","FACTORY","FLAP_BAN","FLAP_BLOCK","PAID","RISK","S","USDT","WALLETS","WBNB","big","call","codeOf","fullCode","log","rpc","tg","tokStr","ts","w","wa"]);
  wire(createNotifications, ["CONFIG","S","WALLETS","deployerOf","lockNote","log","riskNote","sleep","ts","fetchImpl"]);
  wire(createDiscovery, ["noteTransactions","activity","CANDS","INFRA","ME","NEAR_FREE","REGISTRY","RPCS","S","T_TRANSFER","WALLETS","badSel","call","findFree","fullCode","heatTier","keccakHex","learnReplay","log","logsRpc","noteDeploy","noteDev","queueMint","rpc","rpcBatch","scheduler","tg","tokStr","ts","wa","fetchImpl"]);
  wire(createMinting, ["walletLimit","activity","AG_MIN","CANDS","CONFIG","FACTORY","FORCE","GO_PCT","HOT","INFRA","NATIVE_BNB","PAID","REFUND_SELS","S","T_TRANSFER","USDT","WALLETS","WBNB","approvedMint","badSel","big","bnbUsd","call","cc","codeOf","deployerOf","enforceMintRisk","findCapSel","findFree","fitShares","flapGuard","fpCache","freeProgress","freshDeadline","freshWallet","fullCode","groupProgress","isRepeatDev","isSerial","learnReplay","log","noteDev","poolOpen","poolOut","previewExec","progressOf","repeatDevOk","riskBlock","rpc","ruleTxt","safeAddrs","scaleV","serialDev","sleep","submitContract","swapConfirmed","tg","tokStr","ts","upgradeable","w","wa","wallet","defer"]);
  wire(createTransactions, ["walletLimit","CONFIG","FORCE","PROJECT_BUDGET","RECOVERY","S","STATE","USDT","WALLET_LEASE","activity","bnbUsd","call","enforceMintRisk","flapGuard","riskBlock","rpc","sleep","tokStr","w","wa","wallet"]);
  wire(createPortfolio, ["LOG","ME","NATIVE_BNB","RULE","S","TOKENS","WALLETS","big","blacklist","bnbUsd","call","findPair","flow","honeypotCheck","log","rpc","ruleTxt","save","swapConfirmed","tg","tgSay","tokDec","ts","valueUsd","wa"]);
  wire(createReports, ["CONFIG","LOG","PAID","S","T_TRANSFER","UPD","USDT","WALLETS","call","cmdStats","decStrAt","groupProgress","log","rpc","save","sleep","tg","tgSay","tokStr","ts","w","wa","fetchImpl"]);
  wire(createAccount, ["revokePermission","CONFIG","FLAP_BAN","FLAP_BLOCK","S","WALLETS","tg","wallet"]);
  wire(createCommands, ["revokePermission","DIR","GROUP_ID","NATIVE_BNB","S","TG","UPD","USDT","WALLETS","approvedMint","big","bnbUsd","call","cmdBalance","cmdSell","cmdStats","enforceMintRisk","holdReport","log","previewExec","save","sleep","swapConfirmed","tgSay","w","wa","wallet","fetchImpl","activity"]);
  for (const name of required) if (!(name in registry)) throw new Error('Missing dependency: ' + name);
  return registry;
}

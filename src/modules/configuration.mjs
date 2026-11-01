// Module: configuration. Construction is inert; I/O is invoked explicitly.

export function createConfiguration(dependencies) {
  const {
    CONFIG,
    configuredBudget, S = {}, save = () => {}, random = Math.random
  } = dependencies;
  const TOKENS = (CONFIG.tokens || []).map(t => ({
    ...t,
    addr: t.addr.toLowerCase()
  }));
  const ruleTxt = () => `${RULE.backX} 倍回本、${(RULE.steps || []).map(([x, p]) => `${x} 倍賣 ${p}%`).join('、')}；回本前從最高回落 ${Math.round(RULE.crash * 100)}% 全賣，回本後回落 ${Math.round((RULE.crashAfterBack || RULE.crash) * 100)}% 才賣${RULE.moonPct ? `，並留 ${RULE.moonPct}% 長抱只通知` : ''}`;
  const RULE = {
    // 使用者 11/1 00:30 改的付費幣規則（到價就執行）：2 倍 → 賣回本錢；10 倍 → 賣剩下的 30%；20 倍 → 再賣剩下的 50%；其餘不動，從最高點回落 40% → 全部賣
    backX: 2,
    steps: [[10, 30], [20, 50]],
    crash: 0.4,
    crashAfterBack: 0.6,
    moonPct: 20,
    moonNotifyX: [50, 100],
    // 使用者 11/1 13:54：回本後回落門檻放寬到 60%；回本後留 20% 長抱，不自動賣，只在 50／100 倍通知
    fastMin: 30,
    fastCrash: 0.4,
    // 開池 30 分鐘內檢查得比較密（回落門檻一樣 40%）
    stallSec: 300,
    drop: 0.5,
    // 免費幣：從最高回落 50% 全賣（不變）
    notifyX: [5, 10, 20],
    ...(CONFIG.rules || {})
  };
  const FORCE = new Set((CONFIG.forceMint || []).map(a => a.toLowerCase()));
  const PAID = {
    goPct: 0.8,
    earlyPct: 0.8,
    riseDelta: 0.02,
    maxUsd: configuredBudget,
    maxBnbPerDay: CONFIG.paid?.maxBnbPerDay ?? 1e9,
    // 使用者說不管怎樣就打 → 不設每日上限（只受錢包餘額限制）
    minSold: 30,
    // 至少已經有 30 份被別人鑄過才跟（避開沒人理的／陷阱合約）
    maxAgeH: 168,
    // 發現後 48 小時內還沒開就放棄
    keepBnb: CONFIG.paid?.keepBnb ?? 0.006 // 錢包至少留這麼多 BNB 當 gas
  };
  const FLAP_BLOCK = new Set(['0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0', '0x90497450f2a706f1951b5bdda52b4e5d16f34c06', '0x18aa6c93f1887a243fdc348c9a77f5136555174a', '0x8b4329947e34b6d56d71a3385cac122bade7d78d', '0x5dd913731c12ad8df3e574859fde45412bf4aad9']);
  const FLAP_BAN = false;
  if (!S.entryThresholds || S.entryThresholds.version !== 1) {
    S.entryThresholds = { version: 1, progress: Math.round((0.6 + random() * 0.1) * 1000) / 1000, agents: 100 + Math.min(30, Math.floor(random() * 31)) };
    save();
  }
  const { progress: GO_PCT, agents: AG_MIN } = S.entryThresholds;
  if (!(GO_PCT >= 0.6 && GO_PCT <= 0.7 && Number.isInteger(AG_MIN) && AG_MIN >= 100 && AG_MIN <= 130)) throw new Error('Invalid persisted entry thresholds');
  const RISK = {
    dayBnb: 0.01,
    freePerDay: 20,
    gasMax: 0.0003,
    gasMaxPaid: 0.001,
    revMax: 2
  };
  return {
    get TOKENS() {
      return TOKENS;
    },
    get RULE() {
      return RULE;
    },
    get ruleTxt() {
      return ruleTxt;
    },
    get FORCE() {
      return FORCE;
    },
    get PAID() {
      return PAID;
    },
    get AG_MIN() {
      return AG_MIN;
    },
    get GO_PCT() {
      return GO_PCT;
    },
    get RISK() {
      return RISK;
    },
    get FLAP_BLOCK() {
      return FLAP_BLOCK;
    },
    get FLAP_BAN() {
      return FLAP_BAN;
    }
  };
}

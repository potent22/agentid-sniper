// Explicit evidence is required; an absent historical record is not clearance.
export function mintRiskDecision({ developer, code, blacklisted, serial, deploymentCoverageComplete, rugHistoryVerified }) {
  if (blacklisted) return '開發者在風險黑名單';
  if (serial) return '同款合約 24 小時內部署至少三次';
  if (!/^0x[0-9a-f]{40}$/i.test(developer || '')) return '無法核實部署者';
  if (!/^0x[0-9a-f]+$/i.test(code || '') || code.length <= 2) return '無法核實合約代碼';
  if (deploymentCoverageComplete !== true) return '同款合約 24 小時部署記錄尚未完整核實';
  if (rugHistoryVerified !== true) return '開發者歷史 rug 記錄尚未完整核實';
  return '';
}

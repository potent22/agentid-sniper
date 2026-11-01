// Known observations are still mandatory blocks. Missing historical coverage
// is allowed by the owner, but is NOT evidence that a project is safe.
export function mintRiskDecision({ developer, code, blacklisted, serial }) {
  if (blacklisted) return '開發者在風險黑名單';
  if (serial) return '同款合約 24 小時內部署至少三次';
  if (!/^0x[0-9a-f]{40}$/i.test(developer || '')) return '無法核實部署者';
  if (!/^0x[0-9a-f]+$/i.test(code || '') || code.length <= 2) return '無法核實合約代碼';
  return '';
}

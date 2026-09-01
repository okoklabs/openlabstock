export const EXPIRY_WARNING_DAYS = 30;
const DAY_MS = 86_400_000;

function normalizedWarningDays(value) {
  const days = Number(value);
  return Number.isFinite(days) && days >= 0 ? Math.min(3650, Math.floor(days)) : EXPIRY_WARNING_DAYS;
}

export function normalizeExpiryDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('有效期必须使用 YYYY-MM-DD 格式');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 9999) throw new Error('有效期年份应为 2000-9999');
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error('有效期日期无效');
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function inventoryExpiryInfo(expiryDate, nowMs = Date.now(), warningDays = EXPIRY_WARNING_DAYS) {
  const normalized = normalizeExpiryDate(expiryDate);
  if (!normalized) return { status: 'none', daysRemaining: null, expiryDate: '' };
  const [year, month, day] = normalized.split('-').map(Number);
  const expiryEnd = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  const today = new Date(nowMs);
  const todayStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const expiryStart = Date.UTC(year, month - 1, day);
  const daysRemaining = Math.round((expiryStart - todayStart) / DAY_MS);
  const warningWindow = normalizedWarningDays(warningDays);
  const status = nowMs > expiryEnd
    ? 'expired'
    : warningWindow > 0 && daysRemaining <= warningWindow
      ? 'expiring'
      : 'normal';
  return { status, daysRemaining, expiryDate: normalized };
}

// All amounts are stored as integer cents to avoid floating point drift.

export function parseAmount(text) {
  if (text == null) return null;
  let cleaned = String(text).replace(/k(?:sh|es)\.?/i, '').replace(/[,\s]/g, '');
  // Accounting style negatives: (500.00)
  const negative = /^\(.*\)$/.test(cleaned);
  cleaned = cleaned.replace(/[()]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = negative ? -Number(cleaned) : Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function formatKsh(cents, { sign = false } = {}) {
  const value = (cents || 0) / 100;
  const abs = Math.abs(value).toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const prefix = value < 0 ? '-' : sign && value > 0 ? '+' : '';
  return `${prefix}Ksh ${abs}`;
}

export function toPlain(cents) {
  return ((cents || 0) / 100).toFixed(2);
}

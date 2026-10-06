// Accounts ("wallets"): your personal M-Pesa, any other M-Pesa lines (SIMs)
// you own, and any Till, Paybill or Pochi la Biashara. Each keeps its own
// transactions and budgets; "All my M-Pesa lines" views your lines together.

import { normalizePhone, phonesMatch } from './people.js';

export const PERSONAL = 'personal';
export const ALL_LINES = 'all-lines';
// Kinds that are your own personal M-Pesa numbers.
export const LINE_KINDS = new Set(['personal', 'line']);

export const WALLET_KINDS = {
  personal: 'Personal M-Pesa',
  line: 'Another M-Pesa line (SIM)',
  till: 'Till (Buy Goods)',
  paybill: 'Paybill',
  pochi: 'Pochi la Biashara',
};

export const DEFAULT_WALLETS = [{ id: PERSONAL, name: 'Personal M-Pesa', kind: 'personal' }];

// Transaction types that only appear on a business account.
export const BUSINESS_TYPES = new Set(['business_received', 'settlement', 'payout']);

export function walletOf(tx) {
  return tx.wallet || PERSONAL;
}

// Transactions that only come from statements you have disabled are left out.
// Pass { includeDisabled: true } to get everything.
export function walletTxs(state, walletId, { includeDisabled = false } = {}) {
  const off = includeDisabled ? null : disabledStatementIds(state);
  const ids = walletId === ALL_LINES ? new Set(personalLines(state).map((w) => w.id)) : new Set([walletId]);
  return state.transactions.filter((t) => ids.has(walletOf(t)) && (!off || isActive(t, off)));
}

export function personalLines(state) {
  return state.wallets.filter((w) => LINE_KINDS.has(w.kind));
}

export function isLine(wallet) {
  return Boolean(wallet) && LINE_KINDS.has(wallet.kind);
}

// Which accounts a view covers: one account, or all your lines together.
export function walletIdsOf(state, walletId) {
  return walletId === ALL_LINES ? personalLines(state).map((w) => w.id) : [walletId];
}

// Your line whose number matches (masked numbers allowed), if any.
export function lineForPhone(state, phone) {
  const p = normalizePhone(phone);
  if (!p) return null;
  const hits = personalLines(state).filter((w) => w.phone && phonesMatch(normalizePhone(w.phone), p));
  return hits.length === 1 ? hits[0] : null;
}

export function disabledStatementIds(state) {
  return new Set((state.statements || []).filter((s) => s.disabled).map((s) => s.id));
}

const STATEMENT_SOURCES = new Set(['statement', 'csv']);

export function isActive(tx, disabledIds) {
  if (!disabledIds.size || !tx.statements?.length) return true;
  if (!STATEMENT_SOURCES.has(tx.source)) return true; // also came from SMS, Daraja or by hand
  return tx.statements.some((id) => !disabledIds.has(id));
}

export function getWallet(state, walletId) {
  if (walletId === ALL_LINES && personalLines(state).length > 1) {
    return { id: ALL_LINES, kind: 'personal', name: 'All my M-Pesa lines', virtual: true };
  }
  return state.wallets.find((w) => w.id === walletId) || state.wallets[0];
}

export function businessWallets(state) {
  return state.wallets.filter((w) => !LINE_KINDS.has(w.kind));
}

// Personal budgets keep their original location for backwards compatibility.
export function budgetsFor(state, walletId) {
  if (walletId === PERSONAL) return state.budgets;
  state.walletBudgets ||= {};
  return (state.walletBudgets[walletId] ||= {});
}

export function addWallet(state, { name, kind, shortcode, phone }) {
  if (kind === 'line') {
    const number = normalizePhone(phone || shortcode);
    let id = `line-${number || Date.now().toString(36)}`;
    for (let n = 2; state.wallets.some((w) => w.id === id); n++) id = `line-${number}-${n}`;
    const wallet = { id, name: String(name || '').trim() || `Line ${number}`, kind: 'line', phone: number };
    state.wallets.push(wallet);
    return wallet;
  }
  const code = String(shortcode || '').replace(/\D/g, '');
  const base = `biz-${code || Date.now().toString(36)}`;
  let id = base;
  for (let n = 2; state.wallets.some((w) => w.id === id); n++) id = `${base}-${n}`;
  const wallet = { id, name: name.trim() || WALLET_KINDS[kind], kind, shortcode: code };
  state.wallets.push(wallet);
  return wallet;
}

export function removeWallet(state, walletId) {
  if (walletId === PERSONAL) return;
  state.wallets = state.wallets.filter((w) => w.id !== walletId);
  state.transactions = state.transactions.filter((t) => walletOf(t) !== walletId);
  if (state.walletBudgets) delete state.walletBudgets[walletId];
  state.bills = (state.bills || []).filter((b) => (b.wallet || PERSONAL) !== walletId);
  state.statements = (state.statements || []).filter((s) => (s.wallet || PERSONAL) !== walletId);
  if (state.settings?.currentWallet === walletId) state.settings.currentWallet = PERSONAL;
}

export function walletLabel(w) {
  if (!w) return 'Personal M-Pesa';
  if (LINE_KINDS.has(w.kind)) return `${w.name}${w.phone ? ` · ${w.phone}` : ''}`;
  const kind = { till: 'Till', paybill: 'Paybill', pochi: 'Pochi' }[w.kind] || 'Business';
  return `${w.name}${w.shortcode ? ` · ${kind} ${w.shortcode}` : ` · ${kind}`}`;
}

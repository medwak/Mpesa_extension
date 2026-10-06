// Persistence. Uses chrome.storage.local inside the extension and falls back
// to localStorage so the dashboard also works as a plain web page.
// Data stays on this device. The only network use is the optional Daraja
// relay you set up yourself for a business account.

import { DEFAULT_CATEGORIES, DEFAULT_RULES, categorize } from './categories.js';
import { mergeTransactions, walletEffect } from './ledger.js';
import { DEFAULT_WALLETS, PERSONAL, ALL_LINES, BUSINESS_TYPES, businessWallets, personalLines, isLine, getWallet, walletOf } from './wallets.js';

const KEY = 'mpesaLedger';
const ADDED_IN_V2 = ['Sales & collections', 'Supplier payments', 'Salaries & wages', 'Business payouts', 'Settlement to bank'];

export function defaultState() {
  return {
    version: 2,
    transactions: [],
    categories: structuredClone(DEFAULT_CATEGORIES),
    rules: structuredClone(DEFAULT_RULES),
    budgets: {},
    wallets: structuredClone(DEFAULT_WALLETS),
    walletBudgets: {},
    bills: [],
    statements: [],
    settings: { currentWallet: PERSONAL },
    seenDefaultCategories: DEFAULT_CATEGORIES.map((c) => c.name),
  };
}

// Brings data saved by older versions up to date without losing anything.
export function migrate(saved) {
  const state = { ...defaultState(), ...(saved || {}) };
  if (!state.wallets?.some((w) => w.id === PERSONAL)) state.wallets = [...structuredClone(DEFAULT_WALLETS), ...(state.wallets || [])];
  state.settings = { currentWallet: PERSONAL, ...(state.settings || {}) };
  const cw = state.settings.currentWallet;
  const linesView = cw === ALL_LINES && state.wallets.filter((w) => w.kind === 'personal' || w.kind === 'line').length > 1;
  if (!linesView && !state.wallets.some((w) => w.id === cw)) state.settings.currentWallet = PERSONAL;
  state.walletBudgets ||= {};
  state.bills ||= [];
  state.statements ||= [];
  // Offer categories added in newer versions once, so a default you deleted
  // on purpose does not come back.
  const seen = new Set(saved?.seenDefaultCategories || DEFAULT_CATEGORIES.map((c) => c.name).filter((n) => !ADDED_IN_V2.includes(n)));
  for (const c of DEFAULT_CATEGORIES) {
    if (!seen.has(c.name) && !state.categories.some((x) => x.name === c.name)) state.categories.push(structuredClone(c));
  }
  state.seenDefaultCategories = DEFAULT_CATEGORIES.map((c) => c.name);
  state.version = 2;
  return state;
}

const hasChromeStorage = () => typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

export async function loadState() {
  let saved;
  if (hasChromeStorage()) {
    saved = (await chrome.storage.local.get(KEY))[KEY];
  } else {
    try {
      saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    } catch {
      saved = null;
    }
  }
  return migrate(saved);
}

export async function saveState(state) {
  if (hasChromeStorage()) await chrome.storage.local.set({ [KEY]: state });
  else localStorage.setItem(KEY, JSON.stringify(state));
}

// Categorizes and merges new transactions into one account (mutates state).
// Transactions on a business account get an id prefixed with the account, so
// paying your own Till from your personal M-Pesa is kept on both sides.
export function addTransactions(state, incoming, walletId = PERSONAL) {
  const prepared = prepareTransactions(state, incoming, walletId);
  const result = mergeTransactions(state.transactions, prepared);
  state.transactions = result.merged;
  return { added: result.added, duplicates: result.duplicates };
}

// Assigns the account, account-scoped id and category to incoming transactions.
export function prepareTransactions(state, incoming, walletId = PERSONAL) {
  return incoming.map((tx) => {
    const wallet = tx.wallet || walletId;
    const id = wallet === PERSONAL || String(tx.id).startsWith(`${wallet}:`) ? tx.id : `${wallet}:${tx.id}`;
    return {
      ...tx,
      id,
      wallet,
      category: tx.category && state.categories.some((c) => c.name === tx.category)
        ? tx.category
        : categorize(tx, state.rules, state.categories),
    };
  });
}

// With several M-Pesa lines (dual SIM), finds the line whose running balance
// these messages continue. Only switches away from the chosen line when the
// chosen line matches none of them and another line matches at least one.
export function lineByBalance(state, incoming, walletId) {
  const lines = personalLines(state);
  if (lines.length < 2 || !lines.some((w) => w.id === walletId)) return walletId;
  const withBalance = incoming.filter((t) => t.balance != null);
  if (!withBalance.length) return walletId;
  const score = (lineId) => {
    const own = state.transactions.filter((t) => walletOf(t) === lineId && t.balance != null).sort((a, b) => (a.date < b.date ? -1 : 1));
    let hits = 0;
    for (const tx of withBalance) {
      const prev = own.filter((t) => t.date < tx.date).at(-1);
      if (prev && prev.balance + walletEffect(tx) === tx.balance) hits++;
    }
    return hits;
  };
  const scores = lines.map((l) => ({ id: l.id, hits: score(l.id) }));
  const mine = scores.find((x) => x.id === walletId).hits;
  const best = [...scores].sort((a, b) => b.hits - a.hits)[0];
  return mine === 0 && best.hits > 0 ? best.id : walletId;
}

// Imports into the chosen account, except that:
//  - with several lines, messages go to the line whose balance they continue;
//  - business payments imported into one of your lines go to your business
//    account when you have exactly one.
// Returns counts plus what was moved where.
export function importTransactions(state, incoming, walletId = PERSONAL) {
  const chosen = lineByBalance(state, incoming, walletId);
  const lineMovedTo = chosen !== walletId ? chosen : null;
  walletId = chosen;
  const biz = businessWallets(state);
  const toLine = isLine(getWallet(state, walletId));
  const route = toLine && biz.length === 1 ? biz[0].id : null;
  const isBiz = (t) => BUSINESS_TYPES.has(t.type);
  const moved = route ? incoming.filter(isBiz) : [];
  const stay = route ? incoming.filter((t) => !isBiz(t)) : incoming;
  const a = addTransactions(state, stay, walletId);
  const b = moved.length ? addTransactions(state, moved, route) : { added: 0, duplicates: 0 };
  const businessInPersonal = toLine && !route ? incoming.filter(isBiz).length : 0;
  return {
    lineMovedTo,
    added: a.added + b.added,
    duplicates: a.duplicates + b.duplicates,
    movedTo: moved.length ? route : null,
    moved: b.added,
    businessInPersonal,
  };
}

export function recategorizeAll(state) {
  for (const tx of state.transactions) {
    if (!tx.manualCategory) tx.category = categorize(tx, state.rules, state.categories);
  }
}

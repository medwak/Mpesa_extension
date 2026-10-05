// Persistence. Uses chrome.storage.local inside the extension and falls back
// to localStorage so the dashboard also works as a plain web page.
// Data stays on this device. The only network use is the optional Daraja
// relay you set up yourself for a business account.

import { DEFAULT_CATEGORIES, DEFAULT_RULES, categorize } from './categories.js';
import { mergeTransactions } from './ledger.js';
import { DEFAULT_WALLETS, PERSONAL, BUSINESS_TYPES, businessWallets } from './wallets.js';

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
    settings: { currentWallet: PERSONAL },
    seenDefaultCategories: DEFAULT_CATEGORIES.map((c) => c.name),
  };
}

// Brings data saved by older versions up to date without losing anything.
export function migrate(saved) {
  const state = { ...defaultState(), ...(saved || {}) };
  if (!state.wallets?.some((w) => w.id === PERSONAL)) state.wallets = [...structuredClone(DEFAULT_WALLETS), ...(state.wallets || [])];
  state.settings = { currentWallet: PERSONAL, ...(state.settings || {}) };
  if (!state.wallets.some((w) => w.id === state.settings.currentWallet)) state.settings.currentWallet = PERSONAL;
  state.walletBudgets ||= {};
  state.bills ||= [];
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
  const prepared = incoming.map((tx) => {
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
  const result = mergeTransactions(state.transactions, prepared);
  state.transactions = result.merged;
  return { added: result.added, duplicates: result.duplicates };
}

// Imports into the chosen account, except that business payments imported
// while the personal account is selected go to your business account when
// you have exactly one. Returns counts plus how many were moved.
export function importTransactions(state, incoming, walletId = PERSONAL) {
  const biz = businessWallets(state);
  const route = walletId === PERSONAL && biz.length === 1 ? biz[0].id : null;
  const isBiz = (t) => BUSINESS_TYPES.has(t.type);
  const moved = route ? incoming.filter(isBiz) : [];
  const stay = route ? incoming.filter((t) => !isBiz(t)) : incoming;
  const a = addTransactions(state, stay, walletId);
  const b = moved.length ? addTransactions(state, moved, route) : { added: 0, duplicates: 0 };
  const businessInPersonal = walletId === PERSONAL && !route ? incoming.filter(isBiz).length : 0;
  return {
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

// Persistence. Uses chrome.storage.local inside the extension and falls back
// to localStorage so the dashboard also works as a plain web page.
// Everything stays on this device; nothing is sent anywhere.

import { DEFAULT_CATEGORIES, DEFAULT_RULES, categorize } from './categories.js';
import { mergeTransactions } from './ledger.js';

const KEY = 'mpesaLedger';

export function defaultState() {
  return {
    version: 1,
    transactions: [],
    categories: structuredClone(DEFAULT_CATEGORIES),
    rules: structuredClone(DEFAULT_RULES),
    budgets: {},
  };
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
  return { ...defaultState(), ...(saved || {}) };
}

export async function saveState(state) {
  if (hasChromeStorage()) await chrome.storage.local.set({ [KEY]: state });
  else localStorage.setItem(KEY, JSON.stringify(state));
}

// Categorizes and merges new transactions into state (mutates and returns stats).
export function addTransactions(state, incoming) {
  const prepared = incoming.map((tx) => ({
    ...tx,
    category: tx.category && state.categories.some((c) => c.name === tx.category)
      ? tx.category
      : categorize(tx, state.rules, state.categories),
  }));
  const result = mergeTransactions(state.transactions, prepared);
  state.transactions = result.merged;
  return { added: result.added, duplicates: result.duplicates };
}

export function recategorizeAll(state) {
  for (const tx of state.transactions) {
    if (!tx.manualCategory) tx.category = categorize(tx, state.rules, state.categories);
  }
}

// Uploaded statements library: every PDF/CSV statement you import is kept as
// its own entry, can be deleted on its own, and can be combined with others
// (consecutive months or years) into one statement.
//
// Each transaction remembers which statements contain it (tx.statements), so
// deleting a statement only removes transactions nothing else vouches for:
// ones also in another statement, or that came from an SMS, Daraja or a
// manual entry, are kept.

import { prepareTransactions } from './store.js';
import { BUSINESS_TYPES, PERSONAL, businessWallets, walletOf } from './wallets.js';
import { buildStatement, sortByDate } from './ledger.js';

const FROM_STATEMENTS = new Set(['statement', 'csv']);

function newId() {
  return `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function dayAfter(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function dayBefore(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// meta: { name, kind: 'pdf' | 'csv', from?, to? } (from/to = printed period).
export function importStatement(state, incoming, walletId, meta = {}) {
  if (!incoming.length) throw new Error('No transactions were found in this statement.');
  // A business statement imported while the personal account is selected
  // goes to your business account when you have exactly one.
  const biz = businessWallets(state);
  const bizShare = incoming.filter((t) => BUSINESS_TYPES.has(t.type)).length / incoming.length;
  const target = walletId === PERSONAL && biz.length === 1 && bizShare > 0.5 ? biz[0].id : walletId;

  const id = newId();
  const prepared = prepareTransactions(state, incoming, target);
  const byId = new Map(state.transactions.map((t) => [t.id, t]));
  let added = 0;
  let duplicates = 0;
  for (const tx of prepared) {
    const existing = byId.get(tx.id);
    if (existing) {
      existing.statements = [...new Set([...(existing.statements || []), id])];
      duplicates++;
    } else {
      byId.set(tx.id, { ...tx, statements: [id] });
      added++;
    }
  }
  state.transactions = sortByDate([...byId.values()]);

  const dates = prepared.map((t) => t.date).sort();
  const summary = buildStatement(prepared);
  const record = {
    id,
    name: meta.name || 'Statement',
    kind: meta.kind || 'csv',
    wallet: target,
    from: meta.from && meta.from <= dates[0].slice(0, 10) ? meta.from : dates[0].slice(0, 10),
    to: meta.to && meta.to >= dates.at(-1).slice(0, 10) ? meta.to : dates.at(-1).slice(0, 10),
    count: prepared.length,
    openingBalance: summary.openingBalance,
    closingBalance: summary.closingBalance,
    importedAt: new Date().toISOString(),
  };
  state.statements.push(record);
  return { added, duplicates, statement: record, movedTo: target !== walletId ? target : null, moved: target !== walletId ? added : 0 };
}

export function statementsFor(state, walletId) {
  return state.statements.filter((s) => (s.wallet || PERSONAL) === walletId).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

export function deleteStatement(state, statementId) {
  let removed = 0;
  let kept = 0;
  state.transactions = state.transactions.filter((t) => {
    if (!t.statements?.includes(statementId)) return true;
    t.statements = t.statements.filter((x) => x !== statementId);
    if (t.statements.length || !FROM_STATEMENTS.has(t.source)) {
      kept++;
      return true;
    }
    removed++;
    return false;
  });
  state.statements = state.statements.filter((s) => s.id !== statementId);
  return { removed, kept };
}

// Disabled statements stay in the list but their transactions are left out of
// totals, budgets, bills and statements until enabled again.
export function setStatementEnabled(state, statementId, enabled) {
  const st = state.statements.find((s) => s.id === statementId);
  if (st) st.disabled = !enabled;
  return st;
}

export function statementTxs(state, statementIds) {
  const ids = new Set(statementIds);
  return state.transactions.filter((t) => t.statements?.some((x) => ids.has(x)));
}

// Periods between the statements that none of them cover. A gap is ignored
// when the balance carries straight over it (the earlier statement closes on
// exactly the balance the later one opens with), because then no transaction
// can be missing; CSV statements often only show the dates of their first and
// last transactions, which leaves such harmless gaps.
export function coverageGaps(statements) {
  const sorted = [...statements].sort((a, b) => (a.from < b.from ? -1 : 1));
  const gaps = [];
  let last = null;
  for (const s of sorted) {
    if (last && s.from > dayAfter(last.to)) {
      const connected = typeof last.closingBalance === 'number' && last.closingBalance === s.openingBalance;
      if (!connected) gaps.push({ from: dayAfter(last.to), to: dayBefore(s.from) });
    }
    if (!last || s.to > last.to) last = s;
  }
  return gaps;
}

// One statement made from several: transactions appearing in more than one
// are counted once, and the running balance is checked across the joins.
export function combineStatements(state, statementIds) {
  const chosen = state.statements.filter((s) => statementIds.includes(s.id));
  if (!chosen.length) throw new Error('Choose at least one statement.');
  const wallets = new Set(chosen.map((s) => s.wallet || PERSONAL));
  if (wallets.size > 1) throw new Error('Choose statements from the same account.');
  const from = chosen.map((s) => s.from).sort()[0];
  const to = chosen.map((s) => s.to).sort().at(-1);
  const txs = statementTxs(state, statementIds).filter((t) => walletOf(t) === [...wallets][0]);
  return { statements: chosen, from, to, txs, gaps: coverageGaps(chosen) };
}

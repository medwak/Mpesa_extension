// Accounting: merging imports, profit & loss summaries, trends and statements.

import { DEFAULT_CATEGORIES, FEES_CATEGORY, kindOf } from './categories.js';

export const TYPE_LABELS = {
  received: 'Money received',
  sent: 'Send money',
  paybill: 'Pay bill',
  buygoods: 'Buy goods (Till)',
  withdraw: 'Agent withdrawal',
  deposit: 'Agent deposit',
  airtime: 'Airtime purchase',
  fuliza: 'Fuliza draw-down',
  fuliza_repay: 'Fuliza repayment',
  savings_out: 'To savings (M-Shwari etc.)',
  savings_in: 'From savings (M-Shwari etc.)',
  reversal: 'Reversal',
  manual: 'Manual entry',
  business_received: 'Customer payment',
  settlement: 'Settlement to bank',
  payout: 'Business payment out',
};

// Fuliza charges are added to the loan, not deducted from the wallet.
export function feeHitsWallet(tx) {
  return tx.type !== 'fuliza';
}

export function walletEffect(tx) {
  const fee = feeHitsWallet(tx) ? tx.fee || 0 : 0;
  return tx.direction === 'in' ? tx.amount - fee : -(tx.amount + fee);
}

export function sortByDate(txs) {
  return [...txs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function mergeTransactions(existing, incoming) {
  const byId = new Map(existing.map((t) => [t.id, t]));
  let added = 0;
  let duplicates = 0;
  for (const tx of incoming) {
    if (byId.has(tx.id)) {
      duplicates++;
      continue;
    }
    byId.set(tx.id, tx);
    added++;
  }
  return { merged: sortByDate([...byId.values()]), added, duplicates };
}

export function inRange(tx, from, to) {
  const day = tx.date.slice(0, 10);
  return (!from || day >= from) && (!to || day <= to);
}

export function filterRange(txs, from, to) {
  return txs.filter((t) => inRange(t, from, to));
}

export function monthKey(date) {
  return date.slice(0, 7);
}

export function monthBounds(key) {
  const [y, m] = key.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${key}-01`, to: `${key}-${String(last).padStart(2, '0')}` };
}

// Profit & loss style summary. Transaction costs are booked as their own
// expense line, separate from the transaction they were charged on.
export function summarize(txs, categories = DEFAULT_CATEGORIES) {
  const byCat = new Map();
  const add = (name, cents) => {
    const row = byCat.get(name) || { name, kind: kindOf(name, categories), total: 0, count: 0 };
    row.total += cents;
    row.count += 1;
    byCat.set(name, row);
  };

  let moneyIn = 0;
  let moneyOut = 0;
  for (const tx of txs) {
    const signed = tx.direction === 'in' ? tx.amount : -tx.amount;
    add(tx.category, signed);
    if (tx.direction === 'in') moneyIn += tx.amount;
    else moneyOut += tx.amount;
    if (tx.fee) {
      add(FEES_CATEGORY, -tx.fee);
      if (feeHitsWallet(tx)) moneyOut += tx.fee;
    }
  }

  const rows = [...byCat.values()];
  const income = rows.filter((r) => r.kind === 'income').reduce((s, r) => s + r.total, 0);
  // Expense rows are negative; refunds booked to an expense category reduce them.
  const expenses = -rows.filter((r) => r.kind === 'expense').reduce((s, r) => s + r.total, 0);
  const fees = -(byCat.get(FEES_CATEGORY)?.total || 0);

  return {
    income,
    expenses,
    fees,
    net: income - expenses,
    moneyIn,
    moneyOut,
    savingsRate: income > 0 ? (income - expenses) / income : 0,
    categories: rows
      .map((r) => ({ ...r, total: r.kind === 'expense' ? -r.total : r.total }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
    count: txs.length,
  };
}

export function monthlyTrend(txs, categories = DEFAULT_CATEGORIES) {
  const groups = new Map();
  for (const tx of txs) {
    const k = monthKey(tx.date);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(tx);
  }
  return [...groups.keys()].sort().map((month) => {
    const s = summarize(groups.get(month), categories);
    return { month, income: s.income, expenses: s.expenses, net: s.net };
  });
}

export function topCounterparties(txs, direction = 'out', limit = 5) {
  const totals = new Map();
  for (const tx of txs) {
    if (tx.direction !== direction || !tx.counterparty) continue;
    const row = totals.get(tx.counterparty) || { name: tx.counterparty, total: 0, count: 0 };
    row.total += tx.amount;
    row.count += 1;
    totals.set(tx.counterparty, row);
  }
  return [...totals.values()].sort((a, b) => b.total - a.total).slice(0, limit);
}

// Builds an M-Pesa style statement with running balances. Where the SMS
// reported a balance we trust it; where our computed balance disagrees, the
// row is flagged so you know a message (transaction) is probably missing.
export function buildStatement(allTxs, { from, to, openingBalance } = {}) {
  const sorted = sortByDate(allTxs);
  const txs = filterRange(sorted, from, to);

  let opening = openingBalance;
  if (opening == null) {
    const firstKnown = txs.findIndex((t) => t.balance != null);
    if (firstKnown >= 0) {
      opening = txs[firstKnown].balance;
      for (let i = firstKnown; i >= 0; i--) opening -= walletEffect(txs[i]);
    } else {
      opening = 0;
    }
  }

  const rows = [];
  const gaps = [];
  let running = opening;
  for (const tx of txs) {
    running += walletEffect(tx);
    if (tx.balance != null && tx.balance !== running) {
      gaps.push({ id: tx.id, date: tx.date, expected: running, reported: tx.balance, diff: tx.balance - running });
      running = tx.balance;
    }
    rows.push({
      id: tx.id,
      code: tx.code,
      date: tx.date,
      details: describe(tx),
      category: tx.category,
      paidIn: tx.direction === 'in' ? tx.amount : 0,
      withdrawn: tx.direction === 'out' ? tx.amount : 0,
      fee: feeHitsWallet(tx) ? tx.fee || 0 : 0,
      balance: running,
    });
  }

  const byType = new Map();
  for (const tx of txs) {
    const label = TYPE_LABELS[tx.type] || tx.type;
    const row = byType.get(label) || { type: label, paidIn: 0, paidOut: 0 };
    if (tx.direction === 'in') row.paidIn += tx.amount;
    else row.paidOut += tx.amount;
    byType.set(label, row);
  }
  const feeTotal = rows.reduce((s, r) => s + r.fee, 0);
  if (feeTotal) byType.set(FEES_CATEGORY, { type: FEES_CATEGORY, paidIn: 0, paidOut: feeTotal });

  const totalIn = rows.reduce((s, r) => s + r.paidIn, 0);
  const totalOut = rows.reduce((s, r) => s + r.withdrawn + r.fee, 0);

  return {
    from: from || (txs[0] ? txs[0].date.slice(0, 10) : ''),
    to: to || (txs.length ? txs[txs.length - 1].date.slice(0, 10) : ''),
    openingBalance: opening,
    closingBalance: running,
    totalIn,
    totalOut,
    rows,
    summary: [...byType.values()],
    gaps,
  };
}

export function describe(tx) {
  const who = [tx.counterparty, tx.phone].filter(Boolean).join(' ');
  switch (tx.type) {
    case 'received':
      return `Funds received from ${who}`;
    case 'sent':
      return `Customer transfer to ${who}`;
    case 'paybill':
      return `Pay Bill to ${who}${tx.account ? ` Acc. ${tx.account}` : ''}`;
    case 'buygoods':
      return `Merchant payment to ${who}`;
    case 'withdraw':
      return `Customer withdrawal at agent ${who}`;
    case 'deposit':
      return `Deposit of funds at agent ${who}`;
    case 'business_received':
      return `Payment from ${who}${tx.account ? ` Acc. ${tx.account}` : ''}`;
    case 'airtime':
      return `Airtime purchase${tx.account ? ` for ${tx.account}` : ''}`;
    default:
      return [TYPE_LABELS[tx.type] || tx.type, who].filter(Boolean).join(' - ') + (tx.note ? ` (${tx.note})` : '');
  }
}

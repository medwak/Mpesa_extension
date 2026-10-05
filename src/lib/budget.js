// Monthly budget planning and tracking.
// A plan looks like: { month: '2026-10', expectedIncome: cents, savingsGoal: cents,
//                      limits: { 'Groceries': cents, ... } }

import { DEFAULT_CATEGORIES, FEES_CATEGORY, kindOf } from './categories.js';
import { filterRange, monthBounds } from './ledger.js';

export function emptyPlan(month) {
  return { month, expectedIncome: 0, savingsGoal: 0, limits: {} };
}

// Starts a new month from the previous plan, or from actual spending when
// there is no previous plan (rounded up to the nearest Ksh 100).
export function suggestPlan(month, { previousPlan, previousSummary } = {}) {
  if (previousPlan) return { ...structuredClone(previousPlan), month };
  const plan = emptyPlan(month);
  if (previousSummary) {
    plan.expectedIncome = previousSummary.income;
    for (const c of previousSummary.categories) {
      if (c.kind === 'expense' && c.total > 0) plan.limits[c.name] = Math.ceil(c.total / 10000) * 10000;
    }
  }
  return plan;
}

export function spentByCategory(txs, categories = DEFAULT_CATEGORIES) {
  const spent = {};
  for (const tx of txs) {
    if (kindOf(tx.category, categories) === 'expense') {
      const signed = tx.direction === 'out' ? tx.amount : -tx.amount;
      spent[tx.category] = (spent[tx.category] || 0) + signed;
    }
    if (tx.fee) spent[FEES_CATEGORY] = (spent[FEES_CATEGORY] || 0) + tx.fee;
  }
  return spent;
}

function daysInfo(month, today) {
  const { from, to } = monthBounds(month);
  const totalDays = Number(to.slice(8));
  const t = today.slice(0, 10);
  if (t < from) return { totalDays, elapsed: 0, remaining: totalDays };
  if (t > to) return { totalDays, elapsed: totalDays, remaining: 0 };
  const elapsed = Number(t.slice(8));
  return { totalDays, elapsed, remaining: totalDays - elapsed + 1 };
}

export function evaluateBudget(plan, txs, { categories = DEFAULT_CATEGORIES, today } = {}) {
  const { from, to } = monthBounds(plan.month);
  const monthTxs = filterRange(txs, from, to);
  const spent = spentByCategory(monthTxs, categories);
  const now = today || new Date().toISOString().slice(0, 10);
  const days = daysInfo(plan.month, now);
  const paceFraction = days.elapsed / days.totalDays;

  const names = new Set([...Object.keys(plan.limits), ...Object.keys(spent)]);
  const lines = [...names].map((name) => {
    const limit = plan.limits[name] || 0;
    const used = Math.max(0, spent[name] || 0);
    const remaining = limit - used;
    const ratio = limit > 0 ? used / limit : used > 0 ? Infinity : 0;
    let status = 'ok';
    if (!limit && used > 0) status = 'unplanned';
    else if (used > limit) status = 'over';
    else if (ratio >= 0.8) status = 'warning';
    else if (paceFraction > 0 && ratio > paceFraction + 0.15) status = 'fast';
    return {
      name,
      limit,
      spent: used,
      remaining,
      ratio,
      status,
      dailyAllowance: days.remaining > 0 && remaining > 0 ? Math.floor(remaining / days.remaining) : 0,
    };
  });
  lines.sort((a, b) => b.limit - a.limit || b.spent - a.spent);

  const totalLimit = lines.reduce((s, l) => s + l.limit, 0);
  const totalSpent = lines.reduce((s, l) => s + l.spent, 0);
  const actualIncome = monthTxs
    .filter((t) => kindOf(t.category, categories) === 'income')
    .reduce((s, t) => s + (t.direction === 'in' ? t.amount : -t.amount), 0);
  const plannedSavings = plan.expectedIncome - totalLimit;

  const alerts = [];
  for (const l of lines) {
    if (l.status === 'over') alerts.push({ level: 'danger', text: `${l.name} is over budget by Ksh ${((l.spent - l.limit) / 100).toFixed(2)}` });
    else if (l.status === 'warning') alerts.push({ level: 'warning', text: `${l.name} has used ${Math.round(l.ratio * 100)}% of its budget` });
    else if (l.status === 'fast') alerts.push({ level: 'info', text: `${l.name} is being spent faster than the month is passing` });
    else if (l.status === 'unplanned') alerts.push({ level: 'info', text: `${l.name} has spending but no budget line` });
  }
  if (plan.savingsGoal > 0 && plannedSavings < plan.savingsGoal) {
    alerts.push({ level: 'warning', text: 'Your budget limits leave less than your savings goal from expected income' });
  }

  return {
    month: plan.month,
    lines,
    totalLimit,
    totalSpent,
    totalRemaining: totalLimit - totalSpent,
    expectedIncome: plan.expectedIncome,
    actualIncome,
    plannedSavings,
    projectedSavings: actualIncome - totalSpent,
    savingsGoal: plan.savingsGoal,
    days,
    alerts,
  };
}

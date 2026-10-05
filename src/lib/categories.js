// Categories carry a "kind" so the accounting reports can tell real income
// and spending apart from money that merely moves between your own pockets.
//   income   - money earned or received
//   expense  - money spent
//   transfer - savings, loans and cash moves; excluded from profit & loss

export const FEES_CATEGORY = 'Transaction costs';
export const UNCATEGORIZED = 'Uncategorized';

export const DEFAULT_CATEGORIES = [
  { name: 'Salary', kind: 'income' },
  { name: 'Business income', kind: 'income' },
  { name: 'Money received', kind: 'income' },
  { name: 'Refunds & reversals', kind: 'income' },
  { name: 'Groceries', kind: 'expense' },
  { name: 'Food & drinks', kind: 'expense' },
  { name: 'Transport & fuel', kind: 'expense' },
  { name: 'Rent & housing', kind: 'expense' },
  { name: 'Electricity', kind: 'expense' },
  { name: 'Water', kind: 'expense' },
  { name: 'Internet & TV', kind: 'expense' },
  { name: 'Airtime & data', kind: 'expense' },
  { name: 'Bills & utilities', kind: 'expense' },
  { name: 'School fees', kind: 'expense' },
  { name: 'Health', kind: 'expense' },
  { name: 'Shopping', kind: 'expense' },
  { name: 'Entertainment', kind: 'expense' },
  { name: 'Betting', kind: 'expense' },
  { name: 'Family & friends', kind: 'expense' },
  { name: 'Church & charity', kind: 'expense' },
  { name: 'Cash withdrawal', kind: 'expense' },
  { name: 'Loan repayment', kind: 'expense' },
  { name: FEES_CATEGORY, kind: 'expense' },
  { name: 'Savings', kind: 'transfer' },
  { name: 'Savings withdrawal', kind: 'transfer' },
  { name: 'Fuliza loan', kind: 'transfer' },
  { name: 'Fuliza repayment', kind: 'transfer' },
  { name: 'Cash deposit', kind: 'transfer' },
  { name: UNCATEGORIZED, kind: 'expense' },
];

// Keyword rules are matched case-insensitively against counterparty + account.
export const DEFAULT_RULES = [
  { pattern: 'RENTAL', category: 'Rent & housing' },
  { pattern: 'LANDLORD', category: 'Rent & housing' },
  { pattern: 'KPLC', category: 'Electricity' },
  { pattern: 'KENYA POWER', category: 'Electricity' },
  { pattern: 'WATER', category: 'Water' },
  { pattern: 'ZUKU', category: 'Internet & TV' },
  { pattern: 'SAFARICOM HOME', category: 'Internet & TV' },
  { pattern: 'DSTV', category: 'Internet & TV' },
  { pattern: 'GOTV', category: 'Internet & TV' },
  { pattern: 'SAFARICOM DATA', category: 'Airtime & data' },
  { pattern: 'NAIVAS', category: 'Groceries' },
  { pattern: 'CARREFOUR', category: 'Groceries' },
  { pattern: 'QUICKMART', category: 'Groceries' },
  { pattern: 'CHANDARANA', category: 'Groceries' },
  { pattern: 'MAGUNAS', category: 'Groceries' },
  { pattern: 'JAVA', category: 'Food & drinks' },
  { pattern: 'KFC', category: 'Food & drinks' },
  { pattern: 'UBER', category: 'Transport & fuel' },
  { pattern: 'BOLT', category: 'Transport & fuel' },
  { pattern: 'SHELL', category: 'Transport & fuel' },
  { pattern: 'TOTAL', category: 'Transport & fuel' },
  { pattern: 'RUBIS', category: 'Transport & fuel' },
  { pattern: 'SPORTPESA', category: 'Betting' },
  { pattern: 'BETIKA', category: 'Betting' },
  { pattern: 'ODIBETS', category: 'Betting' },
  { pattern: 'HOSPITAL', category: 'Health' },
  { pattern: 'PHARMACY', category: 'Health' },
  { pattern: 'CHEMIST', category: 'Health' },
  { pattern: 'NHIF', category: 'Health' },
  { pattern: 'SHA ', category: 'Health' },
  { pattern: 'SCHOOL', category: 'School fees' },
  { pattern: 'ACADEMY', category: 'School fees' },
  { pattern: 'UNIVERSITY', category: 'School fees' },
  { pattern: 'CHURCH', category: 'Church & charity' },
  { pattern: 'KCB M-PESA', category: 'Loan repayment' },
  { pattern: 'TALA', category: 'Loan repayment' },
];

const TYPE_DEFAULTS = {
  received: 'Money received',
  sent: 'Family & friends',
  paybill: 'Bills & utilities',
  buygoods: 'Shopping',
  withdraw: 'Cash withdrawal',
  deposit: 'Cash deposit',
  airtime: 'Airtime & data',
  fuliza: 'Fuliza loan',
  fuliza_repay: 'Fuliza repayment',
  savings_out: 'Savings',
  savings_in: 'Savings withdrawal',
  reversal: 'Refunds & reversals',
  manual: UNCATEGORIZED,
};

// Rules may only move a transaction to a category of a compatible kind, so a
// rule like "SHELL" can't turn money you received from Shell into spending.
function kindFits(categoryName, direction, categories) {
  const cat = categories.find((c) => c.name === categoryName);
  if (!cat) return false;
  if (cat.kind === 'transfer') return true;
  return direction === 'in' ? cat.kind === 'income' : cat.kind === 'expense';
}

export function categorize(tx, rules = DEFAULT_RULES, categories = DEFAULT_CATEGORIES) {
  const haystack = `${tx.counterparty || ''} ${tx.account || ''}`.toUpperCase();
  for (const rule of rules) {
    if (!rule.pattern) continue;
    if (haystack.includes(rule.pattern.toUpperCase()) && kindFits(rule.category, tx.direction, categories)) {
      return rule.category;
    }
  }
  return TYPE_DEFAULTS[tx.type] || UNCATEGORIZED;
}

export function kindOf(categoryName, categories = DEFAULT_CATEGORIES) {
  const cat = categories.find((c) => c.name === categoryName);
  return cat ? cat.kind : 'expense';
}

// Paying Paybills and Tills: a directory of everyone you have paid, saved
// regular bills with due days, and reminders for bills not yet paid.
// A bill looks like: { id, label, match, account, shortcode, amount, dueDay, wallet }

const PAYEE_TYPES = new Set(['paybill', 'buygoods']);
const upper = (s) => String(s || '').trim().toUpperCase();

function monthKey(date) {
  return date.slice(0, 7);
}

function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

function daysInMonth(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Groups payments by Paybill/Till (and account number, since one Paybill such
// as KPLC can cover several meters).
export function payeeDirectory(txs) {
  const groups = new Map();
  for (const tx of txs) {
    if (tx.direction !== 'out' || !PAYEE_TYPES.has(tx.type) || !tx.counterparty) continue;
    const account = tx.type === 'paybill' ? tx.account || '' : '';
    const key = `${tx.type}|${upper(tx.counterparty)}|${upper(account)}`;
    const g = groups.get(key) || { key, type: tx.type, name: tx.counterparty, shortcode: '', account, count: 0, total: 0, history: [] };
    g.count += 1;
    g.total += tx.amount;
    if (tx.shortcode) g.shortcode = tx.shortcode;
    g.history.push(tx);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => {
      g.history.sort((a, b) => (a.date < b.date ? 1 : -1));
      const last = g.history[0];
      return { ...g, average: Math.round(g.total / g.count), lastDate: last.date, lastAmount: last.amount, months: new Set(g.history.map((t) => monthKey(t.date))).size };
    })
    .sort((a, b) => (a.lastDate < b.lastDate ? 1 : -1));
}

export function billMatches(bill, tx) {
  if (tx.direction !== 'out' || !bill.match) return false;
  if (!upper(tx.counterparty).includes(upper(bill.match))) return false;
  if (bill.account && upper(tx.account) !== upper(bill.account)) return false;
  if (bill.shortcode && tx.shortcode && tx.shortcode !== bill.shortcode) return false;
  return true;
}

// Status of each saved bill for the month containing `today` (YYYY-MM-DD).
export function billStatuses(bills, txs, today) {
  const month = today.slice(0, 7);
  const day = Number(today.slice(8, 10));
  return bills.map((bill) => {
    const payments = txs.filter((t) => billMatches(bill, t)).sort((a, b) => (a.date < b.date ? 1 : -1));
    const thisMonth = payments.filter((t) => monthKey(t.date) === month);
    const paid = thisMonth.reduce((s, t) => s + t.amount, 0);
    const dueDay = bill.dueDay ? Math.min(Number(bill.dueDay), daysInMonth(month)) : null;
    let status;
    if (paid && bill.amount && paid < bill.amount) status = 'partial';
    else if (paid) status = 'paid';
    else if (!dueDay) status = 'unpaid';
    else if (day > dueDay) status = 'overdue';
    else if (dueDay - day <= 5) status = 'due-soon';
    else status = 'upcoming';
    return {
      bill,
      status,
      paid,
      dueDate: dueDay ? `${month}-${String(dueDay).padStart(2, '0')}` : null,
      lastPayment: payments[0] || null,
      daysLeft: dueDay ? dueDay - day : null,
    };
  });
}

export function billAlerts(statuses) {
  const ksh = (c) => `Ksh ${(c / 100).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;
  const out = [];
  for (const s of statuses) {
    const name = s.bill.label || s.bill.match;
    if (s.status === 'overdue') out.push({ level: 'warning', title: 'Bill overdue', text: `${name} was due on day ${s.bill.dueDay} and has not been paid this month${s.bill.amount ? ` (usually ${ksh(s.bill.amount)})` : ''}.` });
    else if (s.status === 'due-soon') out.push({ level: 'info', title: 'Bill due', text: `${name} is due ${s.daysLeft === 0 ? 'today' : `in ${s.daysLeft} day(s)`}${s.bill.amount ? `: about ${ksh(s.bill.amount)}` : ''}.` });
    else if (s.status === 'partial') out.push({ level: 'info', title: 'Part paid', text: `${name}: ${ksh(s.paid)} of ${ksh(s.bill.amount)} paid this month.` });
  }
  return out;
}

// Paybills (and steady monthly Tills) paid in at least two of the last three
// full months that are not yet saved as bills, with a typical amount and day.
export function suggestBills(txs, bills, today) {
  const month = today.slice(0, 7);
  const window = [addMonths(month, -3), addMonths(month, -2), addMonths(month, -1)];
  return payeeDirectory(txs)
    .filter((p) => p.type === 'paybill' || p.count >= 2)
    .map((p) => {
      const recent = p.history.filter((t) => window.includes(monthKey(t.date)));
      const months = new Set(recent.map((t) => monthKey(t.date)));
      const days = recent.map((t) => Number(t.date.slice(8, 10))).sort((a, b) => a - b);
      const amounts = recent.map((t) => t.amount).sort((a, b) => a - b);
      return {
        payee: p,
        months: months.size,
        typicalDay: days.length ? days[Math.floor(days.length / 2)] : null,
        typicalAmount: amounts.length ? amounts[Math.floor(amounts.length / 2)] : 0,
      };
    })
    .filter((s) => s.months >= 2)
    // A Till only counts when paid about once a month for a similar amount;
    // shops and rides you pay many times a month are not bills.
    .filter((s) => {
      if (s.payee.type === 'paybill') return true;
      const recent = s.payee.history.filter((t) => window.includes(monthKey(t.date)));
      const steady = recent.every((t) => Math.abs(t.amount - s.typicalAmount) <= s.typicalAmount * 0.2);
      return recent.length <= s.months + 1 && steady;
    })
    .filter((s) => !bills.some((b) => s.payee.history.some((t) => billMatches(b, t))))
    .sort((a, b) => b.typicalAmount - a.typicalAmount);
}

export function newBillFromPayee(payee, { typicalDay, typicalAmount } = {}) {
  return {
    id: `bill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    label: payee.name,
    match: payee.name,
    account: payee.account || '',
    shortcode: payee.shortcode || '',
    amount: typicalAmount || payee.lastAmount || 0,
    dueDay: typicalDay || Number(payee.lastDate.slice(8, 10)),
  };
}

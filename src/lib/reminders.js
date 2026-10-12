// Phone notifications for the Android app: what to schedule and when.
// Kept free of any Android code so it can be tested; src/ui/native.js hands
// the result to the notification plugin.

import { billStatuses } from './bills.js';
import { evaluateBudget } from './budget.js';
import { walletTxs, budgetsFor, getWallet, PERSONAL } from './wallets.js';

export const DEFAULT_NOTIFICATION_SETTINGS = { weekly: true, weekday: 1, hour: 19, bills: true, budget: true };
export const WEEKLY_ID = 100;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function weekdayName(n) {
  return WEEKDAYS[(n - 1 + 7) % 7];
}

function idFor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return 1000 + (Math.abs(h) % 2000000000); // notification ids must be positive ints
}

function at(day, hour = 9) {
  return `${day}T${String(hour).padStart(2, '0')}:00`;
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
}

function dueDayIn(month, dueDay) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(Math.min(dueDay, last)).padStart(2, '0')}`;
}

const ksh = (c) => `Ksh ${(c / 100).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

// Scheduled notifications. `now` is local time "YYYY-MM-DDTHH:mm".
export function planNotifications(state, now, settings = DEFAULT_NOTIFICATION_SETTINGS) {
  const out = [];
  if (settings.weekly) {
    out.push({
      id: WEEKLY_ID,
      title: 'Update M-Pesa Ledger',
      body: 'Share this week’s M-Pesa messages (select them all at once) or upload a statement to keep your books up to date.',
      on: { weekday: settings.weekday, hour: settings.hour, minute: 0 },
      extra: { tab: 'import' },
    });
  }
  if (settings.bills) {
    const today = now.slice(0, 10);
    const month = today.slice(0, 7);
    for (const st of billStatuses(state.bills || [], state.transactions, today)) {
      const bill = st.bill;
      if (!bill.dueDay) continue;
      const name = bill.label || bill.match;
      const amount = bill.amount ? ` (about ${ksh(bill.amount)})` : '';
      const add = (when, title, body) => {
        if (when > now) out.push({ id: idFor(`${bill.id}|${when}`), title, body, at: when, extra: { tab: 'bills', wallet: bill.wallet || PERSONAL } });
      };
      if (st.status !== 'paid') {
        const due = dueDayIn(month, bill.dueDay);
        if (due >= today) {
          add(at(addDays(due, -1)), `${name} is due tomorrow`, `Pay ${name}${amount} by tomorrow.`);
          add(at(due), `${name} is due today`, `${name}${amount} is due today.`);
        } else {
          // Overdue: one reminder a day until a payment shows up.
          const when = now < at(today) ? at(today) : at(addDays(today, 1));
          add(when, `${name} is overdue`, `${name} was due on day ${bill.dueDay} and no payment has shown up yet.`);
        }
      }
      const nextDue = dueDayIn(nextMonth(month), bill.dueDay);
      add(at(addDays(nextDue, -1)), `${name} is due tomorrow`, `Pay ${name}${amount} by tomorrow.`);
      add(at(nextDue), `${name} is due today`, `${name}${amount} is due today.`);
    }
  }
  return out;
}

// Budget warnings to show right away, each only once per month and status.
// `sent` is the set of keys already shown.
export function budgetNotifications(state, today, sent = new Set(), settings = DEFAULT_NOTIFICATION_SETTINGS) {
  if (!settings.budget) return [];
  const month = today.slice(0, 7);
  const out = [];
  for (const w of state.wallets) {
    const plan = budgetsFor(state, w.id)[month];
    if (!plan) continue;
    const ev = evaluateBudget(plan, walletTxs(state, w.id), { categories: state.categories, today });
    for (const line of ev.lines) {
      if (line.status !== 'over' && line.status !== 'warning') continue;
      const key = `${w.id}|${month}|${line.name}|${line.status}`;
      if (sent.has(key)) continue;
      const where = state.wallets.length > 1 ? ` (${getWallet(state, w.id).name})` : '';
      out.push({
        key,
        id: idFor(key),
        title: line.status === 'over' ? `${line.name} is over budget${where}` : `${line.name} budget almost used${where}`,
        body: line.status === 'over'
          ? `You have spent ${ksh(line.spent)} of ${ksh(line.limit)} this month.`
          : `${Math.round(line.ratio * 100)}% used: ${ksh(line.remaining)} left for the rest of the month.`,
        extra: { tab: 'budget', wallet: w.id },
      });
    }
  }
  return out;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planNotifications, budgetNotifications, WEEKLY_ID, DEFAULT_NOTIFICATION_SETTINGS } from '../src/lib/reminders.js';
import { defaultState, addTransactions } from '../src/lib/store.js';

const kplc = { id: 'bill-1', label: 'Electricity', match: 'KPLC PREPAID', account: '5432', amount: 200000, dueDay: 10, wallet: 'personal' };
const pay = (date) => ({ id: `P${date}`, code: `P${date}`, date, type: 'paybill', direction: 'out', amount: 200000, fee: 0, counterparty: 'KPLC PREPAID', account: '5432' });

test('weekly reminder and bill reminders before and on the due day', () => {
  const state = defaultState();
  state.bills = [kplc];
  const plan = planNotifications(state, '2026-10-05T12:00');
  const weekly = plan.find((n) => n.id === WEEKLY_ID);
  assert.deepEqual(weekly.on, { weekday: 1, hour: 19, minute: 0 });
  assert.equal(weekly.extra.tab, 'import');
  assert.deepEqual(plan.filter((n) => n.at).map((n) => [n.at, n.title]), [
    ['2026-10-09T09:00', 'Electricity is due tomorrow'],
    ['2026-10-10T09:00', 'Electricity is due today'],
    ['2026-11-09T09:00', 'Electricity is due tomorrow'],
    ['2026-11-10T09:00', 'Electricity is due today'],
  ]);
  assert.ok(plan.every((n) => Number.isInteger(n.id) && n.id > 0));
});

test('paid bills only get next month’s reminders; overdue bills a daily nudge', () => {
  const state = defaultState();
  state.bills = [kplc];
  addTransactions(state, [pay('2026-10-08T10:00')]);
  assert.deepEqual(planNotifications(state, '2026-10-09T12:00').filter((n) => n.at).map((n) => n.at), ['2026-11-09T09:00', '2026-11-10T09:00']);

  const late = defaultState();
  late.bills = [kplc];
  const overdue = planNotifications(late, '2026-10-12T12:00').filter((n) => n.title.includes('overdue'));
  assert.deepEqual(overdue.map((n) => n.at), ['2026-10-13T09:00']);
  assert.deepEqual(planNotifications(late, '2026-10-12T08:00').filter((n) => n.title.includes('overdue')).map((n) => n.at), ['2026-10-12T09:00']);
});

test('settings switch reminders off', () => {
  const state = defaultState();
  state.bills = [kplc];
  assert.equal(planNotifications(state, '2026-10-05T12:00', { ...DEFAULT_NOTIFICATION_SETTINGS, weekly: false, bills: false }).length, 0);
});

test('budget warnings fire once per category, month and status', () => {
  const state = defaultState();
  state.budgets['2026-10'] = { month: '2026-10', expectedIncome: 0, savingsGoal: 0, limits: { Electricity: 250000 } };
  addTransactions(state, [pay('2026-10-03T10:00')]);
  const first = budgetNotifications(state, '2026-10-05');
  assert.equal(first.length, 1);
  assert.equal(first[0].title, 'Electricity budget almost used');
  assert.equal(budgetNotifications(state, '2026-10-05', new Set(first.map((n) => n.key))).length, 0);
  addTransactions(state, [{ ...pay('2026-10-04T10:00'), id: 'P2', code: 'P2' }]);
  const over = budgetNotifications(state, '2026-10-05', new Set(first.map((n) => n.key)));
  assert.equal(over[0].title, 'Electricity is over budget');
});

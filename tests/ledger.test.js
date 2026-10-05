import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessages } from '../src/lib/parser.js';
import { buildStatement, summarize, mergeTransactions, monthlyTrend } from '../src/lib/ledger.js';
import { evaluateBudget, suggestPlan } from '../src/lib/budget.js';
import { categorize } from '../src/lib/categories.js';
import { defaultState, addTransactions } from '../src/lib/store.js';
import { importCsv, transactionsToCsv, statementToCsv } from '../src/lib/csv.js';
import { SMS } from './fixtures.js';

function loaded() {
  const state = defaultState();
  addTransactions(state, parseMessages(Object.values(SMS).join('\n')).transactions);
  return state;
}

test('rules categorize merchants and respect direction', () => {
  const state = loaded();
  const cat = Object.fromEntries(state.transactions.map((t) => [t.code, t.category]));
  assert.equal(cat.TJ53ABCD03, 'Electricity');
  assert.equal(cat.TJ54ABCD04, 'Groceries');
  assert.equal(cat.TJ51ABCD01, 'Money received');
  // An expense rule must not reclassify incoming money.
  assert.equal(categorize({ direction: 'in', type: 'received', counterparty: 'SHELL KENYA' }), 'Money received');
});

test('statement balances reconcile with SMS balances', () => {
  const s = buildStatement(loaded().transactions);
  assert.equal(s.openingBalance, 200000);
  assert.equal(s.closingBalance, 3109750);
  assert.deepEqual(s.gaps, []);
  assert.equal(s.openingBalance + s.totalIn - s.totalOut, s.closingBalance);
});

test('statement flags missing transactions', () => {
  const txs = loaded().transactions.filter((t) => t.code !== 'TJ53ABCD03');
  const s = buildStatement(txs);
  assert.equal(s.gaps.length, 1);
  assert.equal(s.gaps[0].diff, -200000);
});

test('summary separates income, expenses, fees and transfers', () => {
  const s = summarize(loaded().transactions);
  assert.equal(s.income, 5000000);
  assert.equal(s.fees, 5200);
  // sent 1500 + paybill 2000 + groceries 3250.50 + withdrawal 5000 + airtime 100 + fees 52
  assert.equal(s.expenses, 150000 + 200000 + 325050 + 500000 + 10000 + 5200);
  assert.equal(s.net, s.income - s.expenses);
  assert.equal(monthlyTrend(loaded().transactions).length, 1);
});

test('merge skips duplicates', () => {
  const state = loaded();
  const again = parseMessages(SMS.sent).transactions;
  const r = mergeTransactions(state.transactions, again);
  assert.equal(r.added, 0);
  assert.equal(r.duplicates, 1);
});

test('budget evaluation statuses and alerts', () => {
  const state = loaded();
  const plan = { month: '2026-10', expectedIncome: 5000000, savingsGoal: 1000000, limits: { Groceries: 300000, Electricity: 250000 } };
  const b = evaluateBudget(plan, state.transactions, { categories: state.categories, today: '2026-10-05' });
  const line = Object.fromEntries(b.lines.map((l) => [l.name, l]));
  assert.equal(line.Groceries.status, 'over');
  assert.equal(line.Electricity.status, 'warning');
  assert.equal(line['Cash withdrawal'].status, 'unplanned');
  assert.ok(b.alerts.some((a) => a.level === 'danger'));
  assert.equal(b.days.remaining, 27);
  // Spending exactly the limit is "used up", not over budget.
  const exact = evaluateBudget({ ...plan, limits: { Electricity: 200000 } }, state.transactions, { categories: state.categories, today: '2026-10-05' });
  assert.equal(exact.lines.find((l) => l.name === 'Electricity').status, 'warning');
});

test('suggested plan rounds previous spending up to Ksh 100', () => {
  const s = summarize(loaded().transactions);
  const plan = suggestPlan('2026-11', { previousSummary: s });
  assert.equal(plan.limits.Groceries, 330000);
});

test('own CSV export round-trips', () => {
  const state = loaded();
  const { transactions } = importCsv(transactionsToCsv(state.transactions));
  assert.equal(transactions.length, state.transactions.length);
  assert.deepEqual(
    transactions.map((t) => [t.id, t.amount, t.fee, t.balance, t.category]),
    state.transactions.map((t) => [t.id, t.amount, t.fee, t.balance, t.category]),
  );
  assert.match(statementToCsv(buildStatement(state.transactions)), /Closing balance,31097\.50/);
});

test('imports a Safaricom statement CSV and folds charges into fees', () => {
  const csv = [
    'Receipt No.,Completion Time,Details,Transaction Status,Paid In,Withdrawn,Balance',
    'TJ62X,2026-10-03 08:00:00,Customer Transfer of Funds Charge,Completed,,-13.00,1937.00',
    'TJ62X,2026-10-03 08:00:00,Customer Transfer to - 0722****111 JANE WANJIKU,Completed,,-1000.00,1950.00',
    'TJ61X,2026-10-02 09:00:00,Pay Bill to 888880 - KPLC PREPAID Acc. 5432,Completed,,-500.00,2950.00',
    'TJ60X,2026-10-01 09:00:00,Funds received from - 0712****678 ACME LIMITED,Completed,3450.00,,3450.00',
    'TJ5ZX,2026-09-30 09:00:00,Customer Transfer to - 0722****111 X,Failed,,-5.00,0.00',
  ].join('\n');
  const { transactions, failed } = importCsv(csv);
  assert.deepEqual(failed, []);
  assert.equal(transactions.length, 3);
  const sent = transactions.find((t) => t.code === 'TJ62X');
  assert.equal(sent.type, 'sent');
  assert.equal(sent.fee, 1300);
  assert.equal(sent.balance, 193700);
  assert.equal(sent.counterparty, 'JANE WANJIKU');
  const bill = transactions.find((t) => t.code === 'TJ61X');
  assert.equal(bill.type, 'paybill');
  assert.equal(bill.account, '5432');
  const st = buildStatement(transactions);
  assert.deepEqual(st.gaps, []);
  assert.equal(st.openingBalance, 0);
});

test('imports semicolon CSV whose header was split over two rows by a PDF converter', () => {
  const csv = [
    'MPESA FULL STATEMENT;;;;;;',
    'Receipt;Completion;Details;Transaction;Paid In;Withdrawn;Balance',
    'No.;Time;;Status;;;',
    'TJ60X;2026-10-01 09:00:00;Funds received from - 0712****678 ACME;Completed;3,450.00;;3,450.00',
    'TJ61X;2026-10-02 09:00:00;Pay Bill to 888880 - KPLC;Completed;;-500.00;2,950.00',
    ';;PREPAID Acc. 5432;;;;',
    'Receipt No.;Completion Time;Details;Transaction Status;Paid In;Withdrawn;Balance',
  ].join('\n');
  const { transactions } = importCsv(csv);
  assert.equal(transactions.length, 2);
  const bill = transactions.find((t) => t.code === 'TJ61X');
  assert.equal(bill.counterparty, 'KPLC PREPAID');
  assert.equal(bill.account, '5432');
});

test('imports CSVs with other column names and day-first Excel dates', () => {
  const csv = [
    'Transaction ID,Date,Description,Money In,Money Out,Balance',
    'TJ70X,03/10/2026 8:15 PM,Merchant Payment to 12345 - NAIVAS,,(1200.00),800.00',
  ].join('\n');
  const [t] = importCsv(csv).transactions;
  assert.equal(t.date, '2026-10-03T20:15');
  assert.equal(t.amount, 120000);
  assert.equal(t.type, 'buygoods');
});

test('imports headerless Safaricom rows', () => {
  const csv = 'TJ80ABCDEF,2026-10-04 10:00:00,Customer Transfer to - 0722****111 JANE,Completed,,-250.00,1000.00\n';
  const [t] = importCsv(csv).transactions;
  assert.equal(t.direction, 'out');
  assert.equal(t.amount, 25000);
  assert.equal(t.balance, 100000);
});

test('explains files that are not CSV statements', () => {
  assert.throws(() => importCsv('%PDF-1.7 ...'), /This is a PDF/);
  assert.throws(() => importCsv('Name,Phone\nJohn,0712\n'), /Your file starts with: "Name \| Phone/);
});

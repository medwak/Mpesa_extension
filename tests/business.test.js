import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from '../src/lib/parser.js';
import { importCsv } from '../src/lib/csv.js';
import { defaultState, migrate, importTransactions, addTransactions } from '../src/lib/store.js';
import { addWallet, walletTxs, budgetsFor, removeWallet, PERSONAL } from '../src/lib/wallets.js';
import { payeeDirectory, billStatuses, billAlerts, suggestBills, newBillFromPayee } from '../src/lib/bills.js';
import { c2bToTransaction, fetchNewPayments, darajaTime } from '../src/lib/daraja.js';
import { summarize } from '../src/lib/ledger.js';
import worker from '../relay/worker.js';

test('parses Till, Paybill and Pochi payment notifications', () => {
  const till = parseMessage('RCI0ABCDEF Confirmed. on 18/3/26 at 1:18 PM Ksh100.00 received from 2547******78 JOHN DOE. New Account balance is Ksh1,234.00. Transaction cost, Ksh0.00');
  assert.deepEqual([till.type, till.direction, till.amount, till.counterparty, till.phone, till.balance, till.date], ['business_received', 'in', 10000, 'JOHN DOE', '2547******78', 123400, '2026-03-18T13:18']);
  const paybill = parseMessage('TJ5BIZ0001 Confirmed. Ksh2,500.00 received from MARY ATIENO 254722000111 Account Number HSE12 New Utility balance is Ksh 50,000.00');
  assert.deepEqual([paybill.type, paybill.counterparty, paybill.account, paybill.balance], ['business_received', 'MARY ATIENO', 'HSE12', 5000000]);
  const pochi = parseMessage('TJ5BIZ0002 Confirmed. You have received Ksh200.00 from PETER 0712345678 on 5/10/26 at 10:00 AM. New business balance is Ksh3,200.00.');
  assert.equal(pochi.type, 'business_received');
  // Personal "received" messages are unchanged.
  assert.equal(parseMessage('TJ51ABCD01 Confirmed.You have received Ksh50.00 from A B 0712345678 on 1/10/26 at 9:05 AM New M-PESA balance is Ksh52.00.').type, 'received');
});

test('imports an M-PESA Org Portal business statement', () => {
  const csv = [
    'Receipt No.,Completion Time,Initiation Time,Details,Transaction Status,Paid In,Withdrawn,Balance,Balance Confirmed,Reason Type,Other Party Info,Linked Transaction ID,A/C No.',
    'TB3,2026-10-03 17:00:00,2026-10-03 17:00:00,Organization Settle to Bank,Completed,,-4000.00,1100.00,true,Withdraw Funds to Bank,KCB BANK,,',
    'TB2,2026-10-02 12:30:00,2026-10-02 12:30:00,Pay Bill Online,Completed,3000.00,,5100.00,true,Pay Bill Online,2547****0111 - MARY ATIENO,,HSE12',
    'TB1,2026-10-01 09:00:00,2026-10-01 09:00:00,Pay Merchant,Completed,2100.00,,2100.00,true,Customer Buy Goods Online,0712****678 - JOHN DOE,,',
  ].join('\n');
  const { transactions, failed } = importCsv(csv);
  assert.deepEqual(failed, []);
  const by = Object.fromEntries(transactions.map((t) => [t.code, t]));
  assert.equal(by.TB1.type, 'business_received');
  assert.equal(by.TB1.counterparty, 'JOHN DOE');
  assert.equal(by.TB2.account, 'HSE12');
  assert.equal(by.TB2.counterparty, 'MARY ATIENO');
  assert.equal(by.TB3.type, 'settlement');
});

test('captures Paybill/Till numbers from personal statements', () => {
  const csv = 'Receipt No.,Completion Time,Details,Transaction Status,Paid In,Withdrawn,Balance\nTX1,2026-10-02 09:00:00,Pay Bill to 888880 - KPLC PREPAID Acc. 5432,Completed,,-500.00,100.00\n';
  const [t] = importCsv(csv).transactions;
  assert.deepEqual([t.shortcode, t.counterparty, t.account], ['888880', 'KPLC PREPAID', '5432']);
});

test('business accounts keep separate transactions, ids and budgets', () => {
  const state = defaultState();
  const shop = addWallet(state, { name: 'Mama Shop', kind: 'till', shortcode: '123456' });
  const pay = { id: 'TJ1', code: 'TJ1', date: '2026-10-01T10:00', type: 'business_received', direction: 'in', amount: 50000, fee: 0, counterparty: 'JOHN' };
  const personal = { id: 'TJ1', code: 'TJ1', date: '2026-10-01T10:00', type: 'buygoods', direction: 'out', amount: 50000, fee: 0, counterparty: 'MAMA SHOP' };
  // Paying your own Till: the same receipt shows on both sides.
  const r = importTransactions(state, [pay, personal], PERSONAL);
  assert.equal(r.added, 2);
  assert.equal(r.movedTo, shop.id);
  assert.equal(walletTxs(state, shop.id)[0].id, `${shop.id}:TJ1`);
  assert.equal(walletTxs(state, shop.id)[0].category, 'Sales & collections');
  assert.equal(walletTxs(state, PERSONAL).length, 1);
  assert.equal(summarize(walletTxs(state, shop.id), state.categories).income, 50000);
  budgetsFor(state, shop.id)['2026-10'] = { month: '2026-10', limits: {} };
  assert.equal(state.budgets['2026-10'], undefined);
  removeWallet(state, shop.id);
  assert.equal(state.transactions.length, 1);
});

test('migrates older saved data without losing it', () => {
  const old = { version: 1, transactions: [{ id: 'A', date: '2026-01-01T00:00', amount: 1 }], categories: [{ name: 'Groceries', kind: 'expense' }], rules: [], budgets: { '2026-01': {} } };
  const s = migrate(old);
  assert.equal(s.transactions.length, 1);
  assert.equal(s.wallets[0].id, PERSONAL);
  assert.ok(s.categories.some((c) => c.name === 'Sales & collections'));
  // A default deleted after migration stays deleted.
  s.categories = s.categories.filter((c) => c.name !== 'Supplier payments');
  assert.ok(!migrate(JSON.parse(JSON.stringify(s))).categories.some((c) => c.name === 'Supplier payments'));
});

const bill = (date, amount, extra = {}) => ({ id: date + amount, date, type: 'paybill', direction: 'out', amount, counterparty: 'KPLC PREPAID', account: '5432', ...extra });

test('payee directory, bill status and reminders', () => {
  const shop = (date) => ({ id: `s${date}`, date, type: 'buygoods', direction: 'out', amount: 30000 + Math.round(Math.random() * 5000), counterparty: 'JAVA HOUSE' });
  const txs = [bill('2026-07-03T08:00', 200000), bill('2026-08-04T08:00', 210000), bill('2026-09-03T08:00', 190000), bill('2026-09-10T08:00', 50000, { account: '9999' }),
    ...['2026-07-02', '2026-07-09', '2026-07-20', '2026-08-05', '2026-08-15', '2026-09-01', '2026-09-12'].map((d) => shop(`${d}T13:00`))];
  const dir = payeeDirectory(txs);
  assert.equal(dir.length, 3);
  assert.equal(dir.find((p) => p.account === '5432').count, 3);

  // A cafe paid several times a month is not suggested as a bill.
  const sugg = suggestBills(txs, [], '2026-10-02');
  assert.deepEqual(sugg.map((x) => x.payee.name), ['KPLC PREPAID']);
  assert.equal(sugg[0].typicalDay, 3);
  assert.equal(sugg[0].typicalAmount, 200000);
  const b = newBillFromPayee(sugg[0].payee, sugg[0]);
  assert.equal(suggestBills(txs, [b], '2026-10-02').length, 0);

  assert.equal(billStatuses([b], txs, '2026-10-02')[0].status, 'due-soon');
  assert.equal(billStatuses([b], txs, '2026-10-05')[0].status, 'overdue');
  assert.equal(billAlerts(billStatuses([b], txs, '2026-10-05'))[0].title, 'Bill overdue');
  const paidTxs = [...txs, bill('2026-10-04T08:00', 200000)];
  assert.equal(billStatuses([b], paidTxs, '2026-10-05')[0].status, 'paid');
  assert.equal(billStatuses([b], [...txs, bill('2026-10-04T08:00', 100000)], '2026-10-05')[0].status, 'partial');
});

const C2B = { TransactionType: 'Pay Bill', TransID: 'TJK1ABCDEF', TransTime: '20261005143012', TransAmount: '1500.00', BusinessShortCode: '600000', BillRefNumber: 'HSE12', OrgAccountBalance: '25000.00', MSISDN: '2547****0111', FirstName: 'MARY', MiddleName: '', LastName: 'ATIENO' };

test('converts Daraja C2B confirmations', () => {
  assert.equal(darajaTime('20261005143012'), '2026-10-05T14:30');
  const t = c2bToTransaction(C2B);
  assert.deepEqual([t.id, t.date, t.amount, t.counterparty, t.account, t.type, t.balance], ['TJK1ABCDEF', '2026-10-05T14:30', 150000, 'MARY ATIENO', 'HSE12', 'business_received', null]);
});

function memoryKv() {
  const store = new Map();
  return {
    async put(name, value, opts) { store.set(name, { name, metadata: opts?.metadata }); },
    async list({ prefix }) {
      const keys = [...store.values()].filter((k) => k.name.startsWith(prefix)).sort((a, b) => (a.name < b.name ? -1 : 1));
      return { keys, list_complete: true };
    },
  };
}

test('relay stores confirmations and serves them to the app', async () => {
  const env = { MPESA_TX: memoryKv(), SYNC_TOKEN: 'sync-123', HOOK_SECRET: 'hook-abc', SHORTCODE: '600000', DARAJA_CONSUMER_KEY: 'k', DARAJA_CONSUMER_SECRET: 's' };
  const post = (path, body) => worker.fetch(new Request(`https://relay.example${path}`, { method: 'POST', body: JSON.stringify(body) }), env);

  assert.equal((await post('/c2b/wrong/confirmation', C2B)).status, 404);
  const ok = await post('/c2b/hook-abc/confirmation', C2B);
  assert.equal((await ok.json()).ResultCode, 0);
  assert.equal((await worker.fetch(new Request('https://relay.example/transactions'), env)).status, 401);

  // The app side, talking to the worker through a fetch shim.
  const wallet = { relayUrl: 'https://relay.example/', relayToken: 'sync-123', shortcode: '600000' };
  const shim = (url, init) => worker.fetch(new Request(url, init), env);
  const first = await fetchNewPayments(wallet, shim);
  assert.equal(first.transactions.length, 1);
  wallet.lastSyncCursor = first.cursor;
  assert.equal((await fetchNewPayments(wallet, shim)).transactions.length, 0);
  await post('/c2b/hook-abc/confirmation', { ...C2B, TransID: 'TJK2ABCDEF' });
  const next = await fetchNewPayments(wallet, shim);
  assert.deepEqual(next.transactions.map((t) => t.id), ['TJK2ABCDEF']);

  const state = defaultState();
  const shop = addWallet(state, { name: 'Rentals', kind: 'paybill', shortcode: '600000' });
  addTransactions(state, [...first.transactions, ...next.transactions], shop.id);
  assert.equal(walletTxs(state, shop.id).length, 2);
});

test('relay registers callback URLs with Daraja', async () => {
  const env = { MPESA_TX: memoryKv(), SYNC_TOKEN: 't', HOOK_SECRET: 'h', SHORTCODE: '600000', DARAJA_CONSUMER_KEY: 'k', DARAJA_CONSUMER_SECRET: 's', DARAJA_ENV: 'sandbox' };
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/oauth/')) return new Response(JSON.stringify({ access_token: 'AT' }));
    return new Response(JSON.stringify({ ResponseCode: '0', ResponseDescription: 'Success' }));
  };
  try {
    const res = await worker.fetch(new Request('https://relay.example/setup/register', { method: 'POST', headers: { Authorization: 'Bearer t' } }), env);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(calls[0].url, /^https:\/\/sandbox\.safaricom\.co\.ke\/oauth\/v1\/generate/);
    assert.equal(calls[0].init.headers.Authorization, `Basic ${btoa('k:s')}`);
    const reg = JSON.parse(calls[1].init.body);
    assert.equal(reg.ConfirmationURL, 'https://relay.example/c2b/h/confirmation');
    assert.equal(reg.ShortCode, '600000');
  } finally {
    globalThis.fetch = realFetch;
  }
});

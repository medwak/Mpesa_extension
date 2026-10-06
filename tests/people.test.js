import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, phonesMatch, peopleDirectory, searchPeople, PEOPLE_SORTS } from '../src/lib/people.js';
import { defaultState, importTransactions, addTransactions } from '../src/lib/store.js';
import { importStatement } from '../src/lib/statements.js';
import { addWallet, walletTxs, getWallet, ALL_LINES, PERSONAL, lineForPhone, businessWallets } from '../src/lib/wallets.js';
import { statementPhone } from '../src/lib/pdf.js';
import { parseMessage } from '../src/lib/parser.js';

const tx = (id, date, type, direction, amount, counterparty, phone, extra = {}) => ({ id, code: id, date, type, direction, amount, fee: 0, counterparty, phone, ...extra });

test('normalizes and matches Kenyan numbers, including masked ones', () => {
  assert.equal(normalizePhone('+254 712 345 678'), '0712345678');
  assert.equal(normalizePhone('254712345678'), '0712345678');
  assert.equal(normalizePhone('712345678'), '0712345678');
  assert.equal(normalizePhone('2547******78'), '07******78');
  assert.ok(phonesMatch('0712345678', '0712****678'));
  assert.ok(!phonesMatch('0712345678', '0722****678'));
});

test('groups people by number, merging masked statement numbers with SMS numbers', () => {
  const txs = [
    tx('S1', '2026-09-01T10:00', 'sent', 'out', 150000, 'JANE WANJIKU', '0722000111', { fee: 2300 }),
    tx('S2', '2026-09-20T10:00', 'sent', 'out', 50000, 'JANE WANJIKU', '0722****111'),
    tx('R1', '2026-09-05T10:00', 'received', 'in', 300000, 'JANE W', '254722000111'),
    tx('R2', '2026-09-07T10:00', 'received', 'in', 5000000, 'ACME LIMITED', '0712345678'),
    tx('P1', '2026-09-08T10:00', 'paybill', 'out', 200000, 'KPLC PREPAID', ''),
    tx('S3', '2026-09-09T10:00', 'sent', 'out', 10000, 'PETER', ''),
  ];
  const people = peopleDirectory(txs);
  assert.equal(people.length, 3); // Jane, ACME, Peter (KPLC is a Paybill, not a person)
  const jane = people.find((p) => p.phones.includes('0722000111'));
  assert.deepEqual([jane.sentTotal, jane.receivedTotal, jane.count, jane.fees, jane.net], [200000, 300000, 3, 2300, 100000]);
  assert.deepEqual(jane.phones, ['0722000111', '0722****111']);
  assert.equal(jane.last, '2026-09-20T10:00');
  assert.equal(searchPeople(people, '0722 000 111').length, 1);
  assert.equal(searchPeople(people, '722000').length, 1);
  assert.equal(searchPeople(people, 'acme')[0].name, 'ACME LIMITED');
  assert.equal([...people].sort(PEOPLE_SORTS.received)[0].name, 'ACME LIMITED');
});

test('own lines: separate books, all-lines view, phone and balance routing', () => {
  const state = defaultState();
  state.wallets[0].phone = '0711111111';
  const line2 = addWallet(state, { name: 'Safaricom line 2', kind: 'line', phone: '+254 722 222 222' });
  assert.equal(line2.phone, '0722222222');
  assert.equal(businessWallets(state).length, 0);
  assert.equal(lineForPhone(state, '0722****222').id, line2.id);

  // Line 2 already has a message ending on Ksh 1,000.
  addTransactions(state, [tx('L2A', '2026-10-01T09:00', 'received', 'in', 100000, 'A', '0700000001', { balance: 100000 })], line2.id);
  // A new message whose balance continues line 2, imported while line 1 is chosen.
  const next = parseMessage('TJ9ZZZZZ01 Confirmed. Ksh300.00 sent to BOB 0733333333 on 2/10/26 at 10:00 AM. New M-PESA balance is Ksh700.00. Transaction cost, Ksh0.00.');
  const r = importTransactions(state, [next], PERSONAL);
  assert.equal(r.lineMovedTo, line2.id);
  assert.equal(walletTxs(state, line2.id).length, 2);
  assert.equal(walletTxs(state, PERSONAL).length, 0);

  // All lines together.
  addTransactions(state, [tx('L1A', '2026-10-03T09:00', 'received', 'in', 5000, 'C', '0700000002')], PERSONAL);
  assert.equal(getWallet(state, ALL_LINES).name, 'All my M-Pesa lines');
  assert.equal(walletTxs(state, ALL_LINES).length, 3);

  // A statement printed for line 2's number goes to line 2.
  const st = importStatement(state, [tx('ST1', '2026-10-04T09:00', 'received', 'in', 1000, 'D', '0700000003', { source: 'statement' })], PERSONAL, { name: 'line2.pdf', phone: '0722222222' });
  assert.equal(st.statement.wallet, line2.id);
});

test('reads the mobile number printed on a statement', () => {
  assert.deepEqual(statementPhone(['M-PESA STATEMENT', 'Customer Name: TEST USER', 'Mobile Number: 0722 222 222']), { phone: '0722222222' });
  assert.deepEqual(statementPhone(['nothing']), {});
});

test('the all-lines view survives reloading saved data', async () => {
  const { migrate } = await import('../src/lib/store.js');
  const state = defaultState();
  addWallet(state, { name: 'Line 2', kind: 'line', phone: '0722222222' });
  state.settings.currentWallet = ALL_LINES;
  assert.equal(migrate(JSON.parse(JSON.stringify(state))).settings.currentWallet, ALL_LINES);
  const single = defaultState();
  single.settings.currentWallet = ALL_LINES;
  assert.equal(migrate(single).settings.currentWallet, PERSONAL);
});

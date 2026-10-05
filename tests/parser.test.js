import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, parseMessages, parseDate } from '../src/lib/parser.js';
import { SMS } from './fixtures.js';

test('parses dates with AM/PM', () => {
  assert.equal(parseDate('on 2/10/26 at 6:30 PM'), '2026-10-02T18:30');
  assert.equal(parseDate('on 12/1/2026 at 12:05 AM'), '2026-01-12T00:05');
});

test('received money', () => {
  const t = parseMessage(SMS.received);
  assert.equal(t.code, 'TJ51ABCD01');
  assert.equal(t.type, 'received');
  assert.equal(t.direction, 'in');
  assert.equal(t.amount, 5000000);
  assert.equal(t.counterparty, 'ACME LIMITED');
  assert.equal(t.phone, '0712345678');
  assert.equal(t.balance, 5200000);
  assert.equal(t.date, '2026-10-01T09:05');
});

test('send money with transaction cost', () => {
  const t = parseMessage(SMS.sent);
  assert.equal(t.type, 'sent');
  assert.equal(t.amount, 150000);
  assert.equal(t.fee, 2300);
  assert.equal(t.counterparty, 'JANE WANJIKU');
});

test('paybill captures account number', () => {
  const t = parseMessage(SMS.paybill);
  assert.equal(t.type, 'paybill');
  assert.equal(t.counterparty, 'KPLC PREPAID');
  assert.equal(t.account, '54321098765');
});

test('buy goods, withdraw, deposit, airtime, savings', () => {
  assert.deepEqual(
    [SMS.buygoods, SMS.withdraw, SMS.deposit, SMS.airtime, SMS.mshwari].map((s) => {
      const t = parseMessage(s);
      return [t.type, t.direction, t.amount, t.fee];
    }),
    [
      ['buygoods', 'out', 325050, 0],
      ['withdraw', 'out', 500000, 2900],
      ['deposit', 'in', 100000, 0],
      ['airtime', 'out', 10000, 0],
      ['savings_out', 'out', 1000000, 0],
    ],
  );
  assert.equal(parseMessage(SMS.buygoods).counterparty, 'NAIVAS SUPERMARKET WESTLANDS');
  assert.equal(parseMessage(SMS.withdraw).counterparty, '123456 - MAMA MBOGA AGENT Kilimani');
});

test('fuliza notices get a distinct id from the payment they funded', () => {
  const t = parseMessage(
    'TJ59ABCD09 Confirmed. Fuliza M-PESA amount is Ksh 150.00. Access Fee charged Ksh 1.50. Total Fuliza M-PESA outstanding amount is Ksh151.50 due on 04/11/26. To check daily charges, Dial *234*0#',
  );
  assert.equal(t.id, 'TJ59ABCD09-FULIZA');
  assert.equal(t.amount, 15000);
  assert.equal(t.fee, 150);
});

test('splits a pasted thread and reports unparseable chunks', () => {
  const bulk = 'Hello, your data bundle expires today.\n' + Object.values(SMS).join('\n');
  const { transactions, failed } = parseMessages(bulk);
  assert.equal(transactions.length, 8);
  assert.equal(failed.length, 1);
});

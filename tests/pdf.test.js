import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupLines, linesToRows } from '../src/lib/pdf.js';
import { importRows } from '../src/lib/csv.js';

// Positions mimic the Safaricom "Detailed Statement" table layout.
const item = (str, x, y, w = str.length * 4.5, page = 1) => ({ str, x, y, w, page });
const header = (y, page = 1) => [
  item('Receipt No.', 40, y, 45, page), item('Completion Time', 110, y, 60, page), item('Details', 200, y, 30, page),
  item('Transaction Status', 370, y, 60, page), item('Paid In', 450, y, 30, page), item('Withdrawn', 505, y, 45, page), item('Balance', 570, y, 35, page),
];

test('rebuilds statement rows from positioned PDF text', () => {
  const items = [
    item('SUMMARY', 40, 780), item('TRANSACTION TYPE', 40, 765), item('PAID IN', 300, 765), item('PAID OUT', 400, 765),
    item('Send Money', 40, 750), item('0.00', 300, 750), item('1,013.00', 400, 750),
    item('DETAILED STATEMENT', 40, 720),
    ...header(705),
    item('TJ62ABCDEF', 40, 690), item('2026-10-03 08:00:00', 110, 690), item('Customer Transfer of Funds Charge', 200, 690), item('Completed', 370, 690),
    item('-13.00', 520, 690, 25), item('1,937.00', 570, 690, 35),
    item('TJ62ABCDEF', 40, 675), item('2026-10-03 08:00:00', 110, 675), item('Customer Transfer to - 0722****111', 200, 675), item('Completed', 370, 675),
    item('-1,000.00', 512, 675, 38), item('1,950.00', 570, 675, 35),
    item('JANE WANJIKU', 200, 665),
    item('TJ61ABCDEF', 40, 650), item('2026-10-02', 110, 650), item('Pay Bill to 888880 - KPLC PREPAID', 200, 650), item('Completed', 370, 650),
    item('-500.00', 518, 650, 30), item('2,950.00', 570, 650, 35),
    item('09:00:00', 110, 640), item('Acc. 5432', 200, 640),
    item('Disclaimer: this statement is produced for your information', 40, 620),
    item('only.', 200, 610),
    item('Page 1 of 2', 280, 40),
    ...header(780, 2),
    item('TJ60ABCDEF', 40, 765, 45, 2), item('2026-10-01 09:00:00', 110, 765, 60, 2), item('Funds received from - 0712****678 ACME LIMITED', 200, 765, 160, 2),
    item('Completed', 370, 765, 40, 2), item('3,450.00', 446, 765, 34, 2), item('3,450.00', 570, 765, 35, 2),
  ];
  const rows = linesToRows(groupLines(items));
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[2], ['TJ62ABCDEF', '2026-10-03 08:00:00', 'Customer Transfer to - 0722****111 JANE WANJIKU', 'Completed', '', '-1,000.00', '1,950.00']);
  // The wrapped disclaimer word "only." must not be glued onto the last row.
  assert.deepEqual(rows[3].slice(0, 3), ['TJ61ABCDEF', '2026-10-02 09:00:00', 'Pay Bill to 888880 - KPLC PREPAID Acc. 5432']);
  assert.equal(rows[4][4], '3,450.00');

  const { transactions, failed } = importRows(rows);
  assert.deepEqual(failed, []);
  const sent = transactions.find((t) => t.code === 'TJ62ABCDEF');
  assert.equal(sent.counterparty, 'JANE WANJIKU');
  assert.equal(sent.fee, 1300);
  assert.equal(sent.balance, 193700);
  const bill = transactions.find((t) => t.code === 'TJ61ABCDEF');
  assert.equal(bill.date, '2026-10-02T09:00');
  assert.equal(bill.account, '5432');
  assert.equal(transactions.find((t) => t.code === 'TJ60ABCDEF').direction, 'in');
});

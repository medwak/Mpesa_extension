import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultState, addTransactions } from '../src/lib/store.js';
import { importStatement, deleteStatement, statementsFor, combineStatements, coverageGaps, statementTxs } from '../src/lib/statements.js';
import { buildStatement } from '../src/lib/ledger.js';
import { statementPeriod } from '../src/lib/pdf.js';
import { PERSONAL } from '../src/lib/wallets.js';

// Statement rows with a running balance starting at Ksh 1,000.
let balance = 100000;
const row = (code, date, amount, dir = 'out') => {
  balance += dir === 'in' ? amount : -amount;
  return { id: code, code, date, type: dir === 'in' ? 'received' : 'buygoods', direction: dir, amount, fee: 0, counterparty: 'X', balance, source: 'statement' };
};
const JAN = [row('A1', '2026-01-05T10:00', 500000, 'in'), row('A2', '2026-01-20T10:00', 100000)];
const FEB = [row('B1', '2026-02-03T10:00', 50000), row('B2', '2026-02-25T10:00', 20000)];
const MAR = [row('C1', '2026-03-10T10:00', 30000)];

test('imports statements as separate entries and deletes them independently', () => {
  const state = defaultState();
  const jan = importStatement(state, JAN, PERSONAL, { name: 'jan.pdf', kind: 'pdf', from: '2026-01-01', to: '2026-01-31' });
  // Overlapping second upload (Jan 20 again plus Feb).
  const feb = importStatement(state, [JAN[1], ...FEB], PERSONAL, { name: 'feb.csv', kind: 'csv' });
  assert.equal(jan.added, 2);
  assert.deepEqual([feb.added, feb.duplicates], [2, 1]);
  assert.equal(state.transactions.length, 4);
  const list = statementsFor(state, PERSONAL);
  assert.deepEqual(list.map((s) => [s.name, s.from, s.to, s.count]), [['jan.pdf', '2026-01-01', '2026-01-31', 2], ['feb.csv', '2026-01-20', '2026-02-25', 3]]);
  assert.equal(list[0].openingBalance, 100000);
  assert.equal(list[0].closingBalance, 500000);

  // Deleting January keeps A2 because February's file also contains it.
  const r = deleteStatement(state, jan.statement.id);
  assert.deepEqual(r, { removed: 1, kept: 1 });
  assert.deepEqual(state.transactions.map((t) => t.id), ['A2', 'B1', 'B2']);
  deleteStatement(state, feb.statement.id);
  assert.equal(state.transactions.length, 0);
  assert.equal(state.statements.length, 0);
});

test('deleting a statement keeps transactions that also came from SMS', () => {
  const state = defaultState();
  addTransactions(state, [{ ...JAN[0], source: 'sms' }]);
  const s = importStatement(state, JAN, PERSONAL, { name: 'jan.pdf' });
  assert.equal(s.duplicates, 1);
  deleteStatement(state, s.statement.id);
  assert.deepEqual(state.transactions.map((t) => t.id), ['A1']);
});

test('combines consecutive months, counts overlaps once and reports gaps', () => {
  const state = defaultState();
  const ids = [
    importStatement(state, JAN, PERSONAL, { name: 'jan', from: '2026-01-01', to: '2026-01-31' }).statement.id,
    importStatement(state, [JAN[1], ...FEB], PERSONAL, { name: 'feb', from: '2026-01-20', to: '2026-02-28' }).statement.id,
    importStatement(state, MAR, PERSONAL, { name: 'mar', from: '2026-03-01', to: '2026-03-31' }).statement.id,
  ];
  const all = combineStatements(state, ids);
  assert.deepEqual([all.from, all.to, all.txs.length, all.gaps.length], ['2026-01-01', '2026-03-31', 5, 0]);
  const st = buildStatement(all.txs, { from: all.from, to: all.to });
  assert.deepEqual([st.openingBalance, st.closingBalance, st.gaps.length], [100000, 400000, 0]);

  // January + March without February: the missing month is reported.
  const jm = combineStatements(state, [ids[0], ids[2]]);
  assert.deepEqual(jm.gaps, [{ from: '2026-02-01', to: '2026-02-28' }]);
  assert.equal(buildStatement(jm.txs, { from: jm.from, to: jm.to }).gaps.length, 1);
  assert.equal(statementTxs(state, [ids[2]]).length, 1);
});

test('coverage gaps across years, ignoring gaps the balance carries over', () => {
  assert.deepEqual(coverageGaps([{ from: '2024-01-01', to: '2024-12-31' }, { from: '2026-01-01', to: '2026-06-30' }]), [{ from: '2025-01-01', to: '2025-12-31' }]);
  const a = { from: '2026-01-05', to: '2026-01-28', closingBalance: 5000 };
  assert.deepEqual(coverageGaps([a, { from: '2026-02-03', to: '2026-02-20', openingBalance: 5000 }]), []);
  assert.equal(coverageGaps([a, { from: '2026-02-03', to: '2026-02-20', openingBalance: 4000 }]).length, 1);
});

test('reads the printed statement period from a PDF', () => {
  assert.deepEqual(statementPeriod(['M-PESA STATEMENT', 'Statement Period: 01 Sep 2026 - 30 Sep 2026']), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(statementPeriod(['nothing here']), {});
});

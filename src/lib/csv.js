// CSV import/export. Import understands both this extension's own export and
// the columns of the official Safaricom M-Pesa statement (Receipt No.,
// Completion Time, Details, Transaction Status, Paid In, Withdrawn, Balance).

import { parseAmount, toPlain } from './money.js';

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

function esc(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  return rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

const TX_COLUMNS = ['id', 'code', 'date', 'type', 'direction', 'amount', 'fee', 'counterparty', 'phone', 'account', 'balance', 'category', 'note'];

export function transactionsToCsv(txs) {
  return toCsv([
    TX_COLUMNS,
    ...txs.map((t) =>
      TX_COLUMNS.map((k) => (k === 'amount' || k === 'fee' || k === 'balance' ? (t[k] == null ? '' : toPlain(t[k])) : t[k] ?? '')),
    ),
  ]);
}

export function statementToCsv(statement) {
  return toCsv([
    ['Receipt No.', 'Completion Time', 'Details', 'Category', 'Paid In', 'Withdrawn', 'Transaction Cost', 'Balance'],
    ...statement.rows.map((r) => [
      r.code,
      r.date.replace('T', ' '),
      r.details,
      r.category,
      r.paidIn ? toPlain(r.paidIn) : '',
      r.withdrawn ? toPlain(r.withdrawn) : '',
      r.fee ? toPlain(r.fee) : '',
      toPlain(r.balance),
    ]),
    [],
    ['Opening balance', toPlain(statement.openingBalance)],
    ['Total paid in', toPlain(statement.totalIn)],
    ['Total paid out', toPlain(statement.totalOut)],
    ['Closing balance', toPlain(statement.closingBalance)],
  ]);
}

function normHeader(h) {
  return h.toLowerCase().replace(/[^a-z]/g, '');
}

function inferType(details, direction) {
  const d = details.toLowerCase();
  if (/reversal/.test(d)) return 'reversal';
  if (/overdraft|fuliza/.test(d) && direction === 'in') return 'fuliza';
  if (/od loan repayment|fuliza/.test(d)) return 'fuliza_repay';
  if (/m-shwari|mshwari|lock savings|ziidi/.test(d)) return direction === 'in' ? 'savings_in' : 'savings_out';
  if (/airtime/.test(d)) return 'airtime';
  if (/pay ?bill/.test(d)) return 'paybill';
  if (/merchant payment|buy goods|till/.test(d) && !/withdraw/.test(d)) return 'buygoods';
  if (/withdraw/.test(d)) return 'withdraw';
  if (/deposit/.test(d)) return 'deposit';
  if (/received|business payment from|salary/.test(d)) return 'received';
  if (/transfer|sent/.test(d)) return 'sent';
  return direction === 'in' ? 'received' : 'sent';
}

function counterpartyFrom(details) {
  // "Pay Bill to 888880 - KPLC PREPAID Acc. 123" -> KPLC PREPAID / 123
  const m = details.match(/\s-\s(.+?)(?:\s+Acc\.\s*(.+))?$/i);
  if (!m) return { counterparty: details.trim(), account: '' };
  let name = m[1].trim();
  let phone = '';
  const ph = name.match(/^((?:\+?254|0)?\d{2,4}\*+\d{2,4}|\d{9,12})\s+(.*)$/);
  if (ph) {
    phone = ph[1];
    name = ph[2];
  }
  return { counterparty: name, phone, account: (m[2] || '').trim() };
}

function normDate(s) {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${m[4].padStart(2, '0')}:${m[5]}`;
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${t}T00:00`;
  return null;
}

export function importCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { transactions: [], failed: [] };
  const headerIdx = rows.findIndex((r) => r.map(normHeader).some((h) => h === 'receiptno' || h === 'id' || h === 'code'));
  if (headerIdx < 0) throw new Error('Unrecognised CSV: expected a "Receipt No." or "id" column');
  const header = rows[headerIdx].map(normHeader);
  const col = (name) => header.indexOf(name);
  const body = rows.slice(headerIdx + 1);
  const failed = [];

  // Own export format.
  if (col('direction') >= 0 && col('amount') >= 0) {
    const transactions = [];
    for (const r of body) {
      const get = (k) => (col(k) >= 0 ? (r[col(k)] || '').trim() : '');
      const date = normDate(get('date'));
      const amount = parseAmount(get('amount'));
      if (!date || !amount) {
        failed.push(r.join(','));
        continue;
      }
      transactions.push({
        id: get('id') || get('code'),
        code: get('code'),
        date,
        type: get('type') || 'manual',
        direction: get('direction') === 'in' ? 'in' : 'out',
        amount,
        fee: parseAmount(get('fee')) || 0,
        counterparty: get('counterparty'),
        phone: get('phone'),
        account: get('account'),
        balance: parseAmount(get('balance')),
        category: get('category') || undefined,
        note: get('note'),
        source: 'csv',
      });
    }
    return { transactions, failed };
  }

  // Safaricom statement format: charges are separate rows sharing the receipt
  // number of the transaction they belong to, so fold them into its fee.
  const iCode = col('receiptno');
  const iTime = col('completiontime');
  const iDetails = col('details');
  const iStatus = col('transactionstatus');
  const iIn = col('paidin');
  const iOut = col('withdrawn');
  const iBal = col('balance');
  if ([iCode, iTime, iDetails].some((i) => i < 0)) throw new Error('CSV is missing Receipt No., Completion Time or Details columns');

  const byCode = new Map();
  const charges = [];
  for (const r of body) {
    const code = (r[iCode] || '').trim();
    const details = (r[iDetails] || '').trim();
    const status = iStatus >= 0 ? (r[iStatus] || '').trim().toLowerCase() : 'completed';
    if (status && status !== 'completed') continue;
    const date = normDate(r[iTime] || '');
    const paidIn = Math.abs(parseAmount(iIn >= 0 ? r[iIn] : '') || 0);
    const paidOut = Math.abs(parseAmount(iOut >= 0 ? r[iOut] : '') || 0);
    if (!code || !date || (!paidIn && !paidOut)) {
      if (code || details) failed.push(r.join(','));
      continue;
    }
    if (/charge/i.test(details) && paidOut) {
      charges.push({ code, amount: paidOut, balance: iBal >= 0 ? parseAmount(r[iBal]) : null });
      continue;
    }
    const direction = paidIn ? 'in' : 'out';
    const id = byCode.has(code) ? `${code}-${byCode.size}` : code;
    byCode.set(id, {
      id,
      code,
      date,
      type: inferType(details, direction),
      direction,
      amount: paidIn || paidOut,
      fee: 0,
      ...counterpartyFrom(details),
      balance: iBal >= 0 ? parseAmount(r[iBal]) : null,
      note: details,
      source: 'statement',
    });
  }
  for (const ch of charges) {
    const tx = byCode.get(ch.code);
    if (tx) {
      tx.fee += ch.amount;
      // The charge row carries the balance after the fee was deducted.
      if (ch.balance != null) tx.balance = ch.balance;
    } else failed.push(`Charge ${ch.code} without matching transaction`);
  }
  return { transactions: [...byCode.values()], failed };
}

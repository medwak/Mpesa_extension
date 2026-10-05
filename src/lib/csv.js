// CSV import/export. Import understands both this extension's own export and
// the columns of the official Safaricom M-Pesa statement (Receipt No.,
// Completion Time, Details, Transaction Status, Paid In, Withdrawn, Balance).

import { parseAmount, toPlain } from './money.js';

export function parseCsv(text, delimiter = ',') {
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
    else if (c === delimiter) {
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
  // Business (Org Portal) statements.
  if (direction === 'in' && /pay ?bill online|customer (?:pay ?bill|buy goods|merchant)|pay merchant|buy goods (?:online|payment) from|merchant payment from|c2b|till payment from|pay ?bill from|payment from .* acc/.test(d)) return 'business_received';
  if (direction === 'out' && /settle|to bank|bank transfer|withdraw(?:al)? (?:of funds )?to bank|organi[sz]ation (?:withdraw|transfer)|working account to/.test(d)) return 'settlement';
  if (direction === 'out' && /salary payment|business payment to|b2c|disbursement|promotion payment|business to business|b2b|business buy goods|business pay ?bill/.test(d)) return 'payout';
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

function counterpartyFrom(details, otherParty = '') {
  // "Pay Bill to 888880 - KPLC PREPAID Acc. 123" -> KPLC PREPAID / 888880 / 123
  const sc = details.match(/\b(?:to|from|at|Till)\s+(\d{5,7})\s+-\s/i);
  const shortcode = sc ? sc[1] : '';
  // Org Portal "Other Party Info": "2547****0111 - MARY ATIENO"
  if (otherParty) {
    const parts = otherParty.split(/\s+-\s+/);
    const name = parts.length > 1 ? parts.slice(1).join(' - ') : parts[0];
    const phone = parts.length > 1 ? parts[0] : '';
    const acc = details.match(/\s+Acc\.\s*(.+)$/i);
    return { counterparty: name.trim(), phone: phone.trim(), account: acc ? acc[1].trim() : '', shortcode };
  }
  const source = details;
  const m = source.match(/\s-\s(.+?)(?:\s+Acc\.\s*(.+))?$/i);
  const accInDetails = details.match(/\s+Acc\.\s*(.+)$/i);
  if (!m) return { counterparty: details.trim(), account: accInDetails ? accInDetails[1].trim() : '', shortcode };
  let name = m[1].trim();
  let phone = '';
  const ph = name.match(/^((?:\+?254|0)?\d{2,4}\*+\d{2,4}|\d{9,12})\s+(.*)$/);
  if (ph) {
    phone = ph[1];
    name = ph[2];
  }
  return { counterparty: name, phone, account: (m[2] || (accInDetails ? accInDetails[1] : '')).trim(), shortcode };
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function isoFrom(y, mo, d, h = 0, mi = 0, ap = '') {
  let year = Number(y);
  if (year < 100) year += 2000;
  let month = Number(mo);
  let day = Number(d);
  // Kenyan files are day-first; swap only when that is impossible.
  if (month > 12 && day <= 12) [month, day] = [day, month];
  if (!month || month > 12 || !day || day > 31) return null;
  let hour = Number(h);
  if (/pm/i.test(ap) && hour < 12) hour += 12;
  if (/am/i.test(ap) && hour === 12) hour = 0;
  const pad = (v) => String(v).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(mi)}`;
}

export function normDate(s) {
  const t = String(s || '').trim();
  const time = '(?:[ T,]+(\\d{1,2}):(\\d{2})(?::\\d{2})?\\s*(AM|PM)?)?';
  let m = t.match(new RegExp(`^(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})${time}`, 'i'));
  if (m) return isoFrom(m[1], m[2], m[3], m[4], m[5], m[6]);
  m = t.match(new RegExp(`^(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{2,4})${time}`, 'i'));
  if (m) return isoFrom(m[3], m[2], m[1], m[4], m[5], m[6]);
  m = t.match(new RegExp(`^(\\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ,]+(\\d{2,4})${time}`, 'i'));
  if (m && MONTHS[m[2].toLowerCase()]) return isoFrom(m[3], MONTHS[m[2].toLowerCase()], m[1], m[4], m[5], m[6]);
  return null;
}

// Header names seen in Safaricom statements and in the CSVs that PDF/Excel
// converters produce from them, normalised to lowercase letters only.
const HEADER_SYNONYMS = {
  code: ['receiptno', 'receiptnumber', 'receipt', 'transactionid', 'transactionno', 'transactionnumber', 'transactioncode', 'transactionref', 'mpesacode', 'mpesaref', 'mpesareceipt', 'reference', 'referenceno', 'refno', 'ref', 'code', 'id'],
  time: ['completiontime', 'completiondate', 'completedtime', 'completedon', 'date', 'time', 'datetime', 'dateandtime', 'transactiondate', 'transactiontime', 'transactiondatetime', 'initiationtime', 'valuedate'],
  details: ['details', 'detail', 'description', 'narration', 'narrative', 'particulars', 'transactiondetails', 'remarks'],
  reason: ['reasontype', 'transactiontype', 'type'],
  otherParty: ['otherpartyinfo', 'otherparty', 'otherpartyname', 'customer', 'customername', 'sender', 'msisdn'],
  acct: ['acno', 'accno', 'accountno', 'accountnumber', 'billrefnumber', 'billreference', 'billrefno'],
  status: ['transactionstatus', 'status'],
  paidIn: ['paidin', 'moneyin', 'credit', 'credits', 'cr', 'in', 'deposit', 'deposits', 'amountin', 'receivedamount', 'received'],
  withdrawn: ['withdrawn', 'withdrawal', 'withdrawals', 'paidout', 'moneyout', 'debit', 'debits', 'dr', 'out', 'amountout', 'spent'],
  amount: ['amount', 'transactionamount', 'amountksh', 'amountkes'],
  balance: ['balance', 'runningbalance', 'accountbalance', 'balanceksh', 'balancekes', 'newbalance'],
};
const FIELD_OF = new Map(Object.entries(HEADER_SYNONYMS).flatMap(([f, names]) => names.map((n) => [n, f])));
const CODE_CELL_RE = /^[A-Z0-9]{10}$/;

function mapHeader(cells) {
  const map = {};
  cells.forEach((c, i) => {
    const f = FIELD_OF.get(normHeader(c));
    if (f && map[f] == null) map[f] = i;
  });
  return map;
}

function usableMap(m) {
  return m.time != null && (m.paidIn != null || m.withdrawn != null || m.amount != null) && (m.code != null || m.details != null);
}

// Finds the header row. Converters often break a header over two lines
// ("Receipt" / "No."), so each row is also tried merged with the next one.
function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 80); i++) {
    const single = mapHeader(rows[i]);
    if (usableMap(single)) return { index: i, size: 1, map: single };
    if (rows[i + 1]) {
      const width = Math.max(rows[i].length, rows[i + 1].length);
      const merged = Array.from({ length: width }, (_, k) => `${rows[i][k] || ''} ${rows[i + 1][k] || ''}`);
      const m = mapHeader(merged);
      if (usableMap(m)) return { index: i, size: 2, map: m };
    }
  }
  return null;
}

// No header at all: find a row with an M-Pesa receipt code followed by a date
// and assume the Safaricom column order from there.
function guessHeaderless(rows) {
  for (const r of rows) {
    const c = r.findIndex((v) => CODE_CELL_RE.test((v || '').trim()));
    if (c < 0 || !normDate(r[c + 1])) continue;
    const hasStatus = /^(completed|failed|pending|cancelled)$/i.test((r[c + 3] || '').trim());
    const base = hasStatus ? c + 4 : c + 3;
    return { index: -1, size: 0, map: { code: c, time: c + 1, details: c + 2, status: hasStatus ? c + 3 : undefined, paidIn: base, withdrawn: base + 1, balance: base + 2 } };
  }
  return null;
}

export function detectDelimiter(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t', '|']) {
    const count = lines.reduce((s, l) => s + l.replace(/"[^"]*"/g, '').split(d).length - 1, 0);
    if (count > bestCount) [best, bestCount] = [d, count];
  }
  return best;
}

function sniffWrongFile(text) {
  const head = String(text).slice(0, 8);
  if (head.startsWith('%PDF')) return 'This is a PDF. Upload it with the PDF option so it can be read as a statement.';
  if (head.startsWith('PK')) return 'This looks like an Excel (.xlsx) file. In Excel choose File → Save As → "CSV (Comma delimited)", or in Google Sheets File → Download → CSV, then upload that file.';
  if (/[\u0000-\u0008]/.test(String(text).slice(0, 2000))) return 'This file is not a text CSV. Save it as CSV and try again.';
  return null;
}

function importOwnFormat(body, map) {
  const failed = [];
  const transactions = [];
  for (const r of body) {
    const get = (k) => (map[k] != null ? (r[map[k]] || '').trim() : '');
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
      amount: Math.abs(amount),
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

export function importCsv(text) {
  const wrong = sniffWrongFile(text);
  if (wrong) throw new Error(wrong);
  return importRows(parseCsv(text, detectDelimiter(text)));
}

// Imports a table given as rows of cells (from a CSV or from a PDF statement).
export function importRows(rows) {
  if (!rows.length) throw new Error('The file is empty.');

  // Own export format (has "direction" and "amount" columns).
  const ownIdx = rows.findIndex((r) => {
    const h = r.map(normHeader);
    return h.includes('direction') && h.includes('amount') && (h.includes('id') || h.includes('code'));
  });
  if (ownIdx >= 0) {
    const map = {};
    rows[ownIdx].forEach((c, i) => (map[normHeader(c)] = i));
    return importOwnFormat(rows.slice(ownIdx + 1), map);
  }

  const header = findHeader(rows) || guessHeaderless(rows);
  if (!header) {
    const preview = rows.slice(0, 3).map((r) => r.filter((c) => c.trim()).join(' | ')).join('  /  ').slice(0, 220);
    throw new Error(
      `Could not find the statement columns. Expected headings like Receipt No., Completion Time, Details, Paid In, Withdrawn, Balance. ` +
      `Your file starts with: "${preview}". If you converted a PDF, make sure the "Detailed Statement" table was included.`,
    );
  }

  const m = header.map;
  const cell = (r, k) => (m[k] != null ? (r[m[k]] || '').trim() : '');
  const body = rows.slice(header.index + header.size);
  const records = [];
  const charges = [];
  const failed = [];
  let last = null;

  for (const r of body) {
    const code = cell(r, 'code');
    const details = cell(r, 'details');
    const rawTime = cell(r, 'time');
    // Repeated header rows (one per PDF page).
    if (FIELD_OF.get(normHeader(code)) === 'code' || FIELD_OF.get(normHeader(rawTime)) === 'time') continue;
    const date = normDate(rawTime);
    // A wrapped "Details" cell continues on the next row with nothing else.
    if (!code && !date && details) {
      if (last) last.details = `${last.details} ${details}`.trim();
      continue;
    }
    const status = cell(r, 'status').toLowerCase();
    if (status && !/^complete/.test(status)) continue;

    let paidIn = parseAmount(cell(r, 'paidIn')) || 0;
    let paidOut = parseAmount(cell(r, 'withdrawn')) || 0;
    if (!paidIn && !paidOut && m.amount != null) {
      const signed = parseAmount(cell(r, 'amount')) || 0;
      if (signed > 0) paidIn = signed;
      else paidOut = signed;
    }
    paidIn = Math.abs(paidIn);
    paidOut = Math.abs(paidOut);
    if (!date || (!paidIn && !paidOut)) {
      if (code || details) failed.push(r.join(','));
      last = null;
      continue;
    }
    const balance = parseAmount(cell(r, 'balance'));
    if (/charge/i.test(details) && paidOut && code) {
      charges.push({ code, amount: paidOut, balance });
      last = null;
      continue;
    }
    const direction = paidIn ? 'in' : 'out';
    const rec = { code, date, direction, amount: paidIn || paidOut, balance, details, reason: cell(r, 'reason'), otherParty: cell(r, 'otherParty'), acct: cell(r, 'acct') };
    records.push(rec);
    last = rec;
  }

  // Safaricom charges are separate rows sharing the receipt number of the
  // transaction they belong to, so fold them into its fee.
  const byCode = new Map();
  for (const rec of records) {
    const base = rec.code || `ROW-${rec.date}-${rec.amount}`;
    const id = byCode.has(base) ? `${base}-${byCode.size}` : base;
    byCode.set(id, {
      id,
      code: rec.code,
      date: rec.date,
      type: inferType(`${rec.reason || ''} ${rec.details}`.trim(), rec.direction),
      direction: rec.direction,
      amount: rec.amount,
      fee: 0,
      ...counterpartyFrom(rec.details, rec.otherParty),
      ...(rec.acct ? { account: rec.acct } : {}),
      balance: rec.balance,
      note: rec.details,
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
  if (!byCode.size && failed.length) {
    throw new Error(`Found the statement columns but could not read any rows. First problem row: "${failed[0].slice(0, 160)}"`);
  }
  return { transactions: [...byCode.values()], failed };
}

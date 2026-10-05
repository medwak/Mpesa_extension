// Parses M-Pesa confirmation SMS messages into transaction records.
// The parser is keyword-driven rather than template-exact, because Safaricom
// tweaks the wording (spacing, punctuation, promo tails) fairly often.

import { parseAmount } from './money.js';

const CODE_RE = /\b([A-Z0-9]{10})\s+[Cc]onfirmed/;
const SPLIT_RE = /(?=\b[A-Z0-9]{10}\s+[Cc]onfirmed)/;
const DATE_RE = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*at\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i;
const BALANCE_RE = /M-PESA\s+(?:account\s+)?balance\s+is(?:\s+now)?\s+Ksh\s?([\d,]+(?:\.\d{1,2})?)/i;
const COST_RE = /Transaction cost,?\s*Ksh\s?([\d,]+(?:\.\d{1,2})?)/i;
const AMT = 'Ksh\\s?([\\d,]+(?:\\.\\d{1,2})?)';

const PHONE_TAIL_RE = /\s+((?:\+?254|0)\d{9}|\d{3,4}\*{3,}\d{3})$/;

function clean(s) {
  return (s || '').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
}

function splitPhone(name) {
  const n = clean(name);
  const m = n.match(PHONE_TAIL_RE);
  if (!m) return { counterparty: n, phone: '' };
  return { counterparty: n.slice(0, m.index).trim(), phone: m[1] };
}

export function parseDate(text) {
  const m = text.match(DATE_RE);
  if (!m) return null;
  let [, d, mo, y, h, mi, ap] = m;
  let year = Number(y);
  if (year < 100) year += 2000;
  let hour = Number(h);
  if (ap) {
    ap = ap.toUpperCase();
    if (ap === 'PM' && hour < 12) hour += 12;
    if (ap === 'AM' && hour === 12) hour = 0;
  }
  const pad = (v) => String(v).padStart(2, '0');
  return `${year}-${pad(mo)}-${pad(d)}T${pad(hour)}:${pad(mi)}`;
}

// Each matcher returns partial transaction fields or null.
const MATCHERS = [
  {
    type: 'reversal',
    test: /has been reversed/i,
    parse(t) {
      const m = t.match(new RegExp(AMT));
      return { direction: 'in', amount: m ? parseAmount(m[1]) : 0, counterparty: 'Reversal' };
    },
  },
  {
    type: 'fuliza',
    test: /Fuliza M-PESA amount is/i,
    parse(t) {
      const m = t.match(new RegExp(`Fuliza M-PESA amount is\\s*${AMT}`, 'i'));
      const fee = t.match(new RegExp(`(?:Access Fee|Interest) charged\\s*${AMT}`, 'i'));
      return {
        direction: 'in',
        amount: m ? parseAmount(m[1]) : 0,
        fee: fee ? parseAmount(fee[1]) : 0,
        counterparty: 'Fuliza M-PESA',
      };
    },
  },
  {
    type: 'fuliza_repay',
    test: /to (?:fully |partially )?pay your outstanding Fuliza/i,
    parse(t) {
      const m = t.match(new RegExp(AMT));
      return { direction: 'out', amount: m ? parseAmount(m[1]) : 0, counterparty: 'Fuliza M-PESA' };
    },
  },
  {
    type: 'savings_out',
    test: /transferred to (M-Shwari|Lock Savings|Ziidi)/i,
    parse(t) {
      const m = t.match(new RegExp(`${AMT}\\s*transferred to ([\\w-]+(?: [\\w-]+)?)`, 'i'));
      return { direction: 'out', amount: m ? parseAmount(m[1]) : 0, counterparty: m ? m[2] : 'M-Shwari' };
    },
  },
  {
    type: 'savings_in',
    test: /transferred from (M-Shwari|Lock Savings|Ziidi)/i,
    parse(t) {
      const m = t.match(new RegExp(`${AMT}\\s*transferred from ([\\w-]+(?: [\\w-]+)?)`, 'i'));
      return { direction: 'in', amount: m ? parseAmount(m[1]) : 0, counterparty: m ? m[2] : 'M-Shwari' };
    },
  },
  {
    type: 'received',
    test: /You have received/i,
    parse(t) {
      const m = t.match(new RegExp(`You have received\\s*${AMT}\\s*from\\s+(.+?)\\s+on\\s+\\d`, 'i'));
      if (!m) return null;
      return { direction: 'in', amount: parseAmount(m[1]), ...splitPhone(m[2]) };
    },
  },
  {
    type: 'withdraw',
    test: /Withdraw\s*Ksh/i,
    parse(t) {
      const m = t.match(new RegExp(`Withdraw\\s*${AMT}\\s*from\\s+(.+?)\\s*New M-PESA`, 'i'));
      if (!m) return null;
      return { direction: 'out', amount: parseAmount(m[1]), counterparty: clean(m[2]) };
    },
  },
  {
    type: 'deposit',
    test: /Give\s*Ksh[\d,.\s]+cash to/i,
    parse(t) {
      const m = t.match(new RegExp(`Give\\s*${AMT}\\s*cash to\\s+(.+?)\\s*New M-PESA`, 'i'));
      if (!m) return null;
      return { direction: 'in', amount: parseAmount(m[1]), counterparty: clean(m[2]) };
    },
  },
  {
    type: 'airtime',
    test: /of airtime/i,
    parse(t) {
      const m = t.match(new RegExp(`bought\\s*${AMT}\\s*of airtime(?:\\s+for\\s+(\\d+))?`, 'i'));
      if (!m) return null;
      return { direction: 'out', amount: parseAmount(m[1]), counterparty: 'Safaricom Airtime', account: m[2] || '' };
    },
  },
  {
    type: 'paybill',
    test: /sent to .+? for account/i,
    parse(t) {
      const m = t.match(new RegExp(`${AMT}\\s*sent to\\s+(.+?)\\s+for account\\s+(.+?)\\s+on\\s+\\d`, 'i'));
      if (!m) return null;
      return { direction: 'out', amount: parseAmount(m[1]), counterparty: clean(m[2]), account: clean(m[3]) };
    },
  },
  {
    type: 'buygoods',
    test: /paid to/i,
    parse(t) {
      const m = t.match(new RegExp(`${AMT}\\s*paid to\\s+(.+?)\\s*\\.?\\s*on\\s+\\d`, 'i'));
      if (!m) return null;
      return { direction: 'out', amount: parseAmount(m[1]), counterparty: clean(m[2]) };
    },
  },
  {
    type: 'sent',
    test: /sent to/i,
    parse(t) {
      const m = t.match(new RegExp(`${AMT}\\s*sent to\\s+(.+?)\\s+on\\s+\\d`, 'i'));
      if (!m) return null;
      return { direction: 'out', amount: parseAmount(m[1]), ...splitPhone(m[2]) };
    },
  },
];

let fallbackCounter = 0;
function fallbackId(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `SMS-${(h >>> 0).toString(36).toUpperCase()}-${fallbackCounter++}`;
}

export function parseMessage(raw) {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const matcher = MATCHERS.find((m) => m.test.test(text));
  if (!matcher) return null;
  const fields = matcher.parse(text);
  if (!fields || !fields.amount) return null;

  const codeMatch = text.match(CODE_RE);
  const code = codeMatch ? codeMatch[1] : '';
  const bal = text.match(BALANCE_RE);
  const cost = text.match(COST_RE);
  const date = parseDate(text);

  return {
    // Fuliza notices reuse the receipt code of the payment they funded.
    id: code ? (matcher.type === 'fuliza' ? `${code}-FULIZA` : code) : fallbackId(text),
    code,
    date: date || new Date().toISOString().slice(0, 16),
    type: matcher.type,
    direction: fields.direction,
    amount: fields.amount,
    fee: fields.fee ?? (cost ? parseAmount(cost[1]) : 0),
    counterparty: fields.counterparty || '',
    phone: fields.phone || '',
    account: fields.account || '',
    balance: bal ? parseAmount(bal[1]) : null,
    raw: text,
    source: 'sms',
  };
}

// Accepts one or many messages pasted together (e.g. an exported SMS thread).
export function parseMessages(bulk) {
  const text = String(bulk || '');
  let chunks = text.split(SPLIT_RE);
  if (chunks.length <= 1) chunks = text.split(/\n\s*\n/);
  const results = [];
  const failed = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const tx = parseMessage(chunk);
    if (tx) results.push(tx);
    else failed.push(chunk.trim());
  }
  return { transactions: results, failed };
}

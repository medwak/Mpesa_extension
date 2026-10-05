// Reads Safaricom M-Pesa PDF statements, including password-protected ones.
// pdf.js extracts positioned text; we rebuild the "Detailed Statement" table
// into rows and hand them to the same importer the CSV upload uses.

import { importRows } from './csv.js';

export const STATEMENT_HEADER = ['Receipt No.', 'Completion Time', 'Details', 'Transaction Status', 'Paid In', 'Withdrawn', 'Balance'];

const NUM_RE = /^-?[\d,]+\.\d{2}$/;
const CODE_LINE_RE = /^([A-Z0-9]{10})\s+(\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)\s*(.*)$/;
const STATUS_RE = /\s*\b(Completed|Failed|Pending|Cancelled|Reversed)\s*$/i;
const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, '');

export class PdfPasswordError extends Error {
  constructor(wrong) {
    super(wrong ? 'That password is not correct.' : 'This statement is password protected.');
    this.name = 'PdfPasswordError';
    this.wrongPassword = wrong;
  }
}

// items: [{ str, x, y, w, page }] with y growing upwards (PDF space).
export function groupLines(items, tolerance = 3) {
  const sorted = items
    .filter((i) => i.str && i.str.trim())
    .sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const line = lines[lines.length - 1];
    if (line && line.page === it.page && Math.abs(line.y - it.y) <= tolerance) line.items.push(it);
    else lines.push({ page: it.page, y: it.y, items: [it] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

// pdf.js often returns neighbouring cells as one string ("TJ61ABCDEF 2026-09-02",
// "-2,000.00 50,000.00"). Split into words with x estimated from the offset.
function splitWords(items) {
  const out = [];
  for (const it of items) {
    const str = it.str;
    const len = str.length || 1;
    const w = it.w || len * 4.5;
    for (const m of str.matchAll(/\S+/g)) {
      out.push({ ...it, str: m[0], x: it.x + (w * m.index) / len, w: (w * m[0].length) / len });
    }
  }
  return out;
}

function lineText(items) {
  return items.map((i) => i.str.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function center(i) {
  return i.x + (i.w || 0) / 2;
}

// Header items may be split ("Paid" + "In"), so anchor on the first word.
function readAnchors(items) {
  const find = (word) => items.find((i) => norm(i.str).startsWith(word));
  const a = {};
  const map = { details: 'details', status: 'transaction', paidIn: 'paid', withdrawn: 'withdrawn', balance: 'balance' };
  for (const [k, w] of Object.entries(map)) {
    const it = find(w);
    if (it) a[k] = { x: it.x, c: center(it) };
  }
  return a;
}

function isHeader(text) {
  const t = norm(text);
  return t.includes('receipt') && t.includes('balance') && (t.includes('paidin') || t.includes('withdrawn'));
}

function assignAmounts(nums, anchors) {
  const out = { paidIn: '', withdrawn: '', balance: '' };
  const cols = ['paidIn', 'withdrawn', 'balance'].filter((k) => anchors[k]);
  if (cols.length === 3) {
    for (const n of nums) {
      const best = cols.reduce((b, k) => (Math.abs(center(n) - anchors[k].c) < Math.abs(center(n) - anchors[b].c) ? k : b), cols[0]);
      if (out[best]) return assignByOrder(nums);
      out[best] = n.str.trim();
    }
    return out;
  }
  return assignByOrder(nums);
}

function assignByOrder(nums) {
  const v = nums.map((n) => n.str.trim());
  if (v.length >= 3) return { paidIn: v[v.length - 3], withdrawn: v[v.length - 2], balance: v[v.length - 1] };
  if (v.length === 2) {
    return v[0].startsWith('-') ? { paidIn: '', withdrawn: v[0], balance: v[1] } : { paidIn: v[0], withdrawn: '', balance: v[1] };
  }
  return { paidIn: '', withdrawn: '', balance: v[0] || '' };
}

// Converts positioned text lines into statement rows (header + data).
export function linesToRows(lines) {
  const rows = [STATEMENT_HEADER];
  let anchors = null;
  let last = null;
  const cols = {};
  for (const raw of lines) {
    const line = { ...raw, items: splitWords(raw.items) };
    const text = lineText(line.items);
    if (isHeader(text)) {
      anchors = readAnchors(line.items);
      last = null;
      continue;
    }
    if (!anchors) continue; // Still in the summary part before the detailed table.
    if (/^page\s+\d+/i.test(text)) {
      last = null;
      continue;
    }

    const nums = line.items.filter((i) => NUM_RE.test(i.str.trim()));
    const words = line.items.filter((i) => !NUM_RE.test(i.str.trim()));
    const wordText = lineText(words);
    const m = wordText.match(CODE_LINE_RE);
    if (m) {
      // Learn where the Details and Status columns really start from the row
      // itself; headings are often centred, so their x is not the column edge.
      const dateTokens = m[2].split(/\s+/).length;
      const detailsTok = words[1 + dateTokens];
      const statusTok = words.find((w) => /^(Completed|Failed|Pending|Cancelled|Reversed)$/i.test(w.str));
      if (detailsTok && (!statusTok || detailsTok.x < statusTok.x)) cols.details = Math.min(cols.details ?? Infinity, detailsTok.x);
      if (statusTok) cols.status = statusTok.x;
      const statusMatch = m[3].match(STATUS_RE);
      const details = m[3].replace(STATUS_RE, '').trim();
      const amt = assignAmounts(nums, anchors);
      last = [m[1], m[2], details, statusMatch ? statusMatch[1] : 'Completed', amt.paidIn, amt.withdrawn, amt.balance];
      rows.push(last);
      continue;
    }

    // Wrapped cells: the rest of the time or of the Details text, told apart
    // by which column they sit in.
    if (last && !nums.length && words.length) {
      const detailsX = cols.details ?? anchors.details?.x;
      const statusX = cols.status ?? anchors.status?.x;
      const inDetails = (i) => (detailsX == null || i.x >= detailsX - 4) && (statusX == null || i.x < statusX - 4);
      const before = words.filter((i) => detailsX != null && i.x < detailsX - 4);
      const t = lineText(before).match(/^(\d{1,2}:\d{2}(?::\d{2})?)$/);
      if (t && !/\d:\d/.test(last[1])) last[1] = `${last[1]} ${t[1]}`;
      const rest = lineText(words.filter(inDetails)).replace(STATUS_RE, '');
      if (rest) last[2] = `${last[2]} ${rest}`.trim();
      continue;
    }
    last = null;
  }
  return rows;
}

let pdfjsPromise;
function loadPdfJs() {
  pdfjsPromise ||= import('../../vendor/pdfjs/pdf.min.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
    return lib;
  });
  return pdfjsPromise;
}

export async function extractPdfItems(data, password) {
  const pdfjs = await loadPdfJs();
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(data),
      password: password || undefined,
      isEvalSupported: false,
      disableFontFace: true,
    }).promise;
  } catch (err) {
    if (err?.name === 'PasswordException') throw new PdfPasswordError(Boolean(password) && err.code === 2);
    throw new Error(`Could not open the PDF: ${err?.message || err}`);
  }
  const items = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const it of content.items) {
      if (!('str' in it)) continue;
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, page: p });
    }
  }
  await doc.destroy();
  return items;
}

export async function importPdf(data, password) {
  const items = await extractPdfItems(data, password);
  if (!items.length) throw new Error('No text found in this PDF. It may be a scanned image; use the M-Pesa statement Safaricom emailed you.');
  const rows = linesToRows(groupLines(items));
  if (rows.length <= 1) {
    throw new Error('This PDF does not look like an M-Pesa statement: no "Receipt No. … Balance" transaction table was found.');
  }
  return importRows(rows);
}

export function isPdf(buffer) {
  const b = new Uint8Array(buffer.slice(0, 5));
  return String.fromCharCode(...b) === '%PDF-';
}

import { loadState, saveState, addTransactions, recategorizeAll, defaultState } from '../lib/store.js';
import { parseMessages } from '../lib/parser.js';
import { importCsv, transactionsToCsv, statementToCsv } from '../lib/csv.js';
import { importPdf, isPdf, PdfPasswordError } from '../lib/pdf.js';
import { summarize, monthlyTrend, topCounterparties, buildStatement, filterRange, monthBounds, describe, sortByDate, TYPE_LABELS } from '../lib/ledger.js';
import { evaluateBudget, suggestPlan, emptyPlan } from '../lib/budget.js';
import { formatKsh, parseAmount, toPlain } from '../lib/money.js';
import { demoTransactions } from '../lib/demo.js';

let state = defaultState();
let lastStatement = null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => today().slice(0, 7);

function fmtDate(iso) {
  const d = new Date(`${iso}:00`);
  return d.toLocaleString('en-KE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtMonth(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-KE', { month: 'long', year: 'numeric' });
}
function shortMonth(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-KE', { month: 'short' });
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

async function persist() {
  await saveState(state);
}

function monthsWithData() {
  const set = new Set(state.transactions.map((t) => t.date.slice(0, 7)));
  set.add(thisMonth());
  return [...set].sort().reverse();
}

function categoryOptions(selected, { includeAll = false } = {}) {
  const groups = { income: [], expense: [], transfer: [] };
  for (const c of state.categories) groups[c.kind]?.push(c.name);
  const label = { income: 'Income', expense: 'Expenses', transfer: 'Transfers' };
  return (includeAll ? '<option value="">All categories</option>' : '') +
    Object.entries(groups)
      .map(([k, names]) => `<optgroup label="${label[k]}">${names.map((n) => `<option ${n === selected ? 'selected' : ''}>${esc(n)}</option>`).join('')}</optgroup>`)
      .join('');
}

function alertHtml(alerts) {
  const icon = { danger: '!', warning: '!', info: 'i', success: '✓' };
  const word = { danger: 'Over budget', warning: 'Warning', info: 'Note', success: 'Done' };
  return alerts.map((a) => `<div class="alert ${a.level}"><span class="icon" aria-hidden="true">${icon[a.level]}</span><span><strong>${a.title || word[a.level]}:</strong> ${esc(a.text)}</span></div>`).join('');
}

/* ---------------- Tabs ---------------- */

function showTab(name) {
  for (const b of $$('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of $$('.tab-panel')) p.hidden = p.id !== `tab-${name}`;
  try { sessionStorage.setItem('tab', name); } catch {}
  render(name);
}

function render(name = currentTab()) {
  ({ overview: renderOverview, transactions: renderTransactions, import: () => {}, statement: renderStatementControls, budget: renderBudget, settings: renderSettings })[name]?.();
}
function currentTab() {
  return $('.tabs button[aria-selected="true"]')?.dataset.tab || 'overview';
}

/* ---------------- Overview ---------------- */

function renderOverview() {
  const sel = $('#ov-month');
  const months = monthsWithData();
  const chosen = sel.value && months.includes(sel.value) ? sel.value : months[0];
  sel.innerHTML = months.map((m) => `<option value="${m}" ${m === chosen ? 'selected' : ''}>${fmtMonth(m)}</option>`).join('');

  const empty = state.transactions.length === 0;
  $('#ov-empty').hidden = !empty;
  for (const el of [$('#ov-tiles'), $('#ov-alerts'), ...$$('#tab-overview .grid-2')]) el.hidden = empty;
  if (empty) return;

  const { from, to } = monthBounds(chosen);
  const monthTxs = filterRange(state.transactions, from, to);
  const s = summarize(monthTxs, state.categories);
  const latest = sortByDate(state.transactions).reverse().find((t) => t.balance != null);

  $('#ov-tiles').innerHTML = [
    ['Income', formatKsh(s.income), `${monthTxs.filter((t) => t.direction === 'in').length} payments in`],
    ['Expenses', formatKsh(s.expenses), `${monthTxs.filter((t) => t.direction === 'out').length} payments out`],
    ['Net (income − expenses)', formatKsh(s.net, { sign: true }), s.income ? `${Math.round(s.savingsRate * 100)}% of income kept` : ''],
    ['Transaction costs', formatKsh(s.fees), s.expenses ? `${((s.fees / s.expenses) * 100).toFixed(1)}% of spending` : ''],
    ['M-Pesa balance', latest ? formatKsh(latest.balance) : '—', latest ? `as of ${fmtDate(latest.date)}` : 'no balance seen yet'],
  ].map(([l, v, n]) => `<div class="tile"><div class="label">${l}</div><div class="value">${v}</div><div class="note">${esc(n)}</div></div>`).join('');

  const plan = state.budgets[chosen];
  $('#ov-alerts').innerHTML = plan ? alertHtml(evaluateBudget(plan, state.transactions, { categories: state.categories, today: today() }).alerts.slice(0, 4)) : '';

  // Trend for the 6 months ending at the chosen month.
  const trend = monthlyTrend(state.transactions, state.categories).filter((r) => r.month <= chosen).slice(-6);
  $('#ov-trend').innerHTML = trendChart(trend);

  const spend = s.categories.filter((c) => c.kind === 'expense' && c.total > 0);
  $('#ov-cat-sub').textContent = `${fmtMonth(chosen)} · ${formatKsh(s.expenses)} total`;
  $('#ov-cats').innerHTML = barList(spend.map((c) => ({ name: c.name, value: c.total })), s.expenses);
  const payees = topCounterparties(monthTxs, 'out', 6);
  $('#ov-payees').innerHTML = barList(payees.map((p) => ({ name: p.name, value: p.total, note: `${p.count}×` })));
  const payers = topCounterparties(monthTxs, 'in', 6);
  $('#ov-payers').innerHTML = barList(payers.map((p) => ({ name: p.name, value: p.total, note: `${p.count}×` })), null, 'var(--series-in)');
}

function barList(items, total, color) {
  if (!items.length) return '<p class="sub">Nothing to show for this period.</p>';
  const max = Math.max(...items.map((i) => i.value));
  return `<div class="barlist">${items.map((i) => {
    const share = total ? ` · ${Math.round((i.value / total) * 100)}%` : i.note ? ` · ${i.note}` : '';
    return `<div class="item" title="${esc(i.name)}: ${formatKsh(i.value)}">
      <span class="name">${esc(i.name)}</span>
      <span class="track"><span class="fill" style="width:${(i.value / max) * 100}%;${color ? `background:${color}` : ''}"></span></span>
      <span class="num">${formatKsh(i.value)}<span class="sub">${share}</span></span></div>`;
  }).join('')}</div>`;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

function trendChart(rows) {
  if (!rows.length) return '<p class="sub">No data yet.</p>';
  const W = 520, H = 220, L = 56, B = 24, T = 8;
  const max = niceMax(Math.max(...rows.map((r) => Math.max(r.income, r.expenses))));
  const plotH = H - B - T;
  const groupW = (W - L) / rows.length;
  const barW = Math.min(28, (groupW - 16) / 2);
  const y = (v) => T + plotH - (v / max) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const bar = (x, v, cls) => {
    const h = Math.max(0, (v / max) * plotH);
    if (h < 1) return '';
    const r = Math.min(4, h, barW / 2);
    const top = T + plotH - h;
    // Rounded data-end, square at the baseline.
    return `<path class="${cls}" d="M${x},${T + plotH} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${T + plotH} Z"/>`;
  };
  const kfmt = (c) => { const k = c / 100; return k >= 1000 ? `${(k / 1000).toFixed(k >= 10000 ? 0 : 1)}k` : `${k}`; };

  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly income and expenses">
    ${ticks.map((t) => `<line class="grid" x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${kfmt(t)}</text>`).join('')}
    ${rows.map((r, i) => {
      const cx = L + groupW * i + groupW / 2;
      return `${bar(cx - barW - 1, r.income, 'bar-in')}${bar(cx + 1, r.expenses, 'bar-out')}
        <text x="${cx}" y="${H - 6}" text-anchor="middle">${shortMonth(r.month)}</text>
        <rect class="hit" x="${L + groupW * i}" y="${T}" width="${groupW}" height="${plotH}" data-i="${i}"/>`;
    }).join('')}
    <line class="baseline" x1="${L}" x2="${W}" y1="${T + plotH}" y2="${T + plotH}"/>
  </svg>`;
  const legend = `<div class="legend"><span><span class="sw" style="background:var(--series-in)"></span>Income</span><span><span class="sw" style="background:var(--series-out)"></span>Expenses</span></div>`;
  const table = `<details><summary class="sub">Show as table</summary><table class="data compact"><thead><tr><th>Month</th><th class="num">Income</th><th class="num">Expenses</th><th class="num">Net</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${fmtMonth(r.month)}</td><td class="num">${formatKsh(r.income)}</td><td class="num">${formatKsh(r.expenses)}</td><td class="num">${formatKsh(r.net, { sign: true })}</td></tr>`).join('')}</tbody></table></details>`;
  trendChart.rows = rows;
  return legend + svg + table;
}

function bindTooltip() {
  const tip = $('#tooltip');
  document.addEventListener('mousemove', (e) => {
    const hit = e.target.closest?.('#ov-trend .hit');
    if (!hit) { tip.hidden = true; return; }
    const r = trendChart.rows[Number(hit.dataset.i)];
    tip.innerHTML = `<div class="t">${fmtMonth(r.month)}</div>
      <div class="r"><span><span style="display:inline-block;width:8px;height:8px;background:var(--series-in);border-radius:2px"></span> Income</span><span class="num">${formatKsh(r.income)}</span></div>
      <div class="r"><span><span style="display:inline-block;width:8px;height:8px;background:var(--series-out);border-radius:2px"></span> Expenses</span><span class="num">${formatKsh(r.expenses)}</span></div>
      <div class="r"><span>Net</span><span class="num">${formatKsh(r.net, { sign: true })}</span></div>`;
    tip.hidden = false;
    const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${x}px`;
    tip.style.top = `${e.clientY + 14}px`;
  });
}

/* ---------------- Transactions ---------------- */

function renderTransactions() {
  const mSel = $('#tx-month');
  const prevMonth = mSel.value;
  mSel.innerHTML = `<option value="">All months</option>` + monthsWithData().map((m) => `<option value="${m}" ${m === prevMonth ? 'selected' : ''}>${fmtMonth(m)}</option>`).join('');
  const cSel = $('#tx-category');
  const prevCat = cSel.value;
  cSel.innerHTML = categoryOptions(prevCat, { includeAll: true });
  if (!prevCat) cSel.value = '';
  $('#manual-form [name=category]').innerHTML = categoryOptions('Uncategorized');

  const q = $('#tx-search').value.trim().toLowerCase();
  const dir = $('#tx-direction').value;
  let list = [...state.transactions].reverse();
  if (mSel.value) list = list.filter((t) => t.date.startsWith(mSel.value));
  if (cSel.value) list = list.filter((t) => t.category === cSel.value);
  if (dir) list = list.filter((t) => t.direction === dir);
  if (q) list = list.filter((t) => [t.code, t.counterparty, t.account, t.phone, t.note, t.category].join(' ').toLowerCase().includes(q));

  const totalIn = list.filter((t) => t.direction === 'in').reduce((s, t) => s + t.amount, 0);
  const totalOut = list.filter((t) => t.direction === 'out').reduce((s, t) => s + t.amount + (t.fee || 0), 0);
  $('#tx-count').textContent = `${list.length} transactions · in ${formatKsh(totalIn)} · out ${formatKsh(totalOut)} (incl. costs)`;

  const shown = list.slice(0, 500);
  $('#tx-body').innerHTML = shown.map((t) => `<tr data-id="${esc(t.id)}">
      <td class="num">${fmtDate(t.date)}</td>
      <td><code>${esc(t.code || '—')}</code></td>
      <td class="details-cell"><div class="who">${esc(t.counterparty || TYPE_LABELS[t.type])}</div><div class="meta">${esc(TYPE_LABELS[t.type] || t.type)}${t.account ? ` · Acc ${esc(t.account)}` : ''}${t.phone ? ` · ${esc(t.phone)}` : ''}${t.note && t.source !== 'statement' ? ` · ${esc(t.note)}` : ''}</div></td>
      <td><select class="cat-select" aria-label="Category">${categoryOptions(t.category)}</select></td>
      <td class="num ${t.direction === 'in' ? 'in' : ''}">${t.direction === 'in' ? '+' : '−'}${formatKsh(t.amount).replace('Ksh ', '')}</td>
      <td class="num">${t.fee ? formatKsh(t.fee).replace('Ksh ', '') : ''}</td>
      <td class="num">${t.balance != null ? formatKsh(t.balance).replace('Ksh ', '') : ''}</td>
      <td><button class="icon-btn delete-tx" title="Delete transaction" aria-label="Delete">✕</button></td>
    </tr>`).join('') + (list.length > shown.length ? `<tr><td colspan="8" class="sub">Showing the latest 500. Use the filters to narrow down.</td></tr>` : '');
}

function bindTransactions() {
  for (const id of ['#tx-search', '#tx-month', '#tx-category', '#tx-direction']) $(id).addEventListener('input', renderTransactions);

  $('#tx-body').addEventListener('change', async (e) => {
    if (!e.target.classList.contains('cat-select')) return;
    const id = e.target.closest('tr').dataset.id;
    const tx = state.transactions.find((t) => t.id === id);
    tx.category = e.target.value;
    tx.manualCategory = true;
    if (tx.counterparty && !['Fuliza M-PESA', 'Safaricom Airtime'].includes(tx.counterparty)) {
      const same = state.transactions.filter((t) => t.counterparty === tx.counterparty && t.id !== tx.id && t.category !== tx.category && t.direction === tx.direction);
      if (confirm(`Always put "${tx.counterparty}" in "${tx.category}"?\n\nThis adds a rule and updates ${same.length} other transaction(s) from them.`)) {
        state.rules.unshift({ pattern: tx.counterparty, category: tx.category });
        for (const t of same) { t.category = tx.category; t.manualCategory = false; }
        recategorizeAll(state);
      }
    }
    await persist();
    renderTransactions();
  });

  $('#tx-body').addEventListener('click', async (e) => {
    if (!e.target.classList.contains('delete-tx')) return;
    const id = e.target.closest('tr').dataset.id;
    if (!confirm('Delete this transaction?')) return;
    state.transactions = state.transactions.filter((t) => t.id !== id);
    await persist();
    renderTransactions();
  });

  $('#manual-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const tx = {
      id: `MAN-${Date.now().toString(36).toUpperCase()}`,
      code: '',
      date: f.get('date'),
      type: 'manual',
      direction: f.get('direction'),
      amount: parseAmount(f.get('amount')),
      fee: parseAmount(f.get('fee')) || 0,
      counterparty: f.get('counterparty').trim(),
      phone: '',
      account: '',
      balance: null,
      category: f.get('category'),
      manualCategory: true,
      note: f.get('note').trim(),
      source: 'manual',
    };
    addTransactions(state, [tx]);
    await persist();
    e.target.reset();
    toast('Transaction added');
    renderTransactions();
  });
}

/* ---------------- Import ---------------- */

function importResult(el, { added, duplicates }, failed) {
  const parts = [`<div class="alert success"><span class="icon">✓</span><span>Imported <strong>${added}</strong> new transaction(s)${duplicates ? `, skipped ${duplicates} already imported` : ''}.</span></div>`];
  if (failed.length) {
    parts.push(`<div class="alert warning"><span class="icon">!</span><span>${failed.length} item(s) were not recognised as M-Pesa transactions.
      <details><summary>Show</summary><pre style="white-space:pre-wrap;font-size:11px">${esc(failed.slice(0, 20).join('\n\n'))}</pre></details></span></div>`);
  }
  el.innerHTML = parts.join('');
}

function bindImport() {
  $('#sms-import').addEventListener('click', async () => {
    const { transactions, failed } = parseMessages($('#sms-input').value);
    if (!transactions.length) {
      $('#sms-result').innerHTML = alertHtml([{ level: 'warning', text: 'No M-Pesa transactions found in the pasted text.' }]);
      return;
    }
    const stats = addTransactions(state, transactions);
    await persist();
    importResult($('#sms-result'), stats, failed);
    $('#sms-input').value = '';
  });
  $('#sms-paste').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) return toast('The clipboard is empty');
      const box = $('#sms-input');
      box.value = box.value.trim() ? `${box.value.trim()}\n\n${text}` : text;
    } catch {
      toast('Clipboard access was blocked. Long-press the box and choose Paste instead.');
    }
  });
  $('#sms-clear').addEventListener('click', () => { $('#sms-input').value = ''; $('#sms-result').innerHTML = ''; });

  let pendingPdf = null;
  const showUnlock = (show) => {
    $('#pdf-unlock').hidden = !show;
    $('#pdf-hint').hidden = !show;
    if (show) $('#pdf-password').focus();
  };

  async function runImport(task) {
    const out = $('#csv-result');
    out.innerHTML = '<p class="sub">Reading statement…</p>';
    try {
      const { transactions, failed } = await task();
      if (!transactions.length) throw new Error('No transactions were found in this file.');
      const stats = addTransactions(state, transactions);
      await persist();
      importResult(out, stats, failed);
      pendingPdf = null;
      showUnlock(false);
    } catch (err) {
      if (err instanceof PdfPasswordError) {
        showUnlock(true);
        out.innerHTML = err.wrongPassword ? alertHtml([{ level: 'danger', title: 'Wrong password', text: 'Check the code in the Safaricom SMS and try again.' }]) : '';
        return;
      }
      pendingPdf = null;
      showUnlock(false);
      out.innerHTML = alertHtml([{ level: 'danger', title: 'Import failed', text: err.message }]);
    }
  }

  $('#csv-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const buffer = await file.arrayBuffer();
    if (isPdf(buffer)) {
      pendingPdf = buffer;
      $('#pdf-password').value = '';
      await runImport(() => importPdf(buffer.slice(0)));
    } else {
      pendingPdf = null;
      showUnlock(false);
      await runImport(async () => importCsv(new TextDecoder().decode(buffer)));
    }
  });

  $('#pdf-unlock').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!pendingPdf) return;
    await runImport(() => importPdf(pendingPdf.slice(0), $('#pdf-password').value));
  });
}

/* ---------------- Statement ---------------- */

function renderStatementControls() {
  if (!$('#st-from').value && !$('#st-to').value) applyPreset('this-month');
  generateStatement();
}

function applyPreset(p) {
  const now = new Date();
  const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const shift = (n) => new Date(now.getFullYear(), now.getMonth() + n, 1);
  let from, to = today();
  if (p === 'this-month') from = `${ym(now)}-01`;
  if (p === 'last-month') ({ from, to } = monthBounds(ym(shift(-1))));
  if (p === '3-months') from = `${ym(shift(-2))}-01`;
  if (p === '6-months') from = `${ym(shift(-5))}-01`;
  if (p === 'year') from = `${now.getFullYear()}-01-01`;
  if (p === 'all') {
    from = state.transactions[0]?.date.slice(0, 10) || today();
    to = state.transactions.at(-1)?.date.slice(0, 10) || today();
  }
  $('#st-from').value = from;
  $('#st-to').value = to;
}

function generateStatement() {
  const from = $('#st-from').value;
  const to = $('#st-to').value;
  const openingInput = $('#st-opening').value;
  const st = buildStatement(state.transactions, { from, to, openingBalance: openingInput === '' ? undefined : parseAmount(openingInput) });
  lastStatement = st;
  const periodTxs = filterRange(state.transactions, from, to);
  const pl = summarize(periodTxs, state.categories);

  const gapNote = st.gaps.length
    ? alertHtml([{ level: 'warning', text: `${st.gaps.length} place(s) where the balance in the message does not match the running total. A transaction is probably missing before: ${st.gaps.slice(0, 5).map((g) => `${fmtDate(g.date)} (${formatKsh(g.diff, { sign: true })})`).join(', ')}${st.gaps.length > 5 ? '…' : ''}. Import the missing messages or a full statement to reconcile.` }])
    : st.rows.length ? alertHtml([{ level: 'success', text: 'All balances reconcile with your M-Pesa messages.' }]) : '';

  $('#st-output').innerHTML = `<div class="no-print">${gapNote}</div>
  <article class="statement">
    <header>
      <div><div class="title">M-PESA Statement</div><div class="period">${from ? fmtDay(from) : 'Start'} – ${to ? fmtDay(to) : 'Today'}</div></div>
      <div class="sub" style="text-align:right">Generated ${new Date().toLocaleString('en-KE')}<br>${st.rows.length} transactions</div>
    </header>
    <div class="totals">
      <div><span>Opening balance</span><strong>${formatKsh(st.openingBalance)}</strong></div>
      <div><span>Total paid in</span><strong>${formatKsh(st.totalIn)}</strong></div>
      <div><span>Total paid out (incl. costs)</span><strong>${formatKsh(st.totalOut)}</strong></div>
      <div><span>Closing balance</span><strong>${formatKsh(st.closingBalance)}</strong></div>
    </div>
    <h3>Summary by transaction type</h3>
    <table class="data compact"><thead><tr><th>Transaction type</th><th class="num">Paid in</th><th class="num">Paid out</th></tr></thead><tbody>
      ${st.summary.map((r) => `<tr><td>${esc(r.type)}</td><td class="num">${toPlain(r.paidIn)}</td><td class="num">${toPlain(r.paidOut)}</td></tr>`).join('')}
      <tr><th>Total</th><th class="num">${toPlain(st.totalIn)}</th><th class="num">${toPlain(st.totalOut)}</th></tr>
    </tbody></table>
    <h3>Income &amp; expenditure</h3>
    <table class="data compact"><thead><tr><th>Category</th><th>Kind</th><th class="num">Amount</th></tr></thead><tbody>
      ${pl.categories.filter((c) => c.kind !== 'transfer' && c.total !== 0).map((c) => `<tr><td>${esc(c.name)}</td><td class="kind">${c.kind}</td><td class="num">${toPlain(c.total)}</td></tr>`).join('')}
      <tr><th>Total income</th><td></td><th class="num">${toPlain(pl.income)}</th></tr>
      <tr><th>Total expenses</th><td></td><th class="num">${toPlain(pl.expenses)}</th></tr>
      <tr><th>Net</th><td></td><th class="num">${toPlain(pl.net)}</th></tr>
    </tbody></table>
    <h3>Detailed statement</h3>
    <div class="table-wrap" style="border:none"><table class="data compact"><thead><tr><th>Receipt No.</th><th>Completion time</th><th>Details</th><th>Category</th><th class="num">Paid in</th><th class="num">Withdrawn</th><th class="num">Cost</th><th class="num">Balance</th></tr></thead><tbody>
      ${st.rows.map((r) => `<tr><td><code>${esc(r.code || '—')}</code></td><td class="num">${esc(r.date.replace('T', ' '))}</td><td>${esc(r.details)}</td><td>${esc(r.category)}</td><td class="num">${r.paidIn ? toPlain(r.paidIn) : ''}</td><td class="num">${r.withdrawn ? toPlain(r.withdrawn) : ''}</td><td class="num">${r.fee ? toPlain(r.fee) : ''}</td><td class="num">${toPlain(r.balance)}</td></tr>`).join('') || '<tr><td colspan="8" class="sub">No transactions in this period.</td></tr>'}
    </tbody></table></div>
    <p class="disclaimer">Compiled by M-Pesa Ledger from your M-Pesa messages and statements. This is a personal record, not an official Safaricom statement.</p>
  </article>`;
}

function fmtDay(d) {
  return new Date(`${d}T00:00`).toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' });
}

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function bindStatement() {
  $('#st-generate').addEventListener('click', generateStatement);
  for (const b of $$('[data-preset]')) b.addEventListener('click', () => { applyPreset(b.dataset.preset); generateStatement(); });
  $('#st-print').addEventListener('click', () => { generateStatement(); window.print(); });
  $('#st-csv').addEventListener('click', () => {
    generateStatement();
    download(`mpesa-statement_${$('#st-from').value}_${$('#st-to').value}.csv`, statementToCsv(lastStatement), 'text/csv');
  });
}

/* ---------------- Budget ---------------- */

function currentPlanMonth() {
  const el = $('#bg-month');
  if (!el.value) el.value = thisMonth();
  return el.value;
}

function prevMonthKey(key) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

function renderBudget() {
  const month = currentPlanMonth();
  const plan = state.budgets[month] || emptyPlan(month);
  const form = $('#bg-form');
  form.expectedIncome.value = plan.expectedIncome ? plan.expectedIncome / 100 : '';
  form.savingsGoal.value = plan.savingsGoal ? plan.savingsGoal / 100 : '';
  const expenseCats = state.categories.filter((c) => c.kind === 'expense');
  $('#bg-limits').innerHTML = expenseCats.map((c) => `<tr><td>${esc(c.name)}</td><td class="num"><input type="number" min="0" step="1" data-cat="${esc(c.name)}" value="${plan.limits[c.name] ? plan.limits[c.name] / 100 : ''}" placeholder="—" aria-label="${esc(c.name)} limit"></td></tr>`).join('');

  const ev = evaluateBudget(plan, state.transactions, { categories: state.categories, today: today() });
  $('#bg-tiles').innerHTML = [
    ['Budgeted spending', formatKsh(ev.totalLimit), plan.expectedIncome ? `of ${formatKsh(ev.expectedIncome)} expected income` : 'set expected income below'],
    ['Spent so far', formatKsh(ev.totalSpent), ev.totalLimit ? `${Math.round((ev.totalSpent / ev.totalLimit) * 100)}% of budget` : ''],
    ['Left to spend', formatKsh(ev.totalRemaining), ev.days.remaining ? `${formatKsh(Math.max(0, Math.floor(ev.totalRemaining / ev.days.remaining)))} per day for ${ev.days.remaining} days` : 'month ended'],
    ['Income received', formatKsh(ev.actualIncome), plan.expectedIncome ? `${Math.round((ev.actualIncome / plan.expectedIncome) * 100)}% of expected` : ''],
    ['Projected savings', formatKsh(ev.projectedSavings, { sign: true }), plan.savingsGoal ? `goal ${formatKsh(plan.savingsGoal)}` : 'income received − spent'],
  ].map(([l, v, n]) => `<div class="tile"><div class="label">${l}</div><div class="value">${v}</div><div class="note">${esc(n)}</div></div>`).join('');
  $('#bg-alerts').innerHTML = alertHtml(ev.alerts);
  $('#bg-days').textContent = `${fmtMonth(month)} · day ${ev.days.elapsed} of ${ev.days.totalDays}`;

  const statusText = { ok: 'On track', fast: 'Spending fast', warning: 'Almost used up', over: 'Over budget', unplanned: 'No budget set' };
  const lines = ev.lines.filter((l) => l.limit || l.spent);
  $('#bg-progress').innerHTML = lines.length ? lines.map((l) => {
    const pct = l.limit ? Math.min(100, (l.spent / l.limit) * 100) : 100;
    return `<div class="progress-item ${l.status}">
      <div class="head"><strong>${esc(l.name)}</strong><span class="status">${statusText[l.status]}</span></div>
      <div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="${esc(l.name)}"><span style="width:${pct}%"></span></div>
      <div class="foot">${formatKsh(l.spent)} spent${l.limit ? ` of ${formatKsh(l.limit)} · ${l.remaining >= 0 ? `${formatKsh(l.remaining)} left${l.dailyAllowance ? ` (${formatKsh(l.dailyAllowance)}/day)` : ''}` : `${formatKsh(-l.remaining)} over`}` : ''}</div>
    </div>`;
  }).join('') : '<p class="sub">Set limits on the left to start tracking this month.</p>';
}

function bindBudget() {
  $('#bg-month').addEventListener('change', renderBudget);
  $('#bg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const month = currentPlanMonth();
    const form = e.target;
    const limits = {};
    for (const input of $$('#bg-limits input')) {
      const v = parseAmount(input.value);
      if (v) limits[input.dataset.cat] = v;
    }
    state.budgets[month] = {
      month,
      expectedIncome: parseAmount(form.expectedIncome.value) || 0,
      savingsGoal: parseAmount(form.savingsGoal.value) || 0,
      limits,
    };
    await persist();
    $('#bg-saved').textContent = 'Saved';
    setTimeout(() => ($('#bg-saved').textContent = ''), 2000);
    renderBudget();
  });
  $('#bg-suggest').addEventListener('click', async () => {
    const month = currentPlanMonth();
    const prev = prevMonthKey(month);
    const { from, to } = monthBounds(prev);
    const prevTxs = filterRange(state.transactions, from, to);
    if (!state.budgets[prev] && !prevTxs.length) {
      toast('No budget or spending found for last month');
      return;
    }
    if (state.budgets[month] && !confirm('Replace this month\'s budget with one based on last month?')) return;
    state.budgets[month] = suggestPlan(month, { previousPlan: state.budgets[prev], previousSummary: summarize(prevTxs, state.categories) });
    await persist();
    toast(state.budgets[prev] ? 'Copied last month\'s budget' : 'Built a budget from last month\'s spending');
    renderBudget();
  });
}

/* ---------------- Settings ---------------- */

function renderSettings() {
  $('#rule-form [name=category]').innerHTML = categoryOptions();
  $('#rules-body').innerHTML = state.rules.map((r, i) => `<tr><td><code>${esc(r.pattern)}</code></td><td>→ ${esc(r.category)}</td><td><button class="icon-btn" data-del-rule="${i}" aria-label="Delete rule">✕</button></td></tr>`).join('');
  const used = new Set(state.transactions.map((t) => t.category));
  $('#cats-body').innerHTML = state.categories.map((c, i) => `<tr><td>${esc(c.name)}</td><td class="kind">${c.kind}</td><td>${used.has(c.name) || c.name === 'Uncategorized' || c.name === 'Transaction costs' ? '' : `<button class="icon-btn" data-del-cat="${i}" aria-label="Delete category">✕</button>`}</td></tr>`).join('');
}

function bindSettings() {
  $('#rule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    state.rules.unshift({ pattern: f.get('pattern').trim(), category: f.get('category') });
    await persist();
    e.target.reset();
    renderSettings();
  });
  $('#rules-body').addEventListener('click', async (e) => {
    const i = e.target.dataset.delRule;
    if (i == null) return;
    state.rules.splice(Number(i), 1);
    await persist();
    renderSettings();
  });
  $('#rules-apply').addEventListener('click', async () => {
    recategorizeAll(state);
    await persist();
    toast('Rules re-applied');
  });
  $('#cat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const name = f.get('name').trim();
    if (state.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) return toast('That category already exists');
    state.categories.push({ name, kind: f.get('kind') });
    await persist();
    e.target.reset();
    renderSettings();
  });
  $('#cats-body').addEventListener('click', async (e) => {
    const i = e.target.dataset.delCat;
    if (i == null) return;
    const name = state.categories[Number(i)].name;
    state.categories.splice(Number(i), 1);
    state.rules = state.rules.filter((r) => r.category !== name);
    for (const plan of Object.values(state.budgets)) delete plan.limits[name];
    await persist();
    renderSettings();
  });

  $('#backup-export').addEventListener('click', () => download(`mpesa-ledger-backup-${today()}.json`, JSON.stringify(state, null, 2), 'application/json'));
  $('#tx-export').addEventListener('click', () => download(`mpesa-transactions-${today()}.csv`, transactionsToCsv(state.transactions), 'text/csv'));
  $('#backup-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.transactions)) throw new Error('Not an M-Pesa Ledger backup');
      if (!confirm(`Replace current data with the backup (${data.transactions.length} transactions)?`)) return;
      state = { ...defaultState(), ...data };
      await persist();
      toast('Backup restored');
      renderSettings();
    } catch (err) {
      toast(`Could not restore: ${err.message}`);
    }
    e.target.value = '';
  });
  $('#load-demo').addEventListener('click', async () => {
    if (state.transactions.length && !confirm('Add demo transactions to your existing data? (Delete all data first if you want to keep them apart.)')) return;
    const stats = addTransactions(state, demoTransactions());
    const month = thisMonth();
    if (!state.budgets[month]) {
      state.budgets[month] = {
        month, expectedIncome: 9500000, savingsGoal: 1000000,
        limits: { 'Rent & housing': 2500000, Groceries: 2000000, 'Transport & fuel': 600000, 'Food & drinks': 500000, Electricity: 300000, 'Internet & TV': 300000, Water: 100000, 'Airtime & data': 100000, 'Cash withdrawal': 600000, Entertainment: 200000, 'Family & friends': 500000, 'Transaction costs': 50000 },
      };
    }
    await persist();
    toast(`Loaded ${stats.added} demo transactions`);
    showTab('overview');
  });
  $('#wipe').addEventListener('click', async () => {
    if (!confirm('Delete ALL transactions, budgets, rules and categories from this browser? Download a backup first if unsure.')) return;
    state = defaultState();
    await persist();
    toast('All data deleted');
    renderSettings();
  });
}

/* ---------------- Boot ---------------- */

async function init() {
  state = await loadState();
  for (const b of $$('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
  document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) showTab(g.dataset.goto); });
  $('#ov-month').addEventListener('change', renderOverview);
  bindTooltip();
  bindTransactions();
  bindImport();
  bindStatement();
  bindBudget();
  bindSettings();

  // Pick up imports made from the popup or the right-click menu in another tab.
  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area === 'local' && changes.mpesaLedger) {
        state = await loadState();
        render();
      }
    });
  }

  if (!isExtension) setUpWebApp();

  const params = new URLSearchParams(location.search);
  if (await importShared(params)) return;
  let start = params.get('tab');
  try { start ||= sessionStorage.getItem('tab'); } catch {}
  showTab(start || 'overview');
}

const isExtension = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);

// Text shared from the phone's Messages app arrives as ?text=... (Web Share Target).
async function importShared(params) {
  const shared = ['title', 'text', 'url'].map((k) => params.get(k) || '').filter(Boolean).join('\n');
  if (!shared) return false;
  history.replaceState(null, '', location.pathname);
  const { transactions, failed } = parseMessages(shared);
  showTab('import');
  if (!transactions.length) {
    $('#sms-input').value = shared;
    $('#sms-result').innerHTML = alertHtml([{ level: 'warning', title: 'Nothing imported', text: 'The shared text did not contain an M-Pesa confirmation message. It is shown in the box above.' }]);
    return true;
  }
  const stats = addTransactions(state, transactions);
  await persist();
  importResult($('#sms-result'), stats, failed);
  toast(stats.added ? `Imported ${stats.added} M-Pesa transaction(s)` : 'Already imported');
  return true;
}

// Installable web app: offline cache, install button, durable storage and
// keeping several open windows in sync.
function setUpWebApp() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register(new URL('../../sw.js', import.meta.url), { scope: new URL('../../', import.meta.url).pathname }).catch(() => {});
  }
  navigator.storage?.persist?.().catch(() => {});
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    $('#install-app').hidden = false;
  });
  $('#install-app').addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    $('#install-app').hidden = true;
  });
  window.addEventListener('storage', async (e) => {
    if (e.key === 'mpesaLedger') {
      state = await loadState();
      render();
    }
  });
}

init();

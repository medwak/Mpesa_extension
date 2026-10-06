import { loadState, saveState, addTransactions, importTransactions, recategorizeAll, defaultState, migrate } from '../lib/store.js';
import { PERSONAL, ALL_LINES, WALLET_KINDS, LINE_KINDS, walletTxs, walletIdsOf, getWallet, budgetsFor, addWallet, removeWallet, walletLabel, businessWallets, personalLines } from '../lib/wallets.js';
import { peopleDirectory, searchPeople, PEOPLE_SORTS, normalizePhone } from '../lib/people.js';
import { payeeDirectory, billStatuses, billAlerts, suggestBills, newBillFromPayee } from '../lib/bills.js';
import { fetchNewPayments, registerUrls, relayHealth } from '../lib/daraja.js';
import { importStatement, deleteStatement, statementsFor, combineStatements, setStatementEnabled } from '../lib/statements.js';
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

// The account (personal or a business Till/Paybill) being viewed.
const cur = () => getWallet(state, state.settings.currentWallet);
const isBiz = () => !LINE_KINDS.has(cur().kind);
const txs = () => walletTxs(state, cur().id);
const budgets = () => budgetsFor(state, cur().id);
const walletBills = () => {
  const ids = new Set(walletIdsOf(state, cur().id));
  return state.bills.filter((b) => ids.has(b.wallet || PERSONAL));
};
// Where imports go: the account chosen on the Import tab, or the selected one.
function importTarget() {
  const pick = $('#import-target')?.value;
  if (pick && state.wallets.some((w) => w.id === pick)) return pick;
  return cur().virtual ? PERSONAL : cur().id;
}

function monthsWithData() {
  const set = new Set(txs().map((t) => t.date.slice(0, 7)));
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
  renderWalletSelect();
  ({ overview: renderOverview, transactions: renderTransactions, people: renderPeople, import: renderImportLibrary, statement: renderStatementControls, bills: renderBills, budget: renderBudget, settings: renderSettings })[name]?.();
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

  const empty = txs().length === 0;
  $('#ov-empty').hidden = !empty;
  const offCount = statementsFor(state, cur().id).filter((x) => x.disabled).length;
  $('#ov-empty p').textContent = offCount
    ? `Nothing to show: ${offCount} uploaded statement(s) are switched off. Turn them back on in Statements, or import more transactions.`
    : 'No transactions yet. Start by importing your M-Pesa messages or statement.';
  for (const el of [$('#ov-tiles'), $('#ov-alerts'), ...$$('#tab-overview .grid-2')]) el.hidden = empty;
  if (empty) return;

  const { from, to } = monthBounds(chosen);
  const monthTxs = filterRange(txs(), from, to);
  const s = summarize(monthTxs, state.categories);
  const latest = sortByDate(txs()).reverse().find((t) => t.balance != null);

  const tiles = isBiz() ? businessTiles(monthTxs, s, latest) : [
    ['Income', formatKsh(s.income), `${monthTxs.filter((t) => t.direction === 'in').length} payments in`],
    ['Expenses', formatKsh(s.expenses), `${monthTxs.filter((t) => t.direction === 'out').length} payments out`],
    ['Net (income − expenses)', formatKsh(s.net, { sign: true }), s.income ? `${Math.round(s.savingsRate * 100)}% of income kept` : ''],
    ['Transaction costs', formatKsh(s.fees), s.expenses ? `${((s.fees / s.expenses) * 100).toFixed(1)}% of spending` : ''],
    ['M-Pesa balance', latest ? formatKsh(latest.balance) : '—', latest ? `as of ${fmtDate(latest.date)}` : 'no balance seen yet'],
  ];
  $('#ov-tiles').innerHTML = tiles.map(([l, v, n]) => `<div class="tile"><div class="label">${l}</div><div class="value">${v}</div><div class="note">${esc(n)}</div></div>`).join('');

  const plan = budgets()[chosen];
  const budgetAlerts = plan ? evaluateBudget(plan, txs(), { categories: state.categories, today: today() }).alerts.slice(0, 4) : [];
  const dueAlerts = chosen === thisMonth() ? billAlerts(billStatuses(walletBills(), txs(), today())) : [];
  const off = statementsFor(state, cur().id).filter((x) => x.disabled);
  const offAlert = off.length ? [{ level: 'info', title: 'Statements switched off', text: `${off.length} uploaded statement(s) are disabled (${off.map((x) => x.name).join(', ')}), so their transactions are left out of these figures. Turn them back on in Statements.` }] : [];
  $('#ov-alerts').innerHTML = alertHtml([...offAlert, ...dueAlerts, ...budgetAlerts]);

  // Trend for the 6 months ending at the chosen month.
  const trend = monthlyTrend(txs(), state.categories).filter((r) => r.month <= chosen).slice(-6);
  $('#ov-trend').innerHTML = trendChart(trend);

  const spend = s.categories.filter((c) => c.kind === 'expense' && c.total > 0);
  $('#ov-cat-sub').textContent = `${fmtMonth(chosen)} · ${formatKsh(s.expenses)} total`;
  $('#ov-cats').innerHTML = barList(spend.map((c) => ({ name: c.name, value: c.total })), s.expenses);
  const payees = topCounterparties(monthTxs, 'out', 6);
  $('#ov-payees').innerHTML = barList(payees.map((p) => ({ name: p.name, value: p.total, note: `${p.count}×` })));
  const payers = topCounterparties(monthTxs, 'in', 6);
  $('#ov-payers').innerHTML = barList(payers.map((p) => ({ name: p.name, value: p.total, note: `${p.count}×` })), null, 'var(--series-in)');

  $('#ov-payees-title').textContent = isBiz() ? 'Payments out' : 'Top payees';
  $('#ov-payers-title').textContent = isBiz() ? 'Top customers' : 'Top sources of money';
  $('#ov-biz').hidden = !isBiz();
  if (isBiz()) {
    const received = monthTxs.filter((t) => t.direction === 'in' && t.type !== 'reversal');
    const byAcc = new Map();
    const byDay = new Map();
    for (const t of received) {
      const acc = t.account || '(no account number)';
      byAcc.set(acc, (byAcc.get(acc) || 0) + t.amount);
      const d = t.date.slice(0, 10);
      byDay.set(d, (byDay.get(d) || 0) + t.amount);
    }
    $('#ov-accounts').innerHTML = barList([...byAcc].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, value]) => ({ name, value })), null, 'var(--series-in)');
    const days = [...byDay].sort((a, b) => (a[0] < b[0] ? 1 : -1));
    $('#ov-days-sub').textContent = days.length ? `Best day: ${fmtDay([...days].sort((a, b) => b[1] - a[1])[0][0])}` : '';
    $('#ov-days').innerHTML = barList(days.map(([d, value]) => ({ name: new Date(`${d}T00:00`).toLocaleDateString('en-KE', { weekday: 'short', day: '2-digit', month: 'short' }), value })), null, 'var(--series-in)');
  }
}

function businessTiles(monthTxs, s, latest) {
  const received = monthTxs.filter((t) => t.direction === 'in' && t.type !== 'reversal');
  const collected = received.reduce((sum, t) => sum + t.amount, 0);
  const todayTotal = txs().filter((t) => t.direction === 'in' && t.date.startsWith(today())).reduce((sum, t) => sum + t.amount, 0);
  const settled = monthTxs.filter((t) => t.type === 'settlement').reduce((sum, t) => sum + t.amount, 0);
  return [
    ['Collections', formatKsh(collected), `${received.length} customer payment(s)`],
    ['Average payment', received.length ? formatKsh(Math.round(collected / received.length)) : '—', `${new Set(received.map((t) => t.phone || t.counterparty)).size} customer(s)`],
    ["Today's takings", formatKsh(todayTotal), new Date().toLocaleDateString('en-KE', { weekday: 'long' })],
    ['Expenses & charges', formatKsh(s.expenses), `charges ${formatKsh(s.fees)}`],
    ['Settled to bank', formatKsh(settled), latest ? `balance ${formatKsh(latest.balance)}` : ''],
  ];
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
  let list = [...txs()].reverse();
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
      <td class="details-cell"><div class="who">${esc(t.counterparty || TYPE_LABELS[t.type])}</div><div class="meta">${esc(TYPE_LABELS[t.type] || t.type)}${t.account ? ` · Acc ${esc(t.account)}` : ''}${t.phone ? ` · ${esc(t.phone)}` : ''}${t.note && t.source !== 'statement' ? ` · ${esc(t.note)}` : ''}${t.statements?.length ? ` · from ${esc(t.statements.map((id) => state.statements.find((x) => x.id === id)?.name).filter(Boolean).join(', '))}` : ''}</div></td>
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
      const same = txs().filter((t) => t.counterparty === tx.counterparty && t.id !== tx.id && t.category !== tx.category && t.direction === tx.direction);
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
    addTransactions(state, [tx], importTarget());
    await persist();
    e.target.reset();
    toast('Transaction added');
    renderTransactions();
  });
}

/* ---------------- Import ---------------- */

function importResult(el, { added, duplicates, movedTo, moved, businessInPersonal, lineMovedTo, statement }, failed) {
  const into = getWallet(state, lineMovedTo || statement?.wallet || importTarget());
  const parts = [`<div class="alert success"><span class="icon">✓</span><span>Imported <strong>${added}</strong> new transaction(s) into <strong>${esc(walletLabel(into))}</strong>${duplicates ? `, skipped ${duplicates} already imported` : ''}.</span></div>`];
  if (lineMovedTo) parts.push(alertHtml([{ level: 'info', title: 'Your other line', text: `These messages continue the balance of ${walletLabel(getWallet(state, lineMovedTo))}, so they were added there instead of ${walletLabel(getWallet(state, importTarget()))}.` }]));
  if (statement && statement.wallet !== importTarget() && !movedTo) parts.push(alertHtml([{ level: 'info', title: 'Matched to your line', text: `This statement ${statement.phone ? `is for ${statement.phone}` : 'continues the balance of another line'}, so it was added to ${walletLabel(getWallet(state, statement.wallet))}.` }]));
  if (movedTo && moved) parts.push(alertHtml([{ level: 'info', title: 'Business payments', text: `${moved} customer payment(s) went to your business account "${getWallet(state, movedTo).name}" instead of your personal books.` }]));
  if (businessInPersonal) parts.push(alertHtml([{ level: 'info', title: 'Business payments', text: `${businessInPersonal} of these look like payments into a Till/Paybill. To keep business money separate, add your Till/Paybill under Settings → Accounts and import them while it is selected.` }]));
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
    const stats = importTransactions(state, transactions, importTarget());
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

  createStatementUploader({
    input: $('#csv-file'),
    unlock: $('#pdf-unlock'),
    password: $('#pdf-password'),
    hint: $('#pdf-hint'),
    result: $('#csv-result'),
  });
}

// Reads PDF/CSV statement files one after another, asking for the password
// of each locked PDF, and saves each file as an entry in the statements list.
function createStatementUploader({ input, unlock, password, hint, result, nameEl, skip, onDone = () => {} }) {
  let queue = [];
  let current = null; // { file, buffer }
  const outputs = [];
  const showUnlock = (show) => {
    unlock.hidden = !show;
    hint.hidden = !show;
    if (nameEl) nameEl.textContent = show && current ? `${current.file.name}:` : '';
    if (show) password.focus();
  };

  async function readCurrent(pass) {
    const { file, buffer } = current;
    const pdf = isPdf(buffer);
    const parsed = pdf ? await importPdf(buffer.slice(0), pass) : importCsv(new TextDecoder().decode(buffer));
    if (!parsed.transactions.length) throw new Error('No transactions were found in this file.');
    const stats = importStatement(state, parsed.transactions, importTarget(), { name: file.name, kind: pdf ? 'pdf' : 'csv', ...(parsed.meta || {}) });
    await persist();
    return { stats, failed: parsed.failed };
  }

  async function next(pass) {
    while (current || queue.length) {
      if (!current) {
        const file = queue.shift();
        current = { file, buffer: await file.arrayBuffer() };
        password.value = '';
      }
      result.innerHTML = `<p class="sub">Reading ${esc(current.file.name)}…</p>${outputs.join('')}`;
      try {
        const { stats, failed } = await readCurrent(pass);
        const st = stats.statement;
        const el = document.createElement('div');
        importResult(el, stats, failed);
        outputs.push(`<p class="sub" style="margin:8px 0 0"><strong>${esc(current.file.name)}</strong> · saved as a statement for ${fmtDay(st.from)} – ${fmtDay(st.to)}</p>${el.innerHTML}`);
      } catch (err) {
        if (err instanceof PdfPasswordError) {
          showUnlock(true);
          result.innerHTML = (err.wrongPassword ? alertHtml([{ level: 'danger', title: 'Wrong password', text: `Check the code in the Safaricom SMS for ${current.file.name} and try again.` }]) : '') + outputs.join('');
          return; // wait for the password form
        }
        outputs.push(alertHtml([{ level: 'danger', title: `${current.file.name}: import failed`, text: err.message }]));
      }
      current = null;
      pass = undefined;
      showUnlock(false);
    }
    result.innerHTML = outputs.join('');
    onDone();
  }

  input.addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    outputs.length = 0;
    queue.push(...files);
    if (!current) await next();
  });
  unlock.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (current) await next(password.value);
  });
  skip?.addEventListener('click', async () => {
    if (!current) return;
    outputs.push(alertHtml([{ level: 'info', title: 'Skipped', text: current.file.name }]));
    current = null;
    showUnlock(false);
    await next();
  });
}

/* ---------------- Statement ---------------- */

let statementView = () => generateStatement();
const libSelected = new Set();

function renderStatementControls() {
  renderLibrary();
  const years = [...new Set([...txs().map((t) => t.date.slice(0, 4)), today().slice(0, 4)])].sort();
  for (const id of ['#st-yfrom', '#st-yto']) {
    const sel = $(id);
    const keep = sel.value;
    sel.innerHTML = years.map((y) => `<option>${y}</option>`).join('');
    sel.value = keep && years.includes(keep) ? keep : id === '#st-yfrom' ? years[0] : years.at(-1);
  }
  if (!$('#st-from').value && !$('#st-to').value) applyPreset('this-month');
  statementView();
}

function statementSwitch(st) {
  return `<label class="switch"><input type="checkbox" class="st-toggle" data-id="${esc(st.id)}" ${st.disabled ? '' : 'checked'} aria-label="Include ${esc(st.name)} in your books"><span>${st.disabled ? 'Disabled' : 'Included'}</span></label>`;
}

function renderImportLibrary() {
  const list = statementsFor(state, cur().id);
  $('#imp-lib-body').innerHTML = list.length ? list.map((st) => `<tr class="${st.disabled ? 'disabled-st' : ''}">
      <td><div class="file">${esc(st.name)}</div></td>
      <td>${fmtDay(st.from)} – ${fmtDay(st.to)}</td>
      <td class="num">${st.count}</td>
      <td>${statementSwitch(st)}</td>
    </tr>`).join('') : '<tr><td colspan="4" class="sub">No statements uploaded for this account yet.</td></tr>';
}

async function toggleStatements(ids, enabled) {
  for (const id of ids) setStatementEnabled(state, id, enabled);
  await persist();
  const names = ids.map((id) => state.statements.find((x) => x.id === id)?.name).filter(Boolean);
  const one = names.length === 1;
  toast(`${enabled ? 'Included' : 'Disabled'}: ${one ? names[0] : `${names.length} statements`}${enabled ? '' : one ? '. Its transactions are left out until you enable it again.' : '. Their transactions are left out until you enable them again.'}`);
  render();
}

function renderLibrary() {
  const list = statementsFor(state, cur().id);
  for (const id of [...libSelected]) if (!list.some((x) => x.id === id)) libSelected.delete(id);
  $('#lib-body').innerHTML = list.length ? list.map((st) => `<tr data-id="${esc(st.id)}" class="${st.disabled ? 'disabled-st' : ''}">
      <td><input type="checkbox" class="lib-check" ${libSelected.has(st.id) ? 'checked' : ''} aria-label="Select ${esc(st.name)}"></td>
      <td><div class="file">${esc(st.name)}</div><div class="meta">${st.kind.toUpperCase()}</div></td>
      <td>${fmtDay(st.from)} – ${fmtDay(st.to)}</td>
      <td class="num">${st.count}</td>
      <td class="num">${formatKsh(st.openingBalance)}</td>
      <td class="num">${formatKsh(st.closingBalance)}</td>
      <td>${new Date(st.importedAt).toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
      <td>${statementSwitch(st)}</td>
      <td><div class="row" style="margin:0;flex-wrap:nowrap"><button data-lib="view">View</button><button class="danger" data-lib="delete">Delete</button></div></td>
    </tr>`).join('') : '<tr><td colspan="9" class="sub">No statements uploaded for this account yet. Add the PDF Safaricom emailed you, or a CSV statement.</td></tr>';
  $('#lib-all').checked = list.length > 0 && libSelected.size === list.length;
  const n = libSelected.size;
  $('#lib-combine').disabled = n < 1;
  $('#lib-combine').textContent = n > 1 ? `Combine ${n} statements` : 'View selected';
  $('#lib-delete-selected').disabled = n < 1;
  $('#lib-disable-selected').disabled = ![...libSelected].some((id) => !state.statements.find((x) => x.id === id)?.disabled);
  $('#lib-enable-selected').disabled = ![...libSelected].some((id) => state.statements.find((x) => x.id === id)?.disabled);
  if (n) {
    const c = combineStatements(state, [...libSelected]);
    $('#lib-selinfo').textContent = `${n} selected · ${fmtDay(c.from)} – ${fmtDay(c.to)}${c.gaps.length ? ` · ${c.gaps.length} gap(s) not covered` : ''}`;
  } else {
    $('#lib-selinfo').textContent = '';
  }
}

function showStatements(ids) {
  const c = combineStatements(state, ids);
  statementView = () => showStatements(ids.filter((id) => state.statements.some((x) => x.id === id)));
  $('#st-from').value = c.from;
  $('#st-to').value = c.to;
  const names = c.statements.map((x) => x.name);
  renderStatement({
    source: c.txs,
    from: c.from,
    to: c.to,
    title: ids.length > 1 ? 'Combined M-PESA Statement' : 'M-PESA Statement',
    note: `${ids.length > 1 ? `Combined from ${ids.length} uploaded statements` : 'Uploaded statement'}: ${names.join(', ')}`,
    extraAlerts: c.gaps.map((g) => ({ level: 'warning', title: 'Missing period', text: `None of the chosen statements covers ${fmtDay(g.from)} – ${fmtDay(g.to)}. Add that statement to make the combined statement complete.` })),
  });
  $('#st-output').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    from = txs()[0]?.date.slice(0, 10) || today();
    to = txs().at(-1)?.date.slice(0, 10) || today();
  }
  $('#st-from').value = from;
  $('#st-to').value = to;
}

function generateStatement() {
  statementView = generateStatement;
  const openingInput = $('#st-opening').value;
  renderStatement({ source: txs(), from: $('#st-from').value, to: $('#st-to').value, opening: openingInput === '' ? undefined : parseAmount(openingInput) });
}

function renderStatement({ source, from, to, opening, title = 'M-PESA Statement', note = '', extraAlerts = [] }) {
  const st = buildStatement(source, { from, to, openingBalance: opening });
  lastStatement = st;
  const periodTxs = filterRange(source, from, to);
  const pl = summarize(periodTxs, state.categories);

  const gapNote = st.gaps.length
    ? alertHtml([{ level: 'warning', text: `${st.gaps.length} place(s) where the balance in the message does not match the running total. A transaction is probably missing before: ${st.gaps.slice(0, 5).map((g) => `${fmtDate(g.date)} (${formatKsh(g.diff, { sign: true })})`).join(', ')}${st.gaps.length > 5 ? '…' : ''}. Import the missing messages or a full statement to reconcile.` }])
    : st.rows.length ? alertHtml([{ level: 'success', text: 'All balances reconcile with your M-Pesa messages.' }]) : '';

  $('#st-output').innerHTML = `<div class="no-print">${alertHtml(extraAlerts)}${gapNote}</div>
  <article class="statement">
    <header>
      <div><div class="title">${esc(title)}</div><div class="period"><strong>${esc(walletLabel(cur()))}</strong><br>${from ? fmtDay(from) : 'Start'} – ${to ? fmtDay(to) : 'Today'}</div></div>
      <div class="sub" style="text-align:right">Generated ${new Date().toLocaleString('en-KE')}<br>${st.rows.length} transactions</div>
    </header>
    ${note ? `<p class="sources">${esc(note)}</p>` : ''}
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
  $('#st-months').addEventListener('click', () => {
    let [a, b] = [$('#st-mfrom').value, $('#st-mto').value || $('#st-mfrom').value];
    if (!a) return toast('Pick the first month');
    if (b < a) [a, b] = [b, a];
    $('#st-from').value = `${a}-01`;
    $('#st-to').value = monthBounds(b).to;
    generateStatement();
  });
  $('#st-years').addEventListener('click', () => {
    let [a, b] = [$('#st-yfrom').value, $('#st-yto').value];
    if (b < a) [a, b] = [b, a];
    $('#st-from').value = `${a}-01-01`;
    $('#st-to').value = `${b}-12-31`;
    generateStatement();
  });
  $('#st-print').addEventListener('click', () => { statementView(); window.print(); });
  $('#st-csv').addEventListener('click', () => {
    statementView();
    download(`mpesa-statement_${$('#st-from').value}_${$('#st-to').value}.csv`, statementToCsv(lastStatement), 'text/csv');
  });

  createStatementUploader({
    input: $('#lib-file'),
    unlock: $('#lib-unlock'),
    password: $('#lib-password'),
    hint: $('#lib-hint'),
    result: $('#lib-result'),
    nameEl: $('#lib-unlock-name'),
    skip: $('#lib-skip'),
    onDone: () => renderStatementControls(),
  });

  const removeStatements = async (ids) => {
    let removed = 0;
    let kept = 0;
    for (const id of ids) {
      const r = deleteStatement(state, id);
      removed += r.removed;
      kept += r.kept;
      libSelected.delete(id);
    }
    await persist();
    statementView = generateStatement;
    toast(`Deleted ${ids.length} statement(s): ${removed} transaction(s) removed${kept ? `, ${kept} kept (also in another statement or from SMS)` : ''}`);
    renderStatementControls();
  };

  document.addEventListener('change', (e) => {
    if (e.target.classList?.contains('st-toggle')) toggleStatements([e.target.dataset.id], e.target.checked);
  });
  $('#lib-disable-selected').addEventListener('click', () => toggleStatements([...libSelected], false));
  $('#lib-enable-selected').addEventListener('click', () => toggleStatements([...libSelected], true));
  $('#lib-body').addEventListener('change', (e) => {
    if (!e.target.classList.contains('lib-check')) return;
    const id = e.target.closest('tr').dataset.id;
    if (e.target.checked) libSelected.add(id);
    else libSelected.delete(id);
    renderLibrary();
  });
  $('#lib-all').addEventListener('change', (e) => {
    libSelected.clear();
    if (e.target.checked) for (const st of statementsFor(state, cur().id)) libSelected.add(st.id);
    renderLibrary();
  });
  $('#lib-body').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-lib]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    const st = state.statements.find((x) => x.id === id);
    if (btn.dataset.lib === 'view') return showStatements([id]);
    if (confirm(`Delete the statement "${st.name}" (${fmtDay(st.from)} – ${fmtDay(st.to)})?\n\nIts transactions are removed from your books, except any that are also in another statement or came from SMS or manual entries.`)) {
      await removeStatements([id]);
    }
  });
  $('#lib-combine').addEventListener('click', () => {
    const ids = statementsFor(state, cur().id).map((x) => x.id).filter((id) => libSelected.has(id));
    if (ids.length) showStatements(ids);
  });
  $('#lib-delete-selected').addEventListener('click', async () => {
    const ids = [...libSelected];
    if (ids.length && confirm(`Delete ${ids.length} statement(s)?\n\nTheir transactions are removed from your books, except any that are also in another statement or came from SMS or manual entries.`)) {
      await removeStatements(ids);
    }
  });
}

/* ---------------- People ---------------- */

function renderPeople() {
  const mSel = $('#people-month');
  const keep = mSel.value;
  mSel.innerHTML = `<option value="">All time</option>` + monthsWithData().map((m) => `<option value="${m}" ${m === keep ? 'selected' : ''}>${fmtMonth(m)}</option>`).join('');
  const scope = mSel.value ? txs().filter((t) => t.date.startsWith(mSel.value)) : txs();
  const all = peopleDirectory(scope);
  const list = searchPeople(all, $('#people-search').value).sort(PEOPLE_SORTS[$('#people-sort').value] || PEOPLE_SORTS.recent);
  const sent = list.reduce((s, p) => s + p.sentTotal, 0);
  const received = list.reduce((s, p) => s + p.receivedTotal, 0);
  $('#people-count').textContent = `${list.length} ${list.length === 1 ? 'person' : 'people'} · sent ${formatKsh(sent)} · received ${formatKsh(received)}`;
  renderPeople.list = list;
  $('#people-list').innerHTML = list.length ? list.slice(0, 300).map((p, i) => `<details class="payee person">
      <summary>
        <span class="pname">${esc(p.name)}</span>
        <span class="ptotal num">${p.sentTotal ? `<span>−${formatKsh(p.sentTotal).replace('Ksh ', '')}</span>` : ''}${p.receivedTotal ? `<span class="in">+${formatKsh(p.receivedTotal).replace('Ksh ', '')}</span>` : ''}<div class="sub" style="margin:0">${p.count} transaction(s)</div></span>
        <span class="pmeta">${p.phones.length ? esc(p.phones.join(' · ')) : 'no number'} · last ${fmtDate(p.last)}</span>
      </summary>
      <div class="person-stats">
        <div><span>Sent</span><strong>${formatKsh(p.sentTotal)}</strong><em>${p.sentCount}×${p.fees ? ` · costs ${formatKsh(p.fees)}` : ''}</em></div>
        <div><span>Received</span><strong>${formatKsh(p.receivedTotal)}</strong><em>${p.receivedCount}×</em></div>
        <div><span>Net</span><strong>${formatKsh(p.net, { sign: true })}</strong><em>since ${fmtDay(p.first.slice(0, 10))}</em></div>
      </div>
      ${p.names.length > 1 ? `<p class="sub" style="margin:4px 0">Also shown as: ${esc(p.names.filter((n) => n !== p.name).join(', '))}</p>` : ''}
      <div class="table-wrap" style="border:none"><table class="data compact"><tbody>${p.history.slice(0, 50).map((t) => `<tr><td>${fmtDate(t.date)}</td><td><code>${esc(t.code || '')}</code></td><td>${esc(TYPE_LABELS[t.type] || t.type)}${t.phone ? ` · ${esc(t.phone)}` : ''}</td><td class="num ${t.direction === 'in' ? 'in' : ''}">${t.direction === 'in' ? '+' : '−'}${formatKsh(t.amount).replace('Ksh ', '')}</td></tr>`).join('')}</tbody></table></div>
      <div class="row"><button data-person-tx="${i}">Show in Transactions</button></div>
    </details>`).join('') : `<p class="sub">${all.length ? 'No one matches that search.' : 'No money sent to or received from people in this account yet.'}</p>`;
}

function bindPeople() {
  for (const id of ['#people-search', '#people-month', '#people-sort']) $(id).addEventListener('input', renderPeople);
  $('#people-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-person-tx]');
    if (!b) return;
    const p = renderPeople.list[Number(b.dataset.personTx)];
    $('#tx-search').value = p.phones.find((x) => !x.includes('*')) || p.phones[0] || p.name;
    $('#tx-month').value = '';
    showTab('transactions');
  });
}

/* ---------------- Accounts ---------------- */

function renderWalletSelect() {
  const sel = $('#wallet-select');
  sel.hidden = state.wallets.length < 2;
  const options = personalLines(state).length > 1 ? [getWallet(state, ALL_LINES), ...state.wallets] : state.wallets;
  sel.innerHTML = options.map((w) => `<option value="${esc(w.id)}" ${w.id === cur().id ? 'selected' : ''}>${esc(walletLabel(w))}</option>`).join('');
  // Import tab: choose which account (line) the next import goes to.
  const imp = $('#import-target');
  if (imp) {
    const keep = imp.value;
    imp.innerHTML = state.wallets.map((w) => `<option value="${esc(w.id)}">${esc(walletLabel(w))}</option>`).join('');
    imp.value = state.wallets.some((w) => w.id === keep) && keep ? keep : (cur().virtual ? PERSONAL : cur().id);
    $('#import-target-row').hidden = state.wallets.length < 2;
  }
}

async function switchWallet(id) {
  state.settings.currentWallet = id;
  await persist();
  $('#ov-month').value = '';
  statementView = generateStatement;
  libSelected.clear();
  render();
  autoSync();
}

// Downloads new Daraja payments for a business account from its relay.
async function syncWallet(id, { quiet = false } = {}) {
  const wallet = state.wallets.find((w) => w.id === id);
  if (!wallet?.relayUrl || !wallet.relayToken) return null;
  try {
    const { transactions, cursor } = await fetchNewPayments(wallet);
    const w = state.wallets.find((x) => x.id === id);
    const stats = addTransactions(state, transactions, id);
    Object.assign(w, { lastSyncCursor: cursor, lastSyncAt: new Date().toISOString(), lastSyncError: null });
    await persist();
    if (!quiet || stats.added) toast(stats.added ? `${stats.added} new payment(s) synced to ${w.name}` : `${w.name} is up to date`);
    render();
    return stats;
  } catch (err) {
    const w = state.wallets.find((x) => x.id === id);
    if (w) {
      w.lastSyncError = err.message;
      await persist();
    }
    if (!quiet) toast(`Sync failed: ${err.message}`);
    if (currentTab() === 'settings') renderSettings();
    return null;
  }
}

function autoSync() {
  const w = cur();
  if (w.relayUrl && w.relayToken) syncWallet(w.id, { quiet: true });
}

function renderAccounts() {
  const open = new Set($$('#accounts-list details[open]').map((d) => d.dataset.id));
  $('#accounts-list').innerHTML = state.wallets.map((w) => {
    const count = walletTxs(state, w.id).length;
    const head = `<div class="head"><div><strong>${esc(w.name)}</strong> <span class="kind">${esc(WALLET_KINDS[w.kind] || w.kind)}${w.shortcode ? ` ${esc(w.shortcode)}` : ''}</span><div class="sub" style="margin:0">${count} transaction(s)</div></div>
      <div class="row" style="margin:0">${w.id === cur().id ? '<span class="badge paid">Selected</span>' : `<button data-act="select" data-id="${esc(w.id)}">Open</button>`}${w.kind === 'personal' ? '' : `<button class="danger" data-act="delete" data-id="${esc(w.id)}">Remove</button>`}</div></div>`;
    if (LINE_KINDS.has(w.kind)) {
      return `<div class="account-row">${head}
        <form class="line-form row" data-id="${esc(w.id)}" style="margin:8px 0 0">
          <label class="sub" style="margin:0">My number on this line <input name="phone" inputmode="tel" placeholder="e.g. 0712 345 678" value="${esc(w.phone || '')}"></label>
          <input name="name" aria-label="Line name" value="${esc(w.name)}">
          <button type="submit">Save</button>
        </form></div>`;
    }
    const status = w.lastSyncError
      ? `<span class="sync-status">Last sync failed: ${esc(w.lastSyncError)}</span>`
      : w.lastSyncAt ? `<span class="sync-status">Last synced ${esc(new Date(w.lastSyncAt).toLocaleString('en-KE'))}</span>` : '';
    return `<div class="account-row">${head}
      <details data-id="${esc(w.id)}" ${open.has(w.id) ? 'open' : ''}>
        <summary>Automatic sync with Safaricom Daraja ${w.relayUrl ? '(on)' : '(off)'}</summary>
        <p class="sub">Needs a Daraja app for this ${w.kind === 'paybill' ? 'Paybill' : 'Till'} and the free relay in the <code>relay/</code> folder (see its README). Payments then appear here automatically.</p>
        <form class="relay-form form-grid" data-id="${esc(w.id)}">
          <label>Relay URL <input name="relayUrl" type="url" placeholder="https://ledger-relay.you.workers.dev" value="${esc(w.relayUrl || '')}"></label>
          <label>Sync token <input name="relayToken" type="password" autocomplete="off" placeholder="SYNC_TOKEN from the relay" value="${esc(w.relayToken || '')}"></label>
          <div class="span-2 row" style="margin:0">
            <button class="primary" type="submit">Save</button>
            <button type="button" data-act="test" data-id="${esc(w.id)}">Test connection</button>
            <button type="button" data-act="register" data-id="${esc(w.id)}">Register with Safaricom</button>
            <button type="button" data-act="sync" data-id="${esc(w.id)}">Sync now</button>
          </div>
        </form>
        ${status}
      </details>
    </div>`;
  }).join('');
}

function bindAccounts() {
  $('#wallet-select').addEventListener('change', (e) => switchWallet(e.target.value));
  $('#wallet-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const code = String(f.get('shortcode') || '').trim();
    const kind = f.get('kind');
    if (kind === 'line') {
      if (!/^0[17]\d{8}$/.test(normalizePhone(code))) return toast('Enter the phone number of this M-Pesa line, e.g. 0712 345 678');
      if (state.wallets.some((x) => x.phone && normalizePhone(x.phone) === normalizePhone(code))) return toast('That number is already one of your accounts');
    } else if (code && !/^\d{5,7}$/.test(code)) return toast('Till and Paybill numbers have 5 to 7 digits');
    const w = addWallet(state, { name: f.get('name'), kind, shortcode: code, phone: code });
    e.target.reset();
    await switchWallet(w.id);
    toast(`Added ${w.name}. It is now the selected account.`);
  });
  $('#wallet-form [name=kind]').addEventListener('change', (e) => {
    const line = e.target.value === 'line';
    $('#wallet-form [name=shortcode]').placeholder = line ? 'Phone number of this line' : 'Till / Paybill number';
    $('#wallet-form [name=name]').placeholder = line ? 'Name, e.g. Safaricom line 2' : 'Business name, e.g. Mama Mboga Shop';
  });
  $('#accounts-list').addEventListener('submit', async (e) => {
    if (e.target.classList.contains('line-form')) {
      e.preventDefault();
      const w = state.wallets.find((x) => x.id === e.target.dataset.id);
      const fields = e.target.elements;
      const phone = normalizePhone(fields.phone.value);
      if (phone && !/^0[17]\d{8}$/.test(phone)) return toast('That does not look like a Safaricom number');
      w.phone = phone;
      w.name = fields.name.value.trim() || w.name;
      await persist();
      toast('Saved');
      render();
      return;
    }
    if (!e.target.classList.contains('relay-form')) return;
    e.preventDefault();
    const w = state.wallets.find((x) => x.id === e.target.dataset.id);
    const f = new FormData(e.target);
    w.relayUrl = String(f.get('relayUrl') || '').trim();
    w.relayToken = String(f.get('relayToken') || '').trim();
    await persist();
    toast('Daraja relay saved');
  });
  $('#accounts-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const w = state.wallets.find((x) => x.id === btn.dataset.id);
    const act = btn.dataset.act;
    if (act === 'select') return switchWallet(w.id);
    if (act === 'delete') {
      const n = walletTxs(state, w.id).length;
      if (!confirm(`Remove "${w.name}" and its ${n} transaction(s), budgets and bills from this device?`)) return;
      removeWallet(state, w.id);
      await persist();
      render();
      return;
    }
    // Use what is typed in the form even if not saved yet.
    const form = btn.closest('form');
    const draft = { ...w, relayUrl: form.relayUrl.value.trim(), relayToken: form.relayToken.value.trim() };
    btn.disabled = true;
    try {
      if (act === 'test') {
        const h = await relayHealth(draft);
        toast(`Relay OK · ${h.environment} · shortcode ${h.shortcode || 'not set'}${h.darajaKeysSet ? '' : ' · Daraja keys missing'}`);
      } else if (act === 'register') {
        const r = await registerUrls(draft);
        toast(`Safaricom accepted the callback URLs for ${r.shortcode} (${r.environment})`);
      } else if (act === 'sync') {
        Object.assign(w, { relayUrl: draft.relayUrl, relayToken: draft.relayToken });
        await persist();
        await syncWallet(w.id);
      }
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---------------- Bills ---------------- */

const STATUS_TEXT = { paid: 'Paid', partial: 'Part paid', 'due-soon': 'Due soon', overdue: 'Overdue', upcoming: 'Upcoming', unpaid: 'Not paid yet' };

function renderBills() {
  const all = txs();
  const statuses = billStatuses(walletBills(), all, today());
  $('#bills-alerts').innerHTML = alertHtml(billAlerts(statuses));
  $('#bills-body').innerHTML = statuses.length ? statuses.map((st) => {
    const b = st.bill;
    const where = [b.shortcode ? `#${esc(b.shortcode)}` : '', esc(b.match), b.account ? `Acc ${esc(b.account)}` : ''].filter(Boolean).join(' · ');
    return `<tr data-id="${esc(b.id)}">
      <td><strong>${esc(b.label)}</strong></td>
      <td>${where}</td>
      <td class="num">${b.amount ? formatKsh(b.amount) : '—'}</td>
      <td>${b.dueDay ? `Day ${b.dueDay}` : '—'}</td>
      <td><span class="badge ${st.status}">${STATUS_TEXT[st.status]}${st.paid ? ` · ${formatKsh(st.paid)}` : ''}</span></td>
      <td>${st.lastPayment ? `${fmtDate(st.lastPayment.date)}<div class="sub" style="margin:0">${formatKsh(st.lastPayment.amount)}</div>` : '—'}</td>
      <td><button class="icon-btn" data-del-bill="${esc(b.id)}" aria-label="Remove bill">✕</button></td>
    </tr>`;
  }).join('') : '<tr><td colspan="7" class="sub">No bills saved yet. Add one below, or use a suggestion.</td></tr>';

  const dir = payeeDirectory(all);
  $('#payee-names').innerHTML = dir.map((p) => `<option value="${esc(p.name)}">`).join('');

  const sugg = suggestBills(all, walletBills(), today());
  $('#bills-suggest-card').hidden = !sugg.length;
  renderBills.suggestions = sugg;
  $('#bills-suggest').innerHTML = sugg.map((sg, i) => `<div class="suggestion">
      <div><strong>${esc(sg.payee.name)}</strong>${sg.payee.account ? ` · Acc ${esc(sg.payee.account)}` : ''}
      <div class="sub" style="margin:0">Paid in ${sg.months} of the last 3 months · usually ${formatKsh(sg.typicalAmount)} around day ${sg.typicalDay}</div></div>
      <button class="primary" data-track="${i}">Track as bill</button></div>`).join('');

  const q = $('#payee-search').value.trim().toLowerCase();
  const shown = dir.filter((p) => !q || `${p.name} ${p.account} ${p.shortcode}`.toLowerCase().includes(q));
  renderBills.directory = dir;
  $('#payees-list').innerHTML = shown.length ? shown.map((p) => {
    const kind = p.type === 'paybill' ? 'Paybill' : 'Till';
    const idx = dir.indexOf(p);
    return `<details class="payee"><summary>
        <span class="pname">${esc(p.name)}</span>
        <span class="ptotal num">${formatKsh(p.total)}<div class="sub" style="margin:0">${p.count} payment(s)</div></span>
        <span class="pmeta">${kind}${p.shortcode ? ` ${esc(p.shortcode)}` : ''}${p.account ? ` · Acc ${esc(p.account)}` : ''} · avg ${formatKsh(p.average)} · last ${fmtDate(p.lastDate)}</span>
      </summary>
      <table class="data compact"><tbody>${p.history.slice(0, 12).map((t) => `<tr><td>${fmtDate(t.date)}</td><td><code>${esc(t.code || '')}</code></td><td class="num">${formatKsh(t.amount)}</td></tr>`).join('')}</tbody></table>
      <div class="row"><button data-track-payee="${idx}">Track as a monthly bill</button></div>
    </details>`;
  }).join('') : `<p class="sub">${dir.length ? 'No match.' : 'No Paybill or Till payments in this account yet.'}</p>`;
}

function bindBills() {
  $('#payee-search').addEventListener('input', renderBills);
  const save = async (bill) => {
    state.bills.push({ ...bill, wallet: cur().virtual ? PERSONAL : cur().id });
    await persist();
    toast(`Tracking ${bill.label}`);
    renderBills();
  };
  $('#bill-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const dueDay = Number(f.get('dueDay')) || null;
    await save({
      id: `bill-${Date.now().toString(36)}`,
      label: f.get('label').trim(),
      match: f.get('match').trim(),
      account: f.get('account').trim(),
      shortcode: f.get('shortcode').trim(),
      amount: parseAmount(f.get('amount')) || 0,
      dueDay: dueDay && dueDay >= 1 && dueDay <= 31 ? dueDay : null,
    });
    e.target.reset();
  });
  $('#tab-bills').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-track]');
    if (t) return save(newBillFromPayee(renderBills.suggestions[Number(t.dataset.track)].payee, renderBills.suggestions[Number(t.dataset.track)]));
    const tp = e.target.closest('[data-track-payee]');
    if (tp) return save(newBillFromPayee(renderBills.directory[Number(tp.dataset.trackPayee)]));
    const del = e.target.closest('[data-del-bill]');
    if (del && confirm('Stop tracking this bill?')) {
      state.bills = state.bills.filter((b) => b.id !== del.dataset.delBill);
      await persist();
      renderBills();
    }
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
  const plan = budgets()[month] || emptyPlan(month);
  const form = $('#bg-form');
  form.expectedIncome.value = plan.expectedIncome ? plan.expectedIncome / 100 : '';
  form.savingsGoal.value = plan.savingsGoal ? plan.savingsGoal / 100 : '';
  const expenseCats = state.categories.filter((c) => c.kind === 'expense');
  $('#bg-limits').innerHTML = expenseCats.map((c) => `<tr><td>${esc(c.name)}</td><td class="num"><input type="number" min="0" step="1" data-cat="${esc(c.name)}" value="${plan.limits[c.name] ? plan.limits[c.name] / 100 : ''}" placeholder="—" aria-label="${esc(c.name)} limit"></td></tr>`).join('');

  const ev = evaluateBudget(plan, txs(), { categories: state.categories, today: today() });
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
    budgets()[month] = {
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
    const prevTxs = filterRange(txs(), from, to);
    if (!budgets()[prev] && !prevTxs.length) {
      toast('No budget or spending found for last month');
      return;
    }
    if (budgets()[month] && !confirm('Replace this month\'s budget with one based on last month?')) return;
    budgets()[month] = suggestPlan(month, { previousPlan: budgets()[prev], previousSummary: summarize(prevTxs, state.categories) });
    await persist();
    toast(budgets()[prev] ? 'Copied last month\'s budget' : 'Built a budget from last month\'s spending');
    renderBudget();
  });
}

/* ---------------- Settings ---------------- */

function renderSettings() {
  renderAccounts();
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
    for (const all of [state.budgets, ...Object.values(state.walletBudgets || {})]) for (const plan of Object.values(all)) delete plan.limits?.[name];
    await persist();
    renderSettings();
  });

  $('#backup-export').addEventListener('click', () => download(`mpesa-ledger-backup-${today()}.json`, JSON.stringify(state, null, 2), 'application/json'));
  $('#tx-export').addEventListener('click', () => download(`mpesa-transactions-${today()}.csv`, transactionsToCsv(txs()), 'text/csv'));
  $('#backup-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.transactions)) throw new Error('Not an M-Pesa Ledger backup');
      if (!confirm(`Replace current data with the backup (${data.transactions.length} transactions)?`)) return;
      state = migrate(data);
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
    const stats = addTransactions(state, demoTransactions(), PERSONAL);
    state.settings.currentWallet = PERSONAL;
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
  bindBills();
  bindPeople();
  bindAccounts();
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
  autoSync();
  setInterval(autoSync, 5 * 60 * 1000);

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
  const stats = importTransactions(state, transactions, importTarget());
  await persist();
  importResult($('#sms-result'), stats, failed);
  toast(stats.added ? `Imported ${stats.added} M-Pesa transaction(s)` : 'Already imported');
  return true;
}

// Installable web app: offline cache, install button, durable storage and
// keeping several open windows in sync.
// Explains, on the phone itself, why the browser will or will not install
// the app. Each check matches one of Chrome's install requirements.
async function runInstallChecks() {
  const checks = [];
  const add = (ok, text, fix = '') => checks.push({ ok, text, fix });
  add(window.isSecureContext, 'Opened over a secure https:// address', 'Open the https:// link from your host (Netlify, GitHub Pages).');
  const link = document.querySelector('link[rel="manifest"]');
  let manifest = null;
  try {
    // Browsers fetch the manifest without your login, so test it the same way.
    const res = await fetch(link.href, { cache: 'no-store', credentials: 'omit', redirect: 'manual' });
    const blocked = [401, 403].includes(res.status) || res.type === 'opaqueredirect';
    if (res.ok) manifest = await res.json().catch(() => null);
    const fix = blocked
      ? 'The site is private, so the phone cannot read this file. In Netlify, open the site and press "Make public" (or turn off password / visitor access protection), then reload.'
      : res.status === 404
        ? `Not found (404) at ${link.href}. Upload the folder that has index.html, manifest.webmanifest and sw.js directly inside it, from the latest download.`
        : `Nothing usable at ${link.href} (status ${res.status || 'redirect'}). Upload the latest download again.`;
    add(Boolean(manifest), `App manifest found at ${new URL(link.href).pathname}`, fix);
  } catch {
    add(false, 'App manifest found', `Could not load ${link.href}. Upload the latest download, dragging the folder that contains manifest.webmanifest.`);
  }
  if (manifest) {
    const icons = manifest.icons || [];
    const base = link.href;
    const sizes = await Promise.all(['192x192', '512x512'].map(async (size) => {
      const icon = icons.find((i) => i.sizes === size);
      if (!icon) return false;
      try {
        return (await fetch(new URL(icon.src, base), { cache: 'no-store' })).ok;
      } catch {
        return false;
      }
    }));
    add(sizes.every(Boolean), 'App icons (192 and 512 px) load', 'The icons folder is missing from the upload.');
  }
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
  add(Boolean(reg), 'Offline support (service worker) is running', 'sw.js is missing from the site root, or the page needs one reload.');
  const installed = matchMedia('(display-mode: standalone)').matches;
  if (installed) add(true, 'Already running as an installed app');
  $('#install-checks').innerHTML = checks.map((c) => `<li class="${c.ok ? 'ok' : 'bad'}"><span class="mark">${c.ok ? '✓' : '✗'}</span><span>${esc(c.text)}${!c.ok && c.fix ? `<div class="fix">${esc(c.fix)}</div>` : ''}</span></li>`).join('');
  return checks;
}

export const APP_VERSION = '2026.10.06-1';

function setUpWebApp() {
  $('#install-card').hidden = false;
  $('#app-version').textContent = APP_VERSION;
  $('#install-recheck').addEventListener('click', runInstallChecks);
  setTimeout(runInstallChecks, 1500);
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

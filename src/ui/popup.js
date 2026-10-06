import { loadState, saveState, importTransactions } from '../lib/store.js';
import { parseMessages } from '../lib/parser.js';
import { summarize, filterRange, monthBounds, sortByDate } from '../lib/ledger.js';
import { evaluateBudget } from '../lib/budget.js';
import { billStatuses, billAlerts } from '../lib/bills.js';
import { walletTxs, walletIdsOf, getWallet, budgetsFor, walletLabel, PERSONAL, ALL_LINES, LINE_KINDS } from '../lib/wallets.js';
import { formatKsh } from '../lib/money.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function render() {
  const state = await loadState();
  const wallet = getWallet(state, state.settings.currentWallet);
  const txs = walletTxs(state, wallet.id);
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const { from, to } = monthBounds(month);
  const s = summarize(filterRange(txs, from, to), state.categories);
  const latest = sortByDate(txs).reverse().find((t) => t.balance != null);
  const [y, m] = month.split('-').map(Number);
  $('#month').textContent = new Date(y, m - 1, 1).toLocaleString('en-KE', { month: 'long', year: 'numeric' });
  $('#wallet').textContent = state.wallets.length > 1 ? walletLabel(wallet) : '';

  const biz = !LINE_KINDS.has(wallet.kind);
  $('#stats').innerHTML = [
    [biz ? 'Collections' : 'Income', formatKsh(s.income)],
    ['Expenses', formatKsh(s.expenses)],
    ['Net', formatKsh(s.net, { sign: true })],
    [biz ? 'Balance' : 'M-Pesa balance', latest ? formatKsh(latest.balance) : '—'],
  ].map(([l, v]) => `<div class="stat"><span>${l}</span><strong>${v}</strong></div>`).join('');

  const ids = new Set(walletIdsOf(state, wallet.id));
  const alerts = billAlerts(billStatuses(state.bills.filter((b) => ids.has(b.wallet || PERSONAL)), txs, today));
  const plan = budgetsFor(state, wallet.id)[month];
  if (plan) alerts.push(...evaluateBudget(plan, txs, { categories: state.categories }).alerts.filter((a) => a.level !== 'info'));
  $('#alerts').innerHTML = alerts
    .slice(0, 3)
    .map((a) => `<div class="alert ${a.level}"><span class="icon" aria-hidden="true">!</span><span>${esc(a.text)}</span></div>`)
    .join('');
}

$('#import').addEventListener('click', async () => {
  const { transactions, failed } = parseMessages($('#paste').value);
  if (!transactions.length) {
    $('#msg').textContent = 'No M-Pesa transactions found in that text.';
    return;
  }
  const state = await loadState();
  const target = state.settings.currentWallet === ALL_LINES ? PERSONAL : state.settings.currentWallet;
  const { added, duplicates } = importTransactions(state, transactions, target);
  await saveState(state);
  $('#paste').value = '';
  $('#msg').textContent = `Imported ${added}${duplicates ? `, ${duplicates} already saved` : ''}${failed.length ? `, ${failed.length} not recognised` : ''}.`;
  render();
});

$('#open').addEventListener('click', () => {
  const url = chrome.runtime.getURL('src/ui/dashboard.html');
  chrome.tabs.create({ url });
  window.close();
});

render();

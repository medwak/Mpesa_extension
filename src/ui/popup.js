import { loadState, saveState, addTransactions } from '../lib/store.js';
import { parseMessages } from '../lib/parser.js';
import { summarize, filterRange, monthBounds, sortByDate } from '../lib/ledger.js';
import { evaluateBudget } from '../lib/budget.js';
import { formatKsh } from '../lib/money.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function render() {
  const state = await loadState();
  const month = new Date().toISOString().slice(0, 7);
  const { from, to } = monthBounds(month);
  const s = summarize(filterRange(state.transactions, from, to), state.categories);
  const latest = sortByDate(state.transactions).reverse().find((t) => t.balance != null);
  const [y, m] = month.split('-').map(Number);
  $('#month').textContent = new Date(y, m - 1, 1).toLocaleString('en-KE', { month: 'long', year: 'numeric' });

  $('#stats').innerHTML = [
    ['Income', formatKsh(s.income)],
    ['Expenses', formatKsh(s.expenses)],
    ['Net', formatKsh(s.net, { sign: true })],
    ['M-Pesa balance', latest ? formatKsh(latest.balance) : '—'],
  ].map(([l, v]) => `<div class="stat"><span>${l}</span><strong>${v}</strong></div>`).join('');

  const plan = state.budgets[month];
  if (plan) {
    const ev = evaluateBudget(plan, state.transactions, { categories: state.categories });
    $('#alerts').innerHTML = ev.alerts
      .filter((a) => a.level !== 'info')
      .slice(0, 3)
      .map((a) => `<div class="alert ${a.level}"><span class="icon" aria-hidden="true">!</span><span>${esc(a.text)}</span></div>`)
      .join('');
  }
}

$('#import').addEventListener('click', async () => {
  const { transactions, failed } = parseMessages($('#paste').value);
  if (!transactions.length) {
    $('#msg').textContent = 'No M-Pesa transactions found in that text.';
    return;
  }
  const state = await loadState();
  const { added, duplicates } = addTransactions(state, transactions);
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

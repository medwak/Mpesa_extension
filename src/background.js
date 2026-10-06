// Service worker: a right-click menu so M-Pesa messages selected on any web
// page (for example Messages for Web) can be imported in one step, and a
// periodic Daraja sync for business accounts that have a relay set up.

import { loadState, saveState, importTransactions, addTransactions } from './lib/store.js';
import { parseMessages } from './lib/parser.js';
import { fetchNewPayments } from './lib/daraja.js';
import { ALL_LINES, PERSONAL } from './lib/wallets.js';

const MENU_ID = 'mpesa-import-selection';
const SYNC_ALARM = 'daraja-sync';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Import selection into M-Pesa Ledger',
    contexts: ['selection'],
  });
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 15 });
});

chrome.runtime.onStartup.addListener(() => chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 15 }));

function badge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 6000);
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_ID || !info.selectionText) return;
  const { transactions } = parseMessages(info.selectionText);
  if (!transactions.length) {
    badge('0', '#d03b3b');
    return;
  }
  const state = await loadState();
  const target = state.settings.currentWallet === ALL_LINES ? PERSONAL : state.settings.currentWallet;
  const { added } = importTransactions(state, transactions, target);
  await saveState(state);
  badge(`+${added}`, '#0d8a3a');
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SYNC_ALARM) return;
  const state = await loadState();
  let total = 0;
  for (const w of state.wallets) {
    if (!w.relayUrl || !w.relayToken) continue;
    try {
      const { transactions, cursor } = await fetchNewPayments(w);
      total += addTransactions(state, transactions, w.id).added;
      Object.assign(w, { lastSyncCursor: cursor, lastSyncAt: new Date().toISOString(), lastSyncError: null });
    } catch (err) {
      w.lastSyncError = err.message;
    }
  }
  await saveState(state);
  if (total) badge(`+${total}`, '#0d8a3a');
});

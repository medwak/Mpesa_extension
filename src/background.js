// Service worker: adds a right-click menu so M-Pesa messages selected on any
// web page (for example Messages for Web) can be imported in one step.

import { loadState, saveState, addTransactions } from './lib/store.js';
import { parseMessages } from './lib/parser.js';

const MENU_ID = 'mpesa-import-selection';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Import selection into M-Pesa Ledger',
    contexts: ['selection'],
  });
});

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
  const { added } = addTransactions(state, transactions);
  await saveState(state);
  badge(`+${added}`, '#0d8a3a');
});

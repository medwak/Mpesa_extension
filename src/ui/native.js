// Android app features (Capacitor). Loaded only inside the APK, never in the
// browser extension or the web app. Each feature talks to one Capacitor
// plugin, so more native features can be added the same way later.

import { Capacitor, registerPlugin } from '../../vendor/capacitor/core.js';
import { planNotifications, budgetNotifications, DEFAULT_NOTIFICATION_SETTINGS } from '../lib/reminders.js';

const LocalNotifications = registerPlugin('LocalNotifications');
const App = registerPlugin('App');
const Filesystem = registerPlugin('Filesystem');
const Share = registerPlugin('Share');
const ShareInbox = registerPlugin('ShareInbox'); // android/app/.../ShareInboxPlugin.java
const Printer = registerPlugin('Printer'); // android/app/.../PrinterPlugin.java

export const isNativeApp = () => Capacitor.isNativePlatform();

function localNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function notificationSettings(state) {
  return { ...DEFAULT_NOTIFICATION_SETTINGS, ...(state.settings.notifications || {}) };
}

export async function notificationPermission() {
  try {
    return (await LocalNotifications.checkPermissions()).display; // granted | denied | prompt
  } catch {
    return 'unavailable';
  }
}

export async function askNotificationPermission() {
  return (await LocalNotifications.requestPermissions()).display;
}

// Replaces every reminder this app scheduled with a fresh plan, and shows any
// new budget warnings. Called on start, on resume and after data changes.
export async function refreshNotifications(state, persist) {
  if ((await notificationPermission()) !== 'granted') return;
  const settings = notificationSettings(state);
  const pending = await LocalNotifications.getPending();
  if (pending.notifications?.length) await LocalNotifications.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });

  const now = localNow();
  const toNative = (n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    extra: n.extra,
    smallIcon: 'ic_stat_ledger',
    schedule: n.on ? { on: n.on, allowWhileIdle: true } : { at: new Date(n.at).toISOString(), allowWhileIdle: true },
  });
  const plan = planNotifications(state, now, settings).map(toNative);
  if (plan.length) await LocalNotifications.schedule({ notifications: plan });

  const month = now.slice(0, 7);
  const sent = new Set((state.settings.notifiedBudget || []).filter((k) => k.includes(`|${month}|`)));
  const warnings = budgetNotifications(state, now.slice(0, 10), sent, settings);
  if (warnings.length) {
    const soon = new Date(Date.now() + 1500).toISOString();
    await LocalNotifications.schedule({
      notifications: warnings.map((w) => ({ id: w.id, title: w.title, body: w.body, extra: w.extra, smallIcon: 'ic_stat_ledger', schedule: { at: soon, allowWhileIdle: true } })),
    });
    state.settings.notifiedBudget = [...sent, ...warnings.map((w) => w.key)];
    await persist();
  }
}

export async function sendTestNotification() {
  await LocalNotifications.schedule({
    notifications: [{
      id: 99,
      title: 'M-Pesa Ledger notifications are on',
      body: 'You will get bill, budget and weekly import reminders here.',
      smallIcon: 'ic_stat_ledger',
      extra: { tab: 'settings' },
      schedule: { at: new Date(Date.now() + 2000).toISOString(), allowWhileIdle: true },
    }],
  });
}

// Android WebViews cannot download files, so files are written to the app's
// cache and handed to the Share sheet (save to Files or Drive, send by email…).
export async function saveFile(name, content) {
  const { uri } = await Filesystem.writeFile({ path: name, data: content, directory: 'CACHE', encoding: 'utf8' });
  await Share.share({ title: name, files: [uri], dialogTitle: 'Save or send' });
}

export async function printPage(name) {
  await Printer.print({ name });
}

// app: { importSharedText(text), showTab(name), currentTab(), switchWallet(id),
//        reload(), getState(), persist() }
export function initNative(app) {
  document.documentElement.classList.add('native-app');

  // Messages shared to the app from the Messages app.
  const checkShare = async () => {
    try {
      const { text } = await ShareInbox.take();
      if (text) await app.importSharedText(text);
    } catch {
      /* plugin missing in an older build */
    }
  };
  window.mpesaCheckShare = checkShare;
  checkShare();

  LocalNotifications.addListener('localNotificationActionPerformed', async ({ notification }) => {
    const extra = notification?.extra || {};
    if (extra.wallet && app.getState().wallets.some((w) => w.id === extra.wallet)) await app.switchWallet(extra.wallet);
    if (extra.tab) app.showTab(extra.tab);
  });

  App.addListener('appStateChange', async ({ isActive }) => {
    if (!isActive) return;
    await app.reload();
    checkShare();
    refreshNotifications(app.getState(), app.persist).catch(() => {});
  });

  // Back goes to the overview first, then leaves the app.
  App.addListener('backButton', () => {
    if (app.currentTab() !== 'overview') app.showTab('overview');
    else App.exitApp();
  });

  // Ask once for notification permission on first start.
  (async () => {
    const state = app.getState();
    if (!state.settings.askedNotifications && (await notificationPermission()) === 'prompt') {
      state.settings.askedNotifications = true;
      await app.persist();
      await askNotificationPermission();
    }
    await refreshNotifications(app.getState(), app.persist);
  })().catch(() => {});
}

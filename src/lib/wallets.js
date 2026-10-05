// Accounts ("wallets"): your personal M-Pesa plus any Till, Paybill or
// Pochi la Biashara you own. Each keeps its own transactions and budgets.

export const PERSONAL = 'personal';

export const WALLET_KINDS = {
  personal: 'Personal M-Pesa',
  till: 'Till (Buy Goods)',
  paybill: 'Paybill',
  pochi: 'Pochi la Biashara',
};

export const DEFAULT_WALLETS = [{ id: PERSONAL, name: 'Personal M-Pesa', kind: 'personal' }];

// Transaction types that only appear on a business account.
export const BUSINESS_TYPES = new Set(['business_received', 'settlement', 'payout']);

export function walletOf(tx) {
  return tx.wallet || PERSONAL;
}

export function walletTxs(state, walletId) {
  return state.transactions.filter((t) => walletOf(t) === walletId);
}

export function getWallet(state, walletId) {
  return state.wallets.find((w) => w.id === walletId) || state.wallets[0];
}

export function businessWallets(state) {
  return state.wallets.filter((w) => w.kind !== 'personal');
}

// Personal budgets keep their original location for backwards compatibility.
export function budgetsFor(state, walletId) {
  if (walletId === PERSONAL) return state.budgets;
  state.walletBudgets ||= {};
  return (state.walletBudgets[walletId] ||= {});
}

export function addWallet(state, { name, kind, shortcode }) {
  const code = String(shortcode || '').replace(/\D/g, '');
  const base = `biz-${code || Date.now().toString(36)}`;
  let id = base;
  for (let n = 2; state.wallets.some((w) => w.id === id); n++) id = `${base}-${n}`;
  const wallet = { id, name: name.trim() || WALLET_KINDS[kind], kind, shortcode: code };
  state.wallets.push(wallet);
  return wallet;
}

export function removeWallet(state, walletId) {
  if (walletId === PERSONAL) return;
  state.wallets = state.wallets.filter((w) => w.id !== walletId);
  state.transactions = state.transactions.filter((t) => walletOf(t) !== walletId);
  if (state.walletBudgets) delete state.walletBudgets[walletId];
  state.bills = (state.bills || []).filter((b) => (b.wallet || PERSONAL) !== walletId);
  state.statements = (state.statements || []).filter((s) => (s.wallet || PERSONAL) !== walletId);
  if (state.settings?.currentWallet === walletId) state.settings.currentWallet = PERSONAL;
}

export function walletLabel(w) {
  if (!w || w.kind === 'personal') return w?.name || 'Personal M-Pesa';
  const kind = { till: 'Till', paybill: 'Paybill', pochi: 'Pochi' }[w.kind] || 'Business';
  return `${w.name}${w.shortcode ? ` · ${kind} ${w.shortcode}` : ` · ${kind}`}`;
}

// Automatic sync for a business Till/Paybill through Safaricom's Daraja API.
// Daraja posts each customer payment (C2B confirmation) to a server; the
// small relay in relay/worker.js receives and stores them, and the app
// downloads new ones from it. The relay URL and token are set per account.

// Daraja TransTime is "YYYYMMDDHHmmss" in Kenyan time.
export function darajaTime(t) {
  const s = String(t || '');
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : null;
}

export function c2bToTransaction(p) {
  const amount = Math.round(Number(p.TransAmount) * 100);
  const date = darajaTime(p.TransTime);
  if (!p.TransID || !amount || !date) return null;
  const name = [p.FirstName, p.MiddleName, p.LastName].filter((x) => x && String(x).trim()).join(' ').trim();
  return {
    id: p.TransID,
    code: p.TransID,
    date,
    type: 'business_received',
    direction: 'in',
    amount,
    fee: 0,
    counterparty: name || 'Customer',
    phone: p.MSISDN ? String(p.MSISDN) : '',
    account: p.BillRefNumber ? String(p.BillRefNumber).trim() : '',
    shortcode: p.BusinessShortCode ? String(p.BusinessShortCode) : '',
    // Daraja only reports incoming payments, so its running balance would
    // look "unreconciled" next to settlements; keep it as a note instead.
    balance: null,
    note: p.OrgAccountBalance ? `Org balance after payment: Ksh ${p.OrgAccountBalance}` : '',
    source: 'daraja',
  };
}

function relayBase(wallet) {
  if (!wallet.relayUrl) throw new Error('Set the relay URL for this account first.');
  return wallet.relayUrl.replace(/\/+$/, '');
}

async function relayFetch(wallet, path, init = {}, fetchImpl = fetch) {
  const res = await fetchImpl(`${relayBase(wallet)}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${wallet.relayToken || ''}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('The relay rejected the sync token. Check it matches SYNC_TOKEN on the relay.');
  if (!res.ok) throw new Error(body.error || `Relay error ${res.status}`);
  return body;
}

// Downloads payments received since the last sync. Returns the converted
// transactions and the new sync cursor; the caller imports and saves.
export async function fetchNewPayments(wallet, fetchImpl = fetch) {
  const since = wallet.lastSyncCursor ? `?since=${encodeURIComponent(wallet.lastSyncCursor)}` : '';
  const body = await relayFetch(wallet, `/transactions${since}`, {}, fetchImpl);
  const items = Array.isArray(body.items) ? body.items : [];
  const txs = [];
  for (const it of items) {
    if (wallet.shortcode && it.BusinessShortCode && String(it.BusinessShortCode) !== String(wallet.shortcode)) continue;
    const tx = c2bToTransaction(it);
    if (tx) txs.push(tx);
  }
  return { transactions: txs, cursor: body.cursor || wallet.lastSyncCursor || null };
}

export async function registerUrls(wallet, fetchImpl = fetch) {
  return relayFetch(wallet, '/setup/register', { method: 'POST', body: '{}' }, fetchImpl);
}

export async function relayHealth(wallet, fetchImpl = fetch) {
  return relayFetch(wallet, '/health', {}, fetchImpl);
}

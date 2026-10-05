// M-Pesa Ledger relay: a Cloudflare Worker that receives Daraja C2B payment
// confirmations for your Till/Paybill and lets the app download them.
//
// Routes
//   POST /c2b/<HOOK_SECRET>/confirmation   Daraja posts each payment here
//   POST /c2b/<HOOK_SECRET>/validation     Daraja validation (always accepts)
//   GET  /transactions?since=<cursor>      app download (Bearer SYNC_TOKEN)
//   POST /setup/register                   registers the URLs above with Daraja
//   GET  /health                           check the relay and its settings
//
// Bindings (see wrangler.toml and relay/README.md)
//   MPESA_TX            KV namespace
//   SYNC_TOKEN          secret shared with the app
//   HOOK_SECRET         secret part of the callback URL (Daraja does not sign callbacks)
//   DARAJA_CONSUMER_KEY, DARAJA_CONSUMER_SECRET   from your Daraja app
//   SHORTCODE           your Paybill, or the shortcode Safaricom gave for your Till
//   DARAJA_ENV          "sandbox" or "production"

const KEEP_SECONDS = 60 * 60 * 24 * 90; // payments are kept 90 days
const FIELDS = ['TransactionType', 'TransID', 'TransTime', 'TransAmount', 'BusinessShortCode', 'BillRefNumber', 'InvoiceNumber', 'OrgAccountBalance', 'ThirdPartyTransID', 'MSISDN', 'FirstName', 'MiddleName', 'LastName'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function authorized(request, env) {
  const h = request.headers.get('Authorization') || '';
  return safeEqual(h.replace(/^Bearer\s+/i, ''), env.SYNC_TOKEN);
}

function darajaBase(env) {
  return env.DARAJA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
}

async function handleCallback(request, env, kind) {
  if (kind === 'validation') return json({ ResultCode: '0', ResultDesc: 'Accepted' });
  let p;
  try {
    p = await request.json();
  } catch {
    return json({ ResultCode: 'C2B00016', ResultDesc: 'Rejected' }, 400);
  }
  if (!p || !p.TransID) return json({ ResultCode: 'C2B00016', ResultDesc: 'Rejected' }, 400);
  const record = {};
  for (const f of FIELDS) if (p[f] != null) record[f] = String(p[f]).slice(0, 100);
  record.receivedAt = new Date().toISOString();
  // Keys sort by arrival time, so the app can ask for "everything after X".
  // The record lives in the key's metadata so one list call returns it all.
  await env.MPESA_TX.put(`tx:${record.receivedAt}:${record.TransID}`, '', { metadata: record, expirationTtl: KEEP_SECONDS });
  return json({ ResultCode: 0, ResultDesc: 'Accepted' });
}

async function listTransactions(env, since) {
  const after = since ? `tx:${since}` : '';
  const items = [];
  let cursor;
  let lastKey = since || null;
  do {
    const page = await env.MPESA_TX.list({ prefix: 'tx:', cursor });
    for (const k of page.keys) {
      if (after && k.name <= after) continue;
      if (k.metadata) items.push(k.metadata);
      lastKey = k.name.slice(3);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && items.length < 5000);
  return { items, cursor: lastKey };
}

async function register(env, origin) {
  for (const k of ['DARAJA_CONSUMER_KEY', 'DARAJA_CONSUMER_SECRET', 'SHORTCODE', 'HOOK_SECRET']) {
    if (!env[k]) return json({ error: `Relay is missing the ${k} setting.` }, 400);
  }
  const base = darajaBase(env);
  const basic = btoa(`${env.DARAJA_CONSUMER_KEY}:${env.DARAJA_CONSUMER_SECRET}`);
  const tokenRes = await fetch(`${base}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${basic}` } });
  const token = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !token.access_token) return json({ error: 'Daraja rejected the consumer key/secret.', daraja: token }, 502);
  const body = {
    ShortCode: String(env.SHORTCODE),
    ResponseType: 'Completed',
    ConfirmationURL: `${origin}/c2b/${env.HOOK_SECRET}/confirmation`,
    ValidationURL: `${origin}/c2b/${env.HOOK_SECRET}/validation`,
  };
  const regRes = await fetch(`${base}/mpesa/c2b/v2/registerurl`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const reg = await regRes.json().catch(() => ({}));
  if (!regRes.ok) return json({ error: reg.errorMessage || 'Daraja refused the URL registration.', daraja: reg }, 502);
  return json({ ok: true, environment: env.DARAJA_ENV || 'sandbox', shortcode: body.ShortCode, daraja: reg });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const cb = url.pathname.match(/^\/c2b\/([^/]+)\/(confirmation|validation)$/);
    if (cb) {
      if (request.method !== 'POST' || !safeEqual(cb[1], env.HOOK_SECRET)) return new Response('Not found', { status: 404 });
      return handleCallback(request, env, cb[2]);
    }

    if (['/transactions', '/setup/register', '/health'].includes(url.pathname)) {
      if (!authorized(request, env)) return json({ error: 'Unauthorized' }, 401);
      if (url.pathname === '/health') {
        return json({ ok: true, environment: env.DARAJA_ENV || 'sandbox', shortcode: env.SHORTCODE || null, darajaKeysSet: Boolean(env.DARAJA_CONSUMER_KEY && env.DARAJA_CONSUMER_SECRET) });
      }
      if (url.pathname === '/transactions' && request.method === 'GET') return json(await listTransactions(env, url.searchParams.get('since')));
      if (url.pathname === '/setup/register' && request.method === 'POST') return register(env, url.origin);
      return json({ error: 'Method not allowed' }, 405);
    }
    return new Response('M-Pesa Ledger relay', { status: 200, headers: CORS });
  },
};

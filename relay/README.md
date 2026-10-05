# Daraja relay (automatic Till/Paybill sync)

Safaricom's Daraja API reports each customer payment to your Till or Paybill by sending it to a web address on a server. It cannot send to a phone or browser. This relay is that server. It is a small Cloudflare Worker (free plan is enough) that:

1. receives each payment confirmation from Safaricom,
2. keeps it for 90 days, and
3. hands new payments to M-Pesa Ledger whenever the app syncs. The desktop extension syncs every 15 minutes in the background; the dashboard and phone app sync when opened and every 5 minutes while open.

Only payments *into* your Till/Paybill (C2B) are reported by Daraja. Settlements to your bank, charges and payouts are not included; import your M-PESA Org Portal statement for those.

## What you need

- A Daraja account at https://developer.safaricom.co.ke and an app there (it gives you a **Consumer Key** and **Consumer Secret**).
- A free Cloudflare account (https://dash.cloudflare.com/sign-up).
- Node.js 18 or newer on your computer.

Start in **sandbox** (Safaricom's test system, with a test shortcode) and switch to **production** once it works. Going live is done from the Daraja portal ("Go Live") and needs your Till/Paybill's M-PESA business administrator details; Safaricom approves it.

## Set up (about 15 minutes)

Run these from this `relay` folder.

```bash
npx wrangler login                                # opens Cloudflare in your browser
npx wrangler kv namespace create MPESA_TX         # copy the id it prints into wrangler.toml
```

Edit `wrangler.toml`:

- `id` under `[[kv_namespaces]]`: the id from the previous step.
- `SHORTCODE`: your Paybill number, or the shortcode Safaricom uses for your Till. For Buy Goods tills this is often the store/head-office number rather than the till number printed for customers; check your Daraja app or ask Safaricom API support if registration fails. In sandbox, use the test shortcode shown in your Daraja app.
- `DARAJA_ENV`: `sandbox` now, `production` later.

Add the secrets. Each command asks you to paste the value:

```bash
npx wrangler secret put SYNC_TOKEN               # make up a long random password; you will paste it into the app
npx wrangler secret put HOOK_SECRET              # another long random string (letters and digits only)
npx wrangler secret put DARAJA_CONSUMER_KEY
npx wrangler secret put DARAJA_CONSUMER_SECRET
npx wrangler deploy                               # prints your relay URL, e.g. https://ledger-relay.<you>.workers.dev
```

A quick way to make the two random strings: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.

## Connect the app

1. In M-Pesa Ledger open **Settings → Accounts**, add your Till/Paybill (if you have not yet) and open **Automatic sync with Safaricom Daraja**.
2. Paste the relay URL and the `SYNC_TOKEN`, then **Save**.
3. **Test connection**: it should show the environment and shortcode.
4. **Register with Safaricom**: this tells Daraja to send payments for your shortcode to the relay. Do it again whenever you switch from sandbox to production.
5. Make a test payment (in sandbox, use the C2B simulator in the Daraja portal), then **Sync now**.

## Notes

- **Security.** Daraja does not sign its callbacks, so the callback address contains `HOOK_SECRET`; keep it private. The app uses `SYNC_TOKEN` to download payments. Anyone with the relay URL but without these secrets gets nothing.
- **Privacy.** Payments are stored in your own Cloudflare account and deleted after 90 days. Safaricom masks customer phone numbers in these notifications, so you see names and masked numbers.
- **Several Tills/Paybills.** Deploy one relay per shortcode (change `name` in `wrangler.toml` for each), and set each account's relay separately in the app.
- **Daraja changes.** Safaricom occasionally changes API versions and rules (for example, callback URLs must be public `https` addresses and may not contain words like "mpesa" or "safaricom"). If registration fails, the app shows Safaricom's error message.

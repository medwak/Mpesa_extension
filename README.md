# M-Pesa Ledger

A desktop browser extension (Chrome, Edge, Brave and other Chromium browsers) and an installable phone app, built from the same code. It turns your M-Pesa transactions into:

- **Accounting.** Every transaction is categorized automatically. You get income, expenses, net savings and transaction costs per month, plus your top payees and sources of money.
- **Your uploaded statements.** Every PDF or CSV statement you upload is kept as its own entry, showing its period, number of transactions and opening/closing balances. Delete any of them at any time: its transactions go too, except ones also in another statement or that came from SMS or manual entries. Tick several to combine them into one statement (consecutive months or whole years). Overlapping statements are counted once, and you are warned about any period none of them covers.
- **M-Pesa statements.** Generate a statement for any period, with opening and closing balances, a running balance, a summary by transaction type and an income & expenditure table. Print it, save it as PDF or download it as CSV. The statement also checks every balance against the balance in your messages and tells you when a transaction is missing.
- **Bills, Paybills and Tills.** A directory of every Paybill and Till you have paid, with each one's payment history. Track regular bills (rent, KPLC, water, internet) with a usual amount and due day, see whether each is paid this month, and get reminders when one is due or overdue. Regular bills are suggested automatically.
- **Business accounts.** Add the Till, Paybill or Pochi la Biashara you own as a separate account, so business money never mixes with personal money. It shows collections, today's takings, top customers and collections per account number, with its own statements and budgets. Payments can sync automatically through Safaricom's Daraja API.
- **Budget planning.** Set expected income, a savings goal and monthly limits per category. Track progress with "on track", "spending fast", "almost used up" and "over budget" warnings, with a daily allowance for the rest of the month. You can start a new month from last month's plan or from last month's actual spending.

All data stays in your browser (`chrome.storage.local`). Nothing is sent to any server.

## How it connects to your M-Pesa

Safaricom does not offer a public API for personal M-Pesa accounts. The Daraja API is only for registered businesses (Paybill/Till), and it needs a public server for callbacks. So the extension reads the records you already receive:

| Source | How |
|---|---|
| **SMS confirmations** | Copy your M-PESA messages and paste them into the popup or the **Import** tab. Paste a whole thread at once; duplicates are skipped. |
| **Messages for Web** | Open your SMS in the browser (e.g. Google Messages for web), select the M-Pesa messages, right-click and choose **Import selection into M-Pesa Ledger**. |
| **Full statement (PDF)** | Request a statement in the M-PESA app or with `*334#` → My Account → M-PESA Statement. Upload the PDF Safaricom emails you in the **Import** tab and type the password from the SMS. The "Detailed Statement" table is read directly, wrapped cells included, and charge rows are merged into their transactions as fees. |
| **Statement CSV** | CSV files with the statement columns (`Receipt No., Completion Time, Details, Transaction Status, Paid In, Withdrawn, Balance`) also work, comma, semicolon or tab separated, including other column names (e.g. Transaction ID, Date, Description, Money In, Money Out). |
| **Manual entries** | Add cash spending or a missing message in the **Transactions** tab. |

Supported message types: received money, send money, Pay Bill, Buy Goods (Till), agent withdrawal, agent deposit, airtime, M-Shwari / Lock Savings transfers, Fuliza draw-downs and repayments, and reversals.

## Install (developer mode)

1. Download or clone this repository.
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Pin **M-Pesa Ledger** to the toolbar. Click it for this month's numbers and quick paste. Click **Open dashboard** for everything else.

To try it without real data, go to **Settings → Load demo data**, or import the files in `samples/`: paste `sample-sms.txt` into the SMS box, or upload `sample-statement.csv` or `sample-statement-password-123456.pdf` (password `123456`). All names and numbers in them are fictional.

## Phone app (Android and iPhone)

The same dashboard also works as an installable web app on your phone. It works offline, and your data stays on the phone.

**Share straight from Messages (Android):** long-press an M-Pesa SMS (or select several), tap **Share** and choose **M-Pesa Ledger**. The message is imported immediately and duplicates are skipped. On iPhone, copy the message and use **Paste from clipboard** on the Import tab.

### Put it online (needed once)

A phone can only install the app from a secure (https) web address. Two free options:

- **GitHub Pages:** the workflow in `.github/workflows/pages.yml` publishes the app whenever `main` changes. Enable it once in the repository under *Settings → Pages → Source: GitHub Actions*. The app is then at `https://<your-user>.github.io/<repo>/`.
- **Netlify Drop (no account setup):** go to https://app.netlify.com/drop and drag this whole folder onto the page. You get an https address in seconds.

### Install it

1. Open the address in **Chrome on Android** and tap **⋮ → Add to Home screen / Install app** (or **Settings → Install app on this device** inside the app).
2. On **iPhone**, open it in Safari and tap **Share → Add to Home Screen**. iPhone does not offer the Share-to-app shortcut, so use Paste from clipboard.

The phone app and the desktop extension each keep their own data. Move data between them with **Settings → Download backup** and **Restore backup**.

## Business accounts (your own Till or Paybill)

Open **Settings → Accounts** and add your Till, Paybill or Pochi la Biashara. An account menu then appears at the top of the dashboard; every tab (overview, transactions, statements, bills, budget) shows the selected account only.

Ways to get business payments in:

- **Payment SMS** sent to the business phone ("Ksh500.00 received from JOHN DOE… New Account balance is…"). Paste or share them like personal messages. If you import them while your personal account is selected, they are moved to your business account automatically (when you have exactly one).
- **M-PESA Org Portal statement** (CSV). Columns such as Reason Type, Other Party Info and A/C No. are read, so customer names, account numbers, settlements to bank and payouts are recognised.
- **Automatic sync through Daraja.** Set up the free relay in [`relay/`](relay/README.md) and paste its address and token into the account's settings. New customer payments then arrive on their own.

## How the accounting works

- Amounts are stored as integer cents, so totals never drift.
- Each category has a kind:
  - **income**: salary, money received.
  - **expense**: groceries, rent, transaction costs.
  - **transfer**: moves between your own money, such as M-Shwari savings, Fuliza draw-downs and repayments, and cash deposits. Transfers are left out of income and expenses so savings don't look like spending.
- Transaction costs are booked separately in the **Transaction costs** category, so you can see what M-Pesa charges you.
- Auto-categorization rules ("payee contains NAIVAS → Groceries") are editable in **Settings**. When you change a transaction's category, you can make that a rule for the same payee.

## Project layout

```
manifest.json            Extension manifest (MV3)
src/background.js        Right-click "import selection" menu
src/lib/parser.js        M-Pesa SMS parser
src/lib/statements.js    Uploaded statements: keep, delete and combine
src/lib/csv.js           CSV import (Safaricom statement + own format) and export
src/lib/pdf.js           Safaricom PDF statement reader (uses pdf.js)
vendor/pdfjs/            pdf.js 4.10.38 by Mozilla (Apache-2.0), bundled unmodified
src/lib/categories.js    Default categories and auto-categorization rules
src/lib/ledger.js        Summaries, trends, statement builder and reconciliation
src/lib/budget.js        Budget plans, progress and alerts
src/lib/bills.js         Paybill/Till directory, saved bills, reminders and suggestions
src/lib/wallets.js       Personal and business accounts
src/lib/daraja.js        Daraja C2B sync with the relay
relay/                   Cloudflare Worker that receives Daraja payments (see relay/README.md)
src/lib/store.js         Storage (chrome.storage, localStorage fallback)
src/ui/                  Popup and dashboard (the dashboard is also the phone app)
manifest.webmanifest     Phone app manifest (install + Share target)
sw.js                    Phone app offline cache
index.html               Phone app entry page
tests/                   Unit tests (node --test)
```

## Development

There is no build step. The only third-party code is pdf.js, bundled in `vendor/pdfjs/` because extensions cannot load remote code. Run the tests with Node 18+:

```
npm test
```

You can also open `src/ui/dashboard.html` from any static web server; outside the extension it saves to `localStorage`.

## Privacy

The extension asks only for `storage`, `unlimitedStorage`, `contextMenus` and `alarms` (for the background Daraja sync). It has no host permissions and runs no remote code. Its only network requests go to a Daraja relay you set up yourself for a business account; without one it makes no network requests at all. Use **Settings → Download backup** to keep a copy of your data. Clearing browser data or removing the extension deletes it.

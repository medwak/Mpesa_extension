// Generates a few months of realistic, fictional transactions so the
// dashboard can be explored before importing real data.

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Approximate Safaricom send-money tariff (Ksh).
function sendFee(ksh) {
  if (ksh <= 100) return 0;
  if (ksh <= 500) return 7;
  if (ksh <= 1000) return 13;
  if (ksh <= 1500) return 23;
  if (ksh <= 2500) return 33;
  if (ksh <= 3500) return 53;
  if (ksh <= 5000) return 57;
  if (ksh <= 7500) return 78;
  return 105;
}
function withdrawFee(ksh) {
  if (ksh <= 2500) return 29;
  if (ksh <= 5000) return 69;
  if (ksh <= 10000) return 115;
  return 185;
}

export function demoTransactions(today = new Date(), months = 4) {
  const rand = rng(42);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const events = [];
  const add = (date, e) => events.push({ date, ...e });
  const pad = (n) => String(n).padStart(2, '0');
  const at = (y, m, d, h, mi) => `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(mi)}`;

  const end = today.toISOString().slice(0, 10);
  for (let k = months - 1; k >= 0; k--) {
    const ref = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - k, 1));
    const y = ref.getUTCFullYear();
    const m = ref.getUTCMonth() + 1;
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();

    add(at(y, m, 1, 9, 5), { type: 'received', direction: 'in', amount: 95000, counterparty: 'ACME LIMITED', phone: '0711000222' });
    add(at(y, m, 2, 10, 12), { type: 'paybill', direction: 'out', amount: 25000, counterparty: 'HOMEPRIDE RENTALS', account: 'HSE-12B' });
    add(at(y, m, 3, 8, 40), { type: 'paybill', direction: 'out', amount: 2000 + Math.round(rand() * 1000), counterparty: 'KPLC PREPAID', account: '54321098765' });
    add(at(y, m, 5, 19, 2), { type: 'paybill', direction: 'out', amount: 2999, counterparty: 'ZUKU', account: '889900' });
    add(at(y, m, 6, 20, 15), { type: 'savings_out', direction: 'out', amount: 10000, counterparty: 'M-Shwari' });
    add(at(y, m, 7, 12, 0), { type: 'sent', direction: 'out', amount: 5000, counterparty: 'MARY ATIENO', phone: '0722333444' });
    add(at(y, m, 15, 11, 30), { type: 'paybill', direction: 'out', amount: 1000, counterparty: 'NAIROBI WATER', account: 'ACC778' });
    if (rand() > 0.5) add(at(y, m, 18, 17, 45), { type: 'received', direction: 'in', amount: 3000 + Math.round(rand() * 6000), counterparty: 'PETER KAMAU', phone: '0733555666' });

    for (let d = 1; d <= days; d++) {
      if (`${y}-${pad(m)}-${pad(d)}` > end) break;
      if (d % 4 === 0) add(at(y, m, d, 18, 20), { type: 'buygoods', direction: 'out', amount: 800 + Math.round(rand() * 3200), counterparty: pick(['NAIVAS SUPERMARKET', 'QUICKMART', 'CARREFOUR JUNCTION']) });
      if (rand() < 0.45) add(at(y, m, d, 7, 50), { type: 'buygoods', direction: 'out', amount: 150 + Math.round(rand() * 450), counterparty: pick(['BOLT', 'UBER', 'SHELL WESTLANDS']) });
      if (rand() < 0.3) add(at(y, m, d, 13, 10), { type: 'buygoods', direction: 'out', amount: 300 + Math.round(rand() * 900), counterparty: pick(['JAVA HOUSE', 'KFC', 'MAMA OLIECH']) });
      if (d % 7 === 1) add(at(y, m, d, 7, 30), { type: 'airtime', direction: 'out', amount: pick([100, 200, 250]), counterparty: 'Safaricom Airtime' });
      if (d % 10 === 5) add(at(y, m, d, 16, 0), { type: 'withdraw', direction: 'out', amount: pick([1000, 2000, 3000]), counterparty: '123456 - CITY AGENT CBD' });
      if (rand() < 0.06) add(at(y, m, d, 21, 0), { type: 'buygoods', direction: 'out', amount: 500 + Math.round(rand() * 1500), counterparty: 'CENTURY CINEMAX' });
    }
  }

  events.sort((a, b) => (a.date < b.date ? -1 : 1));
  let balance = 1200000;
  let n = 0;
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return events
    .filter((e) => e.date.slice(0, 10) <= end)
    .map((e) => {
      const amount = e.amount * 100;
      const fee = (e.type === 'sent' ? sendFee(e.amount) : e.type === 'withdraw' ? withdrawFee(e.amount) : 0) * 100;
      balance += e.direction === 'in' ? amount : -(amount + fee);
      n++;
      const code = `TD${letters[n % 24]}${String(100000 + n * 37).slice(-6)}X`.slice(0, 10);
      return { id: code, code, phone: '', account: '', ...e, amount, fee, balance, source: 'demo' };
    });
}

// People you send money to and receive money from, grouped by phone number.
// Statements mask numbers ("0712****678"), SMS usually shows them in full;
// a masked number is merged with the full number it matches.

const PERSON_TYPES = new Set(['received', 'sent', 'business_received']);

// "+254 712 345 678", "254712345678", "712345678" -> "0712345678"
// Masked digits (*) are kept: "2547******78" -> "07******78".
export function normalizePhone(raw) {
  let p = String(raw || '').replace(/[^\d*]/g, '');
  if (!p) return '';
  if (p.startsWith('254') && p.length >= 12) p = `0${p.slice(3)}`;
  else if (/^[17]/.test(p) && p.length === 9) p = `0${p}`;
  return p;
}

export function isMasked(phone) {
  return phone.includes('*');
}

// True when two normalized numbers can be the same line. Masks do not always
// hide exactly as many digits as they replace ("0712****678" vs 0712345678),
// so a masked number matches on its visible start and end.
export function phonesMatch(a, b) {
  if (!a || !b) return false;
  if (!isMasked(a) && !isMasked(b)) return a === b;
  const ends = (m) => [m.slice(0, m.indexOf('*')), m.slice(m.lastIndexOf('*') + 1)];
  if (isMasked(a) && isMasked(b)) {
    const [pa, sa] = ends(a);
    const [pb, sb] = ends(b);
    return (pa.startsWith(pb) || pb.startsWith(pa)) && (sa.endsWith(sb) || sb.endsWith(sa));
  }
  const [m, f] = isMasked(a) ? [a, b] : [b, a];
  const [pre, suf] = ends(m);
  return pre.length + suf.length >= 5 && f.length > pre.length + suf.length && f.startsWith(pre) && f.endsWith(suf);
}

const firstWord = (s) => String(s || '').trim().split(/\s+/)[0]?.toUpperCase() || '';

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

export function peopleDirectory(txs) {
  const groups = new Map();
  const ensure = (key) => {
    if (!groups.has(key)) groups.set(key, { key, txs: [], phones: new Set(), names: [] });
    return groups.get(key);
  };
  const people = txs.filter((t) => PERSON_TYPES.has(t.type) && (t.phone || t.counterparty));

  // 1. Full numbers first, so masked ones have something to match against.
  const full = new Set(people.map((t) => normalizePhone(t.phone)).filter((p) => p && !isMasked(p)));
  const fullFirst = [...people].sort((a, b) => {
    const fa = normalizePhone(a.phone);
    const fb = normalizePhone(b.phone);
    return Number(!fa || isMasked(fa)) - Number(!fb || isMasked(fb));
  });
  for (const t of fullFirst) {
    const phone = normalizePhone(t.phone);
    let key;
    if (phone && !isMasked(phone)) {
      key = `tel:${phone}`;
    } else if (phone) {
      const candidates = [...full].filter((f) => phonesMatch(f, phone));
      const byName = candidates.filter((f) => groups.get(`tel:${f}`)?.names.some((n) => firstWord(n) === firstWord(t.counterparty)));
      const pick = byName.length === 1 ? byName[0] : candidates.length === 1 ? candidates[0] : null;
      key = pick ? `tel:${pick}` : `mask:${phone}|${firstWord(t.counterparty)}`;
    } else {
      key = `name:${String(t.counterparty).trim().toUpperCase()}`;
    }
    const g = ensure(key);
    g.txs.push(t);
    if (phone) g.phones.add(phone);
    if (t.counterparty) g.names.push(t.counterparty.trim());
  }

  return [...groups.values()]
    .map((g) => {
      const history = [...g.txs].sort((a, b) => (a.date < b.date ? 1 : -1));
      const sent = g.txs.filter((t) => t.direction === 'out');
      const received = g.txs.filter((t) => t.direction === 'in');
      const phones = [...g.phones].sort((a, b) => Number(isMasked(a)) - Number(isMasked(b)));
      return {
        key: g.key,
        name: mostCommon(g.names) || phones[0] || 'Unknown',
        names: [...new Set(g.names)],
        phones,
        sentTotal: sent.reduce((s, t) => s + t.amount, 0),
        receivedTotal: received.reduce((s, t) => s + t.amount, 0),
        fees: sent.reduce((s, t) => s + (t.fee || 0), 0),
        sentCount: sent.length,
        receivedCount: received.length,
        count: g.txs.length,
        first: history.at(-1).date,
        last: history[0].date,
        history,
      };
    })
    .map((p) => ({ ...p, net: p.receivedTotal - p.sentTotal }));
}

export function searchPeople(people, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return people;
  const digits = normalizePhone(q);
  return people.filter((p) =>
    p.names.some((n) => n.toLowerCase().includes(q)) ||
    (digits.length >= 3 && p.phones.some((ph) => ph.includes(digits) || ph.replace(/^0/, '').includes(digits.replace(/^0/, '')) || (digits.length === ph.length && phonesMatch(ph, digits)))),
  );
}

export const PEOPLE_SORTS = {
  recent: (a, b) => (a.last < b.last ? 1 : -1),
  sent: (a, b) => b.sentTotal - a.sentTotal,
  received: (a, b) => b.receivedTotal - a.receivedTotal,
  count: (a, b) => b.count - a.count,
  name: (a, b) => a.name.localeCompare(b.name),
};

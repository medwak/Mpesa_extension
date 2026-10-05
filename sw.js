// Service worker for the installable web app (not used by the extension).
// Caches the app so it opens offline; bump VERSION when files change.
const VERSION = 'mpesa-ledger-v4';
const FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './src/lib/bills.js',
  './src/lib/budget.js',
  './src/lib/categories.js',
  './src/lib/csv.js',
  './src/lib/daraja.js',
  './src/lib/demo.js',
  './src/lib/ledger.js',
  './src/lib/money.js',
  './src/lib/parser.js',
  './src/lib/pdf.js',
  './src/lib/statements.js',
  './src/lib/store.js',
  './src/lib/wallets.js',
  './src/ui/dashboard.css',
  './src/ui/dashboard.html',
  './src/ui/dashboard.js',
  './src/ui/theme.css',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs',
  './icons/icon192.png',
  './icons/icon512.png',
  './icons/maskable512.png',
];

// Files are cached one by one so a single missing file cannot stop the
// service worker from installing (which would also block installing the app).
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((c) => Promise.allSettled(FILES.map((f) => c.add(f))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

// Network first so updates arrive quickly; fall back to the cache offline.
// Query strings are ignored so shared links (?text=...) open from cache.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});

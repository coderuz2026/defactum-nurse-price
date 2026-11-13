const CACHE = 'df-nurse-v35';
const SHELL = ['./', 'index.html', 'scan.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-180.png', 'vendor/JsBarcode.all.min.js', 'data/prices.json', 'vendor/fonts/arimo-cyrillic-400-normal.woff2', 'vendor/fonts/arimo-cyrillic-700-normal.woff2', 'vendor/fonts/arimo-latin-400-normal.woff2', 'vendor/fonts/arimo-latin-700-normal.woff2'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Сеть в первую очередь (свежие цены и версия приложения), кэш — если нет интернета
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && (u.origin === location.origin )) { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});

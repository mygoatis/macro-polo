// Macro Polo service worker — offline-first for the app shell.
const CACHE = 'macropolo-v1.40';

self.addEventListener('message', (e) => { if (e.data === 'skip-waiting') self.skipWaiting(); });
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './charts.js',
  './ai.js',
  './food-data.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/mark.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for the app's own files: always serve the latest when online, and
// fall back to cache only when offline. This prevents installed PWAs from getting
// stuck on a stale version. API calls (Anthropic, USDA, Open Food Facts) bypass the SW.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((c) => c || caches.match('./index.html')))
  );
});

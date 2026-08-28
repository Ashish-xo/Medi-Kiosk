// MediKiosk service worker — makes the kiosk installable + loadable offline.
// Strategy:
//  - API calls: never cached (network only) — the app's offline mode handles those
//  - Navigation: network-first, cache '/index.html' for offline reload
//  - Hashed assets (JS/CSS): cache-first — Vite hashes names per build, so no stale cache
const CACHE = 'medi-kiosk-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(['/', '/manifest.webmanifest']))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;
  if (req.url.includes('/api/')) return; // never cache API

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        // remember the kiosk shell for offline reloads (not /doctor)
        if (req.url.endsWith('/') || req.url.endsWith('/index.html')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy));
        }
        return res;
      }).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // static assets: cache-first
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }))
  );
});

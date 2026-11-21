// Jome-Tech service worker: makes the app installable and quick to open on a phone.
//
// What it keeps on the device: only the app's own files (CSS, scripts, fonts, icons). Those are
// requested as "…?v=<version>", so each deploy fetches fresh copies and the old cache is dropped.
// Pages are never stored: they hold customer and money details and must always be current.
// With no connection, a page request gets a short "You're offline" page instead of the browser's error.

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `jometech-${VERSION}`;
const PRECACHE = ['/img/brand/icon-192.png', '/img/brand/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('jometech-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline · Jome-Tech</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#101828;background:#f5f6f8;text-align:center;padding:1rem}
h1{font-size:1.25rem;margin:.75rem 0 .25rem}p{color:#475467;margin:0 0 1rem}button{font:inherit;font-weight:600;color:#fff;background:#0b1a5c;border:0;border-radius:8px;padding:.6rem 1.2rem}</style></head>
<body><div><img src="/img/brand/icon-192.png" width="64" height="64" alt=""><h1>You’re offline</h1><p>Jome-Tech needs a connection. Check the Wi-Fi or mobile data, then try again.</p>
<button onclick="location.reload()">Try again</button></div></body></html>`;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Pages: always from the server; offline page when there is no connection.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
    return;
  }

  // The app's own files: from the device first, then the network (and kept for next time).
  if (/^\/(css|js|vendor|img)\//.test(url.pathname) || url.pathname === '/manifest.webmanifest') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && (url.searchParams.has('v') || /\.(woff2?|png|svg)$/.test(url.pathname))) cache.put(req, res.clone());
      return res;
    })());
  }
  // Everything else (photos, signatures, API answers): straight to the server, as without a service worker.
});

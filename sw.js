const APP_CACHE = 'luxtrail-app-v24';
const TILE_CACHE = 'luxtrail-tiles-v1';

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './src/app.js',
  './src/db.js',
  './src/gpx.js',
  './src/export.js',
  './src/geo.js',
  './src/tiles.js',
  './src/gps.js',
  './src/recorder.js',
  './src/geocode.js',
  './src/poi.js',
  './src/map.js',
  './src/ui.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/fflate@0.8.3/esm/browser.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== APP_CACHE && k !== TILE_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isAppShellAsset = isSameOrigin || req.url.includes('unpkg.com/leaflet');

  if (req.url.includes('nominatim.openstreetmap.org')) {
    // Place search: never cache, always hit the network so it fails cleanly offline
    event.respondWith(fetch(req));
    return;
  }

  if (isAppShellAsset) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req)
          .then((res) => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(APP_CACHE).then((c) => c.put(req, clone));
            }
            return res;
          })
          .catch(() => cached);
      })
    );
    return;
  }

  // Anything else cross-origin: treat as map tile / provider asset. Cache-first, offline-safe.
  event.respondWith(
    caches.open(TILE_CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch (err) {
        return cached || Response.error();
      }
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'PRECACHE_TILES') {
    const urls = event.data.urls || [];
    caches.open(TILE_CACHE).then(async (cache) => {
      let done = 0;
      let bytes = 0;
      for (const u of urls) {
        try {
          const existing = await cache.match(u);
          if (existing) {
            const len = existing.headers.get('content-length');
            bytes += len ? parseInt(len, 10) : 0;
          } else {
            const res = await fetch(u);
            if (res.ok) {
              const clone = res.clone();
              await cache.put(u, res);
              const len = clone.headers.get('content-length');
              bytes += len ? parseInt(len, 10) : 0;
            }
          }
        } catch (e) {
          // skip failed tile, keep going
        }
        done++;
        event.source.postMessage({ type: 'PRECACHE_PROGRESS', done, total: urls.length, bytes });
      }
      event.source.postMessage({ type: 'PRECACHE_DONE', total: urls.length, bytes });
    });
  }
});

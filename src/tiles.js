import { db, newId } from './db.js';

export const BUILTIN_SOURCES = [
  {
    id: 'opentopomap',
    name: 'OpenTopoMap',
    urlTemplate: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    subdomains: 'abc',
    maxZoom: 17,
    attribution: '© OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors',
    builtin: true,
  },
  {
    id: 'osm',
    name: 'OpenStreetMap',
    urlTemplate: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: 'abc',
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
    builtin: true,
  },
];

// Must match TILE_CACHE in sw.js exactly - the Cache Storage API is shared
// between the page and its service worker on the same origin, so this can
// be read/cleared directly without messaging the worker.
const TILE_CACHE_NAME = 'luxtrail-tiles-v1';

export async function ensureBuiltinSources() {
  const existing = await db.all('tileSources');
  if (existing.length === 0) {
    for (const s of BUILTIN_SOURCES) await db.put('tileSources', s);
  }
}

export async function listTileSources() {
  return db.all('tileSources');
}

export async function addTileSource({ name, urlTemplate, apiKey, maxZoom, attribution }) {
  const src = {
    id: newId(),
    name,
    urlTemplate,
    apiKey: apiKey || null,
    maxZoom: maxZoom || 18,
    attribution: attribution || '',
    builtin: false,
  };
  await db.put('tileSources', src);
  return src;
}

export async function deleteTileSource(id) {
  await db.delete('tileSources', id);
}

// Leaflet picks a subdomain per-tile as Math.abs(x+y) % subdomains.length.
// Precached tiles must use the exact same URL Leaflet will request at
// runtime, or they silently miss the cache when offline.
function pickSubdomain(source, x, y) {
  const subs = source.subdomains || 'a';
  const index = Math.abs(x + y) % subs.length;
  return subs[index];
}

export function resolveTileUrl(source, z, x, y) {
  let url = source.urlTemplate
    .replace('{s}', pickSubdomain(source, x, y))
    .replace('{z}', z)
    .replace('{x}', x)
    .replace('{y}', y);
  if (source.apiKey && url.includes('{key}')) url = url.replace('{key}', source.apiKey);
  return url;
}

function lon2tile(lon, z) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}
function lat2tile(lat, z) {
  return Math.floor(
    ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) *
      Math.pow(2, z)
  );
}

export function tilesForBounds(bounds, minZoom, maxZoom) {
  const urls = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const xMin = lon2tile(bounds.getWest(), z);
    const xMax = lon2tile(bounds.getEast(), z);
    const yMin = lat2tile(bounds.getNorth(), z);
    const yMax = lat2tile(bounds.getSouth(), z);
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        urls.push({ z, x, y });
      }
    }
  }
  return urls;
}

export async function downloadArea(source, bounds, minZoom, maxZoom, label, onProgress) {
  // Ask the browser not to evict this app's storage under space pressure.
  // Not guaranteed - the browser decides - but this is the one real lever
  // available to reduce the risk of a downloaded area silently disappearing
  // before a trip.
  let persisted = false;
  if (navigator.storage && navigator.storage.persist) {
    try { persisted = await navigator.storage.persist(); } catch (e) { /* not supported, continue anyway */ }
  }

  const tiles = tilesForBounds(bounds, minZoom, maxZoom);
  const urls = tiles.map((t) => resolveTileUrl(source, t.z, t.x, t.y));

  if (!('serviceWorker' in navigator)) throw new Error('Service worker unavailable');
  const reg = await navigator.serviceWorker.ready;
  if (!reg.active) throw new Error('Service worker not active');

  const result = await new Promise((resolve, reject) => {
    function onMessage(event) {
      const msg = event.data;
      if (msg.type === 'PRECACHE_PROGRESS') {
        onProgress && onProgress(msg.done, msg.total, msg.bytes);
      } else if (msg.type === 'PRECACHE_DONE') {
        navigator.serviceWorker.removeEventListener('message', onMessage);
        resolve({ total: msg.total, bytes: msg.bytes });
      }
    }
    navigator.serviceWorker.addEventListener('message', onMessage);
    reg.active.postMessage({ type: 'PRECACHE_TILES', urls });
  });

  // Record this as its own named, individually deletable download - not
  // just tiles dumped anonymously into one shared cache.
  const record = {
    id: newId(),
    label: label || `${source.name} — ${new Date().toLocaleDateString()}`,
    sourceName: source.name,
    minZoom, maxZoom,
    tileCount: urls.length,
    bytes: result.bytes,
    tileUrls: urls,
    createdAt: Date.now(),
  };
  await db.put('mapDownloads', record);

  return { total: result.total, bytes: result.bytes, persisted, downloadId: record.id };
}

export async function listMapDownloads() {
  const all = await db.all('mapDownloads');
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

// Deletes one named download. Tiles that are ALSO part of another retained
// download (overlapping areas) are kept - only tiles unique to this
// download are actually removed from the cache.
export async function deleteMapDownload(downloadId) {
  const target = await db.get('mapDownloads', downloadId);
  if (!target) return 0;

  const others = (await db.all('mapDownloads')).filter((d) => d.id !== downloadId);
  const stillNeeded = new Set();
  for (const d of others) for (const url of d.tileUrls) stillNeeded.add(url);

  let removed = 0;
  if ('caches' in window) {
    const cache = await caches.open(TILE_CACHE_NAME);
    for (const url of target.tileUrls) {
      if (!stillNeeded.has(url)) {
        const ok = await cache.delete(url);
        if (ok) removed++;
      }
    }
  }

  await db.delete('mapDownloads', downloadId);
  return removed;
}

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

export function resolveTileUrl(source, z, x, y, subLetter) {
  let url = source.urlTemplate
    .replace('{s}', subLetter || (source.subdomains ? source.subdomains[0] : 'a'))
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

export async function downloadArea(source, bounds, minZoom, maxZoom, onProgress) {
  const tiles = tilesForBounds(bounds, minZoom, maxZoom);
  const urls = tiles.map((t) => resolveTileUrl(source, t.z, t.x, t.y));

  if (!('serviceWorker' in navigator)) throw new Error('Service worker unavailable');
  const reg = await navigator.serviceWorker.ready;
  if (!reg.active) throw new Error('Service worker not active');

  return new Promise((resolve, reject) => {
    function onMessage(event) {
      const msg = event.data;
      if (msg.type === 'PRECACHE_PROGRESS') {
        onProgress && onProgress(msg.done, msg.total);
      } else if (msg.type === 'PRECACHE_DONE') {
        navigator.serviceWorker.removeEventListener('message', onMessage);
        resolve(msg.total);
      }
    }
    navigator.serviceWorker.addEventListener('message', onMessage);
    reg.active.postMessage({ type: 'PRECACHE_TILES', urls });
  });
}

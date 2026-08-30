// Builds a zip export: real photo files + a lightweight standalone HTML
// viewer that references them by relative path (same pattern KMZ uses -
// Gaia GPS, Google Earth - so no base64 bloat and no giant in-memory
// string, even with hundreds of photos). Unzip anywhere, open index.html,
// works in any browser, no app or server needed.
//
// A big trip's photos are automatically split across several zip files by
// size, not by asking the person to reorganize their trip - only one
// batch's worth of photo bytes is ever held in memory at a time, so a
// 4-week trip with a thousand photos doesn't need to fit in RAM all at once.

import { zipSync } from 'https://unpkg.com/fflate@0.8.3/esm/browser.js';

const BATCH_BUDGET_BYTES = 40 * 1024 * 1024; // ~40MB of photos per zip part

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function blobToUint8Array(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
}

function buildViewerHtml(data, partLabel) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.tripName)}${partLabel ? ' — ' + esc(partLabel) : ''} — luxtrail export</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  html, body { margin: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  #map { width: 100%; height: 100%; }
  h2 { font-size: 15px; margin: 0 0 4px; }
  .cat { font-size: 11px; text-transform: uppercase; opacity: .65; margin-bottom: 6px; }
  .notes { font-size: 13px; margin: 6px 0; }
  .elsewhere { font-size: 12px; opacity: .6; font-style: italic; }
  .photos { display: flex; gap: 4px; flex-wrap: wrap; max-width: 240px; }
  .photos img { width: 70px; height: 70px; object-fit: cover; border-radius: 4px; cursor: pointer; }
  #lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.85); z-index: 9999; align-items: center; justify-content: center; }
  #lightbox img { max-width: 92vw; max-height: 92vh; }
  #lightbox.open { display: flex; }
  #part-banner { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); background: #223729; color: #eef0ea; padding: 6px 14px; border-radius: 8px; font-size: 13px; z-index: 500; }
</style>
</head>
<body>
${partLabel ? `<div id="part-banner">${esc(data.tripName)} — ${esc(partLabel)}</div>` : ''}
<div id="map"></div>
<div id="lightbox" onclick="this.classList.remove('open')"><img id="lightbox-img"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const DATA = ${JSON.stringify(data)};
const map = L.map('map');
L.tileLayer('https://tile.opentopomap.org/{z}/{x}/{y}.png', {
  maxZoom: 17, attribution: '© OpenTopoMap, © OpenStreetMap contributors'
}).addTo(map);

const bounds = [];

for (const t of DATA.tracks) {
  if (t.points.length > 1) {
    L.polyline(t.points, { color: '#e07a3f', weight: 4 }).addTo(map).bindTooltip(t.name);
    bounds.push(...t.points);
  }
}

for (const w of DATA.waypoints) {
  L.circleMarker([w.lat, w.lon], { radius: 6, color: '#345040', fillColor: '#345040', fillOpacity: 1 })
    .addTo(map).bindPopup('<h2>' + w.name + '</h2>');
  bounds.push([w.lat, w.lon]);
}

const CATEGORY_COLORS = { water: '#3b82f6', viewpoint: '#8b5cf6', junction: '#eab308', hazard: '#c65b4a', camp: '#22c55e', other: '#a9b8ac' };

for (const p of DATA.pois) {
  const color = CATEGORY_COLORS[p.category] || CATEGORY_COLORS.other;
  let html = '<h2>' + p.name + '</h2><div class="cat">' + p.category + '</div>';
  if (p.notes) html += '<div class="notes">' + p.notes + '</div>';
  if (p.photoFiles && p.photoFiles.length) {
    html += '<div class="photos">' + p.photoFiles.map(f => '<img src="' + f + '" onclick="openLightbox(this.src)">').join('') + '</div>';
  } else if (p.hasPhotosElsewhere) {
    html += '<div class="elsewhere">Photos are in another part of this export</div>';
  }
  L.circleMarker([p.lat, p.lon], { radius: 8, color: '#eef0ea', weight: 2, fillColor: color, fillOpacity: 1 })
    .addTo(map).bindPopup(html, { maxWidth: 280 });
  bounds.push([p.lat, p.lon]);
}

if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });
else map.setView([13.0, 102.5], 12);

function openLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.add('open');
}
</script>
</body>
</html>`;
}

// Greedily groups POIs into batches so each batch's total photo bytes stays
// under the budget - one POI's photos always stay together in one batch.
function planBatches(pois) {
  const batches = [];
  let current = [];
  let currentBytes = 0;

  for (const poi of pois) {
    const poiBytes = (poi.photos || []).reduce((sum, b) => sum + b.size, 0);
    if (current.length && currentBytes + poiBytes > BATCH_BUDGET_BYTES) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(poi);
    currentBytes += poiBytes;
  }
  if (current.length) batches.push(current);
  return batches.length ? batches : [[]];
}

// Returns an array of { filename, bytes } - one per zip part. Every part's
// viewer shows the full route and every POI location; only the photos that
// physically live in that part are bundled with it, so nothing is
// duplicated across parts and no single part needs more than ~40MB of
// photo data in memory at once.
export async function buildTripZipParts(trip, tracks, waypoints, pois, onProgress) {
  const batches = planBatches(pois);
  const parts = [];
  let donePhotos = 0;
  const totalPhotos = pois.reduce((sum, p) => sum + (p.photos ? p.photos.length : 0), 0);

  for (let b = 0; b < batches.length; b++) {
    const batchPoiIds = new Set(batches[b].map((p) => p.id));
    const files = {};
    let photoIndex = 0;

    const dataPois = [];
    for (const poi of pois) {
      const inThisBatch = batchPoiIds.has(poi.id);
      const hasPhotos = poi.photos && poi.photos.length > 0;
      const photoFiles = [];
      if (inThisBatch && hasPhotos) {
        for (const blob of poi.photos) {
          const name = `photos/img${String(photoIndex++).padStart(4, '0')}.jpg`;
          files[name] = [await blobToUint8Array(blob), { level: 0 }];
          photoFiles.push(name);
          donePhotos++;
          onProgress && onProgress(donePhotos, totalPhotos, b + 1, batches.length);
        }
      }
      dataPois.push({
        name: poi.name, category: poi.category, notes: poi.notes, lat: poi.lat, lon: poi.lon,
        photoFiles,
        hasPhotosElsewhere: hasPhotos && !inThisBatch,
      });
    }

    const partLabel = batches.length > 1 ? `part ${b + 1} of ${batches.length}` : null;
    const data = {
      tripName: trip.name,
      tracks: tracks.map((t) => ({ name: t.name, points: t.points.map((p) => [p.lat, p.lon]) })),
      waypoints: waypoints.map((w) => ({ name: w.name, lat: w.lat, lon: w.lon })),
      pois: dataPois,
    };
    files['index.html'] = new TextEncoder().encode(buildViewerHtml(data, partLabel));

    const zipBytes = zipSync(files, { level: 0 });
    const filename = batches.length > 1 ? `${trip.name}-viewer-part${b + 1}` : `${trip.name}-viewer`;
    parts.push({ filename, bytes: zipBytes });
  }

  return parts;
}

export function downloadZipFile(filename, uint8Array) {
  const blob = new Blob([uint8Array], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.zip') ? filename : `${filename}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

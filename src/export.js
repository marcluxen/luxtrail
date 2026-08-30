// One zip file, always. Real photo files inside a photos/ folder (not
// bloated base64 text - a JPEG is already compressed, so the zip itself
// uses no compression either, it's just a container to bundle everything
// into one download). Unzip it, open index.html, see the whole trip - map,
// route, every POI with its notes and photos - on one page.

import { zipSync } from 'https://unpkg.com/fflate@0.8.3/esm/browser.js';

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

function buildViewerHtml(data) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.tripName)} — luxtrail export</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  html, body { margin: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  #map { width: 100%; height: 100%; }
  h2 { font-size: 15px; margin: 0 0 4px; }
  .cat { font-size: 11px; text-transform: uppercase; opacity: .65; margin-bottom: 6px; }
  .notes { font-size: 13px; margin: 6px 0; }
  .photos { display: flex; gap: 4px; flex-wrap: wrap; max-width: 240px; }
  .photos img { width: 70px; height: 70px; object-fit: cover; border-radius: 4px; cursor: pointer; }
  #lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.85); z-index: 9999; align-items: center; justify-content: center; }
  #lightbox img { max-width: 92vw; max-height: 92vh; }
  #lightbox.open { display: flex; }
</style>
</head>
<body>
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

// Everything in one zip: index.html + a photos/ folder with every photo as
// a real file. No splitting, no base64, no exceptions.
export async function buildTripZip(trip, tracks, waypoints, pois, onProgress) {
  const files = {};
  let photoIndex = 0;
  let done = 0;
  const total = pois.reduce((sum, p) => sum + (p.photos ? p.photos.length : 0), 0);

  const dataPois = [];
  for (const poi of pois) {
    const photoFiles = [];
    for (const blob of poi.photos || []) {
      const name = `photos/img${String(photoIndex++).padStart(4, '0')}.jpg`;
      files[name] = [await blobToUint8Array(blob), { level: 0 }];
      photoFiles.push(name);
      done++;
      onProgress && onProgress(done, total);
    }
    dataPois.push({ name: poi.name, category: poi.category, notes: poi.notes, lat: poi.lat, lon: poi.lon, photoFiles });
  }

  const data = {
    tripName: trip.name,
    tracks: tracks.map((t) => ({ name: t.name, points: t.points.map((p) => [p.lat, p.lon]) })),
    waypoints: waypoints.map((w) => ({ name: w.name, lat: w.lat, lon: w.lon })),
    pois: dataPois,
  };
  files['index.html'] = new TextEncoder().encode(buildViewerHtml(data));

  return zipSync(files, { level: 0 });
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

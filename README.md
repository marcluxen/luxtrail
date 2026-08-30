# luxtrail

Offline-first hiking map PWA. Load GPX tracks and waypoints, add POIs with photos, see live GPS position and off-track warnings, view an elevation profile, and cache map tiles for offline use in the field.

## Local dev

No build step. Serve the folder over HTTP (service workers need it):

```
python3 -m http.server 8000
```

Open `http://localhost:8000`.

## Deploy

Static hosting only — GitHub Pages, Cloudflare Pages, Netlify, or any web server. Push this folder as-is; enable Pages on the repo (Settings → Pages → branch → root).

## Structure

```
index.html        entry point
manifest.json      PWA manifest
sw.js               service worker: app shell + tile caching
style.css
src/
  app.js            bootstrap + wiring (the only file that touches every module)
  db.js              IndexedDB wrapper — trips, tracks, waypoints, pois, tile sources, settings
  gpx.js             GPX parse + export
  geo.js             distance/bearing/off-track math
  map.js             Leaflet setup, tile layer switching, track/marker rendering
  gps.js             live position watch, off-track detection
  poi.js             POI CRUD + photo compression
  tiles.js           tile source config, offline area precaching
  elevation.js        elevation profile + stats
  ui.js               toast, prompt dialog, list rendering helpers
```

## Data

Everything lives in IndexedDB (`luxtrail` database) and the service worker's tile cache — no backend, no account. Trips group tracks/waypoints/POIs so old data doesn't clutter a new area.

## Tile sources

Not hardcoded. OpenTopoMap and OpenStreetMap ship as defaults; add any other XYZ tile provider (MapTiler, Thunderforest, etc.) from the settings panel with its URL template and API key. "Download current view" precaches tiles for the visible area at a chosen zoom range into the service worker's cache for offline use.

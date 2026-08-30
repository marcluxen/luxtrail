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
  recorder.js         builds a point array from live GPS fixes while recording
  geocode.js           Nominatim place search (online-only, used for trip planning)
  ui.js               toast, prompt dialog, list rendering helpers
```

## Features

- Load/export GPX tracks and waypoints; all loaded tracks render at once, the active one highlighted, others dimmed — click a dimmed track to make it active
- POIs by category (water, viewpoint, junction, hazard, camp, other), color-coded on the map, with notes and photos — tap the map to place one, or use your live GPS fix instead
- Record your own track live while hiking; saved as a normal track on stop
- Live GPS position with follow mode (auto-recenter; breaks on manual pan, resume with the 🎯 button), off-track warning, and nearest-point distance/bearing with a proximity vibrate+toast
- Device compass heading arrow where supported
- Elevation profile + distance/gain/loss/duration stats
- Share current location via the OS share sheet (or SMS fallback) — useful with no signal once you're back in range
- Place search (needs a signal) for planning before you go offline
- Trips group tracks/waypoints/POIs so different hikes don't mix
- Tile source picker, not hardcoded — add any XYZ provider; "download current view" precaches tiles for offline use
- Deletions ask for confirmation

## Data

Everything lives in IndexedDB (`luxtrail` database) and the service worker's tile cache — no backend, no account. Trips group tracks/waypoints/POIs so old data doesn't clutter a new area.

## Tile sources

Not hardcoded. OpenTopoMap and OpenStreetMap ship as defaults; add any other XYZ tile provider (MapTiler, Thunderforest, etc.) from the settings panel with its URL template and API key. "Download current view" precaches tiles for the visible area at a chosen zoom range into the service worker's cache for offline use.

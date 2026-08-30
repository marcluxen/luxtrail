/* global L */
import { db, newId } from './db.js';
import { parseGpx, buildGpx, downloadGpxFile } from './gpx.js';
import * as mapmod from './map.js';
import { GpsTracker } from './gps.js';
import * as poimod from './poi.js';
import * as tilesmod from './tiles.js';
import { computeProfile, renderElevationSvg, formatDistance, formatDuration } from './elevation.js';
import { toast, promptDialog, renderPhotoPreviews, listItem, togglePanel } from './ui.js';

const state = {
  trip: null,
  trips: [],
  tracks: [],
  waypoints: [],
  pois: [],
  activeTrack: null,
  map: null,
  layerRef: {},
  liveRef: {},
  groups: {},
  gps: null,
  gpsOn: false,
  followMode: true,
  lastPosition: null,
  placingPoi: false,
  pendingPoiLatLng: null,
  pendingPhotoFiles: [],
};

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  await tilesmod.ensureBuiltinSources();

  state.trips = await db.all('trips');
  if (state.trips.length === 0) {
    const trip = { id: newId(), name: 'Koh Kood', createdAt: Date.now() };
    await db.put('trips', trip);
    state.trips = [trip];
  }
  const lastTripId = await db.getSetting('currentTripId', state.trips[0].id);
  state.trip = state.trips.find((t) => t.id === lastTripId) || state.trips[0];

  state.map = mapmod.createMap('map');
  state.groups.track = L.layerGroup().addTo(state.map);
  state.groups.waypoints = L.layerGroup().addTo(state.map);
  state.groups.pois = L.layerGroup().addTo(state.map);

  const sources = await tilesmod.listTileSources();
  const sourceId = await db.getSetting('currentSourceId', sources[0].id);
  const source = sources.find((s) => s.id === sourceId) || sources[0];
  mapmod.setTileLayer(state.map, state.layerRef, source);

  state.gps = new GpsTracker({ onPosition: handlePosition, onError: handleGpsError });

  state.map.on('dragstart', () => { state.followMode = false; });
  state.map.on('click', (e) => {
    if (!state.placingPoi) return;
    state.pendingPoiLatLng = { lat: e.latlng.lat, lon: e.latlng.lng };
    setPlacingMode(false);
    openPoiDialog();
  });

  populateTripSelect();
  await loadTripData();
  populateSourceSelect(sources, source.id);
  wireUi();
}

function setPlacingMode(on) {
  state.placingPoi = on;
  document.getElementById('btn-add-poi').classList.toggle('active', on);
  document.getElementById('map').classList.toggle('placing-poi', on);
  if (on) toast('Tap the map to place the POI');
}

async function loadTripData() {
  const tripId = state.trip.id;
  state.tracks = await db.byIndex('tracks', 'tripId', tripId);
  state.waypoints = await db.byIndex('waypoints', 'tripId', tripId);
  state.pois = await poimod.poisForTrip(tripId);
  state.activeTrack = state.tracks[0] || null;

  renderMapLayers();
  renderList();
  updateElevationPanel();

  if (state.gps) state.gps.setActiveTrack(state.activeTrack ? state.activeTrack.points : null);

  if (state.activeTrack && state.activeTrack.points.length) {
    const latlngs = state.activeTrack.points.map((p) => [p.lat, p.lon]);
    state.map.fitBounds(latlngs, { padding: [30, 30] });
  } else if (state.pois.length) {
    state.map.setView([state.pois[0].lat, state.pois[0].lon], 14);
  }
}

function renderMapLayers() {
  mapmod.drawTrack(state.map, state.groups.track, state.activeTrack ? state.activeTrack.points : null);
  mapmod.drawWaypoints(state.map, state.groups.waypoints, state.waypoints);
  mapmod.drawPois(state.map, state.groups.pois, state.pois, openPoiView);
}

function renderList() {
  const container = document.getElementById('list-items');
  container.innerHTML = '';

  if (!state.tracks.length && !state.waypoints.length && !state.pois.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    empty.textContent = 'Nothing here yet. Load a GPX file or add a POI.';
    container.appendChild(empty);
    return;
  }

  for (const t of state.tracks) {
    const stats = t.points.length > 1 ? computeProfile(t.points) : null;
    const meta = stats ? formatDistance(stats.stats.distance) : `${t.points.length} pts`;
    container.appendChild(listItem({
      title: t.name,
      meta,
      kindLabel: 'Track',
      onClick: () => {
        state.activeTrack = t;
        state.gps.setActiveTrack(t.points);
        renderMapLayers();
        updateElevationPanel();
        const latlngs = t.points.map((p) => [p.lat, p.lon]);
        state.map.fitBounds(latlngs, { padding: [30, 30] });
        togglePanel('list-panel', false);
      },
      onDelete: async () => {
        await db.delete('tracks', t.id);
        await loadTripData();
      },
    }));
  }

  for (const w of state.waypoints) {
    container.appendChild(listItem({
      title: w.name,
      meta: `${w.lat.toFixed(4)}, ${w.lon.toFixed(4)}`,
      kindLabel: 'Waypoint',
      onClick: () => { state.map.setView([w.lat, w.lon], 16); togglePanel('list-panel', false); },
      onDelete: async () => {
        await db.delete('waypoints', w.id);
        await loadTripData();
      },
    }));
  }

  for (const p of state.pois) {
    container.appendChild(listItem({
      title: p.name,
      meta: p.category,
      kindLabel: 'POI',
      kindClass: 'poi',
      onClick: () => { state.map.setView([p.lat, p.lon], 16); openPoiView(p); togglePanel('list-panel', false); },
      onDelete: async () => {
        await poimod.deletePoi(p.id);
        await loadTripData();
      },
    }));
  }
}

function updateElevationPanel() {
  const panel = document.getElementById('elevation-panel');
  const track = state.activeTrack;
  if (!track || track.points.length < 2) {
    panel.classList.add('hidden');
    return;
  }
  const profile = computeProfile(track.points);
  document.getElementById('elevation-title').textContent = track.name;
  const chartEl = document.getElementById('elevation-chart');
  const statsEl = document.getElementById('elevation-stats');

  if (!profile) {
    chartEl.innerHTML = '<div class="hint">No elevation data in this track.</div>';
    statsEl.innerHTML = '';
    return;
  }

  chartEl.innerHTML = renderElevationSvg(profile.points, profile.stats);
  statsEl.innerHTML = `
    <div><strong>${formatDistance(profile.stats.distance)}</strong><br>distance</div>
    <div><strong>+${Math.round(profile.stats.gain)} m</strong><br>gain</div>
    <div><strong>-${Math.round(profile.stats.loss)} m</strong><br>loss</div>
    <div><strong>${formatDuration(profile.stats.duration)}</strong><br>duration</div>
  `;
}

function populateTripSelect() {
  const sel = document.getElementById('trip-select');
  sel.innerHTML = '';
  for (const t of state.trips) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    if (t.id === state.trip.id) opt.selected = true;
    sel.appendChild(opt);
  }
  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = '+ New trip';
  sel.appendChild(newOpt);
}

function populateSourceSelect(sources, activeId) {
  const sel = document.getElementById('source-select');
  sel.innerHTML = '';
  for (const s of sources) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    if (s.id === activeId) opt.selected = true;
    sel.appendChild(opt);
  }
}

function handlePosition(info) {
  state.lastPosition = { lat: info.lat, lon: info.lon };
  mapmod.upsertLiveMarker(state.map, state.liveRef, info.lat, info.lon, info.accuracy || 15);
  const statusEl = document.getElementById('gps-status');
  statusEl.textContent = `GPS: ${info.accuracy ? Math.round(info.accuracy) + 'm accuracy' : 'live'}`;
  statusEl.classList.add('live');

  if (state.followMode) {
    state.map.setView([info.lat, info.lon], state.map.getZoom());
  }

  const warn = document.getElementById('off-track-warning');
  if (info.isOffTrack) {
    warn.textContent = `${Math.round(info.offTrackMeters)} m off track`;
    warn.classList.remove('hidden');
  } else {
    warn.classList.add('hidden');
  }
}

function handleGpsError(err) {
  toast('GPS error: ' + (err.message || 'unavailable'));
  document.getElementById('gps-status').textContent = 'GPS: off';
  document.getElementById('gps-status').classList.remove('live');
}

async function openPoiView(poi) {
  document.getElementById('poi-view-name').textContent = poi.name;
  document.getElementById('poi-view-meta').textContent = `${poi.category} · ${poi.lat.toFixed(5)}, ${poi.lon.toFixed(5)}`;
  document.getElementById('poi-view-notes').textContent = poi.notes || '';
  renderPhotoPreviews(document.getElementById('poi-view-photos'), poi.photos || []);
  const dlg = document.getElementById('poi-view-dialog');
  dlg.showModal();

  const delBtn = document.getElementById('poi-delete');
  const closeBtn = document.getElementById('poi-view-close');
  function cleanup() {
    delBtn.removeEventListener('click', onDelete);
    closeBtn.removeEventListener('click', onClose);
  }
  async function onDelete() {
    await poimod.deletePoi(poi.id);
    dlg.close();
    cleanup();
    await loadTripData();
  }
  function onClose() { dlg.close(); cleanup(); }
  delBtn.addEventListener('click', onDelete);
  closeBtn.addEventListener('click', onClose);
}

function wireUi() {
  document.getElementById('btn-load').addEventListener('click', () => document.getElementById('file-input').click());
  document.getElementById('file-input').addEventListener('change', async (e) => {
    for (const file of e.target.files) await handleGpxFile(file);
    e.target.value = '';
  });

  document.getElementById('btn-list').addEventListener('click', () => togglePanel('list-panel'));
  document.getElementById('btn-close-list').addEventListener('click', () => togglePanel('list-panel', false));
  document.getElementById('btn-export-gpx').addEventListener('click', () => {
    if (!state.tracks.length && !state.waypoints.length) { toast('Nothing to export'); return; }
    const waypoints = [
      ...state.waypoints,
      ...state.pois.map((p) => ({ name: p.name, lat: p.lat, lon: p.lon, notes: p.notes })),
    ];
    const gpxString = buildGpx({ tracks: state.tracks, waypoints });
    downloadGpxFile(state.trip.name, gpxString);
    toast('GPX exported');
  });

  document.getElementById('btn-settings').addEventListener('click', () => togglePanel('settings-panel'));
  document.getElementById('btn-close-settings').addEventListener('click', () => togglePanel('settings-panel', false));

  document.getElementById('btn-elevation').addEventListener('click', () => {
    document.getElementById('elevation-panel').classList.toggle('hidden');
  });
  document.getElementById('btn-close-elevation').addEventListener('click', () => {
    document.getElementById('elevation-panel').classList.add('hidden');
  });

  document.getElementById('btn-locate').addEventListener('click', () => {
    state.gpsOn = !state.gpsOn;
    const recenterBtn = document.getElementById('btn-recenter');
    if (state.gpsOn) {
      state.followMode = true;
      state.gps.start();
      recenterBtn.classList.remove('hidden');
      toast('GPS tracking on');
    } else {
      state.gps.stop();
      recenterBtn.classList.add('hidden');
      document.getElementById('gps-status').textContent = 'GPS: off';
      document.getElementById('gps-status').classList.remove('live');
      toast('GPS tracking off');
    }
  });

  document.getElementById('btn-recenter').addEventListener('click', () => {
    state.followMode = true;
    if (state.lastPosition) {
      state.map.setView([state.lastPosition.lat, state.lastPosition.lon], state.map.getZoom());
    }
  });

  document.getElementById('btn-add-poi').addEventListener('click', () => setPlacingMode(!state.placingPoi));

  document.getElementById('btn-use-gps').addEventListener('click', () => {
    if (!state.lastPosition) { toast('No GPS fix yet'); return; }
    state.pendingPoiLatLng = { ...state.lastPosition };
    document.getElementById('poi-coords').textContent = `${state.lastPosition.lat.toFixed(5)}, ${state.lastPosition.lon.toFixed(5)} (GPS)`;
  });
  document.getElementById('btn-attach-photos').addEventListener('click', () => document.getElementById('photo-input').click());
  document.getElementById('photo-input').addEventListener('change', (e) => {
    state.pendingPhotoFiles = Array.from(e.target.files);
    const container = document.getElementById('poi-photo-preview');
    container.innerHTML = '';
    for (const f of state.pendingPhotoFiles) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(f);
      container.appendChild(img);
    }
  });

  document.getElementById('poi-cancel').addEventListener('click', () => {
    state.pendingPoiLatLng = null;
    document.getElementById('poi-dialog').close();
  });
  document.getElementById('poi-save').addEventListener('click', savePoiFromDialog);

  document.getElementById('trip-select').addEventListener('change', async (e) => {
    const val = e.target.value;
    if (val === '__new__') {
      const name = await promptDialog('Trip name');
      if (!name) { populateTripSelect(); return; }
      const trip = { id: newId(), name, createdAt: Date.now() };
      await db.put('trips', trip);
      state.trips.push(trip);
      state.trip = trip;
    } else {
      state.trip = state.trips.find((t) => t.id === val);
    }
    await db.setSetting('currentTripId', state.trip.id);
    populateTripSelect();
    await loadTripData();
  });

  document.getElementById('source-select').addEventListener('change', async (e) => {
    const sources = await tilesmod.listTileSources();
    const source = sources.find((s) => s.id === e.target.value);
    mapmod.setTileLayer(state.map, state.layerRef, source);
    await db.setSetting('currentSourceId', source.id);
    toast(`Map source: ${source.name}`);
  });

  document.getElementById('btn-add-source').addEventListener('click', async () => {
    const name = document.getElementById('src-name').value.trim();
    const urlTemplate = document.getElementById('src-url').value.trim();
    const apiKey = document.getElementById('src-key').value.trim();
    const maxZoom = parseInt(document.getElementById('src-maxzoom').value, 10) || 18;
    if (!name || !urlTemplate) { toast('Name and URL template required'); return; }
    await tilesmod.addTileSource({ name, urlTemplate, apiKey, maxZoom });
    const sources = await tilesmod.listTileSources();
    populateSourceSelect(sources, sources[sources.length - 1].id);
    document.getElementById('src-name').value = '';
    document.getElementById('src-url').value = '';
    document.getElementById('src-key').value = '';
    toast('Source added');
  });

  document.getElementById('btn-download-area').addEventListener('click', async () => {
    const sources = await tilesmod.listTileSources();
    const source = sources.find((s) => s.id === document.getElementById('source-select').value);
    const minZoom = parseInt(document.getElementById('dl-minzoom').value, 10);
    const maxZoom = parseInt(document.getElementById('dl-maxzoom').value, 10);
    const progressEl = document.getElementById('download-progress');
    progressEl.textContent = 'Starting…';
    try {
      const total = await tilesmod.downloadArea(source, state.map.getBounds(), minZoom, maxZoom, (done, tot) => {
        progressEl.textContent = `Caching tiles: ${done} / ${tot}`;
      });
      progressEl.textContent = `Done — ${total} tiles cached for offline use.`;
      toast('Area saved for offline use');
    } catch (err) {
      progressEl.textContent = 'Failed: ' + err.message;
    }
  });
}

function openPoiDialog() {
  document.getElementById('poi-name').value = '';
  document.getElementById('poi-category').value = 'water';
  document.getElementById('poi-notes').value = '';
  document.getElementById('poi-photo-preview').innerHTML = '';
  state.pendingPhotoFiles = [];
  const coordsEl = document.getElementById('poi-coords');
  coordsEl.textContent = state.pendingPoiLatLng
    ? `${state.pendingPoiLatLng.lat.toFixed(5)}, ${state.pendingPoiLatLng.lon.toFixed(5)}`
    : '';
  document.getElementById('poi-dialog').showModal();
}

async function savePoiFromDialog() {
  const name = document.getElementById('poi-name').value.trim();
  if (!name) { toast('Name required'); return; }
  if (!state.pendingPoiLatLng) { toast('No location set — tap the map first'); return; }
  const category = document.getElementById('poi-category').value;
  const notes = document.getElementById('poi-notes').value.trim();

  await poimod.createPoi({
    tripId: state.trip.id,
    name, category, notes,
    lat: state.pendingPoiLatLng.lat, lon: state.pendingPoiLatLng.lon,
    photoFiles: state.pendingPhotoFiles,
  });

  state.pendingPoiLatLng = null;
  document.getElementById('poi-dialog').close();
  toast('POI saved');
  await loadTripData();
}

async function handleGpxFile(file) {
  try {
    const text = await file.text();
    const { tracks, waypoints } = parseGpx(text);
    if (!tracks.length && !waypoints.length) {
      toast('No tracks or waypoints found in file');
      return;
    }
    for (const t of tracks) {
      await db.put('tracks', { id: newId(), tripId: state.trip.id, name: t.name, points: t.points });
    }
    for (const w of waypoints) {
      await db.put('waypoints', { id: newId(), tripId: state.trip.id, name: w.name, lat: w.lat, lon: w.lon, ele: w.ele });
    }
    toast(`Loaded ${tracks.length} track(s), ${waypoints.length} waypoint(s)`);
    await loadTripData();
  } catch (err) {
    toast('Failed to load GPX: ' + err.message);
  }
}

init();

/* global L */
import { db, newId } from './db.js';
import { parseGpx, buildGpx, downloadGpxFile } from './gpx.js';
import * as mapmod from './map.js';
import { GpsTracker } from './gps.js';
import { TrackRecorder } from './recorder.js';
import { searchPlace } from './geocode.js';
import * as poimod from './poi.js';
import * as tilesmod from './tiles.js';
import { computeProfile, renderElevationSvg, formatDistance, formatDuration } from './elevation.js';
import { toast, promptDialog, renderPhotoPreviews, listItem, togglePanel } from './ui.js';

const PROXIMITY_ALERT_M = 30;

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
  trackLayers: new Map(),
  gps: null,
  gpsOn: false,
  followMode: true,
  lastPosition: null,
  placingPoi: false,
  pendingPoiLatLng: null,
  pendingPhotoFiles: [],
  recorder: new TrackRecorder(),
  recordingLine: null,
  lastAlertedId: null,
  listFilter: '',
  headingPermissionAsked: false,
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
  for (const t of state.tracks) {
    t.stats = t.points.length > 1 ? computeProfile(t.points) : null;
  }
  state.waypoints = await db.byIndex('waypoints', 'tripId', tripId);
  state.pois = await poimod.poisForTrip(tripId);
  state.activeTrack = state.tracks[0] || null;

  const combinedPoints = [
    ...state.waypoints.map((w) => ({ id: w.id, name: w.name, lat: w.lat, lon: w.lon })),
    ...state.pois.map((p) => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon })),
  ];
  if (state.gps) state.gps.setPoints(combinedPoints);
  if (state.gps) state.gps.setActiveTrack(state.activeTrack ? state.activeTrack.points : null);

  renderMapLayers();
  renderList();
  updateElevationPanel();

  if (state.activeTrack && state.activeTrack.points.length) {
    const latlngs = state.activeTrack.points.map((p) => [p.lat, p.lon]);
    state.map.fitBounds(latlngs, { padding: [30, 30] });
  } else if (state.pois.length) {
    state.map.setView([state.pois[0].lat, state.pois[0].lon], 14);
  }
}

function setActiveTrack(track) {
  state.activeTrack = track;
  state.gps.setActiveTrack(track ? track.points : null);
  mapmod.setActiveTrackStyle(state.trackLayers, track ? track.id : null);
  updateElevationPanel();
}

function renderMapLayers() {
  state.trackLayers = mapmod.drawTracks(state.map, state.groups.track, state.tracks, state.activeTrack ? state.activeTrack.id : null, setActiveTrack);
  mapmod.drawWaypoints(state.map, state.groups.waypoints, state.waypoints);
  mapmod.drawPois(state.map, state.groups.pois, state.pois, openPoiView);
}

function matchesFilter(text, category) {
  if (!state.listFilter) return true;
  const q = state.listFilter.toLowerCase();
  return (text || '').toLowerCase().includes(q) || (category || '').toLowerCase().includes(q);
}

function renderList() {
  const container = document.getElementById('list-items');
  container.innerHTML = '';

  const tracks = state.tracks.filter((t) => matchesFilter(t.name));
  const waypoints = state.waypoints.filter((w) => matchesFilter(w.name));
  const pois = state.pois.filter((p) => matchesFilter(p.name, p.category));

  if (!tracks.length && !waypoints.length && !pois.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    empty.textContent = state.listFilter ? 'No matches.' : 'Nothing here yet. Load a GPX file or add a POI.';
    container.appendChild(empty);
    return;
  }

  for (const t of tracks) {
    const meta = t.stats ? formatDistance(t.stats.stats.distance) : `${t.points.length} pts`;
    container.appendChild(listItem({
      title: t.name,
      meta,
      kindLabel: 'Track',
      onClick: () => {
        setActiveTrack(t);
        const latlngs = t.points.map((p) => [p.lat, p.lon]);
        state.map.fitBounds(latlngs, { padding: [30, 30] });
        togglePanel('list-panel', false);
      },
      onDelete: async () => {
        if (!confirm(`Delete track "${t.name}"?`)) return;
        await db.delete('tracks', t.id);
        await loadTripData();
      },
    }));
  }

  for (const w of waypoints) {
    container.appendChild(listItem({
      title: w.name,
      meta: `${w.lat.toFixed(4)}, ${w.lon.toFixed(4)}`,
      kindLabel: 'Waypoint',
      onClick: () => { state.map.setView([w.lat, w.lon], 16); togglePanel('list-panel', false); },
      onDelete: async () => {
        if (!confirm(`Delete waypoint "${w.name}"?`)) return;
        await db.delete('waypoints', w.id);
        await loadTripData();
      },
    }));
  }

  for (const p of pois) {
    container.appendChild(listItem({
      title: p.name,
      meta: p.category,
      kindLabel: 'POI',
      kindClass: 'poi',
      onClick: () => { state.map.setView([p.lat, p.lon], 16); openPoiView(p); togglePanel('list-panel', false); },
      onDelete: async () => {
        if (!confirm(`Delete POI "${p.name}"?`)) return;
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
  const profile = track.stats;
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

function bearingLabel(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

function handlePosition(info) {
  state.lastPosition = { lat: info.lat, lon: info.lon };
  mapmod.upsertLiveMarker(state.map, state.liveRef, info.lat, info.lon, info.accuracy || 15);

  const compassHeading = info.compassHeading != null ? info.compassHeading : info.heading;
  mapmod.upsertHeadingArrow(state.map, state.liveRef, info.lat, info.lon, compassHeading);

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

  const nextCard = document.getElementById('next-waypoint-card');
  if (info.nextInfo) {
    nextCard.innerHTML = `→ <strong>${info.nextInfo.name}</strong><br>${formatDistance(info.nextInfo.distance)} · ${bearingLabel(info.nextInfo.bearing)}`;
    nextCard.classList.remove('hidden');

    if (info.nextInfo.distance <= PROXIMITY_ALERT_M && state.lastAlertedId !== info.nextInfo.id) {
      state.lastAlertedId = info.nextInfo.id;
      toast(`Near: ${info.nextInfo.name}`);
      if ('vibrate' in navigator) navigator.vibrate([120, 60, 120]);
    } else if (info.nextInfo.distance > PROXIMITY_ALERT_M + 15 && state.lastAlertedId === info.nextInfo.id) {
      state.lastAlertedId = null;
    }
  } else {
    nextCard.classList.add('hidden');
  }

  if (state.recorder.recording) {
    const newPoint = state.recorder.addFix(info);
    if (newPoint) {
      const latlng = [newPoint.lat, newPoint.lon];
      if (!state.recordingLine) {
        state.recordingLine = L.polyline([latlng], { color: '#c65b4a', weight: 4, dashArray: '6 6' }).addTo(state.map);
      } else {
        state.recordingLine.addLatLng(latlng);
      }
    }
  }
}

function handleGpsError(err) {
  toast('GPS error: ' + (err.message || 'unavailable'));
  document.getElementById('gps-status').textContent = 'GPS: off';
  document.getElementById('gps-status').classList.remove('live');
}

function requestHeadingIfNeeded() {
  if (state.headingPermissionAsked) return;
  state.headingPermissionAsked = true;

  function onOrientation(e) {
    let heading = null;
    if (typeof e.webkitCompassHeading === 'number') {
      heading = e.webkitCompassHeading; // iOS: already a true compass heading
    } else if (e.alpha != null) {
      heading = 360 - e.alpha; // rough approximation elsewhere
    }
    if (heading != null && state.lastPosition) {
      mapmod.upsertHeadingArrow(state.map, state.liveRef, state.lastPosition.lat, state.lastPosition.lon, heading);
    }
  }

  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission()
      .then((result) => {
        if (result === 'granted') window.addEventListener('deviceorientation', onOrientation);
      })
      .catch(() => {});
  } else if (typeof DeviceOrientationEvent !== 'undefined') {
    window.addEventListener('deviceorientationabsolute', onOrientation);
    window.addEventListener('deviceorientation', onOrientation);
  }
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
    if (!confirm(`Delete POI "${poi.name}"?`)) return;
    await poimod.deletePoi(poi.id);
    dlg.close();
    cleanup();
    await loadTripData();
  }
  function onClose() { dlg.close(); cleanup(); }
  delBtn.addEventListener('click', onDelete);
  closeBtn.addEventListener('click', onClose);
}

async function shareLocation() {
  let pos = state.lastPosition;
  if (!pos) {
    try {
      const fix = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 })
      );
      pos = { lat: fix.coords.latitude, lon: fix.coords.longitude };
    } catch (err) {
      toast('Could not get a GPS fix');
      return;
    }
  }
  const url = `https://www.google.com/maps?q=${pos.lat},${pos.lon}`;
  if (navigator.share) {
    navigator.share({ title: 'My location', text: 'My location:', url }).catch(() => {});
  } else {
    window.location.href = `sms:?&body=${encodeURIComponent('My location: ' + url)}`;
  }
}

async function toggleRecording() {
  if (!state.recorder.recording) {
    if (!state.gpsOn) document.getElementById('btn-locate').click();
    state.recorder.start();
    document.getElementById('recording-indicator').classList.remove('hidden');
    document.getElementById('btn-record').classList.add('active');
    toast('Recording started');
  } else {
    const points = state.recorder.stop();
    document.getElementById('recording-indicator').classList.add('hidden');
    document.getElementById('btn-record').classList.remove('active');
    if (state.recordingLine) { state.map.removeLayer(state.recordingLine); state.recordingLine = null; }

    if (points.length > 1) {
      const defaultName = `Recorded ${new Date().toLocaleDateString()}`;
      const name = (await promptDialog('Track name', defaultName)) || defaultName;
      await db.put('tracks', { id: newId(), tripId: state.trip.id, name, points });
      toast('Track saved');
      await loadTripData();
    } else {
      toast('Recording too short, discarded');
    }
  }
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

  document.getElementById('list-filter').addEventListener('input', (e) => {
    state.listFilter = e.target.value.trim();
    renderList();
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
      requestHeadingIfNeeded();
      recenterBtn.classList.remove('hidden');
      toast('GPS tracking on');
    } else {
      state.gps.stop();
      recenterBtn.classList.add('hidden');
      document.getElementById('gps-status').textContent = 'GPS: off';
      document.getElementById('gps-status').classList.remove('live');
      document.getElementById('next-waypoint-card').classList.add('hidden');
      if (state.recorder.recording) toggleRecording();
    }
  });

  document.getElementById('btn-recenter').addEventListener('click', () => {
    state.followMode = true;
    if (state.lastPosition) {
      state.map.setView([state.lastPosition.lat, state.lastPosition.lon], state.map.getZoom());
    }
  });

  document.getElementById('btn-record').addEventListener('click', toggleRecording);
  document.getElementById('btn-share-location').addEventListener('click', shareLocation);

  document.getElementById('btn-search-toggle').addEventListener('click', () => {
    document.getElementById('search-bar').classList.toggle('hidden');
    document.getElementById('search-input').focus();
  });
  document.getElementById('btn-search-close').addEventListener('click', () => {
    document.getElementById('search-bar').classList.add('hidden');
  });
  async function runSearch() {
    const q = document.getElementById('search-input').value.trim();
    if (!q) return;
    try {
      const results = await searchPlace(q);
      if (!results.length) { toast('No results'); return; }
      state.map.setView([results[0].lat, results[0].lon], 13);
      toast(results[0].name.split(',')[0]);
      document.getElementById('search-bar').classList.add('hidden');
    } catch (err) {
      toast('Search needs a signal');
    }
  }
  document.getElementById('btn-search-go').addEventListener('click', runSearch);
  document.getElementById('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
  });

  document.getElementById('btn-add-poi').addEventListener('click', () => setPlacingMode(!state.placingPoi));

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

  document.getElementById('btn-use-gps').addEventListener('click', () => {
    if (!state.lastPosition) { toast('No GPS fix yet'); return; }
    state.pendingPoiLatLng = { ...state.lastPosition };
    document.getElementById('poi-coords').textContent = `${state.lastPosition.lat.toFixed(5)}, ${state.lastPosition.lon.toFixed(5)} (GPS)`;
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
    state.listFilter = '';
    document.getElementById('list-filter').value = '';
    await loadTripData();
  });

  document.getElementById('source-select').addEventListener('change', async (e) => {
    const sources = await tilesmod.listTileSources();
    const source = sources.find((s) => s.id === e.target.value);
    mapmod.setTileLayer(state.map, state.layerRef, source);
    await db.setSetting('currentSourceId', source.id);
    toast(`Map source: ${source.name}`);
  });

  document.getElementById('btn-delete-source').addEventListener('click', async () => {
    const sources = await tilesmod.listTileSources();
    if (sources.length <= 1) { toast("Can't delete the last remaining source"); return; }
    const id = document.getElementById('source-select').value;
    const source = sources.find((s) => s.id === id);
    if (!confirm(`Delete map source "${source.name}"?`)) return;
    await tilesmod.deleteTileSource(id);
    const remaining = await tilesmod.listTileSources();
    populateSourceSelect(remaining, remaining[0].id);
    mapmod.setTileLayer(state.map, state.layerRef, remaining[0]);
    await db.setSetting('currentSourceId', remaining[0].id);
    toast('Source deleted');
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

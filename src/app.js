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
import { nearestPointIndex, trackStats, nearestPointByTime } from './geo.js';
import { readPhotoCaptureTime } from './exif.js';
import { buildTripZip, downloadZipFile } from './export.js';
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
  measuringSegment: false,
  segmentStartIdx: null,
  segmentEndIdx: null,
  segmentRawA: null,
  segmentRawB: null,
  dayTrips: [],
  segmentGroup: null,
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

  setupInstallPrompt();

  await tilesmod.ensureBuiltinSources();

  state.trips = await db.all('trips');
  if (state.trips.length === 0) {
    const trip = { id: newId(), name: 'Koh Kood', createdAt: Date.now() };
    await db.put('trips', trip);
    state.trips = [trip];
  }
  const lastTripId = await db.getSetting('currentTripId', state.trips[0].id);
  state.trip = state.trips.find((t) => t.id === lastTripId) || state.trips[0];
  await db.setSetting('currentTripId', state.trip.id); // make the fallback stick, not just live in memory

  state.map = mapmod.createMap('map');
  state.groups.track = L.layerGroup().addTo(state.map);
  state.groups.waypoints = L.layerGroup().addTo(state.map);
  state.groups.pois = L.layerGroup().addTo(state.map);
  state.segmentGroup = L.layerGroup().addTo(state.map);

  const sources = await tilesmod.listTileSources();
  const sourceId = await db.getSetting('currentSourceId', sources[0].id);
  const source = sources.find((s) => s.id === sourceId) || sources[0];
  mapmod.setTileLayer(state.map, state.layerRef, source);

  state.gps = new GpsTracker({ onPosition: handlePosition, onError: handleGpsError });

  state.map.on('dragstart', () => { state.followMode = false; });
  state.map.on('moveend', () => {
    if (!state.activeTrack) mapmod.applyViewportVisibility(state.map, state.groups.track, state.trackLayers);
  });
  state.map.on('click', (e) => {
    if (state.placingPoi) {
      state.pendingPoiLatLng = { lat: e.latlng.lat, lon: e.latlng.lng };
      setPlacingMode(false);
      openPoiDialog();
      return;
    }
    if (state.measuringSegment) {
      pickSegmentPoint(e.latlng);
    }
  });

  populateTripSelect();
  await loadTripData();
  fitToSensibleDefault();
  populateSourceSelect(sources, source.id);
  wireUi();
}

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return mb < 1000 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(2)} GB`;
}

async function renderDownloadsList() {
  const container = document.getElementById('downloads-list');
  const downloads = await tilesmod.listMapDownloads();

  if (!downloads.length) {
    container.innerHTML = '<div class="hint">No maps downloaded yet.</div>';
    return;
  }

  container.innerHTML = '';
  for (const d of downloads) {
    const row = document.createElement('div');
    row.className = 'download-row';
    const info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = `${d.label}<div class="meta">${d.sourceName} · z${d.minZoom}-${d.maxZoom} · ${formatBytes(d.bytes)} · ${new Date(d.createdAt).toLocaleDateString()}</div>`;
    const delBtn = document.createElement('button');
    delBtn.className = 'btn';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete "${d.label}"? This removes its tiles unless another download still needs them.`)) return;
      await tilesmod.deleteMapDownload(d.id);
      renderDownloadsList();
      toast('Download removed');
    });
    row.appendChild(info);
    row.appendChild(delBtn);
    container.appendChild(row);
  }
}

let deferredInstallPrompt = null;

function setupInstallPrompt() {
  const btn = document.getElementById('btn-install');
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (isStandalone) return; // already installed, nothing to offer

  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    btn.classList.remove('hidden');
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    btn.classList.add('hidden');
  });

  if (isIos) btn.classList.remove('hidden'); // no install prompt event on iOS - offer instructions instead

  btn.addEventListener('click', async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      if (choice.outcome === 'accepted') btn.classList.add('hidden');
    } else if (isIos) {
      toast('Tap the Share icon below, then "Add to Home Screen"', 5000);
    } else {
      toast('Use your browser menu to install or add to home screen');
    }
  });
}

function setPlacingMode(on) {
  if (on) setMeasuringModeOff();
  state.placingPoi = on;
  document.getElementById('btn-add-poi').classList.toggle('active', on);
  document.getElementById('map').classList.toggle('placing-poi', on);
  if (on) toast('Tap the map to place the POI');
}

function setMeasuringMode(on) {
  if (on) setPlacingMode(false);
  state.measuringSegment = on;
  document.getElementById('btn-measure').classList.toggle('active', on);
  document.getElementById('map').classList.toggle('placing-poi', on);
  if (on) {
    if (!state.activeTrack) { toast('Load or select a track first'); state.measuringSegment = false; document.getElementById('btn-measure').classList.remove('active'); return; }
    state.segmentStartIdx = null;
    state.segmentEndIdx = null;
    state.segmentRawA = null;
    state.segmentRawB = null;
    state.segmentGroup.clearLayers();
    updateElevationPanel();
    toast('Tap two points on the route');
  }
}

function pickSegmentPoint(latlng) {
  const idx = nearestPointIndex(latlng, state.activeTrack.points);
  if (state.segmentStartIdx == null) {
    state.segmentStartIdx = idx;
    state.segmentRawA = latlng;
    toast('Start set — tap the end point');
  } else {
    state.segmentEndIdx = idx;
    state.segmentRawB = latlng;
    setMeasuringModeOff();
    toast('Segment selected');
    document.getElementById('elevation-panel').classList.remove('hidden');
    fitToSegment(); // always zoom in on the picked stretch, no saving required
  }
  mapmod.drawSegmentSelection(state.map, state.segmentGroup, state.activeTrack.points, state.segmentStartIdx, state.segmentEndIdx, state.segmentRawA, state.segmentRawB);
  updateElevationPanel();
}

function setMeasuringModeOff() {
  state.measuringSegment = false;
  document.getElementById('btn-measure').classList.remove('active');
  document.getElementById('map').classList.remove('placing-poi');
}

function clearSegment() {
  state.segmentStartIdx = null;
  state.segmentEndIdx = null;
  state.segmentRawA = null;
  state.segmentRawB = null;
  state.segmentGroup.clearLayers();
  updateElevationPanel();
  if (state.activeTrack) fitToTrack(state.activeTrack); // back out to the full route
}

function fitToSegment() {
  if (state.segmentStartIdx == null || state.segmentEndIdx == null || !state.activeTrack) return;
  const lo = Math.min(state.segmentStartIdx, state.segmentEndIdx);
  const hi = Math.max(state.segmentStartIdx, state.segmentEndIdx);
  const latlngs = state.activeTrack.points.slice(lo, hi + 1).map((p) => [p.lat, p.lon]);
  if (latlngs.length > 1) state.map.fitBounds(latlngs, { padding: [30, 30] });
}

// Optional: names the current selection so it can be reopened later. Just a
// pointer (track + start/end index) - never a copy of the points.
async function saveDayTrip() {
  if (state.segmentStartIdx == null || state.segmentEndIdx == null || !state.activeTrack) return;
  const defaultName = `Day trip — ${new Date().toLocaleDateString()}`;
  const name = await promptDialog('Name this day trip (optional)', defaultName);
  if (!name) return;

  await db.put('dayTrips', {
    id: newId(),
    tripId: state.trip.id,
    trackId: state.activeTrack.id,
    name,
    startIdx: state.segmentStartIdx,
    endIdx: state.segmentEndIdx,
    createdAt: Date.now(),
  });
  state.dayTrips = await db.byIndex('dayTrips', 'tripId', state.trip.id);
  renderList();
  toast('Saved for later');
}

// Reopens a saved day trip: locks the referenced track, restores its
// segment selection, and zooms to just that stretch.
async function openDayTrip(dt) {
  const track = state.tracks.find((t) => t.id === dt.trackId);
  if (!track) { toast('The original route for this day trip is gone'); return; }

  state.activeTrack = track;
  state.trip.activeTrackId = track.id;
  await db.put('trips', state.trip);
  state.gps.setActiveTrack(track.points);
  mapmod.showOnlyTrack(state.groups.track, state.trackLayers, track.id);

  state.segmentStartIdx = dt.startIdx;
  state.segmentEndIdx = dt.endIdx;
  state.segmentRawA = null;
  state.segmentRawB = null;
  mapmod.drawSegmentSelection(state.map, state.segmentGroup, track.points, dt.startIdx, dt.endIdx, null, null);
  updateElevationPanel();
  fitToSegment();
  togglePanel('list-panel', false);
}

async function loadTripData() {
  const tripId = state.trip.id;
  state.tracks = await db.byIndex('tracks', 'tripId', tripId);
  for (const t of state.tracks) {
    t.stats = t.points.length > 1 ? computeProfile(t.points) : null;
  }
  state.waypoints = await db.byIndex('waypoints', 'tripId', tripId);
  state.pois = await poimod.poisForTrip(tripId);
  state.dayTrips = await db.byIndex('dayTrips', 'tripId', tripId);

  // Only ever locked by an explicit action (tapping a track). Never
  // auto-selected just because it's the only one - import is storage, not
  // selection, full stop.
  const lockedId = state.trip.activeTrackId;
  const stillExists = lockedId && state.tracks.some((t) => t.id === lockedId);
  state.activeTrack = stillExists ? state.tracks.find((t) => t.id === lockedId) : null;

  const combinedPoints = [
    ...state.waypoints.map((w) => ({ id: w.id, name: w.name, lat: w.lat, lon: w.lon })),
    ...state.pois.map((p) => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon })),
  ];
  if (state.gps) state.gps.setPoints(combinedPoints);
  if (state.gps) state.gps.setActiveTrack(state.activeTrack ? state.activeTrack.points : null);

  renderMapLayers();
  renderList();
  updateElevationPanel();
}

function fitToSensibleDefault() {
  if (state.activeTrack && state.activeTrack.points.length) {
    fitToTrack(state.activeTrack);
  } else if (state.tracks.length) {
    const allLatLngs = state.tracks.flatMap((t) => t.points.map((p) => [p.lat, p.lon]));
    if (allLatLngs.length) state.map.fitBounds(allLatLngs, { padding: [30, 30] });
  } else if (state.pois.length) {
    state.map.setView([state.pois[0].lat, state.pois[0].lon], 14);
  }
}

function fitToTrack(track) {
  if (!track || track.points.length < 2) return;
  const latlngs = track.points.map((p) => [p.lat, p.lon]);
  state.map.fitBounds(latlngs, { padding: [30, 30] });
}

async function setActiveTrack(track) {
  state.activeTrack = track;
  state.trip.activeTrackId = track ? track.id : null;
  await db.put('trips', state.trip);
  if (track) {
    track.lastWalkedAt = Date.now();
    const { stats, ...toSave } = track; // stats is a derived/cached field, don't persist it
    await db.put('tracks', toSave);
  }
  state.gps.setActiveTrack(track ? track.points : null);
  mapmod.showOnlyTrack(state.groups.track, state.trackLayers, track.id);
  clearSegment();
}

async function unlockTrack() {
  state.activeTrack = null;
  state.trip.activeTrackId = null;
  await db.put('trips', state.trip);
  state.gps.setActiveTrack(null);
  mapmod.applyViewportVisibility(state.map, state.groups.track, state.trackLayers);
  clearSegment();
}

function renderMapLayers() {
  const selectTrack = (track) => {
    if (state.placingPoi || state.measuringSegment) return; // a tap right now means place-POI or pick-a-point, not switch tracks
    setActiveTrack(track);
  };
  state.trackLayers = mapmod.buildTrackLayers(state.tracks, selectTrack);
  if (state.activeTrack) {
    mapmod.showOnlyTrack(state.groups.track, state.trackLayers, state.activeTrack.id);
  } else {
    mapmod.applyViewportVisibility(state.map, state.groups.track, state.trackLayers);
  }
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
  const dayTrips = state.dayTrips.filter((d) => matchesFilter(d.name));

  if (!tracks.length && !waypoints.length && !pois.length && !dayTrips.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    empty.textContent = state.listFilter ? 'No matches.' : 'Nothing here yet. Load a GPX file or add a POI.';
    container.appendChild(empty);
    return;
  }

  for (const t of tracks) {
    const meta = t.stats ? formatDistance(t.stats.stats.distance) : `${t.points.length} pts`;
    const isLocked = state.activeTrack && state.activeTrack.id === t.id;
    container.appendChild(listItem({
      title: (isLocked ? '● ' : '') + t.name,
      meta: isLocked ? meta + ' · walking this one, tap to show all' : meta,
      kindLabel: 'Track',
      onClick: async () => {
        if (isLocked) {
          await unlockTrack();
        } else {
          await setActiveTrack(t);
          fitToTrack(t);
        }
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

  for (const d of dayTrips) {
    const track = state.tracks.find((t) => t.id === d.trackId);
    let meta = 'route missing';
    if (track) {
      const lo = Math.min(d.startIdx, d.endIdx), hi = Math.max(d.startIdx, d.endIdx);
      const segPoints = track.points.slice(lo, hi + 1);
      meta = segPoints.length > 1 ? formatDistance(trackStats(segPoints).distance) : `${segPoints.length} pts`;
    }
    container.appendChild(listItem({
      title: d.name,
      meta,
      kindLabel: 'Day trip',
      kindClass: 'poi',
      onClick: () => openDayTrip(d),
      onDelete: async () => {
        if (!confirm(`Delete saved day trip "${d.name}"? (The route itself is untouched.)`)) return;
        await db.delete('dayTrips', d.id);
        state.dayTrips = await db.byIndex('dayTrips', 'tripId', state.trip.id);
        renderList();
      },
    }));
  }
}

function renderTrackSelectPanel() {
  const container = document.getElementById('track-select-items');
  container.innerHTML = '';

  if (!state.tracks.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    empty.textContent = 'No tracks loaded yet. Import a GPX first.';
    container.appendChild(empty);
    return;
  }

  for (const t of state.tracks) {
    const dist = t.stats ? formatDistance(t.stats.stats.distance) : `${t.points.length} pts`;
    const imported = t.createdAt ? new Date(t.createdAt).toLocaleDateString() : 'unknown date';
    const lastWalked = t.lastWalkedAt ? `walked ${new Date(t.lastWalkedAt).toLocaleDateString()}` : 'not walked yet';
    const isLocked = state.activeTrack && state.activeTrack.id === t.id;
    container.appendChild(listItem({
      title: (isLocked ? '● ' : '') + t.name,
      meta: `${dist} · imported ${imported} · ${lastWalked}` + (isLocked ? ' · walking now, tap to show all' : ''),
      kindLabel: isLocked ? 'Walking' : 'Track',
      kindClass: isLocked ? 'poi' : '',
      onClick: async () => {
        if (isLocked) {
          await unlockTrack();
        } else {
          await setActiveTrack(t);
          fitToTrack(t);
        }
        togglePanel('track-select-panel', false);
      },
      onDelete: async () => {
        if (!confirm(`Delete track "${t.name}"?`)) return;
        await db.delete('tracks', t.id);
        await loadTripData();
        renderTrackSelectPanel();
      },
    }));
  }
}

function updateElevationPanel() {
  const panel = document.getElementById('elevation-panel');
  const track = state.activeTrack;
  const clearBtn = document.getElementById('btn-clear-segment');
  const saveBtn = document.getElementById('btn-save-segment');

  if (!track || track.points.length < 2) {
    panel.classList.add('hidden');
    clearBtn.classList.add('hidden');
    saveBtn.classList.add('hidden');
    return;
  }

  const hasSegment = state.segmentStartIdx != null && state.segmentEndIdx != null;
  clearBtn.classList.toggle('hidden', !hasSegment);
  saveBtn.classList.toggle('hidden', !hasSegment);

  let points, profile, title;
  if (hasSegment) {
    const lo = Math.min(state.segmentStartIdx, state.segmentEndIdx);
    const hi = Math.max(state.segmentStartIdx, state.segmentEndIdx);
    points = track.points.slice(lo, hi + 1);
    profile = points.length > 1 ? computeProfile(points) : null;
    title = `${track.name} — segment (${points.length} pts)`;
  } else {
    points = track.points;
    profile = track.stats;
    title = track.name;
  }

  document.getElementById('elevation-title').textContent = title;
  const chartEl = document.getElementById('elevation-chart');
  const statsEl = document.getElementById('elevation-stats');

  if (!profile) {
    chartEl.innerHTML = '<div class="hint">No elevation data here.</div>';
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
      await db.put('tracks', { id: newId(), tripId: state.trip.id, name, points, createdAt: Date.now() });
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
    const files = Array.from(e.target.files);
    e.target.value = '';
    if (files.length) await handleGpxFiles(files);
  });

  document.getElementById('btn-list').addEventListener('click', () => togglePanel('list-panel'));
  document.getElementById('btn-select-track').addEventListener('click', () => { togglePanel('track-select-panel'); renderTrackSelectPanel(); });
  document.getElementById('btn-close-track-select').addEventListener('click', () => togglePanel('track-select-panel', false));
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

  document.getElementById('btn-export-html').addEventListener('click', async () => {
    if (!state.tracks.length && !state.pois.length && !state.waypoints.length) { toast('Nothing to export'); return; }
    toast('Building export…');
    try {
      const zipBytes = await buildTripZip(state.trip, state.tracks, state.waypoints, state.pois, (done, total) => {
        if (total) toast(`Packing photos: ${done} / ${total}`);
      });
      downloadZipFile(state.trip.name + '-viewer', zipBytes);
      toast('Saved — unzip and open index.html at home, no app needed');
    } catch (err) {
      toast('Export failed: ' + err.message);
    }
  });

  document.getElementById('list-filter').addEventListener('input', (e) => {
    state.listFilter = e.target.value.trim();
    renderList();
  });

  document.getElementById('btn-settings').addEventListener('click', () => { togglePanel('settings-panel'); renderDownloadsList(); });
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
  document.getElementById('btn-photo-poi').addEventListener('click', () => document.getElementById('import-photo-input').click());
  document.getElementById('import-photo-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    e.target.value = '';
    if (!files.length) return;
    await startPoiFromPhoto(files);
  });
  document.getElementById('btn-measure').addEventListener('click', () => setMeasuringMode(!state.measuringSegment));
  document.getElementById('btn-clear-segment').addEventListener('click', clearSegment);
  document.getElementById('btn-save-segment').addEventListener('click', saveDayTrip);

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
    fitToSensibleDefault();
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
    const label = await promptDialog('Name this download (e.g. "Norway day 1-3")', `${source.name} area`);
    if (!label) return;
    const progressEl = document.getElementById('download-progress');
    progressEl.textContent = 'Starting…';
    try {
      const result = await tilesmod.downloadArea(source, state.map.getBounds(), minZoom, maxZoom, label, (done, tot) => {
        progressEl.textContent = `Caching tiles: ${done} / ${tot}`;
      });
      const persistNote = result.persisted
        ? 'Storage marked persistent - less likely to be cleared under low space.'
        : "Couldn't get persistent storage from the browser - keep some free space on your phone before the trip.";
      progressEl.textContent = `Done — ${result.total} tiles, ${formatBytes(result.bytes)} cached. ${persistNote}`;
      toast('Area saved for offline use');
      renderDownloadsList();
    } catch (err) {
      progressEl.textContent = 'Failed: ' + err.message;
    }
  });
}

// Places a POI using a photo's own capture time, matched against the
// active track's timestamped points - no map tap, no GPS needed. Falls
// back to leaving the location unset (GPS or a tap still work from there)
// if there's no time on the photo or no timestamped track to match against.
async function startPoiFromPhoto(files) {
  state.pendingPhotoFiles = files;
  const previewContainer = document.getElementById('poi-photo-preview');
  previewContainer.innerHTML = '';
  for (const f of files) {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(f);
    previewContainer.appendChild(img);
  }

  state.pendingPoiLatLng = null;
  let coordsLabel = 'No location yet - use GPS below, or pick a photo with a matching timestamp';

  const captureTime = await readPhotoCaptureTime(files[0]);
  if (!captureTime) {
    toast("Couldn't read a timestamp from that photo");
  } else if (!state.activeTrack || !state.activeTrack.points.some((p) => p.time)) {
    toast('No timestamped route loaded to match against');
  } else {
    const match = nearestPointByTime(captureTime, state.activeTrack.points);
    if (match) {
      state.pendingPoiLatLng = { lat: match.point.lat, lon: match.point.lon };
      const minutesOff = Math.round(match.diffMs / 60000);
      coordsLabel = `${match.point.lat.toFixed(5)}, ${match.point.lon.toFixed(5)} (matched from photo time, ${minutesOff}m off)`;
      toast(`Location matched from photo time (±${minutesOff}m)`);
    } else {
      toast('No timestamped points on the route to match against');
    }
  }

  openPoiDialog({ keepPhotos: true, coordsLabel });
}

function openPoiDialog({ keepPhotos = false, coordsLabel = null } = {}) {
  document.getElementById('poi-name').value = '';
  document.getElementById('poi-category').value = 'water';
  document.getElementById('poi-notes').value = '';
  if (!keepPhotos) {
    document.getElementById('poi-photo-preview').innerHTML = '';
    state.pendingPhotoFiles = [];
  }
  const coordsEl = document.getElementById('poi-coords');
  coordsEl.textContent = coordsLabel || (state.pendingPoiLatLng
    ? `${state.pendingPoiLatLng.lat.toFixed(5)}, ${state.pendingPoiLatLng.lon.toFixed(5)}`
    : '');
  document.getElementById('poi-dialog').showModal();
}

async function savePoiFromDialog() {
  const name = document.getElementById('poi-name').value.trim();
  if (!name) { toast('Name required'); return; }
  if (!state.pendingPoiLatLng) { toast('No location set — tap the map, use GPS, or pick a matching photo first'); return; }
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

// Parses and stores one file's tracks/waypoints. No trip reload, no map
// movement - that happens once for the whole batch in handleGpxFiles, so
// selecting several files doesn't reload/rezoom once per file.
async function importGpxFile(file) {
  const text = await file.text();
  const { tracks, waypoints } = parseGpx(text);
  for (const t of tracks) {
    await db.put('tracks', { id: newId(), tripId: state.trip.id, name: t.name, points: t.points, createdAt: Date.now() });
  }
  for (const w of waypoints) {
    await db.put('waypoints', { id: newId(), tripId: state.trip.id, name: w.name, lat: w.lat, lon: w.lon, ele: w.ele });
  }
  return { trackCount: tracks.length, waypointCount: waypoints.length };
}

async function handleGpxFiles(files) {
  let totalTracks = 0, totalWaypoints = 0, failed = 0;

  for (const file of files) {
    try {
      const result = await importGpxFile(file);
      totalTracks += result.trackCount;
      totalWaypoints += result.waypointCount;
    } catch (err) {
      failed++;
    }
  }

  if (totalTracks === 0 && totalWaypoints === 0) {
    toast(failed ? `Couldn't read ${failed} file(s)` : 'No tracks or waypoints found');
    return;
  }

  toast(`Loaded ${totalTracks} track(s), ${totalWaypoints} waypoint(s)` + (failed ? ` — ${failed} file(s) failed` : ''));

  // Importing only stores data - it never touches the map. Whatever's
  // currently shown (locked track, or the current view) stays exactly as
  // it was. The new tracks just become available in the list until you
  // deliberately pick one to walk.
  await loadTripData();
}

init();

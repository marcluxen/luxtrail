/* global L */

export const CATEGORY_COLORS = {
  water: '#3b82f6',
  viewpoint: '#8b5cf6',
  junction: '#eab308',
  hazard: '#c65b4a',
  camp: '#22c55e',
  other: '#a9b8ac',
};

export function createMap(elementId) {
  const map = L.map(elementId, { zoomControl: false, attributionControl: true }).setView([13.0, 102.5], 12);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  return map;
}

export function setTileLayer(map, currentLayerRef, source) {
  if (currentLayerRef.layer) {
    map.removeLayer(currentLayerRef.layer);
  }
  const layer = L.tileLayer(source.urlTemplate.replace('{key}', source.apiKey || ''), {
    subdomains: source.subdomains || 'abc',
    maxZoom: source.maxZoom || 18,
    attribution: source.attribution || '',
  });
  layer.addTo(map);
  currentLayerRef.layer = layer;
  currentLayerRef.source = source;
}

// Draws every track once (data actually changed - a trip load, or a track
// added/removed). Returns a Map of id -> layer so the active track can be
// switched later with a style change instead of rebuilding every polyline,
// which matters once a track has tens of thousands of points.
export function drawTracks(map, group, tracks, activeTrackId, onSelect) {
  group.clearLayers();
  const layers = new Map();
  for (const t of tracks) {
    if (!t.points || t.points.length < 2) continue;
    const isActive = t.id === activeTrackId;
    const latlngs = t.points.map((p) => [p.lat, p.lon]);
    const line = L.polyline(latlngs, {
      color: isActive ? '#e07a3f' : '#6b8f78',
      weight: isActive ? 5 : 3,
      opacity: isActive ? 0.95 : 0.55,
    });
    if (!isActive && onSelect) line.on('click', () => onSelect(t));
    group.addLayer(line);
    layers.set(t.id, line);
  }
  return layers;
}

// Cheap re-style when only the active track changes - no geometry rebuild.
export function setActiveTrackStyle(trackLayers, activeTrackId) {
  for (const [id, line] of trackLayers) {
    const isActive = id === activeTrackId;
    line.setStyle({
      color: isActive ? '#e07a3f' : '#6b8f78',
      weight: isActive ? 5 : 3,
      opacity: isActive ? 0.95 : 0.55,
    });
    if (isActive) line.bringToFront();
  }
}

export function drawWaypoints(map, group, waypoints, onClick) {
  group.clearLayers();
  for (const w of waypoints) {
    const marker = L.circleMarker([w.lat, w.lon], {
      radius: 6, color: '#eef0ea', weight: 2, fillColor: '#345040', fillOpacity: 1,
    });
    marker.bindPopup(popupHtml(w.name, null));
    if (onClick) marker.on('click', () => onClick(w));
    group.addLayer(marker);
  }
}

export function drawPois(map, group, pois, onOpen) {
  group.clearLayers();
  for (const poi of pois) {
    const color = CATEGORY_COLORS[poi.category] || CATEGORY_COLORS.other;
    const marker = L.circleMarker([poi.lat, poi.lon], {
      radius: 8, color: '#eef0ea', weight: 2, fillColor: color, fillOpacity: 1,
    });
    marker.bindPopup(popupHtml(poi.name, poi.category));
    marker.on('click', () => onOpen && onOpen(poi));
    group.addLayer(marker);
  }
}

function popupHtml(name, category) {
  const cat = category ? `<div style="opacity:.7;font-size:11px;text-transform:uppercase">${category}</div>` : '';
  return `<div><strong>${escapeHtml(name)}</strong>${cat}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Draws the highlighted sub-section between two picked points on the
// active track, plus A/B markers. group should be a dedicated layer group
// so it can be cleared independently of the main track/waypoint/poi layers.
export function drawSegmentSelection(map, group, points, startIdx, endIdx, rawA, rawB) {
  group.clearLayers();

  function markRawTap(latlng) {
    L.circleMarker([latlng.lat, latlng.lon], {
      radius: 5, color: '#fff', weight: 2, fillColor: '#c65b4a', fillOpacity: 1,
    }).addTo(group).bindTooltip('tapped here');
  }
  if (rawA) markRawTap(rawA);
  if (rawB) markRawTap(rawB);

  if (startIdx == null) return;

  const a = points[startIdx];
  L.marker([a.lat, a.lon], {
    icon: L.divIcon({ className: '', html: '<div class="segment-marker">A</div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
  }).addTo(group);

  if (endIdx == null) return;

  const b = points[endIdx];
  L.marker([b.lat, b.lon], {
    icon: L.divIcon({ className: '', html: '<div class="segment-marker">B</div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
  }).addTo(group);

  const lo = Math.min(startIdx, endIdx), hi = Math.max(startIdx, endIdx);
  const slice = points.slice(lo, hi + 1).map((p) => [p.lat, p.lon]);
  L.polyline(slice, { color: '#3b82f6', weight: 7, opacity: 0.85 }).addTo(group);
}

export function upsertLiveMarker(map, ref, lat, lon, accuracy) {
  if (!ref.marker) {
    ref.marker = L.circleMarker([lat, lon], {
      radius: 8, color: '#fff', weight: 2, fillColor: '#3b82f6', fillOpacity: 1,
    }).addTo(map);
    ref.accuracyCircle = L.circle([lat, lon], { radius: accuracy, color: '#3b82f6', weight: 1, fillOpacity: 0.08 }).addTo(map);
  } else {
    ref.marker.setLatLng([lat, lon]);
    ref.accuracyCircle.setLatLng([lat, lon]);
    ref.accuracyCircle.setRadius(accuracy);
  }
}

const headingIcon = (deg) => L.divIcon({
  className: 'heading-arrow',
  html: `<div style="transform: rotate(${deg}deg);">▲</div>`,
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

export function upsertHeadingArrow(map, ref, lat, lon, heading) {
  if (heading == null || Number.isNaN(heading)) {
    if (ref.headingMarker) { map.removeLayer(ref.headingMarker); ref.headingMarker = null; }
    return;
  }
  if (!ref.headingMarker) {
    ref.headingMarker = L.marker([lat, lon], { icon: headingIcon(heading), interactive: false }).addTo(map);
  } else {
    ref.headingMarker.setLatLng([lat, lon]);
    ref.headingMarker.setIcon(headingIcon(heading));
  }
}

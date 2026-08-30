/* global L */
import { resolveTileUrl } from './tiles.js';

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

export function drawTrack(map, group, points, color = '#e07a3f') {
  group.clearLayers();
  if (!points || points.length < 2) return null;
  const latlngs = points.map((p) => [p.lat, p.lon]);
  const line = L.polyline(latlngs, { color, weight: 4, opacity: 0.9 });
  group.addLayer(line);
  return line;
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
    const marker = L.circleMarker([poi.lat, poi.lon], {
      radius: 8, color: '#e07a3f', weight: 2, fillColor: '#b8632f', fillOpacity: 1,
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

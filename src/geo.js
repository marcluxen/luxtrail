const R = 6371000; // meters

export function toRad(deg) {
  return (deg * Math.PI) / 180;
}

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

// Distance from point P to segment AB, in meters (approx, good enough for hiking scale)
export function distanceToSegment(p, a, b) {
  const latMid = toRad((a.lat + b.lat) / 2);
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(latMid);

  const ax = a.lon * mPerDegLon, ay = a.lat * mPerDegLat;
  const bx = b.lon * mPerDegLon, by = b.lat * mPerDegLat;
  const px = p.lon * mPerDegLon, py = p.lat * mPerDegLat;

  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

export function distanceToTrack(p, points) {
  if (!points || points.length === 0) return Infinity;
  if (points.length === 1) return haversine(p.lat, p.lon, points[0].lat, points[0].lon);
  let min = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const d = distanceToSegment(p, points[i], points[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

// Searches only segments near a known index instead of the whole track -
// O(window) instead of O(n), which matters once a track has tens of
// thousands of points (a multi-day route) and this runs on every GPS fix.
// step > 1 turns this into a sparse sample pass (used once to bootstrap a
// starting position, never per-fix).
export function nearestSegmentInRange(p, points, startIdx, endIdx, step = 1) {
  const s = Math.max(0, startIdx);
  const e = Math.min(points.length - 2, endIdx);
  let min = Infinity, idx = s;
  for (let i = s; i <= e; i += step) {
    const d = distanceToSegment(p, points[i], points[i + 1]);
    if (d < min) { min = d; idx = i; }
  }
  return { distance: min, index: idx };
}

// One-off nearest-point lookup for a tap-to-select action (not the live
// per-GPS-fix hot path), so a full scan is fine even on a large track -
// it runs once per tap, not dozens of times a minute.
export function nearestPointIndex(latlng, points) {
  let min = Infinity, idx = 0;
  for (let i = 0; i < points.length; i++) {
    const d = haversine(latlng.lat, latlng.lon, points[i].lat, points[i].lon);
    if (d < min) { min = d; idx = i; }
  }
  return idx;
}

// One-off lookup by time instead of distance - used to place a photo on
// the route using its own capture timestamp rather than GPS/manual tap.
// Skips any point with no time data (e.g. a pre-planned GPX with no
// timestamps at all - nothing to match against there).
export function nearestPointByTime(targetTime, points) {
  let min = Infinity, best = null;
  const targetMs = targetTime.getTime();
  for (const p of points) {
    if (!p.time) continue;
    const t = new Date(p.time).getTime();
    if (Number.isNaN(t)) continue;
    const diff = Math.abs(t - targetMs);
    if (diff < min) { min = diff; best = p; }
  }
  return best ? { point: best, diffMs: min } : null;
}

export function trackStats(points) {
  let distance = 0, gain = 0, loss = 0;
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    const d = haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    distance += d;
    cumulative.push(distance);
    const e0 = points[i - 1].ele, e1 = points[i].ele;
    if (e0 != null && e1 != null) {
      const diff = e1 - e0;
      if (diff > 0) gain += diff; else loss += -diff;
    }
  }
  let duration = null;
  const t0 = points[0]?.time, t1 = points[points.length - 1]?.time;
  if (t0 && t1) duration = (new Date(t1) - new Date(t0)) / 1000;
  return { distance, gain, loss, duration, cumulative };
}

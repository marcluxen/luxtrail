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

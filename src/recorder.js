import { haversine } from './geo.js';

const MIN_DISTANCE_M = 6;   // don't record a new point unless you've moved at least this far
const MAX_INTERVAL_MS = 30000; // ...unless this long has passed anyway, so a rest stop doesn't leave a gap

export class TrackRecorder {
  constructor() {
    this.points = [];
    this.recording = false;
    this.lastRecordedAt = 0;
  }

  start() {
    this.points = [];
    this.recording = true;
    this.lastRecordedAt = 0;
  }

  stop() {
    this.recording = false;
    return this.points;
  }

  // Returns the newly added point, or null if this fix was throttled away -
  // callers use that to know whether the map line actually needs updating.
  addFix(info) {
    if (!this.recording) return null;

    const now = Date.now();
    const last = this.points[this.points.length - 1];
    if (last) {
      const moved = haversine(last.lat, last.lon, info.lat, info.lon);
      const elapsed = now - this.lastRecordedAt;
      if (moved < MIN_DISTANCE_M && elapsed < MAX_INTERVAL_MS) return null;
    }

    const point = {
      lat: info.lat,
      lon: info.lon,
      ele: info.alt != null ? info.alt : null,
      time: new Date().toISOString(),
    };
    this.points.push(point);
    this.lastRecordedAt = now;
    return point;
  }
}

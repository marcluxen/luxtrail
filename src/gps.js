import { haversine, bearing, nearestSegmentInRange } from './geo.js';

const OFF_TRACK_THRESHOLD_M = 50;
const SEARCH_WINDOW = 40; // segments each side of the last known position
const RELOCATE_THRESHOLD_M = 300; // widen the window if the match is this far off
const WINDOW_GROWTH = [1, 5, 25]; // multiples of SEARCH_WINDOW tried, widest wins if none land inside RELOCATE_THRESHOLD_M
const COARSE_STEP = 25; // sparse sample used once to bootstrap the very first fix on a track - never a full per-point scan, and never repeated

export class GpsTracker {
  constructor({ onPosition, onError }) {
    this.watchId = null;
    this.onPosition = onPosition;
    this.onError = onError;
    this.activeTrackPoints = null;
    this.lastSegmentIndex = null;
    this.points = []; // combined waypoints + pois: {id, name, lat, lon}
  }

  setActiveTrack(points) {
    this.activeTrackPoints = points || null;
    this.lastSegmentIndex = null; // new track - unknown where we are on it
  }

  setPoints(points) {
    this.points = points || [];
  }

  start() {
    if (!('geolocation' in navigator)) {
      this.onError && this.onError(new Error('Geolocation not supported'));
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this._handlePosition(pos),
      (err) => this.onError && this.onError(err),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
  }

  stop() {
    if (this.watchId != null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  _locateOnTrack(p) {
    const points = this.activeTrackPoints;
    const maxIndex = points.length - 2;

    if (this.lastSegmentIndex == null) {
      // First fix on this track: one sparse pass to find roughly where we
      // are, then refine locally. Runs once per track, never per fix.
      const coarse = nearestSegmentInRange(p, points, 0, maxIndex, COARSE_STEP);
      return nearestSegmentInRange(p, points, coarse.index - SEARCH_WINDOW, coarse.index + SEARCH_WINDOW);
    }

    // Anchored to the last known position - never re-scans the whole
    // track, just widens the local window a few steps if needed.
    let best = null;
    for (const mult of WINDOW_GROWTH) {
      const w = SEARCH_WINDOW * mult;
      best = nearestSegmentInRange(p, points, this.lastSegmentIndex - w, this.lastSegmentIndex + w);
      if (best.distance <= RELOCATE_THRESHOLD_M) return best;
    }
    return best; // widest local window tried - accept it rather than ever scanning the full track
  }

  _handlePosition(pos) {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    const accuracy = pos.coords.accuracy;

    let offTrackMeters = null;
    if (this.activeTrackPoints && this.activeTrackPoints.length > 1) {
      const result = this._locateOnTrack({ lat, lon });
      offTrackMeters = result.distance;
      this.lastSegmentIndex = result.index;
    }

    let nextInfo = null;
    if (this.points.length) {
      let nearest = null, nearestDist = Infinity;
      for (const p of this.points) {
        const d = haversine(lat, lon, p.lat, p.lon);
        if (d < nearestDist) { nearestDist = d; nearest = p; }
      }
      if (nearest) {
        nextInfo = {
          id: nearest.id,
          name: nearest.name,
          distance: nearestDist,
          bearing: bearing(lat, lon, nearest.lat, nearest.lon),
        };
      }
    }

    this.onPosition({
      lat, lon, accuracy,
      alt: pos.coords.altitude,
      heading: pos.coords.heading,
      offTrackMeters,
      isOffTrack: offTrackMeters != null && offTrackMeters > OFF_TRACK_THRESHOLD_M,
      nextInfo,
    });
  }
}

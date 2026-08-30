import { haversine, bearing, distanceToTrack } from './geo.js';

const OFF_TRACK_THRESHOLD_M = 50;

export class GpsTracker {
  constructor({ onPosition, onError }) {
    this.watchId = null;
    this.onPosition = onPosition;
    this.onError = onError;
    this.activeTrackPoints = null;
    this.points = []; // combined waypoints + pois: {id, name, lat, lon}
  }

  setActiveTrack(points) {
    this.activeTrackPoints = points || null;
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

  _handlePosition(pos) {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    const accuracy = pos.coords.accuracy;

    let offTrackMeters = null;
    if (this.activeTrackPoints && this.activeTrackPoints.length > 1) {
      offTrackMeters = distanceToTrack({ lat, lon }, this.activeTrackPoints);
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

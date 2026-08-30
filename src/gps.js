import { haversine, bearing, distanceToTrack } from './geo.js';

const OFF_TRACK_THRESHOLD_M = 50;

export class GpsTracker {
  constructor({ onPosition, onError }) {
    this.watchId = null;
    this.onPosition = onPosition;
    this.onError = onError;
    this.activeTrackPoints = null;
    this.nextWaypoint = null;
  }

  setActiveTrack(points) {
    this.activeTrackPoints = points || null;
  }

  setNextWaypoint(wpt) {
    this.nextWaypoint = wpt || null;
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
    if (this.nextWaypoint) {
      nextInfo = {
        distance: haversine(lat, lon, this.nextWaypoint.lat, this.nextWaypoint.lon),
        bearing: bearing(lat, lon, this.nextWaypoint.lat, this.nextWaypoint.lon),
      };
    }

    this.onPosition({
      lat, lon, accuracy,
      offTrackMeters,
      isOffTrack: offTrackMeters != null && offTrackMeters > OFF_TRACK_THRESHOLD_M,
      nextInfo,
    });
  }
}

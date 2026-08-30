export class TrackRecorder {
  constructor() {
    this.points = [];
    this.recording = false;
  }

  start() {
    this.points = [];
    this.recording = true;
  }

  stop() {
    this.recording = false;
    return this.points;
  }

  addFix(info) {
    if (!this.recording) return;
    this.points.push({
      lat: info.lat,
      lon: info.lon,
      ele: info.alt != null ? info.alt : null,
      time: new Date().toISOString(),
    });
  }
}

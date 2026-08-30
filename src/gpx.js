function text(el, sel) {
  const n = el.querySelector(sel);
  return n ? n.textContent.trim() : null;
}

export function parseGpx(xmlString) {
  const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Invalid GPX file');
  }

  const tracks = [];
  doc.querySelectorAll('trk').forEach((trk) => {
    const name = text(trk, 'name') || 'Track';
    const points = [];
    trk.querySelectorAll('trkpt').forEach((pt) => {
      const lat = parseFloat(pt.getAttribute('lat'));
      const lon = parseFloat(pt.getAttribute('lon'));
      const ele = text(pt, 'ele');
      const time = text(pt, 'time');
      points.push({
        lat, lon,
        ele: ele !== null ? parseFloat(ele) : null,
        time: time || null,
      });
    });
    if (points.length) tracks.push({ name, points });
  });

  const waypoints = [];
  doc.querySelectorAll('wpt').forEach((wpt) => {
    const lat = parseFloat(wpt.getAttribute('lat'));
    const lon = parseFloat(wpt.getAttribute('lon'));
    const ele = text(wpt, 'ele');
    waypoints.push({
      name: text(wpt, 'name') || 'Waypoint',
      lat, lon,
      ele: ele !== null ? parseFloat(ele) : null,
    });
  });

  return { tracks, waypoints };
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildGpx({ tracks = [], waypoints = [] }) {
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="luxtrail" xmlns="http://www.topografix.com/GPX/1/1">\n`;

  for (const wpt of waypoints) {
    out += `  <wpt lat="${wpt.lat}" lon="${wpt.lon}">\n`;
    if (wpt.ele != null) out += `    <ele>${wpt.ele}</ele>\n`;
    out += `    <name>${esc(wpt.name || '')}</name>\n`;
    if (wpt.notes) out += `    <desc>${esc(wpt.notes)}</desc>\n`;
    out += `  </wpt>\n`;
  }

  for (const trk of tracks) {
    out += `  <trk>\n    <name>${esc(trk.name || 'Track')}</name>\n    <trkseg>\n`;
    for (const pt of trk.points) {
      out += `      <trkpt lat="${pt.lat}" lon="${pt.lon}">`;
      if (pt.ele != null) out += `<ele>${pt.ele}</ele>`;
      if (pt.time) out += `<time>${pt.time}</time>`;
      out += `</trkpt>\n`;
    }
    out += `    </trkseg>\n  </trk>\n`;
  }

  out += `</gpx>\n`;
  return out;
}

export function downloadGpxFile(filename, gpxString) {
  const blob = new Blob([gpxString], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.gpx') ? filename : `${filename}.gpx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

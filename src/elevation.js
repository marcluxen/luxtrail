import { trackStats } from './geo.js';

export function computeProfile(points) {
  const withEle = points.filter((p) => p.ele != null);
  if (withEle.length < 2) return null;
  const stats = trackStats(points);
  return { points, stats };
}

export function renderElevationSvg(points, stats, width = 320, height = 90) {
  const eles = points.map((p) => p.ele).filter((e) => e != null);
  if (eles.length < 2) return '';
  const min = Math.min(...eles);
  const max = Math.max(...eles);
  const range = Math.max(1, max - min);
  const totalDist = stats.distance || 1;

  const pathPoints = points.map((p, i) => {
    const x = (stats.cumulative[i] / totalDist) * width;
    const y = p.ele != null ? height - ((p.ele - min) / range) * height : height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const areaPoints = `0,${height} ${pathPoints.join(' ')} ${width},${height}`;

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none">
      <polygon points="${areaPoints}" fill="#4a7c59" opacity="0.35"></polygon>
      <polyline points="${pathPoints.join(' ')}" fill="none" stroke="#e07a3f" stroke-width="2"></polyline>
    </svg>
  `;
}

export function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export function formatDuration(seconds) {
  if (seconds == null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

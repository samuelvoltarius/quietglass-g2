import type { LatLng } from "../geo/geometry";

/**
 * Route overview projection, ported from Map Glass (apps/map-glass) together
 * with its fixes: one scale for both axes so turns keep their real angles,
 * centring so a due-north route is not pinned to an edge, and longitudes taken
 * the short way so a route across the antimeridian stays in one piece.
 */

export interface PixelPoint { readonly x: number; readonly y: number; }

/** Smallest signed longitude difference, in -180…180, so a route across the antimeridian stays contiguous. */
export function wrapLongitude(delta: number): number {
  return ((((delta + 180) % 360) + 360) % 360) - 180;
}

/** A geographic box: south, west, north, east in degrees. */
export interface BBox { readonly south: number; readonly west: number; readonly north: number; readonly east: number; }

/** The fitted transform of one route into one viewport, reusable for anything else drawn on that map. */
export interface Projector {
  readonly toPixel: (point: LatLng) => PixelPoint;
  /** The area the whole viewport shows, edges included; null when the route has no extent to scale by. */
  readonly bounds: BBox | null;
}

/**
 * Fits the route into the viewport with one scale for both axes (equirectangular,
 * longitude shrunk by cos(lat)), centred, so turns keep their real angles and a
 * straight north–south or east–west route is not pinned to an edge.
 */
export function fitProjection(points: readonly LatLng[], width: number, height: number, padding = 18): Projector | null {
  const first = points[0];
  if (!first) return null;
  // Loops rather than Math.min(...array): a long route has tens of thousands
  // of points, more than a spread call may pass as arguments.
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const point of points) {
    const lat = point.lat, lon = first.lon + wrapLongitude(point.lon - first.lon);
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const spanX = (maxLon - minLon) * kx;
  const spanY = maxLat - minLat;
  const innerWidth = Math.max(0, width - padding * 2);
  const innerHeight = Math.max(0, height - padding * 2);
  const fit = Math.min(
    spanX > 1e-9 ? innerWidth / spanX : Number.POSITIVE_INFINITY,
    spanY > 1e-9 ? innerHeight / spanY : Number.POSITIVE_INFINITY,
  );
  const scale = Number.isFinite(fit) ? fit : 0;
  const left = padding + (innerWidth - spanX * scale) / 2;
  const bottom = height - padding - (innerHeight - spanY * scale) / 2;
  const toPixel = (point: LatLng): PixelPoint => ({
    x: left + (first.lon + wrapLongitude(point.lon - first.lon) - minLon) * kx * scale,
    y: bottom - (point.lat - minLat) * scale,
  });
  const lonScale = kx * scale;
  const bounds = scale > 0 && lonScale > 1e-12 ? {
    south: minLat + (bottom - height) / scale,
    north: minLat + bottom / scale,
    west: minLon + (0 - left) / lonScale,
    east: minLon + (width - left) / lonScale,
  } : null;
  return { toPixel, bounds };
}

/** Projects the route itself; see {@link fitProjection}. */
export function project(points: readonly LatLng[], width: number, height: number, padding = 18): PixelPoint[] {
  const projector = fitProjection(points, width, height, padding);
  return projector ? points.map(projector.toPixel) : [];
}

/**
 * Keeps at most `max` points, evenly spaced, always including the first and
 * last. A 288 px image cannot show more detail than that, and drawing and
 * encoding a 20 000-point line on every fix costs battery for nothing.
 */
export function thinPoints<T>(points: readonly T[], max = 600): T[] {
  if (points.length <= max || max < 2) return [...points];
  const out: T[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    const point = points[Math.round(i * step)];
    if (point !== undefined) out.push(point);
  }
  return out;
}

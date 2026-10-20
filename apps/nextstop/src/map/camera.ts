import type { LatLon } from "../route/walk";
import { metresBetween } from "../transit/types";
import type { PixelPoint } from "./streets";

/**
 * Where the walking map looks: projection, camera and the rule for when the
 * picture is worth sending again.
 *
 * Like OpenGlance's walking map the picture turns with the walker: the
 * direction the route runs from here is up (heading-up) and the walker sits
 * low on the picture, so the way ahead gets most of the room. With no
 * direction (standing on the last metres of the route) north is up and the
 * walker is a dot in the middle. The scale moves in steps, never smoothly,
 * so a picture is not resent just because the scale drifted.
 *
 * Everything here is pure: the same input gives the same view.
 */

/** The map area: the two left tiles of the cockpit, above the hint line. */
export const MAP_W = 288;
export const MAP_H = 254;
/** Where the walker is drawn: low on the picture while the map is turned, in the middle otherwise. */
export const MARKER_HEADING: PixelPoint = { x: 144, y: 178 };
export const MARKER_NORTH: PixelPoint = { x: 144, y: 127 };
/** Metres the picture is wide: the scale steps. Never less than 150 m, never more than 1.2 km. */
export const SPAN_LEVELS_M: readonly number[] = [150, 220, 320, 480, 700, 1000, 1200];
/** Clearance kept between a point that must be seen and the edge of the picture. */
const PAD = 28;
/** The direction is taken from the route this far ahead. */
const LOOK_AHEAD_M = 60;

/** A redraw is worth it once the walker moved this far, turned this much, or the scale stepped. */
export const MOVE_M = 8;
export const TURN_DEG = 10;
/** And never more often than this. */
export const MIN_REDRAW_MS = 4_000;

export interface MapView {
  /** Where the walker is. */
  readonly user: LatLon;
  /** The direction drawn upwards, degrees clockwise from north; null = north is up. */
  readonly bearing: number | null;
  /** Metres across the picture, one of {@link SPAN_LEVELS_M}. */
  readonly spanM: number;
}

const M_LAT = 110_540;
const M_LON = 111_320;
const rad = (degrees: number): number => (degrees * Math.PI) / 180;

/** Flat metres east and north of `origin` (good to centimetres over the few hundred metres of a walk). */
export function localMetres(origin: LatLon, point: LatLon): { readonly x: number; readonly y: number } {
  return { x: (point.lon - origin.lon) * M_LON * Math.cos(rad(origin.lat)), y: (point.lat - origin.lat) * M_LAT };
}

export const markerFor = (bearing: number | null): PixelPoint => (bearing === null ? MARKER_NORTH : MARKER_HEADING);

/** The function that places a geographic point on the map picture. */
export function mapProjector(view: MapView): (point: LatLon) => PixelPoint {
  const pixelsPerMetre = MAP_W / view.spanM;
  const theta = rad(view.bearing ?? 0);
  const sin = Math.sin(theta); const cos = Math.cos(theta);
  const marker = markerFor(view.bearing);
  return (point) => {
    const { x: east, y: north } = localMetres(view.user, point);
    // Forward is up: the component along the direction of travel, and the one to its right.
    const ahead = east * sin + north * cos;
    const right = east * cos - north * sin;
    return { x: marker.x + right * pixelsPerMetre, y: marker.y - ahead * pixelsPerMetre };
  };
}

export interface Located {
  /** Index of the shape point that starts the segment the walker is nearest to. */
  readonly index: number;
  /** The nearest point on the route. */
  readonly point: LatLon;
  /** Metres from the walker to it. */
  readonly off: number;
}

/** The nearest point of a route to `at`. Null for a route with no segment. */
export function locate(shape: readonly LatLon[], at: LatLon): Located | null {
  if (shape.length < 2) return null;
  let best: Located | null = null;
  for (let i = 1; i < shape.length; i += 1) {
    const a = localMetres(at, shape[i - 1]!); const b = localMetres(at, shape[i]!);
    const dx = b.x - a.x; const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / len2));
    const off = Math.hypot(a.x + u * dx, a.y + u * dy);
    if (best === null || off < best.off) {
      const from = shape[i - 1]!; const to = shape[i]!;
      best = { index: i - 1, off, point: { lat: from.lat + (to.lat - from.lat) * u, lon: from.lon + (to.lon - from.lon) * u } };
    }
  }
  return best;
}

/** The part of the route still to walk: from the nearest point on it to its end. */
export function remainingRoute(shape: readonly LatLon[], at: LatLon): LatLon[] {
  const near = locate(shape, at);
  if (!near) return [...shape];
  return [near.point, ...shape.slice(near.index + 1)];
}

/** The compass direction (degrees, 0..359) from `from` to `to`. */
export function bearingBetween(from: LatLon, to: LatLon): number {
  const { x, y } = localMetres(from, to);
  return (Math.round((Math.atan2(x, y) * 180) / Math.PI) + 360) % 360;
}

/** The direction the path runs from its start, looking about `lookAhead` metres along it; null when it has no length. */
export function courseAhead(path: readonly LatLon[], lookAhead = LOOK_AHEAD_M): number | null {
  const first = path[0];
  if (!first || path.length < 2) return null;
  let travelled = 0;
  let from = first;
  for (let i = 1; i < path.length; i += 1) {
    const next = path[i]!;
    const step = metresBetween(from.lat, from.lon, next.lat, next.lon);
    if (travelled + step >= lookAhead) {
      const f = step > 0 ? (lookAhead - travelled) / step : 1;
      const target = { lat: from.lat + (next.lat - from.lat) * f, lon: from.lon + (next.lon - from.lon) * f };
      return metresBetween(first.lat, first.lon, target.lat, target.lon) > 3 ? bearingBetween(first, target) : null;
    }
    travelled += step;
    from = next;
  }
  // The last stretch is shorter than the look-ahead: face the end of the route.
  return metresBetween(first.lat, first.lon, from.lat, from.lon) > 3 ? bearingBetween(first, from) : null;
}

/** The smallest step of the scale that shows everything. */
export function spanFor(bearing: number | null, user: LatLon, points: readonly LatLon[]): number {
  const theta = rad(bearing ?? 0);
  const sin = Math.sin(theta); const cos = Math.cos(theta);
  const marker = markerFor(bearing);
  let right = 0; let ahead = 0; let behind = 0;
  for (const point of points) {
    const { x, y } = localMetres(user, point);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const forward = x * sin + y * cos;
    right = Math.max(right, Math.abs(x * cos - y * sin));
    ahead = Math.max(ahead, forward);
    behind = Math.max(behind, -forward);
  }
  const room = (pixels: number, metres: number): number => (metres > 0 ? (pixels - PAD) / metres : Number.POSITIVE_INFINITY);
  const pixelsPerMetre = Math.min(room(MAP_W / 2, right), room(marker.y, ahead), room(MAP_H - marker.y, behind));
  if (!Number.isFinite(pixelsPerMetre) || pixelsPerMetre <= 0) return pixelsPerMetre <= 0 ? SPAN_LEVELS_M[SPAN_LEVELS_M.length - 1]! : SPAN_LEVELS_M[0]!;
  const needed = MAP_W / pixelsPerMetre;
  return SPAN_LEVELS_M.find((level) => level >= needed) ?? SPAN_LEVELS_M[SPAN_LEVELS_M.length - 1]!;
}

/**
 * The view for a walker on a route towards `target`: turned to the course of
 * the rest of the route, at the scale where the rest of the walk fits.
 */
export function cameraFor(shape: readonly LatLon[], user: LatLon, target: LatLon): MapView {
  const rest = remainingRoute(shape, user);
  const bearing = courseAhead(rest)
    ?? (metresBetween(user.lat, user.lon, target.lat, target.lon) > 6 ? bearingBetween(user, target) : null);
  return { user, bearing, spanM: spanFor(bearing, user, [...rest, target]) };
}

/** Smallest difference of two compass directions, 0..180. */
export function angleBetween(a: number, b: number): number {
  return Math.abs(((((a - b) % 360) + 540) % 360) - 180);
}

/** The view that is on the glasses, and when it was put there. */
export interface Settled {
  readonly view: MapView;
  readonly at: number;
}

/** Whether `next` differs from `shown` enough to redraw the map. */
export function worthRedrawing(shown: MapView, next: MapView): boolean {
  if (next.spanM !== shown.spanM) return true;
  if ((shown.bearing === null) !== (next.bearing === null)) return true;
  if (shown.bearing !== null && next.bearing !== null && angleBetween(shown.bearing, next.bearing) >= TURN_DEG) return true;
  return metresBetween(shown.user.lat, shown.user.lon, next.user.lat, next.user.lon) >= MOVE_M;
}

/**
 * Keeps the map still while it would barely change: the new view is taken
 * over once the walker moved 8 m or turned 10 degrees or the scale stepped,
 * but not more often than every 4 s. Until then the old view is returned
 * as it was, so its pixels - and with them its tiles - stay the same and
 * nothing is sent.
 */
export function settleView(previous: Settled | null, next: MapView, nowMs: number): Settled {
  if (previous === null) return { view: next, at: nowMs };
  if (!worthRedrawing(previous.view, next) || nowMs - previous.at < MIN_REDRAW_MS) return previous;
  return { view: next, at: nowMs };
}

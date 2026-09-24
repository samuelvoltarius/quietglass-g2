/**
 * Geodesy, kept to what navigation on a 576×288 display actually needs.
 */

export interface LatLng {
  readonly lat: number;
  readonly lon: number;
}

const EARTH_RADIUS_M = 6_371_008.8;

export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

/** Great-circle distance in metres. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, in degrees clockwise from north. */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLon = toRadians(b.lon - a.lon);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest signed difference between two bearings, in -180…180. */
export function bearingDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

/**
 * Decodes a Google/Valhalla encoded polyline.
 *
 * Valhalla uses precision 6 by default, Google and OSRM use 5. Getting this
 * wrong silently misplaces the whole route by a factor of ten, so the
 * precision is an explicit argument rather than a guess.
 */
export function decodePolyline(encoded: string, precision = 6): LatLng[] {
  const factor = Math.pow(10, precision);
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / factor, lon: lon / factor });
  }

  return points;
}

export interface Projection {
  /** Closest point on the line. */
  readonly point: LatLng;
  /** Index of the segment start. */
  readonly index: number;
  /** Distance from the query point to the line, in metres. */
  readonly distance: number;
  /** How far along that segment, 0…1. */
  readonly t: number;
}

/**
 * Projects a position onto the route.
 *
 * Used both to know where on the route the user is and to decide whether they
 * have left it. Works in a local flat approximation, which is exact enough at
 * the scale of a road segment and far cheaper than spherical maths on every
 * GPS update.
 */
export function projectOntoPath(point: LatLng, path: readonly LatLng[]): Projection | null {
  if (path.length === 0) return null;
  const first = path[0];
  if (!first) return null;
  if (path.length === 1) {
    return { point: first, index: 0, distance: distanceMeters(point, first), t: 0 };
  }

  // Metres per degree at this latitude, so x and y are comparable.
  const mPerLat = 111_320;
  const mPerLon = 111_320 * Math.cos(toRadians(point.lat));
  const px = point.lon * mPerLon;
  const py = point.lat * mPerLat;

  let best: Projection | null = null;

  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (!a || !b) continue;

    const ax = a.lon * mPerLon, ay = a.lat * mPerLat;
    const bx = b.lon * mPerLon, by = b.lat * mPerLat;
    const dx = bx - ax, dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;

    const t = lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));

    const projected: LatLng = {
      lat: (ay + t * dy) / mPerLat,
      lon: (ax + t * dx) / mPerLon,
    };
    const distance = distanceMeters(point, projected);

    if (!best || distance < best.distance) {
      best = { point: projected, index: i, distance, t };
    }
  }

  return best;
}

/** Remaining distance along the path from a projection to its end. */
export function remainingAlong(path: readonly LatLng[], projection: Projection): number {
  let total = 0;
  const startSegmentEnd = path[projection.index + 1];
  if (startSegmentEnd) total += distanceMeters(projection.point, startSegmentEnd);

  for (let i = projection.index + 1; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (a && b) total += distanceMeters(a, b);
  }
  return total;
}

/** "250 m" / "1.4 km" — the precision a driver can act on, and no more. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "--";
  if (meters < 20) return "now";
  if (meters < 1000) return String(Math.round(meters / 10) * 10) + " m";
  if (meters < 10_000) return (meters / 1000).toFixed(1) + " km";
  return String(Math.round(meters / 1000)) + " km";
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--";
  const total = Math.round(seconds / 60);
  if (total < 60) return total + " min";
  return Math.floor(total / 60) + " h " + (total % 60) + " min";
}

/** Clock time of arrival, which is what people actually want to know. */
export function formatEta(seconds: number, now: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--";
  const arrival = new Date(now + seconds * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return pad(arrival.getHours()) + ":" + pad(arrival.getMinutes());
}

import { bearingDegrees, distanceMeters, projectOntoPath, toRadians, type LatLng } from "../geo/geometry";
import { wrapLongitude, type PixelPoint } from "./project";

/**
 * Where the map looks.
 *
 * The map fills the whole 576 × 288 display and is centred on the car, which
 * sits low on the picture so the road ahead gets most of the room, like a
 * satnav in a car. The map turns so that the direction of travel is up
 * (heading-up) whenever a direction is known, and has north up otherwise.
 *
 * The zoom is not continuous: it moves in steps, chosen so the next turn is
 * always on the picture. A step changes only now and then, which keeps the
 * picture from being resent just because the scale drifted.
 */

export const MAP_WIDTH = 576;
export const MAP_HEIGHT = 288;
export const TILE_WIDTH = 288;
export const TILE_HEIGHT = 144;
/** The four image containers of the map, left to right, top to bottom. */
export const MAP_TILES = [
  { name: "map-nw", x: 0, y: 0 },
  { name: "map-ne", x: TILE_WIDTH, y: 0 },
  { name: "map-sw", x: 0, y: TILE_HEIGHT },
  { name: "map-se", x: TILE_WIDTH, y: TILE_HEIGHT },
] as const;

/** The black plate behind the text on the top left, so it reads against any road. */
export const PLATE = { width: 232, height: 40 } as const;

/** Where the car is drawn: bottom centre, leaving the road ahead the room above. */
export const MARKER_AT: PixelPoint = { x: MAP_WIDTH / 2, y: 218 };
/** Pixels the "range" spans ahead of the marker. */
export const RANGE_PX = 190;
/** The visible stretch ahead of the car, in metres, to choose from. */
export const RANGE_LEVELS_M: readonly number[] = [150, 300, 600, 1200, 2500, 5000, 10_000, 20_000, 40_000, 80_000];
/** The next turn is placed at this share of the range, so it never sits at the very edge. */
const TURN_SHARE = 0.85;

/** The smallest range at which a turn `distanceToTurn` metres ahead is comfortably on the picture. */
export function rangeFor(distanceToTurn: number): number {
  const wanted = (Number.isFinite(distanceToTurn) ? Math.max(0, distanceToTurn) : 0) / TURN_SHARE;
  return RANGE_LEVELS_M.find((level) => level >= wanted) ?? RANGE_LEVELS_M[RANGE_LEVELS_M.length - 1]!;
}

export interface MapView {
  /** The geographic point drawn at {@link MARKER_AT}. */
  readonly center: LatLng;
  /** Direction of travel in degrees clockwise from north, drawn upwards; null = north is up. */
  readonly bearing: number | null;
  /** Metres from the car to the top of the picture's reach, see {@link RANGE_PX}. */
  readonly range: number;
}

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320;

/** The function that places a geographic point on the map picture. */
export function mapProjector(view: MapView): (point: LatLng) => PixelPoint {
  const pixelsPerMeter = RANGE_PX / view.range;
  const theta = toRadians(view.bearing ?? 0);
  const sin = Math.sin(theta), cos = Math.cos(theta);
  const kx = Math.cos(toRadians(view.center.lat)) * M_PER_DEG_LON;
  return (point) => {
    const east = wrapLongitude(point.lon - view.center.lon) * kx;
    const north = (point.lat - view.center.lat) * M_PER_DEG_LAT;
    // Forward is up: the component along the direction of travel, and the one to its right.
    const ahead = east * sin + north * cos;
    const right = east * cos - north * sin;
    return { x: MARKER_AT.x + right * pixelsPerMeter, y: MARKER_AT.y - ahead * pixelsPerMeter };
  };
}

/**
 * The direction the route runs from `position`, looking about `lookAhead`
 * metres along it — the direction a driver on the route is facing. Null when
 * there is no route or it has no length.
 */
export function courseAhead(route: readonly LatLng[], position: LatLng, lookAhead = 80): number | null {
  const projection = projectOntoPath(position, route);
  if (!projection || route.length < 2) return null;
  let from = projection.point;
  let travelled = 0;
  for (let i = projection.index + 1; i < route.length; i++) {
    const next = route[i]!;
    const step = distanceMeters(from, next);
    if (travelled + step >= lookAhead) {
      const t = step > 0 ? (lookAhead - travelled) / step : 1;
      const target = { lat: from.lat + (next.lat - from.lat) * t, lon: from.lon + wrapLongitude(next.lon - from.lon) * t };
      return distanceMeters(projection.point, target) > 1 ? bearingDegrees(projection.point, target) : null;
    }
    travelled += step;
    from = next;
  }
  // The last stretch is shorter than the look-ahead: face the end of the route.
  const end = route[route.length - 1]!;
  return distanceMeters(projection.point, end) > 3 ? bearingDegrees(projection.point, end) : null;
}

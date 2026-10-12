import { bearingDelta, distanceMeters, type LatLng } from "../geo/geometry";

/**
 * When the map is worth sending again.
 *
 * The map is four images, about 80 kB over Bluetooth, and it moves with the
 * car, so it is sent only when the picture really changed: a new route,
 * streets that arrived, the next turn moving on, a new zoom step. Driving
 * along the route moves the car and turns the map a little at every GPS fix;
 * that waits until the change is visible and some seconds have passed.
 */
export interface MapFrame {
  /** Bumped for every new route. */
  readonly route: number;
  /** Bumped when streets for the route arrive. */
  readonly streets: number;
  readonly maneuver: number;
  /** The zoom step in metres, see rangeFor. */
  readonly range: number;
  readonly position: LatLng | null;
  /** Direction of travel drawn upwards, or null when north is up. */
  readonly bearing: number | null;
  /** When this frame would be sent, in ms. */
  readonly at: number;
}

/** The car and the map orientation update at most this often. */
export const MAP_MIN_INTERVAL_MS = 4_000;
/** …and only once the car has moved this many metres… */
export const MAP_MIN_MOVE_M = 12;
/** …or the map has to turn this many degrees. */
export const MAP_MIN_TURN_DEG = 12;

export function needsMapImage(
  sent: MapFrame | null,
  next: MapFrame,
  minIntervalMs = MAP_MIN_INTERVAL_MS,
  minMoveM = MAP_MIN_MOVE_M,
  minTurnDeg = MAP_MIN_TURN_DEG,
): boolean {
  if (!sent) return true;
  if (sent.route !== next.route || sent.streets !== next.streets || sent.maneuver !== next.maneuver || sent.range !== next.range) return true;
  if ((sent.bearing === null) !== (next.bearing === null)) return true;
  if ((sent.position === null) !== (next.position === null)) return true;
  if (next.at - sent.at < minIntervalMs) return false;
  if (sent.position && next.position && distanceMeters(sent.position, next.position) >= minMoveM) return true;
  return sent.bearing !== null && next.bearing !== null && Math.abs(bearingDelta(sent.bearing, next.bearing)) >= minTurnDeg;
}

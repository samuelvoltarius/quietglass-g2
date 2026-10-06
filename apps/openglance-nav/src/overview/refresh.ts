import type { PixelPoint } from "./project";

/**
 * When the overview image is worth sending again.
 *
 * Every image crosses Bluetooth to the glasses, so it is sent only when the
 * picture really changed: a new route, streets that arrived, the next turn
 * moving on. Walking along the route moves the marker a pixel or two per GPS
 * fix; that waits until it has moved visibly and some time has passed.
 */
export interface OverviewFrame {
  /** Bumped for every new route. */
  readonly route: number;
  /** Bumped when streets for the route arrive. */
  readonly streets: number;
  readonly maneuver: number;
  /** Where the position marker is drawn, or null without a route. */
  readonly marker: PixelPoint | null;
  /** When this frame would be sent, in ms. */
  readonly at: number;
}

/** Marker updates at most this often. */
export const MARKER_MIN_INTERVAL_MS = 5_000;
/** …and only once it has moved this many pixels. */
export const MARKER_MIN_MOVE_PX = 6;

export function needsOverviewImage(
  sent: OverviewFrame | null,
  next: OverviewFrame,
  minIntervalMs = MARKER_MIN_INTERVAL_MS,
  minMovePx = MARKER_MIN_MOVE_PX,
): boolean {
  if (!sent) return true;
  if (sent.route !== next.route || sent.streets !== next.streets || sent.maneuver !== next.maneuver) return true;
  if (!sent.marker || !next.marker) return sent.marker !== next.marker;
  const moved = Math.hypot(next.marker.x - sent.marker.x, next.marker.y - sent.marker.y);
  return moved >= minMovePx && next.at - sent.at >= minIntervalMs;
}

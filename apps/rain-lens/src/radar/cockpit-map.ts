import { crop, type Frame } from "../screen/frame";
import { baseMapFor, type Box } from "./basemap";
import { composeFrame } from "./frame";
import type { MapArea } from "./layout";
import type { RadarData } from "./load";
import { metersPerPixel, RADAR_ZOOM, type Position } from "./tiles";

/**
 * The cockpit's radar picture: the left half of the display (288 x 218),
 * centred on the place, the same base map and rain as the radar page but in
 * its own window, without the page's rings and cross (the cockpit draws its
 * own crosshair, range ring, north marker and wind dial on top). Private
 * build only, like the rest of the radar.
 */

export const COCKPIT_AREA: MapArea = { x: 0, y: 0, width: 288, height: 218, anchorX: 144, anchorY: 109 };
const RING_CHOICES_KM = [100, 75, 50, 25, 10] as const;
const RING_MAX_RADIUS = 92;

/** The biggest round distance whose ring still fits the window, and its radius in pixels. */
export function cockpitRing(position: Position, zoom = RADAR_ZOOM): { km: number; radius: number } {
  const perPixel = metersPerPixel(position.latitude, zoom);
  for (const km of RING_CHOICES_KM) {
    const radius = Math.round((km * 1000) / perPixel);
    if (radius <= RING_MAX_RADIUS) return { km, radius };
  }
  return { km: 10, radius: Math.round(10_000 / perPixel) };
}

/** Where the cockpit's own marks sit, so no place name is written under them. */
function overlays(position: Position): Box[] {
  const ring = cockpitRing(position);
  const at = Math.SQRT1_2 * ring.radius;
  return [
    { x: 0, y: 0, width: 50, height: 50 },
    { x: 130, y: 0, width: 40, height: 20 },
    { x: Math.round(144 + at), y: Math.round(109 - at - 18), width: 60, height: 20 },
  ];
}

const cache = new Map<string, Frame>();

/**
 * Radar frame `index` of `data` in the cockpit window; with no data (or a
 * frame without raw levels) the base map alone. Cached per load and frame.
 */
export function cockpitMap(position: Position, data: RadarData | null, index: number | null, locale: string): Frame {
  const frame = data && index !== null ? data.frames[index] : undefined;
  const place = data?.position ?? position;
  const base = baseMapFor(place, RADAR_ZOOM, locale, { area: COCKPIT_AREA, rings: [], blocked: overlays(place) });
  const key = `${base.key}|${data?.loadedAt ?? 0}|${frame?.time ?? "map"}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const lookup = frame?.lookup ?? (() => null);
  const full = composeFrame(place, lookup, RADAR_ZOOM, base, COCKPIT_AREA, false);
  const picture = crop(full, COCKPIT_AREA.x, COCKPIT_AREA.y, COCKPIT_AREA.width, COCKPIT_AREA.height);
  cache.set(key, picture);
  // Seven pictures are a whole loop plus the bare map; older ones belong to an old load.
  while (cache.size > 8) cache.delete(cache.keys().next().value as string);
  return picture;
}

/** The nearest town for the caption, or null. */
export function cockpitPlace(position: Position, locale: string): string | null {
  return baseMapFor(position, RADAR_ZOOM, locale, { area: COCKPIT_AREA, rings: [], blocked: overlays(position) }).nearest;
}

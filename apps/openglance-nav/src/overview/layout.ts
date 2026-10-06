import type { LatLng } from "../geo/geometry";
import { fitProjection, project, wrapLongitude, type PixelPoint, type Projector } from "./project";

/**
 * Geometry of the overview image, shared by the drawing and by the code that
 * decides when to fetch streets or resend the picture — so both always agree
 * on where things land.
 */

/** Size of the overview image: the largest image container the G2 accepts. */
export const OVERVIEW_WIDTH = 288;
export const OVERVIEW_HEIGHT = 144;
/** Room around the route for the markers and the north arrow. */
export const OVERVIEW_PADDING = 28;

/** The projection the overview uses; streets must be projected with exactly this one. */
export function overviewProjector(points: readonly LatLng[], width = OVERVIEW_WIDTH, height = OVERVIEW_HEIGHT): Projector | null {
  return fitProjection(points, width, height, OVERVIEW_PADDING);
}

/** The pixel of the route point nearest `position`, measured the short way round the antimeridian. */
export function nearestPixel(position: LatLng, geo: readonly LatLng[], pixels: readonly PixelPoint[]): PixelPoint | undefined {
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  geo.forEach((point, index) => {
    const next = (point.lat - position.lat) ** 2 + (wrapLongitude(point.lon - position.lon) * Math.cos(position.lat * Math.PI / 180)) ** 2;
    if (next < distance) { distance = next; best = index; }
  });
  return pixels[best];
}

/** Where the position marker lands in the image (null without a route), for deciding whether it moved enough to resend. */
export function markerPixel(points: readonly LatLng[], position: LatLng | null, width = OVERVIEW_WIDTH, height = OVERVIEW_HEIGHT): PixelPoint | null {
  const pixels = project(points, width, height, OVERVIEW_PADDING);
  return (position ? nearestPixel(position, points, pixels) : pixels[0]) ?? null;
}

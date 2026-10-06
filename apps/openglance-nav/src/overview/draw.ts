import type { LatLng } from "../geo/geometry";
import { project, type PixelPoint } from "./project";
import type { RoadClass, StreetSegment } from "./streets";
import { nearestPixel, OVERVIEW_HEIGHT, OVERVIEW_PADDING, OVERVIEW_WIDTH } from "./layout";

export { markerPixel, nearestPixel, overviewProjector, OVERVIEW_HEIGHT, OVERVIEW_WIDTH } from "./layout";

/**
 * Overview image drawing, ported from Map Glass: black background, the real
 * streets around the route in grey (when they could be loaded), the route as
 * one thick white line with a black edge so it stands clear of them, a ringed
 * dot for the position, a square for the destination, "N" with an
 * up-pointing triangle. OpenGlance adds a small ring on the next manoeuvre.
 *
 * The glasses convert images to 16 grey levels, so streets can be dimmer
 * than the route without disappearing: major roads brighter and thicker,
 * minor roads dim, footpaths faint.
 */

/** The slice of the 2D canvas API the map uses, so drawing can be checked against a recording fake in node. */
export type MapContext = Pick<CanvasRenderingContext2D, "fillStyle" | "strokeStyle" | "lineWidth" | "lineCap" | "lineJoin" | "font" | "fillRect" | "beginPath" | "moveTo" | "lineTo" | "stroke" | "arc" | "fill" | "strokeRect" | "fillText">;
export interface Segment { readonly from: PixelPoint; readonly to: PixelPoint; }

/**
 * The decorative grid Map Glass drew behind the route. No longer drawn — it
 * looked like streets and was not; real streets replaced it — and kept only
 * so the Map Glass history and its test stay readable.
 */
export function gridLines(width: number, height: number): Segment[] {
  const lines: Segment[] = [];
  for (let x = 40; x < width; x += 70) lines.push({ from: { x, y: 0 }, to: { x: x - 80, y: height } });
  for (let y = 35; y < height; y += 55) lines.push({ from: { x: 0, y }, to: { x: width, y: y + 28 } });
  return lines;
}

/** "N" in the top-right corner with a triangle below it whose apex points up (north). */
export function northArrow(width: number): { readonly label: PixelPoint; readonly triangle: readonly [PixelPoint, PixelPoint, PixelPoint] } {
  return { label: { x: width - 30, y: 24 }, triangle: [{ x: width - 30, y: 32 }, { x: width - 24, y: 44 }, { x: width - 36, y: 44 }] };
}

const PADDING = OVERVIEW_PADDING;

/** Stroke per road class: brightness and width on a 16-grey display. */
export const STREET_STYLE: Readonly<Record<RoadClass, { readonly color: string; readonly width: number }>> = {
  major: { color: "#a0a0a0", width: 3 },
  minor: { color: "#606060", width: 2 },
  path: { color: "#404040", width: 1 },
};

/** Faintest first, so a major road is never painted over by a footpath. */
const STREET_ORDER: readonly RoadClass[] = ["path", "minor", "major"];

/**
 * Draws streets, route, position marker, destination square, optional
 * next-manoeuvre ring and north arrow. An empty route draws only the
 * background; no streets means the route alone, never a fake grid.
 */
export function drawRoute(
  ctx: MapContext,
  points: readonly LatLng[],
  position: LatLng | null,
  width: number,
  height: number,
  next: LatLng | null = null,
  streets: readonly StreetSegment[] = [],
): void {
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height);

  const pixels = project(points, width, height, PADDING);
  if (pixels.length && streets.length) {
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const cls of STREET_ORDER) {
      const style = STREET_STYLE[cls];
      const own = streets.filter((segment) => segment.cls === cls);
      if (!own.length) continue;
      // One path per class: hundreds of tiny strokes cost far more than one.
      ctx.strokeStyle = style.color; ctx.lineWidth = style.width;
      ctx.beginPath();
      for (const segment of own) { ctx.moveTo(segment.from.x, segment.from.y); ctx.lineTo(segment.to.x, segment.to.y); }
      ctx.stroke();
    }
  }

  if (pixels.length) {
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (streets.length) {
      // A black edge keeps the route readable where it runs along a street.
      ctx.strokeStyle = "#000"; ctx.lineWidth = 14;
      ctx.beginPath();
      pixels.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
      ctx.stroke();
    }
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 8;
    ctx.beginPath();
    pixels.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
    ctx.stroke();
  }

  const turn = next && pixels.length ? nearestPixel(next, points, pixels) : undefined;
  if (turn) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(turn.x, turn.y, 14, 0, Math.PI * 2); ctx.stroke(); }

  const marker = position ? nearestPixel(position, points, pixels) : pixels[0];
  if (marker) {
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(marker.x, marker.y, 10, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#000"; ctx.beginPath(); ctx.arc(marker.x, marker.y, 4, 0, Math.PI * 2); ctx.fill();
  }

  const end = pixels[pixels.length - 1];
  if (end) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 3; ctx.strokeRect(end.x - 9, end.y - 9, 18, 18); }

  const north = northArrow(width);
  ctx.fillStyle = "#fff"; ctx.font = "bold 18px sans-serif"; ctx.fillText("N", north.label.x, north.label.y);
  ctx.beginPath();
  north.triangle.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
  ctx.fill();
}

export async function renderRoutePng(
  points: readonly LatLng[],
  position: LatLng | null,
  next: LatLng | null = null,
  width = OVERVIEW_WIDTH,
  height = OVERVIEW_HEIGHT,
  streets: readonly StreetSegment[] = [],
): Promise<Uint8Array> {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("2d canvas unavailable");
  drawRoute(ctx, points, position, width, height, next, streets);
  const blob: Blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encode failed")), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

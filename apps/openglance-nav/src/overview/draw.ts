import type { LatLng } from "../geo/geometry";
import { project, wrapLongitude, type PixelPoint } from "./project";

/**
 * Overview image drawing, ported from Map Glass: black background, faint
 * decorative grid, the route as one thick white line, a ringed dot for the
 * position, a square for the destination, "N" with an up-pointing triangle.
 * OpenGlance adds a small ring on the next manoeuvre.
 */

/** Size of the overview image: the largest image container the G2 accepts. */
export const OVERVIEW_WIDTH = 288;
export const OVERVIEW_HEIGHT = 144;

/** The slice of the 2D canvas API the map uses, so drawing can be checked against a recording fake in node. */
export type MapContext = Pick<CanvasRenderingContext2D, "fillStyle" | "strokeStyle" | "lineWidth" | "lineCap" | "lineJoin" | "font" | "fillRect" | "beginPath" | "moveTo" | "lineTo" | "stroke" | "arc" | "fill" | "strokeRect" | "fillText">;
export interface Segment { readonly from: PixelPoint; readonly to: PixelPoint; }

/**
 * Decorative grid behind the route: slanted lines every 70 px, gently sloped
 * cross lines every 55 px. Drawn dim so it reads as texture, not as streets.
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

const PADDING = 28;

/**
 * Draws grid, route, position marker, destination square, optional
 * next-manoeuvre ring and north arrow. An empty route draws only the background.
 */
export function drawRoute(
  ctx: MapContext,
  points: readonly LatLng[],
  position: LatLng | null,
  width: number,
  height: number,
  next: LatLng | null = null,
): void {
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#353535"; ctx.lineWidth = 2;
  for (const line of gridLines(width, height)) { ctx.beginPath(); ctx.moveTo(line.from.x, line.from.y); ctx.lineTo(line.to.x, line.to.y); ctx.stroke(); }

  const pixels = project(points, width, height, PADDING);
  if (pixels.length) {
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 8; ctx.lineCap = "round"; ctx.lineJoin = "round";
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
): Promise<Uint8Array> {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("2d canvas unavailable");
  drawRoute(ctx, points, position, width, height, next);
  const blob: Blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encode failed")), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
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

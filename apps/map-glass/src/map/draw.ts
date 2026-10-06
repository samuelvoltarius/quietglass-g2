import { project, wrapLongitude, type GeoPoint, type PixelPoint } from "./model";
/** The slice of the 2D canvas API the map uses, so drawing can be checked against a recording fake in node. */
export type MapContext = Pick<CanvasRenderingContext2D, "fillStyle" | "strokeStyle" | "lineWidth" | "lineCap" | "lineJoin" | "font" | "fillRect" | "beginPath" | "moveTo" | "lineTo" | "stroke" | "arc" | "fill" | "strokeRect" | "fillText">;
export interface Segment { readonly from: PixelPoint; readonly to: PixelPoint; }
/** Decorative street grid behind the route: slanted avenues every 70 px, gently sloped cross streets every 55 px. */
export function gridLines(width: number, height: number): Segment[] { const lines: Segment[] = []; for (let x = 40; x < width; x += 70) lines.push({ from: { x, y: 0 }, to: { x: x - 80, y: height } }); for (let y = 35; y < height; y += 55) lines.push({ from: { x: 0, y }, to: { x: width, y: y + 28 } }); return lines; }
/** "N" in the top-right corner with a triangle below it whose apex points up (north). */
export function northArrow(width: number): { readonly label: PixelPoint; readonly triangle: readonly [PixelPoint, PixelPoint, PixelPoint] } { return { label: { x: width - 30, y: 24 }, triangle: [{ x: width - 30, y: 32 }, { x: width - 24, y: 44 }, { x: width - 36, y: 44 }] }; }
/** Draws grid, route, position marker, destination square and north arrow. An empty route draws only the background. */
export function drawRoute(ctx: MapContext, points: readonly GeoPoint[], position: GeoPoint | null, width: number, height: number): void {
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#353535"; ctx.lineWidth = 2; for (const line of gridLines(width, height)) { ctx.beginPath(); ctx.moveTo(line.from.x, line.from.y); ctx.lineTo(line.to.x, line.to.y); ctx.stroke(); }
  const pixels = project(points, width, height, 28); if (pixels.length) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 8; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.beginPath(); pixels.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)); ctx.stroke(); }
  const marker = position ? nearestPixel(position, points, pixels) : pixels[0]; if (marker) { ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(marker.x, marker.y, 10, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = "#000"; ctx.beginPath(); ctx.arc(marker.x, marker.y, 4, 0, Math.PI * 2); ctx.fill(); }
  const end = pixels[pixels.length - 1]; if (end) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 3; ctx.strokeRect(end.x - 9, end.y - 9, 18, 18); }
  const north = northArrow(width); ctx.fillStyle = "#fff"; ctx.font = "bold 18px sans-serif"; ctx.fillText("N", north.label.x, north.label.y); ctx.beginPath(); north.triangle.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)); ctx.fill();
}
export async function renderRoutePng(points: readonly GeoPoint[], position: GeoPoint | null, width = 576, height = 224): Promise<Uint8Array> {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("2d canvas unavailable");
  drawRoute(ctx, points, position, width, height);
  const blob: Blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encode failed")), "image/png")); return new Uint8Array(await blob.arrayBuffer());
}
export function nearestPixel(position: GeoPoint, geo: readonly GeoPoint[], pixels: readonly { x: number; y: number }[]): { x: number; y: number } | undefined { let best = 0; let distance = Number.POSITIVE_INFINITY; geo.forEach((point, index) => { const next = (point.lat - position.lat) ** 2 + (wrapLongitude(point.lon - position.lon) * Math.cos(position.lat * Math.PI / 180)) ** 2; if (next < distance) { distance = next; best = index; } }); return pixels[best]; }

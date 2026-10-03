import { project, type GeoPoint, type RouteMap } from "./model";
export async function renderRoutePng(route: RouteMap, position: GeoPoint | null, width = 576, height = 224): Promise<Uint8Array> {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("2d canvas unavailable");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#353535"; ctx.lineWidth = 2; for (let x = 40; x < width; x += 70) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x - 80, height); ctx.stroke(); } for (let y = 35; y < height; y += 55) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y + 28); ctx.stroke(); }
  const pixels = project(route.points, width, height, 28); ctx.strokeStyle = "#fff"; ctx.lineWidth = 8; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.beginPath(); pixels.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)); ctx.stroke();
  const marker = position ? nearestPixel(position, route.points, pixels) : pixels[0]; if (marker) { ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(marker.x, marker.y, 10, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = "#000"; ctx.beginPath(); ctx.arc(marker.x, marker.y, 4, 0, Math.PI * 2); ctx.fill(); }
  const end = pixels[pixels.length - 1]; if (end) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 3; ctx.strokeRect(end.x - 9, end.y - 9, 18, 18); }
  ctx.fillStyle = "#fff"; ctx.font = "bold 18px sans-serif"; ctx.fillText(`N`, width - 30, 24); ctx.beginPath(); ctx.moveTo(width - 24, 34); ctx.lineTo(width - 30, 44); ctx.lineTo(width - 36, 34); ctx.fill();
  const blob: Blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encode failed")), "image/png")); return new Uint8Array(await blob.arrayBuffer());
}
function nearestPixel(position: GeoPoint, geo: readonly GeoPoint[], pixels: readonly { x: number; y: number }[]): { x: number; y: number } | undefined { let best = 0; let distance = Number.POSITIVE_INFINITY; geo.forEach((point, index) => { const next = (point.lat - position.lat) ** 2 + (point.lon - position.lon) ** 2; if (next < distance) { distance = next; best = index; } }); return pixels[best]; }

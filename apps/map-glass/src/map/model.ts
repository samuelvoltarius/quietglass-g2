export interface GeoPoint { readonly lat: number; readonly lon: number; }
export interface RouteMap { readonly points: readonly GeoPoint[]; readonly instruction: string; readonly distanceMeters: number; readonly road: string; readonly source: "bridge" | "demo"; }
export interface PixelPoint { readonly x: number; readonly y: number; }
/** Smallest signed longitude difference, in -180…180, so a route across the antimeridian stays contiguous. */
export function wrapLongitude(delta: number): number { return ((((delta + 180) % 360) + 360) % 360) - 180; }
/**
 * Fits the route into the viewport with one scale for both axes (equirectangular, longitude shrunk by cos(lat)),
 * centred, so turns keep their real angles and a straight north–south or east–west route is not pinned to an edge.
 */
export function project(points: readonly GeoPoint[], width: number, height: number, padding = 18): PixelPoint[] {
  const first = points[0]; if (!first) return [];
  const lons = points.map((point) => first.lon + wrapLongitude(point.lon - first.lon)); const lats = points.map((point) => point.lat);
  const minLat = Math.min(...lats); const maxLat = Math.max(...lats); const minLon = Math.min(...lons); const maxLon = Math.max(...lons);
  const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180); const spanX = (maxLon - minLon) * kx; const spanY = maxLat - minLat;
  const innerWidth = Math.max(0, width - padding * 2); const innerHeight = Math.max(0, height - padding * 2);
  const fit = Math.min(spanX > 1e-9 ? innerWidth / spanX : Number.POSITIVE_INFINITY, spanY > 1e-9 ? innerHeight / spanY : Number.POSITIVE_INFINITY); const scale = Number.isFinite(fit) ? fit : 0;
  const left = padding + (innerWidth - spanX * scale) / 2; const bottom = height - padding - (innerHeight - spanY * scale) / 2;
  return points.map((point, index) => ({ x: left + ((lons[index] ?? point.lon) - minLon) * kx * scale, y: bottom - (point.lat - minLat) * scale }));
}
function isCoordinate(lat: unknown, lon: unknown): boolean { return typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180; }
export function parseRoute(value: unknown): RouteMap { const row = (value && typeof value === "object" ? value : {}) as Partial<RouteMap>; if (!Array.isArray(row.points) || row.points.length < 2) throw new Error("route needs at least two points"); const points = row.points.flatMap((point) => { const candidate = (point && typeof point === "object" ? point : {}) as Partial<GeoPoint>; return isCoordinate(candidate.lat, candidate.lon) ? [{ lat: Number(candidate.lat), lon: Number(candidate.lon) }] : []; }); if (points.length < 2) throw new Error("route geometry is invalid"); return { points, instruction: typeof row.instruction === "string" ? row.instruction : "Route folgen", distanceMeters: Number.isFinite(row.distanceMeters) ? Math.max(0, Math.round(Number(row.distanceMeters))) : 0, road: typeof row.road === "string" ? row.road : "", source: "bridge" }; }
export function demoRoute(): RouteMap { return { source: "demo", road: "Vogelweiderstrasse", instruction: "Rechts auf Sterneckstrasse", distanceMeters: 180, points: [{ lat: 47.806, lon: 13.052 }, { lat: 47.807, lon: 13.053 }, { lat: 47.808, lon: 13.054 }, { lat: 47.809, lon: 13.056 }, { lat: 47.8105, lon: 13.057 }, { lat: 47.811, lon: 13.059 }] }; }
/** Stored destination fields are free text; blank or invalid input falls back instead of becoming 0,0. */
export function readDestination(lat: string | null, lon: string | null, fallback: GeoPoint): GeoPoint { const parse = (text: string | null): number => text === null || text.trim() === "" ? Number.NaN : Number(text.trim().replace(",", ".")); const parsedLat = parse(lat); const parsedLon = parse(lon); return isCoordinate(parsedLat, parsedLon) ? { lat: parsedLat, lon: parsedLon } : fallback; }
export interface FetchRouteOptions { readonly timeoutMs?: number; readonly fetchImpl?: typeof fetch; }
/** Asks the bridge for a route. Every failure, including a malformed bridge address, rejects instead of throwing synchronously. */
export async function fetchRoute(api: string, origin: GeoPoint, destination: GeoPoint, lang: string, options: FetchRouteOptions = {}): Promise<RouteMap> {
  const doFetch = options.fetchImpl ?? fetch; const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
  try { const url = new URL(api); url.searchParams.set("lat", String(origin.lat)); url.searchParams.set("lon", String(origin.lon)); url.searchParams.set("destLat", String(destination.lat)); url.searchParams.set("destLon", String(destination.lon)); url.searchParams.set("lang", lang); const response = await doFetch(url, { signal: controller.signal }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return parseRoute(await response.json()); }
  catch (error) { if (controller.signal.aborted) throw new Error("timed out"); throw error; }
  finally { clearTimeout(timeout); }
}

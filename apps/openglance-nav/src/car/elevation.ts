import type { LatLng } from "../geo/geometry";

/**
 * Climb along the route for the arrival battery (private build, own Valhalla
 * with elevation data, `VITE_HEIGHT_URL`).
 *
 * The estimate used to be "km left × the car's last 50-km consumption" - flat.
 * Salzburg → Lungau climbs ~1000 m over the Tauern and drops ~400 m: for a
 * Dolphin Surf about 4.5 kWh (~10 %) the flat estimate never saw (15.10.:
 * "13 % at arrival - I don't trust it"). The heights come once per route,
 * edge by edge, and the climb still ahead of the car goes into the estimate:
 * uphill in full (through the drive's losses), downhill only partly back
 * (recuperation).
 */

const BUILD_HEIGHT_URL: string | undefined = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_HEIGHT_URL;

/** Base of the Valhalla with elevation (its `/height`); empty = no climb in the estimate. */
export function buildHeightUrl(raw: string | undefined = BUILD_HEIGHT_URL): string {
  const url = (raw ?? "").trim().replace(/\/+$/, "");
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? url : "";
  } catch {
    return "";
  }
}

/** Car with driver (Dolphin Surf ~1.4 t + people and luggage). */
export const VEHICLE_MASS_KG = 1_500;
/** Share of the battery energy that ends up lifting the car (motor, inverter, gearbox). */
export const DRIVE_EFFICIENCY = 0.88;
/** Share of the height energy won back downhill (recuperation, minus what the brakes and drag eat). */
export const RECUPERATION = 0.6;

export interface ElevationProfile {
  /** Metres along the route of each sample. */
  readonly along: readonly number[];
  /** Metres climbed / descended from the start up to each sample. */
  readonly up: readonly number[];
  readonly down: readonly number[];
}

/** Cumulative climb and descent; a sample without a height (outside the data) adds nothing. */
export function buildProfile(along: readonly number[], heights: readonly (number | null)[]): ElevationProfile {
  const up: number[] = [], down: number[] = [];
  let u = 0, d = 0, last: number | null = null;
  for (let i = 0; i < along.length; i++) {
    const h = heights[i];
    if (typeof h === "number" && Number.isFinite(h)) {
      if (last !== null) { if (h > last) u += h - last; else d += last - h; }
      last = h;
    }
    up.push(u);
    down.push(d);
  }
  return { along, up, down };
}

/** Climb and descent still ahead of a point `alongM` metres along the route. */
export function climbAhead(profile: ElevationProfile, alongM: number): { up: number; down: number } {
  const n = profile.along.length;
  if (n === 0) return { up: 0, down: 0 };
  let i = 0;
  while (i < n - 1 && profile.along[i + 1]! <= alongM) i++;
  return { up: profile.up[n - 1]! - profile.up[i]!, down: profile.down[n - 1]! - profile.down[i]! };
}

/** Extra battery energy (kWh) for the climb ahead; negative when the way ahead goes down overall. */
export function climbKwh(up: number, down: number, massKg = VEHICLE_MASS_KG): number {
  const joulesPerMetre = massKg * 9.81;
  return (joulesPerMetre * up / DRIVE_EFFICIENCY - joulesPerMetre * down * RECUPERATION) / 3.6e6;
}

/** Edges of the route with their length (km), mean height and tunnel flag, from Valhalla's trace_attributes. */
interface TraceEdge { readonly length?: unknown; readonly mean_elevation?: unknown; readonly tunnel?: unknown }

/**
 * Heights of the road itself, edge by edge (own Valhalla with elevation,
 * `trace_attributes` along the route). Plain height sampling along the line
 * measured the MOUNTAIN above the Tauern and Katschberg tunnels (max 2236 m,
 * 3445 m "climbed" Salzburg → Tamsweg; 15.10.) - tunnel edges carry no height
 * here and are bridged, which gave 1398 m up / 806 m down, highest 1338 m (the
 * Tauern tunnel portal). Null when the server does not answer or the route
 * leaves its data (the estimate then stays flat).
 */
export async function fetchProfile(
  base: string,
  shape: readonly LatLng[],
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  timeoutMs = 20_000,
): Promise<ElevationProfile | null> {
  if (shape.length < 2) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // text/plain keeps it a CORS "simple request" (Valhalla reads the JSON body either way).
    const response = await fetchImpl(base + "/trace_attributes", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({
        shape: shape.map((p) => ({ lat: Number(p.lat.toFixed(6)), lon: Number(p.lon.toFixed(6)) })),
        shape_match: "edge_walk",
        costing: "auto",
        filters: { attributes: ["edge.length", "edge.mean_elevation", "edge.tunnel"], action: "include" },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const value = await response.json() as { edges?: unknown };
    return profileFromEdges(Array.isArray(value.edges) ? value.edges as TraceEdge[] : []);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Valhalla marks "no data" with a large negative height. */
const NO_HEIGHT_BELOW = -500;

export function profileFromEdges(edges: readonly TraceEdge[]): ElevationProfile | null {
  const along: number[] = [];
  const heights: (number | null)[] = [];
  let metres = 0;
  for (const edge of edges) {
    const km = typeof edge.length === "number" && Number.isFinite(edge.length) ? edge.length : 0;
    metres += km * 1000;
    const h = edge.mean_elevation;
    along.push(metres);
    heights.push(edge.tunnel === true || typeof h !== "number" || !Number.isFinite(h) || h < NO_HEIGHT_BELOW ? null : h);
  }
  if (along.length < 2 || heights.every((h) => h === null)) return null;
  return buildProfile(along, heights);
}

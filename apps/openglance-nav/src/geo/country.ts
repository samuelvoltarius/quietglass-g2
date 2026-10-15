import type { LatLng } from "./geometry";

/**
 * "Is this Germany?" - cheaply, for one legal reason: in Germany a driver may
 * not use warnings about speed-enforcement points while driving (StVO § 23
 * Abs. 1c), so the speed-camera hint is off there.
 *
 * A coarse outline of Germany (about 120 points, ±10 km) decides away from
 * the border. Within BORDER_BAND_M of the outline a reverse geocode (Photon,
 * the app's own place search server) decides, cached per cell of 0.01°
 * (about 1 km); until it has answered - or if it fails - the hint stays OFF.
 * Only the cell centre is sent, rounded to two decimals.
 */

/** Germany, roughly, as [lon, lat], clockwise from Aachen. */
export const DE_OUTLINE: readonly (readonly [number, number])[] = [
  [6.02, 50.75], [5.87, 51.05], [6.17, 51.17], [6.08, 51.4], [6.22, 51.51], [5.95, 51.81], [6.17, 51.86],
  [6.72, 51.9], [7.05, 52.24], [6.7, 52.48], [7.07, 52.65], [7.2, 53.24], [6.95, 53.6], [7.2, 53.75],
  [8.0, 53.75], [8.5, 53.6], [8.85, 54.0], [8.6, 54.4], [8.3, 55.05], [8.65, 54.91], [9.45, 54.82],
  [10.0, 54.7], [11.0, 54.55], [11.3, 54.15], [12.2, 54.5], [13.4, 54.7], [14.27, 53.93], [14.42, 53.3],
  [14.13, 52.83], [14.63, 52.57], [14.71, 52.1], [14.6, 51.8], [15.04, 51.27], [14.82, 50.87], [14.4, 50.93],
  [14.2, 50.87], [13.85, 50.73], [12.95, 50.4], [12.26, 50.27], [12.1, 50.31], [12.2, 50.1], [12.5, 49.95],
  [12.55, 49.7], [12.88, 49.33], [13.4, 49.05], [13.84, 48.77], [13.73, 48.52], [13.45, 48.56], [13.42, 48.37],
  [13.03, 48.26], [12.83, 48.16], [12.77, 48.06], [12.93, 47.94], [12.98, 47.84], [13.0, 47.82], [12.98, 47.78],
  [12.91, 47.73], [13.08, 47.65], [13.05, 47.5], [12.95, 47.48], [12.72, 47.6], [12.47, 47.68], [12.17, 47.59],
  [11.63, 47.59], [11.26, 47.4], [10.98, 47.4], [10.43, 47.58], [10.18, 47.27], [9.97, 47.54], [9.73, 47.55],
  [9.55, 47.53], [9.18, 47.67], [8.87, 47.7], [8.6, 47.65], [8.2, 47.6], [7.6, 47.58], [7.57, 48.12],
  [7.8, 48.58], [8.23, 48.97], [7.63, 49.06], [7.0, 49.18], [6.73, 49.16], [6.36, 49.46], [6.51, 49.8],
  [6.13, 50.13], [6.4, 50.32], [6.18, 50.55],
];

/** Within this distance of the outline the coarse answer is not trusted. */
export const BORDER_BAND_M = 20_000;
/** Reverse lookups at most this often. */
export const LOOKUP_MIN_INTERVAL_MS = 10_000;

const M_PER_DEG = 111_320;

function inside(lon: number, lat: number, ring: readonly (readonly [number, number])[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Metres from the point to the nearest edge of the ring (flat approximation, plenty at this scale). */
function edgeDistance(p: LatLng, ring: readonly (readonly [number, number])[]): number {
  const mx = M_PER_DEG * Math.cos((p.lat * Math.PI) / 180);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = (ring[j]![0] - p.lon) * mx, ay = (ring[j]![1] - p.lat) * M_PER_DEG;
    const bx = (ring[i]![0] - p.lon) * mx, by = (ring[i]![1] - p.lat) * M_PER_DEG;
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** "DE" deep inside, "other" well outside, "border" near the outline (ask someone who knows). */
export function coarseCountry(p: LatLng): "DE" | "other" | "border" {
  if (edgeDistance(p, DE_OUTLINE) <= BORDER_BAND_M) return "border";
  return inside(p.lon, p.lat, DE_OUTLINE) ? "DE" : "other";
}

/** Two-letter country code of a point (upper case), or null when unknown. */
export type CountryLookup = (p: LatLng) => Promise<string | null>;

/** Photon's reverse geocode: `GET {base}/reverse?lat=…&lon=…` → `features[0].properties.countrycode`. */
export function photonCountry(base: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init), timeoutMs = 8_000): CountryLookup {
  return async (p) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${base.replace(/\/+$/, "")}/reverse?lat=${p.lat.toFixed(2)}&lon=${p.lon.toFixed(2)}&limit=1`;
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) return null;
      const value = await response.json() as { features?: { properties?: { countrycode?: unknown } }[] };
      const code = value?.features?.[0]?.properties?.countrycode;
      return typeof code === "string" && /^[a-z]{2}$/i.test(code) ? code.toUpperCase() : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The cell a point falls in (0.01°), and its centre: the only position a lookup ever sends. */
export function cellOf(p: LatLng): { key: string; centre: LatLng } {
  const lat = Math.floor(p.lat * 100), lon = Math.floor(p.lon * 100);
  return { key: `${lat}:${lon}`, centre: { lat: (lat + 0.5) / 100, lon: (lon + 0.5) / 100 } };
}

/**
 * Decides whether speed-camera hints may be shown at a position: never in
 * Germany, never while unsure. One lookup at a time, at most every
 * LOOKUP_MIN_INTERVAL_MS; answers are kept per cell for the session.
 */
export class CameraCountryGate {
  private readonly cells = new Map<string, string>();
  private busy = false;
  private lastLookupAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly lookup: CountryLookup | null, private readonly onAnswer: () => void = () => undefined) {}

  allowed(p: LatLng | null, now: number): boolean {
    if (!p) return false;
    const coarse = coarseCountry(p);
    if (coarse === "DE") return false;
    if (coarse === "other") return true;
    const cell = cellOf(p);
    const known = this.cells.get(cell.key);
    if (known) return known !== "DE";
    if (this.lookup && !this.busy && now - this.lastLookupAt >= LOOKUP_MIN_INTERVAL_MS) {
      this.busy = true;
      this.lastLookupAt = now;
      void this.lookup(cell.centre).then((code) => {
        if (code) { this.cells.set(cell.key, code); this.onAnswer(); }
      }, () => undefined).finally(() => { this.busy = false; });
    }
    return false;
  }
}

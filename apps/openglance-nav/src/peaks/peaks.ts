import { bearingDegrees, bearingDelta, distanceMeters, type LatLng } from "../geo/geometry";
import { isOwnOverpass, overpassUrlsFor } from "../overpass/own";

/**
 * Summits nearby, from OpenStreetMap (`natural=peak` with a name and an
 * elevation) via the public Overpass API.
 *
 * Asked sparingly - the servers are free and shared:
 *  - one request per *area*: the world is cut into 5 km cells, a request asks
 *    for everything within the chosen radius (+ 4 km, so any point of the cell
 *    is covered) around the cell's centre, and the answer is kept on the phone
 *    (Even app storage) for 30 days; a larger radius serves a smaller one;
 *  - nothing is asked on its own: only when the peaks page is opened (glasses)
 *    or "Gipfel laden" is pressed (phone), or when the peaks page is open and
 *    the glasses move into a new cell; no polling;
 *  - at most one request every 20 s, with a timeout, every failure in words.
 *
 * Checked 2026-10-14 with curl (POST form, `Origin` set): overpass-api.de and
 * other mirrors answer `Access-Control-Allow-Origin: *`; both were also seen to
 * answer 504 under load, overpass-api.de 406 to a client without a browser
 * Referer. Hence the list of servers, asked one after the other.
 */

export interface Peak {
  readonly id: number;
  readonly name: string;
  /** Elevation in metres. */
  readonly ele: number;
  readonly at: LatLng;
}

/** A peak seen from where one stands. */
export interface PeakSight {
  readonly peak: Peak;
  /** Metres. */
  readonly distance: number;
  /** Degrees clockwise from north. */
  readonly bearing: number;
}

export type PeakRadiusKm = 10 | 25 | 50;
export const PEAK_RADII: readonly PeakRadiusKm[] = [10, 25, 50];
export const DEFAULT_PEAK_RADIUS: PeakRadiusKm = 25;

export function isPeakRadius(value: unknown): value is PeakRadiusKm {
  return value === 10 || value === 25 || value === 50;
}

export const DEFAULT_PEAK_URLS: readonly string[] = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

/** Edge of one cache cell. */
export const CELL_M = 5_000;
/** Added to the radius so that every point of a cell is covered (half diagonal ≈ 3.54 km). */
export const CELL_MARGIN_M = 4_000;
export const MIN_INTERVAL_MS = 20_000;
export const CACHE_TTL_MS = 30 * 24 * 60 * 60_000;
/** Areas kept on the phone; the oldest goes first. */
export const MAX_AREAS = 4;
/** Peaks kept per area (the highest, when an answer has more). */
export const MAX_PEAKS_PER_AREA = 2_000;
export const MAX_RESPONSE_BYTES = 4_000_000;
const M_PER_DEG = 111_320;

// ---- Geometry ----

/** Distance and bearing of every peak from `here`, within `radiusM`, nearest first. */
export function sightsFrom(here: LatLng, peaks: readonly Peak[], radiusM = Number.POSITIVE_INFINITY): PeakSight[] {
  const out: PeakSight[] = [];
  for (const peak of peaks) {
    const distance = distanceMeters(here, peak.at);
    if (distance > radiusM) continue;
    out.push({ peak, distance, bearing: bearingDegrees(here, peak.at) });
  }
  return out.sort((a, b) => a.distance - b.distance || b.peak.ele - a.peak.ele);
}

/** Where a peak lies relative to the direction one faces: -180 (behind, left) … 0 (ahead) … 180. */
export function relativeBearing(facing: number, bearing: number): number {
  return bearingDelta(facing, bearing);
}

const COMPASS: Readonly<Record<"de" | "en", readonly string[]>> = {
  de: ["N", "NO", "O", "SO", "S", "SW", "W", "NW"],
  en: ["N", "NE", "E", "SE", "S", "SW", "W", "NW"],
};

/** "NO" / "NE" for 45°: the nearest of the eight compass points. */
export function compassPoint(bearing: number, locale: "de" | "en"): string {
  const index = Math.round((((bearing % 360) + 360) % 360) / 45) % 8;
  return COMPASS[locale][index]!;
}

export type PeakPick = "near" | "high";

/** Field of view of the compass band: this many degrees either side of the facing direction. */
export const HALF_FOV = 60;

export interface BandPicks {
  /** The peaks to draw, in order of importance (the first wins a label). */
  readonly shown: readonly PeakSight[];
  /** How many peaks lie outside the band, to the left and to the right. */
  readonly left: number;
  readonly right: number;
}

/**
 * The peaks for the compass band: within ±HALF_FOV of `facing`, the `n`
 * nearest (`near`) or highest (`high`); the rest are only counted, by side.
 */
export function bandPicks(sights: readonly PeakSight[], facing: number, pick: PeakPick, n = 7, halfFov = HALF_FOV): BandPicks {
  const inView: PeakSight[] = [];
  let left = 0, right = 0;
  for (const sight of sights) {
    const rel = relativeBearing(facing, sight.bearing);
    if (rel < -halfFov) left++;
    else if (rel > halfFov) right++;
    else inView.push(sight);
  }
  const order = pick === "near"
    ? (a: PeakSight, b: PeakSight) => a.distance - b.distance || b.peak.ele - a.peak.ele
    : (a: PeakSight, b: PeakSight) => b.peak.ele - a.peak.ele || a.distance - b.distance;
  const sorted = [...inView].sort(order);
  return { shown: sorted.slice(0, n), left, right };
}

// ---- Which way one faces ----

export interface Course {
  /** Degrees from the GPS, or null. */
  readonly heading: number | null;
  /** Metres per second. */
  readonly speed: number | null;
  /** When it was measured (ms). */
  readonly at: number;
}

/** Faster than this, the GPS course says where one is going (a brisk walk is ~1.4 m/s). */
export const MOVING_MS = 1.0;
/** A course older than this no longer counts. */
export const COURSE_MAX_AGE_MS = 15_000;

export interface Facing {
  readonly deg: number;
  readonly source: "gps" | "set" | "north";
}

/** GPS course while moving; standing still the direction set on the phone, else north up. */
export function facingFor(course: Course | null, now: number, setFacing: number | null): Facing {
  if (course && course.heading !== null && course.heading >= 0 && (course.speed ?? 0) >= MOVING_MS && now - course.at <= COURSE_MAX_AGE_MS) {
    return { deg: ((course.heading % 360) + 360) % 360, source: "gps" };
  }
  if (setFacing !== null && Number.isFinite(setFacing)) return { deg: ((setFacing % 360) + 360) % 360, source: "set" };
  return { deg: 0, source: "north" };
}

// ---- Overpass ----

const coord = (value: number): string => value.toFixed(4);

/** Named peaks with an elevation within `radiusM` of a point. */
export function buildPeakQuery(at: LatLng, radiusM: number, serverTimeoutS = 25): string {
  return `[out:json][timeout:${serverTimeoutS}];node["natural"="peak"]["name"]["ele"](around:${Math.round(radiusM)},${coord(at.lat)},${coord(at.lon)});out qt;`;
}

/**
 * Elevation from an OSM `ele` tag: "2522", "2522.5", "2522 m", "2522,5",
 * "ca. 900", "2.522" (German thousands). Null when it is no plausible number.
 */
export function parseEle(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > -500 && value < 9_000 ? Math.round(value) : null;
  if (typeof value !== "string") return null;
  let text = value.trim().toLowerCase().replace(/^(ca\.?|~|approx\.?)\s*/, "").replace(/\s*(m|meter|metres|meters|müa|m\.ü\.a\.?)\s*$/, "").trim();
  if (/^\d{1,2}\.\d{3}$/.test(text)) text = text.replace(".", "");
  text = text.replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) && n > -500 && n < 9_000 ? Math.round(n) : null;
}

/** Peaks from an Overpass answer; null when it is not one. Nodes without a name or a usable elevation are left out. */
export function parsePeaks(json: unknown): Peak[] | null {
  const elements = (json as { elements?: unknown } | null)?.elements;
  if (!Array.isArray(elements)) return null;
  const out: Peak[] = [];
  const seen = new Set<number>();
  for (const raw of elements) {
    const e = raw as { type?: unknown; id?: unknown; lat?: unknown; lon?: unknown; tags?: Record<string, unknown> } | null;
    if (!e || e.type !== "node" || typeof e.id !== "number" || seen.has(e.id)) continue;
    if (typeof e.lat !== "number" || typeof e.lon !== "number" || Math.abs(e.lat) > 90 || Math.abs(e.lon) > 180) continue;
    const name = typeof e.tags?.["name"] === "string" ? (e.tags["name"] as string).trim().replace(/\s+/g, " ") : "";
    const ele = parseEle(e.tags?.["ele"]);
    if (!name || ele === null) continue;
    seen.add(e.id);
    out.push({ id: e.id, name, ele, at: { lat: e.lat, lon: e.lon } });
  }
  return out;
}

// ---- Areas and the cache ----

export interface Area {
  readonly key: string;
  readonly center: LatLng;
  readonly radiusKm: PeakRadiusKm;
  /** What is asked for: the radius plus the cell margin. */
  readonly queryRadiusM: number;
}

function cellOf(at: LatLng): { iy: number; ix: number; center: LatLng } {
  const iy = Math.floor((at.lat * M_PER_DEG) / CELL_M);
  const lat = ((iy + 0.5) * CELL_M) / M_PER_DEG;
  const lonStep = CELL_M / (M_PER_DEG * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  const ix = Math.floor(at.lon / lonStep);
  return { iy, ix, center: { lat, lon: (ix + 0.5) * lonStep } };
}

/** The cache cell a point lies in, for a radius. */
export function areaFor(at: LatLng, radiusKm: PeakRadiusKm): Area {
  const { iy, ix, center } = cellOf(at);
  return { key: `${iy}:${ix}`, center, radiusKm, queryRadiusM: radiusKm * 1000 + CELL_MARGIN_M };
}

export interface CachedArea {
  readonly key: string;
  readonly radiusKm: PeakRadiusKm;
  /** When it was fetched (ms). */
  readonly time: number;
  readonly peaks: readonly Peak[];
}

/** Stored compactly: [id, lat, lon, ele, name] per peak. */
type StoredPeak = [number, number, number, number, string];
interface StoredArea { k: string; r: number; t: number; p: StoredPeak[] }

export function serializeCache(areas: readonly CachedArea[]): string {
  const out: StoredArea[] = areas.map((a) => ({
    k: a.key, r: a.radiusKm, t: a.time,
    p: a.peaks.map((p) => [p.id, Math.round(p.at.lat * 1e5) / 1e5, Math.round(p.at.lon * 1e5) / 1e5, p.ele, p.name]),
  }));
  return JSON.stringify({ v: 1, areas: out });
}

export function parseCache(raw: string | null | undefined): CachedArea[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as { v?: unknown; areas?: unknown };
    if (value.v !== 1 || !Array.isArray(value.areas)) return [];
    const out: CachedArea[] = [];
    for (const a of value.areas as StoredArea[]) {
      if (!a || typeof a.k !== "string" || !isPeakRadius(a.r) || typeof a.t !== "number" || !Array.isArray(a.p)) continue;
      const peaks: Peak[] = [];
      for (const p of a.p) {
        if (!Array.isArray(p) || p.length < 5) continue;
        const [id, lat, lon, ele, name] = p;
        if (typeof id !== "number" || typeof lat !== "number" || typeof lon !== "number" || typeof ele !== "number" || typeof name !== "string") continue;
        peaks.push({ id, name, ele, at: { lat, lon } });
      }
      out.push({ key: a.k, radiusKm: a.r, time: a.t, peaks });
    }
    return out.slice(0, MAX_AREAS);
  } catch {
    return [];
  }
}

/** A cached answer that serves this area: same cell, same or larger radius, not expired. */
export function findCached(cache: readonly CachedArea[], area: Area, now: number): CachedArea | null {
  return cache.find((c) => c.key === area.key && c.radiusKm >= area.radiusKm && now - c.time < CACHE_TTL_MS) ?? null;
}

/** Adds an answer: replaces what it covers, newest first, at most MAX_AREAS. */
export function addToCache(cache: readonly CachedArea[], entry: CachedArea): CachedArea[] {
  const others = cache.filter((c) => !(c.key === entry.key && c.radiusKm <= entry.radiusKm));
  return [entry, ...others].slice(0, MAX_AREAS);
}

/** At most MAX_PEAKS_PER_AREA, keeping the highest. */
export function capPeaks(peaks: readonly Peak[], max = MAX_PEAKS_PER_AREA): Peak[] {
  return peaks.length <= max ? [...peaks] : [...peaks].sort((a, b) => b.ele - a.ele).slice(0, max);
}

// ---- The source ----

export type PeakError = "cooldown" | "timeout" | "busy" | "offline" | "server" | "invalid" | "oversized";

export interface PeakOutcome {
  /** The peaks of the area (wider than the radius: filter with {@link sightsFrom}). */
  readonly peaks: readonly Peak[];
  readonly error: PeakError | null;
  readonly fromCache?: boolean;
  /** With "cooldown": seconds until the next request may go out. */
  readonly waitS?: number;
}

export interface PeakStorage {
  load(): Promise<string>;
  save(raw: string): Promise<void>;
}

export interface PeakSourceConfig {
  readonly urls?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly minIntervalMs?: number;
  readonly clock?: () => number;
  readonly storage?: PeakStorage;
}

export interface PeakSource {
  /** The peaks around `here` for a radius: from the cache when it has them, else one request. */
  get(here: LatLng, radiusKm: PeakRadiusKm): Promise<PeakOutcome>;
  /** True when this area is already on the phone (no request would go out). */
  has(here: LatLng, radiusKm: PeakRadiusKm): Promise<boolean>;
  /** How many requests went out (for tests and the README's promise). */
  readonly requests: () => number;
}

export function createPeakSource(config: PeakSourceConfig = {}): PeakSource {
  const urlsFor = (center: LatLng): readonly string[] => config.urls ?? overpassUrlsFor([center], DEFAULT_PEAK_URLS);
  const doFetch = config.fetchImpl ?? ((input, init) => fetch(input, init));
  const clock = config.clock ?? Date.now;
  const minInterval = config.minIntervalMs ?? MIN_INTERVAL_MS;
  let lastRequestAt = Number.NEGATIVE_INFINITY;
  let requests = 0;
  let cache: CachedArea[] | null = null;
  const inflight = new Map<string, Promise<PeakOutcome>>();

  const loadCache = async (): Promise<CachedArea[]> => {
    if (cache) return cache;
    let raw = "";
    try { raw = (await config.storage?.load()) ?? ""; } catch { raw = ""; }
    cache ??= parseCache(raw);
    return cache;
  };

  const fetchOne = async (url: string, query: string): Promise<{ readonly peaks: Peak[] } | { readonly error: PeakError }> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000);
    try {
      // A form POST without own headers: a "simple request", no CORS preflight.
      const response = await doFetch(url, { method: "POST", body: new URLSearchParams({ data: query }), signal: controller.signal });
      if (!response.ok) return { error: [406, 429, 503, 504].includes(response.status) ? "busy" : "server" };
      const declared = Number(response.headers?.get?.("content-length") ?? "0");
      if (declared > MAX_RESPONSE_BYTES) { controller.abort(); return { error: "oversized" }; }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) return { error: "oversized" };
      let parsed: Peak[] | null = null;
      try { parsed = parsePeaks(JSON.parse(text)); } catch { parsed = null; }
      return parsed ? { peaks: parsed } : { error: "invalid" };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return { error: "timeout" };
      if (error instanceof TypeError) return { error: "offline" };
      return { error: "server" };
    } finally {
      clearTimeout(timeout);
    }
  };

  const ask = async (area: Area): Promise<PeakOutcome> => {
    const now = clock();
    if (now - lastRequestAt < minInterval) {
      return { peaks: [], error: "cooldown", waitS: Math.ceil((minInterval - (now - lastRequestAt)) / 1000) };
    }
    lastRequestAt = now;
    requests++;
    const query = buildPeakQuery(area.center, area.queryRadiusM);
    let last: PeakError = "server";
    for (const url of urlsFor(area.center)) {
      const outcome = await fetchOne(url, query);
      if ("peaks" in outcome) {
        const peaks = capPeaks(outcome.peaks);
        cache = addToCache(await loadCache(), { key: area.key, radiusKm: area.radiusKm, time: clock(), peaks });
        void config.storage?.save(serializeCache(cache)).catch(() => undefined);
        return { peaks, error: null };
      }
      if (outcome.error === "offline" && !isOwnOverpass(url)) return { peaks: [], error: "offline" };
      last = outcome.error;
    }
    return { peaks: [], error: last };
  };

  return {
    async get(here, radiusKm) {
      const area = areaFor(here, radiusKm);
      const hit = findCached(await loadCache(), area, clock());
      if (hit) return { peaks: hit.peaks, error: null, fromCache: true };
      const id = `${area.key}/${radiusKm}`;
      const running = inflight.get(id);
      if (running) return running;
      const next = ask(area).finally(() => inflight.delete(id));
      inflight.set(id, next);
      return next;
    },
    async has(here, radiusKm) {
      return findCached(await loadCache(), areaFor(here, radiusKm), clock()) !== null;
    },
    requests: () => requests,
  };
}

/** Made-up peaks around a point for the demo (no network), labelled as demo data by their names. */
export function demoPeaks(around: LatLng): Peak[] {
  const at = (east: number, north: number): LatLng => ({
    lat: around.lat + north / M_PER_DEG,
    lon: around.lon + east / (M_PER_DEG * Math.cos((around.lat * Math.PI) / 180)),
  });
  return [
    { id: -1, name: "Demo Gaisberg", ele: 1287, at: at(5200, 1800) },
    { id: -2, name: "Demo Untersberg", ele: 1973, at: at(-6000, -9000) },
    { id: -3, name: "Demo Schafberg", ele: 1783, at: at(21_000, 14_000) },
    { id: -4, name: "Demo Kapuzinerberg", ele: 636, at: at(600, 900) },
    { id: -5, name: "Demo Hoher Göll", ele: 2522, at: at(4000, -20_000) },
    { id: -6, name: "Demo Watzmann", ele: 2713, at: at(-9000, -24_000) },
    { id: -7, name: "Demo Tennengebirge", ele: 2431, at: at(16_000, -22_000) },
  ];
}

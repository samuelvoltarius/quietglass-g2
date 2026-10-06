import type { LatLng } from "../geo/geometry";
import type { TravelMode } from "../routing/provider";
import type { BBox, PixelPoint, Projector } from "./project";

/**
 * Real streets behind the overview route, from OpenStreetMap via Overpass.
 *
 * Fetched at most once per route (and reused for a reroute that stays inside
 * the area already loaded), never per GPS fix. The display is 288 × 144 and
 * monochrome with grey levels, so the streets are reduced hard: three classes
 * drawn at different brightness, geometry clipped to the image and thinned to
 * whole pixels, and a cap on the total number of segments. Anything going
 * wrong — timeout, a busy server, an oversized or malformed answer — yields
 * no streets, and the overview falls back to the route alone. Navigation
 * never waits for this.
 *
 * Public servers checked on 2026-10-07 (see README): overpass-api.de answers
 * a WebView with `Access-Control-Allow-Origin: *` but returns 406 to a client
 * that sends no Referer; a browser sends one by itself.
 */

/** Major roads are drawn brightest, minor dimmer, footpaths faintest. */
export type RoadClass = "major" | "minor" | "path";

export const ROAD_CLASSES: readonly RoadClass[] = ["major", "minor", "path"];

/** Overpass tag filters per class. Service roads, tracks and areas are never asked for. */
const FILTERS: Readonly<Record<RoadClass, string>> = {
  major: '["highway"~"^(motorway|trunk|primary|secondary)(_link)?$"]',
  minor: '["highway"~"^(tertiary|tertiary_link|unclassified|residential|living_street|pedestrian)$"]',
  // Sidewalks and crossings repeat the street they belong to; areas are not lines.
  path: '["highway"~"^(footway|path|cycleway|steps)$"]["footway"!~"^(sidewalk|crossing|access_aisle)$"]["area"!="yes"]',
};

export const DEFAULT_OVERPASS_URLS: readonly string[] = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

/** Above this the map is too zoomed out for minor roads to be anything but noise. */
export const MINOR_MAX_SPAN_M = 4_000;
/** Footpaths only on foot, and only when zoomed in this far. */
export const PATH_MAX_SPAN_M = 2_500;
/** Above this even major roads are not fetched: too much data for a 288 px picture. */
export const MAJOR_MAX_SPAN_M = 25_000;
/** Largest answer accepted, in bytes (UTF-16 code units of the text). */
export const MAX_RESPONSE_BYTES = 3_000_000;
/** Most street segments drawn; a picture this small holds no more. */
export const MAX_SEGMENTS = 1_500;

export interface Street { readonly cls: RoadClass; readonly points: readonly LatLng[]; }
export interface StreetSegment { readonly cls: RoadClass; readonly from: PixelPoint; readonly to: PixelPoint; }

const M_PER_DEG = 111_320;

/** Width and height of a box in metres, the larger of the two. */
export function spanMeters(box: BBox): number {
  const mid = ((box.south + box.north) / 2) * Math.PI / 180;
  return Math.max((box.north - box.south) * M_PER_DEG, (box.east - box.west) * M_PER_DEG * Math.cos(mid));
}

/** Which road classes are worth fetching for a map showing `box`, travelling by `mode`. */
export function classesFor(box: BBox, mode: TravelMode): RoadClass[] {
  const span = spanMeters(box);
  if (!Number.isFinite(span) || span <= 0 || span > MAJOR_MAX_SPAN_M) return [];
  const classes: RoadClass[] = ["major"];
  if (span <= MINOR_MAX_SPAN_M) classes.push("minor");
  if (mode === "walking" && span <= PATH_MAX_SPAN_M) classes.push("path");
  return classes;
}

/**
 * The box to fetch: the visible area plus a margin, so a reroute nearby is
 * answered from what is already loaded, rounded outwards to 4 decimals
 * (about 10 m) so it is stable and says no more about the route than needed.
 * Null when the area crosses the antimeridian or a pole.
 */
export function fetchBox(view: BBox, margin = 0.15): BBox | null {
  const dLat = (view.north - view.south) * margin;
  const dLon = (view.east - view.west) * margin;
  const down = (value: number): number => Math.floor(value * 1e4) / 1e4;
  const up = (value: number): number => Math.ceil(value * 1e4) / 1e4;
  const box = { south: down(view.south - dLat), west: down(view.west - dLon), north: up(view.north + dLat), east: up(view.east + dLon) };
  if (![box.south, box.west, box.north, box.east].every(Number.isFinite)) return null;
  if (box.south < -90 || box.north > 90 || box.west < -180 || box.east > 180) return null;
  if (box.south >= box.north || box.west >= box.east) return null;
  return box;
}

export function containsBox(outer: BBox, inner: BBox): boolean {
  return inner.south >= outer.south && inner.north <= outer.north && inner.west >= outer.west && inner.east <= outer.east;
}

/**
 * One query, one answer: a set per class, each followed by a count element
 * that marks where it ends. Only ids and geometry are returned (no tags), and
 * the geometry is cut to the box server-side — both keep the answer small.
 */
export function buildOverpassQuery(box: BBox, classes: readonly RoadClass[], serverTimeoutS = 10): string {
  const b = [box.south, box.west, box.north, box.east].map((value) => value.toFixed(4)).join(",");
  const parts = classes.map((cls, index) => `way${FILTERS[cls]}(${b})->.s${index};.s${index} out ids geom(${b}) qt;.s${index} out count;`);
  return `[out:json][timeout:${serverTimeoutS}];` + parts.join("");
}

/**
 * Reads the answer of {@link buildOverpassQuery}. Ways before the first count
 * element are the first class, and so on. A missing count, an unknown element
 * or a bad coordinate is skipped rather than guessed at; an answer that is not
 * an Overpass result at all returns null.
 */
export function parseOverpass(value: unknown, classes: readonly RoadClass[]): Street[] | null {
  const result = value as { elements?: unknown; remark?: unknown } | null;
  const elements = result?.elements;
  if (!Array.isArray(elements)) return null;
  // An overloaded server answers 200 with a runtime-error remark and a partial
  // list; drawing that would show streets missing at random.
  if (typeof result?.remark === "string" && /error/i.test(result.remark)) return null;
  const streets: Street[] = [];
  let section = 0;
  for (const element of elements) {
    const e = element as { type?: unknown; geometry?: unknown } | null;
    if (e?.type === "count") { section++; continue; }
    const cls = classes[section];
    if (e?.type !== "way" || !cls || !Array.isArray(e.geometry)) continue;
    const points: LatLng[] = [];
    for (const node of e.geometry) {
      const n = node as { lat?: unknown; lon?: unknown } | null;
      // Geometry cut to a box marks dropped nodes as null; that breaks the line.
      if (typeof n?.lat !== "number" || typeof n?.lon !== "number" || !Number.isFinite(n.lat) || !Number.isFinite(n.lon)) {
        if (points.length >= 2) streets.push({ cls, points: points.splice(0) }); else points.length = 0;
        continue;
      }
      points.push({ lat: n.lat, lon: n.lon });
    }
    if (points.length >= 2) streets.push({ cls, points });
  }
  return streets;
}

/**
 * Liang–Barsky: the part of a segment inside the rectangle, or null. Lines
 * leaving the image are cut at its edge instead of being drawn into nowhere.
 */
export function clipSegment(a: PixelPoint, b: PixelPoint, minX: number, minY: number, maxX: number, maxY: number): [PixelPoint, PixelPoint] | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  let t0 = 0, t1 = 1;
  const edges: Array<[number, number]> = [[-dx, a.x - minX], [dx, maxX - a.x], [-dy, a.y - minY], [dy, maxY - a.y]];
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [{ x: a.x + t0 * dx, y: a.y + t0 * dy }, { x: a.x + t1 * dx, y: a.y + t1 * dy }];
}

/**
 * Projects, clips and thins the streets for one image: points closer than
 * `minStep` pixels to the last kept one are dropped, segments are cut to the
 * image, and at most `cap` segments are kept — major roads first, so a dense
 * old town loses footpaths before it loses its main street.
 */
export function prepareStreets(
  streets: readonly Street[],
  projector: Pick<Projector, "toPixel">,
  width: number,
  height: number,
  cap = MAX_SEGMENTS,
  minStep = 1.5,
): StreetSegment[] {
  const byClass: Record<RoadClass, StreetSegment[]> = { major: [], minor: [], path: [] };
  for (const street of streets) {
    let last: PixelPoint | null = null;
    const pixels = street.points.map(projector.toPixel);
    pixels.forEach((pixel, index) => {
      if (!Number.isFinite(pixel.x) || !Number.isFinite(pixel.y)) return;
      if (!last) { last = pixel; return; }
      const isEnd = index === pixels.length - 1;
      if (!isEnd && Math.hypot(pixel.x - last.x, pixel.y - last.y) < minStep) return;
      const clipped = clipSegment(last, pixel, 0, 0, width, height);
      if (clipped && (clipped[0].x !== clipped[1].x || clipped[0].y !== clipped[1].y)) {
        byClass[street.cls].push({ cls: street.cls, from: clipped[0], to: clipped[1] });
      }
      last = pixel;
    });
  }
  const out: StreetSegment[] = [];
  for (const cls of ROAD_CLASSES) {
    for (const segment of byClass[cls]) {
      if (out.length >= cap) return out;
      out.push(segment);
    }
  }
  return out;
}

export type StreetsError = "timeout" | "busy" | "server" | "oversized" | "offline" | "invalid" | "cooldown";

export interface StreetsOutcome {
  readonly streets: readonly Street[];
  readonly error: StreetsError | null;
}

export interface StreetSourceConfig {
  readonly urls?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Pause after the servers refused or failed, before asking again (Overpass asks ≥ 30 s after a 429/406). */
  readonly cooldownMs?: number;
  readonly clock?: () => number;
}

export interface StreetSource {
  /** Streets of these classes in `box`; from memory when an earlier answer already covers it. */
  load(box: BBox, classes: readonly RoadClass[]): Promise<StreetsOutcome>;
}

/**
 * Overpass client: one request per call at most, the next server tried only
 * when the first fails, an answer reused for any box inside it, and a pause
 * after failures so a struggling public server is not asked again at once.
 */
export function createStreetSource(config: StreetSourceConfig = {}): StreetSource {
  const urls = config.urls ?? DEFAULT_OVERPASS_URLS;
  const doFetch = config.fetchImpl ?? ((input, init) => fetch(input, init));
  const clock = config.clock ?? Date.now;
  const maxBytes = config.maxBytes ?? MAX_RESPONSE_BYTES;
  let cache: { box: BBox; classes: readonly RoadClass[]; streets: readonly Street[] } | null = null;
  let blockedUntil = 0;

  const fetchOne = async (url: string, query: string): Promise<{ readonly text: string } | { readonly error: StreetsError }> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 12_000);
    try {
      // A form body keeps this a "simple" CORS request: no preflight round trip.
      const response = await doFetch(url, { method: "POST", body: new URLSearchParams({ data: query }), signal: controller.signal });
      if (!response.ok) {
        return { error: [406, 429, 503, 504].includes(response.status) ? "busy" : "server" };
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > maxBytes) { controller.abort(); return { error: "oversized" }; }
      const text = await response.text();
      return text.length > maxBytes ? { error: "oversized" } : { text };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return { error: "timeout" };
      if (error instanceof TypeError) return { error: "offline" };
      return { error: "server" };
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    async load(box, classes): Promise<StreetsOutcome> {
      if (!classes.length) return { streets: [], error: null };
      if (cache && containsBox(cache.box, box) && classes.every((cls) => cache!.classes.includes(cls))) {
        return { streets: cache.streets.filter((street) => classes.includes(street.cls)), error: null };
      }
      if (clock() < blockedUntil) return { streets: [], error: "cooldown" };
      const query = buildOverpassQuery(box, classes);
      let last: StreetsError = "server";
      for (const url of urls) {
        const outcome = await fetchOne(url, query);
        if ("error" in outcome) {
          // Offline means every server would fail the same way; do not count it against them.
          if (outcome.error === "offline") return { streets: [], error: "offline" };
          last = outcome.error;
          continue;
        }
        let parsed: Street[] | null = null;
        try { parsed = parseOverpass(JSON.parse(outcome.text), classes); } catch { parsed = null; }
        if (!parsed) { last = "invalid"; continue; }
        cache = { box, classes: [...classes], streets: parsed };
        return { streets: parsed, error: null };
      }
      blockedUntil = clock() + (config.cooldownMs ?? 60_000);
      return { streets: [], error: last };
    },
  };
}

/**
 * Everything between a route and the street segments of its overview image:
 * which classes to ask for at this zoom, which box to fetch, and the answer
 * cut to the picture. Never throws; no streets is a valid outcome.
 */
export async function streetsForRoute(
  source: StreetSource,
  projector: Projector | null,
  mode: TravelMode,
  width: number,
  height: number,
): Promise<{ readonly segments: readonly StreetSegment[]; readonly error: StreetsError | null }> {
  const view = projector?.bounds;
  if (!projector || !view) return { segments: [], error: null };
  const classes = classesFor(view, mode);
  const box = fetchBox(view);
  if (!box || !classes.length) return { segments: [], error: null };
  try {
    const outcome = await source.load(box, classes);
    return { segments: prepareStreets(outcome.streets, projector, width, height), error: outcome.error };
  } catch {
    return { segments: [], error: "server" };
  }
}

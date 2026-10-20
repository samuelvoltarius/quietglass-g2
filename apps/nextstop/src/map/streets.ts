import type { LatLon } from "../route/walk";

/**
 * Streets behind the walking map, from OpenStreetMap via Overpass.
 *
 * Ported from OpenGlance Nav (apps/openglance-nav/src/overview/streets.ts),
 * reduced to what a walk needs: three road classes, one bounding box per
 * walking leg, bounded in time and size. Anything going wrong - a timeout, a
 * busy server, an oversized or malformed answer - yields no streets, and the
 * map is drawn from the route and the markers alone. Guidance never waits
 * for this and never fails because of it.
 *
 * The only network targets are the Overpass endpoints listed here (and in
 * app.json's network whitelist). Overpass answers a WebView with
 * `Access-Control-Allow-Origin: *`; a POST with a form body keeps the call a
 * "simple" request, so no preflight round trip is needed.
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

/** The origins the app may call (the same two as OpenGlance, and the network whitelist of app.json). */
export const OVERPASS_ORIGINS: readonly string[] = ["https://overpass-api.de", "https://overpass.private.coffee"];
export const OVERPASS_URLS: readonly string[] = OVERPASS_ORIGINS.map((origin) => `${origin}/api/interpreter`);

/** Above this the map is too zoomed out for minor roads to be anything but noise. */
export const MINOR_MAX_SPAN_M = 4_000;
/** Footpaths only when the leg is short enough for them to be readable. */
export const PATH_MAX_SPAN_M = 2_500;
/** Above this even major roads are not fetched: too much data for a 288 px picture. */
export const MAJOR_MAX_SPAN_M = 25_000;
/** Largest answer accepted, in characters of the text. */
export const MAX_RESPONSE_CHARS = 2_500_000;
/** Most street segments drawn; a picture this small holds no more. */
export const MAX_SEGMENTS = 1_200;
/** The whole fetch (all endpoints together) gives up after this long. */
export const STREETS_TOTAL_MS = 8_000;
/** One endpoint gets at most this long. */
export const STREETS_ENDPOINT_MS = 5_000;

export interface BBox { readonly south: number; readonly west: number; readonly north: number; readonly east: number }

export interface Street {
  readonly cls: RoadClass;
  readonly points: readonly LatLon[];
  /** `name` of the way, else the first `ref` ("B1"); absent without either. Never asked for footpaths. */
  readonly name?: string;
}
export interface PixelPoint { readonly x: number; readonly y: number }
export interface StreetSegment { readonly cls: RoadClass; readonly from: PixelPoint; readonly to: PixelPoint }

const M_PER_DEG = 111_320;

/** Width and height of a box in metres, the larger of the two. */
export function spanMeters(box: BBox): number {
  const mid = ((box.south + box.north) / 2) * Math.PI / 180;
  return Math.max((box.north - box.south) * M_PER_DEG, (box.east - box.west) * M_PER_DEG * Math.cos(mid));
}

/** Which road classes are worth fetching for a leg whose box is `box`, on foot. */
export function classesFor(box: BBox): RoadClass[] {
  const span = spanMeters(box);
  if (!Number.isFinite(span) || span <= 0 || span > MAJOR_MAX_SPAN_M) return [];
  const classes: RoadClass[] = ["major"];
  if (span <= MINOR_MAX_SPAN_M) classes.push("minor");
  if (span <= PATH_MAX_SPAN_M) classes.push("path");
  return classes;
}

/**
 * The box to fetch for one walking leg: every point of it (start, end, the
 * route's shape) plus a margin, so a reroute close by is answered from what is
 * already loaded; rounded outwards to 4 decimals (about 10 m) so it is stable.
 * Null for nothing to fetch, or an area across the antimeridian or a pole.
 */
export function legBox(points: readonly LatLon[], marginM = 220): BBox | null {
  if (points.length === 0) return null;
  let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
  for (const point of points) {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) continue;
    south = Math.min(south, point.lat); north = Math.max(north, point.lat);
    west = Math.min(west, point.lon); east = Math.max(east, point.lon);
  }
  if (!Number.isFinite(south)) return null;
  const dLat = marginM / 110_540;
  const dLon = marginM / (M_PER_DEG * Math.max(0.01, Math.cos(((south + north) / 2) * Math.PI / 180)));
  const down = (value: number): number => Math.floor(value * 1e4) / 1e4;
  const up = (value: number): number => Math.ceil(value * 1e4) / 1e4;
  const box = { south: down(south - dLat), west: down(west - dLon), north: up(north + dLat), east: up(east + dLon) };
  if (box.south < -90 || box.north > 90 || box.west < -180 || box.east > 180) return null;
  return box;
}

export function containsBox(outer: BBox, inner: BBox): boolean {
  return inner.south >= outer.south && inner.north <= outer.north && inner.west >= outer.west && inner.east <= outer.east;
}

/**
 * One query, one answer: a set per class, each followed by a count element
 * that marks where it ends. Ids and geometry, plus the tags of roads (their
 * `name` / `ref` label the map; footpaths go without), cut to the box
 * server-side - both keep the answer small.
 */
export function buildOverpassQuery(box: BBox, classes: readonly RoadClass[], serverTimeoutS = 6): string {
  const b = [box.south, box.west, box.north, box.east].map((value) => value.toFixed(4)).join(",");
  const parts = classes.map((cls, index) => `way${FILTERS[cls]}(${b})->.s${index};.s${index} out ids ${cls === "path" ? "" : "tags "}geom(${b}) qt;.s${index} out count;`);
  return `[out:json][timeout:${serverTimeoutS}];` + parts.join("");
}

/** The name a way is known by: its `name`, else the first of its `ref` ("B1;E55" gives "B1"). */
export function nameOf(tags: unknown): string | undefined {
  const t = tags as { name?: unknown; ref?: unknown } | null | undefined;
  const name = typeof t?.name === "string" ? t.name.trim() : "";
  if (name) return name;
  const ref = typeof t?.ref === "string" ? (t.ref.split(";")[0] ?? "").trim() : "";
  return ref || undefined;
}

/**
 * Reads the answer of {@link buildOverpassQuery}. Ways before the first count
 * element are the first class, and so on. A bad coordinate breaks the line
 * rather than being guessed at; an answer that is not an Overpass result (or
 * carries a runtime-error remark: partial data) returns null.
 */
export function parseOverpass(value: unknown, classes: readonly RoadClass[]): Street[] | null {
  const result = value as { elements?: unknown; remark?: unknown } | null;
  const elements = result?.elements;
  if (!Array.isArray(elements)) return null;
  if (typeof result?.remark === "string" && /error/i.test(result.remark)) return null;
  const streets: Street[] = [];
  let section = 0;
  for (const element of elements) {
    const e = element as { type?: unknown; geometry?: unknown; tags?: unknown } | null;
    const name = e?.type === "way" ? nameOf(e.tags) : undefined;
    if (e?.type === "count") { section += 1; continue; }
    const cls = classes[section];
    if (e?.type !== "way" || !cls || !Array.isArray(e.geometry)) continue;
    let points: LatLon[] = [];
    for (const node of e.geometry) {
      const n = node as { lat?: unknown; lon?: unknown } | null;
      // Geometry cut to a box marks dropped nodes as null; that breaks the line.
      if (typeof n?.lat !== "number" || typeof n?.lon !== "number" || !Number.isFinite(n.lat) || !Number.isFinite(n.lon)) {
        if (points.length >= 2) streets.push({ cls, points, ...(name ? { name } : {}) });
        points = [];
        continue;
      }
      points.push({ lat: n.lat, lon: n.lon });
    }
    if (points.length >= 2) streets.push({ cls, points, ...(name ? { name } : {}) });
  }
  return streets;
}

/** Liang-Barsky: the part of a segment inside the rectangle, or null. */
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
 * Projects, clips and thins the streets for one picture: points closer than
 * `minStep` pixels to the last kept one are dropped, segments are cut to the
 * picture, and at most `cap` segments are kept - major roads first, so a dense
 * old town loses footpaths before it loses its main street.
 */
export function prepareStreets(
  streets: readonly Street[], toPixel: (point: LatLon) => PixelPoint, width: number, height: number, cap = MAX_SEGMENTS, minStep = 1.5,
): StreetSegment[] {
  const byClass: Record<RoadClass, StreetSegment[]> = { major: [], minor: [], path: [] };
  for (const street of streets) {
    let last: PixelPoint | null = null;
    const pixels = street.points.map(toPixel);
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

export type StreetsError = "timeout" | "busy" | "server" | "oversized" | "offline" | "invalid";

export interface StreetsOutcome { readonly streets: readonly Street[]; readonly error: StreetsError | null }

export interface StreetSourceConfig {
  readonly urls?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  /** One endpoint's share. */
  readonly timeoutMs?: number;
  /** The whole load, all endpoints together. */
  readonly totalMs?: number;
  readonly maxChars?: number;
}

export interface StreetSource {
  /** Streets of these classes in `box`; from memory when the last answer already covers it. Never throws. */
  load(box: BBox, classes: readonly RoadClass[]): Promise<StreetsOutcome>;
}

/**
 * Overpass client: one request at a time, the next endpoint tried only when
 * the first fails, the whole thing bounded by `totalMs` (a fetch that ignores
 * its abort signal is raced against the clock as well), an answer reused for
 * any box inside it.
 */
export function createStreetSource(config: StreetSourceConfig = {}): StreetSource {
  const urls = config.urls ?? OVERPASS_URLS;
  const maxChars = config.maxChars ?? MAX_RESPONSE_CHARS;
  let cache: { box: BBox; classes: readonly RoadClass[]; streets: readonly Street[] } | null = null;

  const fetchOne = async (url: string, query: string, ms: number): Promise<{ readonly text: string } | { readonly error: StreetsError }> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clock = new Promise<{ readonly error: StreetsError }>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve({ error: "timeout" }); }, ms);
    });
    const request = (async (): Promise<{ readonly text: string } | { readonly error: StreetsError }> => {
      try {
        const doFetch = config.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
        const response = await doFetch(url, { method: "POST", body: new URLSearchParams({ data: query }), signal: controller.signal });
        if (!response.ok) return { error: [406, 429, 503, 504].includes(response.status) ? "busy" : "server" };
        const declared = Number(response.headers?.get("content-length") ?? "0");
        if (declared > maxChars) { controller.abort(); return { error: "oversized" }; }
        const text = await response.text();
        return text.length > maxChars ? { error: "oversized" } : { text };
      } catch (error) {
        if ((error as { name?: string } | null)?.name === "AbortError") return { error: "timeout" };
        return { error: error instanceof TypeError ? "offline" : "server" };
      }
    })();
    try {
      return await Promise.race([request, clock]);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async load(box, classes): Promise<StreetsOutcome> {
      if (classes.length === 0) return { streets: [], error: null };
      if (cache && containsBox(cache.box, box) && classes.every((cls) => cache!.classes.includes(cls))) {
        return { streets: cache.streets.filter((street) => classes.includes(street.cls)), error: null };
      }
      const query = buildOverpassQuery(box, classes);
      const deadline = Date.now() + (config.totalMs ?? STREETS_TOTAL_MS);
      let last: StreetsError = "server";
      for (const url of urls) {
        const left = deadline - Date.now();
        if (left < 300) { last = "timeout"; break; }
        const outcome = await fetchOne(url, query, Math.min(config.timeoutMs ?? STREETS_ENDPOINT_MS, left));
        if ("error" in outcome) {
          // Offline means every endpoint would fail the same way.
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
      return { streets: [], error: last };
    },
  };
}

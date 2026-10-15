import type { LatLng } from "../geo/geometry";
import type { TravelMode } from "../routing/provider";
import type { RoadClass, Street, StreetsError, StreetsOutcome } from "./streets";
import { parseSpeedLimits, type SpeedLimitSpan } from "../nav/speed";

/**
 * Street names along the route from your own Valhalla server (private build:
 * `VITE_STREETS_URL`, usually the same server as `VITE_ROUTER_URL`).
 *
 * Valhalla's `trace_attributes` walks the route's own shape and returns, for
 * every edge, its names and road class. That gives the map labels ("the street
 * of the next turn", "the street you are on") without asking the public
 * Overpass servers - one GET with the shape in the query (`?json=`), a
 * "simple" CORS request without a preflight, answered in ~0.1-0.3 s even for
 * a 300 km route. It only knows the route's own streets, not the ones around
 * it; those still come from Overpass when that answers (best effort).
 */

/** Build-time default of a private build; empty in the public one. */
const BUILD_STREETS_URL: string | undefined = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_STREETS_URL;

export function buildStreetsUrl(): string {
  return (BUILD_STREETS_URL ?? "").trim().replace(/\/+$/, "");
}

/** Encoded polyline with six decimals (Valhalla's precision, not Google's five). */
export function encodePolyline6(points: readonly LatLng[]): string {
  let out = "";
  let lastLat = 0, lastLon = 0;
  const put = (value: number): void => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>>= 5; }
    out += String.fromCharCode(v + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e6), lon = Math.round(p.lon * 1e6);
    put(lat - lastLat); put(lon - lastLon);
    lastLat = lat; lastLon = lon;
  }
  return out;
}

const COSTING: Readonly<Record<TravelMode, string>> = { driving: "auto", cycling: "bicycle", walking: "pedestrian" };

/** Longest shape sent: beyond this the URL gets long and the map is zoomed out too far for names anyway. */
export const MAX_TRACE_POINTS = 20_000;

export function buildTraceUrl(base: string, shape: readonly LatLng[], mode: TravelMode): string {
  const request = {
    encoded_polyline: encodePolyline6(shape.slice(0, MAX_TRACE_POINTS)),
    // The shape is Valhalla's own route: walk its edges; snap only if it came from elsewhere.
    shape_match: "walk_or_snap",
    costing: COSTING[mode],
    // Speed limit and the router's own speed ride along in the same request (the speed display):
    // still one call per route.
    units: "kilometers",
    filters: {
      attributes: ["edge.names", "edge.road_class", "edge.begin_shape_index", "edge.end_shape_index", "edge.speed_limit", "edge.speed"],
      action: "include",
    },
  };
  return `${base}/trace_attributes?json=${encodeURIComponent(JSON.stringify(request))}`;
}

/**
 * The longest prefix of the shape whose request URL stays within `maxLength`
 * characters (a public server answers an overlong GET with 414). The indices
 * of a prefix are the route's own, so its speed limits still map onto the
 * route; beyond it they are simply unknown. Binary search: the URL grows with
 * the number of points.
 */
export function fittingPoints(base: string, shape: readonly LatLng[], mode: TravelMode, maxLength: number): number {
  const all = Math.min(shape.length, MAX_TRACE_POINTS);
  if (buildTraceUrl(base, shape.slice(0, all), mode).length <= maxLength) return all;
  let low = 0, high = all;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (buildTraceUrl(base, shape.slice(0, mid), mode).length <= maxLength) low = mid; else high = mid;
  }
  return low >= 2 ? low : 0;
}

const MAJOR = new Set(["motorway", "trunk", "primary", "secondary"]);

function classOf(roadClass: unknown, mode: TravelMode): RoadClass {
  if (typeof roadClass === "string" && MAJOR.has(roadClass)) return "major";
  return mode === "walking" && roadClass === "service_other" ? "path" : "minor";
}

/**
 * Edges → streets: consecutive edges with the same name and class are joined
 * into one street, so a long road gets one label, not one per crossing. The
 * first name is the street's name ("Vogelweiderstraße"), the rest are refs
 * ("B150"); a road with only a ref is called by it. Null when the answer is
 * not a trace_attributes result.
 */
export function parseTrace(value: unknown, shape: readonly LatLng[], mode: TravelMode): Street[] | null {
  const edges = (value as { edges?: unknown } | null)?.edges;
  if (!Array.isArray(edges)) return null;
  const streets: Street[] = [];
  let current: { cls: RoadClass; name: string | undefined; from: number; to: number } | null = null;
  const flush = (): void => {
    if (!current) return;
    const points = shape.slice(current.from, current.to + 1);
    if (points.length >= 2) streets.push({ cls: current.cls, points, ...(current.name ? { name: current.name } : {}) });
    current = null;
  };
  for (const raw of edges) {
    const e = raw as { names?: unknown; road_class?: unknown; begin_shape_index?: unknown; end_shape_index?: unknown } | null;
    const from = e?.begin_shape_index, to = e?.end_shape_index;
    if (typeof from !== "number" || typeof to !== "number" || !(to > from) || to >= shape.length) { flush(); continue; }
    const names = Array.isArray(e?.names) ? (e!.names as unknown[]).filter((n): n is string => typeof n === "string" && n.trim() !== "") : [];
    const name = names[0]?.trim();
    const cls = classOf(e?.road_class, mode);
    if (current && current.cls === cls && current.name === name && current.to === from) { current.to = to; continue; }
    flush();
    current = { cls, name, from, to };
  }
  flush();
  return streets;
}

export interface RouteStreetConfig {
  readonly url: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Longest request URL; the shape is cut to a prefix that fits (public servers). Unlimited when absent. */
  readonly maxUrlLength?: number;
  /**
   * With `maxUrlLength`: how many requests one route may take, one after the
   * other (the rest of the shape continues where the previous part ended), so
   * the speed limits - and the brake hints built on them - cover more than the
   * first stretch of a long route. Default 1: the prefix only.
   */
  readonly chunks?: number;
  /** Pause between two parts (the public server allows about one request per second). */
  readonly chunkGapMs?: number;
}

/** Street names and speed limits along the route, from one trace_attributes answer. */
export interface RouteTraceOutcome extends StreetsOutcome {
  readonly limits: readonly SpeedLimitSpan[];
}

export interface RouteStreetSource {
  load(shape: readonly LatLng[], mode: TravelMode): Promise<RouteTraceOutcome>;
}

export function createRouteStreetSource(config: RouteStreetConfig): RouteStreetSource {
  const doFetch = config.fetchImpl ?? ((input, init) => fetch(input, init));
  const source: RouteStreetSource = {
    async load(shape, mode): Promise<RouteTraceOutcome> {
      const none = (error: StreetsError | null): RouteTraceOutcome => ({ streets: [], limits: [], error });
      if (shape.length < 2 || !config.url) return none(null);
      const parts = config.maxUrlLength ? Math.max(1, Math.floor(config.chunks ?? 1)) : 1;
      const streets: Street[] = [];
      const limits: SpeedLimitSpan[] = [];
      let start = 0;
      for (let part = 0; part < parts && start < shape.length - 1; part++) {
        const rest = start > 0 ? shape.slice(start) : shape;
        const count = config.maxUrlLength ? fittingPoints(config.url, rest, mode, config.maxUrlLength) : rest.length;
        if (count < 2) break;
        if (part > 0) await new Promise((resolve) => setTimeout(resolve, config.chunkGapMs ?? 1_100));
        const piece = count < rest.length ? rest.slice(0, count) : rest;
        const outcome = await loadPiece(piece, mode);
        // A later part failing keeps what the earlier ones brought.
        if (outcome.error !== null) return part === 0 ? none(outcome.error) : { streets, limits, error: null };
        streets.push(...outcome.streets);
        for (const span of outcome.limits) limits.push({ ...span, from: span.from + start, to: span.to + start });
        if (count >= rest.length) break;
        // The next part starts on the last point of this one, so the indices stay continuous.
        start += count - 1;
      }
      return { streets, limits, error: null };
    },
  };
  return source;

  async function loadPiece(part: readonly LatLng[], mode: TravelMode): Promise<RouteTraceOutcome> {
    const none = (error: StreetsError | null): RouteTraceOutcome => ({ streets: [], limits: [], error });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000);
    try {
      const response = await doFetch(buildTraceUrl(config.url, part, mode), { signal: controller.signal });
      if (!response.ok) return none([429, 503, 504].includes(response.status) ? "busy" : "server");
      let value: unknown = null;
      try { value = await response.json(); } catch { value = null; }
      const parsed = parseTrace(value, part, mode);
      return parsed ? { streets: parsed, limits: parseSpeedLimits(value, part.length) ?? [], error: null } : none("invalid");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return none("timeout");
      if (error instanceof TypeError) return none("offline");
      return none("server");
    } finally {
      clearTimeout(timeout);
    }
  }
}

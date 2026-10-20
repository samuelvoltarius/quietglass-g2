import { metresBetween } from "../transit/types";

/**
 * Turn-by-turn for the walking parts of a connection.
 *
 * MOTIS' own walk legs carry steps, but they all say CONTINUE and rarely name a
 * street (checked against api.transitous.org), so they cannot be turned into
 * "turn left here". A pedestrian route from Valhalla on OpenStreetMap data can:
 * the public FOSSGIS server by default, or a server of your own in a private
 * build (VITE_ROUTER_URL at build time).
 */

export type TurnType =
  | "depart" | "arrive" | "straight"
  | "left" | "slightLeft" | "sharpLeft"
  | "right" | "slightRight" | "sharpRight"
  | "uturn" | "roundabout";

export interface Maneuver {
  readonly type: TurnType;
  readonly street?: string;
  /** Metres from this manoeuvre to the next. */
  readonly length: number;
  /** Index into the shape where the manoeuvre happens. */
  readonly shapeIndex: number;
}

export interface LatLon { readonly lat: number; readonly lon: number }

export interface WalkRoute {
  readonly shape: readonly LatLon[];
  readonly maneuvers: readonly Maneuver[];
  readonly distance: number;
  readonly duration: number;
  /** Metres along the shape at each shape point, for progress along the route. */
  readonly along: readonly number[];
}

/** A private build can point at its own Valhalla; the public one is FOSSGIS. */
const BUILD_ROUTER: string | undefined = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_ROUTER_URL;
export const PUBLIC_ROUTER = "https://valhalla1.openstreetmap.de";
export const ROUTER_URL = (BUILD_ROUTER && BUILD_ROUTER !== "" ? BUILD_ROUTER : PUBLIC_ROUTER).replace(/\/+$/, "");

/** Valhalla's polyline, precision 6 (precision 5 would misplace everything tenfold, silently). */
export function decodePolyline(encoded: string, precision = 6): LatLon[] {
  const factor = 10 ** precision;
  const points: LatLon[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const next = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lon += next();
    points.push({ lat: lat / factor, lon: lon / factor });
  }
  return points;
}

/** Valhalla's manoeuvre numbers; anything unknown is "straight", which never invents a turn. */
export function mapType(type: number): TurnType {
  switch (type) {
    case 1: case 2: case 3: return "depart";
    case 4: case 5: case 6: return "arrive";
    case 9: return "slightRight";
    case 10: return "right";
    case 11: return "sharpRight";
    case 12: case 13: return "uturn";
    case 14: return "sharpLeft";
    case 15: return "left";
    case 16: return "slightLeft";
    case 23: return "slightRight";
    case 24: return "slightLeft";
    case 26: case 27: return "roundabout";
    default: return "straight";
  }
}

function cumulative(shape: readonly LatLon[]): number[] {
  const along = [0];
  for (let i = 1; i < shape.length; i += 1) {
    const a = shape[i - 1]!;
    const b = shape[i]!;
    along.push(along[i - 1]! + metresBetween(a.lat, a.lon, b.lat, b.lon));
  }
  return along;
}

/** Shorter than this, a "turn" is a kerb or a zigzag of the pavement, not a decision. */
export const MIN_TURN_METRES = 12;

/** Reads the answer of Valhalla's `/route`; null when it carries nothing to walk by. */
export function parseWalkRoute(raw: unknown): WalkRoute | null {
  const trip = (raw as { trip?: { legs?: unknown[]; summary?: Record<string, unknown> } } | null)?.trip;
  const leg = trip?.legs?.[0] as { shape?: unknown; maneuvers?: unknown[] } | undefined;
  if (!leg || typeof leg.shape !== "string" || !Array.isArray(leg.maneuvers)) return null;
  const shape = decodePolyline(leg.shape, 6);
  if (shape.length < 2) return null;

  const all: Maneuver[] = [];
  for (const entry of leg.maneuvers) {
    const m = entry as Record<string, unknown>;
    const streets = Array.isArray(m["street_names"]) ? m["street_names"] as unknown[] : [];
    const street = typeof streets[0] === "string" ? streets[0] : undefined;
    all.push({
      type: mapType(typeof m["type"] === "number" ? m["type"] : 0),
      ...(street ? { street } : {}),
      // Kilometres, because the request asks for units=kilometers.
      length: (typeof m["length"] === "number" ? m["length"] : 0) * 1000,
      shapeIndex: Math.min(shape.length - 1, typeof m["begin_shape_index"] === "number" ? m["begin_shape_index"] : 0),
    });
  }
  // Keep the start, the arrival and every turn that is followed by a stretch worth walking.
  const maneuvers = all.filter((m, index) => index === 0 || m.type === "arrive" || m.length >= MIN_TURN_METRES);
  if (maneuvers.length === 0) return null;

  const along = cumulative(shape);
  const summary = trip?.summary ?? {};
  return {
    shape, maneuvers, along,
    distance: typeof summary["length"] === "number" ? summary["length"] * 1000 : along[along.length - 1]!,
    duration: typeof summary["time"] === "number" ? summary["time"] : 0,
  };
}

export interface WalkOptions {
  readonly baseUrl?: string;
  readonly language?: "de" | "en";
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Asks for a pedestrian route. A GET with `?json=` is a "simple" request, so
 * the glasses' WebView sends no CORS preflight (a self-hosted Valhalla answers
 * OPTIONS with 405). The client id header is sent only to the public server,
 * which allows it; elsewhere it would bring the preflight back.
 */
export async function fetchWalkRoute(from: LatLon, to: LatLon, options: WalkOptions = {}): Promise<WalkRoute | null> {
  const base = (options.baseUrl ?? ROUTER_URL).replace(/\/+$/, "");
  const body = {
    locations: [{ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }],
    costing: "pedestrian",
    directions_options: { units: "kilometers", language: options.language === "en" ? "en-US" : "de-DE" },
  };
  const headers: Record<string, string> = {};
  if (base === PUBLIC_ROUTER) headers["X-Client-Id"] = "quietglass-nextstop";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  try {
    const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const response = await doFetch(`${base}/route?json=${encodeURIComponent(JSON.stringify(body))}`, {
      method: "GET", headers, signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseWalkRoute(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

/** Where a walker is on a route, and what comes next. */
export interface WalkNav {
  /** The next decision: a turn, or the arrival. */
  readonly next: Maneuver;
  /** Metres to it, along the route. */
  readonly toNext: number;
  /** Length of the stretch that ends at it (from the previous manoeuvre), for the approach bar. */
  readonly stretch: number;
  /** Metres still to walk to the end. */
  readonly remaining: number;
  /** How far the walker is from the route itself. */
  readonly off: number;
  /** The walker is closer than this to the end of the route. */
  readonly atEnd: boolean;
  /** The street the walker is on now (that of the manoeuvre passed last), when the route names it. */
  readonly current?: string;
  /** Where along the route the next decision is (index into the shape), for the map. */
  readonly nextShapeIndex?: number;
}

/** Further than this from the route, the walker has gone the wrong way: plan afresh. */
export const OFF_ROUTE_METRES = 80;

/** Projects a point onto the route: distance to the line, and metres walked along it. */
export function project(route: WalkRoute, at: LatLon): { off: number; along: number } {
  const cosLat = Math.cos((at.lat * Math.PI) / 180);
  let best = { off: Number.POSITIVE_INFINITY, along: 0 };
  for (let i = 1; i < route.shape.length; i += 1) {
    const a = route.shape[i - 1]!;
    const b = route.shape[i]!;
    // Local flat metres around the point: good to centimetres over a segment.
    const ax = (a.lon - at.lon) * 111320 * cosLat;
    const ay = (a.lat - at.lat) * 110540;
    const bx = (b.lon - at.lon) * 111320 * cosLat;
    const by = (b.lat - at.lat) * 110540;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const off = Math.hypot(ax + u * dx, ay + u * dy);
    if (off < best.off) best = { off, along: route.along[i - 1]! + u * (route.along[i]! - route.along[i - 1]!) };
  }
  return best;
}

export function walkNav(route: WalkRoute, at: LatLon): WalkNav {
  const { off, along } = project(route, at);
  const total = route.along[route.along.length - 1] ?? 0;
  const arrive = route.maneuvers[route.maneuvers.length - 1]!;
  // A turn is "next" until the walker has passed it; the start is not a turn once under way.
  const next = route.maneuvers.find((m) => m.type !== "depart" && (route.along[m.shapeIndex] ?? 0) > along + 3) ?? arrive;
  const nextAt = next === arrive ? total : (route.along[next.shapeIndex] ?? total);
  const index = route.maneuvers.indexOf(next);
  const previous = index > 0 ? route.maneuvers[index - 1]! : route.maneuvers[0]!;
  const previousAt = route.along[previous.shapeIndex] ?? 0;
  const end = route.shape[route.shape.length - 1]!;
  return {
    next,
    toNext: Math.max(0, nextAt - along),
    stretch: Math.max(0, nextAt - previousAt),
    remaining: Math.max(0, total - along),
    off,
    atEnd: metresBetween(at.lat, at.lon, end.lat, end.lon) <= 25,
    ...(previous.street && previous !== next ? { current: previous.street } : {}),
    nextShapeIndex: next.shapeIndex,
  };
}

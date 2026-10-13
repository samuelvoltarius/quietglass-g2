import {
  cumulativeMeters, distanceMeters, projectOntoPath, type LatLng,
} from "../geo/geometry";
import { DEFAULT_OVERPASS_URLS } from "../overview/streets";

/**
 * Charging stations from OpenStreetMap (`amenity=charging_station`) through
 * the public Overpass API - the same servers as the overview streets, asked
 * the same way (a form POST, so no CORS preflight).
 *
 * Asked sparingly: only while the setting is on, at most one request every
 * 30 s, answers kept and reused (nearby: while one stays within 1.5 km for
 * ten minutes; along a route: per route line), a timeout on every request,
 * and every failure reported in words.
 *
 * Checked 2026-10-13 against overpass-api.de: around Salzburg most
 * `charging_station` objects are for bicycles (`bicycle=yes`) - those, and
 * private ones, are left out. Power comes from `socket:*:output` (e.g.
 * "150 kW"), sockets from `socket:type2_combo` (CCS), `socket:chademo`,
 * `socket:type2`.
 */

export interface Charger {
  readonly id: string;
  readonly at: LatLng;
  /** Name, else operator, else brand/network; empty when OSM has none. */
  readonly name: string;
  readonly operator: string;
  /** Highest output of any socket, in kW; null when not mapped. */
  readonly powerKw: number | null;
  /** Number of each socket (1 when only "yes" is mapped), 0 = none mapped. */
  readonly combo: number;
  readonly chademo: number;
  readonly type2: number;
  /** Cars that can charge at once; null when not mapped. */
  readonly capacity: number | null;
}

/** Fast charging, as far as the map says: from this power on. */
export const FAST_KW = 50;
/** Corridor either side of a route. */
export const CORRIDOR_M = 2_000;
/** Search radius for "charging nearby". */
export const NEARBY_RADIUS_M = 15_000;
/** At most one request this often. */
export const MIN_INTERVAL_MS = 30_000;
export const MAX_RESPONSE_BYTES = 2_000_000;

const FILTER = '["amenity"="charging_station"]';

/** Coordinates to four decimals (about 10 m): enough for a 2 km corridor, and no more precise than needed. */
const coord = (value: number): string => value.toFixed(4);

/** Stations within `radius` metres of a point. */
export function buildNearbyQuery(at: LatLng, radius = NEARBY_RADIUS_M, serverTimeoutS = 12): string {
  return `[out:json][timeout:${serverTimeoutS}];nwr${FILTER}(around:${Math.round(radius)},${coord(at.lat)},${coord(at.lon)});out center tags qt;`;
}

/** Longest stretch of route covered by one box; a long route gets fewer, larger boxes (MAX_BOXES). */
export const BOX_STRETCH_M = 20_000;
export const MAX_BOXES = 24;

/**
 * Stations near a route: the route is cut into stretches of about 20 km, each
 * stretch's box widened by `radius`, and the boxes asked for in one union.
 * Boxes are what the Overpass index answers fast - an `around` along a 130 km
 * line ran into the server's time limit (504, measured 2026-10-13). The
 * exact corridor is then measured on the phone ({@link chargersAlong}).
 */
export function buildCorridorQuery(line: readonly LatLng[], radius = CORRIDOR_M, serverTimeoutS = 15): string | null {
  if (line.length === 0) return null;
  const along = cumulativeMeters(line);
  const total = along[along.length - 1] ?? 0;
  const stretch = Math.max(BOX_STRETCH_M, total / MAX_BOXES);
  const boxes: { s: number; w: number; n: number; e: number }[] = [];
  let box: { s: number; w: number; n: number; e: number } | null = null;
  let boxStart = 0;
  line.forEach((p, i) => {
    if (!box || (along[i] ?? 0) - boxStart > stretch) {
      // Each box starts at the end of the last one, so the stretches join up.
      if (box) { box.s = Math.min(box.s, p.lat); box.n = Math.max(box.n, p.lat); box.w = Math.min(box.w, p.lon); box.e = Math.max(box.e, p.lon); }
      box = { s: p.lat, w: p.lon, n: p.lat, e: p.lon };
      boxes.push(box);
      boxStart = along[i] ?? 0;
    }
    box.s = Math.min(box.s, p.lat); box.n = Math.max(box.n, p.lat); box.w = Math.min(box.w, p.lon); box.e = Math.max(box.e, p.lon);
  });
  const parts = boxes.map((b) => {
    const dLat = radius / 111_320;
    const dLon = radius / (111_320 * Math.max(0.1, Math.cos((((b.s + b.n) / 2) * Math.PI) / 180)));
    return `nwr${FILTER}(${coord(b.s - dLat)},${coord(b.w - dLon)},${coord(b.n + dLat)},${coord(b.e + dLon)});`;
  });
  return `[out:json][timeout:${serverTimeoutS}];(${parts.join("")});out center tags qt;`;
}

/** "150 kW", "22kW", "50 kVA", "11000 W", "3.7" → kW; the highest of a list ("22 kW;50 kW"). */
export function parsePower(value: unknown): number | null {
  if (typeof value !== "string") return null;
  let best: number | null = null;
  for (const part of value.split(/;|\/|,\s/)) {
    const match = /(\d+(?:[.,]\d+)?)\s*(mw|kw|kva|w)?\b/i.exec(part.trim());
    if (!match) continue;
    let kw = Number(match[1]!.replace(",", "."));
    const unit = (match[2] ?? "").toLowerCase();
    if (unit === "mw") kw *= 1000;
    else if (unit === "w" || (unit === "" && kw >= 1000)) kw /= 1000;
    if (!Number.isFinite(kw) || kw <= 0 || kw > 2000) continue;
    best = best === null ? kw : Math.max(best, kw);
  }
  return best === null ? null : Math.round(best * 10) / 10;
}

function count(value: unknown): number {
  if (typeof value !== "string") return 0;
  const v = value.trim().toLowerCase();
  if (v === "no" || v === "0" || v === "") return 0;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 99) : 1;
}

/** Car charging only: bicycle chargers and private stations are not for a stop on the way. */
function forCars(tags: Record<string, unknown>): boolean {
  const access = String(tags["access"] ?? "").toLowerCase();
  if (access === "private" || access === "no") return false;
  const car = String(tags["motorcar"] ?? "").toLowerCase();
  if (car === "no") return false;
  if (car === "yes" || car === "designated") return true;
  const bike = String(tags["bicycle"] ?? "").toLowerCase();
  const scooter = String(tags["scooter"] ?? "").toLowerCase();
  if ((bike === "yes" || bike === "designated" || scooter === "yes") && count(tags["socket:type2_combo"]) === 0 && count(tags["socket:chademo"]) === 0) return false;
  return true;
}

/**
 * Reads an Overpass answer (`out center tags`). Nodes use their position, ways
 * and relations their centre; anything without a position, for bikes, or
 * private is skipped. Null when the answer is not an Overpass result at all or
 * the server reports a runtime error.
 */
export function parseChargers(value: unknown): Charger[] | null {
  const result = value as { elements?: unknown; remark?: unknown } | null;
  if (!result || !Array.isArray(result.elements)) return null;
  if (typeof result.remark === "string" && /error/i.test(result.remark)) return null;
  const out: Charger[] = [];
  const seen = new Set<string>();
  for (const raw of result.elements) {
    const e = raw as { type?: unknown; id?: unknown; lat?: unknown; lon?: unknown; center?: { lat?: unknown; lon?: unknown }; tags?: unknown } | null;
    if (!e || (e.type !== "node" && e.type !== "way" && e.type !== "relation")) continue;
    const lat = typeof e.lat === "number" ? e.lat : e.center?.lat;
    const lon = typeof e.lon === "number" ? e.lon : e.center?.lon;
    if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const tags = (e.tags && typeof e.tags === "object" ? e.tags : {}) as Record<string, unknown>;
    if (!forCars(tags)) continue;
    const id = `${String(e.type)[0]}${String(e.id)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let power: number | null = null;
    for (const [key, val] of Object.entries(tags)) {
      if (/^socket:[^:]+:output$/.test(key) || key === "charging_station:output" || key === "maxpower") {
        const kw = parsePower(val);
        if (kw !== null) power = power === null ? kw : Math.max(power, kw);
      }
    }
    const text = (key: string): string => (typeof tags[key] === "string" ? (tags[key] as string).trim() : "");
    const operator = text("operator");
    const capacity = Number.parseInt(text("capacity:motorcar") || text("capacity"), 10);
    out.push({
      id,
      at: { lat, lon },
      name: text("name") || operator || text("brand") || text("network"),
      operator,
      powerKw: power,
      combo: count(tags["socket:type2_combo"]),
      chademo: count(tags["socket:chademo"]),
      type2: count(tags["socket:type2"]),
      capacity: Number.isFinite(capacity) && capacity > 0 ? Math.min(capacity, 999) : null,
    });
  }
  return out;
}

/**
 * Fast for an electric car (CCS): at least FAST_KW when the power is mapped;
 * without power, a CCS socket counts as fast. "unknown" when the map says
 * neither, "slow" when it says it is not.
 */
export function speedOf(charger: Charger): "fast" | "slow" | "unknown" {
  if (charger.powerKw !== null) return charger.powerKw >= FAST_KW ? "fast" : "slow";
  if (charger.combo > 0 || charger.chademo > 0) return "fast";
  if (charger.type2 > 0) return "slow";
  return "unknown";
}

export interface NearbyCharger { readonly charger: Charger; readonly distance: number; }

/**
 * The nearest `n` stations worth driving to: fast ones first (nearest first),
 * then those the map says nothing about; slow ones only when nothing else is
 * there at all.
 */
export function nearestFast(chargers: readonly Charger[], here: LatLng, n = 3): NearbyCharger[] {
  const all = chargers.map((charger) => ({ charger, distance: distanceMeters(here, charger.at) })).sort((a, b) => a.distance - b.distance);
  const fast = all.filter((c) => speedOf(c.charger) === "fast");
  const unknown = all.filter((c) => speedOf(c.charger) === "unknown");
  const picked = [...fast, ...unknown].slice(0, n);
  return picked.length ? picked : all.slice(0, n);
}

export interface RouteCharger {
  readonly charger: Charger;
  /** Metres from the start of the route to where the station is beside it. */
  readonly along: number;
  /** Metres from the route. */
  readonly off: number;
}

/**
 * The stations within `corridor` metres of a route, with how far along it
 * each one is; sorted from the start. The server's corridor is approximate
 * (the line it got was thinned), this one is measured on the full route.
 */
export function chargersAlong(route: readonly LatLng[], chargers: readonly Charger[], corridor = CORRIDOR_M): RouteCharger[] {
  if (route.length < 2) return [];
  const along = cumulativeMeters(route);
  const out: RouteCharger[] = [];
  for (const charger of chargers) {
    const p = projectOntoPath(charger.at, route);
    if (!p || p.distance > corridor) continue;
    const start = route[p.index]!;
    out.push({ charger, along: (along[p.index] ?? 0) + distanceMeters(start, p.point), off: p.distance });
  }
  return out.sort((a, b) => a.along - b.along);
}

/** The first station ahead of `travelled` metres along the route, preferring fast ones; null when none is left. */
export function nextAhead(list: readonly RouteCharger[], travelled: number): RouteCharger | null {
  const ahead = list.filter((c) => c.along > travelled + 100);
  return ahead.find((c) => speedOf(c.charger) === "fast") ?? ahead.find((c) => speedOf(c.charger) === "unknown") ?? null;
}

/** "CCS 2 · Typ 2" - the sockets in words; empty when none are mapped. */
export function socketsText(charger: Charger, locale: "de" | "en"): string {
  const parts: string[] = [];
  const n = (value: number): string => (value > 1 ? ` ×${value}` : "");
  if (charger.combo) parts.push("CCS" + n(charger.combo));
  if (charger.chademo) parts.push("CHAdeMO" + n(charger.chademo));
  if (charger.type2) parts.push((locale === "de" ? "Typ 2" : "Type 2") + n(charger.type2));
  return parts.join(" · ");
}

/** "150 kW" or "" */
export function powerText(charger: Charger): string {
  if (charger.powerKw === null) return "";
  return `${Number.isInteger(charger.powerKw) ? charger.powerKw : charger.powerKw.toFixed(1)} kW`;
}

export type ChargerError = "cooldown" | "timeout" | "busy" | "offline" | "server" | "invalid" | "oversized";

export interface ChargerOutcome {
  readonly chargers: readonly Charger[];
  readonly error: ChargerError | null;
  /** With "cooldown": seconds until the next request may go out. */
  readonly waitS?: number;
}

export interface ChargerSourceConfig {
  readonly urls?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly minIntervalMs?: number;
  readonly clock?: () => number;
}

export interface ChargerSource {
  /** Stations around a point (NEARBY_RADIUS_M). */
  nearby(at: LatLng): Promise<ChargerOutcome>;
  /** Stations in the corridor of a route line. */
  along(line: readonly LatLng[]): Promise<ChargerOutcome>;
}

/** How long a nearby answer is reused, and how far one may have moved. */
const NEARBY_TTL_MS = 10 * 60_000;
const NEARBY_REUSE_M = 1_500;

export function createChargerSource(config: ChargerSourceConfig = {}): ChargerSource {
  const urls = config.urls ?? DEFAULT_OVERPASS_URLS;
  const doFetch = config.fetchImpl ?? ((input, init) => fetch(input, init));
  const clock = config.clock ?? Date.now;
  const minInterval = config.minIntervalMs ?? MIN_INTERVAL_MS;
  let lastRequestAt = Number.NEGATIVE_INFINITY;
  let nearbyCache: { at: LatLng; time: number; chargers: readonly Charger[] } | null = null;
  const lineCache = new Map<string, readonly Charger[]>();

  const fetchOne = async (url: string, query: string): Promise<{ readonly chargers: Charger[] } | { readonly error: ChargerError }> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 18_000);
    try {
      const response = await doFetch(url, { method: "POST", body: new URLSearchParams({ data: query }), signal: controller.signal });
      if (!response.ok) return { error: [406, 429, 503, 504].includes(response.status) ? "busy" : "server" };
      const declared = Number(response.headers?.get?.("content-length") ?? "0");
      if (declared > MAX_RESPONSE_BYTES) { controller.abort(); return { error: "oversized" }; }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) return { error: "oversized" };
      let parsed: Charger[] | null = null;
      try { parsed = parseChargers(JSON.parse(text)); } catch { parsed = null; }
      return parsed ? { chargers: parsed } : { error: "invalid" };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return { error: "timeout" };
      if (error instanceof TypeError) return { error: "offline" };
      return { error: "server" };
    } finally {
      clearTimeout(timeout);
    }
  };

  const ask = async (query: string): Promise<ChargerOutcome> => {
    const now = clock();
    if (now - lastRequestAt < minInterval) {
      return { chargers: [], error: "cooldown", waitS: Math.ceil((minInterval - (now - lastRequestAt)) / 1000) };
    }
    lastRequestAt = now;
    let last: ChargerError = "server";
    for (const url of urls) {
      const outcome = await fetchOne(url, query);
      if ("chargers" in outcome) return { chargers: outcome.chargers, error: null };
      if (outcome.error === "offline") return { chargers: [], error: "offline" };
      last = outcome.error;
    }
    return { chargers: [], error: last };
  };

  return {
    async nearby(at) {
      if (nearbyCache && clock() - nearbyCache.time < NEARBY_TTL_MS && distanceMeters(nearbyCache.at, at) <= NEARBY_REUSE_M) {
        return { chargers: nearbyCache.chargers, error: null };
      }
      const outcome = await ask(buildNearbyQuery(at));
      if (!outcome.error) nearbyCache = { at, time: clock(), chargers: outcome.chargers };
      return outcome;
    },
    async along(line) {
      const query = buildCorridorQuery(line);
      if (!query) return { chargers: [], error: null };
      const cached = lineCache.get(query);
      if (cached) return { chargers: cached, error: null };
      const outcome = await ask(query);
      if (!outcome.error) {
        if (lineCache.size >= 8) lineCache.delete(lineCache.keys().next().value as string);
        lineCache.set(query, outcome.chargers);
      }
      return outcome;
    },
  };
}

/**
 * Made-up stations for the demo route (no network): two beside the route, or
 * four around a point for "charging nearby". Labelled as demo data.
 */
export function demoChargers(line: readonly LatLng[] | null, around?: LatLng): Charger[] {
  const make = (id: string, at: LatLng, name: string, powerKw: number | null, combo: number, type2: number, capacity: number): Charger => ({
    id, at, name, operator: "Demo", powerKw, combo, chademo: 0, type2, capacity,
  });
  const offset = (p: LatLng, east: number, north: number): LatLng => ({
    lat: p.lat + north / 111_320,
    lon: p.lon + east / (111_320 * Math.cos((p.lat * Math.PI) / 180)),
  });
  if (line && line.length >= 2) {
    const a = line[Math.min(line.length - 1, Math.round(line.length * 0.55))]!;
    const b = line[Math.min(line.length - 1, Math.round(line.length * 0.85))]!;
    return [make("demo1", offset(a, 40, 0), "Demo Schnelllader", 150, 2, 2, 4), make("demo2", offset(b, -30, 20), "Demo Laden Süd", 50, 1, 1, 2)];
  }
  const c = around ?? { lat: 47.8, lon: 13.04 };
  return [
    make("demo3", offset(c, 900, 400), "Demo Schnelllader", 150, 2, 2, 4),
    make("demo4", offset(c, -1500, 800), "Demo Ladepark", 300, 6, 0, 6),
    make("demo5", offset(c, 300, -200), "Demo Wallbox", 11, 0, 1, 1),
    make("demo6", offset(c, 2600, -1900), "Demo Laden Süd", 50, 1, 1, 2),
  ];
}

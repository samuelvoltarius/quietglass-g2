import { cumulativeMeters, distanceMeters, projectOntoPath, type LatLng } from "../geo/geometry";
import { corridorBoxes } from "../chargers/chargers";
import { DEFAULT_OVERPASS_URLS } from "../overview/streets";
import { isOwnOverpass, overpassUrlsFor } from "../overpass/own";
import { tr, type Locale } from "../i18n";
import { messages } from "../messages";

/**
 * Fixed speed-enforcement points from OpenStreetMap (`highway=speed_camera`
 * nodes and the `device` nodes of `type=enforcement` + `enforcement=maxspeed`
 * relations), asked once per route through the same public Overpass servers
 * as the charging stations (corridor boxes, form POST, no preflight).
 *
 * Shown as a neutral hint ("Tempo beachten · 50") a few hundred metres before
 * the point; the words for the devices themselves never appear on screen.
 * Off in Germany (see {@link ../geo/country}) and when the phone setting is off.
 */

/** Corridor either side of the route: the devices stand on or right beside the road. */
export const CAMERA_CORRIDOR_M = 35;
/** The hint starts this far ahead at the latest… */
export const CAMERA_WARN_M = 300;
/** …and at speed at least this many seconds ahead. */
export const CAMERA_WARN_S = 10;
/** Shown until this far past the point. */
export const CAMERA_PASSED_M = 20;
/** At most one Overpass request this often (public servers). */
export const CAMERA_MIN_INTERVAL_MS = 30_000;
const MAX_RESPONSE_CHARS = 2_000_000;

export interface Camera {
  readonly id: string;
  readonly at: LatLng;
  /** The limit the point enforces when mapped (`maxspeed`), else null. */
  readonly maxspeed: number | null;
}

/** Overpass QL for the corridor of a route; null for an empty line. */
export function buildCameraQuery(line: readonly LatLng[], serverTimeoutS = 15): string | null {
  const boxes = corridorBoxes(line, 200);
  if (!boxes) return null;
  const box = (b: readonly number[]): string => b.map((v) => v.toFixed(4)).join(",");
  const nodes = boxes.map((b) => `node["highway"="speed_camera"](${box(b)});`).join("");
  const relations = boxes.map((b) => `relation["type"="enforcement"]["enforcement"="maxspeed"](${box(b)});`).join("");
  return `[out:json][timeout:${serverTimeoutS}];(${nodes})->.c;(${relations})->.r;node(r.r:"device")->.d;(.c;.d;.r;);out body qt;`;
}

/** "50", "50 km/h", "30 mph" (→ km/h); "none", "signals", "AT:urban" → null. */
export function parseMaxspeed(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^\s*(\d{1,3})\s*(km\/h|kmh|mph)?\s*$/i.exec(value.split(";")[0] ?? "");
  if (!match) return null;
  let kmh = Number(match[1]);
  if (/mph/i.test(match[2] ?? "")) kmh = Math.round(kmh * 1.609);
  return kmh >= 5 && kmh <= 200 ? kmh : null;
}

/** Reads the Overpass answer; null when it is not one. Device nodes take the relation's limit when they have none. */
export function parseCameras(value: unknown): Camera[] | null {
  const result = value as { elements?: unknown; remark?: unknown } | null;
  if (!result || !Array.isArray(result.elements)) return null;
  if (typeof result.remark === "string" && /error/i.test(result.remark)) return null;
  const nodes = new Map<number, { at: LatLng; tags: Record<string, unknown> }>();
  const relations: { members: { type?: unknown; ref?: unknown; role?: unknown }[]; tags: Record<string, unknown> }[] = [];
  for (const raw of result.elements) {
    const e = raw as { type?: unknown; id?: unknown; lat?: unknown; lon?: unknown; tags?: unknown; members?: unknown } | null;
    const tags = (e?.tags && typeof e.tags === "object" ? e.tags : {}) as Record<string, unknown>;
    if (e?.type === "node" && typeof e.id === "number" && typeof e.lat === "number" && typeof e.lon === "number"
      && Number.isFinite(e.lat) && Number.isFinite(e.lon)) {
      nodes.set(e.id, { at: { lat: e.lat, lon: e.lon }, tags });
    } else if (e?.type === "relation" && Array.isArray(e.members)) {
      relations.push({ members: e.members as never[], tags });
    }
  }
  const out = new Map<number, Camera>();
  for (const [id, node] of nodes) {
    if (node.tags["highway"] === "speed_camera") out.set(id, { id: "n" + id, at: node.at, maxspeed: parseMaxspeed(node.tags["maxspeed"]) });
  }
  for (const relation of relations) {
    if (relation.tags["enforcement"] !== "maxspeed") continue;
    const limit = parseMaxspeed(relation.tags["maxspeed"]);
    for (const member of relation.members) {
      if (member.type !== "node" || member.role !== "device" || typeof member.ref !== "number") continue;
      const node = nodes.get(member.ref);
      if (!node) continue;
      const known = out.get(member.ref);
      out.set(member.ref, { id: "n" + member.ref, at: node.at, maxspeed: known?.maxspeed ?? parseMaxspeed(node.tags["maxspeed"]) ?? limit });
    }
  }
  return [...out.values()];
}

export interface RouteCamera {
  readonly camera: Camera;
  /** Metres from the start of the route. */
  readonly along: number;
}

/** The points within `corridor` metres of the route, with how far along it each is; sorted from the start. */
export function camerasAlong(route: readonly LatLng[], cameras: readonly Camera[], corridor = CAMERA_CORRIDOR_M): RouteCamera[] {
  if (route.length < 2) return [];
  const along = cumulativeMeters(route);
  const out: RouteCamera[] = [];
  for (const camera of cameras) {
    const p = projectOntoPath(camera.at, route);
    if (!p || p.distance > corridor) continue;
    out.push({ camera, along: (along[p.index] ?? 0) + distanceMeters(route[p.index]!, p.point) });
  }
  return out.sort((a, b) => a.along - b.along);
}

/** How far ahead the hint starts at this speed: CAMERA_WARN_M, or CAMERA_WARN_S seconds when that is further. */
export function warnDistance(kmh: number | null): number {
  return Math.max(CAMERA_WARN_M, ((kmh ?? 0) / 3.6) * CAMERA_WARN_S);
}

export interface CameraAhead {
  readonly distance: number;
  /** The point's own limit, else the current limit, else null. */
  readonly limit: number | null;
}

/** The point to mention now, or null: within the warning distance ahead, until just past it. */
export function cameraAhead(list: readonly RouteCamera[], alongNow: number, kmh: number | null, currentLimit: number | null): CameraAhead | null {
  const reach = warnDistance(kmh);
  for (const item of list) {
    const distance = item.along - alongNow;
    if (distance < -CAMERA_PASSED_M) continue;
    if (distance > reach) return null;
    return { distance: Math.max(0, distance), limit: item.camera.maxspeed ?? currentLimit };
  }
  return null;
}

/** `Tempo beachten · 50` / `Mind your speed · 50`. */
export function cameraText(ahead: CameraAhead, locale: Locale): string {
  return ahead.limit ? tr(messages, locale, "s.camera", { v: ahead.limit }) : tr(messages, locale, "s.cameraNoLimit");
}

export type CameraError = "cooldown" | "timeout" | "busy" | "offline" | "server" | "invalid";

export interface CameraOutcome {
  readonly cameras: readonly Camera[];
  readonly error: CameraError | null;
  readonly waitS?: number;
}

export interface CameraSourceConfig {
  readonly urls?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly minIntervalMs?: number;
  readonly clock?: () => number;
}

/** Points along a route line: one Overpass request per line (cached), at most one every CAMERA_MIN_INTERVAL_MS. */
export function createCameraSource(config: CameraSourceConfig = {}): { along(line: readonly LatLng[]): Promise<CameraOutcome> } {
  const urlsFor = (line: readonly LatLng[]): readonly string[] => config.urls ?? overpassUrlsFor(line, DEFAULT_OVERPASS_URLS);
  const doFetch = config.fetchImpl ?? ((input, init) => fetch(input, init));
  const clock = config.clock ?? Date.now;
  const minInterval = config.minIntervalMs ?? CAMERA_MIN_INTERVAL_MS;
  let lastAt = Number.NEGATIVE_INFINITY;
  const cache = new Map<string, readonly Camera[]>();

  const fetchOne = async (url: string, query: string): Promise<Camera[] | CameraError> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 18_000);
    try {
      const response = await doFetch(url, { method: "POST", body: new URLSearchParams({ data: query }), signal: controller.signal });
      if (!response.ok) return [406, 429, 503, 504].includes(response.status) ? "busy" : "server";
      const text = await response.text();
      if (text.length > MAX_RESPONSE_CHARS) return "invalid";
      let parsed: Camera[] | null = null;
      try { parsed = parseCameras(JSON.parse(text)); } catch { parsed = null; }
      return parsed ?? "invalid";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "timeout";
      if (error instanceof TypeError) return "offline";
      return "server";
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async along(line) {
      const query = buildCameraQuery(line);
      if (!query) return { cameras: [], error: null };
      const cached = cache.get(query);
      if (cached) return { cameras: cached, error: null };
      const now = clock();
      if (now - lastAt < minInterval) return { cameras: [], error: "cooldown", waitS: Math.ceil((minInterval - (now - lastAt)) / 1000) };
      lastAt = now;
      let last: CameraError = "server";
      for (const url of urlsFor(line)) {
        const outcome = await fetchOne(url, query);
        if (typeof outcome !== "string") {
          if (cache.size >= 8) cache.delete(cache.keys().next().value as string);
          cache.set(query, outcome);
          return { cameras: outcome, error: null };
        }
        if (outcome === "offline" && !isOwnOverpass(url)) return { cameras: [], error: "offline" };
        last = outcome;
      }
      return { cameras: [], error: last };
    },
  };
}

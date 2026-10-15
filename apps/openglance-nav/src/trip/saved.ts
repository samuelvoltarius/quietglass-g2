import {
  cumulativeMeters, decodePolyline, distanceMeters, encodePolyline, projectOntoPath, simplifyTo, type LatLng,
} from "../geo/geometry";
import { MAX_STOPS, type Maneuver, type Route, type TravelMode } from "../routing/provider";

/**
 * Routes planned ahead on the phone and saved under a name: a start (a place,
 * or "wherever I am when I go"), up to three stops on the way, a destination
 * and how to travel. On the glasses they sit in the destination list; a tap
 * routes from the current position through the stops still ahead.
 *
 * Privacy: a route that starts "from my position" stores neither the position
 * nor the line of the route (which would begin there). Only routes from a
 * place that was typed in keep their line, thinned, for the "join the route"
 * decision below.
 */

export interface RoutePoint {
  readonly label: string;
  readonly at: LatLng;
}

export interface SavedRoute {
  readonly id: string;
  readonly name: string;
  readonly mode: TravelMode;
  /** Null: from wherever the glasses are when the route is started. */
  readonly start: RoutePoint | null;
  readonly stops: readonly RoutePoint[];
  readonly to: RoutePoint;
  /** Metres and seconds as planned. */
  readonly distance: number;
  readonly duration: number;
  /** The planned line, thinned, polyline precision 5; only for a route from a typed start. */
  readonly line?: string;
  /** Last change (ms since 1970): saved, renamed. Decides which copy wins when phone and PC are synced. */
  readonly updated?: number;
}

/** A route deleted on one device, kept so the deletion reaches the others. */
export interface RouteTombstone {
  readonly id: string;
  /** When it was deleted (ms). */
  readonly at: number;
}

/** Most saved routes kept. */
export const MAX_ROUTES = 20;
/** Most points of a stored line: enough to know where the route runs, small in storage. */
export const MAX_LINE_POINTS = 150;
/** Within this of the saved start the route is driven as planned. */
export const NEAR_START_M = 500;
/** Within this of the planned line (but far from its start) the route is joined where one is. */
export const JOIN_LINE_M = 2_000;

/**
 * A new route id. Routes are planned on the phone and on the PC and synced, so
 * a counter ("s3") could be taken twice; the time plus a random tail cannot.
 */
export function nextRouteId(routes: readonly SavedRoute[], now = Date.now(), random: () => number = Math.random): string {
  const taken = new Set(routes.map((r) => r.id));
  for (;;) {
    const id = "r" + now.toString(36) + Math.floor(random() * 36 ** 4).toString(36).padStart(4, "0");
    if (!taken.has(id)) return id;
  }
}

/** Builds the route to store from a plan and the route the router gave for it. */
export function makeSavedRoute(
  routes: readonly SavedRoute[],
  plan: { readonly name: string; readonly mode: TravelMode; readonly start: RoutePoint | null; readonly stops: readonly RoutePoint[]; readonly to: RoutePoint },
  route: Pick<Route, "shape" | "distance" | "duration">,
  now = Date.now(),
): SavedRoute {
  const name = plan.name.trim() || `${plan.start?.label ?? "→"} – ${plan.to.label}`;
  return {
    id: nextRouteId(routes, now),
    name: name.slice(0, 60),
    mode: plan.mode,
    start: plan.start,
    stops: plan.stops.slice(0, MAX_STOPS),
    to: plan.to,
    distance: Math.round(route.distance),
    duration: Math.round(route.duration),
    ...(plan.start && route.shape.length >= 2 ? { line: encodePolyline(simplifyTo(route.shape, MAX_LINE_POINTS)) } : {}),
    updated: now,
  };
}

export function addRoute(routes: readonly SavedRoute[], route: SavedRoute): SavedRoute[] {
  return [...routes, route].slice(-MAX_ROUTES);
}

export function renameRoute(routes: readonly SavedRoute[], id: string, name: string, now = Date.now()): SavedRoute[] {
  const clean = name.trim().slice(0, 60);
  if (!clean) return [...routes];
  return routes.map((r) => (r.id === id ? { ...r, name: clean, updated: now } : r));
}

export function removeRoute(routes: readonly SavedRoute[], id: string): SavedRoute[] {
  return routes.filter((r) => r.id !== id);
}

/** Deletions are remembered this long, long enough for every device to have synced once. */
export const TOMBSTONE_KEEP_MS = 180 * 24 * 60 * 60_000;
/** Most deletions remembered. */
export const MAX_TOMBSTONES = 200;

/** Records a deletion so that syncing removes the route everywhere. */
export function forgetRoute(deleted: readonly RouteTombstone[], id: string, now = Date.now()): RouteTombstone[] {
  return [...deleted.filter((d) => d.id !== id), { id, at: now }].slice(-MAX_TOMBSTONES);
}

export function parseTombstones(value: unknown, now = Date.now()): RouteTombstone[] {
  if (!Array.isArray(value)) return [];
  const out: RouteTombstone[] = [];
  for (const raw of value) {
    const d = raw as { id?: unknown; at?: unknown } | null;
    if (typeof d?.id !== "string" || !d.id || d.id.length > 40) continue;
    if (typeof d.at !== "number" || !Number.isFinite(d.at) || now - d.at > TOMBSTONE_KEEP_MS) continue;
    out.push({ id: d.id, at: d.at });
  }
  return out.slice(-MAX_TOMBSTONES);
}

/**
 * Joins two copies of the saved routes (this device and the route store):
 * per id the copy changed last wins, a deletion beats every copy older than
 * it, and of what is left the MAX_ROUTES changed most recently are kept,
 * oldest first. The route store runs the same rules, so it does not matter
 * who merges.
 */
export function mergeRoutes(
  a: { readonly routes: readonly SavedRoute[]; readonly deleted: readonly RouteTombstone[] },
  b: { readonly routes: readonly SavedRoute[]; readonly deleted: readonly RouteTombstone[] },
  now = Date.now(),
): { routes: SavedRoute[]; deleted: RouteTombstone[] } {
  const deleted = new Map<string, number>();
  for (const d of [...a.deleted, ...b.deleted]) {
    if (now - d.at > TOMBSTONE_KEEP_MS) continue;
    deleted.set(d.id, Math.max(deleted.get(d.id) ?? 0, d.at));
  }
  const routes = new Map<string, SavedRoute>();
  for (const r of [...a.routes, ...b.routes]) {
    const have = routes.get(r.id);
    if (!have || (r.updated ?? 0) > (have.updated ?? 0)) routes.set(r.id, r);
  }
  const alive = [...routes.values()]
    .filter((r) => (deleted.get(r.id) ?? -1) < (r.updated ?? 0))
    .map((r, index) => ({ r, index }))
    .sort((x, y) => (x.r.updated ?? 0) - (y.r.updated ?? 0) || x.index - y.index)
    .map(({ r }) => r)
    .slice(-MAX_ROUTES);
  const tombstones = [...deleted.entries()].map(([id, at]) => ({ id, at })).sort((x, y) => x.at - y.at).slice(-MAX_TOMBSTONES);
  return { routes: alive, deleted: tombstones };
}

function readPoint(value: unknown): RoutePoint | null {
  const p = value as { label?: unknown; at?: { lat?: unknown; lon?: unknown } } | null;
  const lat = p?.at?.lat, lon = p?.at?.lon;
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { label: typeof p?.label === "string" && p.label.trim() ? p.label.trim().slice(0, 80) : `${lat.toFixed(4)}, ${lon.toFixed(4)}`, at: { lat, lon } };
}

/** Reads stored routes; anything malformed is dropped, never guessed at. */
export function parseRoutes(value: unknown): SavedRoute[] {
  if (!Array.isArray(value)) return [];
  const out: SavedRoute[] = [];
  for (const raw of value) {
    const r = raw as Partial<Record<keyof SavedRoute, unknown>> | null;
    if (typeof r?.id !== "string" || !r.id) continue;
    const to = readPoint(r.to);
    if (!to) continue;
    const mode = r.mode === "driving" || r.mode === "cycling" || r.mode === "walking" ? r.mode : "driving";
    const start = r.start === null || r.start === undefined ? null : readPoint(r.start);
    const stops = Array.isArray(r.stops) ? r.stops.map(readPoint).filter((p): p is RoutePoint => p !== null).slice(0, MAX_STOPS) : [];
    const number = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    out.push({
      id: r.id,
      name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 60) : to.label,
      mode,
      start,
      stops,
      to,
      distance: number(r.distance),
      duration: number(r.duration),
      ...(start && typeof r.line === "string" && r.line.length > 0 && r.line.length < 20_000 ? { line: r.line } : {}),
      ...(typeof r.updated === "number" && Number.isFinite(r.updated) && r.updated > 0 ? { updated: r.updated } : {}),
    });
    if (out.length >= MAX_ROUTES) break;
  }
  return out;
}

/** How a saved route is begun from where one is. */
export type JoinKind = "asPlanned" | "joined" | "toFirstStop" | "direct";

export interface TripPlan {
  /** Stops still to visit, in order. */
  readonly stops: readonly RoutePoint[];
  readonly to: RoutePoint;
  readonly kind: JoinKind;
}

/**
 * Where to route when a saved route is started at `here`. Near its start, as
 * planned: here → every stop → destination. Far from the start but close to
 * the planned line: the route is joined, and stops already behind that point
 * are left out. Otherwise straight to the first stop (or the destination,
 * when there is none) and on from there - never back to a start that may be
 * far behind.
 */
export function planFrom(route: SavedRoute, here: LatLng): TripPlan {
  const stops = route.stops.slice(0, MAX_STOPS);
  if (!route.start || distanceMeters(here, route.start.at) <= NEAR_START_M) {
    return { stops, to: route.to, kind: "asPlanned" };
  }
  const line = route.line ? decodePolyline(route.line, 5) : [];
  const onLine = line.length >= 2 ? projectOntoPath(here, line) : null;
  if (onLine && onLine.distance <= JOIN_LINE_M) {
    const along = cumulativeMeters(line);
    const hereAlong = (along[onLine.index] ?? 0) + distanceMeters(line[onLine.index]!, onLine.point);
    const ahead = stops.filter((stop) => {
      const p = projectOntoPath(stop.at, line);
      if (!p) return true;
      const stopAlong = (along[p.index] ?? 0) + distanceMeters(line[p.index]!, p.point);
      return stopAlong > hereAlong + 50;
    });
    return { stops: ahead, to: route.to, kind: "joined" };
  }
  return { stops, to: route.to, kind: stops.length ? "toFirstStop" : "direct" };
}

/** Within this of a stop it counts as reached, even when the route was left just before it. */
export const STOP_REACHED_M = 60;

/**
 * How many of the stops a route was planned with lie behind: the arrival at a
 * stop is a manoeuvre of its own (`via`), and once the manoeuvre being
 * approached is past it, it is done. Also counts the next stop as reached when
 * the position is right at it.
 */
export function stopsPassed(maneuvers: readonly Maneuver[], maneuverIndex: number, stops: readonly RoutePoint[], position: LatLng | null): number {
  let passed = 0;
  for (const [index, maneuver] of maneuvers.entries()) {
    if (maneuver.via !== undefined && index < maneuverIndex) passed = Math.max(passed, maneuver.via);
  }
  const next = stops[passed];
  if (next && position && distanceMeters(position, next.at) <= STOP_REACHED_M) passed++;
  return Math.min(passed, stops.length);
}

/** Labels the arrivals at stops with the stop names, so the glasses say "Stopp 1: Ladepark" rather than the router's words. */
export function nameStops(route: Route, stops: readonly RoutePoint[], stopWord: string): Route {
  if (!stops.length) return route;
  return {
    ...route,
    maneuvers: route.maneuvers.map((m) => {
      if (m.via === undefined) return m;
      const stop = stops[m.via - 1];
      return stop ? { ...m, street: `${stopWord} ${m.via}: ${stop.label}` } : m;
    }),
  };
}

import { decodePolyline, type LatLng } from "../geo/geometry";

/**
 * Routing providers.
 *
 * Every G2 navigation app found routes through Mapbox or another proprietary
 * service, which means an account, a key and a quota. OpenGlance targets
 * **Valhalla** on OpenStreetMap data, which anyone can host, and keeps the
 * interface narrow enough that OSRM or GraphHopper can be added without
 * touching the navigation logic.
 */

export type TravelMode = "walking" | "cycling" | "driving";

/** Normalised manoeuvre types. Providers map their own vocabulary onto these. */
export type ManeuverType =
  | "depart" | "arrive"
  | "left" | "slightLeft" | "sharpLeft"
  | "right" | "slightRight" | "sharpRight"
  | "straight" | "uturn"
  | "roundabout" | "merge" | "fork" | "exit";

export interface Maneuver {
  readonly type: ManeuverType;
  /** Human instruction from the router. */
  readonly instruction: string;
  /** Street or road being joined, when the router supplies one. */
  readonly street?: string;
  /** Metres from this manoeuvre to the next. */
  readonly length: number;
  /** Seconds from this manoeuvre to the next. */
  readonly time: number;
  /** Index into the route shape where this manoeuvre begins. */
  readonly shapeIndex: number;
  /** Roundabout exit number, when applicable. */
  readonly exitNumber?: number;
}

export interface Route {
  readonly shape: readonly LatLng[];
  readonly maneuvers: readonly Maneuver[];
  readonly distance: number;
  readonly duration: number;
}

export interface RouteRequest {
  readonly from: LatLng;
  readonly to: LatLng;
  readonly mode: TravelMode;
}

/**
 * Why a route could not be had, in terms a person can act on. The app turns
 * these into plain sentences ("No connection", "Server busy") instead of
 * showing HTTP codes or router internals.
 */
export type RouteErrorCode = "offline" | "timeout" | "busy" | "noRoute" | "tooFar" | "server";

export interface RouteOutcome {
  readonly route: Route | null;
  readonly error: string | null;
  /** Present whenever `route` is null. */
  readonly code?: RouteErrorCode;
}

export interface RoutingProvider {
  readonly name: string;
  route(request: RouteRequest): Promise<RouteOutcome>;
}

/**
 * The public Valhalla server run by FOSSGIS e.V. — keyless, CORS-enabled,
 * planet-wide. Terms (fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen):
 * at most one request per second, OpenStreetMap attribution with a
 * "fix the map" link, an identifiable client, no high-traffic use. The address
 * stays user-editable, as those terms recommend, and self-hosting is one
 * field away.
 */
export const DEFAULT_ROUTER_URL = "https://valhalla1.openstreetmap.de";
export const DEFAULT_ROUTER_HOST = "valhalla1.openstreetmap.de";

/**
 * A browser cannot set its User-Agent, so on the FOSSGIS server the client is
 * identified with the `X-Client-Id` header that server explicitly allows in its
 * CORS preflight. It is sent nowhere else: a self-hosted server's CORS setup
 * may not allow the extra header and would then refuse every request.
 */
export const CLIENT_ID = "quietglass-openglance";

export function clientIdFor(url: string): string | undefined {
  try {
    return new URL(url).hostname === DEFAULT_ROUTER_HOST ? CLIENT_ID : undefined;
  } catch {
    return undefined;
  }
}

export interface ValhallaConfig {
  /** Base URL of a Valhalla instance, e.g. https://valhalla.example. */
  readonly url: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Language for the router's own instruction text, e.g. "de-DE". */
  readonly language?: string;
  /** Sent as `X-Client-Id` when set. */
  readonly clientId?: string;
}

const COSTING: Readonly<Record<TravelMode, string>> = {
  walking: "pedestrian",
  cycling: "bicycle",
  driving: "auto",
};

export function createValhallaProvider(config: ValhallaConfig): RoutingProvider {
  const doFetch = config.fetchImpl ?? fetch;

  return {
    name: "valhalla",
    async route({ from, to, mode }): Promise<RouteOutcome> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 15_000);

      try {
        const body = {
          locations: [
            { lat: from.lat, lon: from.lon },
            { lat: to.lat, lon: to.lon },
          ],
          costing: COSTING[mode],
          directions_options: {
            units: "kilometers",
            ...(config.language ? { language: config.language } : {}),
          },
        };

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (config.clientId) headers["X-Client-Id"] = config.clientId;

        const response = await doFetch(joinUrl(config.url, "/route"), {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify(body),
        });

        if (!response.ok) return failedResponse(response);
        return parseValhalla(await response.json());
      } catch (error) {
        return { route: null, error: describeError(error), code: errorCodeOf(error) };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/**
 * A non-2xx answer. Valhalla explains a 400 in JSON ("No path could be
 * found", "No suitable edges near location"): to the user that is "no way to
 * this destination", not a server fault. 429 is the public server's rate limit.
 */
async function failedResponse(response: Response): Promise<RouteOutcome> {
  const fallback = "HTTP " + response.status;
  let message = fallback;
  try {
    const value = await response.json() as Record<string, unknown>;
    if (value && typeof value["error"] === "string") message = value["error"].slice(0, 60);
  } catch { /* not JSON */ }
  // The public server caps route length per mode (100 km on foot, verified
  // 2026-10-06): that deserves its own sentence, not "no way found".
  const code = /max distance/i.test(message) ? "tooFar" : codeForStatus(response.status);
  return { route: null, error: message, code };
}

export function codeForStatus(status: number): RouteErrorCode {
  if (status === 429 || status === 503) return "busy";
  if (status === 504) return "timeout";
  if (status >= 400 && status < 500) return "noRoute";
  return "server";
}

export function errorCodeOf(error: unknown): RouteErrorCode {
  if (error instanceof DOMException && error.name === "AbortError") return "timeout";
  if (error instanceof TypeError) return "offline";
  return "server";
}

/** Parses a Valhalla `/route` response into the normalised shape. */
export function parseValhalla(value: unknown): RouteOutcome {
  if (!value || typeof value !== "object") return { route: null, error: "unreadable response", code: "server" };
  const root = value as Record<string, unknown>;

  if (root["error"]) {
    return { route: null, error: String(root["error"]).slice(0, 60), code: "noRoute" };
  }

  const trip = root["trip"] as Record<string, unknown> | undefined;
  const legs = Array.isArray(trip?.["legs"]) ? trip["legs"] as unknown[] : null;
  if (!legs || legs.length === 0) return { route: null, error: "no route found", code: "noRoute" };

  const shape: LatLng[] = [];
  const maneuvers: Maneuver[] = [];

  for (const rawLeg of legs) {
    const leg = rawLeg as Record<string, unknown>;
    const offset = shape.length;

    if (typeof leg["shape"] === "string") {
      // Valhalla encodes at precision 6; using 5 would misplace the route
      // by a factor of ten without any error being raised.
      shape.push(...decodePolyline(leg["shape"], 6));
    }

    const rawManeuvers = Array.isArray(leg["maneuvers"]) ? leg["maneuvers"] as unknown[] : [];
    for (const rawManeuver of rawManeuvers) {
      const m = rawManeuver as Record<string, unknown>;
      const streets = Array.isArray(m["street_names"]) ? m["street_names"] as unknown[] : [];
      const street = typeof streets[0] === "string" ? streets[0] : undefined;

      maneuvers.push({
        type: mapValhallaType(numberOr(m["type"], 0)),
        instruction: typeof m["instruction"] === "string" ? m["instruction"] : "",
        ...(street ? { street } : {}),
        // Valhalla reports length in kilometres with units=kilometers.
        length: numberOr(m["length"], 0) * 1000,
        time: numberOr(m["time"], 0),
        shapeIndex: offset + numberOr(m["begin_shape_index"], 0),
        ...(m["roundabout_exit_count"] !== undefined
          ? { exitNumber: numberOr(m["roundabout_exit_count"], 0) }
          : {}),
      });
    }
  }

  const summary = trip?.["summary"] as Record<string, unknown> | undefined;
  if (shape.length === 0 || maneuvers.length === 0) {
    return { route: null, error: "route had no usable geometry", code: "noRoute" };
  }

  return {
    route: {
      shape,
      maneuvers,
      distance: numberOr(summary?.["length"], 0) * 1000,
      duration: numberOr(summary?.["time"], 0),
    },
    error: null,
  };
}

/**
 * Valhalla manoeuvre type numbers, from its documented enumeration.
 * Anything unrecognised becomes `straight`, which is the safe default: it
 * never invents a turn that the router did not ask for.
 */
export function mapValhallaType(type: number): ManeuverType {
  switch (type) {
    case 1: case 2: case 3: return "depart";
    case 4: case 5: case 6: return "arrive";
    case 8: return "straight";
    case 9: return "slightRight";
    case 10: return "right";
    case 11: return "sharpRight";
    case 12: case 13: return "uturn";
    case 14: return "sharpLeft";
    case 15: return "left";
    case 16: return "slightLeft";
    case 17: case 18: return "straight";     // ramp straight
    case 19: case 20: return "exit";
    case 21: case 22: return "merge";
    case 23: return "fork";
    case 24: case 25: case 26: case 27: return "roundabout";
    case 37: case 38: case 39: return "merge";
    default: return "straight";
  }
}

export function describeError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "routing timed out";
  if (error instanceof TypeError) return "router unreachable";
  if (error instanceof Error && error.message) return error.message.slice(0, 60);
  return "routing failed";
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Mock route for the simulator, which supplies no GPS.
 *
 * It is a real route object so the whole navigation pipeline can be exercised;
 * the app labels it MOCK wherever it appears.
 */
export function createMockProvider(): RoutingProvider {
  return {
    name: "mock",
    async route({ from }): Promise<RouteOutcome> {
      const shape: LatLng[] = [];
      for (let i = 0; i <= 40; i++) {
        shape.push({ lat: from.lat + i * 0.0005, lon: from.lon + i * 0.0003 });
      }
      return {
        route: {
          shape,
          maneuvers: [
            { type: "depart", instruction: "Head north on Mock Street", street: "Mock Street", length: 800, time: 120, shapeIndex: 0 },
            { type: "right", instruction: "Turn right onto Example Road", street: "Example Road", length: 1200, time: 180, shapeIndex: 16 },
            { type: "roundabout", instruction: "At the roundabout, take the second exit", street: "Sample Avenue", length: 600, time: 90, shapeIndex: 30 },
            { type: "arrive", instruction: "You have arrived", length: 0, time: 0, shapeIndex: 40 },
          ],
          distance: 2600,
          duration: 390,
        },
        error: null,
      };
    },
  };
}

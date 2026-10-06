import type { LatLng } from "../geo/geometry";
import { createRequestGate } from "../routing/throttle";

/**
 * Place search through Photon (OpenStreetMap data, by komoot).
 *
 * The public instance needs no key and sends `Access-Control-Allow-Origin: *`,
 * so a WebView can call it directly. Its terms ask for fair use ("extensive
 * usage will be throttled"), so OpenGlance searches only when the user presses
 * Search — never while typing — answers a repeated query from memory, and keeps
 * at least a second between requests.
 *
 * Nominatim was considered and not used: its policy forbids client-side
 * autocomplete, requires an identifying User-Agent a WebView cannot set, and
 * asks apps to proxy requests.
 */

export const DEFAULT_GEOCODER_URL = "https://photon.komoot.io";

export interface FoundPlace {
  /** Short name: the place, or street and number. */
  readonly label: string;
  /** Where it is: postcode, town, country. */
  readonly detail: string;
  readonly at: LatLng;
}

export type SearchErrorCode = "short" | "empty" | "offline" | "timeout" | "busy" | "server";

export interface SearchOutcome {
  readonly places: readonly FoundPlace[];
  readonly error: SearchErrorCode | null;
}

export interface SearchOptions {
  /** UI language; Photon only knows de/en/fr, anything else gets local names. */
  readonly lang?: string;
  /** Rough current position, to rank nearby results first. */
  readonly near?: LatLng | null;
  readonly limit?: number;
}

export interface GeocoderConfig {
  readonly url: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly minIntervalMs?: number;
}

export const MIN_QUERY_LENGTH = 3;
const PHOTON_LANGS = new Set(["de", "en", "fr"]);

/**
 * The bias position is rounded to two decimals (about 1 km): enough to put the
 * nearby "Bahnhof" first, without handing a third service an exact position.
 */
export function buildSearchUrl(base: string, query: string, options: SearchOptions = {}): string {
  const url = new URL(base.replace(/\/+$/, "") + "/api/");
  url.searchParams.set("q", query.trim());
  url.searchParams.set("limit", String(options.limit ?? 5));
  if (options.lang && PHOTON_LANGS.has(options.lang)) url.searchParams.set("lang", options.lang);
  if (options.near) {
    url.searchParams.set("lat", options.near.lat.toFixed(2));
    url.searchParams.set("lon", options.near.lon.toFixed(2));
  }
  return url.toString();
}

/** Reads Photon's GeoJSON answer; anything malformed is skipped, never invented. */
export function parsePhoton(value: unknown): FoundPlace[] {
  const features = (value as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];
  const places: FoundPlace[] = [];
  for (const feature of features) {
    const f = feature as { geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> } | null;
    const coordinates = f?.geometry?.coordinates;
    if (!Array.isArray(coordinates)) continue;
    const [lon, lat] = coordinates as unknown[];
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const p = f?.properties ?? {};
    const text = (key: string): string => (typeof p[key] === "string" ? (p[key] as string).trim() : "");
    const street = [text("street"), text("housenumber")].filter(Boolean).join(" ");
    const label = text("name") || street || text("city");
    if (!label) continue;
    const town = [text("postcode"), text("city") || text("district")].filter(Boolean).join(" ");
    const detail = [label === street ? "" : street, town, text("country")]
      .filter((part) => part && part !== label)
      .join(", ");
    places.push({ label, detail, at: { lat, lon } });
  }
  return places;
}

export interface Geocoder {
  search(query: string, options?: SearchOptions): Promise<SearchOutcome>;
}

export function createGeocoder(config: GeocoderConfig): Geocoder {
  const doFetch = config.fetchImpl ?? fetch;
  const gate = createRequestGate(config.minIntervalMs ?? 1_000);
  const cache = new Map<string, readonly FoundPlace[]>();

  return {
    async search(query, options = {}): Promise<SearchOutcome> {
      const trimmed = query.trim();
      if (trimmed.length < MIN_QUERY_LENGTH) return { places: [], error: "short" };

      const url = buildSearchUrl(config.url, trimmed, options);
      const cached = cache.get(url);
      if (cached) return { places: cached, error: cached.length ? null : "empty" };

      await gate.ready();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000);
      try {
        const response = await doFetch(url, { signal: controller.signal });
        if (!response.ok) {
          return { places: [], error: response.status === 429 || response.status === 503 ? "busy" : "server" };
        }
        const places = parsePhoton(await response.json());
        cache.set(url, places);
        return { places, error: places.length ? null : "empty" };
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return { places: [], error: "timeout" };
        if (error instanceof TypeError) return { places: [], error: "offline" };
        return { places: [], error: "server" };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

import type { Coordinates } from "./api";

/**
 * Place search for people who cannot or will not share the phone location.
 *
 * Open-Meteo's geocoder is keyless, sends `access-control-allow-origin: *`
 * and falls under the same free, non-commercial terms as the forecast itself,
 * so a place name works straight after install without anyone hosting a proxy.
 * Location data is based on GeoNames.
 */
export interface Place extends Coordinates { readonly name: string; readonly label: string; }
export interface GeocodeOptions { readonly timeoutMs?: number; readonly fetchImpl?: typeof fetch; readonly count?: number; }

const DEFAULT_TIMEOUT = 10_000;

/** Two characters match a name exactly and one character matches nothing, so anything shorter is not worth a request. */
export function usableQuery(raw: string): string | null { const query = raw.replace(/\s+/g, " ").trim(); return Array.from(query).length >= 2 ? query : null; }

export function geocodeUrl(query: string, language: string, count = 5): URL {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query); url.searchParams.set("count", String(count));
  url.searchParams.set("language", language); url.searchParams.set("format", "json");
  return url;
}

const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

/** "Hallein, Land Salzburg, Österreich" — enough to tell the three Neukirchens apart. */
export function parsePlaces(value: unknown): Place[] {
  const results = (value as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((entry): Place[] => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const name = text(record.name); const latitude = record.latitude; const longitude = record.longitude;
    if (!name || typeof latitude !== "number" || typeof longitude !== "number" || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
    const parts = [name, text(record.admin1), text(record.country)].filter((part, index, all): part is string => !!part && all.indexOf(part) === index);
    return [{ name, label: parts.join(", "), latitude, longitude }];
  });
}

/** An empty list means "nothing by that name"; network trouble throws, so the phone can tell the two apart. */
export async function searchPlaces(raw: string, language: string, options: GeocodeOptions = {}): Promise<Place[]> {
  const query = usableQuery(raw); if (!query) return [];
  const doFetch = options.fetchImpl ?? fetch; const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const response = await doFetch(geocodeUrl(query, language, options.count), { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parsePlaces(await response.json());
  } catch (cause) {
    if (controller.signal.aborted) throw new Error("timed out");
    throw cause;
  } finally { clearTimeout(timeout); }
}

/** A place kept in localStorage; anything malformed counts as no place at all. */
export function parseSavedPlace(raw: string | null): Place | null {
  if (!raw) return null;
  try { const value = JSON.parse(raw) as Record<string, unknown> | null; const [place] = parsePlaces({ results: [value] }); return place ? { ...place, label: text(value?.label) ?? place.label } : null; }
  catch { return null; }
}

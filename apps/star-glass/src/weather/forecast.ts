/**
 * The Open-Meteo forecast for the observing site: free, no key, CORS open.
 * One plain GET without custom headers (a CORS "simple request", no
 * preflight). Request style follows RainLens (apps/rain-lens/src/rain/api.ts).
 *
 * Coordinates are rounded to two decimals (about 1 km) before they leave the
 * phone: enough for a cloud forecast, not a precise address.
 */

export interface Coordinates {
  readonly latitude: number;
  readonly longitude: number;
}

/** One forecast hour; every value may be missing. */
export interface HourPoint {
  /** Start of the hour, epoch milliseconds (UTC). */
  readonly time: number;
  /** Total cloud cover, percent. */
  readonly cloud: number | null;
  readonly cloudLow: number | null;
  readonly cloudMid: number | null;
  readonly cloudHigh: number | null;
  /** Percent. */
  readonly rainProb: number | null;
  /** mm in that hour. */
  readonly rain: number | null;
  readonly humidity: number | null;
  readonly dewPoint: number | null;
  readonly temp: number | null;
  /** km/h. */
  readonly wind: number | null;
  readonly gust: number | null;
}

export interface Forecast {
  readonly fetchedAt: number;
  readonly position: Coordinates;
  readonly hours: readonly HourPoint[];
}

export const FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
export const HOURLY_FIELDS = [
  "cloud_cover", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high",
  "precipitation_probability", "precipitation", "relative_humidity_2m", "dew_point_2m",
  "temperature_2m", "wind_speed_10m", "wind_gusts_10m",
] as const;

const DEFAULT_TIMEOUT_MS = 10_000;

export const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Same place for the forecast when both coordinates agree to two decimals. */
export function samePlace(a: Coordinates | null, b: Coordinates | null): boolean {
  if (!a || !b) return a === b;
  return round2(a.latitude) === round2(b.latitude) && round2(a.longitude) === round2(b.longitude);
}

export function validCoordinates(value: { readonly latitude?: number | undefined; readonly longitude?: number | undefined } | null | undefined): value is Coordinates {
  if (!value) return false;
  const { latitude, longitude } = value;
  return typeof latitude === "number" && typeof longitude === "number" && Number.isFinite(latitude) && Number.isFinite(longitude)
    && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && !(latitude === 0 && longitude === 0);
}

/** Reads one coordinate typed on the phone; a decimal comma ("47,8") is fine. */
export function parseCoordinate(raw: string | null | undefined, limit: number): number | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const value = Number(raw.trim().replace(",", "."));
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

export function forecastUrl(position: Coordinates): string {
  const url = new URL(FORECAST_ENDPOINT);
  url.searchParams.set("latitude", round2(position.latitude).toFixed(2));
  url.searchParams.set("longitude", round2(position.longitude).toFixed(2));
  url.searchParams.set("hourly", HOURLY_FIELDS.join(","));
  url.searchParams.set("wind_speed_unit", "kmh");
  url.searchParams.set("timeformat", "unixtime");
  url.searchParams.set("timezone", "GMT");
  url.searchParams.set("past_hours", "1");
  url.searchParams.set("forecast_hours", "14");
  return url.toString();
}

type Raw = Record<string, unknown>;
const rec = (value: unknown): Raw => (value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {});
const at = (list: unknown, index: number): number | null => {
  if (!Array.isArray(list)) return null;
  const value: unknown = list[index];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/** Defensive: odd or partial answers give fewer hours, never an exception. */
export function parseForecast(input: unknown, position: Coordinates, fetchedAt: number): Forecast {
  const hourly = rec(rec(input)["hourly"]);
  const times = Array.isArray(hourly["time"]) ? hourly["time"] : [];
  const hours: HourPoint[] = [];
  times.forEach((time, i) => {
    const seconds = typeof time === "number" && Number.isFinite(time) ? time : typeof time === "string" ? Date.parse(time.endsWith("Z") ? time : time + "Z") / 1000 : NaN;
    if (!Number.isFinite(seconds)) return;
    hours.push({
      time: seconds * 1000,
      cloud: at(hourly["cloud_cover"], i),
      cloudLow: at(hourly["cloud_cover_low"], i),
      cloudMid: at(hourly["cloud_cover_mid"], i),
      cloudHigh: at(hourly["cloud_cover_high"], i),
      rainProb: at(hourly["precipitation_probability"], i),
      rain: at(hourly["precipitation"], i),
      humidity: at(hourly["relative_humidity_2m"], i),
      dewPoint: at(hourly["dew_point_2m"], i),
      temp: at(hourly["temperature_2m"], i),
      wind: at(hourly["wind_speed_10m"], i),
      gust: at(hourly["wind_gusts_10m"], i),
    });
  });
  hours.sort((a, b) => a.time - b.time);
  return { fetchedAt, position: { latitude: round2(position.latitude), longitude: round2(position.longitude) }, hours };
}

export interface FetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/** Fetches and parses; a stalled request is aborted. Throws `Error("timeout" | "HTTP n" | "unreachable" | "bad-reply")`. */
export async function fetchForecast(position: Coordinates, options: FetchOptions = {}): Promise<Forecast> {
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(forecastUrl(position), { signal: controller.signal });
  } catch {
    clearTimeout(timer);
    throw new Error(controller.signal.aborted ? "timeout" : "unreachable");
  }
  try {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error(controller.signal.aborted ? "timeout" : "bad-reply"); }
    const forecast = parseForecast(body, position, (options.now ?? Date.now)());
    if (forecast.hours.length === 0) throw new Error("bad-reply");
    return forecast;
  } finally {
    clearTimeout(timer);
  }
}

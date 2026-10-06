import { parseOpenMeteo, type WeatherForecast } from "./model";

export interface Coordinates { readonly latitude: number; readonly longitude: number; }
export interface ForecastOptions { readonly timeoutMs?: number; readonly fetchImpl?: typeof fetch; }

const DEFAULT_TIMEOUT = 10_000;

/** Reads one coordinate typed on the phone; accepts a decimal comma ("47,8"), as German keyboards produce. */
export function parseCoordinate(raw: string | null, limit: number): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw.trim().replace(",", "."));
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

/** Null when the stored pair is missing, malformed, out of range, or the unset 0/0 placeholder. */
export function parseCoordinates(latitude: string | null, longitude: string | null): Coordinates | null {
  const lat = parseCoordinate(latitude, 90); const lon = parseCoordinate(longitude, 180);
  if (lat === null || lon === null || (lat === 0 && lon === 0)) return null;
  return { latitude: lat, longitude: lon };
}

export function forecastUrl(position: Coordinates): URL {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(position.latitude)); url.searchParams.set("longitude", String(position.longitude));
  url.searchParams.set("current", "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m");
  url.searchParams.set("hourly", "temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m");
  url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset");
  url.searchParams.set("forecast_days", "3"); url.searchParams.set("timezone", "auto");
  return url;
}

/** Fetches and parses; a stalled request is aborted so the glasses never stay on "Updating..." forever. */
export async function fetchForecast(position: Coordinates, options: ForecastOptions = {}): Promise<WeatherForecast> {
  const doFetch = options.fetchImpl ?? fetch; const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const response = await doFetch(forecastUrl(position), { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseOpenMeteo(await response.json());
  } catch (cause) {
    if (controller.signal.aborted) throw new Error("timed out");
    throw cause;
  } finally { clearTimeout(timeout); }
}

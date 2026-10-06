export type WeatherKind = "clear" | "cloud" | "fog" | "rain" | "snow" | "storm";

export interface CurrentWeather {
  readonly time: string; readonly temperature: number; readonly feelsLike: number; readonly humidity: number;
  readonly precipitation: number; readonly weatherCode: number; readonly cloudCover: number; readonly windSpeed: number;
  readonly windDirection: number; readonly windGusts: number; readonly isDay: boolean;
}
export interface HourWeather { readonly time: string; readonly temperature: number; readonly precipitationProbability: number; readonly precipitation: number; readonly weatherCode: number; readonly windSpeed: number; }
export interface DayWeather { readonly date: string; readonly minimum: number; readonly maximum: number; readonly precipitationProbability: number; readonly weatherCode: number; readonly sunrise: string; readonly sunset: string; }
export interface WeatherForecast { readonly current: CurrentWeather; readonly hourly: readonly HourWeather[]; readonly daily: readonly DayWeather[]; readonly source: "live" | "demo"; }

type NumericRecord = Record<string, unknown>;
// Open-Meteo sends null for values a model does not cover; Number(null) is 0, so only real numbers count.
function toNumber(value: unknown): number { return typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN; }
function finite(record: NumericRecord, key: string): number { const value = toNumber(record[key]); if (!Number.isFinite(value)) throw new Error(`forecast field ${key} is missing`); return value; }
function strings(value: unknown): readonly string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function numbers(value: unknown): readonly number[] { return Array.isArray(value) ? value.map(toNumber) : []; }

export function parseOpenMeteo(value: unknown): WeatherForecast {
  const root = value as { current?: NumericRecord; hourly?: NumericRecord; daily?: NumericRecord };
  if (!root?.current || typeof root.current.time !== "string") throw new Error("forecast has no current weather");
  const current: CurrentWeather = {
    time: root.current.time, temperature: finite(root.current, "temperature_2m"), feelsLike: finite(root.current, "apparent_temperature"),
    humidity: finite(root.current, "relative_humidity_2m"), precipitation: finite(root.current, "precipitation"), weatherCode: finite(root.current, "weather_code"),
    cloudCover: finite(root.current, "cloud_cover"), windSpeed: finite(root.current, "wind_speed_10m"), windDirection: finite(root.current, "wind_direction_10m"),
    windGusts: finite(root.current, "wind_gusts_10m"), isDay: finite(root.current, "is_day") === 1,
  };
  const hourly = root.hourly ?? {}; const hourTimes = strings(hourly.time); const hourTemperature = numbers(hourly.temperature_2m);
  const hourRainChance = numbers(hourly.precipitation_probability); const hourRain = numbers(hourly.precipitation);
  const hourCodes = numbers(hourly.weather_code); const hourWind = numbers(hourly.wind_speed_10m); const hours: HourWeather[] = [];
  for (let index = 0; index < hourTimes.length && hours.length < 12; index += 1) {
    // Compare whole hours: current.time comes in 15-minute steps ("11:15"), and the 11:00 hour is still the current one.
    const time = hourTimes[index]; if (!time || time.slice(0, 13) < current.time.slice(0, 13)) continue;
    const values = [hourTemperature[index], hourRainChance[index], hourRain[index], hourCodes[index], hourWind[index]];
    if (!values.every(Number.isFinite)) continue;
    hours.push({ time, temperature: values[0]!, precipitationProbability: values[1]!, precipitation: values[2]!, weatherCode: values[3]!, windSpeed: values[4]! });
  }
  if (hours.length === 0) throw new Error("forecast has no hourly weather");
  const daily = root.daily ?? {}; const dayDates = strings(daily.time); const dayMin = numbers(daily.temperature_2m_min); const dayMax = numbers(daily.temperature_2m_max);
  const dayRain = numbers(daily.precipitation_probability_max); const dayCodes = numbers(daily.weather_code); const sunrises = strings(daily.sunrise); const sunsets = strings(daily.sunset); const days: DayWeather[] = [];
  for (let index = 0; index < Math.min(dayDates.length, 3); index += 1) {
    const date = dayDates[index]; const sunrise = sunrises[index]; const sunset = sunsets[index]; const values = [dayMin[index], dayMax[index], dayRain[index], dayCodes[index]];
    if (!date || !sunrise || !sunset || !values.every(Number.isFinite)) continue;
    days.push({ date, minimum: values[0]!, maximum: values[1]!, precipitationProbability: values[2]!, weatherCode: values[3]!, sunrise, sunset });
  }
  if (days.length === 0) throw new Error("forecast has no daily weather");
  return { current, hourly: hours, daily: days, source: "live" };
}

export function demoWeather(now = new Date()): WeatherForecast {
  const hour = new Date(now); hour.setMinutes(0, 0, 0);
  const hourly = Array.from({ length: 12 }, (_, index): HourWeather => ({ time: new Date(hour.valueOf() + index * 3_600_000).toISOString(), temperature: 14 + Math.sin(index / 3) * 3, precipitationProbability: [15, 20, 35, 60, 75, 55, 30, 20, 10, 10, 5, 5][index] ?? 0, precipitation: [0, 0, 0, 0.4, 1.2, 0.6, 0.1, 0, 0, 0, 0, 0][index] ?? 0, weatherCode: [2, 2, 3, 61, 63, 61, 3, 2, 1, 1, 0, 0][index] ?? 0, windSpeed: 12 + index }));
  const daily = Array.from({ length: 3 }, (_, index): DayWeather => { const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + index); const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`; return { date, minimum: 8 + index, maximum: 18 + index, precipitationProbability: [75, 25, 10][index] ?? 0, weatherCode: [61, 2, 1][index] ?? 0, sunrise: `${date}T07:08`, sunset: `${date}T18:42` }; });
  return { source: "demo", current: { time: now.toISOString(), temperature: 14.8, feelsLike: 13.6, humidity: 72, precipitation: 0, weatherCode: 2, cloudCover: 55, windSpeed: 14, windDirection: 245, windGusts: 24, isDay: true }, hourly, daily };
}

export function weatherKind(code: number): WeatherKind {
  if (code === 0 || code === 1) return "clear"; if (code === 2 || code === 3) return "cloud"; if (code === 45 || code === 48) return "fog";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain"; if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm"; return "cloud";
}
export function windCompass(degrees: number): string { const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]; return points[Math.round(((degrees % 360) + 360) % 360 / 45) % 8] ?? "N"; }
export function clock(iso: string, locale = "de-AT"): string { const date = new Date(iso); return Number.isNaN(date.valueOf()) ? "--:--" : date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }); }
export function dayName(iso: string, locale = "de-AT"): string { const date = new Date(`${iso}T12:00:00`); return Number.isNaN(date.valueOf()) ? "---" : date.toLocaleDateString(locale, { weekday: "short" }); }

/** Rows the 214 px body shows, and roughly the characters across it next to the 104 px icon column. */
export const BODY_ROWS = 7;
export const LINE_WIDTH = 38;
/** Cuts to the line budget with an ellipsis instead of letting the glasses wrap into a row that gets clipped. */
export function fit(text: string, width: number = LINE_WIDTH): string { const chars = Array.from(text); return chars.length <= width ? text : chars.slice(0, Math.max(0, width - 1)).join("") + "…"; }
/** Page lines plus an optional error row, each one row wide and seven rows at most, so the error is never pushed into an eighth row. */
export function glassesBody(lines: readonly string[], error = "", rows: number = BODY_ROWS, width: number = LINE_WIDTH): string[] { return [...lines.slice(0, error ? rows - 1 : rows), ...(error ? [`! ${error.replace(/\s+/g, " ").trim()}`] : [])].map((line) => fit(line, width)); }
/** Error text and stored coordinates are not trusted markup on the phone page. */
export function escapeHtml(text: string): string { return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char); }

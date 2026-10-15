import type { StationWeather } from "../nina/status";
import type { Forecast, HourPoint } from "./forecast";

/**
 * Weather warnings for an imaging night, as pure functions of (now, forecast,
 * station readings, thresholds): clouds coming, rain risk, dew risk, wind.
 *
 * N.I.N.A.'s own weather station (when connected) speaks for "now"; the
 * Open-Meteo forecast speaks for the next hours. Hysteresis: a warning that
 * is on stays on until its value is clearly back (10 % cloud / rain chance,
 * 1 °C dew spread, 5 km/h wind), so a value hovering at the limit does not
 * flicker. Popups: a warning pops up when it starts, but never twice within
 * 30 minutes (`trackWarnings`).
 */

export interface Thresholds {
  /** Total cloud cover in percent at or above which it counts as cloudy. */
  readonly cloud: number;
  /** Chance of precipitation in percent. */
  readonly rainProb: number;
  /** Temperature minus dew point in °C at or below which dew forms. */
  readonly dewSpread: number;
  /** Wind or gusts in km/h. */
  readonly wind: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { cloud: 60, rainProb: 40, dewSpread: 2, wind: 30 };

/** Allowed ranges for the phone page. */
export const THRESHOLD_LIMITS: Readonly<Record<keyof Thresholds, readonly [number, number]>> = {
  cloud: [10, 100],
  rainProb: [5, 100],
  dewSpread: [0, 10],
  wind: [5, 150],
};

/** How far a value must come back before an active warning clears. */
export const RELEASE: Thresholds = { cloud: 10, rainProb: 10, dewSpread: 1, wind: 5 };

/** Warnings look this far ahead. */
export const LEAD_MS = 2 * 3_600_000;
/** The chart and the clear-sky window look this far ahead. */
export const HORIZON_MS = 12 * 3_600_000;
/** Resolution of every search through the forecast. */
export const STEP_MS = 10 * 60_000;
/** The same warning pops up at most once in this time. */
export const POPUP_COOLDOWN_MS = 30 * 60_000;
/** Precipitation in mm per hour that counts as rain in the forecast. */
export const RAIN_MM = 0.2;

export function clampThresholds(value: Partial<Record<keyof Thresholds, unknown>> | null | undefined): Thresholds {
  const out: Record<keyof Thresholds, number> = { ...DEFAULT_THRESHOLDS };
  for (const key of Object.keys(DEFAULT_THRESHOLDS) as Array<keyof Thresholds>) {
    const raw = value?.[key];
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim().replace(",", ".")) : NaN;
    if (!Number.isFinite(n)) continue;
    const [low, high] = THRESHOLD_LIMITS[key];
    out[key] = Math.max(low, Math.min(high, Math.round(n * 10) / 10));
  }
  return out;
}

export type WarningKind = "clouds" | "rain" | "dew" | "wind";

export interface WeatherWarning {
  readonly kind: WarningKind;
  readonly level: "critical" | "warn";
  /** Minutes until it starts, in 10-minute steps; 0 = now. */
  readonly minutes: number;
  /** Percent (clouds, rain), °C spread (dew) or km/h (wind). */
  readonly value: number;
  readonly source: "station" | "forecast";
  /** Rain: it rains already (station rain sensor or measurable rain this hour). */
  readonly raining?: boolean;
}

export interface WeatherInput {
  readonly now: number;
  readonly forecast: Forecast | null;
  readonly station: StationWeather | null;
  readonly thresholds: Thresholds;
}

type Getter = (hour: HourPoint) => number | null;

export const cloudOf: Getter = (h) => h.cloud;
export const rainProbOf: Getter = (h) => h.rainProb;
export const spreadOf: Getter = (h) => (h.temp !== null && h.dewPoint !== null ? h.temp - h.dewPoint : null);
export const windOf: Getter = (h) => (h.wind === null && h.gust === null ? null : Math.max(h.wind ?? 0, h.gust ?? 0));

/**
 * A forecast value at any moment, linearly between the hours. Null outside
 * the forecast (one hour of slack after the last point) or where a value is missing.
 */
export function valueAt(hours: readonly HourPoint[], get: Getter, time: number): number | null {
  if (hours.length === 0) return null;
  const first = hours[0]!;
  const last = hours[hours.length - 1]!;
  if (time < first.time || time > last.time + 3_600_000) return null;
  if (time >= last.time) return get(last);
  for (let i = 0; i < hours.length - 1; i++) {
    const a = hours[i]!;
    const b = hours[i + 1]!;
    if (time < a.time || time > b.time) continue;
    const va = get(a);
    const vb = get(b);
    if (va === null || vb === null) return time - a.time < b.time - time ? va : vb;
    const span = b.time - a.time;
    return span <= 0 ? va : va + ((vb - va) * (time - a.time)) / span;
  }
  return null;
}

export interface Crossing {
  /** First moment the condition holds. */
  readonly at: number;
  /** The worst value from then to the end of the window (highest; lowest for `below`). */
  readonly peak: number;
}

/** First moment in [from, to] (10-minute steps) where the value is >= limit (or <= limit with `below`). */
export function firstCrossing(hours: readonly HourPoint[], get: Getter, limit: number, from: number, to: number, below = false): Crossing | null {
  let found: number | null = null;
  let peak = below ? Infinity : -Infinity;
  for (let t = from; t <= to; t += STEP_MS) {
    const v = valueAt(hours, get, t);
    if (v === null) continue;
    const hit = below ? v <= limit : v >= limit;
    if (found === null && hit) found = t;
    if (found !== null) peak = below ? Math.min(peak, v) : Math.max(peak, v);
  }
  // Hourly points between the steps can hold the real peak.
  if (found !== null) {
    for (const h of hours) {
      const v = get(h);
      if (v === null || h.time < found || h.time > to) continue;
      peak = below ? Math.min(peak, v) : Math.max(peak, v);
    }
  }
  return found === null ? null : { at: found, peak };
}

const stepsUntil = (now: number, at: number): number => Math.max(0, Math.round((at - now) / STEP_MS) * 10);

const release = (active: ReadonlySet<string>, kind: WarningKind): boolean => active.has(kind) || (kind === "rain" && active.has("rainNow"));

/**
 * The warnings right now, worst first. `active` (from `trackWarnings`) are the
 * kinds already on: they use the release limits (hysteresis).
 */
export function evaluateWeather(input: WeatherInput, active: ReadonlySet<string> = new Set()): WeatherWarning[] {
  const { now, station, thresholds } = input;
  const hours = input.forecast?.hours ?? [];
  const out: WeatherWarning[] = [];
  const ahead = now + LEAD_MS;

  // Clouds: the station's sky sensor for now, the forecast for what comes.
  {
    const limit = release(active, "clouds") ? thresholds.cloud - RELEASE.cloud : thresholds.cloud;
    const measured = station?.cloudCover ?? null;
    if (measured !== null && measured >= limit) {
      out.push({ kind: "clouds", level: "warn", minutes: 0, value: Math.round(measured), source: "station" });
    } else {
      const hit = firstCrossing(hours, cloudOf, limit, measured !== null ? now + STEP_MS : now, ahead);
      if (hit) out.push({ kind: "clouds", level: "warn", minutes: stepsUntil(now, hit.at), value: Math.round(hit.peak), source: "forecast" });
    }
  }

  // Rain: the rain sensor wins; then measurable rain or a high chance in the forecast.
  {
    const limit = release(active, "rain") ? thresholds.rainProb - RELEASE.rainProb : thresholds.rainProb;
    const rate = station?.rainRate ?? null;
    const chanceNow = valueAt(hours, rainProbOf, now);
    if (rate !== null && rate > 0) {
      out.push({ kind: "rain", level: "critical", minutes: 0, value: Math.round(Math.max(chanceNow ?? 100, 0)), source: "station", raining: true });
    } else {
      const wet = rate === null ? firstCrossing(hours, (h) => h.rain, RAIN_MM, now, now) : null;
      const chance = firstCrossing(hours, rainProbOf, limit, now, ahead);
      const shower = firstCrossing(hours, (h) => h.rain, RAIN_MM, now, ahead);
      if (wet) {
        out.push({ kind: "rain", level: "warn", minutes: 0, value: Math.round(chanceNow ?? 100), source: "forecast", raining: true });
      } else if (chance || shower) {
        const at = Math.min(chance?.at ?? Infinity, shower?.at ?? Infinity);
        const peak = Math.max(chance?.peak ?? 0, firstCrossing(hours, rainProbOf, 0, at, ahead)?.peak ?? 0);
        out.push({ kind: "rain", level: "warn", minutes: stepsUntil(now, at), value: Math.round(peak), source: "forecast" });
      }
    }
  }

  // Dew: temperature minus dew point.
  {
    const limit = release(active, "dew") ? thresholds.dewSpread + RELEASE.dewSpread : thresholds.dewSpread;
    const measured = station && station.temperature !== null && station.dewPoint !== null ? station.temperature - station.dewPoint : null;
    if (measured !== null && measured <= limit) {
      out.push({ kind: "dew", level: "warn", minutes: 0, value: Math.round(Math.max(0, measured) * 10) / 10, source: "station" });
    } else {
      const hit = firstCrossing(hours, spreadOf, limit, measured !== null ? now + STEP_MS : now, ahead, true);
      if (hit) out.push({ kind: "dew", level: "warn", minutes: stepsUntil(now, hit.at), value: Math.round(Math.max(0, hit.peak) * 10) / 10, source: "forecast" });
    }
  }

  // Wind and gusts.
  {
    const limit = release(active, "wind") ? thresholds.wind - RELEASE.wind : thresholds.wind;
    const measured = station && (station.windSpeed !== null || station.windGust !== null) ? Math.max(station.windSpeed ?? 0, station.windGust ?? 0) : null;
    if (measured !== null && measured >= limit) {
      out.push({ kind: "wind", level: "warn", minutes: 0, value: Math.round(measured), source: "station" });
    } else {
      const hit = firstCrossing(hours, windOf, limit, measured !== null ? now + STEP_MS : now, ahead);
      if (hit) out.push({ kind: "wind", level: "warn", minutes: stepsUntil(now, hit.at), value: Math.round(hit.peak), source: "forecast" });
    }
  }

  const rank = { critical: 0, warn: 1 } as const;
  return out.sort((a, b) => rank[a.level] - rank[b.level] || a.minutes - b.minutes);
}

/** Popups are counted per warning; rain that has started is a new warning after a rain risk. */
export function warningKey(warning: WeatherWarning): string {
  return warning.kind === "rain" && warning.raining ? "rainNow" : warning.kind;
}

export interface WarningTracker {
  /** Keys of the warnings that are on. */
  readonly active: ReadonlySet<string>;
  /** When each key last popped up. */
  readonly lastPopup: Readonly<Record<string, number>>;
}

export const EMPTY_TRACKER: WarningTracker = { active: new Set(), lastPopup: {} };

/**
 * Next tracker state and the warnings to pop up now: those that just
 * started and did not pop up in the last 30 minutes.
 */
export function trackWarnings(tracker: WarningTracker, warnings: readonly WeatherWarning[], now: number): { tracker: WarningTracker; popups: WeatherWarning[] } {
  const active = new Set<string>();
  const lastPopup: Record<string, number> = { ...tracker.lastPopup };
  const popups: WeatherWarning[] = [];
  for (const warning of warnings) {
    const key = warningKey(warning);
    active.add(key);
    if (tracker.active.has(key)) continue;
    const last = lastPopup[key];
    if (last !== undefined && now - last < POPUP_COOLDOWN_MS) continue;
    lastPopup[key] = now;
    popups.push(warning);
  }
  return { tracker: { active, lastPopup }, popups };
}

/** Where the night stands: clear until when, or cloudy until when. */
export type SkyWindow =
  | { readonly kind: "clear"; /** First cloudy moment; null = clear for the whole horizon. */ readonly until: number | null }
  | { readonly kind: "cloudy"; /** First clear moment; null = no clearing within the horizon. */ readonly from: number | null }
  | { readonly kind: "unknown" };

export function skyWindow(input: WeatherInput): SkyWindow {
  const { now, station, thresholds } = input;
  const hours = input.forecast?.hours ?? [];
  const current = station?.cloudCover ?? valueAt(hours, cloudOf, now);
  if (current === null) return { kind: "unknown" };
  const end = now + HORIZON_MS;
  if (current < thresholds.cloud) {
    const hit = firstCrossing(hours, cloudOf, thresholds.cloud, now + STEP_MS, end);
    return { kind: "clear", until: hit ? hit.at : null };
  }
  const clear = firstCrossing(hours, cloudOf, thresholds.cloud - 0.001, now + STEP_MS, end, true);
  return { kind: "cloudy", from: clear ? clear.at : null };
}

/** Rounded to 10 minutes, "02:30", in the given offset from UTC (minutes east). */
export function clockText(time: number, offsetMinutes: number): string {
  const local = Math.round((time + offsetMinutes * 60_000) / STEP_MS) * STEP_MS;
  const d = new Date(local);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** The phone's offset from UTC at that moment, in minutes east. */
export function localOffset(time: number): number {
  return -new Date(time).getTimezoneOffset();
}

/** "~40 min", "~1 h 30". */
export function inMinutes(minutes: number): string {
  if (minutes < 60) return `~${Math.max(10, minutes)} min`;
  const rest = minutes % 60;
  return rest ? `~${Math.floor(minutes / 60)} h ${String(rest).padStart(2, "0")}` : `~${minutes / 60} h`;
}

/** The forecast for the cloud chart: one value per sample from now over the horizon. */
export function cloudSeries(forecast: Forecast | null, now: number, samples: number, get: Getter = cloudOf): Array<number | null> {
  const hours = forecast?.hours ?? [];
  const out: Array<number | null> = [];
  for (let i = 0; i < samples; i++) out.push(valueAt(hours, get, now + (HORIZON_MS * i) / Math.max(1, samples - 1)));
  return out;
}

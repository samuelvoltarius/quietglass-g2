/**
 * The car link (private build): your own byd-bridge
 * (selfhost/services/byd-bridge) answers `GET /state` with what the car
 * reports. OpenGlance only READS it: the car's own speedometer value instead
 * of the GPS speed, and the battery for "arrive with ~62 %". Nothing is ever
 * sent to the car from here.
 *
 * Plain GET without custom headers is a CORS "simple request" (no
 * preflight); the bridge authenticates through `tailscale serve`.
 */

const BUILD_BYD_URL: string | undefined = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_BYD_URL;

/** The bridge address of this build (`VITE_BYD_URL`); empty = no car link (public build). */
export function buildBydUrl(raw: string | undefined = BUILD_BYD_URL): string {
  const url = (raw ?? "").trim().replace(/\/+$/, "");
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? url : "";
  } catch {
    return "";
  }
}

/** A car speed older than this (telemetry age + time since the answer) falls back to the GPS. */
export const CAR_FRESH_MS = 10_000;
/** The battery is still shown when the last answer is at most this old. */
export const CAR_BATTERY_MAX_MS = 10 * 60_000;
/**
 * Battery values from the BYD cloud (bridge `battery.src: "cloud"`, when the
 * car itself is silent) are shown up to this age, marked "Cloud".
 */
export const CLOUD_BATTERY_MAX_MIN = 180;
/** Poll while navigating by car, and otherwise (phone line only). */
export const CAR_POLL_NAV_MS = 5_000;
export const CAR_POLL_IDLE_MS = 60_000;
/** Consumption when the car has no 50-km value yet (kWh/100 km). */
export const DEFAULT_CONSUMPTION = 16;
/**
 * Usable battery of the Dolphin Surf (large battery). The bridge passes no
 * capacity field, so it is a phone setting with this default.
 */
export const DEFAULT_USABLE_KWH = 43.2;
export const USABLE_KWH_MIN = 10;
export const USABLE_KWH_MAX = 150;
/** Below this the glasses warn: plan a charging stop. */
export const LOW_ARRIVAL_SOC = 10;

export interface CarSnapshot {
  /** When the answer arrived (ms, local clock). */
  readonly fetchedAt: number;
  /** The bridge says its data is old (car asleep). */
  readonly stale: boolean;
  /** Seconds since the car last reported, as the bridge counted it. */
  readonly ageS: number | null;
  readonly mode: string | null;
  readonly speed: number | null;
  readonly soc: number | null;
  readonly rangeKm: number | null;
  /** kWh/100 km over the last 50 km. */
  readonly cons50: number | null;
  /** Where soc and range come from: the car itself, or the BYD cloud while the car is silent. */
  readonly batterySource: "car" | "cloud";
  /** Age of the cloud values in minutes (null when they come from the car). */
  readonly cloudAgeMin: number | null;
  /** Last known place of the car (from the cloud), null when unknown. */
  readonly position: { readonly lat: number; readonly lon: number; readonly ageMin: number | null } | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The bridge's `/state` JSON → what the navigation needs; null when it is not a car state. */
export function parseCarState(raw: unknown, fetchedAt: number): CarSnapshot | null {
  const r = obj(raw);
  const mode = r["mode"];
  if (mode !== "driving" && mode !== "charging" && mode !== "parked") return null;
  const drive = obj(r["drive"]);
  const battery = obj(r["battery"]);
  const place = obj(r["position"]);
  const lat = num(place["lat"]);
  const lon = num(place["lon"]);
  return {
    fetchedAt,
    stale: r["stale"] !== false,
    ageS: num(r["age_s"]),
    mode,
    speed: num(drive["speed"]),
    soc: num(battery["soc"]),
    rangeKm: num(battery["range_km"]),
    cons50: num(drive["cons50"]),
    batterySource: battery["src"] === "cloud" ? "cloud" : "car",
    cloudAgeMin: battery["src"] === "cloud" ? num(battery["cloud_age_min"]) : null,
    position: lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon, ageMin: num(place["age_min"]) } : null,
  };
}

/** How old the car's values are now: its own age plus the time since the answer. */
export function carAgeMs(car: CarSnapshot, now: number): number {
  if (car.ageS === null) return Number.POSITIVE_INFINITY;
  return car.ageS * 1000 + Math.max(0, now - car.fetchedAt);
}

/** The car's speed when it is fresh enough to trust, else null. */
export function freshCarSpeed(car: CarSnapshot | null, now: number): number | null {
  if (!car || car.stale || car.speed === null || car.speed < 0) return null;
  if (carAgeMs(car, now) >= CAR_FRESH_MS) return null;
  return Math.round(car.speed);
}

export type SpeedSource = "car" | "gps";

/**
 * Which speed the glasses show: the car's when fresh, otherwise the GPS. With
 * no car link at all the source stays undefined (nothing to mark).
 */
export function chooseSpeed(car: CarSnapshot | null, gpsKmh: number | null, now: number, linked: boolean): { kmh: number | null; source?: SpeedSource } {
  if (!linked) return { kmh: gpsKmh };
  const carKmh = freshCarSpeed(car, now);
  return carKmh !== null ? { kmh: carKmh, source: "car" } : { kmh: gpsKmh, source: "gps" };
}

/** Consumption used for the estimate: the car's 50-km value when it has one. */
export function consumptionOf(car: CarSnapshot | null): number {
  return car && car.cons50 !== null && car.cons50 > 0 ? car.cons50 : DEFAULT_CONSUMPTION;
}

/**
 * Battery at arrival in %, not rounded and not clamped:
 * soc − (remaining km × kWh/100 km ÷ 100) ÷ usable kWh × 100.
 */
export function arrivalSoc(soc: number, remainingKm: number, consumption: number, usableKwh: number): number {
  if (!(usableKwh > 0)) return soc;
  const kwh = (Math.max(0, remainingKm) * Math.max(0, consumption)) / 100;
  return soc - (kwh / usableKwh) * 100;
}

export function clampUsableKwh(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(",", ".")) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_USABLE_KWH;
  return Math.round(Math.max(USABLE_KWH_MIN, Math.min(USABLE_KWH_MAX, n)) * 10) / 10;
}

export interface BatteryEstimate {
  /** Now, whole %. */
  readonly soc: number;
  /** At arrival, whole %, never below 0. */
  readonly arrival: number;
  /** Below LOW_ARRIVAL_SOC. */
  readonly low: boolean;
  /** The value comes from the BYD cloud (shown marked). */
  readonly cloud?: boolean;
}

/** Battery values the glasses may show: recent, and cloud values only up to CLOUD_BATTERY_MAX_MIN old. */
function batteryUsable(car: CarSnapshot, now: number): boolean {
  if (now - car.fetchedAt > CAR_BATTERY_MAX_MS) return false;
  return car.batterySource !== "cloud" || (car.cloudAgeMin !== null && car.cloudAgeMin <= CLOUD_BATTERY_MAX_MIN);
}

/**
 * Now and at arrival, or null when the car has no (recent) battery value.
 * `climbKwh`: extra energy for the height still to climb (see car/elevation.ts;
 * negative when the way ahead goes down) - 0 when no height profile is known.
 */
export function batteryEstimate(car: CarSnapshot | null, remainingM: number, usableKwh: number, now: number, climbKwh = 0): BatteryEstimate | null {
  if (!car || car.soc === null || !batteryUsable(car, now)) return null;
  const climbSoc = usableKwh > 0 && Number.isFinite(climbKwh) ? (climbKwh / usableKwh) * 100 : 0;
  const raw = arrivalSoc(car.soc, remainingM / 1000, consumptionOf(car), usableKwh) - climbSoc;
  const arrival = Math.max(0, Math.round(raw));
  return { soc: Math.round(car.soc), arrival, low: raw < LOW_ARRIVAL_SOC, ...(car.batterySource === "cloud" ? { cloud: true } : {}) };
}

/** Fetches the car state; null on any failure (the navigation carries on without it). */
export async function fetchCar(base: string, now: () => number, fetchImpl: typeof fetch = (input, init) => fetch(input, init), timeoutMs = 8_000): Promise<CarSnapshot | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(base.replace(/\/+$/, "") + "/state", { cache: "no-store", signal: controller.signal });
    if (!response.ok) return null;
    return parseCarState(await response.json(), now());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface BatteryRange {
  /** Kilometres the battery still reaches, whole km. */
  readonly km: number;
  /** True when computed here (no range from the car): shown with "≈". */
  readonly estimated: boolean;
  /** The value comes from the BYD cloud (shown marked). */
  readonly cloud?: boolean;
}

/**
 * Remaining range: the car's own value when the bridge has one, otherwise
 * SoC × usable kWh ÷ consumption (the car's 50-km value, else
 * DEFAULT_CONSUMPTION kWh/100 km), marked as an estimate. Null without a
 * (recent) battery value.
 */
export function batteryRange(car: CarSnapshot | null, usableKwh: number, now: number): BatteryRange | null {
  if (!car || !batteryUsable(car, now)) return null;
  const cloud = car.batterySource === "cloud" ? { cloud: true } : {};
  if (car.rangeKm !== null && car.rangeKm >= 0) return { km: Math.round(car.rangeKm), estimated: false, ...cloud };
  if (car.soc === null || !(usableKwh > 0)) return null;
  const kwh = (Math.max(0, Math.min(100, car.soc)) / 100) * usableKwh;
  return { km: Math.round((kwh / consumptionOf(car)) * 100), estimated: true, ...cloud };
}

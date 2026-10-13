/**
 * Nightscout data as Sugar Glass reads it: glucose readings (entries), the
 * newest pump/uploader report (devicestatus) and recent treatments. Every
 * parser is defensive — Nightscout is fed by many uploaders, and fields are
 * missing, strings, or named differently.
 */

/** Nightscout trend directions (entries `direction`). */
export type Direction =
  | "TripleUp" | "DoubleUp" | "SingleUp" | "FortyFiveUp" | "Flat"
  | "FortyFiveDown" | "SingleDown" | "DoubleDown" | "TripleDown" | "NONE";

const DIRECTIONS: readonly Direction[] = ["TripleUp", "DoubleUp", "SingleUp", "FortyFiveUp", "Flat", "FortyFiveDown", "SingleDown", "DoubleDown", "TripleDown"];
/** Nightscout's numeric `trend` (1..7) as a direction, for uploaders without `direction`. */
const TREND_NUMBERS: Readonly<Record<number, Direction>> = { 1: "DoubleUp", 2: "SingleUp", 3: "FortyFiveUp", 4: "Flat", 5: "FortyFiveDown", 6: "SingleDown", 7: "DoubleDown" };

export interface Reading {
  /** Milliseconds since the epoch. */
  readonly at: number;
  /** Always mg/dL internally. */
  readonly mgdl: number;
  readonly direction: Direction;
}

export interface PumpStatus {
  /** When the report was made (ms), if known. */
  readonly at: number | null;
  readonly device: string | null;
  /** Insulin on board, units. */
  readonly iob: number | null;
  /** Reservoir, units. */
  readonly reservoir: number | null;
  /** Pump battery, percent. */
  readonly battery: number | null;
  /** Phone / uploader battery, percent. */
  readonly uploaderBattery: number | null;
  /** SmartGuard / closed loop: "auto", "safe" (safe basal), "manual", or null if not reported. */
  readonly mode: "auto" | "safe" | "manual" | null;
  /** Sensor: hours until change, if reported. */
  readonly sensorHours: number | null;
  /** Raw sensor state from CareLink (e.g. WARM_UP), if any. */
  readonly sensorState: string | null;
  /** Hours until the next calibration, if reported. */
  readonly calibHours: number | null;
}

export interface Treatments {
  readonly lastCarbs: { readonly at: number; readonly grams: number } | null;
  readonly lastBolus: { readonly at: number; readonly units: number } | null;
}

const num = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
};
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const time = (...values: unknown[]): number | null => {
  for (const value of values) {
    const n = num(value);
    if (n !== null && n > 1e11) return n;
    if (typeof value === "string" && value) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
};

export function toDirection(direction: unknown, trend?: unknown): Direction {
  if (typeof direction === "string") {
    const found = DIRECTIONS.find((d) => d.toLowerCase() === direction.trim().toLowerCase());
    if (found) return found;
  }
  const n = num(trend);
  return n !== null ? TREND_NUMBERS[n] ?? "NONE" : "NONE";
}

/** SGV entries, newest first, without duplicates or nonsense values. */
export function parseEntries(body: unknown): Reading[] {
  if (!Array.isArray(body)) return [];
  const seen = new Set<number>();
  const out: Reading[] = [];
  for (const item of body) {
    const r = record(item);
    if (!r) continue;
    if (r["type"] !== undefined && r["type"] !== "sgv") continue;
    const mgdl = num(r["sgv"]);
    const at = time(r["date"], r["dateString"], r["sysTime"]);
    // 39 = "LOW" and 401 = "HIGH" from some sensors; anything outside is an error code.
    if (mgdl === null || at === null || mgdl < 20 || mgdl > 600 || seen.has(at)) continue;
    seen.add(at);
    out.push({ at, mgdl: Math.round(mgdl), direction: toDirection(r["direction"], r["trend"]) });
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * Change against the reading about five minutes earlier, scaled to five
 * minutes (mg/dL per 5 min). Null when there is no reading 2.5–15 min before.
 */
export function delta(readings: readonly Reading[]): number | null {
  const [now, ...rest] = readings;
  if (!now) return null;
  const before = rest.find((r) => now.at - r.at >= 150_000);
  if (!before) return null;
  const minutes = (now.at - before.at) / 60_000;
  if (minutes > 15) return null;
  return Math.round(((now.mgdl - before.mgdl) / minutes) * 5);
}

function mode(pump: Record<string, unknown> | null, connect: Record<string, unknown> | null, root: Record<string, unknown>): PumpStatus["mode"] {
  const candidates = [
    record(connect?.["therapyAlgorithmState"])?.["autoModeShieldState"],
    connect?.["autoModeShieldState"],
    record(pump?.["status"])?.["status"],
    pump?.["mode"],
  ].filter((v): v is string => typeof v === "string").map((v) => v.toUpperCase());
  for (const value of candidates) {
    if (value.includes("SAFE")) return "safe";
    if (value.includes("AUTO") || value.includes("SMARTGUARD") || value.includes("CLOSED")) return "auto";
    if (value.includes("MANUAL") || value.includes("FEATURE_OFF") || value.includes("NORMAL")) return "manual";
  }
  if (record(root["openaps"]) || record(root["loop"])) return "auto";
  return null;
}

/** The newest devicestatus document that says anything about the pump. */
export function parseDeviceStatus(body: unknown): PumpStatus | null {
  if (!Array.isArray(body)) return null;
  const docs = body.map(record).filter((r): r is Record<string, unknown> => r !== null);
  docs.sort((a, b) => (time(b["created_at"], b["mills"]) ?? 0) - (time(a["created_at"], a["mills"]) ?? 0));
  for (const doc of docs) {
    const pump = record(doc["pump"]);
    const connect = record(doc["connect"]);
    const uploader = record(doc["uploader"]);
    const iobRecord = record(pump?.["iob"]) ?? record(record(doc["openaps"])?.["iob"]) ?? record(record(doc["loop"])?.["iob"]);
    const battery = record(pump?.["battery"]);
    const status: PumpStatus = {
      at: time(doc["created_at"], doc["mills"]),
      device: typeof doc["device"] === "string" ? doc["device"] : null,
      iob: num(iobRecord?.["bolusiob"]) ?? num(iobRecord?.["iob"]),
      reservoir: num(pump?.["reservoir"]),
      battery: num(battery?.["percent"]) ?? num(connect?.["pumpBatteryLevelPercent"]) ?? num(connect?.["medicalDeviceBatteryLevelPercent"]),
      uploaderBattery: num(uploader?.["battery"]) ?? num(doc["uploaderBattery"]),
      mode: mode(pump, connect, doc),
      sensorHours: num(connect?.["sensorDurationHours"]),
      sensorState: typeof connect?.["sensorState"] === "string" ? (connect["sensorState"] as string) : null,
      calibHours: num(connect?.["timeToNextCalibHours"]),
    };
    if (pump || connect || status.uploaderBattery !== null) return status;
  }
  return null;
}

export function parseTreatments(body: unknown): Treatments {
  let lastCarbs: Treatments["lastCarbs"] = null;
  let lastBolus: Treatments["lastBolus"] = null;
  if (Array.isArray(body)) {
    for (const item of body) {
      const r = record(item);
      if (!r) continue;
      const at = time(r["created_at"], r["mills"], r["date"]);
      if (at === null) continue;
      const carbs = num(r["carbs"]);
      const insulin = num(r["insulin"]);
      if (carbs !== null && carbs > 0 && (!lastCarbs || at > lastCarbs.at)) lastCarbs = { at, grams: carbs };
      if (insulin !== null && insulin > 0 && (!lastBolus || at > lastBolus.at)) lastBolus = { at, units: insulin };
    }
  }
  return { lastCarbs, lastBolus };
}

/** Everything the app shows, from one round of requests. */
export interface SugarData {
  readonly readings: readonly Reading[];
  readonly pump: PumpStatus | null;
  readonly treatments: Treatments;
}

export const EMPTY_TREATMENTS: Treatments = { lastCarbs: null, lastBolus: null };

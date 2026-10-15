/**
 * The bridge's evaluation (selfhost/services/byd-bridge/byd_bridge.py, `derive`)
 * mirrored in TypeScript. The app uses it for demo mode, so the demo shows
 * exactly what the bridge would send; the tests run both on the same samples.
 *
 * Input: raw telemetry as Overdrive publishes it (field -> string), plus
 * `_age` (seconds since the last message). Output: the `/state` JSON shape.
 */

export type Telemetry = Readonly<Record<string, string | number | null | undefined>>;

export interface Thresholds {
  readonly tyreLowKpa: number;
  readonly v12Low: number;
  readonly socLow: number;
  readonly staleS: number;
  readonly unlockedMin: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { tyreLowKpa: 210, v12Low: 12.2, socLow: 15, staleS: 120, unlockedMin: 10 };

/** Overdrive's "no value" placeholders. */
const SENTINELS = new Set([65535, 1048575, -10011, 104857.5]);
const WHEELS = ["fl", "fr", "rl", "rr"] as const;

export interface Memo {
  wasCharging?: boolean;
  chargeDoneAt?: number;
  unlockedSince?: number;
}

export function parseValue(raw: string | number | null | undefined): number | string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === "" || ["NULL", "NONE", "NAN", "UNKNOWN", "UNAVAILABLE"].includes(text.toUpperCase())) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return text;
  return SENTINELS.has(value) ? null : value;
}

const num = (t: Telemetry, key: string): number | null => {
  const v = parseValue(t[key]);
  return typeof v === "number" ? v : null;
};
const flag = (t: Telemetry, key: string): boolean | null => {
  const v = num(t, key);
  return v === null ? null : v >= 1;
};
const r1 = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10);

export function modeOf(t: Telemetry): "driving" | "charging" | "parked" {
  const speed = num(t, "speed") ?? 0;
  const gearRaw = parseValue(t["gear"]);
  const gear = typeof gearRaw === "string" ? gearRaw.toUpperCase() : "";
  if (speed > 3 || gear === "D" || gear === "R" || (flag(t, "is_parked") === false && gear !== "P" && gear !== "")) return "driving";
  if (flag(t, "is_charging")) return "charging";
  return "parked";
}

export function deriveRaw(t: Telemetry, nowS: number, memo: Memo = {}, limits: Thresholds = DEFAULT_THRESHOLDS): Record<string, unknown> {
  const mode = modeOf(t);
  const age = typeof t["_age"] === "number" ? t["_age"] : null;
  const stale = age === null || age > limits.staleS;
  const power = num(t, "power");
  const charging = mode === "charging";
  let chargeKw: number | null = null;
  if (charging) chargeKw = power !== null && power < 0 ? -power : num(t, "charge_power");
  const etaMinutes = num(t, "charging_eta_minutes");
  const eta = etaMinutes === null ? null : Math.trunc((num(t, "charging_eta_hours") ?? 0) * 60 + etaMinutes);
  const soc = num(t, "soc");

  if (charging) { memo.wasCharging = true; delete memo.chargeDoneAt; }
  else if (memo.wasCharging) { memo.wasCharging = false; memo.chargeDoneAt = nowS; }
  const chargeDone = memo.chargeDoneAt !== undefined && nowS - memo.chargeDoneAt < 1800 && mode !== "driving";

  const locked = flag(t, "locked");
  const doorOpen = flag(t, "door_open");
  if (locked === false && mode !== "driving") memo.unlockedSince ??= nowS;
  else delete memo.unlockedSince;

  const tyres: Record<string, { kpa: number | null; leak: boolean; low: boolean }> = {};
  for (const w of WHEELS) {
    const kpa = num(t, "tyre_p_" + w);
    const state = num(t, "tyre_p_state_" + w);
    tyres[w] = {
      kpa: kpa === null ? null : Math.round(kpa),
      leak: flag(t, "tyre_leak_" + w) === true,
      low: (kpa !== null && kpa < limits.tyreLowKpa) || (state !== null && state > 0),
    };
  }

  const warnings: Array<Record<string, unknown>> = [];
  for (const w of WHEELS) {
    const tyre = tyres[w]!;
    if (tyre.leak) warnings.push({ code: "tyre_leak", wheel: w, kpa: tyre.kpa, level: "crit" });
    else if (tyre.low) warnings.push({ code: "tyre_low", wheel: w, kpa: tyre.kpa, level: "warn" });
  }
  if (doorOpen) warnings.push({ code: "door_open", level: mode === "driving" ? "crit" : "warn" });
  const v12 = num(t, "volt_12v");
  if (v12 !== null && v12 > 5 && v12 < limits.v12Low) warnings.push({ code: "v12_low", volt: r1(v12), level: "warn" });
  if (locked === false && memo.unlockedSince !== undefined && mode === "parked" && !doorOpen) {
    const minutes = Math.floor((nowS - memo.unlockedSince) / 60);
    if (minutes >= limits.unlockedMin) warnings.push({ code: "unlocked", minutes, level: "warn" });
  }
  if (soc !== null && soc < limits.socLow && mode !== "charging") warnings.push({ code: "soc_low", soc: Math.trunc(soc), level: "warn" });
  if (chargeDone) warnings.push({ code: "charge_done", soc: soc === null ? null : Math.trunc(soc), level: "info" });

  const gear = parseValue(t["gear"]);
  const range = num(t, "ev_range_km");
  return {
    v: 1,
    mode,
    online: t["_online"] === "online",
    stale,
    age_s: age === null ? null : Math.trunc(age),
    drive: {
      speed: r1(num(t, "speed")),
      limit_warn: flag(t, "speed_limit_warning") === true && mode === "driving",
      gear: gear === null ? null : String(gear),
      power_kw: r1(power),
      cons50: r1(num(t, "consumption_50km")),
      trip_km: r1(num(t, "trip_km")),
      trip_kwh: r1(num(t, "trip_kwh")),
      turn_left: flag(t, "light_left_turn") === true,
      turn_right: flag(t, "light_right_turn") === true,
      hazard: flag(t, "light_hazard") === true,
      high_beam: flag(t, "light_high_beam") === true,
    },
    battery: {
      soc: soc === null ? null : Math.round(soc),
      range_km: range === null ? null : Math.trunc(range),
      soh: r1(num(t, "soh")),
      cell_t_min: r1(num(t, "cell_t_min")),
      cell_t_max: r1(num(t, "cell_t_max")),
      volt_12v: r1(v12),
    },
    charge: {
      active: charging,
      dc: charging ? flag(t, "is_dcfc") === true : false,
      kw: r1(chargeKw),
      eta_min: charging ? eta : null,
      kwh: charging ? r1(num(t, "charging_capacity_kwh")) : null,
      done: chargeDone,
    },
    body: {
      locked,
      lock_src: locked === null ? null : "car",
      door_open: doorOpen,
      ext_temp: r1(num(t, "ext_temp")),
      ac_on: flag(t, "ac_on"),
      setpoint: r1(num(t, "climate_setpoint")),
      klima_mode: null,
    },
    tyres,
    warnings,
  };
}

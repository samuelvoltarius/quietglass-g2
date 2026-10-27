/**
 * The car state as the glasses use it, parsed defensively from the bridge's
 * `/state` JSON (or from the demo, which produces the same JSON). Anything
 * missing or malformed becomes null instead of throwing: one odd field must
 * never blank the whole display. Panoptes serves many BYD models: a value a
 * model does not report stays null and is hidden, never shown as 0.
 *
 * Commands (0.7.0, Alfred 23.10.2026): `control` says which of lock / unlock /
 * preheat the bridge accepts (all off unless BYD_CONTROL=1), `command` is the
 * last command and its result. Every guard lives in the bridge; the app only
 * shows what the bridge reports and never treats anything as confirmed itself.
 */

export type Mode = "driving" | "charging" | "parked";
export type Wheel = "fl" | "fr" | "rl" | "rr";
export const WHEELS: readonly Wheel[] = ["fl", "fr", "rl", "rr"];
export type Level = "crit" | "warn" | "info";
/** The only commands there are: no climate off, no temperature (13.10.2026). */
export type Action = "lock" | "unlock" | "preheat";
export const ACTIONS: readonly Action[] = ["lock", "unlock", "preheat"];
/** sent -> confirmed | not_confirmed | error. Only fresh telemetry after the command confirms (bridge). */
export type CommandStatus = "sent" | "confirmed" | "not_confirmed" | "error";
const STATUSES: readonly CommandStatus[] = ["sent", "confirmed", "not_confirmed", "error"];

export interface CommandState {
  readonly id: string;
  readonly action: Action;
  /** Minutes for preheat, else null. */
  readonly value: number | null;
  readonly status: CommandStatus;
  readonly at: number;
}

export interface Control {
  /** BYD_CONTROL=1 on the bridge; false hides the control page. */
  readonly enabled: boolean;
  readonly lock: boolean;
  readonly unlock: boolean;
  readonly preheat: boolean;
  readonly preheatMinutes: readonly number[];
  /** A fresh power_level 0 right now (display only; the bridge checks every command again). */
  readonly carOff: boolean;
}

export const NO_CONTROL: Control = { enabled: false, lock: false, unlock: false, preheat: false, preheatMinutes: [], carOff: false };

export interface CarWarning {
  readonly code: string;
  readonly level: Level;
  readonly wheel: Wheel | null;
  readonly kpa: number | null;
  readonly volt: number | null;
  readonly minutes: number | null;
  readonly soc: number | null;
}

export interface Tyre {
  readonly kpa: number | null;
  readonly leak: boolean;
  readonly low: boolean;
  /** Tyre temperature in °C (Panoptes tyre_t_*), null when the model does not report it. */
  readonly temp: number | null;
}

export interface CarState {
  readonly rev: number;
  readonly at: number;
  readonly mode: Mode;
  readonly online: boolean;
  readonly stale: boolean;
  readonly ageS: number | null;
  readonly drive: {
    readonly speed: number | null;
    readonly limitWarn: boolean;
    readonly gear: string | null;
    readonly powerKw: number | null;
    readonly cons50: number | null;
    readonly tripKm: number | null;
    readonly tripKwh: number | null;
    readonly turnLeft: boolean;
    readonly turnRight: boolean;
    readonly hazard: boolean;
    readonly highBeam: boolean;
  };
  readonly battery: {
    readonly soc: number | null;
    readonly rangeKm: number | null;
    readonly soh: number | null;
    readonly cellTMin: number | null;
    readonly cellTMax: number | null;
    readonly volt12: number | null;
    /** Where soc/range come from: the car itself (Panoptes) or the BYD cloud while the car is silent. */
    readonly src: "car" | "cloud" | null;
    /** Age of the cloud values in minutes (null without cloud data). */
    readonly cloudAgeMin: number | null;
    readonly odometerKm: number | null;
  };
  /** The car's last known position (BYD cloud via the bridge); null when unknown. */
  readonly position: { readonly lat: number; readonly lon: number; readonly ageMin: number | null } | null;
  readonly charge: {
    readonly active: boolean;
    readonly dc: boolean;
    readonly kw: number | null;
    readonly etaMin: number | null;
    readonly kwh: number | null;
    readonly done: boolean;
  };
  readonly body: {
    readonly locked: boolean | null;
    readonly lockSrc: string | null;
    readonly doorOpen: boolean | null;
    readonly trunkOpen: boolean | null;
    readonly hoodOpen: boolean | null;
    readonly extTemp: number | null;
    /** Climate on/off. There is deliberately no temperature: the Dolphin Surf has no cabin sensor, and
     *  the climate setpoint (17-33, 25 = neutral) is not a temperature reading, so it is not shown. */
    readonly acOn: boolean | null;
    /** Fan level (Panoptes ac_fan / ac_wind). */
    readonly acFan: number | null;
  };
  readonly tyres: Readonly<Record<Wheel, Tyre>>;
  readonly warnings: readonly CarWarning[];
  readonly control: Control;
  readonly command: CommandState | null;
}

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const b = (v: unknown): boolean => v === true;
const nb = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null);
const s = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const isWheel = (v: unknown): v is Wheel => v === "fl" || v === "fr" || v === "rl" || v === "rr";
const LEVELS: readonly Level[] = ["crit", "warn", "info"];

export class StateError extends Error {
  constructor() {
    super("bad-state");
    this.name = "StateError";
  }
}

function parsePosition(raw: unknown): CarState["position"] {
  const p = obj(raw);
  const lat = n(p["lat"]), lon = n(p["lon"]);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, ageMin: n(p["age_min"]) };
}

export function parseState(raw: unknown): CarState {
  const r = obj(raw);
  const mode = r["mode"];
  if (mode !== "driving" && mode !== "charging" && mode !== "parked") throw new StateError();
  const d = obj(r["drive"]);
  const bat = obj(r["battery"]);
  const ch = obj(r["charge"]);
  const body = obj(r["body"]);
  const ty = obj(r["tyres"]);
  const tyres = {} as Record<Wheel, Tyre>;
  for (const w of WHEELS) {
    const t = obj(ty[w]);
    tyres[w] = { kpa: n(t["kpa"]), leak: b(t["leak"]), low: b(t["low"]), temp: n(t["temp"]) };
  }
  const warnings: CarWarning[] = (Array.isArray(r["warnings"]) ? r["warnings"] : [])
    .map(obj)
    .filter((w) => typeof w["code"] === "string")
    .map((w) => ({
      code: String(w["code"]),
      level: LEVELS.includes(w["level"] as Level) ? (w["level"] as Level) : "warn",
      wheel: isWheel(w["wheel"]) ? w["wheel"] : null,
      kpa: n(w["kpa"]),
      volt: n(w["volt"]),
      minutes: n(w["minutes"]),
      soc: n(w["soc"]),
    }));
  const ctl = obj(r["control"]);
  const enabled = ctl["enabled"] === true;
  const control: Control = enabled
    ? {
      enabled,
      lock: b(ctl["lock"]),
      unlock: b(ctl["unlock"]),
      preheat: b(ctl["preheat"]),
      preheatMinutes: (Array.isArray(ctl["preheat_minutes"]) ? ctl["preheat_minutes"] : [])
        .filter((m): m is number => typeof m === "number" && Number.isInteger(m) && m >= 10 && m <= 30),
      carOff: b(ctl["car_off"]),
    }
    : NO_CONTROL;
  const c = obj(r["command"]);
  const command: CommandState | null = ACTIONS.includes(c["action"] as Action) && typeof c["id"] === "string"
    ? {
      id: c["id"],
      action: c["action"] as Action,
      value: n(c["value"]),
      // Anything unknown counts as still open, never as confirmed.
      status: STATUSES.includes(c["status"] as CommandStatus) ? (c["status"] as CommandStatus) : "sent",
      at: n(c["at"]) ?? 0,
    }
    : null;
  return {
    rev: n(r["rev"]) ?? 0,
    at: n(r["at"]) ?? 0,
    mode,
    online: b(r["online"]),
    stale: r["stale"] !== false,
    ageS: n(r["age_s"]),
    drive: {
      speed: n(d["speed"]),
      limitWarn: b(d["limit_warn"]),
      gear: s(d["gear"]),
      powerKw: n(d["power_kw"]),
      cons50: n(d["cons50"]),
      tripKm: n(d["trip_km"]),
      tripKwh: n(d["trip_kwh"]),
      turnLeft: b(d["turn_left"]),
      turnRight: b(d["turn_right"]),
      hazard: b(d["hazard"]),
      highBeam: b(d["high_beam"]),
    },
    battery: {
      soc: n(bat["soc"]),
      rangeKm: n(bat["range_km"]),
      soh: n(bat["soh"]),
      cellTMin: n(bat["cell_t_min"]),
      cellTMax: n(bat["cell_t_max"]),
      volt12: n(bat["volt_12v"]),
      src: bat["src"] === "car" || bat["src"] === "cloud" ? bat["src"] : null,
      cloudAgeMin: n(bat["cloud_age_min"]),
      odometerKm: n(bat["odometer_km"]),
    },
    position: parsePosition(r["position"]),
    charge: {
      active: b(ch["active"]),
      dc: b(ch["dc"]),
      kw: n(ch["kw"]),
      etaMin: n(ch["eta_min"]),
      kwh: n(ch["kwh"]),
      done: b(ch["done"]),
    },
    body: {
      locked: nb(body["locked"]),
      lockSrc: s(body["lock_src"]),
      doorOpen: nb(body["door_open"]),
      trunkOpen: nb(body["trunk_open"]),
      hoodOpen: nb(body["hood_open"]),
      extTemp: n(body["ext_temp"]),
      acOn: nb(body["ac_on"]),
      acFan: n(body["ac_fan"]),
    },
    tyres,
    warnings,
    control,
    command,
  };
}

/** Stable identity of a warning: a new key pops the overlay up once. */
export function warningKey(w: CarWarning): string {
  return w.code + (w.wheel ? ":" + w.wheel : "");
}

/** Worst first: crit, warn, info. */
export function sortWarnings(list: readonly CarWarning[]): CarWarning[] {
  return [...list].sort((a, c) => LEVELS.indexOf(a.level) - LEVELS.indexOf(c.level));
}

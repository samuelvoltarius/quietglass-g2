/**
 * The car state as the glasses use it, parsed defensively from the bridge's
 * `/state` JSON (or from the demo, which produces the same JSON). Anything
 * missing or malformed becomes null instead of throwing: one odd field must
 * never blank the whole display.
 */

export type Mode = "driving" | "charging" | "parked";
export type Wheel = "fl" | "fr" | "rl" | "rr";
export const WHEELS: readonly Wheel[] = ["fl", "fr", "rl", "rr"];
export type Level = "crit" | "warn" | "info";
export type Action = "climate_on" | "climate_off" | "lock" | "unlock";
export const ACTIONS: readonly Action[] = ["climate_on", "climate_off", "lock", "unlock"];
export type CommandStatus = "sent" | "pending" | "ok" | "busy" | "error" | "timeout";

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
}

export interface CommandState {
  readonly id: string;
  readonly action: Action;
  readonly value: number | null;
  readonly status: CommandStatus;
  readonly text: string;
  readonly at: number;
  readonly note: string | null;
}

export interface CarState {
  readonly rev: number;
  readonly at: number;
  readonly mode: Mode;
  readonly online: boolean;
  readonly stale: boolean;
  readonly ageS: number | null;
  /** The car is switched on: the bridge refuses every command (fail-safe: only `true` counts). */
  readonly carOn: boolean;
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
    /** Where soc/range come from: the car itself (Overdrive) or the BYD cloud while the car is silent. */
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
    readonly extTemp: number | null;
    readonly acOn: boolean | null;
    readonly setpoint: number | null;
    readonly klimaMode: string | null;
  };
  readonly tyres: Readonly<Record<Wheel, Tyre>>;
  readonly warnings: readonly CarWarning[];
  readonly command: CommandState | null;
  readonly control: {
    readonly enabled: boolean;
    readonly lock: boolean;
    readonly unlock: boolean;
    readonly climateTemp: boolean;
  };
}

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const b = (v: unknown): boolean => v === true;
const nb = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null);
const s = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const isWheel = (v: unknown): v is Wheel => v === "fl" || v === "fr" || v === "rl" || v === "rr";
const LEVELS: readonly Level[] = ["crit", "warn", "info"];
const STATUSES: readonly CommandStatus[] = ["sent", "pending", "ok", "busy", "error", "timeout"];

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
  const ctl = obj(r["control"]);
  const tyres = {} as Record<Wheel, Tyre>;
  for (const w of WHEELS) {
    const t = obj(ty[w]);
    tyres[w] = { kpa: n(t["kpa"]), leak: b(t["leak"]), low: b(t["low"]) };
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
  const c = obj(r["command"]);
  const command: CommandState | null = ACTIONS.includes(c["action"] as Action) && typeof c["id"] === "string"
    ? {
      id: c["id"],
      action: c["action"] as Action,
      value: n(c["value"]),
      status: STATUSES.includes(c["status"] as CommandStatus) ? (c["status"] as CommandStatus) : "pending",
      text: typeof c["text"] === "string" ? c["text"] : "",
      at: n(c["at"]) ?? 0,
      note: s(c["note"]),
    }
    : null;
  return {
    rev: n(r["rev"]) ?? 0,
    at: n(r["at"]) ?? 0,
    mode,
    online: b(r["online"]),
    stale: r["stale"] !== false,
    ageS: n(r["age_s"]),
    carOn: b(r["car_on"]),
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
      extTemp: n(body["ext_temp"]),
      acOn: nb(body["ac_on"]),
      setpoint: n(body["setpoint"]),
      klimaMode: s(body["klima_mode"]),
    },
    tyres,
    warnings,
    command,
    control: {
      enabled: b(ctl["enabled"]),
      lock: b(ctl["lock"]),
      unlock: b(ctl["unlock"]),
      climateTemp: b(ctl["climate_temp"]),
    },
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

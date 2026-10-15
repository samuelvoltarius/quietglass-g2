/**
 * The status the Star Glass bridge sends (examples/star-bridge.mjs), read
 * defensively: every field may be missing or null, a newer bridge may add
 * fields, and nothing here may throw on odd input.
 */

export type SequenceState = "running" | "idle" | "finished" | "none";

export interface Sequence {
  readonly state: SequenceState;
  readonly target: string | null;
  readonly step: string | null;
  readonly frame: number | null;
  readonly frames: number | null;
}

export interface Exposure {
  readonly active: boolean;
  readonly total: number | null;
  readonly remaining: number | null;
  readonly progress: number | null;
}

export interface Camera {
  readonly connected: boolean;
  readonly name: string;
  readonly temp: number | null;
  readonly setpoint: number | null;
  readonly cooler: boolean;
  readonly power: number | null;
  readonly canCool: boolean;
  readonly atTarget: boolean;
}

export interface Mount {
  readonly connected: boolean;
  readonly tracking: boolean;
  readonly parked: boolean;
  readonly slewing: boolean;
  readonly alt: number | null;
  readonly az: number | null;
  readonly flipMinutes: number | null;
  readonly pier: string | null;
}

export interface Focuser {
  readonly connected: boolean;
  readonly position: number | null;
  readonly temp: number | null;
  readonly moving: boolean;
}

export interface Guider {
  readonly connected: boolean;
  readonly guiding: boolean | null;
  readonly rms: number | null;
  readonly ra: number | null;
  readonly dec: number | null;
}

export interface LastImage {
  readonly index: number;
  readonly at: string | null;
  readonly type: string | null;
  readonly filter: string | null;
  readonly exposure: number | null;
  readonly hfr: number | null;
  readonly stars: number | null;
  readonly target: string | null;
}

export interface NinaEvent {
  readonly name: string;
  readonly ageSeconds: number | null;
}

export interface History {
  readonly hfr: readonly number[];
  readonly temp: readonly number[];
  readonly rms: readonly number[];
}

/**
 * The weather station N.I.N.A. knows (ASCOM ObservingConditions through the
 * Advanced API), already in the units the glasses show: wind in km/h.
 * Null when no weather device is connected.
 */
export interface StationWeather {
  readonly name: string | null;
  /** Percent. */
  readonly cloudCover: number | null;
  /** mm/h; above zero means it rains. */
  readonly rainRate: number | null;
  readonly humidity: number | null;
  readonly dewPoint: number | null;
  readonly temperature: number | null;
  /** km/h. */
  readonly windSpeed: number | null;
  readonly windGust: number | null;
  /** mag/arcsec². */
  readonly skyQuality: number | null;
}

/** N.I.N.A.'s safety monitor: `safe` is null when connected but silent. */
export interface Safety {
  readonly connected: boolean;
  readonly safe: boolean | null;
}

/** The site from N.I.N.A. (rounded to 2 decimals by the bridge, only if it shares it). */
export interface Site {
  readonly latitude: number;
  readonly longitude: number;
}

export type StarStatus =
  | {
    readonly online: true;
    readonly version: string;
    readonly sequence: Sequence;
    readonly exposure: Exposure;
    readonly filter: string | null;
    readonly camera: Camera;
    readonly mount: Mount;
    readonly focuser: Focuser;
    readonly guider: Guider;
    readonly last: LastImage | null;
    readonly images: number;
    readonly history: History;
    readonly events: readonly NinaEvent[];
    /** Key of the bridge's current preview picture; null when there is none. */
    readonly preview: string | null;
    readonly controllable: boolean;
    readonly weather: StationWeather | null;
    readonly safety: Safety;
    readonly site: Site | null;
  }
  | { readonly online: false; readonly reason: string; readonly controllable: boolean };

export type OnlineStatus = Extract<StarStatus, { online: true }>;

/** Sequence commands the bridge may accept. */
export type Command = "stop" | "start";

type Raw = Record<string, unknown>;

const rec = (value: unknown): Raw => (value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {});
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const bool = (value: unknown): boolean => value === true;
const nums = (value: unknown, max = 60): number[] => (Array.isArray(value) ? value.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).slice(-max) : []);

function parseWeather(value: unknown): StationWeather | null {
  const w = rec(value);
  if (w["connected"] !== true) return null;
  const pct = (v: unknown): number | null => { const n = num(v); return n === null ? null : Math.max(0, Math.min(100, n)); };
  return {
    name: str(w["name"]),
    cloudCover: pct(w["cloudCover"]),
    rainRate: num(w["rainRate"]),
    humidity: pct(w["humidity"]),
    dewPoint: num(w["dewPoint"]),
    temperature: num(w["temperature"]),
    windSpeed: num(w["windSpeed"]),
    windGust: num(w["windGust"]),
    skyQuality: num(w["skyQuality"]),
  };
}

function parseSite(value: unknown): Site | null {
  const s = rec(value);
  const lat = num(s["lat"] ?? s["latitude"]);
  const lon = num(s["lon"] ?? s["longitude"]);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { latitude: Math.round(lat * 100) / 100, longitude: Math.round(lon * 100) / 100 };
}

const SEQUENCE_STATES: readonly SequenceState[] = ["running", "idle", "finished", "none"];

export function parseStatus(input: unknown): StarStatus {
  const raw = rec(input);
  const controllable = bool(raw["controllable"]);
  if (raw["online"] !== true) return { online: false, reason: str(raw["reason"]) ?? "unknown", controllable };

  const seq = rec(raw["sequence"]);
  const exp = rec(raw["exposure"]);
  const cam = rec(raw["camera"]);
  const mnt = rec(raw["mount"]);
  const foc = rec(raw["focuser"]);
  const gd = rec(raw["guider"]);
  const last = raw["last"] && typeof raw["last"] === "object" ? rec(raw["last"]) : null;
  const hist = rec(raw["history"]);
  const state = str(seq["state"]) as SequenceState | null;
  const progress = num(exp["progress"]);

  return {
    online: true,
    version: str(raw["version"]) ?? "",
    sequence: {
      state: state && SEQUENCE_STATES.includes(state) ? state : "none",
      target: str(seq["target"]),
      step: str(seq["step"]),
      frame: num(seq["frame"]),
      frames: num(seq["frames"]),
    },
    exposure: {
      active: bool(exp["active"]),
      total: num(exp["total"]),
      remaining: num(exp["remaining"]),
      progress: progress === null ? null : Math.max(0, Math.min(100, progress)),
    },
    filter: str(raw["filter"]),
    camera: {
      connected: bool(cam["connected"]),
      name: str(cam["name"]) ?? "",
      temp: num(cam["temp"]),
      setpoint: num(cam["setpoint"]),
      cooler: bool(cam["cooler"]),
      power: num(cam["power"]),
      canCool: bool(cam["canCool"]),
      atTarget: bool(cam["atTarget"]),
    },
    mount: {
      connected: bool(mnt["connected"]),
      tracking: bool(mnt["tracking"]),
      parked: bool(mnt["parked"]),
      slewing: bool(mnt["slewing"]),
      alt: num(mnt["alt"]),
      az: num(mnt["az"]),
      flipMinutes: num(mnt["flipMinutes"]),
      pier: str(mnt["pier"]),
    },
    focuser: { connected: bool(foc["connected"]), position: num(foc["position"]), temp: num(foc["temp"]), moving: bool(foc["moving"]) },
    guider: {
      connected: bool(gd["connected"]),
      guiding: typeof gd["guiding"] === "boolean" ? gd["guiding"] : null,
      rms: num(gd["rms"]),
      ra: num(gd["ra"]),
      dec: num(gd["dec"]),
    },
    last: last ? {
      index: num(last["index"]) ?? 0,
      at: str(last["at"]),
      type: str(last["type"]),
      filter: str(last["filter"]),
      exposure: num(last["exposure"]),
      hfr: num(last["hfr"]),
      stars: num(last["stars"]),
      target: str(last["target"]),
    } : null,
    images: num(raw["images"]) ?? 0,
    history: { hfr: nums(hist["hfr"]), temp: nums(hist["temp"]), rms: nums(hist["rms"]) },
    events: (Array.isArray(raw["events"]) ? raw["events"] : []).slice(-12).map((e) => ({ name: str(rec(e)["name"]) ?? "", ageSeconds: num(rec(e)["ageSeconds"]) })).filter((e) => e.name),
    preview: str(raw["preview"]),
    controllable,
    weather: parseWeather(raw["weather"]),
    safety: (() => {
      const sm = rec(raw["safety"]);
      return { connected: bool(sm["connected"]), safe: sm["connected"] === true && typeof sm["safe"] === "boolean" ? sm["safe"] : null };
    })(),
    site: parseSite(raw["site"]),
  };
}

/** Which sequence commands make sense now. */
export function availableCommands(status: StarStatus | null): Command[] {
  if (!status?.online || !status.controllable) return [];
  if (status.sequence.state === "running") return ["stop"];
  if (status.sequence.state === "idle") return ["start"];
  return [];
}

/** Seconds left of the running exposure, counted down locally from the last reading. */
export function remainingNow(status: StarStatus | null, ageSeconds: number): number | null {
  if (!status?.online || !status.exposure.active || status.exposure.remaining === null) return null;
  return Math.max(0, status.exposure.remaining - Math.max(0, ageSeconds));
}

/** Percent of the running exposure, counted forward locally. */
export function progressNow(status: StarStatus | null, ageSeconds: number): number | null {
  const left = remainingNow(status, ageSeconds);
  if (left === null || !status?.online || !status.exposure.total) return status?.online ? status.exposure.progress : null;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - left / status.exposure.total))));
}

/** "3:05" for seconds, "1 h 05" above an hour. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A number the way the language writes it (1,5 / 1.5). */
export function decimal(value: number, digits: number, locale: "de" | "en"): string {
  const text = value.toFixed(digits);
  return locale === "de" ? text.replace(".", ",") : text;
}

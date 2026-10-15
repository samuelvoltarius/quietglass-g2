/**
 * The printer status as the bridge reports it, validated, plus the rules for
 * which controls make sense in which state. Pure — no SDK, no network.
 */

export interface Temperature {
  readonly now: number;
  readonly target: number;
}

export type PrinterState = "printing" | "paused" | "complete" | "standby" | "cancelled" | "error" | "unknown";

export interface OnlineStatus {
  readonly online: true;
  readonly state: PrinterState;
  readonly file: string;
  /** 0–100. */
  readonly progress: number;
  readonly layer: number | null;
  readonly layers: number | null;
  readonly minutesLeft: number | null;
  readonly nozzle: Temperature | null;
  readonly bed: Temperature | null;
  /** Speed factor in percent. */
  readonly speed: number;
  readonly message: string;
  /** Nozzle height in mm (G-code position), when the bridge reports it. */
  readonly z: number | null;
  /** The active Spoolman spool, when Spoolman is set up. */
  readonly spool: Spool | null;
  /** The bridge allows pause/resume/cancel. */
  readonly controllable: boolean;
}

export interface Spool {
  readonly material: string;
  readonly vendor: string;
  readonly name: string;
  readonly grams: number | null;
  readonly meters: number | null;
}

export type OfflineReason = "searching" | "no-printer" | "printer-silent" | "unknown";

export interface OfflineStatus {
  readonly online: false;
  readonly reason: OfflineReason;
  /** Seconds until the bridge looks for the printer again. */
  readonly nextScanSeconds: number | null;
  readonly controllable: boolean;
}

export type PrinterStatus = OnlineStatus | OfflineStatus;

export type Command = "pause" | "resume" | "cancel";

const STATES: readonly PrinterState[] = ["printing", "paused", "complete", "standby", "cancelled", "error"];
const REASONS: readonly OfflineReason[] = ["searching", "no-printer", "printer-silent"];

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const number = (value: unknown, min: number, max: number): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").slice(0, max) : "");

function spool(value: unknown): Spool | null {
  if (!value || typeof value !== "object") return null;
  const v = record(value);
  const meters = typeof v["meters"] === "number" && Number.isFinite(v["meters"]) ? Math.max(0, Math.round(v["meters"] * 10) / 10) : null;
  const result = {
    material: text(v["material"], 20),
    vendor: text(v["vendor"], 24),
    name: text(v["name"], 32),
    grams: number(v["grams"], 0, 100_000),
    meters,
  };
  return result.material || result.vendor || result.name || result.grams !== null ? result : null;
}

function temperature(value: unknown): Temperature | null {
  const t = record(value);
  const now = number(t["now"], -50, 600);
  const target = number(t["target"], 0, 600);
  return now === null ? null : { now, target: target ?? 0 };
}

/** Validates a bridge reply; anything unreadable becomes an offline status. */
export function parseStatus(raw: unknown): PrinterStatus {
  const value = record(raw);
  const controllable = value["controllable"] === true;
  if (value["online"] !== true) {
    const reason = REASONS.includes(value["reason"] as OfflineReason) ? (value["reason"] as OfflineReason) : "unknown";
    return { online: false, reason, nextScanSeconds: number(value["nextScanSeconds"], 0, 86_400), controllable };
  }
  const state = STATES.includes(value["state"] as PrinterState) ? (value["state"] as PrinterState) : "unknown";
  return {
    online: true,
    state,
    file: text(value["file"], 120),
    progress: number(value["progress"], 0, 100) ?? 0,
    layer: number(value["layer"], 0, 1_000_000),
    layers: number(value["layers"], 0, 1_000_000),
    minutesLeft: number(value["minutesLeft"], 0, 100_000),
    nozzle: temperature(value["nozzle"]),
    bed: temperature(value["bed"]),
    speed: number(value["speed"], 0, 1000) ?? 100,
    message: text(value["message"], 120),
    z: typeof value["z"] === "number" && Number.isFinite(value["z"]) ? Math.max(0, Math.min(10_000, value["z"])) : null,
    spool: spool(value["spool"]),
    controllable,
  };
}

/** What may be offered right now. Cancel stays last, so a slip lands on something harmless first. */
export function availableCommands(status: PrinterStatus | null): Command[] {
  if (!status?.online || !status.controllable) return [];
  if (status.state === "printing") return ["pause", "cancel"];
  if (status.state === "paused") return ["resume", "cancel"];
  return [];
}

/** "1 h 05 min" / "42 min". */
export function duration(minutes: number | null): string {
  if (minutes === null) return "–";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** Local clock time when the print should finish: "23:40", or "Mo 08:15" when it is not today. */
export function finishClock(minutesLeft: number | null, now: number, locale: "de" | "en"): string | null {
  if (minutesLeft === null || !Number.isFinite(now)) return null;
  const end = new Date(now + minutesLeft * 60_000);
  const start = new Date(now);
  const time = String(end.getHours()).padStart(2, "0") + ":" + String(end.getMinutes()).padStart(2, "0");
  const sameDay = end.getFullYear() === start.getFullYear() && end.getMonth() === start.getMonth() && end.getDate() === start.getDate();
  if (sameDay) return time;
  const days = locale === "de" ? ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return days[end.getDay()] + " " + time;
}

/** "PLA · Prusament · 412 g" — the parts that are known. */
export function spoolLine(spool: Spool | null): string {
  if (!spool) return "";
  return [spool.material, spool.vendor, spool.grams === null ? "" : spool.grams + " g"].filter(Boolean).join(" · ");
}

/** A progress bar from glyphs the G2 is known to draw. */
export function progressBar(percent: number, width = 22): string {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  return "●".repeat(filled) + "○".repeat(width - filled);
}

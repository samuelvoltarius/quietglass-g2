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
  /** The bridge allows pause/resume/cancel. */
  readonly controllable: boolean;
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

/** A progress bar from glyphs the G2 is known to draw. */
export function progressBar(percent: number, width = 20): string {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  return "●".repeat(filled) + "○".repeat(width - filled);
}

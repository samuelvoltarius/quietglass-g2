/**
 * Glucose in the driving HUD (info only, never advice): the newest value of
 * the owner's own Nightscout-compatible server, read with a plain GET.
 *
 * Nothing here talks to a third party. Without `VITE_SUGAR_URL` the feature is
 * off: nothing is shown and no request is ever made.
 */

const env = (import.meta as { env?: Record<string, string | undefined> }).env;
const BUILD_SUGAR_URL: string | undefined = env?.VITE_SUGAR_URL;
const BUILD_SUGAR_TOKEN: string | undefined = env?.VITE_SUGAR_TOKEN;

/** The server address of this build (`VITE_SUGAR_URL`); empty = feature off. */
export function buildSugarUrl(raw: string | undefined = BUILD_SUGAR_URL): string {
  const url = (raw ?? "").trim().replace(/\/+$/, "");
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? url : "";
  } catch {
    return "";
  }
}

/** Optional Nightscout token of a private build (`VITE_SUGAR_TOKEN`); goes into the query like sugar-glass does, never a header (no preflight). */
export function buildSugarToken(raw: string | undefined = BUILD_SUGAR_TOKEN): string {
  return (raw ?? "").trim();
}

/** Poll interval while navigating by car. */
export const SUGAR_POLL_MS = 60_000;
/** Older than this the value is marked stale (`128?`, no arrow, no warning). */
export const SUGAR_STALE_MS = 15 * 60_000;
/** Older than this nothing is shown at all. */
export const SUGAR_HIDE_MS = 60 * 60_000;
/** Warning: below this and falling (mg/dl). */
export const SUGAR_LOW_MGDL = 80;
/** Warning: below this whatever the trend (mg/dl). */
export const SUGAR_CRITICAL_MGDL = 70;
const TIMEOUT_MS = 8_000;

/** Nightscout trend directions (entries `direction`). */
export type Direction =
  | "DoubleUp" | "SingleUp" | "FortyFiveUp" | "Flat" | "FortyFiveDown" | "SingleDown" | "DoubleDown" | "NONE";

const DIRECTIONS: readonly Direction[] = ["DoubleUp", "SingleUp", "FortyFiveUp", "Flat", "FortyFiveDown", "SingleDown", "DoubleDown"];
const FALLING: readonly Direction[] = ["FortyFiveDown", "SingleDown", "DoubleDown"];

export interface SugarReading {
  /** Milliseconds since the epoch. */
  readonly at: number;
  /** mg/dl. */
  readonly mgdl: number;
  readonly direction: Direction;
}

const num = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
};

export function toDirection(value: unknown): Direction {
  if (typeof value !== "string") return "NONE";
  return DIRECTIONS.find((d) => d.toLowerCase() === value.trim().toLowerCase()) ?? "NONE";
}

/** The sgv entries of a Nightscout answer, newest first; nonsense entries are skipped. */
export function parseSugarEntries(body: unknown): SugarReading[] {
  if (!Array.isArray(body)) return [];
  const out: SugarReading[] = [];
  for (const item of body) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    if (r["type"] !== undefined && r["type"] !== "sgv") continue;
    const mgdl = num(r["sgv"]);
    let at = num(r["date"]);
    if (at === null && typeof r["dateString"] === "string") {
      const parsed = Date.parse(r["dateString"]);
      at = Number.isFinite(parsed) ? parsed : null;
    }
    // Below 20 or above 600 are sensor error codes, not glucose.
    if (mgdl === null || at === null || at < 1e11 || mgdl < 20 || mgdl > 600) continue;
    out.push({ at, mgdl: Math.round(mgdl), direction: toDirection(r["direction"]) });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Glasses-safe trend arrow ("" when the trend is unknown or not computable). */
export function arrowOf(direction: Direction): string {
  switch (direction) {
    case "DoubleUp": return "↑↑";
    case "SingleUp": return "↑";
    case "FortyFiveUp": return "↗";
    case "Flat": return "→";
    case "FortyFiveDown": return "↘";
    case "SingleDown": return "↓";
    case "DoubleDown": return "↓↓";
    default: return "";
  }
}

export type SugarWarning = "lowFalling" | "low" | null;

export interface SugarDisplay {
  readonly mgdl: number;
  /** Arrow shown with the value; "" when stale or unknown. */
  readonly arrow: string;
  readonly stale: boolean;
  readonly warning: SugarWarning;
}

/**
 * What to show for the newest reading, or null for nothing (no reading, or
 * older than SUGAR_HIDE_MS). A stale value is marked and never warns: an old
 * number says nothing about now.
 */
export function sugarDisplay(reading: SugarReading | null, now: number): SugarDisplay | null {
  if (!reading) return null;
  const age = now - reading.at;
  if (age > SUGAR_HIDE_MS) return null;
  if (age > SUGAR_STALE_MS) return { mgdl: reading.mgdl, arrow: "", stale: true, warning: null };
  const falling = FALLING.includes(reading.direction);
  const warning: SugarWarning = reading.mgdl < SUGAR_CRITICAL_MGDL
    ? (falling ? "lowFalling" : "low")
    : reading.mgdl < SUGAR_LOW_MGDL && falling ? "lowFalling" : null;
  return { mgdl: reading.mgdl, arrow: arrowOf(reading.direction), stale: false, warning };
}

/** `128↗`, `128` (trend unknown) or `128?` (stale). */
export function sugarChip(display: SugarDisplay): string {
  return String(display.mgdl) + (display.stale ? "?" : display.arrow);
}

/** Newest reading of the server, or null on any failure (navigation carries on without it). */
export async function fetchSugar(
  base: string,
  token: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  timeoutMs = TIMEOUT_MS,
): Promise<SugarReading | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const params = new URLSearchParams({ count: "3" });
    if (token) params.set("token", token);
    const response = await fetchImpl(base.replace(/\/+$/, "") + "/api/v1/entries/sgv.json?" + params.toString(), { cache: "no-store", signal: controller.signal });
    if (!response.ok) return null;
    return parseSugarEntries(await response.json())[0] ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

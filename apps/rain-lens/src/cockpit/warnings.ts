/**
 * Official weather warnings for Austria from GeoSphere Austria (formerly
 * ZAMG), the public API behind warnungen.zamg.at:
 *
 *   GET https://warnungen.zamg.at/wsapp/api/getWarningsForCoords?lon=…&lat=…&lang=de
 *
 * Checked 2026-10-13: answers JSON with `Access-Control-Allow-Origin: *`
 * (no key, simple GET, no preflight); outside Austria it answers 404
 * "Could not find municipal for coords.". Each warning carries
 * `warntypid` (1 wind, 2 rain, 3 snow, 4 black ice, 5 thunderstorm, 6 heat,
 * 7 cold), `warnstufeid` (1 yellow, 2 orange, 3 red) and `rawinfo`
 * { wtype, wlevel, start, end } with start/end in Unix seconds.
 */

export const WARNINGS_ORIGIN = "https://warnungen.zamg.at";
export const WARNINGS_TIMEOUT_MS = 10_000;
/** Warnings that start later than this are not shown yet. */
export const WARNING_LOOKAHEAD_MS = 24 * 3_600_000;

export type WarningType = "wind" | "rain" | "snow" | "ice" | "thunder" | "heat" | "cold";
const TYPES: Readonly<Record<number, WarningType>> = { 1: "wind", 2: "rain", 3: "snow", 4: "ice", 5: "thunder", 6: "heat", 7: "cold" };

export interface Warning {
  readonly type: WarningType;
  /** 1 yellow, 2 orange, 3 red. */
  readonly level: 1 | 2 | 3;
  /** Epoch ms; NaN when the service sent none. */
  readonly start: number;
  readonly end: number;
}

export interface WarningsResult {
  /** "ok": the place is covered (maybe without warnings); "outside": not in Austria. */
  readonly status: "ok" | "outside";
  readonly warnings: readonly Warning[];
  /** The municipality GeoSphere matched, e.g. "Salzburg". */
  readonly place: string | null;
}

/** Rough box around Austria: outside it the service is not even asked. */
export function inAustria(latitude: number, longitude: number): boolean {
  return latitude >= 46.3 && latitude <= 49.1 && longitude >= 9.4 && longitude <= 17.2;
}

export function warningsUrl(latitude: number, longitude: number, locale: string): string {
  const lang = locale === "de" ? "de" : "en";
  return `${WARNINGS_ORIGIN}/wsapp/api/getWarningsForCoords?lon=${longitude.toFixed(4)}&lat=${latitude.toFixed(4)}&lang=${lang}`;
}

/** Seconds or ms (or a numeric string) → epoch ms; NaN otherwise. */
function toMs(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) return Number.NaN;
  return number < 1e12 ? number * 1000 : number;
}

/** The warnings of one answer; anything malformed is skipped, never thrown. */
export function parseWarnings(json: unknown): WarningsResult {
  const root = json as { type?: unknown; properties?: { warnings?: unknown; location?: { properties?: { name?: unknown } } } } | null;
  if (!root || root.type === "Error" || !root.properties) return { status: "outside", warnings: [], place: null };
  const name = root.properties.location?.properties?.name;
  const list = Array.isArray(root.properties.warnings) ? root.properties.warnings : [];
  const warnings: Warning[] = [];
  for (const item of list) {
    const props = (item as { properties?: Record<string, unknown> } | null)?.properties;
    if (!props) continue;
    const raw = (props.rawinfo ?? {}) as Record<string, unknown>;
    const type = TYPES[Number(raw.wtype ?? props.warntypid)];
    const level = Number(raw.wlevel ?? props.warnstufeid);
    if (!type || !(level === 1 || level === 2 || level === 3)) continue;
    warnings.push({ type, level, start: toMs(raw.start), end: toMs(raw.end) });
  }
  return { status: "ok", warnings, place: typeof name === "string" && name.trim() ? name.trim() : null };
}

/** The warning to show: in force now or starting within a day; the highest level, then the earliest. */
export function topWarning(warnings: readonly Warning[], now: number, lookahead = WARNING_LOOKAHEAD_MS): Warning | null {
  const relevant = warnings.filter((warning) => !(warning.end <= now) && !(warning.start > now + lookahead));
  relevant.sort((a, b) => b.level - a.level || (Number.isFinite(a.start) ? a.start : 0) - (Number.isFinite(b.start) ? b.start : 0));
  return relevant[0] ?? null;
}

export async function fetchWarnings(latitude: number, longitude: number, locale: string, fetchImpl: typeof fetch = fetch, timeoutMs = WARNINGS_TIMEOUT_MS): Promise<WarningsResult> {
  if (!inAustria(latitude, longitude)) return { status: "outside", warnings: [], place: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(warningsUrl(latitude, longitude, locale), { signal: controller.signal });
    if (response.status === 404) return { status: "outside", warnings: [], place: null };
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseWarnings(await response.json());
  } finally { clearTimeout(timer); }
}

export type Sport = "bike" | "run";
export const sports: readonly Sport[] = ["bike", "run"];
export interface Telemetry { readonly sport: Sport; readonly elapsedSeconds: number; readonly speedKph: number; readonly paceSecPerKm: number; readonly powerWatts: number; readonly heartRate: number; readonly cadence: number; readonly distanceKm: number; readonly source: string; readonly updatedAt: string; }
function number(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
const RUN_NAMES = new Set(["run", "running", "trail_running", "treadmill_running"]);
/** Case-insensitive; Garmin-style names ("Running") count as run, everything else as bike. */
export function parseSport(value: unknown): Sport { return typeof value === "string" && RUN_NAMES.has(value.trim().toLowerCase()) ? "run" : "bike"; }
export function parseTelemetry(value: unknown): Telemetry { const row = (value && typeof value === "object" ? value : {}) as Partial<Telemetry>; return { sport: parseSport(row.sport), elapsedSeconds: number(row.elapsedSeconds), speedKph: number(row.speedKph), paceSecPerKm: number(row.paceSecPerKm), powerWatts: number(row.powerWatts), heartRate: number(row.heartRate), cadence: number(row.cadence), distanceKm: number(row.distanceKm), source: typeof row.source === "string" ? row.source : "bridge", updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : new Date().toISOString() }; }
export function demoTelemetry(): Telemetry { return { sport: "bike", elapsedSeconds: 2540, speedKph: 31.4, paceSecPerKm: 115, powerWatts: 238, heartRate: 154, cadence: 91, distanceKm: 22.7, source: "demo", updatedAt: new Date().toISOString() }; }
export function pace(seconds: number): string { if (!Number.isFinite(seconds) || seconds <= 0) return "--:--"; const total = Math.round(seconds); const minutes = Math.floor(total / 60); return `${minutes}:${String(total % 60).padStart(2, "0")}`; }
export function elapsed(input: number): string { const seconds = Number.isFinite(input) ? Math.max(0, Math.floor(input)) : 0; const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); const rest = Math.floor(seconds % 60); return `${hours ? `${hours}:` : ""}${String(minutes).padStart(hours ? 2 : 1, "0")}:${String(rest).padStart(2, "0")}`; }
export interface FetchTelemetryOptions { readonly timeoutMs?: number; readonly fetchImpl?: typeof fetch; }
/** One poll of the bridge. Aborts after `timeoutMs` so a stalled bridge cannot pile up requests behind the 2 s poll. */
export async function fetchTelemetry(endpoint: string, options: FetchTelemetryOptions = {}): Promise<Telemetry> { const doFetch = options.fetchImpl ?? fetch; const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 4000); try { const response = await doFetch(endpoint, { signal: controller.signal }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return parseTelemetry(await response.json()); } catch (error) { if (controller.signal.aborted) throw new Error("timed out"); throw error; } finally { clearTimeout(timeout); } }
/** The sport the HUD shows: the rider's saved choice wins over what the bridge reports. */
export function effectiveSport(choice: string | null, reported: Sport): Sport { return choice === "run" || choice === "bike" ? choice : reported; }
/** Swipe cycles through the supported sports (bike ↔ run). */
export function nextSport(current: Sport, step = 1): Sport { const index = sports.indexOf(current); return sports[(index + step + sports.length * 2) % sports.length] ?? "bike"; }
/** Pace in s/km, derived from speed when the source only reports speed (a bike computer viewed in run mode). */
export function paceOf(data: Telemetry): number { return data.paceSecPerKm > 0 ? data.paceSecPerKm : data.speedKph > 0 ? 3600 / data.speedKph : 0; }
/** Speed in km/h, derived from pace when the source only reports pace. */
export function speedOf(data: Telemetry): number { return data.speedKph > 0 ? data.speedKph : data.paceSecPerKm > 0 ? 3600 / data.paceSecPerKm : 0; }
/** The watch posts about every second and the HUD polls every 2 s; older data is no longer shown as live. */
export const STALE_AFTER_MS = 10000;
/** Milliseconds since epoch, or null for a missing/unparseable timestamp. */
export function parseTimestamp(value: unknown): number | null { if (typeof value !== "string") return null; const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
export function ageLabel(ms: number): string { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`; }
/** Age label ("12s") when the data must be shown as stale — too old, or the last poll failed — otherwise null. A future timestamp (clock skew) counts as age 0. */
export function staleAge(updatedAt: number, now: number, failed: boolean, maxAgeMs = STALE_AFTER_MS): string | null { const age = Math.max(0, now - updatedAt); return failed || age > maxAgeMs ? ageLabel(age) : null; }

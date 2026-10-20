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
/** How the data stands: sample data, live, or stale (the watch stopped posting / the bridge stopped answering) with its age label. */
export type Mode = { readonly kind: "demo" } | { readonly kind: "live" } | { readonly kind: "stale"; readonly age: string };
export function modeOf(data: Telemetry, receivedAt: number, now: number, failed: boolean): Mode { if (data.source === "demo") return { kind: "demo" }; const age = staleAge(parseTimestamp(data.updatedAt) ?? receivedAt, now, failed); return age ? { kind: "stale", age } : { kind: "live" }; }
/** Heart-rate zone 1..5 from the share of the maximum heart rate (below 60 % = 1, from 90 % = 5); 0 without a reading. */
export const DEFAULT_MAX_HR = 190;
export function hrZone(heartRate: number, maxHr: number): number { if (!(heartRate > 0) || !(maxHr > 0)) return 0; const share = heartRate / maxHr; return share < 0.6 ? 1 : share < 0.7 ? 2 : share < 0.8 ? 3 : share < 0.9 ? 4 : 5; }
/** The average of the main value over the whole workout: km/h on the bike, s/km on foot; 0 before there is a distance and a time. */
export function averageOf(data: Telemetry, sport: Sport): number { if (!(data.distanceKm > 0) || !(data.elapsedSeconds > 0)) return 0; return sport === "run" ? data.elapsedSeconds / data.distanceKm : data.distanceKm / (data.elapsedSeconds / 3600); }
/**
 * The workout so far, kept in memory only (nothing is written): counters for the averages and one snapshot a minute for the
 * strip on the phone. A workout restarts it when the elapsed time runs backwards.
 */
export interface Snapshot { readonly at: number; readonly elapsedSeconds: number; readonly speedKph: number; readonly paceSecPerKm: number; readonly heartRate: number; readonly powerWatts: number }
export interface Session { readonly samples: number; readonly hrSum: number; readonly hrCount: number; readonly hrMax: number; readonly powerSum: number; readonly powerCount: number; readonly lastElapsed: number; readonly history: readonly Snapshot[] }
export const EMPTY_SESSION: Session = { samples: 0, hrSum: 0, hrCount: 0, hrMax: 0, powerSum: 0, powerCount: 0, lastElapsed: 0, history: [] };
const HISTORY_EVERY_MS = 60_000;
const HISTORY_KEEP = 60;
export function addSample(session: Session, data: Telemetry, now: number): Session { const base = data.elapsedSeconds + 30 < session.lastElapsed ? EMPTY_SESSION : session; const last = base.history[base.history.length - 1]; const snap = !last || now - last.at >= HISTORY_EVERY_MS ? [...base.history, { at: now, elapsedSeconds: data.elapsedSeconds, speedKph: data.speedKph, paceSecPerKm: data.paceSecPerKm, heartRate: data.heartRate, powerWatts: data.powerWatts }].slice(-HISTORY_KEEP) : base.history; return { samples: base.samples + 1, hrSum: base.hrSum + (data.heartRate > 0 ? data.heartRate : 0), hrCount: base.hrCount + (data.heartRate > 0 ? 1 : 0), hrMax: Math.max(base.hrMax, data.heartRate > 0 ? data.heartRate : 0), powerSum: base.powerSum + (data.powerWatts > 0 ? data.powerWatts : 0), powerCount: base.powerCount + (data.powerWatts > 0 ? 1 : 0), lastElapsed: data.elapsedSeconds, history: snap }; }
/** The sample workout of the first start (and of every start without a bridge): eight minutes, so the history is not empty. */
export function demoSession(now: number): Session { const history = Array.from({ length: 8 }, (_, index): Snapshot => ({ at: now - (8 - index) * HISTORY_EVERY_MS, elapsedSeconds: 2540 - (8 - index) * 60, speedKph: 29 + (index % 3) * 1.2, paceSecPerKm: 125 - (index % 3) * 4, heartRate: 142 + index * 2, powerWatts: 220 + (index % 4) * 9 })); return { samples: 8, hrSum: history.reduce((sum, snap) => sum + snap.heartRate, 0), hrCount: 8, hrMax: 158, powerSum: history.reduce((sum, snap) => sum + snap.powerWatts, 0), powerCount: 8, lastElapsed: 2540, history }; }
export const averageHr =(session: Session): number => (session.hrCount > 0 ? session.hrSum / session.hrCount : 0);
export const averagePower = (session: Session): number => (session.powerCount > 0 ? session.powerSum / session.powerCount : 0);

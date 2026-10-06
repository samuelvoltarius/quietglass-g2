/**
 * Time tracking.
 *
 * The design constraint is that this runs on glasses while your hands are
 * busy: starting, stopping and switching must each be a single gesture, and it
 * must be impossible to lose time by fumbling. Switching projects therefore
 * closes the open entry and opens the next one in the same move — there is no
 * state where the clock is running against nothing.
 */

export interface TimeEntry {
  readonly id: string;
  readonly project: string;
  readonly startedAt: number;
  readonly endedAt: number;
}

export interface ClockState {
  /** Project currently being tracked, or null when stopped. */
  readonly project: string | null;
  /** When the open entry began; null when stopped. */
  readonly startedAt: number | null;
}

export const STOPPED: ClockState = { project: null, startedAt: null };

/** Entries shorter than this are discarded as fumbles rather than recorded. */
export const MIN_ENTRY_SECONDS = 10;

export interface StartResult {
  readonly state: ClockState;
  /** An entry closed by this action, if any. */
  readonly closed: TimeEntry | null;
}

export function isRunning(state: ClockState): boolean {
  return state.project !== null && state.startedAt !== null;
}

/**
 * Starts tracking a project. If another project is open it is closed first, so
 * switching never leaves two entries running or a gap between them.
 */
export function startProject(
  state: ClockState,
  project: string,
  now: number,
  nextId: () => string,
): StartResult {
  const closed = closeEntry(state, now, nextId);
  return { state: { project, startedAt: now }, closed };
}

export function stop(state: ClockState, now: number, nextId: () => string): StartResult {
  return { state: STOPPED, closed: closeEntry(state, now, nextId) };
}

/** Closes the open entry, or returns null when nothing is open or it is too short. */
function closeEntry(state: ClockState, now: number, nextId: () => string): TimeEntry | null {
  if (state.project === null || state.startedAt === null) return null;
  const seconds = (now - state.startedAt) / 1000;
  if (seconds < MIN_ENTRY_SECONDS) return null;
  return { id: nextId(), project: state.project, startedAt: state.startedAt, endedAt: now };
}

/** Seconds on the open entry, or 0 when stopped. */
export function openSeconds(state: ClockState, now: number): number {
  if (state.startedAt === null) return 0;
  return Math.max(0, (now - state.startedAt) / 1000);
}

export function entrySeconds(entry: TimeEntry): number {
  return Math.max(0, Math.round((entry.endedAt - entry.startedAt) / 1000));
}

export function totalSeconds(entries: readonly TimeEntry[]): number {
  return entries.reduce((sum, e) => sum + entrySeconds(e), 0);
}

/**
 * Entries that touch a calendar day, including one that started the evening
 * before and ran past midnight.
 */
export function entriesOnDay(entries: readonly TimeEntry[], dayStart: number): TimeEntry[] {
  const dayEnd = nextDayStart(dayStart);
  return entries
    .filter((e) => e.startedAt < dayEnd && e.endedAt > dayStart)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Seconds recorded within one calendar day. A shift across midnight counts
 * each part on its own day, so "today" never includes yesterday's hours.
 */
export function secondsOnDay(entries: readonly TimeEntry[], dayStart: number): number {
  const dayEnd = nextDayStart(dayStart);
  let total = 0;
  for (const e of entries) total += overlapSeconds(e.startedAt, e.endedAt, dayStart, dayEnd);
  return total;
}

/** Seconds the open entry has run within the day containing `now`. */
export function openSecondsOnDay(state: ClockState, dayStart: number, now: number): number {
  if (state.startedAt === null) return 0;
  return overlapSeconds(state.startedAt, now, dayStart, nextDayStart(dayStart));
}

function overlapSeconds(start: number, end: number, from: number, to: number): number {
  return Math.max(0, Math.round((Math.min(end, to) - Math.max(start, from)) / 1000));
}

export function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** The following local midnight. A day is 23 or 25 hours when the clocks change. */
export function nextDayStart(dayStart: number): number {
  const date = new Date(dayStart);
  date.setDate(date.getDate() + 1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Time per project, largest first. */
export function totalsByProject(
  entries: readonly TimeEntry[],
): Array<{ project: string; seconds: number }> {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    totals.set(entry.project, (totals.get(entry.project) ?? 0) + entrySeconds(entry));
  }
  return [...totals.entries()]
    .map(([project, seconds]) => ({ project, seconds }))
    .sort((a, b) => b.seconds - a.seconds || a.project.localeCompare(b.project));
}

export function addEntry(
  entries: readonly TimeEntry[],
  entry: TimeEntry,
  keep = 2000,
): TimeEntry[] {
  return [...entries, entry].slice(-keep);
}

export function nextEntryId(entries: readonly TimeEntry[]): string {
  let n = entries.length + 1;
  const taken = new Set(entries.map((e) => e.id));
  while (taken.has("e" + n)) n++;
  return "e" + n;
}

/** `1:23` under an hour, `2:05:00` beyond it — readable at a glance either way. */
export function formatClock(totalSecs: number): string {
  const seconds = Math.max(0, Math.floor(totalSecs));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return hours > 0
    ? hours + ":" + pad(minutes) + ":" + pad(rest)
    : minutes + ":" + pad(rest);
}

/** Decimal hours, the unit invoices use. */
export function formatHours(totalSecs: number): string {
  return (Math.max(0, totalSecs) / 3600).toFixed(2);
}

/** CSV for a spreadsheet or an invoice. */
export function toCsv(entries: readonly TimeEntry[]): string {
  const rows = [["date", "project", "start", "end", "seconds", "hours"].join(",")];
  for (const entry of entries) {
    const start = new Date(entry.startedAt);
    rows.push([
      // The day the work belongs to is the local one; the ISO times stay UTC.
      localDate(start),
      csvField(entry.project),
      start.toISOString(),
      new Date(entry.endedAt).toISOString(),
      String(entrySeconds(entry)),
      formatHours(entrySeconds(entry)),
    ].join(","));
  }
  return rows.join("\n") + "\n";
}

/**
 * Quotes a field when it holds a separator, a quote or a line break, and
 * defuses spreadsheet formulas: a project name starting with `=`, `+`, `-` or
 * `@` would otherwise be evaluated when the export is opened.
 */
function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
  return /[",\r\n]/.test(safe) ? '"' + safe.split('"').join('""') + '"' : safe;
}

function localDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

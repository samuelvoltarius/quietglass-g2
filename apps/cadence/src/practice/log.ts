import type { Locale } from "../i18n";
import { t } from "../messages";
import { joinCsv, localDateTime, numberCell, textCell, type CsvFormat } from "../csv";
/**
 * Practice log.
 *
 * The metronome is the visible part; this is the part that is actually worth
 * keeping. A session records what was practised, at what tempo, for how long —
 * which is the thing players never write down and always want later.
 */

export interface PracticeSession {
  readonly id: string;
  /** What was practised. Chosen on the phone from the user's own list. */
  readonly item: string;
  readonly bpm: number;
  readonly startedAt: number;
  readonly endedAt: number;
}

export function durationSeconds(session: PracticeSession): number {
  return Math.max(0, Math.round((session.endedAt - session.startedAt) / 1000));
}

export function totalSeconds(sessions: readonly PracticeSession[]): number {
  return sessions.reduce((sum, s) => sum + durationSeconds(s), 0);
}

/** Sessions from the same calendar day as `now`, newest first. */
export function sessionsToday(
  sessions: readonly PracticeSession[],
  now: number,
): PracticeSession[] {
  const start = startOfDay(now);
  return sessions
    .filter((s) => s.startedAt >= start)
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** Total practice time per item, highest first. */
export function totalsByItem(
  sessions: readonly PracticeSession[],
): Array<{ item: string; seconds: number }> {
  const totals = new Map<string, number>();
  for (const session of sessions) {
    totals.set(session.item, (totals.get(session.item) ?? 0) + durationSeconds(session));
  }
  return [...totals.entries()]
    .map(([item, seconds]) => ({ item, seconds }))
    .sort((a, b) => b.seconds - a.seconds || a.item.localeCompare(b.item));
}

/** Fastest tempo reached per item — the number players actually chase. */
export function bestTempoByItem(
  sessions: readonly PracticeSession[],
): Array<{ item: string; bpm: number }> {
  const best = new Map<string, number>();
  for (const session of sessions) {
    // Sessions too short to count as practice would inflate the record.
    if (durationSeconds(session) < 30) continue;
    best.set(session.item, Math.max(best.get(session.item) ?? 0, session.bpm));
  }
  return [...best.entries()]
    .map(([item, bpm]) => ({ item, bpm }))
    .sort((a, b) => b.bpm - a.bpm || a.item.localeCompare(b.item));
}

export function addSession(
  sessions: readonly PracticeSession[],
  session: PracticeSession,
  keep = 500,
): PracticeSession[] {
  // Bounded so per-app storage cannot grow without limit.
  return [...sessions, session].slice(-keep);
}

export function nextSessionId(sessions: readonly PracticeSession[]): string {
  let n = sessions.length + 1;
  const taken = new Set(sessions.map((s) => s.id));
  while (taken.has("p" + n)) n++;
  return "p" + n;
}

export function formatDuration(totalSecs: number, locale: Locale = "en"): string {
  const seconds = Math.max(0, Math.round(totalSecs));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return t(locale, "u.hm", { h: hours, m: minutes });
  if (minutes > 0) return t(locale, "u.ms", { m: minutes, s: seconds % 60 });
  return t(locale, "u.s", { s: seconds });
}

/**
 * Exports the log as CSV for a spreadsheet, in one of two formats (see
 * src/csv.ts). `standard` is unchanged: `date,item,bpm,seconds` with the start
 * in ISO 8601 UTC. `excel-de` is for opening by double-click in German or
 * Austrian Excel: the start in local time as `07.10.2026 14:05`, the duration
 * also in minutes with a decimal comma, and the exact ISO time in a last column.
 */
export function toCsv(
  sessions: readonly PracticeSession[],
  format: CsvFormat = "standard",
  locale: Locale = "en",
): string {
  if (format === "standard") {
    return joinCsv([
      ["date", "item", "bpm", "seconds"],
      ...sessions.map((session) => [
        new Date(session.startedAt).toISOString(),
        textCell(session.item, format),
        numberCell(session.bpm, format),
        numberCell(durationSeconds(session), format),
      ]),
    ], format);
  }
  return joinCsv([
    t(locale, "x.csvHeader").split(";").map((name) => textCell(name, format)),
    ...sessions.map((session) => [
      localDateTime(session.startedAt),
      textCell(session.item, format),
      numberCell(session.bpm, format),
      numberCell(durationSeconds(session), format),
      numberCell(durationSeconds(session) / 60, format, 2),
      new Date(session.startedAt).toISOString(),
    ]),
  ], format);
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

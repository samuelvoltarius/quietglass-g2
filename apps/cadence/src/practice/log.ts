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

export function formatDuration(totalSecs: number): string {
  const seconds = Math.max(0, Math.round(totalSecs));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return hours + "h " + minutes + "m";
  if (minutes > 0) return minutes + "m " + (seconds % 60) + "s";
  return seconds + "s";
}

/** Exports the log as CSV for a spreadsheet. */
export function toCsv(sessions: readonly PracticeSession[]): string {
  const rows = [["date", "item", "bpm", "seconds"].join(",")];
  for (const session of sessions) {
    rows.push([
      new Date(session.startedAt).toISOString(),
      csvField(session.item),
      String(session.bpm),
      String(durationSeconds(session)),
    ].join(","));
  }
  return rows.join("\n") + "\n";
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? '"' + value.split('"').join('""') + '"' : value;
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

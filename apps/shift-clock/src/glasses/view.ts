import {
  formatClock, isRunning, openSeconds, openSecondsOnDay, secondsOnDay, startOfDay,
  type ClockState, type TimeEntry,
} from "../tracking/clock";
import type { Locale } from "../i18n";
import { defaultProject, t } from "../messages";

/**
 * What the glasses show.
 *
 * While the clock runs, the elapsed time is the whole point and gets the
 * display. The project name and the day's total sit around it. When stopped,
 * the app says what will happen on the next tap — never leaving the user
 * guessing whether time is being counted.
 */
export interface ClockView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

/** Rows the body container holds; more are pushed off the display. */
export const MAX_BODY_ROWS = 7;
/** Characters the header holds on one line in the G2's proportional font. */
export const HEADER_WIDTH = 46;
/** The body sits beside the pixel icon, so its lines are shorter. */
export const BODY_WIDTH = 38;

/** The footer is one full-width line, like the header. */
export const FOOTER_WIDTH = 46;

/**
 * Picker row that leaves the list without starting anything. A control
 * character cannot be typed into a project name, so it never collides.
 */
export const CANCEL = "\u0000cancel";

export interface ViewOptions {
  /** Highlighted project in the picker (or CANCEL), when the user is choosing. */
  readonly selecting?: string | null;
  readonly projects?: readonly string[];
  readonly locale?: Locale;
}

export function buildView(
  state: ClockState,
  entries: readonly TimeEntry[],
  options: ViewOptions = {},
  now = Date.now(),
): ClockView {
  const projects = options.projects ?? [];
  const locale = options.locale ?? "en";
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);

  // Never a dead end: one tap creates a project to track against.
  if (projects.length === 0 && !isRunning(state)) {
    const name = truncate(defaultProject(locale), 12);
    return {
      header: "ShiftClock",
      body: [L("g.none.1"), L("g.none.2", { name }), L("g.none.3")].map((row) => truncate(row, BODY_WIDTH)),
      footer: L("g.f.none"),
    };
  }

  // Choosing which project to start: the list replaces the clock, because
  // picking is the only thing that matters at that moment.
  if (options.selecting != null && !isRunning(state)) {
    return {
      header: L("g.h.picker"),
      body: pickerRows(projects, options.selecting, L("g.cancel")),
      footer: L("g.f.picker"),
    };
  }

  const today = startOfDay(now);
  const todaySeconds = secondsOnDay(entries, today);

  if (!isRunning(state)) {
    // With a single project the tap starts it directly; say which one.
    const only = projects.length === 1 ? projects[0] : undefined;
    return {
      header: "ShiftClock",
      body: only === undefined
        ? [L("g.stopped")]
        : [L("g.stopped"), truncate(L("g.project", { project: only }), BODY_WIDTH)],
      footer: L(only === undefined ? "g.f.stoppedMany" : "g.f.stoppedOne", { total: formatClock(todaySeconds) }),
    };
  }

  const running = openSeconds(state, now);
  return {
    header: truncate(state.project ?? "", HEADER_WIDTH),
    body: [formatClock(running)],
    // The day total includes the entry still running, so the number on screen
    // is what the day actually stands at — not what it stood at an hour ago.
    // Only today's part counts: a shift begun last night is split at midnight.
    footer: L("g.f.running", { total: formatClock(todaySeconds + openSecondsOnDay(state, today, now)) }),
  };
}

/**
 * The project picker: a window of at most seven rows that keeps the choice in
 * view. The last row leaves the picker without starting anything.
 */
function pickerRows(projects: readonly string[], selecting: string, cancelLabel: string): string[] {
  const choices = [...projects, CANCEL];
  const rows = choices.map((p) =>
    truncate((p === selecting ? "> " : "  ") + (p === CANCEL ? cancelLabel : p), BODY_WIDTH));
  if (rows.length <= MAX_BODY_ROWS) return rows;
  const index = Math.max(0, choices.indexOf(selecting));
  const start = Math.min(Math.max(0, index - Math.floor(MAX_BODY_ROWS / 2)), rows.length - MAX_BODY_ROWS);
  return rows.slice(start, start + MAX_BODY_ROWS);
}

export function truncate(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, Math.max(0, maxWidth - 1)).trimEnd() + "…";
}

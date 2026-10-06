import {
  formatClock, isRunning, openSeconds, openSecondsOnDay, secondsOnDay, startOfDay,
  type ClockState, type TimeEntry,
} from "../tracking/clock";

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

export interface ViewOptions {
  /** Highlighted project in the picker, when the user is choosing. */
  readonly selecting?: string | null;
  readonly projects?: readonly string[];
}

export function buildView(
  state: ClockState,
  entries: readonly TimeEntry[],
  options: ViewOptions = {},
  now = Date.now(),
): ClockView {
  const projects = options.projects ?? [];

  if (projects.length === 0) {
    return {
      header: "ShiftClock",
      body: ["No projects yet.", "Add one in the phone app."],
      footer: "",
    };
  }

  // Choosing which project to start: the list replaces the clock, because
  // picking is the only thing that matters at that moment.
  if (options.selecting != null && !isRunning(state)) {
    return {
      header: "Start which project?",
      body: pickerRows(projects, options.selecting),
      footer: "swipe = choose  ·  tap = start",
    };
  }

  const today = startOfDay(now);
  const todaySeconds = secondsOnDay(entries, today);

  if (!isRunning(state)) {
    return {
      header: "ShiftClock",
      body: ["stopped"],
      footer: "today " + formatClock(todaySeconds) + "  ·  tap = choose project",
    };
  }

  const running = openSeconds(state, now);
  return {
    header: truncate(state.project ?? "", HEADER_WIDTH),
    body: [formatClock(running)],
    // The day total includes the entry still running, so the number on screen
    // is what the day actually stands at — not what it stood at an hour ago.
    // Only today's part counts: a shift begun last night is split at midnight.
    footer: "today " + formatClock(todaySeconds + openSecondsOnDay(state, today, now)) + "  ·  tap = stop",
  };
}

/** The project picker: a window of at most seven rows that keeps the choice in view. */
function pickerRows(projects: readonly string[], selecting: string): string[] {
  const rows = projects.map((p) =>
    truncate((p === selecting ? "> " : "  ") + p, BODY_WIDTH));
  if (rows.length <= MAX_BODY_ROWS) return rows;
  const index = Math.max(0, projects.indexOf(selecting));
  const start = Math.min(Math.max(0, index - Math.floor(MAX_BODY_ROWS / 2)), rows.length - MAX_BODY_ROWS);
  return rows.slice(start, start + MAX_BODY_ROWS);
}

export function truncate(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, Math.max(0, maxWidth - 1)).trimEnd() + "…";
}

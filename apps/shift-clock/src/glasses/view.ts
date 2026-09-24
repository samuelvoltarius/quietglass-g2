import {
  entriesOnDay, formatClock, isRunning, openSeconds, startOfDay, totalSeconds,
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
      body: projects.map((p) => (p === options.selecting ? "> " + p : "  " + p)),
      footer: "swipe = choose  ·  tap = start",
    };
  }

  const todaySeconds = totalSeconds(entriesOnDay(entries, startOfDay(now)));

  if (!isRunning(state)) {
    return {
      header: "ShiftClock",
      body: ["stopped"],
      footer: "today " + formatClock(todaySeconds) + "  ·  tap = choose project",
    };
  }

  const running = openSeconds(state, now);
  return {
    header: state.project ?? "",
    body: [formatClock(running)],
    // The day total includes the entry still running, so the number on screen
    // is what the day actually stands at — not what it stood at an hour ago.
    footer: "today " + formatClock(todaySeconds + running) + "  ·  tap = stop",
  };
}

import {
  formatClock, isRunning, openSeconds, openSecondsOnDay, secondsOnDay, startOfDay,
  type ClockState, type TimeEntry,
} from "../tracking/clock";
import type { Locale } from "../i18n";
import { defaultProject, t } from "../messages";
import { dayBarState, type DayBarState } from "./daybar";
import { armedFooter, footer } from "./footer";

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
export const HEADER_WIDTH = 56;
/** The body sits beside the pixel icon, so its lines are shorter. */
export const BODY_WIDTH = 46;

/** The footer is one full-width line, like the header. */
export const FOOTER_WIDTH = 56;

/**
 * Picker row that leaves the list without starting anything. A control
 * character cannot be typed into a project name, so it never collides.
 */
export const CANCEL = "\u0000cancel";
/** Picker row that opens the help page (last entry; a control character, like CANCEL). Only without the side menu. */
export const HELP = "\u0000help";

/** A stop must be confirmed by a second tap within this time (QIS v1, section 2). */
export const ARM_MS = 4_000;

export interface ViewOptions {
  /** Highlighted project in the picker (or CANCEL), when the user is choosing. */
  readonly selecting?: string | null;
  readonly projects?: readonly string[];
  readonly locale?: Locale;
  /** Daily target in hours, shown as a body row and on the day bar. */
  readonly targetHours?: number | null;
  /** The running clock was tapped once: the next tap stops it. */
  readonly armed?: boolean;
  /** The help page is open. */
  readonly help?: boolean;
  /** No side menu: a hold opens the help (named in the footers) and the picker has a "Help" row. */
  readonly holdHelp?: boolean;
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
  const holdPart: { hold?: string } = options.holdHelp ? { hold: L("g.f.help") } : {};

  if (options.help) {
    return {
      header: L("g.h.help"),
      body: [1, 2, 3, 4, 5, 6].map((n) => L("g.help." + n)),
      footer: footer(locale, {}, "back"),
    };
  }

  // Armed stop: nothing has happened yet, and the screen says so.
  if (options.armed && isRunning(state)) {
    return {
      header: L("g.h.armed"),
      body: [truncate(L("g.project", { project: state.project ?? "" }), BODY_WIDTH), formatClock(openSeconds(state, now)), L("g.armed.1")],
      footer: armedFooter(locale, L("g.f.stop")),
    };
  }

  // Never a dead end: one tap creates a project to track against.
  if (projects.length === 0 && !isRunning(state)) {
    const name = truncate(defaultProject(locale), 12);
    return {
      header: L("g.h.none"),
      body: [L("g.none.1"), L("g.none.2", { name }), L("g.none.3")].map((row) => truncate(row, BODY_WIDTH)),
      footer: footer(locale, { tap: L("g.f.create"), ...holdPart }, "exit"),
    };
  }

  // Choosing which project to start: the list replaces the clock, because
  // picking is the only thing that matters at that moment.
  if (options.selecting != null && !isRunning(state)) {
    return {
      header: L("g.h.picker"),
      body: pickerRows(projects, options.selecting, L("g.cancel"), options.holdHelp ? L("g.helpRow") : null),
      footer: footer(locale, { tap: L("g.f.start"), swipe: L("g.f.choose") }, "back"),
    };
  }

  const today = startOfDay(now);
  const todaySeconds = secondsOnDay(entries, today);
  const target = targetRow(options.targetHours ?? null, todaySeconds + openSecondsOnDay(state, today, now), locale);

  if (!isRunning(state)) {
    // With a single project the tap starts it directly; say which one.
    const only = projects.length === 1 ? projects[0] : undefined;
    return {
      header: L("g.h.stopped"),
      body: [
        ...(only === undefined ? [L("g.stopped")] : [L("g.stopped"), truncate(L("g.project", { project: only }), BODY_WIDTH)]),
        L("g.today", { total: formatClock(todaySeconds) }),
        ...target,
      ],
      footer: footer(locale, { tap: L(only === undefined ? "g.f.chooseProject" : "g.f.start"), ...holdPart }, "exit"),
    };
  }

  const running = openSeconds(state, now);
  return {
    header: truncate(L("g.h.running", { project: state.project ?? "" }), HEADER_WIDTH),
    // The day total includes the entry still running, so the number on screen
    // is what the day actually stands at — not what it stood at an hour ago.
    // Only today's part counts: a shift begun last night is split at midnight.
    body: [formatClock(running), L("g.today", { total: formatClock(todaySeconds + openSecondsOnDay(state, today, now)) }), ...target],
    footer: footer(locale, { tap: L("g.f.stop"), ...holdPart }, "exit"),
  };
}

/**
 * What the day bar shows: today's recorded time, the part of the running
 * entry that falls on today, and the target. Quantized in `dayBarState`, so
 * the image only changes every five minutes of tracked time.
 */
export function dayBarFor(
  state: ClockState,
  entries: readonly TimeEntry[],
  targetHours: number | null,
  now = Date.now(),
): DayBarState {
  const today = startOfDay(now);
  return dayBarState(secondsOnDay(entries, today), openSecondsOnDay(state, today, now), isRunning(state), targetHours);
}

/** An empty row, then how far the target is — only when a target is set. */
function targetRow(targetHours: number | null, todaySeconds: number, locale: Locale): string[] {
  if (targetHours === null || targetHours <= 0) return [];
  const target = formatTargetHours(targetHours, locale);
  const left = targetHours * 3600 - todaySeconds;
  const row = left > 0
    ? t(locale, "g.target", { target, left: formatClock(left) })
    : t(locale, "g.targetReached", { target });
  return ["", truncate(row, BODY_WIDTH)];
}

/** "8", "7,5" / "7.5": hours as the language writes them, no trailing zeros. */
export function formatTargetHours(hours: number, locale: Locale): string {
  const text = String(Math.round(hours * 100) / 100);
  return locale === "de" ? text.replace(".", ",") : text;
}

/**
 * The project picker: a window of at most seven rows that keeps the choice in
 * view. The last rows leave the picker without starting anything; without the side menu the very last opens the help.
 */
function pickerRows(projects: readonly string[], selecting: string, cancelLabel: string, helpLabel: string | null): string[] {
  const choices = helpLabel === null ? [...projects, CANCEL] : [...projects, CANCEL, HELP];
  const label = (p: string): string => (p === CANCEL ? cancelLabel : p === HELP ? (helpLabel ?? "") : p);
  const rows = choices.map((p) => truncate((p === selecting ? "> " : "  ") + label(p), BODY_WIDTH));
  if (rows.length <= MAX_BODY_ROWS) return rows;
  const index = Math.max(0, choices.indexOf(selecting));
  const start = Math.min(Math.max(0, index - Math.floor(MAX_BODY_ROWS / 2)), rows.length - MAX_BODY_ROWS);
  return rows.slice(start, start + MAX_BODY_ROWS);
}

export function truncate(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, Math.max(0, maxWidth - 1)).trimEnd() + "…";
}

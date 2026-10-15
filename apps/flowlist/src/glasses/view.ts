import type { Checklist } from "../checklist/model";
import { currentStep, elapsedSeconds, isFinished, positionOf, progress, type RunState } from "../checklist/run";
import { indexOfStep, needsConfirmation, requiredSteps } from "../checklist/model";
import type { ProgressBarState } from "./progressbar";
import type { Locale } from "../i18n";
import type { Armed } from "../input/dispatch";
import { t } from "../messages";
import { armedFooter, footer } from "./footer";

/**
 * What the glasses show, as plain strings.
 *
 * The rule for this app: the current step must be readable without effort, so
 * it gets the whole middle of the display. Everything else — position,
 * progress, the next step — is support and stays small.
 */
export interface FlowView {
  readonly header: string;
  /** The current step, drawn big as a picture (stepimage.ts); the body only holds what supports it. */
  readonly headline: string;
  readonly body: readonly string[];
  readonly footer: string;
}

export interface ViewOptions {
  /** Show a dimmed preview of what comes next. */
  readonly showNext?: boolean;
  /** Show the detail text instead of the preview (long press). */
  readonly showDetail?: boolean;
  /** Characters per line before wrapping. */
  readonly lineWidth?: number;
  /** Language of the app's own words; checklist text is shown as written. */
  readonly locale?: Locale;
  /** Whether the big picture can show this text whole; when not, the body carries the full text too. */
  readonly headlineFits?: (text: string) => boolean;
  /** Skip or restart was asked for: the next single tap carries it out (QIS v1). */
  readonly armed?: Armed | null;
  /** The page carries the glasses' side menu (SIDE_MENU in main.ts). Off by default: swipe and hold do its work. */
  readonly sideMenu?: boolean;
  /** The help page is open. */
  readonly help?: boolean;
}

/** Name in the header: `FLOWLIST · state`. */
const APP = "FLOWLIST";

const DEFAULT_WIDTH = 56;

/**
 * The step itself is a picture across the top (96 px); the body container
 * below it holds four rows of support: the confirm banner, choices, detail or
 * the next step. Anything beyond is cut with an ellipsis.
 */
export const MAX_BODY_ROWS = 4;
/** Characters the header holds on one line in the G2's proportional font. */
export const HEADER_WIDTH = 56;
/**
 * The header text shares its row with the progress bar and keeps the left
 * half (288 px), about 22 characters. The position ("3/7") always survives;
 * a long section name gives way.
 */
export const HEADER_TEXT_WIDTH = 22;
/** The footer is one line, like the header. */
export const FOOTER_WIDTH = 56;
/** Most branch options shown at once; the list scrolls with the highlight. */
const MAX_CHOICE_ROWS = 4;

export function buildView(
  list: Checklist,
  state: RunState,
  options: ViewOptions = {},
  now = Date.now(),
): FlowView {
  const width = options.lineWidth ?? DEFAULT_WIDTH;
  const locale = options.locale ?? "en";

  if (options.help) return helpView(locale, width);

  // Never a dead end: say where a checklist comes from, and how to leave.
  if (list.steps.length === 0) {
    return {
      header: headerOf(t(locale, "g.s.empty")),
      headline: t(locale, "g.empty.1"),
      body: clampRows(wrap(t(locale, "g.empty.2"), width), MAX_BODY_ROWS, width),
      footer: footer(locale, { hold: t(locale, options.sideMenu === true ? "g.v.menu" : "g.v.help") }, "exit"),
    };
  }

  const sideMenu = options.sideMenu === true;
  if (isFinished(state)) return finishedView(list, state, now, width, locale, options.armed ?? null, sideMenu);

  const step = currentStep(list, state);
  if (!step) return finishedView(list, state, now, width, locale, options.armed ?? null, sideMenu);

  // A critical step states plainly that it wants a second tap. Never rely on
  // the user noticing a subtle marker for something that matters.
  const head = state.awaitingConfirm ? [truncate(t(locale, "g.confirm"), width)] : [];
  const rows = MAX_BODY_ROWS - head.length;
  // The picture shows the step whole when it can; otherwise the body repeats it in full.
  const fits = options.headlineFits ? options.headlineFits(step.text) : true;
  const text = fits ? [] : wrap(step.text, width);

  // Everything below the step text competes for the remaining rows. The step
  // text keeps at least two rows (one if that is all it needs).
  let extra: string[] = [];
  if (step.kind === "choice" && step.choices) {
    const labels = step.choices.map((choice, index) =>
      truncate((index === state.choiceIndex ? "> " : "  ") + choice.label, width));
    const room = Math.max(1, rows - Math.min(text.length, 2));
    extra = windowAround(labels, state.choiceIndex, Math.min(MAX_CHOICE_ROWS, room));
  } else if (options.showDetail && step.detail) {
    extra = wrap(step.detail, width);
  } else if (options.showNext) {
    const next = nextStepText(list, state);
    if (next) extra = [truncate(t(locale, "g.next", { text: next }), width)];
  }

  const shown = clampRows(text, Math.max(Math.min(text.length, 2), rows - extra.length), width);
  const body = [...head, ...shown, ...clampRows(extra, rows - shown.length, width)];

  const skipArmed = options.armed === "skip";
  const backArmed = options.armed === "back";
  const stateLabel = state.awaitingConfirm ? t(locale, "g.s.confirm")
    : skipArmed ? t(locale, "g.s.skip")
    : backArmed ? t(locale, "g.s.undo")
    : positionOf(list, state) + "/" + list.steps.length;
  return {
    header: headerOf(stateLabel),
    headline: step.text,
    body,
    footer: footerText(list, state, now, locale, options.armed ?? null, sideMenu),
  };
}

/** `FLOWLIST · state`, within the half of the row the progress bar leaves. */
function headerOf(label: string): string {
  return truncate(`${APP} · ${label}`, HEADER_TEXT_WIDTH);
}

/** The help page: the gestures in footer order (the picture line says what the app needs). */
function helpView(locale: Locale, width: number): FlowView {
  return {
    header: headerOf(t(locale, "g.s.help")),
    headline: t(locale, "g.h.needs"),
    body: (["g.h.tap", "g.h.swipe", "g.h.hold", "g.h.end"] as const).map((key) => truncate(t(locale, key), width)),
    footer: footer(locale, { tap: t(locale, "g.v.back") }, "back"),
  };
}

function finishedView(list: Checklist, state: RunState, now: number, width: number, locale: Locale, armed: Armed | null, sideMenu: boolean): FlowView {
  const restartArmed = armed === "restart";
  const backArmed = armed === "back";
  const p = progress(list, state);
  const body = [t(locale, "g.doneCount", { done: p.done, total: p.total })];
  if (p.skipped > 0) body.push(t(locale, "g.skipped", { skipped: p.skipped }));
  body.push(t(locale, "g.took", { time: formatDuration(elapsedSeconds(state, now)) }));
  body.push(t(locale, "g.otherList"));
  return {
    header: headerOf(t(locale, restartArmed ? "g.s.restart" : backArmed ? "g.s.undo" : "g.s.done")),
    headline: t(locale, "g.done"),
    body: clampRows(body.map((row) => truncate(row, width)), MAX_BODY_ROWS, width),
    footer: restartArmed
      ? armedFooter(locale, t(locale, "g.v.restart"))
      : backArmed
        ? armedFooter(locale, t(locale, "g.v.undo"))
        : sideMenu
          ? footer(locale, { tap: t(locale, "g.v.restart"), hold: t(locale, "g.v.menu") }, "exit")
          : footer(locale, { tap: t(locale, "g.v.restart"), swipe: t(locale, "g.v.back"), hold: t(locale, "g.v.help") }, "exit"),
  };
}

/**
 * What the progress bar shows: one segment per required step (the same
 * steps the "done of total" count uses), in list order, with critical steps
 * marked. Optional steps have no segment, as they never count as progress.
 */
export function progressBarFor(list: Checklist, state: RunState): ProgressBarState {
  return {
    segments: requiredSteps(list).map((step) => ({
      status: state.status[step.id] === "done" ? "done" : step.id === state.currentId ? "current" : "open",
      critical: needsConfirmation(step),
    })),
  };
}

/**
 * The gestures win the one footer line (QIS v1: Tippen, Wischen, Halten, 2×); the elapsed time stands
 * in front when it fits. A pending confirmation or skip shows the armed row instead.
 */
function footerText(list: Checklist, state: RunState, now: number, locale: Locale, armed: Armed | null, sideMenu: boolean): string {
  const step = currentStep(list, state);
  if (state.awaitingConfirm) return armedFooter(locale, t(locale, "g.v.confirm"));
  if (armed === "skip") return armedFooter(locale, t(locale, "g.v.skip"));
  if (armed === "back") return armedFooter(locale, t(locale, "g.v.undo"));

  const time = formatDuration(elapsedSeconds(state, now));
  // QIS v1.2 with a side menu: a swipe only moves the highlight on a question; help, info, back and skip are in the menu.
  // Without one: swipe asks back/skip, hold shows the step info (or opens the help).
  const hold = t(locale, sideMenu ? "g.v.menu" : step?.detail ? "g.v.info" : "g.v.help");
  if (step?.kind === "choice") return footer(locale, { tap: t(locale, "g.v.go"), swipe: t(locale, "g.v.choose"), hold }, "exit", time);
  if (sideMenu) return footer(locale, { tap: t(locale, "g.v.done"), hold }, "exit", time);
  const swipe = t(locale, step?.kind === "optional" ? "g.v.backSkip" : "g.v.back");
  return footer(locale, { tap: t(locale, "g.v.done"), swipe, hold }, "exit", time);
}

function nextStepText(list: Checklist, state: RunState): string | null {
  if (!state.currentId) return null;
  const index = indexOfStep(list, state.currentId);
  if (index === -1) return null;
  return list.steps[index + 1]?.text ?? null;
}

/**
 * Greedy word wrap. A word longer than the line is split rather than left to
 * overflow, so a pasted URL cannot run off the edge of the display.
 */
export function wrap(text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (maxWidth <= 0) return [text];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : current + " " + word;
    if (candidate.length <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current !== "") lines.push(current);
    current = word;
    while (current.length > maxWidth) {
      lines.push(current.slice(0, maxWidth));
      current = current.slice(maxWidth);
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** At most `max` rows; a cut is marked with an ellipsis on the last row kept. */
function clampRows(lines: readonly string[], max: number, width: number): string[] {
  if (max <= 0) return [];
  if (lines.length <= max) return [...lines];
  const kept = lines.slice(0, max);
  // Appending first forces truncate() to cut, so the row always ends in "…".
  kept[max - 1] = truncate((kept[max - 1] ?? "") + " …", width);
  return kept;
}

/** A run of `size` items that keeps `index` in view. */
function windowAround(items: readonly string[], index: number, size: number): string[] {
  if (items.length <= size) return [...items];
  const start = Math.min(Math.max(0, index - Math.floor(size / 2)), items.length - size);
  return items.slice(start, start + size);
}

export function truncate(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, Math.max(0, maxWidth - 1)).trimEnd() + "…";
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return minutes + ":" + String(seconds % 60).padStart(2, "0");
}

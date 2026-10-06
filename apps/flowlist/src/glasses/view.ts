import type { Checklist } from "../checklist/model";
import { currentStep, elapsedSeconds, isFinished, positionOf, progress, type RunState } from "../checklist/run";
import { indexOfStep } from "../checklist/model";
import type { Locale } from "../i18n";
import { t } from "../messages";

/**
 * What the glasses show, as plain strings.
 *
 * The rule for this app: the current step must be readable without effort, so
 * it gets the whole middle of the display. Everything else — position,
 * progress, the next step — is support and stays small.
 */
export interface FlowView {
  readonly header: string;
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
}

const DEFAULT_WIDTH = 46;

/**
 * The body container holds seven rows; anything beyond is pushed off the
 * bottom of the display rather than shrunk to fit.
 */
export const MAX_BODY_ROWS = 7;
/** Characters the header holds on one line in the G2's proportional font. */
export const HEADER_WIDTH = 46;
/** The footer is one line, like the header. */
export const FOOTER_WIDTH = 46;
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

  // Never a dead end: say where a checklist comes from, and how to leave.
  if (list.steps.length === 0) {
    return {
      header: truncate(list.title || "FlowList", HEADER_WIDTH),
      body: [...wrap(t(locale, "g.empty.1"), width), ...wrap(t(locale, "g.empty.2"), width)],
      footer: t(locale, "g.empty.footer"),
    };
  }

  if (isFinished(state)) return finishedView(list, state, now, width, locale);

  const step = currentStep(list, state);
  if (!step) return finishedView(list, state, now, width, locale);

  // A critical step states plainly that it wants a second tap. Never rely on
  // the user noticing a subtle marker for something that matters.
  const head = state.awaitingConfirm ? [truncate(t(locale, "g.confirm"), width)] : [];
  const rows = MAX_BODY_ROWS - head.length;
  const text = wrap(step.text, width);

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

  return {
    header: truncate(headerText(list, state, step.section), HEADER_WIDTH),
    body,
    footer: footerText(list, state, now, locale),
  };
}

function finishedView(list: Checklist, state: RunState, now: number, width: number, locale: Locale): FlowView {
  const p = progress(list, state);
  const body = [t(locale, "g.done"), t(locale, "g.doneCount", { done: p.done, total: p.total })];
  if (p.skipped > 0) body.push(t(locale, "g.skipped", { skipped: p.skipped }));
  body.push(t(locale, "g.took", { time: formatDuration(elapsedSeconds(state, now)) }));
  body.push("", t(locale, "g.otherList"));
  return {
    header: truncate(list.title || "FlowList", HEADER_WIDTH),
    body: clampRows(body.map((row) => truncate(row, width)), MAX_BODY_ROWS, width),
    footer: truncate(t(locale, "g.finished.footer"), FOOTER_WIDTH),
  };
}

function headerText(list: Checklist, state: RunState, section: string | undefined): string {
  const position = positionOf(list, state);
  const label = section || list.title || "FlowList";
  return label + "  " + position + "/" + list.steps.length;
}

/**
 * The gesture hint always wins the one footer line. Progress and time follow
 * when they fit; German hints are longer, so on a narrow line the percentage
 * goes first (the header already shows the position), then the time.
 */
function footerText(list: Checklist, state: RunState, now: number, locale: Locale): string {
  const step = currentStep(list, state);
  let hint: string;
  if (state.awaitingConfirm) hint = t(locale, "g.hint.confirm");
  else if (step?.kind === "choice") hint = t(locale, "g.hint.choice");
  else if (step?.kind === "optional") hint = t(locale, "g.hint.optional");
  else hint = t(locale, "g.hint.normal");

  const percent = Math.round(progress(list, state).fraction * 100) + "%";
  const time = formatDuration(elapsedSeconds(state, now));
  const candidates = [
    [hint, percent, time].join("  ·  "),
    [hint, percent, time].join(" · "),
    [hint, time].join(" · "),
  ];
  return candidates.find((line) => line.length <= FOOTER_WIDTH) ?? truncate(hint, FOOTER_WIDTH);
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

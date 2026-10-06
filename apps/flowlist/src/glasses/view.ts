import type { Checklist } from "../checklist/model";
import { currentStep, elapsedSeconds, isFinished, positionOf, progress, type RunState } from "../checklist/run";
import { indexOfStep } from "../checklist/model";

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
}

const DEFAULT_WIDTH = 46;

/**
 * The body container holds seven rows; anything beyond is pushed off the
 * bottom of the display rather than shrunk to fit.
 */
export const MAX_BODY_ROWS = 7;
/** Characters the header holds on one line in the G2's proportional font. */
export const HEADER_WIDTH = 46;
/** Most branch options shown at once; the list scrolls with the highlight. */
const MAX_CHOICE_ROWS = 4;

export function buildView(
  list: Checklist,
  state: RunState,
  options: ViewOptions = {},
  now = Date.now(),
): FlowView {
  const width = options.lineWidth ?? DEFAULT_WIDTH;

  if (list.steps.length === 0) {
    return {
      header: truncate(list.title || "FlowList", HEADER_WIDTH),
      body: ["No checklist loaded.", "Add one in the phone app."],
      footer: "",
    };
  }

  if (isFinished(state)) return finishedView(list, state, now);

  const step = currentStep(list, state);
  if (!step) return finishedView(list, state, now);

  // A critical step states plainly that it wants a second tap. Never rely on
  // the user noticing a subtle marker for something that matters.
  const head = state.awaitingConfirm ? ["CONFIRM:"] : [];
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
    if (next) extra = ["next: " + truncate(next, Math.max(1, width - 6))];
  }

  const shown = clampRows(text, Math.max(Math.min(text.length, 2), rows - extra.length), width);
  const body = [...head, ...shown, ...clampRows(extra, rows - shown.length, width)];

  return {
    header: truncate(headerText(list, state, step.section), HEADER_WIDTH),
    body,
    footer: footerText(list, state, now),
  };
}

function finishedView(list: Checklist, state: RunState, now: number): FlowView {
  const p = progress(list, state);
  const body = ["Complete.", p.done + " of " + p.total + " done"];
  if (p.skipped > 0) body.push(p.skipped + " skipped");
  return {
    header: truncate(list.title || "FlowList", HEADER_WIDTH),
    body,
    footer: "took " + formatDuration(elapsedSeconds(state, now)) + "  ·  double tap = exit",
  };
}

function headerText(list: Checklist, state: RunState, section: string | undefined): string {
  const position = positionOf(list, state);
  const label = section || list.title || "FlowList";
  return label + "  " + position + "/" + list.steps.length;
}

function footerText(list: Checklist, state: RunState, now: number): string {
  const step = currentStep(list, state);
  const parts: string[] = [];

  if (state.awaitingConfirm) parts.push("tap again = confirm");
  else if (step?.kind === "choice") parts.push("swipe = choose · tap = go");
  else if (step?.kind === "optional") parts.push("tap = done · swipe down = skip");
  else parts.push("tap = done");

  parts.push(Math.round(progress(list, state).fraction * 100) + "%");
  parts.push(formatDuration(elapsedSeconds(state, now)));
  return parts.join("  ·  ");
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

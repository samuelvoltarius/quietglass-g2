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

export function buildView(
  list: Checklist,
  state: RunState,
  options: ViewOptions = {},
  now = Date.now(),
): FlowView {
  const width = options.lineWidth ?? DEFAULT_WIDTH;

  if (list.steps.length === 0) {
    return {
      header: list.title || "FlowList",
      body: ["No checklist loaded.", "Add one in the phone app."],
      footer: "",
    };
  }

  if (isFinished(state)) return finishedView(list, state, now);

  const step = currentStep(list, state);
  if (!step) return finishedView(list, state, now);

  const body: string[] = [];

  // A critical step states plainly that it wants a second tap. Never rely on
  // the user noticing a subtle marker for something that matters.
  if (state.awaitingConfirm) {
    body.push("CONFIRM:");
    body.push(...wrap(step.text, width));
  } else {
    body.push(...wrap(step.text, width));
  }

  if (step.kind === "choice" && step.choices) {
    step.choices.forEach((choice, index) => {
      body.push((index === state.choiceIndex ? "> " : "  ") + choice.label);
    });
  } else if (options.showDetail && step.detail) {
    body.push(...wrap(step.detail, width));
  } else if (options.showNext) {
    const next = nextStepText(list, state);
    if (next) body.push("next: " + truncate(next, width));
  }

  return {
    header: headerText(list, state, step.section),
    body,
    footer: footerText(list, state, now),
  };
}

function finishedView(list: Checklist, state: RunState, now: number): FlowView {
  const p = progress(list, state);
  const body = ["Complete.", p.done + " of " + p.total + " done"];
  if (p.skipped > 0) body.push(p.skipped + " skipped");
  return {
    header: list.title || "FlowList",
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
    } else {
      if (current !== "") lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
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

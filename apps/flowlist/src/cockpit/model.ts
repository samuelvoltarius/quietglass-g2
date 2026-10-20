import type { Locale } from "../i18n";
import { t } from "../messages";
import { requiredSteps, type Checklist, type Step } from "../checklist/model";
import { currentStep, isFinished, positionOf, type RunState } from "../checklist/run";
import { footer } from "../glasses/footer";

/**
 * What the cockpit shows, in words and numbers, decided without drawing
 * (QUS v1): the headline, the label/value cells, the progress ring for the
 * left half, the caption and the hint line. compose.ts only lays this out.
 *
 * Nothing here changes by itself with the clock: every figure moves only when
 * the run moves, so the clock alone redraws just the top right tile.
 */

export type Tone = "ok" | "warn" | "critical" | "offline";

export interface CockpitCell {
  readonly label: string;
  readonly value: string;
  /** Drawn with a frame round it (something needs attention here). */
  readonly alert?: boolean;
}

/** One bar of the left half: a reading against 0..100 % (the shared composer can draw these; FlowList uses the ring). */
export interface CockpitBar {
  readonly label: string;
  readonly value: number | null;
  readonly text: string;
  readonly tone: Tone;
}

export type CockpitGraphic =
  /** A ring of one arc per step (or per group of steps); the centre says how many are done. */
  | { readonly kind: "ring"; readonly segments: readonly Tone[]; readonly center: string; readonly sub: string }
  | { readonly kind: "bars"; readonly bars: readonly CockpitBar[] };

export interface CockpitModel {
  readonly title: string;
  readonly clock: string;
  /** One line, already upper case. */
  readonly headline: readonly string[];
  readonly cells: readonly CockpitCell[];
  readonly graphic: CockpitGraphic;
  /** Left bottom: which list this is. */
  readonly caption: string;
  /** The one footer line with the gestures. */
  readonly hint: string;
  readonly tone: Tone;
}

export interface CockpitInput {
  readonly list: Checklist;
  readonly state: RunState;
  readonly now: number;
  readonly locale: Locale;
}

/** "HH:MM" of an epoch ms in the phone's time (24 h). */
export function hhmm(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const DASH = "–";
/** More arcs than this are merged into groups, so the ring stays readable. */
export const MAX_ARCS = 24;

export interface Counts {
  /** Required steps (the denominator everywhere). */
  readonly total: number;
  /** Required steps done. */
  readonly done: number;
  /** Required steps still to do; 0 once the run is finished. */
  readonly open: number;
  readonly skipped: number;
  /** Optional steps not yet done or skipped. */
  readonly optionalLeft: number;
  /** Important (critical) steps not yet done. */
  readonly criticalLeft: number;
  readonly finished: boolean;
}

export function counts(list: Checklist, state: RunState): Counts {
  const required = requiredSteps(list);
  const done = required.filter((step) => state.status[step.id] === "done").length;
  const finished = list.steps.length > 0 && isFinished(state);
  const pending = (step: Step): boolean => state.status[step.id] !== "done" && state.status[step.id] !== "skipped";
  return {
    total: required.length,
    done,
    open: finished ? 0 : required.length - done,
    skipped: list.steps.filter((step) => state.status[step.id] === "skipped").length,
    optionalLeft: finished ? 0 : list.steps.filter((step) => step.kind === "optional" && pending(step)).length,
    criticalLeft: finished ? 0 : list.steps.filter((step) => step.kind === "critical" && pending(step)).length,
    finished,
  };
}

/** The one statement of a page: "3 OFFEN", "ALLES ERLEDIGT" or "KEINE LISTE". */
export function statusLines(list: Checklist, state: RunState, locale: Locale): string[] {
  if (list.steps.length === 0) return [t(locale, "g.cp.noList").toUpperCase()];
  const c = counts(list, state);
  if (c.finished || c.open === 0) return [t(locale, "g.cp.allDone").toUpperCase()];
  return [t(locale, "g.cp.open", { n: c.open }).toUpperCase()];
}

/** The text of the step after the current one (list order), or null. */
export function nextStepText(list: Checklist, state: RunState): string | null {
  if (!state.currentId) return null;
  const index = list.steps.findIndex((step) => step.id === state.currentId);
  return index === -1 ? null : (list.steps[index + 1]?.text ?? null);
}

/** The six cells: step, done, critical, optional, skipped, next. */
export function flowCells(list: Checklist, state: RunState, locale: Locale): CockpitCell[] {
  if (list.steps.length === 0) {
    return ["g.cp.step", "g.cp.done", "g.cp.critical", "g.cp.optional", "g.cp.skipped", "g.cp.next"].map((key) => ({ label: t(locale, key), value: DASH }));
  }
  const c = counts(list, state);
  const position = c.finished ? list.steps.length : positionOf(list, state);
  const next = c.finished ? null : nextStepText(list, state);
  return [
    { label: t(locale, "g.cp.step"), value: `${position}/${list.steps.length}` },
    { label: t(locale, "g.cp.done"), value: String(c.done) },
    { label: t(locale, "g.cp.critical"), value: String(c.criticalLeft), ...(c.criticalLeft > 0 ? { alert: true } : {}) },
    { label: t(locale, "g.cp.optional"), value: String(c.optionalLeft) },
    { label: t(locale, "g.cp.skipped"), value: String(c.skipped) },
    { label: t(locale, "g.cp.next"), value: next ?? DASH },
  ];
}

/**
 * The arcs of the ring: one per required step - done = calm solid, the step
 * to do now = bright dashes, still ahead = faint dots. Long lists are merged
 * into at most MAX_ARCS groups (a group is done when all of it is).
 */
export function ringTones(list: Checklist, state: RunState): Tone[] {
  const steps = requiredSteps(list);
  const toneOf = (step: Step): Tone => (state.status[step.id] === "done" ? "ok" : step.id === state.currentId ? "warn" : "offline");
  if (steps.length <= MAX_ARCS) return steps.map(toneOf);
  const out: Tone[] = [];
  for (let group = 0; group < MAX_ARCS; group += 1) {
    const from = Math.floor((group * steps.length) / MAX_ARCS);
    const to = Math.floor(((group + 1) * steps.length) / MAX_ARCS);
    const tones = steps.slice(from, to).map(toneOf);
    out.push(tones.every((tone) => tone === "ok") ? "ok" : tones.includes("warn") ? "warn" : tones.includes("ok") ? "warn" : "offline");
  }
  return out;
}

/** The hint line: only the gestures that do something here. */
export function cockpitHint(locale: Locale): string {
  return footer(locale, { tap: t(locale, "g.v.run") }, "back");
}

export function cockpitModel(input: CockpitInput): CockpitModel {
  const { list, state, now, locale } = input;
  const empty = list.steps.length === 0;
  const c = counts(list, state);
  return {
    title: t(input.locale, "g.title"),
    clock: hhmm(now),
    headline: statusLines(list, state, locale),
    cells: flowCells(list, state, locale),
    graphic: { kind: "ring", segments: empty ? [] : ringTones(list, state), center: empty ? DASH : `${c.done}/${c.total}`, sub: t(locale, "g.cp.ringSub") },
    caption: empty ? t(locale, "g.cp.noListCaption") : list.title,
    hint: cockpitHint(locale),
    tone: empty ? "offline" : c.finished || c.open === 0 ? "ok" : c.criticalLeft > 0 ? "warn" : "ok",
  };
}

/** A key that changes exactly when what the cockpit would draw changes. */
export function modelKey(model: CockpitModel): string {
  return JSON.stringify([model.clock, model.headline, model.cells, model.graphic, model.caption, model.hint]);
}

/** The step the user is on, for callers that need its text (phone). */
export function currentText(list: Checklist, state: RunState): string | null {
  return currentStep(list, state)?.text ?? null;
}

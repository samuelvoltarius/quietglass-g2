import {
  indexOfStep,
  isSkippable,
  needsConfirmation,
  requiredSteps,
  stepById,
  type Checklist,
  type Step,
} from "./model";

/**
 * Running a checklist.
 *
 * The state is plain data and every transition is a pure function, so the whole
 * flow — including branching and critical-step confirmation — is testable
 * without the glasses.
 */

export type StepStatus = "pending" | "done" | "skipped";

export interface RunState {
  readonly listId: string;
  /** Null once the run is finished. */
  readonly currentId: string | null;
  readonly status: Readonly<Record<string, StepStatus>>;
  /** Visited step ids, newest last. Drives "back" across branches. */
  readonly history: readonly string[];
  /** A critical step asks once before it is accepted. */
  readonly awaitingConfirm: boolean;
  /** Highlighted option on a choice step. */
  readonly choiceIndex: number;
  readonly startedAt: number;
  readonly finishedAt: number | null;
}

export function startRun(list: Checklist, now = Date.now()): RunState {
  return {
    listId: list.id,
    currentId: list.steps[0]?.id ?? null,
    status: {},
    history: [],
    awaitingConfirm: false,
    choiceIndex: 0,
    startedAt: now,
    finishedAt: list.steps.length === 0 ? now : null,
  };
}

export function currentStep(list: Checklist, state: RunState): Step | null {
  if (!state.currentId) return null;
  return stepById(list, state.currentId) ?? null;
}

export function isFinished(state: RunState): boolean {
  return state.currentId === null;
}

/**
 * Advance past the current step, marking it `status`.
 *
 * A critical step must be confirmed first: the first completion arms
 * `awaitingConfirm`, the second actually advances. This is the only place in
 * FlowList where a step costs two taps, and only where getting it wrong matters.
 */
export function complete(
  list: Checklist,
  state: RunState,
  status: StepStatus = "done",
  now = Date.now(),
): RunState {
  const step = currentStep(list, state);
  if (!step) return state;

  if (status === "done" && needsConfirmation(step) && !state.awaitingConfirm) {
    return { ...state, awaitingConfirm: true };
  }

  const nextId = followingStepId(list, state, step);
  return {
    ...state,
    status: { ...state.status, [step.id]: status },
    history: [...state.history, step.id],
    currentId: nextId,
    awaitingConfirm: false,
    choiceIndex: 0,
    finishedAt: nextId === null ? now : null,
  };
}

/** Skips the current step. Only allowed on steps marked optional. */
export function skip(list: Checklist, state: RunState, now = Date.now()): RunState {
  const step = currentStep(list, state);
  if (!step || !isSkippable(step)) return state;
  return complete(list, state, "skipped", now);
}

/**
 * Returns to the previously visited step, clearing its recorded status so it
 * can be answered again. Uses the visit history rather than the list order,
 * so going back across a branch returns where the user actually came from.
 */
export function back(list: Checklist, state: RunState): RunState {
  if (state.awaitingConfirm) return { ...state, awaitingConfirm: false };

  const previousId = state.history[state.history.length - 1];
  if (previousId === undefined) return state;
  // The checklist may have been edited since the run started; a step that no
  // longer exists is dropped from the history rather than jumped to.
  if (!stepById(list, previousId)) {
    return back(list, { ...state, history: state.history.slice(0, -1) });
  }

  const status = { ...state.status };
  delete status[previousId];

  return {
    ...state,
    currentId: previousId,
    history: state.history.slice(0, -1),
    status,
    awaitingConfirm: false,
    choiceIndex: 0,
    finishedAt: null,
  };
}

/** Moves the highlight on a choice step. Wraps around. */
export function moveChoice(list: Checklist, state: RunState, delta: number): RunState {
  const step = currentStep(list, state);
  const choices = step?.choices ?? [];
  if (choices.length === 0) return state;

  const count = choices.length;
  const next = ((state.choiceIndex + delta) % count + count) % count;
  return next === state.choiceIndex ? state : { ...state, choiceIndex: next };
}

/** Where to go after `step`, honouring a selected branch. */
function followingStepId(list: Checklist, state: RunState, step: Step): string | null {
  if (step.choices && step.choices.length > 0) {
    const choice = step.choices[state.choiceIndex] ?? step.choices[0];
    if (choice?.goto) {
      // A dangling target must not strand the run; fall through in order.
      const exists = stepById(list, choice.goto);
      if (exists) return choice.goto;
    }
  }

  const index = indexOfStep(list, step.id);
  if (index === -1) return null;
  const next = list.steps[index + 1];
  return next ? next.id : null;
}

export interface Progress {
  readonly done: number;
  readonly skipped: number;
  /** Required steps only; optional ones do not inflate the denominator. */
  readonly total: number;
  readonly fraction: number;
}

export function progress(list: Checklist, state: RunState): Progress {
  const required = requiredSteps(list);
  let done = 0;
  let skipped = 0;

  for (const step of list.steps) {
    const status = state.status[step.id];
    if (status === "done") done++;
    else if (status === "skipped") skipped++;
  }

  const total = required.length;
  const countedDone = required.filter((s) => state.status[s.id] === "done").length;
  return {
    done,
    skipped,
    total,
    fraction: total === 0 ? 1 : countedDone / total,
  };
}

/** Position of the current step in the list, 1-based; 0 once finished. */
export function positionOf(list: Checklist, state: RunState): number {
  if (!state.currentId) return 0;
  return indexOfStep(list, state.currentId) + 1;
}

export function elapsedSeconds(state: RunState, now = Date.now()): number {
  const end = state.finishedAt ?? now;
  return Math.max(0, Math.round((end - state.startedAt) / 1000));
}

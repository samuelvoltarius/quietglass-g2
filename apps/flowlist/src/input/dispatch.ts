import type { Gesture } from "./gestures";
import type { Checklist } from "../checklist/model";
import { back, complete, currentStep, isFinished, moveChoice, skip, startRun, type RunState } from "../checklist/run";

/**
 * Gesture handling for the single run screen (Quietglass Interaction Standard, QIS v1).
 *
 * FlowList is used with both hands busy — cooking, wiring, packing. The design
 * rule is that the common action is always the same single tap, and that no
 * gesture can silently destroy progress: a swipe only moves (the highlight on a
 * question) and never changes the checklist. QIS v1.2: going a step back and
 * skipping a step live in the glasses' side menu; both, and starting a finished
 * list over, are armed first and carried out by a second single tap (or a second
 * click of the same menu item); a swipe, 2× or a pause cancels them.
 */

/** Something that needs a second tap before it happens. */
export type Armed = "skip" | "restart" | "back";

/** Side-menu items (ids as registered on the page). */
export const MENU = { help: 1, info: 2, back: 3, skip: 4 } as const;

export type Effect =
  | { readonly kind: "exit" }
  | { readonly kind: "help" }
  /** Sets or (null) clears the armed action. */
  | { readonly kind: "arm"; readonly action: Armed | null };

export interface DispatchResult {
  readonly state: RunState;
  readonly effects: readonly Effect[];
}

const NONE: readonly Effect[] = [];
const DISARM: readonly Effect[] = [{ kind: "arm", action: null }];

/**
 * `sideMenu` says whether the page carries the glasses' side menu (SIDE_MENU in main.ts). Without one (the
 * state of the real glasses, step log 15.10.2026) a swipe up arms "step back", a swipe down arms "skip" on an
 * optional step; one more tap carries the armed action out. The step's detail is always on the page. A hold
 * reaches the app only from the optional R1 ring (on the temple it opens the system menu, 21.10.2026): it opens
 * the help as an extra, which only repeats the phone's gesture table.
 */
export function dispatch(list: Checklist, state: RunState, gesture: Gesture, armed: Armed | null = null, sideMenu = false): DispatchResult {
  // Armed: one more single tap carries it out, anything else cancels it.
  if (armed !== null) {
    if (gesture === "click") {
      const next = armed === "restart" ? startRun(list) : armed === "back" ? back(list, state) : skip(list, state);
      return { state: next, effects: DISARM };
    }
    return { state, effects: DISARM };
  }

  const step = currentStep(list, state);

  switch (gesture) {
    // One tap completes the step — or picks the highlighted branch, or
    // confirms a critical step that already asked. On the summary at the end
    // it asks whether to start the same list again, so a finished run is never
    // a dead end and never lost by one stray tap.
    case "click":
      if (isFinished(state) && list.steps.length > 0) return { state, effects: [{ kind: "arm", action: "restart" }] };
      return { state: complete(list, state), effects: NONE };

    // A pending confirmation of a critical step is cancelled instead of leaving the app.
    case "doubleClick":
      if (state.awaitingConfirm) return { state: { ...state, awaitingConfirm: false }, effects: NONE };
      return { state, effects: [{ kind: "exit" }] };

    // On a choice step both swipes move the highlight, because choosing is
    // the only thing that makes sense there. Anywhere else a swipe moves
    // nothing and changes nothing (QIS v1.2); it only cancels a pending confirmation.
    case "scrollUp":
    case "scrollDown":
      if (state.awaitingConfirm) return { state: { ...state, awaitingConfirm: false }, effects: NONE };
      if (step?.kind === "choice") return { state: moveChoice(list, state, gesture === "scrollUp" ? -1 : 1), effects: NONE };
      if (sideMenu) return { state, effects: NONE };
      // No side menu: up asks to go a step back (nothing to undo at the first step), down asks to skip an optional step.
      if (gesture === "scrollUp") return state.history.length === 0 ? { state, effects: NONE } : { state, effects: [{ kind: "arm", action: "back" }] };
      if (step?.kind === "optional") return { state, effects: [{ kind: "arm", action: "skip" }] };
      return { state, effects: NONE };

    // R1-ring extra only (a temple hold never arrives): the help. Never named on the glasses, nothing depends on it.
    case "longPress":
      return sideMenu ? { state, effects: NONE } : { state, effects: [{ kind: "help" }] };

    default:
      return { state, effects: NONE };
  }
}

/**
 * A click in the glasses' side menu (QIS v1.2). Help only looks (info changes nothing: the detail is always shown); stepping back and skipping
 * change the run, so the first click arms them and a second click of the same item (or a single
 * tap, see `dispatch`) within the window carries them out.
 */
export function dispatchMenu(list: Checklist, state: RunState, item: number, armed: Armed | null = null): DispatchResult {
  const step = currentStep(list, state);
  switch (item) {
    case MENU.help:
      return { state, effects: [{ kind: "help" }] };
    case MENU.info:
      return { state, effects: armed === null ? NONE : DISARM };
    case MENU.back: {
      // Nothing to undo at the first step; a pending confirmation is cancelled by swipe or 2×.
      if (state.awaitingConfirm || state.history.length === 0) return { state, effects: armed === null ? NONE : DISARM };
      if (armed === "back") return { state: back(list, state), effects: DISARM };
      return { state, effects: [{ kind: "arm", action: "back" }] };
    }
    case MENU.skip: {
      if (state.awaitingConfirm || step?.kind !== "optional") return { state, effects: armed === null ? NONE : DISARM };
      if (armed === "skip") return { state: skip(list, state), effects: DISARM };
      return { state, effects: [{ kind: "arm", action: "skip" }] };
    }
    default:
      return { state, effects: armed === null ? NONE : DISARM };
  }
}

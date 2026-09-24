import type { Gesture } from "./gestures";
import type { Checklist } from "../checklist/model";
import { back, complete, currentStep, moveChoice, skip, type RunState } from "../checklist/run";

/**
 * Gesture handling for the single run screen.
 *
 * FlowList is used with both hands busy — cooking, wiring, packing. The design
 * rule is that the common action is always the same single tap, and that no
 * gesture can silently destroy progress.
 */

export type Effect =
  | { readonly kind: "exit" }
  | { readonly kind: "showDetail"; readonly on: boolean };

export interface DispatchResult {
  readonly state: RunState;
  readonly effects: readonly Effect[];
}

const NONE: readonly Effect[] = [];

export function dispatch(list: Checklist, state: RunState, gesture: Gesture): DispatchResult {
  const step = currentStep(list, state);

  switch (gesture) {
    // One tap completes the step — or picks the highlighted branch, or
    // confirms a critical step that already asked.
    case "click":
      return { state: complete(list, state), effects: NONE };

    case "doubleClick":
      return { state, effects: [{ kind: "exit" }] };

    // On a choice step both swipes move the highlight, because choosing is
    // the only thing that makes sense there.
    case "scrollUp":
      if (step?.kind === "choice") return { state: moveChoice(list, state, -1), effects: NONE };
      return { state: back(list, state), effects: NONE };

    case "scrollDown":
      if (step?.kind === "choice") return { state: moveChoice(list, state, 1), effects: NONE };
      return { state: skip(list, state), effects: NONE };

    // Hold to read the detail, release to hide it again. Nothing is committed
    // by holding, so it is safe to explore mid-task.
    case "longPress":
      return { state, effects: [{ kind: "showDetail", on: true }] };

    case "longPressRelease":
      return { state, effects: [{ kind: "showDetail", on: false }] };

    default:
      return { state, effects: NONE };
  }
}

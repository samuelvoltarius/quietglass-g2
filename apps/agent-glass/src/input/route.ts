import type { AgentState } from "../terminal/types";
import type { Gesture } from "./gestures";

/**
 * What a gesture means right now, decided without side effects so the rules
 * can be tested. `main.ts` carries the actions out.
 */
export type GestureAction =
  | { readonly kind: "decide"; readonly decision: "allow" | "deny" }
  | { readonly kind: "open" }
  | { readonly kind: "back" }
  | { readonly kind: "retry" }
  | { readonly kind: "replay" }
  | { readonly kind: "interrupt" }
  | { readonly kind: "sessions" }
  | { readonly kind: "select"; readonly index: number }
  | { readonly kind: "exit" }
  | { readonly kind: "ignore" };

export interface GestureContext {
  readonly screen: "agent" | "sessions";
  readonly state: AgentState;
  readonly selected: number;
  readonly sessionCount: number;
  /** Whether the backend can answer permission requests at all. */
  readonly decisions: boolean;
  readonly demo: boolean;
}

const IGNORE: GestureAction = { kind: "ignore" };

/** Whether the permission screen is what the glasses are showing. */
export function decisionOnScreen(screen: "agent" | "sessions", state: AgentState): boolean {
  // The error view takes precedence over the decision view in `buildView`, so
  // a request hidden behind an error must not be answerable by a blind swipe.
  return screen === "agent" && !state.error && state.pending?.kind === "permission";
}

export function routeGesture(gesture: Gesture, context: GestureContext): GestureAction {
  const { screen, state } = context;
  if (context.demo && gesture !== "doubleClick") return IGNORE;

  // While a decision is pending the swipes mean allow and deny and nothing
  // else, so no other binding can steal them.
  if (screen === "agent" && state.pending && (gesture === "scrollUp" || gesture === "scrollDown")) {
    if (!decisionOnScreen(screen, state) || !state.controllable || !context.decisions) return IGNORE;
    return { kind: "decide", decision: gesture === "scrollUp" ? "allow" : "deny" };
  }

  switch (gesture) {
    case "click":
      if (screen === "sessions") return context.sessionCount > 0 ? { kind: "open" } : { kind: "back" };
      return state.error ? { kind: "retry" } : { kind: "replay" };

    case "longPress":
      if (screen === "agent" && state.busy && state.controllable && state.session) return { kind: "interrupt" };
      return { kind: "sessions" };

    case "scrollUp":
    case "scrollDown": {
      if (screen !== "sessions" || context.sessionCount === 0) return IGNORE;
      const step = gesture === "scrollUp" ? -1 : 1;
      const index = Math.min(context.sessionCount - 1, Math.max(0, context.selected + step));
      return { kind: "select", index };
    }

    case "doubleClick":
      return { kind: "exit" };

    default:
      return IGNORE;
  }
}

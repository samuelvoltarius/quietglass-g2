import type { AgentState } from "../terminal/types";
import { showsCockpit, type Armed, type ViewMode } from "../glasses/view";
import type { Gesture } from "./gestures";

/**
 * What a gesture means right now, decided without side effects so the rules
 * can be tested. `main.ts` carries the actions out.
 *
 * QIS v1 (docs/BEDIENSTANDARD.md): a swipe only moves, a tap on a risky entry
 * arms it, a second single tap within 4 s carries it out, and a swipe, a
 * double tap or the timeout cancels. Approvals are never a swipe direction.
 */
export type GestureAction =
  | { readonly kind: "decide"; readonly decision: "allow" | "deny" }
  /** Move the cursor in the answer list; also cancels an armed answer. */
  | { readonly kind: "choose"; readonly index: 0 | 1 }
  /** First tap (or hold) on a risky entry. */
  | { readonly kind: "arm"; readonly what: Armed }
  | { readonly kind: "disarm" }
  | { readonly kind: "open" }
  | { readonly kind: "back" }
  | { readonly kind: "closeHelp" }
  | { readonly kind: "retry" }
  | { readonly kind: "replay" }
  | { readonly kind: "interrupt" }
  | { readonly kind: "sessions" }
  | { readonly kind: "select"; readonly index: number }
  /** Show another screen of the current answer; 0 = the newest. */
  | { readonly kind: "page"; readonly page: number }
  /** Switch between the status cockpit and the answer text of the open session. */
  | { readonly kind: "mode"; readonly mode: ViewMode }
  | { readonly kind: "exit" }
  | { readonly kind: "ignore" };

export type ScreenName = "agent" | "sessions" | "help";

export interface GestureContext {
  readonly screen: ScreenName;
  readonly state: AgentState;
  readonly selected: number;
  readonly sessionCount: number;
  /** Whether the backend can answer permission requests at all. */
  readonly decisions: boolean;
  readonly demo: boolean;
  /** Screen of the answer on display, counted back from the newest (0). */
  readonly page?: number;
  /** How many screens the answer takes (1 = it fits). */
  readonly pages?: number;
  /** Cursor in the answer list: 0 = Erlauben, 1 = Ablehnen. */
  readonly choice?: 0 | 1;
  /** What a first tap has armed, if anything. */
  readonly armed?: Armed | null;
  /** Which page of the open session is up: the status cockpit or the answer text. Omitted = no cockpit logic. */
  readonly mode?: ViewMode;
}

const IGNORE: GestureAction = { kind: "ignore" };

/** Whether the permission screen is what the glasses are showing. */
export function decisionOnScreen(screen: ScreenName, state: AgentState): boolean {
  // The error view takes precedence over the decision view in `buildView`, so
  // a request hidden behind an error must not be answerable by a blind tap.
  return screen === "agent" && !state.error && state.pending?.kind === "permission";
}

export function routeGesture(gesture: Gesture, context: GestureContext): GestureAction {
  const { screen, state } = context;
  if (screen === "help") {
    return gesture === "click" || gesture === "doubleClick" ? { kind: "closeHelp" } : IGNORE;
  }
  const swiped = gesture === "scrollUp" || gesture === "scrollDown";
  if (context.mode !== undefined) {
    // The cockpit is the root of an open session: a swipe opens the answer text (a view only), 2x there goes back.
    if (showsCockpit(screen, state, context.mode) && swiped) return { kind: "mode", mode: "answer" };
    // An armed interrupt is cancelled by the 2x first (it stays on this page, QIS v1).
    if (context.mode === "answer" && screen === "agent" && state.session && !state.error && !state.pending && gesture === "doubleClick" && context.armed !== "interrupt") {
      return { kind: "mode", mode: "status" };
    }
  }
  if (context.demo && gesture !== "doubleClick") return IGNORE;

  const choice = context.choice ?? 0;
  const armed = context.armed ?? null;
  const swipe = gesture === "scrollUp" || gesture === "scrollDown";

  // The answer list: swipe moves the cursor, tap arms, a second tap sends.
  if (decisionOnScreen(screen, state) && state.controllable && context.decisions) {
    const wanted = choice === 0 ? "allow" : "deny";
    if (swipe) {
      const index = gesture === "scrollUp" ? Math.max(0, choice - 1) : Math.min(1, choice + 1);
      return { kind: "choose", index: index as 0 | 1 };
    }
    if (gesture === "click") return armed === wanted ? { kind: "decide", decision: wanted } : { kind: "arm", what: wanted };
    if (gesture === "doubleClick" && armed) return { kind: "disarm" };
  } else if (screen === "agent" && state.pending && swipe) {
    // A request that cannot be answered from here: nothing to move.
    return IGNORE;
  }

  // An armed interrupt: the next tap carries it out, anything else cancels.
  if (armed === "interrupt" && screen === "agent") {
    if (gesture === "click") return { kind: "interrupt" };
    if (swipe || gesture === "doubleClick") return { kind: "disarm" };
  }

  const page = context.page ?? 0;
  const pages = context.pages ?? 1;

  switch (gesture) {
    case "click":
      if (screen === "sessions") return context.sessionCount > 0 ? { kind: "open" } : { kind: "back" };
      if (state.error) return { kind: "retry" };
      // Reading back through an answer: a tap returns to the newest part.
      return page > 0 ? { kind: "page", page: 0 } : { kind: "replay" };

    case "longPress":
      // Hold never stops anything by itself: it arms the interrupt.
      if (screen === "agent" && state.busy && state.controllable && state.session) return { kind: "arm", what: "interrupt" };
      return { kind: "sessions" };

    case "scrollUp":
    case "scrollDown": {
      if (screen === "agent") {
        // Paging through a long answer. Up goes back in time, like the list.
        if (state.error || !state.session) return IGNORE;
        const next = gesture === "scrollUp" ? page + 1 : page - 1;
        if (next < 0 || next > pages - 1) return IGNORE;
        return { kind: "page", page: next };
      }
      if (context.sessionCount === 0) return IGNORE;
      const step = gesture === "scrollUp" ? -1 : 1;
      const index = Math.min(context.sessionCount - 1, Math.max(0, context.selected + step));
      return { kind: "select", index };
    }

    case "doubleClick":
      // 2× is "back" below the root and "exit" on it: the session list opened
      // from a running session goes back to that session.
      if (screen === "sessions" && state.session) return { kind: "back" };
      return { kind: "exit" };

    default:
      return IGNORE;
  }
}

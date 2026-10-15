import type { AgentState } from "../terminal/types";
import { iconBitmap, type Bitmap } from "./gfx";
import { mascotFrame, type Mood } from "./mascot";

/** The face sits in the top-right corner of the header; the header text gets 576 - 64. */
export const ICON_WIDTH = 64;
export const ICON_HEIGHT = 30;

/** Redraw at least this often while the face moves. */
export { MASCOT_STEP_MS } from "./mascot";

const LIST = ["##.#########", "............", "##.#########", "............", "##.#########"];

/** Error texts that mean "cannot reach the agent" rather than "the agent failed". */
const CONNECTION_LOST = /unreachable|timed out|no token|token rejected|stream|network|fetch/i;

/**
 * Whether the glasses have a working line to the agent. Without a token, with a
 * dropped stream or with a connection error the face falls asleep.
 */
export function isOffline(state: AgentState, hasToken: boolean, streamGap: boolean): boolean {
  return !hasToken || streamGap || (state.error !== null && CONNECTION_LOST.test(state.error));
}

/** How the agent feels right now. Pure: the same state always gives the same mood. */
export function agentMood(state: AgentState, offline: boolean): Mood {
  if (offline) return "asleep";
  if (state.pending) return "waiting";
  if (state.error) return "error";
  if (state.busy) return "working";
  return "idle";
}

/** The header picture for a screen, at a given time. */
export function headerIcon(screen: "agent" | "sessions" | "help", state: AgentState, offline: boolean, now: number): Bitmap {
  if (screen !== "agent") return iconBitmap(LIST, ICON_WIDTH, ICON_HEIGHT);
  return iconBitmap(mascotFrame(agentMood(state, offline), now), ICON_WIDTH, ICON_HEIGHT);
}

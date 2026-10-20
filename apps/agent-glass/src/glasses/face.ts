import type { AgentState } from "../terminal/types";
import type { Mood } from "./mascot";

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

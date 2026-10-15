/**
 * How the glasses ask the daemon for the next report.
 *
 * A 0.6.8+ daemon advertises `live.longPoll`: the glasses then keep one
 * request open (GET /report?since=<rev>&wait=25) and the daemon answers the
 * moment anything changes - an answer appears word by word instead of every
 * 1.5 s. Older daemons, the demo, or a path that breaks held requests fall
 * back to the plain polling of 0.6.7.
 *
 * Pure state, no timers: main.ts asks `planPoll` what to do next and reports
 * the outcome back.
 */
import type { HubReport, ReportCursor } from "./types";

/** Plain polling while idle, and while an agent works or a card waits (0.6.7 behaviour). */
export const POLL_IDLE_MS = 5000;
export const POLL_FAST_MS = 1500;
/** Shortest gap between two long-polls (guards against a daemon that answers instantly forever). */
export const LONG_GAP_MS = 60;
/** After a failed long-poll the next try is a plain report this soon. */
export const AFTER_LONG_FAIL_MS = 1000;
/** This many long-poll failures in a row (with plain reports working) switch long-poll off for a while. */
export const LONG_FAIL_LIMIT = 3;
export const LONG_OFF_MS = 5 * 60_000;
export const LONG_WAIT_S = 25;

export interface LivePollState {
  /** The last report advertised long-poll support. */
  readonly supported: boolean;
  readonly cursor: ReportCursor | null;
  readonly waitS: number;
  /** Long-poll failures in a row. */
  readonly fails: number;
  /** The previous long-poll failed: try a plain report next. */
  readonly lastFailed: boolean;
  /** Long-poll is off until then (epoch ms). */
  readonly offUntil: number;
}

export type PollPlan =
  | { readonly mode: "long"; readonly delayMs: number; readonly cursor: ReportCursor; readonly waitS: number }
  | { readonly mode: "plain"; readonly delayMs: number };

export function initialLivePoll(): LivePollState {
  return { supported: false, cursor: null, waitS: LONG_WAIT_S, fails: 0, lastFailed: false, offUntil: 0 };
}

/** A report arrived (plain or long): remember where it stands and whether the daemon can long-poll. */
export function noteReport(state: LivePollState, report: HubReport, viaLong: boolean): LivePollState {
  const supported = report.live?.longPoll === true && typeof report.rev === "number" && typeof report.boot === "string";
  const cursor = supported ? { rev: report.rev as number, boot: report.boot as string } : null;
  const waitS = Math.max(1, Math.min(LONG_WAIT_S, Math.round(report.live?.maxWaitS ?? LONG_WAIT_S)));
  return { ...state, supported, cursor, waitS, lastFailed: false, fails: viaLong ? 0 : state.fails };
}

/** A long-poll failed (network, timeout, HTTP error). */
export function noteLongFailure(state: LivePollState, now: number): LivePollState {
  const fails = state.fails + 1;
  if (fails >= LONG_FAIL_LIMIT) return { ...state, fails: 0, lastFailed: true, offUntil: now + LONG_OFF_MS };
  return { ...state, fails, lastFailed: true };
}

/**
 * The next request. `fast`: an agent works or a card waits (matters only for plain polling;
 * a long-poll is answered at once on every change anyway).
 */
export function planPoll(state: LivePollState, fast: boolean, now: number): PollPlan {
  if (state.lastFailed) return { mode: "plain", delayMs: AFTER_LONG_FAIL_MS };
  if (state.supported && state.cursor !== null && now >= state.offUntil) {
    return { mode: "long", delayMs: LONG_GAP_MS, cursor: state.cursor, waitS: state.waitS };
  }
  return { mode: "plain", delayMs: fast ? POLL_FAST_MS : POLL_IDLE_MS };
}

/**
 * A long-poll answer may overtake a newer report (one fetched right after a tap).
 * True when `incoming` is older than what is shown and must be dropped.
 */
export function isOlder(incoming: HubReport, shown: ReportCursor | null): boolean {
  if (shown === null || typeof incoming.rev !== "number" || incoming.boot !== shown.boot) return false;
  return incoming.rev < shown.rev;
}

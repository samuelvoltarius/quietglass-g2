import type { Action, Control, Mode } from "./car/model";

/**
 * Paging and the control list as pure state machines, so every gesture path can be tested without glasses.
 *
 * Commands (0.7.0, Alfred 23.10.2026): lock, unlock and preheat 10/20/30 min - nothing else (no climate off,
 * no temperature). The control page exists only while the bridge reports control enabled. Every command is
 * two taps: the first asks the bridge (it checks every guard and sends nothing), the second within
 * CONFIRM_WINDOW_MS sends. A hold is never needed or offered (it never reaches the app from the temple).
 */

export type Page = "drive" | "charge" | "status" | "control";
export const PAGES: readonly Page[] = ["drive", "charge", "status", "control"];
const VIEW_PAGES: readonly Page[] = ["drive", "charge", "status"];

/** The pages the user can swipe through: the control page only when the bridge accepts commands. */
export function pagesFor(withControl: boolean): readonly Page[] {
  return withControl ? PAGES : VIEW_PAGES;
}

/** The page that fits what the car is doing. */
export function startPageFor(mode: Mode): Page {
  return mode === "driving" ? "drive" : mode === "charging" ? "charge" : "status";
}

export function stepPage(page: Page, delta: 1 | -1, withControl = false): Page {
  const list = pagesFor(withControl);
  const at = list.indexOf(page);
  const index = ((at < 0 ? 0 : at) + delta + list.length) % list.length;
  return list[index] ?? "drive";
}

/** A new mode moves the user to its page - unless they are busy on the control page. */
export function followMode(previous: Mode | null, next: Mode, page: Page, controlBusy = false): Page {
  if (previous === next) return page;
  if (page === "control" && controlBusy) return page;
  return startPageFor(next);
}

// ---- control list ------------------------------------------------------------

export type ControlItem = "lock" | "unlock" | "preheat10" | "preheat20" | "preheat30";
const PREHEAT_ITEMS: ReadonlyArray<readonly [ControlItem, number]> = [["preheat10", 10], ["preheat20", 20], ["preheat30", 30]];
/** The second tap must come within this time after the question is on screen. */
export const CONFIRM_WINDOW_MS = 4_000;
/** A result line stays this long. */
export const RESULT_MS = 180_000;

/** The entries the bridge accepts right now (an entry it refuses by configuration is not shown). */
export function controlItems(control: Control): ControlItem[] {
  if (!control.enabled) return [];
  const items: ControlItem[] = [];
  if (control.lock) items.push("lock");
  if (control.unlock) items.push("unlock");
  if (control.preheat) {
    for (const [item, minutes] of PREHEAT_ITEMS) if (control.preheatMinutes.includes(minutes)) items.push(item);
  }
  return items;
}

export function itemAction(item: ControlItem): { readonly action: Action; readonly minutes: number | null } {
  if (item === "lock" || item === "unlock") return { action: item, minutes: null };
  return { action: "preheat", minutes: Number(item.slice("preheat".length)) };
}

export type ControlResult =
  /** The bridge refused (its own text, shown as it is). */
  | { readonly item: ControlItem; readonly kind: "refused"; readonly code: string; readonly message: { readonly de: string; readonly en: string } | null; readonly at: number }
  /** Published; the bridge's `command` with this id tells confirmed / not confirmed. */
  | { readonly item: ControlItem; readonly kind: "sent"; readonly id: string | null; readonly at: number }
  /** The bridge could not be asked: nothing was sent. */
  | { readonly item: ControlItem; readonly kind: "failed"; readonly reason: "unreachable" | "auth"; readonly at: number }
  /** The second tap did not come in time. */
  | { readonly item: ControlItem; readonly kind: "lapsed"; readonly at: number }
  /** The confirm call got no answer: it may or may not have been sent - the bridge's `command` tells. */
  | { readonly item: ControlItem; readonly kind: "unknown"; readonly at: number };

export interface ControlState {
  readonly cursor: number;
  /** A request to the bridge is running: taps wait. */
  readonly busy: { readonly item: ControlItem; readonly step: "arm" | "confirm" } | null;
  /** The bridge said yes to the first tap: a second tap until `until` sends. */
  readonly armed: { readonly item: ControlItem; readonly token: string; readonly until: number } | null;
  readonly result: ControlResult | null;
  /** Last touch on the control page (for `followMode`). */
  readonly touchedAt: number;
}

export const INITIAL_CONTROL: ControlState = { cursor: 0, busy: null, armed: null, result: null, touchedAt: 0 };

/** The open question, or null when there is none or it ran out. */
export function openArm(state: ControlState, now: number): ControlState["armed"] {
  return state.armed && now <= state.armed.until ? state.armed : null;
}

/** Swipe: in a question it cancels (never confirms, never leaves); otherwise move, leave past either end. */
export function moveCursor(state: ControlState, delta: 1 | -1, count: number, now: number): { state: ControlState; leave: 0 | 1 | -1 } {
  if (state.busy) return { state, leave: 0 };
  if (openArm(state, now)) return { state: { ...state, armed: null, touchedAt: now }, leave: 0 };
  const base = { ...state, armed: null };
  const next = base.cursor + delta;
  if (count === 0) return { state: { ...base, cursor: 0 }, leave: delta };
  if (next < 0) return { state: { ...base, cursor: 0 }, leave: -1 };
  if (next >= count) return { state: { ...base, cursor: count - 1 }, leave: 1 };
  return { state: { ...base, cursor: next, touchedAt: now }, leave: 0 };
}

export type TapDecision =
  | { readonly kind: "none" }
  | { readonly kind: "arm"; readonly item: ControlItem }
  | { readonly kind: "confirm"; readonly item: ControlItem; readonly token: string };

/** Tap: the first asks the bridge, the second (in time) sends; while a request runs, taps do nothing. */
export function tapControl(state: ControlState, now: number, items: readonly ControlItem[]): TapDecision {
  if (state.busy) return { kind: "none" };
  const armed = openArm(state, now);
  if (armed) return { kind: "confirm", item: armed.item, token: armed.token };
  const item = items[Math.min(state.cursor, items.length - 1)];
  return item ? { kind: "arm", item } : { kind: "none" };
}

/** Double tap: cancels an open question. Null when there was none (then it means "leave"). */
export function cancelControl(state: ControlState, now: number): ControlState | null {
  if (!openArm(state, now)) return null;
  return { ...state, armed: null, touchedAt: now };
}

/** Clock tick: a question that ran out closes ("not sent"); an old result line goes away. */
export function expireControl(state: ControlState, now: number): ControlState {
  let next = state;
  if (next.armed && now > next.armed.until) next = { ...next, armed: null, result: { item: next.armed.item, kind: "lapsed", at: now } };
  if (next.result && now - next.result.at > RESULT_MS) next = { ...next, result: null };
  return next;
}

export function controlBusy(state: ControlState, now: number): boolean {
  return state.busy !== null || openArm(state, now) !== null || now - state.touchedAt < 30_000;
}

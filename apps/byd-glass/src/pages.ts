import type { Action, CarState, Mode } from "./car/model";

/**
 * Paging and the control list as pure state machines, so every gesture path
 * can be tested without glasses.
 */

export type Page = "drive" | "charge" | "status" | "control";
export const PAGES: readonly Page[] = ["drive", "charge", "status", "control"];

/** The page that fits what the car is doing. */
export function startPageFor(mode: Mode): Page {
  return mode === "driving" ? "drive" : mode === "charging" ? "charge" : "status";
}

export function stepPage(page: Page, delta: 1 | -1): Page {
  const index = (PAGES.indexOf(page) + delta + PAGES.length) % PAGES.length;
  return PAGES[index] ?? "drive";
}

/**
 * Should a new mode move the user to its page? Yes, unless they are busy on
 * the control page (a confirm open, or a tap there within the last 30 s).
 */
export function followMode(previous: Mode | null, next: Mode, page: Page, controlBusy: boolean): Page {
  if (previous === next) return page;
  if (page === "control" && controlBusy) return page;
  return startPageFor(next);
}

// ---- control list ------------------------------------------------------------

/**
 * Car commands, each behind TWO confirmations (13.10.2026: a cloud "climate off"
 * switched off the running car with the driver inside). Flow per item:
 *   list → [climate_on only: choose temperature, swipe ±1 °C] → question 1 →
 *   pause ARM_MS → final confirmation → send.
 * A double tap cancels at every step; nothing is sent without both taps, and
 * the reason check runs again right before sending.
 */
export type ControlItem = "climate_on" | "climate_off" | "lock" | "unlock";
export const CONTROL_ITEMS: readonly ControlItem[] = ["lock", "unlock", "climate_on", "climate_off"];
export const TEMP_MIN = 16;
export const TEMP_MAX = 28;
export const TEMP_DEFAULT = 21;
/** Every step waits this long, then quietly goes away. */
export const CONFIRM_MS = 8_000;
/** The final confirmation ignores taps this long, so it cannot be tapped through. */
export const ARM_MS = 1_000;

export type ConfirmStep = "temp" | "first" | "final";

export interface Confirm {
  readonly item: ControlItem;
  readonly step: ConfirmStep;
  readonly until: number;
  /** Taps count from here on (final step only). */
  readonly armedAt: number;
}

export interface ControlState {
  readonly cursor: number;
  readonly temp: number;
  readonly confirm: Confirm | null;
  /** Last tap on the control page (for `followMode`). */
  readonly touchedAt: number;
}

export const INITIAL_CONTROL: ControlState = { cursor: 0, temp: TEMP_DEFAULT, confirm: null, touchedAt: 0 };

export interface Availability {
  readonly enabled: boolean;
  readonly lock: boolean;
  readonly unlock: boolean;
}

/** Why an item cannot be used right now, or null. */
export function blockedReason(item: ControlItem, car: CarState | null, available: Availability): string | null {
  if (!car) return "noData";
  // The bridge refuses everything while the car is on; never even ask.
  if (car.carOn) return "car_on";
  if (!available.enabled) return "readOnly";
  if (item === "lock" && !available.lock) return "notSetUp";
  if (item === "unlock") {
    if (!available.unlock) return "notSetUp";
    if (car.mode !== "parked" || (car.drive.speed ?? 0) > 0) return "notParked";
  }
  return null;
}

export function actionFor(item: ControlItem): Action {
  return item;
}

/** The open confirmation, or null when there is none or it ran out. */
export function openConfirm(state: ControlState, now: number): Confirm | null {
  return state.confirm && now <= state.confirm.until ? state.confirm : null;
}

/** Is the final step still in its pause? */
export function finalArmed(confirm: Confirm, now: number): boolean {
  return confirm.step === "final" && now >= confirm.armedAt;
}

const clampTemp = (temp: number): number => Math.max(TEMP_MIN, Math.min(TEMP_MAX, temp));

/**
 * Swipe on the control page: in the temperature step ±1 °C; in a question
 * it cancels (QIS v1: a swipe never leaves or confirms, it backs out); otherwise
 * move the cursor and leave the page past either end.
 */
export function moveCursor(state: ControlState, delta: 1 | -1, now = 0): { state: ControlState; leave: 0 | 1 | -1 } {
  const confirm = openConfirm(state, now);
  if (confirm) {
    if (confirm.step !== "temp") return { state: { ...state, confirm: null, touchedAt: now }, leave: 0 };
    // Swipe down = warmer would feel wrong; up (scrollUp, -1) = warmer.
    const temp = clampTemp(state.temp - delta);
    return { state: { ...state, temp, touchedAt: now, confirm: { ...confirm, until: now + CONFIRM_MS } }, leave: 0 };
  }
  const base = state.confirm ? { ...state, confirm: null } : state;
  const next = base.cursor + delta;
  if (next < 0) return { state: { ...base, cursor: 0 }, leave: -1 };
  if (next >= CONTROL_ITEMS.length) return { state: { ...base, cursor: CONTROL_ITEMS.length - 1 }, leave: 1 };
  return { state: { ...base, cursor: next }, leave: 0 };
}

export type TapResult =
  | { readonly kind: "none"; readonly state: ControlState }
  | { readonly kind: "asked"; readonly state: ControlState }
  | { readonly kind: "send"; readonly state: ControlState; readonly action: Action; readonly value: number | null }
  | { readonly kind: "blocked"; readonly state: ControlState; readonly reason: string };

/** Tap: one step forward in the flow; only the armed final step sends. */
export function tapControl(state: ControlState, now: number, car: CarState | null, available: Availability): TapResult {
  const confirm = openConfirm(state, now);
  const item = confirm?.item ?? CONTROL_ITEMS[state.cursor] ?? "climate_on";
  const touched = { ...state, touchedAt: now };
  const reason = blockedReason(item, car, available);
  if (reason) return { kind: "blocked", state: { ...touched, confirm: null }, reason };
  const action = actionFor(item);
  const step = (next: ConfirmStep): ControlState => ({
    ...touched,
    confirm: { item, step: next, until: now + CONFIRM_MS, armedAt: next === "final" ? now + ARM_MS : now },
  });
  if (!confirm) return { kind: "asked", state: step(item === "climate_on" ? "temp" : "first") };
  if (confirm.step === "temp") return { kind: "asked", state: step("first") };
  if (confirm.step === "first") return { kind: "asked", state: step("final") };
  // Final step: a tap inside the pause is ignored (no send, no change).
  if (!finalArmed(confirm, now)) return { kind: "none", state };
  return { kind: "send", state: { ...touched, confirm: null }, action, value: action === "climate_on" ? clampTemp(state.temp) : null };
}

/** Double tap: cancels an open step. Returns null when there was none (then it means "leave"). */
export function cancelConfirm(state: ControlState, now: number): ControlState | null {
  if (!openConfirm(state, now)) return null;
  return { ...state, confirm: null, touchedAt: now };
}

/** Clock tick: a step that ran out, or a car that was switched on, closes the question. */
export function expireConfirm(state: ControlState, now: number, car: CarState | null = null): ControlState {
  if (!state.confirm) return state;
  if (now > state.confirm.until || car?.carOn) return { ...state, confirm: null };
  return state;
}

export function controlBusy(state: ControlState, now: number): boolean {
  return openConfirm(state, now) !== null || now - state.touchedAt < 30_000;
}

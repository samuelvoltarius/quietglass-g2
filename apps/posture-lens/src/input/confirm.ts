/**
 * Two-step confirmation for gestures that destroy something.
 *
 * The first gesture only arms the action and the glasses say what a second one
 * will do; the same gesture again within the window carries it out. Anything
 * else, or waiting, disarms it. Pure functions, so the timing is testable.
 */

export const CONFIRM_WINDOW_MS = 4000;

export interface PendingConfirm<K extends string = string> {
  readonly kind: K;
  readonly until: number;
}

export interface ConfirmStep<K extends string> {
  /** True when this gesture is the confirming second one. */
  readonly confirmed: boolean;
  /** The armed action after this gesture (null once confirmed). */
  readonly pending: PendingConfirm<K> | null;
}

/** Arms `kind`, or confirms it when it is already armed and still in time. */
export function confirmStep<K extends string>(
  pending: PendingConfirm<K> | null, kind: K, now: number, windowMs = CONFIRM_WINDOW_MS,
): ConfirmStep<K> {
  if (pending !== null && pending.kind === kind && now <= pending.until) return { confirmed: true, pending: null };
  return { confirmed: false, pending: { kind, until: now + windowMs } };
}

/** The armed action if it has not run out yet. */
export function activeConfirm<K extends string>(pending: PendingConfirm<K> | null, now: number): PendingConfirm<K> | null {
  return pending !== null && now <= pending.until ? pending : null;
}

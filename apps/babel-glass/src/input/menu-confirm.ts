/**
 * QIS v1.2 #3: risky side-menu items are armed like any other risky action.
 *
 * The first click only arms the item and the footer says what a second click
 * does ("Nochmal = löschen"); the same item again within CONFIRM_WINDOW_MS
 * carries it out. A different item, a tap/swipe/2x on the glasses or waiting
 * disarms it. Pure functions, so the timing is testable.
 */
import { activeConfirm, confirmStep, type PendingConfirm } from "./confirm";

/**
 * The glasses' side menu (QIS v1.2). Off: the menu shows on the real glasses, but its clicks never reach
 * the app, and while a page carries a menu a hold opens it instead of reaching the app (step log 15.10.2026).
 * Off, the pages carry no `menuObject`; hold, swipe and the start list do what the menu was meant to.
 */
export const SIDE_MENU = false;

/** What an armed item does: delete the voice print, or restart the running captions. */
export type MenuArmed = "voiceDelete" | "restart";

export interface MenuClick {
  /** True when the item runs now (it needs no arming, or this is the confirming second click). */
  readonly run: boolean;
  /** The armed item after this click (null when it ran). */
  readonly pending: PendingConfirm<string> | null;
}

/** One click on menu item `itemId`; `arm` is null for items that run at once. */
export function menuClickStep(pending: PendingConfirm<string> | null, itemId: number, arm: MenuArmed | null, now: number): MenuClick {
  if (arm === null) return { run: true, pending: null };
  const step = confirmStep(pending, `${arm}:${itemId}`, now);
  return { run: step.confirmed, pending: step.pending };
}

/** The armed item's meaning while it is still in time, else null. */
export function menuArmedKind(pending: PendingConfirm<string> | null, now: number): MenuArmed | null {
  const armed = activeConfirm(pending, now);
  if (!armed) return null;
  return armed.kind.startsWith("voiceDelete:") ? "voiceDelete" : "restart";
}

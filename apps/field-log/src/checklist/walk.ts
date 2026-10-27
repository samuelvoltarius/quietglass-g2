import { confirmStep, type PendingConfirm } from "../input/confirm";
import type { CheckItem, CheckRoom } from "./checklist";

/**
 * Walking one room on the glasses. Pure functions, so the gestures are testable.
 *
 * Every item offers two rows, "OK" and "Defect". A swipe moves through them
 * and on to the next item (down) or back to the previous one (up), wrapping
 * inside the room; it never records anything. A tap on "OK" marks the item and
 * moves on; on a critical item the first tap only arms it and a second single
 * tap within 4 s confirms (the FlowList pattern). A tap on "Defect" opens the
 * quick notes for that item.
 */

/** 0 = OK, 1 = Defect. */
export type WalkChoice = 0 | 1;

export interface WalkCursor {
  readonly item: number;
  readonly choice: WalkChoice;
}

export function walkStart(item = 0): WalkCursor {
  return { item, choice: 0 };
}

/** One swipe: OK -> Defect -> next item's OK (down), and back (up). Wraps inside the room. */
export function walkSwipe(room: CheckRoom, cursor: WalkCursor, delta: 1 | -1): WalkCursor {
  const positions = Math.max(1, room.items.length) * 2;
  const at = Math.min(cursor.item, Math.max(0, room.items.length - 1)) * 2 + cursor.choice;
  const next = (at + delta + positions) % positions;
  return { item: Math.floor(next / 2), choice: (next % 2) as WalkChoice };
}

export type OkKind = `ok:${string}`;

export interface OkTap {
  /** True when the item is to be marked OK now. */
  readonly confirmed: boolean;
  /** The armed second tap of a critical item, or null. */
  readonly pending: PendingConfirm<OkKind> | null;
}

/** A tap on "OK": plain items at once, critical items on the second tap within the window. */
export function tapOk(item: CheckItem, pending: PendingConfirm<OkKind> | null, now: number): OkTap {
  if (!item.critical) return { confirmed: true, pending: null };
  const step = confirmStep<OkKind>(pending, `ok:${item.id}`, now);
  return { confirmed: step.confirmed, pending: step.pending };
}

/** After an item was answered: the next item, or null at the end of the room (back to the overview). */
export function afterAnswer(room: CheckRoom, cursor: WalkCursor): WalkCursor | null {
  const next = cursor.item + 1;
  return next < room.items.length ? walkStart(next) : null;
}

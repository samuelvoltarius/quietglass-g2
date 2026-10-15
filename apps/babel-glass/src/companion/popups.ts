/**
 * One popup at a time on the glasses (0.5.0). Priority:
 * word finder / own sentence (asked for by the user) > reply suggestion >
 * explanation > tip card (cue, Kundengespräch). A higher or equal popup replaces the current one; a lower one
 * waits in a small queue (one per kind) and is shown when the current one
 * closes — unless it has gone stale by then (a reply suggestion is only
 * useful for a few seconds).
 */

export type PopupKind = "word" | "say" | "reply" | "info" | "cue";

export const POPUP_RANK: Readonly<Record<PopupKind, number>> = { word: 3, say: 3, reply: 2, info: 1, cue: 0 };

/** How long a queued popup may wait before it is no longer worth showing. */
export const QUEUE_MAX_MS: Readonly<Record<PopupKind, number>> = { word: 5_000, say: 10_000, reply: 8_000, info: 30_000, cue: 5_000 };

export interface Shown<P> {
  readonly popup: P;
  readonly kind: PopupKind;
  readonly until: number;
}

interface Waiting<P> {
  readonly popup: P;
  readonly kind: PopupKind;
  /** Display time once shown. */
  readonly ms: number;
  readonly staleAt: number;
}

export interface PopupSlot<P> {
  readonly current: Shown<P> | null;
  readonly queue: readonly Waiting<P>[];
}

export function emptySlot<P>(): PopupSlot<P> {
  return { current: null, queue: [] };
}

/** Expired popup out, the best fresh waiting one in. */
export function advancePopups<P>(slot: PopupSlot<P>, now: number): PopupSlot<P> {
  if (slot.current && slot.current.until > now) {
    const queue = slot.queue.filter((entry) => entry.staleAt > now);
    return queue.length === slot.queue.length ? slot : { ...slot, queue };
  }
  const fresh = slot.queue.filter((entry) => entry.staleAt > now);
  if (fresh.length === 0) return slot.current || slot.queue.length ? { current: null, queue: [] } : slot;
  const best = fresh.reduce((a, b) => (POPUP_RANK[b.kind] > POPUP_RANK[a.kind] ? b : a));
  return {
    current: { popup: best.popup, kind: best.kind, until: now + best.ms },
    queue: fresh.filter((entry) => entry !== best),
  };
}

/** Offers a popup: shown now (`shown`) or queued behind a higher one. */
export function offerPopup<P>(slot: PopupSlot<P>, kind: PopupKind, popup: P, ms: number, now: number): { slot: PopupSlot<P>; shown: boolean } {
  const live = advancePopups(slot, now);
  const current = live.current;
  if (!current || POPUP_RANK[kind] >= POPUP_RANK[current.kind]) {
    // The same kind waiting in the queue is superseded by this one.
    return { slot: { current: { popup, kind, until: now + ms }, queue: live.queue.filter((entry) => entry.kind !== kind) }, shown: true };
  }
  const queue = [...live.queue.filter((entry) => entry.kind !== kind), { popup, kind, ms, staleAt: now + QUEUE_MAX_MS[kind] }];
  return { slot: { current, queue }, shown: false };
}

/** Closes what is on screen (a tap); the next waiting popup follows. */
export function closePopup<P>(slot: PopupSlot<P>, now: number): PopupSlot<P> {
  return advancePopups({ current: null, queue: slot.queue }, now);
}

/** Removes one kind everywhere (e.g. an explanation that came to nothing). */
export function dropKind<P>(slot: PopupSlot<P>, kind: PopupKind, now: number): PopupSlot<P> {
  const queue = slot.queue.filter((entry) => entry.kind !== kind);
  if (slot.current?.kind === kind) return advancePopups({ current: null, queue }, now);
  return { current: slot.current, queue };
}

export function visiblePopup<P>(slot: PopupSlot<P>, now: number): Shown<P> | null {
  return slot.current && slot.current.until > now ? slot.current : null;
}

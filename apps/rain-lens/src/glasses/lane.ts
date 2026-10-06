/**
 * The one way images reach the glasses.
 *
 * Text is cheap (`textContainerUpgrade`), images are not: every update is a
 * full transfer of the picture over BLE. So images travel in their own lane,
 * apart from the text:
 *
 * - **Only on change.** Each request carries a key describing what is drawn
 *   (already quantised). A key equal to the one on the glasses costs nothing.
 * - **Throttled.** A container is written at most once per `minIntervalMs`;
 *   a change inside that window is sent when it ends, newest state only.
 * - **One at a time.** Never two image transfers in flight at once.
 * - **Never in the way.** Callers do not await the lane, so a slow image never
 *   delays a text update.
 *
 * Shared Quietglass convention: each app carries its own copy of this file.
 */

export interface ImageTarget {
  readonly id: number;
  readonly name: string;
}

export type ImageSend = (target: ImageTarget, data: Uint8Array) => Promise<boolean>;
export type ImageRender = () => Uint8Array | Promise<Uint8Array>;

export interface ImageLane {
  /** Asks for `target` to show what `key` describes; `render` runs only if it will be sent. */
  request(target: ImageTarget, key: string, render: ImageRender): void;
  /** The page was created anew and its images are blank: resend on the next request, without waiting. */
  invalidate(): void;
  /** Stops all sending and timers. */
  close(): void;
  /** Resolves once nothing is in flight or waiting (for tests). */
  settled(): Promise<void>;
}

interface Job { readonly target: ImageTarget; readonly key: string; readonly render: ImageRender; readonly retry: boolean }
interface Slot { shownKey: string | null; sentAt: number; pending: Job | null }

/** Default spacing between two writes of the same image. */
export const IMAGE_INTERVAL_MS = 3000;

export function createImageLane(send: ImageSend, minIntervalMs = IMAGE_INTERVAL_MS): ImageLane {
  const slots = new Map<number, Slot>();
  let busy: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  /** Bumped by invalidate(); a transfer that started on the old page does not count as shown. */
  let generation = 0;

  const slotFor = (target: ImageTarget): Slot => {
    let slot = slots.get(target.id);
    if (!slot) { slot = { shownKey: null, sentAt: Number.NEGATIVE_INFINITY, pending: null }; slots.set(target.id, slot); }
    return slot;
  };

  const run = async (slot: Slot, job: Job): Promise<void> => {
    const started = generation;
    let ok = false;
    try { ok = await send(job.target, await job.render()); } catch { ok = false; }
    if (closed || started !== generation) return;
    slot.sentAt = Date.now();
    if (ok) slot.shownKey = job.key;
    // One retry after the interval, unless something newer is already waiting.
    else if (!slot.pending && !job.retry) slot.pending = { ...job, retry: true };
  };

  const pump = (): void => {
    if (busy || closed) return;
    const now = Date.now();
    let wait = Number.POSITIVE_INFINITY;
    for (const slot of slots.values()) {
      const job = slot.pending;
      if (!job) continue;
      if (job.key === slot.shownKey) { slot.pending = null; continue; }
      const due = slot.sentAt + minIntervalMs - now;
      if (due > 0) { wait = Math.min(wait, due); continue; }
      slot.pending = null;
      busy = run(slot, job).finally(() => { busy = null; pump(); });
      return;
    }
    if (Number.isFinite(wait) && timer === undefined) timer = setTimeout(() => { timer = undefined; pump(); }, wait);
  };

  return {
    request(target, key, render) {
      if (closed) return;
      const slot = slotFor(target);
      if (key === slot.shownKey) { slot.pending = null; return; }
      slot.pending = { target, key, render, retry: false };
      pump();
    },
    invalidate() {
      generation += 1;
      for (const slot of slots.values()) { slot.shownKey = null; slot.sentAt = Number.NEGATIVE_INFINITY; }
      clearTimeout(timer); timer = undefined;
      pump();
    },
    close() {
      closed = true;
      clearTimeout(timer); timer = undefined;
      for (const slot of slots.values()) slot.pending = null;
    },
    async settled() {
      while (busy) await busy;
    },
  };
}

/**
 * Keeps one image container in step with a small piece of state, without
 * ever holding up the text.
 *
 * Each image update is a BLE transfer that can take far longer than a text
 * update, so it runs on its own lane: `request()` returns at once, at most one
 * transfer is in flight, requests made meanwhile collapse into the newest, and
 * nothing is sent when the state on the glasses already matches. A transfer
 * that failed is not retried for the same state (the next change, or a page
 * rebuild, tries again) so a failing image cannot turn into a resend loop.
 */
export interface ImageSync<S> {
  /** Asks for `state` to be shown. Never waits for the transfer. */
  request(state: S): void;
  /** The page was rebuilt: whatever was shown is gone. */
  reset(): void;
  /** Resolves once no transfer is in flight (for tests and shutdown). */
  idle(): Promise<void>;
}

export function createImageSync<S>(
  same: (a: S | null, b: S) => boolean,
  send: (state: S) => Promise<boolean>,
): ImageSync<S> {
  let shown: S | null = null;
  let failed: S | null = null;
  let wanted: S | null = null;
  let running: Promise<void> | null = null;
  /** Bumped by reset(); a transfer started before it no longer counts as shown. */
  let generation = 0;

  const pending = (): S | null => {
    if (wanted === null || same(shown, wanted) || same(failed, wanted)) return null;
    return wanted;
  };

  const pump = async (): Promise<void> => {
    for (let next = pending(); next !== null; next = pending()) {
      const startedIn = generation;
      let ok = false;
      try {
        ok = await send(next);
      } catch {
        ok = false;
      }
      if (startedIn !== generation) continue;
      if (ok) { shown = next; failed = null; } else failed = next;
    }
  };

  const start = (): void => {
    if (running || pending() === null) return;
    // A request landing between the last check and the end of the pump would
    // otherwise be dropped; look once more when the lane frees up.
    running = pump().finally(() => { running = null; start(); });
  };

  return {
    request(state) {
      wanted = state;
      start();
    },
    reset() {
      generation++;
      shown = null;
      failed = null;
    },
    idle: () => running ?? Promise.resolve(),
  };
}

/**
 * Limits how often streamed text redraws the glasses: the first request runs
 * at once, later ones at most every `ms`, and the last request in a burst is
 * never lost (it runs when the interval is over).
 */
export interface Throttle {
  request(): void;
  /** Drops a scheduled run. */
  cancel(): void;
}

export const STREAM_REDRAW_MS = 300;

export function createThrottle(run: () => void, ms = STREAM_REDRAW_MS, now: () => number = Date.now): Throttle {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = (): void => {
    timer = undefined;
    last = now();
    run();
  };
  return {
    request() {
      if (timer !== undefined) return;
      const wait = last + ms - now();
      if (wait <= 0) fire();
      else timer = setTimeout(fire, wait);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

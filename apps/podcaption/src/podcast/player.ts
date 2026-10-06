import type { Caption } from "./parse";

export interface PlayerOptions {
  readonly length: () => number;
  readonly cursor: () => number;
  readonly setCursor: (cursor: number) => void;
  readonly onChange: () => void;
  /** Fixed beat for untimed text. */
  readonly intervalMs?: number;
  /** How long the caption at `cursor` stays up; undefined falls back to the fixed beat. */
  readonly delayMs?: (cursor: number) => number | undefined;
}

export interface Player {
  readonly playing: boolean;
  toggle(): void;
  stop(): void;
  /** Re-times the pending step after a manual scroll, so the new caption gets its own duration. */
  resync(): void;
}

export const DEFAULT_BEAT_MS = 4000;

/** Time until the next caption from the timestamps; untimed text (every start 0) and out-of-order cues keep the fixed beat. */
export function captionDelay(captions: readonly Caption[], cursor: number, fallbackMs = DEFAULT_BEAT_MS): number {
  const current = captions[cursor]; const next = captions[cursor + 1]; if (!current || !next) return fallbackMs;
  const gap = (next.start - current.start) * 1000; return Number.isFinite(gap) && gap > 0 ? gap : fallbackMs;
}

/** Steps through captions on their own timing (or a fixed beat) and releases its timer when it reaches the end. */
export function createPlayer(options: PlayerOptions): Player {
  let timer: ReturnType<typeof setTimeout> | undefined; let playing = false;
  const stop = (): void => { clearTimeout(timer); timer = undefined; playing = false; };
  const schedule = (): void => { clearTimeout(timer); timer = setTimeout(tick, options.delayMs?.(options.cursor()) ?? options.intervalMs ?? DEFAULT_BEAT_MS); };
  const tick = (): void => {
    const last = Math.max(0, options.length() - 1);
    options.setCursor(Math.min(last, options.cursor() + 1));
    if (options.cursor() >= last) stop(); else schedule();
    options.onChange();
  };
  return {
    get playing() { return playing; },
    // Play on the last caption starts over instead of waiting a beat and stopping again.
    toggle() { if (playing) stop(); else { if (options.length() > 1 && options.cursor() >= options.length() - 1) options.setCursor(0); playing = true; schedule(); } options.onChange(); },
    stop() { stop(); },
    resync() { if (playing) schedule(); },
  };
}

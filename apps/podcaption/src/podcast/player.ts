export interface PlayerOptions {
  readonly length: () => number;
  readonly cursor: () => number;
  readonly setCursor: (cursor: number) => void;
  readonly onChange: () => void;
  readonly intervalMs?: number;
}

export interface Player {
  readonly playing: boolean;
  toggle(): void;
  stop(): void;
}

/** Steps through captions on a fixed beat and releases its timer when it reaches the end. */
export function createPlayer(options: PlayerOptions): Player {
  let timer: ReturnType<typeof setInterval> | undefined; let playing = false;
  const stop = (): void => { clearInterval(timer); timer = undefined; playing = false; };
  const tick = (): void => {
    const last = Math.max(0, options.length() - 1);
    options.setCursor(Math.min(last, options.cursor() + 1));
    if (options.cursor() >= last) stop();
    options.onChange();
  };
  return {
    get playing() { return playing; },
    toggle() { if (playing) stop(); else { playing = true; timer = setInterval(tick, options.intervalMs ?? 4000); } options.onChange(); },
    stop() { stop(); },
  };
}

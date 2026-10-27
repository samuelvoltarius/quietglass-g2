/**
 * Timing rules of the remote, pure and clock-driven so the tests can step
 * through them: the volume swipes are collected and sent in one burst, and
 * switching the TV off needs a second tap within four seconds.
 */

/** A swipe series ends after this pause; then the collected steps are sent. */
export const VOLUME_SETTLE_MS = 350;
/** At most this many steps per burst (a long swipe series must not blast the TV). */
export const VOLUME_MAX_BURST = 5;
/** Switching off: the second tap must come within this time. */
export const POWER_ARM_MS = 4_000;

export interface Scheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface VolumeStepper {
  /** One swipe: +1 louder, -1 quieter. */
  step(direction: 1 | -1): void;
  /** Steps waiting to be sent (positive = up), for the optimistic display. */
  pending(): number;
  /** Drops what is waiting (page left, app closing). */
  cancel(): void;
}

/**
 * Collects swipes. Each swipe restarts the settle timer; when it runs out the
 * net number of steps (up minus down, capped at VOLUME_MAX_BURST) is handed to
 * `send` once. A swipe series that cancels itself out sends nothing.
 */
export function createVolumeStepper(send: (steps: number) => void, scheduler: Scheduler = realScheduler, settleMs = VOLUME_SETTLE_MS): VolumeStepper {
  let net = 0;
  let timer: unknown = null;
  const flush = (): void => {
    timer = null;
    const steps = Math.max(-VOLUME_MAX_BURST, Math.min(VOLUME_MAX_BURST, net));
    net = 0;
    if (steps !== 0) send(steps);
  };
  return {
    step(direction) {
      net = Math.max(-VOLUME_MAX_BURST, Math.min(VOLUME_MAX_BURST, net + direction));
      if (timer !== null) scheduler.clearTimeout(timer);
      timer = scheduler.setTimeout(flush, settleMs);
    },
    pending: () => net,
    cancel() {
      if (timer !== null) scheduler.clearTimeout(timer);
      timer = null;
      net = 0;
    },
  };
}

export interface PowerArm {
  /** A tap on "switch off": true = confirmed now (second tap in time), false = armed (first tap). */
  tap(now: number): boolean;
  armed(now: number): boolean;
  disarm(): void;
}

export function createPowerArm(windowMs = POWER_ARM_MS): PowerArm {
  let armedAt: number | null = null;
  const isArmed = (now: number): boolean => armedAt !== null && now - armedAt <= windowMs;
  return {
    tap(now) {
      if (isArmed(now)) { armedAt = null; return true; }
      armedAt = now;
      return false;
    },
    armed: isArmed,
    disarm() { armedAt = null; },
  };
}

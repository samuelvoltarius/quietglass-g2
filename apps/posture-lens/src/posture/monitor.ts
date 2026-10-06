import { angleBetween, normalise, smooth, type Vec3 } from "../imu/vector";

/**
 * Posture state over time.
 *
 * The hard part is not measuring an angle — it is deciding when to say
 * something. Looking down is normal and constant; *staying* down is the
 * problem. So a warning needs the angle to be exceeded continuously for a
 * sustained period, and after a warning the monitor goes quiet for a while so
 * it does not become noise the user learns to ignore.
 */

export type PostureState = "uncalibrated" | "good" | "leaning" | "warned";

export interface PostureSettings {
  /** Degrees from the calibrated upright pose that count as leaning. */
  readonly warnAngle: number;
  /** Seconds of continuous leaning before a warning appears. */
  readonly sustainSeconds: number;
  /** Seconds of quiet after a warning before it can fire again. */
  readonly snoozeSeconds: number;
  /** EMA factor, 0…1. Lower is steadier and slower to react. */
  readonly smoothing: number;
}

export const DEFAULT_SETTINGS: PostureSettings = {
  warnAngle: 25,
  sustainSeconds: 60,
  snoozeSeconds: 300,
  smoothing: 0.15,
};

export interface PostureMonitor {
  readonly state: PostureState;
  /** Calibrated upright direction; null until the user calibrates. */
  readonly reference: Vec3 | null;
  /** Smoothed current direction. */
  readonly current: Vec3 | null;
  /** Degrees from the reference, or null when not measurable. */
  readonly angle: number | null;
  /** Timestamp the current lean began, or null while upright. */
  readonly leaningSince: number | null;
  /** Timestamp of the last warning, for the snooze window. */
  readonly lastWarnAt: number | null;
  /** Seconds accumulated in each state since the session started. */
  readonly goodSeconds: number;
  readonly leaningSeconds: number;
  readonly lastSampleAt: number | null;
}

export function createMonitor(): PostureMonitor {
  return {
    state: "uncalibrated",
    reference: null,
    current: null,
    angle: null,
    leaningSince: null,
    lastWarnAt: null,
    goodSeconds: 0,
    leaningSeconds: 0,
    lastSampleAt: null,
  };
}

/**
 * Longest gap between two IMU samples that still counts as tracked time. The
 * glasses report every 500 ms; a longer silence means they were off, asleep or
 * disconnected, and that time is neither upright nor leaning.
 */
export const MAX_SAMPLE_GAP_SECONDS = 30;

/**
 * Takes the current pose as the upright reference. A zero vector carries no
 * direction — every later angle would be undefined and the monitor would sit
 * silently at "good" — so it is refused and the monitor is left as it was.
 */
export function calibrate(monitor: PostureMonitor, sample: Vec3, now: number): PostureMonitor {
  if (!normalise(sample)) return monitor;
  const current = smooth(monitor.current, sample, 1);
  return {
    ...monitor,
    reference: current,
    current,
    angle: 0,
    state: "good",
    leaningSince: null,
    lastWarnAt: null,
    goodSeconds: 0,
    leaningSeconds: 0,
    lastSampleAt: now,
  };
}

export function reset(monitor: PostureMonitor): PostureMonitor {
  return { ...createMonitor(), reference: monitor.reference, state: monitor.reference ? "good" : "uncalibrated" };
}

/**
 * Feeds one IMU sample. Pure: same inputs, same output.
 */
export function addSample(
  monitor: PostureMonitor,
  sample: Vec3,
  settings: PostureSettings,
  now: number,
): PostureMonitor {
  const current = smooth(monitor.current, sample, settings.smoothing);

  if (!monitor.reference) {
    return { ...monitor, current, lastSampleAt: now, state: "uncalibrated" };
  }

  const angle = angleBetween(current, monitor.reference);
  const gap = monitor.lastSampleAt === null
    ? 0
    : Math.max(0, (now - monitor.lastSampleAt) / 1000);
  // After a long silence the time in between was not observed, and a lean
  // from before it is not one the user has been holding since.
  const resumed = gap > MAX_SAMPLE_GAP_SECONDS;
  const elapsed = resumed ? 0 : gap;

  if (angle === null) {
    return { ...monitor, current, lastSampleAt: now };
  }

  const leaning = angle >= settings.warnAngle;
  const leaningSince = leaning ? ((resumed ? null : monitor.leaningSince) ?? now) : null;

  let state: PostureState = leaning ? "leaning" : "good";
  let lastWarnAt = monitor.lastWarnAt;

  if (leaning && leaningSince !== null) {
    const heldSeconds = (now - leaningSince) / 1000;
    const snoozed = lastWarnAt !== null && (now - lastWarnAt) / 1000 < settings.snoozeSeconds;
    if (heldSeconds >= settings.sustainSeconds && !snoozed) {
      state = "warned";
      lastWarnAt = now;
    } else if (monitor.state === "warned" && snoozed) {
      // Stay visibly warned until the user straightens up.
      state = "warned";
    }
  }

  return {
    ...monitor,
    current,
    angle,
    state,
    leaningSince,
    lastWarnAt,
    goodSeconds: monitor.goodSeconds + (leaning ? 0 : elapsed),
    leaningSeconds: monitor.leaningSeconds + (leaning ? elapsed : 0),
    lastSampleAt: now,
  };
}

/** Share of tracked time spent upright, 0…1. Null before any time is tracked. */
export function uprightShare(monitor: PostureMonitor): number | null {
  const total = monitor.goodSeconds + monitor.leaningSeconds;
  if (total <= 0) return null;
  return monitor.goodSeconds / total;
}

/** Seconds the current lean has been held, or null while upright. */
export function heldSeconds(monitor: PostureMonitor, now: number): number | null {
  if (monitor.leaningSince === null) return null;
  return Math.max(0, (now - monitor.leaningSince) / 1000);
}

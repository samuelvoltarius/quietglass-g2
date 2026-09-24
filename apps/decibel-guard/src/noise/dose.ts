/**
 * Noise dose.
 *
 * A single loudness reading says little. What damages hearing is **level
 * multiplied by time**, which is why occupational limits are written as a pair
 * — commonly 85 dB(A) for 8 hours — with an exchange rate saying how much the
 * allowed time shrinks as the level rises.
 *
 * DecibelGuard accumulates that dose so it can say "you have had enough for
 * today" rather than only "it is loud right now".
 *
 * **This is an indicator, not an instrument.** See README: the level itself
 * comes from an uncalibrated microphone with a user-supplied offset, and no
 * frequency weighting is applied.
 */

export interface DoseSettings {
  /** Level permitted for the full reference duration, in dB. */
  readonly criterionDb: number;
  /** Reference duration in hours at the criterion level. */
  readonly criterionHours: number;
  /**
   * Exchange rate in dB: the increase that halves the permitted time.
   * 3 dB is the equal-energy rule used in the EU; 5 dB is used by OSHA.
   */
  readonly exchangeRateDb: number;
  /** Below this the sound is not counted toward the dose at all. */
  readonly thresholdDb: number;
}

export const DEFAULT_DOSE: DoseSettings = {
  criterionDb: 85,
  criterionHours: 8,
  exchangeRateDb: 3,
  thresholdDb: 70,
};

/**
 * Permitted exposure time in seconds at a given level.
 *
 *   T = criterionHours / 2^((L - criterionDb) / exchangeRate)
 */
export function permittedSeconds(level: number, settings: DoseSettings): number {
  const steps = (level - settings.criterionDb) / settings.exchangeRateDb;
  return settings.criterionHours * 3600 / Math.pow(2, steps);
}

/**
 * Dose fraction contributed by `seconds` spent at `level`.
 * 1.0 is a full day's permitted exposure.
 */
export function doseFraction(level: number, seconds: number, settings: DoseSettings): number {
  if (seconds <= 0) return 0;
  if (level < settings.thresholdDb) return 0;
  const permitted = permittedSeconds(level, settings);
  if (!Number.isFinite(permitted) || permitted <= 0) return seconds > 0 ? Infinity : 0;
  return seconds / permitted;
}

export interface DoseState {
  /** Accumulated fraction of a permitted day, 0…n. */
  readonly fraction: number;
  /** Seconds of audio actually measured. */
  readonly measuredSeconds: number;
  /** Highest smoothed level seen, for context. */
  readonly peakDb: number | null;
  /** When accumulation began. */
  readonly startedAt: number | null;
}

export function createDose(): DoseState {
  return { fraction: 0, measuredSeconds: 0, peakDb: null, startedAt: null };
}

export function accumulate(
  state: DoseState,
  level: number,
  seconds: number,
  settings: DoseSettings,
  now: number,
): DoseState {
  if (seconds <= 0) return state;
  return {
    fraction: state.fraction + doseFraction(level, seconds, settings),
    measuredSeconds: state.measuredSeconds + seconds,
    peakDb: state.peakDb === null ? level : Math.max(state.peakDb, level),
    startedAt: state.startedAt ?? now,
  };
}

export function resetDose(): DoseState {
  return createDose();
}

export type DoseLevel = "quiet" | "accumulating" | "high" | "exceeded";

/**
 * Bands for the display. "high" starts at 50% so there is time to act — being
 * told only once the limit is passed is useless for preventing damage.
 */
export function doseLevel(state: DoseState): DoseLevel {
  if (state.fraction >= 1) return "exceeded";
  if (state.fraction >= 0.5) return "high";
  if (state.fraction > 0) return "accumulating";
  return "quiet";
}

/** Seconds of further exposure permitted at `level` before the dose is full. */
export function remainingSeconds(
  state: DoseState,
  level: number,
  settings: DoseSettings,
): number | null {
  if (level < settings.thresholdDb) return null;
  const remainingFraction = Math.max(0, 1 - state.fraction);
  const permitted = permittedSeconds(level, settings);
  if (!Number.isFinite(permitted)) return null;
  return remainingFraction * permitted;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return hours + "h " + minutes + "m";
  if (minutes > 0) return minutes + "m";
  return seconds + "s";
}

/**
 * The values the cockpit draws are quantised, so the picture only changes -
 * and a tile is only sent - when something visibly moved.
 */

/** Level is shown in 3 dB steps: one step is one halving of the permitted time. */
export const LEVEL_STEP_DB = 3;
/** Dose is shown in 2 % steps. */
export const DOSE_STEP_PERCENT = 2;
/** The dose that turns the display to "high" (see noise/dose.ts doseLevel). */
export const WARN_PERCENT = 50;

/** Level scale of the bar. */
export const METER_MIN_DB = 40;
export const METER_MAX_DB = 110;

/**
 * Snaps a reading to `step` with hysteresis: the shown value only moves once
 * the reading is three quarters of a step away from it. Without this a value
 * sitting on a boundary would flip every sample and cost a transfer each time.
 */
export function quantize(previous: number | null, value: number | null, step: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const snapped = Math.round(value / step) * step;
  if (previous === null) return snapped;
  return Math.abs(value - previous) < step * 0.75 ? previous : snapped;
}

/** Floors the dose to whole 2 % steps (never shows more than was measured), capped at 200 %. */
export function dosePercent(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  return Math.min(200, Math.floor((fraction * 100) / DOSE_STEP_PERCENT) * DOSE_STEP_PERCENT);
}

/** Next level to draw, in 3 dB steps with hysteresis against the one drawn now. */
export function meterLevel(previous: number | null, level: number | null): number | null {
  return quantize(previous, level, LEVEL_STEP_DB);
}

/** A level as 0..100 on the bar's scale (clamped). */
export function meterShare(level: number): number {
  return Math.round(((Math.min(METER_MAX_DB, Math.max(METER_MIN_DB, level)) - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)) * 100);
}

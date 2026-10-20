/**
 * The values the cockpit draws are quantised, so the picture only changes -
 * and a tile is only sent - when something visibly moved.
 */

/** The gauge needle moves in 2° steps. */
export const ANGLE_STEP = 2;

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

/** Next angle to draw, in 2° steps with hysteresis against the one drawn now. */
export function gaugeAngle(previous: number | null, angle: number | null): number | null {
  return quantize(previous, angle, ANGLE_STEP);
}

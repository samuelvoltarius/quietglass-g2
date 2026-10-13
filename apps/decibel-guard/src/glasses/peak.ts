/**
 * Peak hold for the level meter: the line stays at the loudest recent level,
 * waits a moment, then falls slowly. Pure — the caller keeps the state.
 */
export interface Peak {
  readonly db: number;
  /** When the peak was last set or confirmed. */
  readonly at: number;
}

/** The line stays put this long after the last peak. */
export const PEAK_HOLD_MS = 2000;
/** Then it falls at this speed. */
export const PEAK_FALL_DB_PER_S = 4;

export function updatePeak(previous: Peak | null, level: number | null, now: number): Peak | null {
  if (level === null || !Number.isFinite(level)) return previous;
  if (previous === null || level >= previous.db) return { db: level, at: now };
  const idle = now - previous.at - PEAK_HOLD_MS;
  if (idle <= 0) return previous;
  const fallen = previous.db - (idle / 1000) * PEAK_FALL_DB_PER_S;
  // Never below the present level, and the clock restarts from the new height.
  const db = Math.max(level, fallen);
  return { db, at: now - PEAK_HOLD_MS };
}

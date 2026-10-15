/**
 * The "too fast" warning in the middle of the HUD, and the dead reckoning
 * that keeps the distance to the turn moving between GPS fixes.
 *
 * Both are pure and clocked from outside, so the tests can step time.
 */

/** Tolerance over the limit: +3 km/h up to 50, +5 above. */
export function speedingTolerance(limit: number): number {
  return limit <= 50 ? 3 : 5;
}

/** Over the tolerance this long before the warning appears, and under it this long before it goes. */
export const SPEEDING_HOLD_MS = 2_000;
/** A limit not confirmed by a position this recent is not trusted. */
export const LIMIT_STALE_MS = 10_000;

export interface SpeedingWarning {
  readonly kmh: number;
  readonly limit: number;
}

/**
 * Debounced speeding state. `update` is called on every draw (≥ 1 Hz while
 * driving); it reports the warning to show, or null.
 *
 *  - appears after the speed has been over limit + tolerance for 2 s without a break,
 *  - disappears after it has been back at or under it for 2 s,
 *  - never with an unknown limit or one older than LIMIT_STALE_MS (gone at once).
 */
export class SpeedingWatch {
  private shown = false;
  private overSince: number | null = null;
  private underSince: number | null = null;

  update(kmh: number | null, limit: number | null, limitAgeMs: number, now: number): SpeedingWarning | null {
    if (limit === null || kmh === null || !Number.isFinite(limitAgeMs) || limitAgeMs > LIMIT_STALE_MS) {
      this.reset();
      return null;
    }
    const over = kmh > limit + speedingTolerance(limit);
    if (over) {
      this.underSince = null;
      this.overSince ??= now;
      if (!this.shown && now - this.overSince >= SPEEDING_HOLD_MS) this.shown = true;
    } else {
      this.overSince = null;
      if (this.shown) {
        this.underSince ??= now;
        if (now - this.underSince >= SPEEDING_HOLD_MS) { this.shown = false; this.underSince = null; }
      }
    }
    return this.shown ? { kmh, limit } : null;
  }

  reset(): void {
    this.shown = false;
    this.overSince = null;
    this.underSince = null;
  }
}

/** Dead reckoning never runs further ahead of the last fix than this. */
export const RECKON_MAX_MS = 4_000;

/**
 * The distance to the turn now, from the distance at the last fix, the time
 * since then and the speed: d₀ − v·Δt, never below 0 and never extrapolated
 * for more than RECKON_MAX_MS (a lost fix must not count the turn down to
 * "now"). Unknown speed: the fix value as it is.
 */
export function reckonDistance(distanceAtFix: number, kmh: number | null, sinceFixMs: number): number {
  if (!Number.isFinite(distanceAtFix)) return distanceAtFix;
  if (kmh === null || !(kmh > 0) || !(sinceFixMs > 0)) return distanceAtFix;
  const travelled = (kmh / 3.6) * (Math.min(sinceFixMs, RECKON_MAX_MS) / 1000);
  return Math.max(0, distanceAtFix - travelled);
}

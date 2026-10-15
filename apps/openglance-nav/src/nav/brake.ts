import type { SpeedLimitSpan } from "./speed";

/**
 * Brake hints: a lower speed limit ahead (the town sign, a 70 before a
 * junction) is announced early enough to roll towards it without braking.
 *
 * Everything here is pure maths over the route's limit spans, which arrive
 * once per route with the trace_attributes request (no request per fix):
 *
 *   d = (v² − vₜ²) / (2·a)
 *
 * with the current speed v, the new limit vₜ (both m/s) and the deceleration
 * a: 0.8 m/s² for rolling ("vom Gas"), 1.5 m/s² for braking. A reaction margin
 * of 3 s (rolling) and 1 s (braking) at the current speed is added.
 */

/** Deceleration when the foot just leaves the pedal (EV recuperation, mild). */
export const COAST_DECEL = 0.8;
/** A comfortable, deliberate braking. */
export const BRAKE_DECEL = 1.5;
/** Reaction margins in seconds at the current speed. */
export const COAST_REACTION_S = 3;
export const BRAKE_REACTION_S = 1;
/** The hint ends once the speed is at most this much over the new limit. */
export const CLEAR_MARGIN_KMH = 5;
/** Drops further ahead than this are not considered (a hint never needs more at 200 km/h → 50). */
export const LOOKAHEAD_M = 2_500;
/** A drop just passed while still too fast keeps the hint this far beyond the sign. */
export const PASSED_KEEP_M = 150;

/** Where on the route (metres from its start) the limit falls, and to what. */
export interface LimitDrop {
  readonly along: number;
  /** The limit before the drop. */
  readonly from: number;
  /** The new, lower limit. */
  readonly to: number;
}

/**
 * The places where the limit goes down, in route order. `along` holds the
 * cumulative metres of every shape point (geometry.cumulativeMeters). A span
 * without a known limit neither starts nor ends a drop: the last known limit
 * before it counts.
 */
export function limitDrops(spans: readonly SpeedLimitSpan[], along: readonly number[]): LimitDrop[] {
  const drops: LimitDrop[] = [];
  let last: number | null = null;
  for (const span of spans) {
    if (span.limit === null) continue;
    if (last !== null && span.limit < last) {
      const at = along[span.from];
      if (at !== undefined) drops.push({ along: at, from: last, to: span.limit });
    }
    last = span.limit;
  }
  return drops;
}

/** Metres needed to go from `kmh` down to `targetKmh` at `decel` m/s²; 0 when not faster. */
export function stoppingDistance(kmh: number, targetKmh: number, decel: number): number {
  const v = kmh / 3.6, vt = targetKmh / 3.6;
  if (!(v > vt) || !(decel > 0)) return 0;
  return (v * v - vt * vt) / (2 * decel);
}

/** Distance before the drop at which "vom Gas" appears. */
export function coastPoint(kmh: number, targetKmh: number): number {
  return stoppingDistance(kmh, targetKmh, COAST_DECEL) + COAST_REACTION_S * (kmh / 3.6);
}

/** Distance before the drop at which "BREMSEN" appears. */
export function brakePoint(kmh: number, targetKmh: number): number {
  return stoppingDistance(kmh, targetKmh, BRAKE_DECEL) + BRAKE_REACTION_S * (kmh / 3.6);
}

export type BrakePhase = "coast" | "brake";

export interface BrakeHint {
  readonly phase: BrakePhase;
  /** The new limit, km/h. */
  readonly target: number;
  /** Metres to the sign, never below 0. */
  readonly distance: number;
}

/**
 * The hint for one moment, without memory: the most urgent drop ahead (not yet passed) whose
 * rolling point has been reached. `alongNow` is where the car is on the route.
 */
export function brakeHintAt(drops: readonly LimitDrop[], alongNow: number, kmh: number | null): BrakeHint | null {
  if (kmh === null || !Number.isFinite(kmh)) return null;
  let best: BrakeHint | null = null;
  let bestSlack = Number.POSITIVE_INFINITY;
  for (const drop of drops) {
    const distance = drop.along - alongNow;
    if (distance > LOOKAHEAD_M) break;
    // A new hint only for a sign still ahead; one already showing is kept past it by BrakeAdvisor.
    if (distance < 0) continue;
    if (kmh <= drop.to + CLEAR_MARGIN_KMH) continue;
    const d = Math.max(0, distance);
    const coast = coastPoint(kmh, drop.to);
    if (d > coast) continue;
    const phase: BrakePhase = d <= brakePoint(kmh, drop.to) ? "brake" : "coast";
    // The drop that leaves the least room is the one to talk about.
    const slack = d - brakePoint(kmh, drop.to);
    if (slack < bestSlack) { bestSlack = slack; best = { phase, target: drop.to, distance: d }; }
  }
  return best;
}

/**
 * The hint as the wearer sees it: once shown for a drop it stays (and may only
 * go from "coast" to "brake") until the speed is within CLEAR_MARGIN_KMH of the
 * new limit or the sign lies PASSED_KEEP_M behind. Slowing down while rolling
 * shrinks the rolling distance; without this memory the hint would vanish
 * before the car is slow enough and come back again.
 */
export class BrakeAdvisor {
  private held: { drop: LimitDrop; phase: BrakePhase } | null = null;

  update(drops: readonly LimitDrop[], alongNow: number, kmh: number | null): BrakeHint | null {
    const fresh = brakeHintAt(drops, alongNow, kmh);
    if (this.held) {
      const { drop } = this.held;
      const distance = drop.along - alongNow;
      const cleared = kmh === null || kmh <= drop.to + CLEAR_MARGIN_KMH || distance < -PASSED_KEEP_M || !drops.includes(drop);
      if (cleared) this.held = null;
      else if (!fresh || fresh.target === drop.to) {
        const d = Math.max(0, distance);
        const phase: BrakePhase = this.held.phase === "brake" || d <= brakePoint(kmh, drop.to) ? "brake" : "coast";
        this.held = { drop, phase };
        return { phase, target: drop.to, distance: d };
      }
    }
    if (!fresh) return null;
    const drop = drops.find((candidate) => candidate.to === fresh.target && Math.abs(Math.max(0, candidate.along - alongNow) - fresh.distance) < 1e-6) ?? null;
    if (drop) this.held = { drop, phase: fresh.phase };
    return fresh;
  }

  reset(): void {
    this.held = null;
  }
}

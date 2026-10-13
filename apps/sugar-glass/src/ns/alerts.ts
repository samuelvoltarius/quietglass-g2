import { delta, type Reading } from "./model";

/** Limits, always in mg/dL. */
export interface Limits {
  /** Target range shown as the band in the curve. */
  readonly targetLow: number;
  readonly targetHigh: number;
  /** Below: "very low" (urgent). */
  readonly urgentLow: number;
  /** Below: "low". */
  readonly low: number;
  /** Above: "high". */
  readonly high: number;
  /** Older than this many minutes: "no current value". */
  readonly staleMinutes: number;
}

export const DEFAULT_LIMITS: Limits = { targetLow: 70, targetHigh: 180, urgentLow: 54, low: 70, high: 250, staleMinutes: 15 };

export type AlertKind = "urgentLow" | "low" | "high" | "stale" | "fallingFast" | "risingFast" | "noData";

export interface Alert {
  readonly kind: AlertKind;
  /** Critical alerts pulse on the glasses. */
  readonly critical: boolean;
}

/** Falling at least this much per 5 minutes counts as "falling fast" (3 mg/dL per minute). */
export const FAST_DROP = -15;
export const FAST_RISE = 15;

/** Keeps the limits sane whatever was typed. */
export function normaliseLimits(raw: Partial<Limits>): Limits {
  const pick = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
  const urgentLow = pick(raw.urgentLow, DEFAULT_LIMITS.urgentLow, 40, 80);
  const low = Math.max(urgentLow, pick(raw.low, DEFAULT_LIMITS.low, 50, 120));
  const high = pick(raw.high, DEFAULT_LIMITS.high, 120, 400);
  const targetLow = pick(raw.targetLow, DEFAULT_LIMITS.targetLow, 50, 140);
  const targetHigh = Math.max(targetLow + 10, pick(raw.targetHigh, DEFAULT_LIMITS.targetHigh, 100, 300));
  return { targetLow, targetHigh, urgentLow, low, high, staleMinutes: pick(raw.staleMinutes, DEFAULT_LIMITS.staleMinutes, 6, 60) };
}

/**
 * What needs attention, worst first. A stale value is not judged as low or
 * high any more (it may be long over), only reported as stale.
 */
export function alerts(readings: readonly Reading[], limits: Limits, now: number): Alert[] {
  const newest = readings[0];
  if (!newest) return [{ kind: "noData", critical: false }];
  const ageMinutes = (now - newest.at) / 60_000;
  if (ageMinutes > limits.staleMinutes) return [{ kind: "stale", critical: true }];
  const out: Alert[] = [];
  const change = delta(readings);
  const falling = newest.direction === "DoubleDown" || newest.direction === "TripleDown" || (change !== null && change <= FAST_DROP);
  const rising = newest.direction === "DoubleUp" || newest.direction === "TripleUp" || (change !== null && change >= FAST_RISE);
  if (newest.mgdl < limits.urgentLow) out.push({ kind: "urgentLow", critical: true });
  else if (newest.mgdl < limits.low) out.push({ kind: "low", critical: true });
  else if (newest.mgdl > limits.high) out.push({ kind: "high", critical: true });
  if (falling) out.push({ kind: "fallingFast", critical: true });
  else if (rising && newest.mgdl > limits.targetHigh) out.push({ kind: "risingFast", critical: false });
  return out;
}

export function isCritical(list: readonly Alert[]): boolean {
  return list.some((a) => a.critical);
}

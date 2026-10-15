import { magnitude, type Vec3 } from "./vector";

/**
 * Sensor test: shows what the IMU actually sends.
 *
 * The SDK documents `{x, y, z}` as plain doubles — no unit, no axis
 * convention, not even whether it is an accelerometer, a gyroscope or a fused
 * orientation. These helpers keep the raw numbers honest so the user can find
 * out with the glasses on: live values, magnitude, sample rate, min/max since
 * start, the axis that moved most, and a 20 s recording as CSV.
 *
 * Everything here is pure (time comes in as an argument) and tested.
 */

export type Axis = "x" | "y" | "z";
export const AXES: readonly Axis[] = ["x", "y", "z"];

export interface AxisRange { readonly min: number; readonly max: number }

export interface SensorStats {
  readonly count: number;
  readonly last: Vec3 | null;
  readonly lastMagnitude: number | null;
  readonly range: Readonly<Record<Axis, AxisRange>> | null;
  readonly magnitudeRange: AxisRange | null;
  /** Sum of |change| per axis between consecutive samples. */
  readonly travel: Readonly<Record<Axis, number>>;
  /** Arrival times of the most recent samples, oldest first (for the rate). */
  readonly recent: readonly number[];
}

/** How many arrival times the rate is averaged over. */
export const RATE_WINDOW = 20;
/** Samples older than this no longer count towards the rate (sensor stopped). */
export const RATE_MAX_AGE_MS = 3000;

export function createStats(): SensorStats {
  return { count: 0, last: null, lastMagnitude: null, range: null, magnitudeRange: null, travel: { x: 0, y: 0, z: 0 }, recent: [] };
}

function widen(range: AxisRange | undefined, value: number): AxisRange {
  return range ? { min: Math.min(range.min, value), max: Math.max(range.max, value) } : { min: value, max: value };
}

export function addToStats(stats: SensorStats, sample: Vec3, now: number): SensorStats {
  const m = magnitude(sample);
  const prev = stats.last;
  const range = {
    x: widen(stats.range?.x, sample.x),
    y: widen(stats.range?.y, sample.y),
    z: widen(stats.range?.z, sample.z),
  };
  const travel = prev
    ? {
      x: stats.travel.x + Math.abs(sample.x - prev.x),
      y: stats.travel.y + Math.abs(sample.y - prev.y),
      z: stats.travel.z + Math.abs(sample.z - prev.z),
    }
    : stats.travel;
  return {
    count: stats.count + 1,
    last: sample,
    lastMagnitude: m,
    range,
    magnitudeRange: widen(stats.magnitudeRange ?? undefined, m),
    travel,
    recent: [...stats.recent, now].slice(-RATE_WINDOW),
  };
}

/**
 * Samples per second over the recent window; null with fewer than two
 * samples, or when the newest one is older than RATE_MAX_AGE_MS.
 */
export function sampleRate(recent: readonly number[], now: number): number | null {
  const fresh = recent.filter((at) => now - at <= RATE_MAX_AGE_MS);
  if (fresh.length < 2) return null;
  const first = fresh[0]!;
  const last = fresh[fresh.length - 1]!;
  if (last <= first) return null;
  return ((fresh.length - 1) * 1000) / (last - first);
}

/**
 * The axis that changed most since start: by total travel (sum of
 * |changes|), which a back-and-forth head turn drives up even when it ends
 * where it began. Null until something moved at all.
 */
export function mostChangedAxis(stats: SensorStats): Axis | null {
  let best: Axis | null = null;
  let bestValue = 0;
  for (const axis of AXES) {
    const value = stats.travel[axis];
    if (value > bestValue) { best = axis; bestValue = value; }
  }
  return best;
}

/** Two decimals, a real minus sign kept narrow, "--" for nothing. */
export function fmt2(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  const fixed = value.toFixed(2);
  return fixed === "-0.00" ? "0.00" : fixed;
}

// ---------------------------------------------------------------- recording

export interface RecordedSample {
  /** Milliseconds since the recording started. */
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Recording {
  readonly startedAt: number;
  readonly durationMs: number;
  readonly samples: readonly RecordedSample[];
}

export const RECORD_MS = 20_000;

export function startRecording(now: number, durationMs = RECORD_MS): Recording {
  return { startedAt: now, durationMs, samples: [] };
}

export function recordingDone(rec: Recording, now: number): boolean {
  return now - rec.startedAt >= rec.durationMs;
}

/** Adds a sample; samples after the end are ignored. */
export function record(rec: Recording, sample: Vec3, now: number): Recording {
  if (recordingDone(rec, now) || now < rec.startedAt) return rec;
  return { ...rec, samples: [...rec.samples, { t: now - rec.startedAt, x: sample.x, y: sample.y, z: sample.z }] };
}

/**
 * The guided procedure, one step at a time. Each step has a start offset;
 * the step labels (de/en) live in messages.ts under `s.step1` … `s.step5`.
 */
export const GUIDE_STEPS: readonly { readonly key: string; readonly fromMs: number }[] = [
  { key: "s.step1", fromMs: 0 }, // still, looking straight ahead, 3 s
  { key: "s.step2", fromMs: 3_000 }, // turn head left
  { key: "s.step3", fromMs: 7_000 }, // turn head right
  { key: "s.step4", fromMs: 11_000 }, // nod
  { key: "s.step5", fromMs: 15_000 }, // tilt head sideways
];

/** Index (0…4) of the step for an elapsed time; the last step runs to the end. */
export function guideStep(elapsedMs: number): number {
  let index = 0;
  GUIDE_STEPS.forEach((step, i) => { if (elapsedMs >= step.fromMs) index = i; });
  return index;
}

/**
 * CSV with a header row; every sample gets the guide step it fell into, so
 * the file can be read without remembering the timing. Full precision (no
 * rounding) because the point is to see what the sensor really sends.
 */
export function toCsv(rec: Recording, pace: number): string {
  const lines = [`# PostureLens IMU recording; pace=${pace} (SDK ImuReportPace, unit unknown); started=${new Date(rec.startedAt).toISOString()}`];
  lines.push("t_ms,step,x,y,z,magnitude");
  for (const s of rec.samples) {
    const m = magnitude(s);
    lines.push([s.t, guideStep(s.t) + 1, s.x, s.y, s.z, Number(m.toFixed(6))].join(","));
  }
  return lines.join("\n") + "\n";
}

/** File name for the download, from the start time (no personal data). */
export function csvFileName(rec: Recording): string {
  const iso = new Date(rec.startedAt).toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
  return `posturelens-imu-${iso}.csv`;
}

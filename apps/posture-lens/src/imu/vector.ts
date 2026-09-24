/**
 * Vector maths for head orientation.
 *
 * The Even Hub SDK reports IMU samples as `{x, y, z}` and documents neither the
 * unit nor the axis orientation. PostureLens therefore never interprets the
 * axes: it measures the **angle between the current sample and a reference
 * sample the user calibrated while sitting upright**.
 *
 * That angle is well defined for any orthogonal axis convention and any linear
 * unit, because the angle between two vectors is invariant under rotation and
 * uniform scaling. The only assumption is that a still head produces a vector
 * dominated by gravity, which is true of any accelerometer at rest.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

export function magnitude(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/** Null for a zero-length vector, which carries no direction. */
export function normalise(v: Vec3): Vec3 | null {
  const m = magnitude(v);
  if (m === 0 || !Number.isFinite(m)) return null;
  return { x: v.x / m, y: v.y / m, z: v.z / m };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Angle between two directions, in degrees (0…180).
 * Null when either vector has no direction.
 */
export function angleBetween(a: Vec3, b: Vec3): number | null {
  const na = normalise(a);
  const nb = normalise(b);
  if (!na || !nb) return null;
  // Clamp guards against floating point pushing the cosine just past ±1.
  const cosine = Math.min(1, Math.max(-1, dot(na, nb)));
  return (Math.acos(cosine) * 180) / Math.PI;
}

/**
 * Exponential moving average over samples.
 *
 * Head motion is constant and mostly irrelevant — a glance, a nod, a step.
 * Smoothing is what separates "looking down at your desk for a second" from
 * "holding your head forward for twenty minutes", and it runs on the vector
 * rather than the angle so that direction, not just magnitude, is averaged.
 */
export function smooth(previous: Vec3 | null, sample: Vec3, factor: number): Vec3 {
  if (!previous) return sample;
  const f = Math.min(1, Math.max(0, factor));
  return {
    x: previous.x + (sample.x - previous.x) * f,
    y: previous.y + (sample.y - previous.y) * f,
    z: previous.z + (sample.z - previous.z) * f,
  };
}

/** Reads a sample out of an SDK IMU payload, tolerating missing fields. */
export function sampleFrom(imuData: unknown): Vec3 | null {
  if (!imuData || typeof imuData !== "object") return null;
  const record = imuData as Record<string, unknown>;
  const x = numberOrNull(record["x"]);
  const y = numberOrNull(record["y"]);
  const z = numberOrNull(record["z"]);
  // proto3 omits zero-valued fields, so a missing axis means 0 — but a sample
  // with no axes at all is not a reading.
  if (x === null && y === null && z === null) return null;
  return { x: x ?? 0, y: y ?? 0, z: z ?? 0 };
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

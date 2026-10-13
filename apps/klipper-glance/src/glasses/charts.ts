import { CURVE_WINDOW_MS, type TempSample } from "../printer/history";
import { DIM, FULL, createBitmap, drawText, fillRect, line, textWidth, type Bitmap } from "./gfx";

/** Progress ring, left of the text. */
export const RING_SIZE = 144;
/** Nozzle curve under the ring and the text. */
export const CURVE_WIDTH = 288;
export const CURVE_HEIGHT = 64;

const RING_OUTER = 69;
const RING_INNER = 55;

/**
 * A ring that fills clockwise from the top as the print advances, with the
 * percentage in large pixel digits inside. Pure function of the percentage, so
 * the picture only changes (and is only resent) when the percentage does.
 */
export function ringFrame(percent: number, size = RING_SIZE): Bitmap {
  const value = Math.max(0, Math.min(100, Math.round(Number.isFinite(percent) ? percent : 0)));
  const b = createBitmap(size, size);
  const c = (size - 1) / 2;
  const sweep = (value / 100) * Math.PI * 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - c;
      const dy = y - c;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r < RING_INNER || r > RING_OUTER) continue;
      // Angle from twelve o'clock, clockwise.
      let angle = Math.atan2(dx, -dy);
      if (angle < 0) angle += Math.PI * 2;
      b.pixels[y * size + x] = value >= 100 || angle <= sweep ? FULL : DIM;
    }
  }
  const digits = String(value);
  const scale = digits.length >= 3 ? 5 : 6;
  const digitHeight = 7 * scale;
  const sign = 3;
  const gap = 6;
  const top = Math.round((size - (digitHeight + gap + 7 * sign)) / 2);
  drawText(b, digits, Math.round((size - textWidth(digits, scale)) / 2), top, scale);
  drawText(b, "%", Math.round((size - textWidth("%", sign)) / 2), top + digitHeight + gap, sign);
  return b;
}

/**
 * The nozzle temperature over the last five minutes: newest on the right,
 * highest and lowest value as small numbers on the left, the target as a
 * dotted line. Pure function of the samples, so it changes only with new data.
 */
export function curveFrame(samples: readonly TempSample[], width = CURVE_WIDTH, height = CURVE_HEIGHT): Bitmap {
  const b = createBitmap(width, height);
  const left = 26;
  const right = width - 4;
  const top = 4;
  const bottom = height - 5;
  fillRect(b, left, bottom + 1, right - left + 1, 1, DIM);
  if (samples.length === 0) return b;

  const latest = samples[samples.length - 1]!;
  const target = latest.target > 0 ? latest.target : null;
  const values = samples.map((s) => s.now);
  let low = Math.min(...values, ...(target === null ? [] : [target]));
  let high = Math.max(...values, ...(target === null ? [] : [target]));
  if (high - low < 20) {
    const middle = (high + low) / 2;
    low = middle - 10;
    high = middle + 10;
  }
  low = Math.floor(low);
  high = Math.ceil(high);
  const y = (value: number): number => bottom - ((value - low) / (high - low)) * (bottom - top);
  const x = (t: number): number => right - Math.min(1, (latest.t - t) / CURVE_WINDOW_MS) * (right - left);

  if (target !== null) {
    const ty = Math.round(y(target));
    for (let px = left; px <= right; px += 4) fillRect(b, px, ty, 2, 1, DIM);
  }
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1]!;
    const c = samples[i]!;
    line(b, x(a.t), y(a.now), x(c.t), y(c.now), FULL, 2);
  }
  fillRect(b, x(latest.t) - 2, y(latest.now) - 2, 5, 5, FULL);
  drawText(b, String(high), 0, 1, 1, FULL);
  drawText(b, String(low), 0, height - 9, 1, FULL);
  return b;
}

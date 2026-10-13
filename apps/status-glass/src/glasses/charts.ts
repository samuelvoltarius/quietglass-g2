import { problems, unacknowledgedProblems, type SourceStatus } from "../monitor/dashboard";
import { SPARK_POINTS, type SparkSeries } from "../monitor/history";
import { DIM, FULL, MID, createBitmap, drawText, fillRect, iconBitmap, line, strokeRect, textWidth, type Bitmap } from "./gfx";

/** The status sign sits in the top-right corner of the header. */
export const ICON_WIDTH = 64;
export const ICON_HEIGHT = 30;

/** One sparkline picture; three of them side by side span the display. */
export const SPARK_WIDTH = 188;
export const SPARK_HEIGHT = 64;

/** One pulse per second: bright for 500 ms, dim for 500 ms. */
export const PULSE_MS = 500;

/**
 * Draws a series as a line chart with its label and latest value on top.
 * Percent metrics use a fixed 0..100 scale so a quiet 5 % does not look like a
 * crisis; other units scale to the readings. The newest reading is the dot on
 * the right edge. Pure: the same series always gives the same picture.
 */
export function sparklineFrame(series: SparkSeries, width = SPARK_WIDTH, height = SPARK_HEIGHT): Bitmap {
  const b = createBitmap(width, height);
  const last = series.values[series.values.length - 1] ?? 0;
  const shown = Math.abs(last) >= 100 || Number.isInteger(last) ? String(Math.round(last)) : last.toFixed(1);
  const head = `${series.label} ${shown}${series.unit === "%" ? "%" : ""}`;
  drawText(b, head, 2, 1, 2, series.state === "critical" || series.state === "warn" ? FULL : MID);

  const top = 20;
  const bottom = height - 4;
  const left = 3;
  const right = width - 5;
  const percent = series.unit === "%";
  let low = percent ? 0 : Math.min(...series.values);
  let high = percent ? 100 : Math.max(...series.values);
  if (!percent && high - low < Math.max(1, Math.abs(high) * 0.1)) {
    const pad = Math.max(1, Math.abs(high) * 0.05);
    low -= pad;
    high += pad;
  }
  const y = (value: number): number => {
    const t = (Math.min(high, Math.max(low, value)) - low) / (high - low);
    return bottom - t * (bottom - top);
  };

  // Baseline, and a dotted line where the warning starts.
  fillRect(b, left, bottom + 1, right - left + 1, 1, DIM);
  if (series.warn !== undefined && series.warn >= low && series.warn <= high) {
    const wy = Math.round(y(series.warn));
    for (let x = left; x <= right; x += 4) fillRect(b, x, wy, 2, 1, DIM);
  }

  const count = series.values.length;
  const span = right - left;
  const step = span / (SPARK_POINTS - 1);
  const points = series.values.map((value, i) => ({ x: right - (count - 1 - i) * step, y: y(value) }));
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const c = points[i]!;
    line(b, a.x, a.y, c.x, c.y, FULL, 2);
  }
  const tip = points[points.length - 1]!;
  fillRect(b, tip.x - 2, tip.y - 2, 5, 5, FULL);
  if (series.state === "critical") strokeRect(b, 0, 0, width, height, DIM);
  return b;
}

/** What the header sign shows: calm when fine, a quiet warning, or the pulsing alarm. */
export type SignState = "ok" | "unknown" | "warn" | "critical";

/**
 * The state the sign shows. An acknowledged problem has been seen: it no
 * longer pulses, it keeps a calm warning until it is gone.
 */
export function signState(sources: readonly SourceStatus[], now: number): SignState {
  if (sources.length === 0) return "unknown";
  const open = unacknowledgedProblems(sources, now);
  if (open.some((p) => p.state === "critical")) return "critical";
  if (open.some((p) => p.state === "warn")) return "warn";
  if (open.some((p) => p.state === "unknown")) return "unknown";
  return problems(sources, now).length > 0 ? "warn" : "ok";
}

const CHECK = ["......", ".....#", "....##", "#..##.", ".###..", "..#..."];
const QUESTION = [".####.", "#....#", ".....#", "...##.", "......", "...#.."];
const TRIANGLE = ["....##....", "....##....", "...####...", "...#..#...", "..##..##..", "..######.."];

/**
 * The 64 x 30 sign. Critical pulses at 1 Hz: the frame is bright for half a
 * second and dim for the next half, the "!" stays. A warning is a calm,
 * unmoving triangle.
 */
export function signFrame(state: SignState, now: number): Bitmap {
  switch (state) {
    case "ok": return iconBitmap(CHECK, ICON_WIDTH, ICON_HEIGHT);
    case "unknown": return iconBitmap(QUESTION, ICON_WIDTH, ICON_HEIGHT);
    case "warn": return iconBitmap(TRIANGLE, ICON_WIDTH, ICON_HEIGHT);
    case "critical": {
      const b = createBitmap(ICON_WIDTH, ICON_HEIGHT);
      const bright = Math.floor(now / PULSE_MS) % 2 === 0;
      // Bright: a thick frame. Dim: a thin one, so the pulse stays visible whatever the gray levels do.
      strokeRect(b, 1, 1, ICON_WIDTH - 2, ICON_HEIGHT - 2, bright ? FULL : DIM, bright ? 3 : 1);
      const scale = 3;
      drawText(b, "!", Math.floor((ICON_WIDTH - textWidth("!", scale)) / 2), Math.floor((ICON_HEIGHT - 7 * scale) / 2), scale, FULL);
      return b;
    }
  }
}

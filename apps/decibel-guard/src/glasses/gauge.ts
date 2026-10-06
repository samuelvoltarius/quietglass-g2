import { columnDivider, createBitmap, drawIcon, drawText, fillRect, MAX_LEVEL, quantize, strokeRect, textWidth, type Bitmap } from "./bitmap";

/**
 * DecibelGuard's two graphics.
 *
 * - **Dose bar** (below the text): today's dose as a long bar, 0 … 100 % of
 *   the daily limit, with a marker where the warning starts (50 %) and a box
 *   past the end that fills once the limit is exceeded. Readable at a glance
 *   while walking: how full is the bar, is it past the marker.
 * - **Level meter** (the icon column): the current level as a vertical bar
 *   with a tick at the criterion level (85 dB by default). While not
 *   measuring, the column shows the speaker icon instead.
 *
 * Both are drawn from quantised values, so an image is only redrawn — and
 * sent — when the picture would visibly change.
 */

export const METER = { id: 4, name: "pixel-icon", x: 0, y: 36, width: 96, height: 144 } as const;
export const DOSE_BAR = { id: 5, name: "dose-bar", x: 104, y: 164, width: 288, height: 80 } as const;

/** Level is shown in 3 dB steps: one step is one halving of the permitted time. */
export const LEVEL_STEP_DB = 3;
/** Dose is shown in 2 % steps. */
export const DOSE_STEP_PERCENT = 2;
/** The dose that turns the display to "high" (see noise/dose.ts doseLevel). */
export const WARN_PERCENT = 50;

/** Meter scale, bottom to top. */
export const METER_MIN_DB = 40;
export const METER_MAX_DB = 110;

const SPEAKER = ["..........", "...##.....", "..###...#.", "#####....#", "#####..#.#", "#####..#.#", "#####....#", "..###...#.", "...##.....", ".........."] as const;

/** Floors the dose to whole 2 % steps (never shows more than was measured), capped at 200 %. */
export function dosePercent(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  return Math.min(200, Math.floor((fraction * 100) / DOSE_STEP_PERCENT) * DOSE_STEP_PERCENT);
}

/** Next level to draw, in 3 dB steps with hysteresis against the one drawn now. */
export function meterLevel(previous: number | null, level: number | null): number | null {
  return quantize(previous, level, LEVEL_STEP_DB);
}

export interface MeterState {
  readonly listening: boolean;
  /** Quantised level, or null before audio arrives. */
  readonly level: number | null;
  readonly criterionDb: number;
}

export function meterKey(state: MeterState): string {
  return state.listening ? `on:${state.level ?? "-"}:${state.criterionDb}` : "icon";
}

/** Bar geometry inside the meter bitmap. */
const BAR = { x: 30, width: 26, top: 8, bottom: 134 } as const;

/** Pixel row of a level on the meter's scale (clamped to it). */
export function meterY(level: number): number {
  const share = (Math.min(METER_MAX_DB, Math.max(METER_MIN_DB, level)) - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB);
  return Math.round(BAR.bottom - share * (BAR.bottom - BAR.top));
}

export function drawMeter(state: MeterState): Bitmap {
  const bitmap = createBitmap(METER.width, METER.height);
  columnDivider(bitmap);
  if (!state.listening) { drawIcon(bitmap, SPEAKER); return bitmap; }
  strokeRect(bitmap, BAR.x - 2, BAR.top - 2, BAR.width + 4, BAR.bottom - BAR.top + 4, 4);
  if (state.level !== null) {
    const top = meterY(state.level);
    // Below the criterion the fill is dimmer; at or above it, full brightness.
    fillRect(bitmap, BAR.x, top, BAR.width, BAR.bottom - top + 1, state.level >= state.criterionDb ? MAX_LEVEL : 9);
  }
  const tick = meterY(state.criterionDb);
  fillRect(bitmap, BAR.x - 8, tick - 1, BAR.width + 16, 2, MAX_LEVEL);
  // The tick stays visible across a full bar.
  fillRect(bitmap, BAR.x, tick - 1, BAR.width, 2, state.level !== null && state.level >= state.criterionDb ? 0 : MAX_LEVEL);
  drawText(bitmap, String(Math.round(state.criterionDb)), BAR.x + BAR.width + 10, tick - 5, 2, MAX_LEVEL);
  return bitmap;
}

export function doseKey(percent: number): string {
  return `dose:${percent}`;
}

/** Track geometry inside the dose bitmap: 0 % at `left`, 100 % at `right`. */
const TRACK = { left: 2, right: 246, top: 12, height: 36 } as const;
const OVER = { x: 256, width: 30 } as const;

/** Pixel column of a dose percentage on the track (clamped to 0…100). */
export function doseX(percent: number): number {
  return Math.round(TRACK.left + (Math.min(100, Math.max(0, percent)) / 100) * (TRACK.right - TRACK.left));
}

export function drawDoseBar(percent: number, warnPercent: number = WARN_PERCENT): Bitmap {
  const bitmap = createBitmap(DOSE_BAR.width, DOSE_BAR.height);
  const { left, right, top, height } = TRACK;
  strokeRect(bitmap, left - 2, top - 2, right - left + 4, height + 4, 5);
  const end = doseX(percent);
  if (percent > 0) fillRect(bitmap, left, top, end - left, height, MAX_LEVEL);
  // Warning marker: a tall tick, cut black where the fill covers it.
  const marker = doseX(warnPercent);
  fillRect(bitmap, marker - 1, top - 8, 3, height + 16, MAX_LEVEL);
  if (end > marker - 1) fillRect(bitmap, marker - 1, top, 3, height, 0);
  // Past the limit: the box after the end fills and carries a plus.
  if (percent >= 100) {
    fillRect(bitmap, OVER.x, top - 2, OVER.width, height + 4, MAX_LEVEL);
    fillRect(bitmap, OVER.x + 7, top + height / 2 - 2, OVER.width - 14, 4, 0);
    fillRect(bitmap, OVER.x + OVER.width / 2 - 2, top + 9, 4, height - 18, 0);
  } else strokeRect(bitmap, OVER.x, top - 2, OVER.width, height + 4, 3);
  const labelY = top + height + 12;
  const warnLabel = `${warnPercent}%`;
  drawText(bitmap, warnLabel, marker - Math.floor(textWidth(warnLabel, 2) / 2), labelY, 2, 10);
  drawText(bitmap, "100%", right - textWidth("100%", 2), labelY, 2, 10);
  return bitmap;
}

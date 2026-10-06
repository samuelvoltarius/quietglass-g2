import { createBitmap, drawText, fillRect, line, MAX_LEVEL, plot, textWidth, type Bitmap } from "../glasses/bitmap";
import type { HourWeather } from "../rain/model";

/**
 * The next twelve hours as one picture: rain chance as bars, temperature as a
 * bright line over them, and three labels — now, +6h, +12h. Below the text,
 * on every view, so "will it rain, and when" never needs a swipe.
 *
 * The chart is drawn from quantised data (rain in 5 % steps, whole degrees),
 * and its key is that data, so the image is only sent again when the forecast
 * visibly changes — in practice once per refresh.
 */

export const CHART = { id: 6, name: "rain-chart", x: 104, y: 148, width: 288, height: 100 } as const;
export const CHART_HOURS = 12;
/** Rain chance is drawn in 5 % steps. */
export const RAIN_STEP = 5;

/** One hour per slot; bars stand on the baseline and reach the top at 100 %. */
const SLOT = CHART.width / CHART_HOURS;
const BAR_INSET = 3;
const TOP = 4;
const BASE = 78;
const LABEL_Y = BASE + 9;

export interface ChartData {
  /** Rain chance per hour, 0…100 in 5 % steps. */
  readonly rain: readonly number[];
  /** Temperature per hour, whole degrees. */
  readonly temperature: readonly number[];
  /** Label under the first hour (the app's word for "now"). */
  readonly nowLabel: string;
}

export function chartData(hours: readonly HourWeather[], nowLabel: string): ChartData {
  const next = hours.slice(0, CHART_HOURS);
  return {
    rain: next.map((hour) => Math.min(100, Math.max(0, Math.round(hour.precipitationProbability / RAIN_STEP) * RAIN_STEP))),
    temperature: next.map((hour) => Math.round(hour.temperature)),
    nowLabel,
  };
}

export function chartKey(data: ChartData): string {
  return `${data.nowLabel}|${data.rain.join(",")}|${data.temperature.join(",")}`;
}

/** Height in pixels of the bar for a rain chance. */
export function barHeight(rain: number): number {
  return Math.round((Math.min(100, Math.max(0, rain)) / 100) * (BASE - TOP));
}

/** Left edge of an hour's bar. */
export function barX(hour: number): number {
  return Math.round(hour * SLOT + BAR_INSET);
}

export const BAR_WIDTH = SLOT - 2 * BAR_INSET;
export const CHART_BASE = BASE;

/** Pixel row of each temperature: the warmest hour highest, at least a 6° span so small wobbles stay flat. */
export function temperatureRows(temperature: readonly number[]): number[] {
  if (temperature.length === 0) return [];
  const low = Math.min(...temperature); const high = Math.max(...temperature);
  const span = Math.max(6, high - low); const floor = (low + high) / 2 - span / 2;
  const top = TOP + 6; const bottom = BASE - 8;
  return temperature.map((value) => Math.round(bottom - ((value - floor) / span) * (bottom - top)));
}

export function drawChart(data: ChartData): Bitmap {
  const bitmap = createBitmap(CHART.width, CHART.height);
  // Faint guide at 50 %.
  for (let x = 0; x < CHART.width; x += 4) plot(bitmap, x, BASE - barHeight(50), 3);
  data.rain.forEach((rain, hour) => { const height = barHeight(rain); if (height > 0) fillRect(bitmap, barX(hour), BASE - height, BAR_WIDTH, height, 7); });
  fillRect(bitmap, 0, BASE, CHART.width, 1, 6);
  // Temperature: a bright line with a black edge, so it reads over the bars.
  const rows = temperatureRows(data.temperature);
  const points = rows.map((y, hour) => ({ x: Math.round(hour * SLOT + SLOT / 2), y }));
  for (const [thickness, level] of [[7, 0], [3, MAX_LEVEL]] as const) {
    points.forEach((point, index) => { const next = points[index + 1] ?? point; line(bitmap, point.x, point.y, next.x, next.y, level, thickness); });
  }
  // Ticks and labels: now, +6h, +12h.
  const ticks = [0, Math.round(6 * SLOT) - 1, CHART.width - 2];
  for (const x of ticks) fillRect(bitmap, x, BASE + 1, 2, 5, MAX_LEVEL);
  drawText(bitmap, data.nowLabel, 0, LABEL_Y, 2, 12);
  drawText(bitmap, "+6H", Math.round(6 * SLOT) - Math.floor(textWidth("+6H", 2) / 2), LABEL_Y, 2, 12);
  drawText(bitmap, "+12H", CHART.width - textWidth("+12H", 2), LABEL_Y, 2, 12);
  return bitmap;
}

/** The numbers beside the chart: when rain is most likely, and the temperature range. */
export function chartSummary(hours: readonly HourWeather[]): { readonly rain: number; readonly time: string; readonly low: number; readonly high: number } | null {
  const next = hours.slice(0, CHART_HOURS);
  const first = next[0];
  if (!first) return null;
  const wettest = next.reduce((best, hour) => hour.precipitationProbability > best.precipitationProbability ? hour : best, first);
  const temperatures = next.map((hour) => hour.temperature);
  return { rain: Math.round(wettest.precipitationProbability), time: wettest.time, low: Math.round(Math.min(...temperatures)), high: Math.round(Math.max(...temperatures)) };
}

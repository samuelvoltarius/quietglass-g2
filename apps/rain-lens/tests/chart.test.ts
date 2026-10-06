import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pixel } from "../src/glasses/bitmap";
import { createImageLane, type ImageTarget } from "../src/glasses/lane";
import { locales, tr } from "../src/i18n";
import { messages } from "../src/messages";
import { CHART_ROWS, LINE_WIDTH, SIDE_WIDTH, demoWeather, glassesBody, type HourWeather } from "../src/rain/model";
import { BAR_WIDTH, CHART, CHART_BASE, barHeight, barX, chartData, chartKey, chartSummary, drawChart, temperatureRows } from "../src/weather/chart";
import { ICONS, drawWeatherIcons, iconKey, iconKinds } from "../src/weather/icons";

const hour = (index: number, rain: number, temperature: number): HourWeather => ({ time: `2026-10-07T${String(8 + index).padStart(2, "0")}:00`, temperature, precipitationProbability: rain, precipitation: 0, weatherCode: 3, windSpeed: 10 });
const hours = (rain: number[], temperature: number[] = rain.map(() => 15)): HourWeather[] => rain.map((value, index) => hour(index, value, temperature[index] ?? 15));
/** Height of the lit run in a bar's middle column, from the baseline up. */
const barPixels = (bitmap: ReturnType<typeof drawChart>, index: number): number => {
  const x = barX(index) + 2; let y = CHART_BASE - 1; let count = 0;
  while (y >= 0 && pixel(bitmap, x, y) === 7) { count += 1; y -= 1; }
  return count;
};

describe("chart data", () => {
  it("quantises rain to 5 % steps and temperature to whole degrees", () => {
    const data = chartData(hours([12, 13, 61, 99, 101], [14.4, 14.6, 15, 15, 15]), "NOW");
    expect(data.rain).toEqual([10, 15, 60, 100, 100]);
    expect(data.temperature).toEqual([14, 15, 15, 15, 15]);
  });

  it("keeps the key when only invisible details change, and changes it otherwise", () => {
    const base = chartKey(chartData(hours([20, 40, 60], [10, 11, 12]), "NOW"));
    expect(chartKey(chartData(hours([21, 41, 59], [10.2, 11.3, 11.6]), "NOW"))).toBe(base);
    expect(chartKey(chartData(hours([20, 45, 60], [10, 11, 12]), "NOW"))).not.toBe(base);
    expect(chartKey(chartData(hours([20, 40, 60], [10, 11, 13]), "NOW"))).not.toBe(base);
    expect(chartKey(chartData(hours([20, 40, 60], [10, 11, 12]), "JETZT"))).not.toBe(base);
  });

  it("uses at most twelve hours", () => {
    expect(chartData(demoWeather().hourly, "NOW").rain).toHaveLength(12);
    expect(chartData(hours(Array.from({ length: 20 }, () => 50)), "NOW").rain).toHaveLength(12);
  });

  it("summarises the wettest hour and the temperature range for the side column", () => {
    expect(chartSummary(hours([10, 70, 75, 20], [9.6, 12, 14.4, 11]))).toEqual({ rain: 75, time: "2026-10-07T10:00", low: 10, high: 14 });
    expect(chartSummary([])).toBeNull();
  });
});

describe("chart pixels", () => {
  it("fits its image container", () => {
    const bitmap = drawChart(chartData(demoWeather().hourly, "NOW"));
    expect([bitmap.width, bitmap.height]).toEqual([CHART.width, CHART.height]);
    expect(CHART.width).toBeLessThanOrEqual(288);
    expect(CHART.height).toBeLessThanOrEqual(144);
    expect(CHART.y + CHART.height).toBeLessThanOrEqual(252);
    expect(Math.max(...bitmap.pixels)).toBeLessThanOrEqual(15);
  });

  it("draws bars in proportion to the rain chance", () => {
    // No temperature line, so nothing cuts the columns measured.
    const bitmap = drawChart({ rain: [0, 25, 50, 100], temperature: [], nowLabel: "NOW" });
    expect(barPixels(bitmap, 0)).toBe(0);
    expect(barHeight(100)).toBe(2 * barHeight(50));
    expect(barPixels(bitmap, 3)).toBeGreaterThan(barPixels(bitmap, 2));
    expect(barPixels(bitmap, 2)).toBeGreaterThan(barPixels(bitmap, 1));
    expect(barPixels(bitmap, 1)).toBe(barHeight(25));
    expect(barPixels(bitmap, 3)).toBe(barHeight(100));
    expect(BAR_WIDTH).toBeGreaterThan(10);
  });

  it("draws the warmest hour highest", () => {
    const rows = temperatureRows([10, 14, 18, 12]);
    expect(Math.min(...rows)).toBe(rows[2]);
    expect(Math.max(...rows)).toBe(rows[0]);
    // A one-degree wobble stays nearly flat.
    const flat = temperatureRows([15, 16]);
    expect(Math.abs((flat[0] ?? 0) - (flat[1] ?? 0))).toBeLessThan(15);
    const bitmap = drawChart(chartData(hours([0, 0, 0, 0], [10, 14, 18, 12]), "NOW"));
    expect(pixel(bitmap, 2 * 24 + 12, rows[2] ?? 0)).toBe(15);
  });

  it("marks now, +6h and +12h on the axis", () => {
    const bitmap = drawChart(chartData(demoWeather().hourly, "NOW"));
    for (const x of [0, 143, 286]) expect(pixel(bitmap, x, CHART_BASE + 3), `tick at ${x}`).toBe(15);
    const labels = (from: number, to: number): number => { let lit = 0; for (let y = CHART_BASE + 8; y < CHART.height; y += 1) for (let x = from; x < to; x += 1) if (pixel(bitmap, x, y) > 0) lit += 1; return lit; };
    expect(labels(0, 30)).toBeGreaterThan(0);
    expect(labels(130, 158)).toBeGreaterThan(0);
    expect(labels(250, 288)).toBeGreaterThan(0);
  });
});

describe("icon column", () => {
  const forecast = demoWeather();
  it("shows one icon per body row, and nothing for a notice", () => {
    expect(iconKinds(forecast, 0)).toHaveLength(1);
    expect(iconKinds(forecast, 1)).toHaveLength(4);
    expect(iconKinds(forecast, 1).length).toBeLessThanOrEqual(CHART_ROWS);
    expect(iconKinds(forecast, 2)).toHaveLength(3);
    expect(iconKinds(forecast, -1)).toEqual([]);
    const bitmap = drawWeatherIcons(forecast, 0);
    expect([bitmap.width, bitmap.height]).toEqual([ICONS.width, ICONS.height]);
    expect(bitmap.pixels.some((value) => value === 15)).toBe(true);
  });

  it("changes its key only when the icons change", () => {
    expect(iconKey(forecast, 0)).toBe(iconKey(demoWeather(), 0));
    expect(iconKey(forecast, 0)).not.toBe(iconKey(forecast, 1));
  });
});

describe("text around the chart", () => {
  it.each(locales)("%s notices fit the four rows above the chart", (locale) => {
    for (const key of ["glassLoading", "glassNoLocation", "glassOffline"]) {
      const lines = tr(messages, locale, key).split("\n");
      expect(lines.length, `${locale}.${key}`).toBeLessThanOrEqual(CHART_ROWS);
      for (const line of lines) expect(Array.from(line).length, `${locale}.${key}: ${line}`).toBeLessThanOrEqual(LINE_WIDTH);
      expect(glassesBody(lines, "", CHART_ROWS)).toEqual(lines);
    }
  });

  it.each(locales)("%s keeps the rain label for the side column uncut", (locale) => {
    expect(Array.from(tr(messages, locale, "chance")).length).toBeLessThanOrEqual(SIDE_WIDTH);
  });

  it("keeps an error row inside the four rows", () => {
    const body = glassesBody(["a", "b", "c", "d"], "timed out", CHART_ROWS);
    expect(body).toEqual(["a", "b", "c", "! timed out"]);
  });
});

describe("image lane", () => {
  const target: ImageTarget = CHART;
  let sent: number[];
  const send = async (_image: ImageTarget, data: Uint8Array): Promise<boolean> => { sent.push(data[0] ?? -1); return true; };
  beforeEach(() => { vi.useFakeTimers(); sent = []; });
  afterEach(() => { vi.useRealTimers(); });

  it("sends a chart once and not again for the same forecast", async () => {
    const lane = createImageLane(send, 3000);
    const key = chartKey(chartData(demoWeather().hourly, "NOW"));
    lane.request(target, key, () => new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 5; i += 1) { lane.request(target, chartKey(chartData(demoWeather().hourly, "NOW")), () => new Uint8Array([2])); await vi.advanceTimersByTimeAsync(5000); }
    expect(sent).toEqual([1]);
  });
});

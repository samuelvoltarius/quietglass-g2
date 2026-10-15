import { describe, expect, it } from "vitest";
import { cellBoxes, cellValueLayout, CELL_WIDTH, composeCockpit, headlineLayout } from "../src/cockpit/compose";
import { cockpitModel, headlineLines, nextHourGusts, playFrame, precipSlots, warningCell, type CockpitInput } from "../src/cockpit/model";
import { tr, type Locale } from "../src/i18n";
import { locales } from "../src/i18n";
import { messages } from "../src/messages";
import { demoWeather, type WeatherForecast } from "../src/rain/model";
import { createFrame, frameKey, tiles } from "../src/screen/frame";
import { pixelBackend, type TextBackend } from "../src/screen/text";

/** A pessimistic measuring backend: wide bold capitals (0.68 x size per character). */
const measuring: TextBackend = {
  name: "measure",
  measure: (text, font) => Math.round(Array.from(text).length * font.size * 0.68),
  render: (text, font) => { const width = Math.max(1, Math.round(Array.from(text).length * font.size * 0.68)); const height = Math.round(font.size * 0.7); return { width, height, baseline: height, left: 0, alpha: new Uint8Array(width * height).fill(255) }; },
};

const NOW = new Date("2026-10-07T13:20:00");
const live: WeatherForecast = { ...demoWeather(NOW), source: "live" };
const t = (locale: Locale) => (key: string, vars: Record<string, string | number> = {}) => tr(messages, locale, key, vars);
const input = (patch: Partial<CockpitInput> = {}): CockpitInput => ({ forecast: live, now: NOW.valueOf(), t: t("de"), locale: "de", notice: null, warning: null, gustLimit: null, place: "Salzburg", ...patch });

describe("cockpit model", () => {
  it("answers the headline from the 15-minute rain", () => {
    expect(cockpitModel(input()).headline).toEqual(["REGEN IN", "~40 MIN"]);
    expect(cockpitModel(input({ t: t("en"), locale: "en" })).headline).toEqual(["RAIN IN", "~40 MIN"]);
  });
  it("words every kind of answer in German and English", () => {
    const de = t("de"); const en = t("en");
    expect(headlineLines({ kind: "now", snow: false }, de)).toEqual(["REGNET", "JETZT"]);
    expect(headlineLines({ kind: "now", snow: true }, de)).toEqual(["SCHNEIT", "JETZT"]);
    expect(headlineLines({ kind: "soon", snow: true, minutes: 25 }, de)).toEqual(["SCHNEE IN", "~25 MIN"]);
    expect(headlineLines({ kind: "dryUntil", snow: false, time: "18:00" }, de)).toEqual(["TROCKEN", "BIS 18:00"]);
    expect(headlineLines({ kind: "dry" }, de)).toEqual(["TROCKEN"]);
    expect(headlineLines({ kind: "dryUntil", snow: false, time: "18:00" }, en)).toEqual(["DRY", "UNTIL 18:00"]);
  });
  it("falls back to the hourly rain when there are no 15-minute values", () => {
    const hourly: WeatherForecast = { ...live, minutely: [], utcOffsetSeconds: 0 };
    const slots = precipSlots(hourly);
    expect(slots).toHaveLength(live.hourly.length);
    expect(slots.every((slot) => slot.minutes === 60)).toBe(true);
  });
  it("fills the eight cells with units and a German decimal comma", () => {
    const cells = cockpitModel(input()).cells;
    expect(cells.map((cell) => cell.label)).toEqual(["TEMP", "GEFÜHLT", "FEUCHTE", "HIMMEL", "WIND km/h", "BÖEN km/h", "REGEN 2 H", "WARNUNG"]);
    expect(cells.map((cell) => cell.value)).toEqual(["15°", "14°", "72%", "BEWÖLKT", "SW 14", "24", "2,6 mm", "keine"]);
    expect(cockpitModel(input({ t: t("en"), locale: "en" })).cells[6]?.value).toBe("2.6 mm");
  });
  it("says what is going on instead of numbers while there is no forecast", () => {
    const model = cockpitModel(input({ forecast: demoWeather(NOW), notice: "glassNoLocation" }));
    expect(model.headline).toEqual(["KEIN", "STANDORT"]);
    expect(model.cells.every((cell) => cell.value === "–")).toBe(true);
    expect(model.windFrom).toBeNull();
  });
  it("shows an official warning with type and colour, before the gust alert", () => {
    const cell = warningCell({ ...input({ gustLimit: 10 }), warning: { type: "wind", level: 1, start: 0, end: Infinity } });
    expect(cell).toMatchObject({ value: "▲ STURM (gelb)", alert: true, span: 2 });
    expect(warningCell({ ...input(), t: t("en"), warning: { type: "thunder", level: 3, start: 0, end: Infinity } }).value).toBe("▲ THUNDER (red)");
  });
  it("raises the gust alert only when the next hour's gusts reach the setting", () => {
    expect(nextHourGusts(live)).toBe(24);
    expect(warningCell(input({ gustLimit: 24 })).value).toBe("▲ BÖEN 24");
    expect(warningCell(input({ gustLimit: 60 })).value).toBe("keine");
    expect(warningCell(input({ gustLimit: null })).alert).toBeUndefined();
    // Warnings unknown here (outside Austria, service down): a dash, not "none".
    expect(warningCell(input({ warning: undefined })).value).toBe("–");
  });
  it("captions the map with the frame time and the place", () => {
    const frameTimes = [NOW.valueOf() - 30 * 60_000, NOW.valueOf() - 20 * 60_000];
    const model = cockpitModel(input({ frameTimes, shownFrame: 0 }));
    expect(model.caption).toBe("12:50 · Salzburg");
    expect(model.loop.frames).toEqual([-30, -20]);
    expect(model.loop.shown).toBe(-30);
    // Without radar: the time of the forecast data, not the clock (that is top right).
    expect(cockpitModel(input({ place: "" })).caption).toBe(live.current.time.slice(11, 16));
  });
  it("plays the loop once, holds the newest frame a step, then stops", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((step) => playFrame(step, 6))).toEqual([0, 1, 2, 3, 4, 5, 5, null]);
    expect(playFrame(0, 0)).toBeNull();
  });
});

describe("cockpit layout", () => {
  it("lays out three rows of three columns, the warning spanning two", () => {
    const boxes = cellBoxes(cockpitModel(input()).cells);
    expect(boxes.map((box) => [box.x, box.y, box.width])).toEqual([
      [298, 118, 90], [388, 118, 90], [478, 118, 90],
      [298, 174, 90], [388, 174, 90], [478, 174, 90],
      [298, 230, 90], [388, 230, 180],
    ]);
    expect(Math.max(...boxes.map((box) => box.x + box.width))).toBeLessThanOrEqual(576);
    expect(Math.max(...boxes.map((box) => box.y + box.height))).toBeLessThanOrEqual(288);
  });
  it.each(locales)("%s: every cell value and the headline fit their room", (locale) => {
    const tl = t(locale);
    const models = [
      cockpitModel(input({ t: tl, locale })),
      cockpitModel(input({ t: tl, locale, warning: { type: "thunder", level: 2, start: 0, end: Infinity } })),
      cockpitModel(input({ t: tl, locale, gustLimit: 10 })),
    ];
    for (const model of models) {
      for (const box of cellBoxes(model.cells)) {
        const layout = cellValueLayout(measuring, box.cell.value, box.width);
        expect(measuring.measure(layout.text, layout.font), `${locale}: ${box.cell.value}`).toBeLessThanOrEqual(box.width - 8);
        // Values are shrunk before they are cut: nothing loses characters at these widths.
        expect(layout.text, `${locale}: ${box.cell.value}`).toBe(box.cell.value);
      }
      const head = headlineLayout(measuring, model.headline);
      head.lines.forEach((line) => expect(measuring.measure(line, head.font)).toBeLessThanOrEqual(270));
      expect(head.font.size).toBeGreaterThanOrEqual(24);
    }
    for (const key of ["cpRainNow", "cpSnowNow", "cpDry", "cpUnknown", "cp_glassLoading", "cp_glassNoLocation", "cp_glassOffline"]) {
      const lines = tl(key, { min: 25, time: "18:00" }).split("|").map((line) => line.toUpperCase());
      expect(lines.length, key).toBeLessThanOrEqual(2);
      const head = headlineLayout(measuring, lines);
      expect(head.lines, `${locale}.${key}`).toEqual(lines);
    }
    for (const key of ["cpRainIn", "cpSnowIn", "cpDryUntil"]) {
      const lines = tl(key, { min: 25, time: "18:00" }).split("|").map((line) => line.toUpperCase());
      expect(headlineLayout(measuring, lines).lines, `${locale}.${key}`).toEqual(lines);
    }
  });
  it("keeps the cell width the grid was planned with", () => { expect(CELL_WIDTH).toBe(90); });
});

describe("cockpit frame", () => {
  const backend = pixelBackend();
  it("draws the full display", () => {
    const frame = composeCockpit(cockpitModel(input()), backend);
    expect(frame.width).toBe(576); expect(frame.height).toBe(288);
    expect(frame.pixels.some((level) => level === 15)).toBe(true);
  });
  it("changes only the top-right tile when the clock moves", () => {
    const before = tiles(composeCockpit(cockpitModel(input()), backend)).map(frameKey);
    const after = tiles(composeCockpit(cockpitModel(input({ now: NOW.valueOf() + 60_000 })), backend)).map(frameKey);
    expect(before.map((key, index) => key !== after[index])).toEqual([false, true, false, false]);
  });
  it("changes only the left tiles when the radar steps", () => {
    const map = (level: number) => { const frame = createFrame(288, 218); frame.pixels.fill(level, 288 * 50, 288 * 150); return frame; };
    const frameTimes = [NOW.valueOf() - 20 * 60_000, NOW.valueOf() - 10 * 60_000];
    // The caption shows the frame time; same minute on both so only the picture differs.
    const a = tiles(composeCockpit(cockpitModel(input({ map: map(6), frameTimes: [frameTimes[1]!, frameTimes[1]!], shownFrame: 0 })), backend)).map(frameKey);
    const b = tiles(composeCockpit(cockpitModel(input({ map: map(9), frameTimes: [frameTimes[1]!, frameTimes[1]!], shownFrame: 1 })), backend)).map(frameKey);
    expect(a.map((key, index) => key !== b[index])).toEqual([true, false, true, false]);
  });
});

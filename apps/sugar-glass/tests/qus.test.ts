import { describe, expect, it } from "vitest";
import { arrowAngle, cockpitHint, cockpitModel, curvePoints, glucoseCells, glucoseModel, pumpModel, statusWord } from "../src/cockpit/model";
import { cellBoxes, composeCockpit, modelKey, type CockpitModel } from "../src/cockpit/compose";
import { createTileSender, tileSlots } from "../src/screen/sender";
import { frameKey, tiles } from "../src/screen/frame";
import { pixelBackend } from "../src/screen/text";
import { footer } from "../src/glasses/footer";
import { HEADER_WIDTH, PAGES, ROW_WIDTH, VISIBLE_ROWS, alertRow, headerLine, liveWord, startRows, startView, type ViewState } from "../src/glasses/views";
import { locales, type Locale } from "../src/i18n";
import { messages, t } from "../src/messages";
import { DEFAULT_LIMITS } from "../src/ns/alerts";
import { demoPump, demoReadings, demoTreatments, type DemoScene } from "../src/ns/demo";
import { EMPTY_SETTINGS } from "../src/storage/persist";
import { TABS, bannerFor, historyInner, isFirstRun, nowInner, pillOf, setupInner } from "../src/ui/phone";

// QUS v1: the pure parts of the cockpit and the start page - cells, headline, start rows, footer text, tile diff.
const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const backend = pixelBackend();

function state(over: Partial<ViewState> & { scene?: DemoScene; pump?: boolean } = {}): ViewState {
  const scene = over.scene ?? "normal";
  return {
    locale: "de", demo: false, connection: { kind: "ok" }, page: "glucose", unit: "mgdl", limits: DEFAULT_LIMITS, now: NOW,
    data: { readings: demoReadings(scene, NOW), pump: over.pump === false ? null : demoPump(scene, NOW), treatments: demoTreatments(NOW) },
    ...over,
  };
}
const noData: ViewState = { ...state(), data: null, connection: { kind: "loading" } };

describe("glucose cockpit: headline", () => {
  it("is the big value, then the trend as a word", () => {
    const model = glucoseModel(state());
    expect(model.headline[0]).toMatch(/^\d{2,3}$/);
    expect(model.headline[1]).toMatch(/STEIGT|STABIL|FÄLLT/);
  });
  it("the worst alert replaces the trend word, and the tone is critical", () => {
    const low = glucoseModel(state({ scene: "low" }));
    expect(low.headline[1]).toMatch(/NIEDRIG/);
    expect(low.tone).toBe("critical");
    expect(glucoseModel(state({ scene: "urgent" })).headline[1]).toBe("SEHR NIEDRIG");
    expect(glucoseModel(state({ scene: "high" })).headline[1]).toBe("HOCH");
  });
  it("stale: says so, never judges the old value, tone offline", () => {
    const model = glucoseModel(state({ scene: "stale", now: NOW }));
    expect(model.headline[1]).toBe("VERALTET");
    expect(model.tone).toBe("offline");
    expect(model.graphic).not.toHaveProperty("arrow");
  });
  it("the value is shown in the chosen unit (mmol/L with a decimal comma in German)", () => {
    expect(glucoseModel(state({ unit: "mmol" })).headline[0]).toMatch(/^\d{1,2},\d$/);
    expect(glucoseModel(state({ unit: "mmol", locale: "en" })).headline[0]).toMatch(/^\d{1,2}\.\d$/);
  });
  it("without data: dashes and the state in words", () => {
    expect(glucoseModel(noData).headline).toEqual(["–", "VERBINDE …"]);
    expect(glucoseModel({ ...noData, connection: { kind: "error", code: "timeout" } }).headline[1]).toBe("KEINE VERBINDUNG");
    expect(statusWord({ ...noData, data: { readings: [], pump: null, treatments: demoTreatments(NOW) } }, [])).toBe("KEINE WERTE");
  });
});

describe("glucose cockpit: cells, graphic, caption, hint", () => {
  it("trend, time and target, plus IOB, reservoir and sensor when a pump reports", () => {
    const cells = glucoseCells(state(), []);
    expect(cells.map((c) => c.label)).toEqual(["Trend", "Zeit", "Ziel", "IOB", "Reserv.", "Sensor"]);
    expect(cells[2]?.value).toBe("70–180");
    expect(glucoseCells(state({ pump: false }), [])).toHaveLength(3);
    expect(cellBoxes(cells).length).toBeLessThanOrEqual(6);
  });
  it("the cells that carry a warning are marked", () => {
    const s = state({ scene: "falling" });
    const cells = glucoseModel(s).cells;
    expect(cells.find((c) => c.label === "Trend")?.alert).toBe(true);
    expect(glucoseModel(state({ scene: "low" })).cells.find((c) => c.label === "Ziel")?.alert).toBe(true);
    expect(glucoseModel(state({ scene: "stale" })).cells.find((c) => c.label === "Zeit")?.alert).toBe(true);
    expect(glucoseModel(state()).cells.some((c) => c.alert)).toBe(false);
  });
  it("the graphic is the curve of the last three hours with the target band and the arrow", () => {
    const model = glucoseModel(state());
    expect(model.graphic.kind).toBe("spark");
    if (model.graphic.kind === "spark") {
      expect(model.graphic.band).toEqual({ low: 70, high: 180 });
      expect(model.graphic.points.length).toBeGreaterThan(20);
      expect(model.graphic.points.length).toBeLessThanOrEqual(37);
      expect(model.graphic.top).toBe("mg/dL");
      expect(model.graphic.arrow).toBeTypeOf("number");
    }
    expect(curvePoints(noData)).toEqual([]);
  });
  it("the arrow follows the direction: up, flat to the right, down", () => {
    expect([arrowAngle("SingleUp"), arrowAngle("Flat"), arrowAngle("DoubleDown"), arrowAngle("NONE")]).toEqual([0, 90, 180, undefined]);
  });
  it("the caption is the age; the first-start demo says so", () => {
    expect(glucoseModel(state()).caption).toMatch(/^vor \d+ min|gerade eben$/);
    expect(glucoseModel(state({ demoHint: true })).caption).toMatch(/^Demo · /);
  });
  it("the hint is one footer line with the page indicator, ending in 2×", () => {
    expect(cockpitHint("de", "glucose")).toBe("1/2 · Tippen = neu laden · Wischen = Pumpe · 2× = zurück");
    expect(cockpitHint("en", "pump")).toBe("2/2 · Tap = refresh · Swipe = glucose · 2× = back");
    for (const locale of locales) for (const page of PAGES) expect(cockpitHint(locale, page).length).toBeLessThanOrEqual(ROW_WIDTH);
  });
});

describe("pump cockpit", () => {
  it("IOB big, the mode as a word, bars for batteries and sensor, cells for reservoir, meal and bolus", () => {
    const model = pumpModel(state({ page: "pump" }));
    expect(model.headline).toEqual(["1,2 E", "AUTO"]);
    expect(model.graphic.kind).toBe("bars");
    expect(model.cells.map((c) => c.label)).toEqual(["Reserv.", "Sensor", "Stand", "Mahlzeit", "Bolus", "Zeit"]);
    expect(model.cells.find((c) => c.label === "Mahlzeit")?.value).toBe("45 g");
    expect(model.caption).toContain("MiniMed");
  });
  it("without a pump: a dash and one word, no cells", () => {
    const model = pumpModel(state({ page: "pump", pump: false }));
    expect(model.headline).toEqual(["–", "KEINE PUMPE"]);
    expect(model.cells).toEqual([]);
  });
  it("cockpitModel picks the page", () => {
    expect(cockpitModel(state({ page: "pump" })).graphic.kind).toBe("bars");
    expect(cockpitModel(state()).graphic.kind).toBe("spark");
  });
});

describe("start rows and the text page", () => {
  it("at most three entries: the glucose and the pump", () => {
    expect(startRows()).toEqual([{ kind: "glucose" }, { kind: "pump" }]);
    expect(startRows().length).toBeLessThanOrEqual(3);
  });
  it("header `Modus · ● live`, a dot on the cursor, one footer line", () => {
    const view = startView(state(), 1);
    expect(view.header).toBe("Sugar Glass · ● live");
    expect(view.body[0]).toMatch(/^ {2}Zucker · \d+ mg\/dL$/);
    expect(view.body[1]).toBe("● Pumpe · IOB 1,2 E");
    expect(view.footer).toBe("Tippen = öffnen · Wischen = wählen · 2× = Ende");
  });
  it("a critical alert gets its own row; the first-start demo says how to set up in one line", () => {
    expect(alertRow(state({ scene: "low" }))).toMatch(/^! NIEDRIG \d+ mg\/dL$/);
    expect(alertRow(state())).toBeNull();
    const view = startView(state({ demoHint: true }), 0);
    expect(view.header).toBe("Sugar Glass · Demo");
    expect(view.body.at(-1)).toBe("Demo · Verbindung am Handy einrichten");
    expect(view.body.length).toBeLessThanOrEqual(VISIBLE_ROWS);
  });
  it("the state word: live, stale, offline, demo", () => {
    expect(liveWord(state())).toBe("live");
    expect(liveWord(state({ scene: "stale" }))).toBe("stale");
    expect(liveWord(noData)).toBe("offline");
    expect(liveWord(state({ demo: true }))).toBe("demo");
    expect(headerLine("en", "Sugar Glass", "offline")).toBe("Sugar Glass · offline");
  });
  for (const locale of locales) {
    it(`${locale}: header, rows and footer fit their rows in every state, 2× is never dropped`, () => {
      const scenes: DemoScene[] = ["normal", "low", "urgent", "high", "stale", "falling"];
      for (const scene of scenes) {
        for (const demoHint of [false, true]) {
          const view = startView(state({ locale, scene, unit: "mmol", demoHint }), 0);
          expect(Array.from(view.header).length, view.header).toBeLessThanOrEqual(HEADER_WIDTH);
          expect(Array.from(view.footer).length, view.footer).toBeLessThanOrEqual(ROW_WIDTH);
          expect(view.footer.split(" · ").at(-1)?.startsWith("2× = ")).toBe(true);
          for (const row of view.body) expect(Array.from(row).length, row).toBeLessThanOrEqual(ROW_WIDTH);
        }
        expect(Array.from(glucoseModel(state({ locale, scene })).hint).length).toBeLessThanOrEqual(ROW_WIDTH);
      }
    });
  }
  it("the footer drops the swipe, then the hold, never the 2×", () => {
    expect(footer("de", { tap: "x".repeat(10), swipe: "y".repeat(40), hold: "z" }, "exit")).toBe(`Tippen = ${"x".repeat(10)} · Halten = z · 2× = Ende`);
  });
  it("no help page any more: no help keys in the texts", () => {
    for (const locale of locales) expect(Object.keys(messages[locale]).filter((key) => /help|m\./.test(key))).toEqual([]);
  });
});

describe("words", () => {
  it("both languages have every key", () => {
    const keys = Object.keys(messages.de).sort();
    for (const locale of locales) expect(Object.keys(messages[locale]).sort(), locale).toEqual(keys);
  });
  it("German never says Tap, Wisch, 2x or Doppeltipp; English never 2x", () => {
    const de = Object.values(messages.de).join("\n");
    expect(de).not.toMatch(/\bTap\b|\bWisch\b|\b2x\b|Doppeltipp/);
    expect(Object.values(messages.en).join("\n")).not.toMatch(/\b2x\b|Doppeltipp/);
  });
  it("the glasses never show a status code", () => {
    for (const locale of locales as readonly Locale[]) for (const key of Object.keys(messages[locale]).filter((k) => k.startsWith("g."))) expect(t(locale, key)).not.toMatch(/HTTP|\b50\d\b/);
  });
});

describe("tile diff", () => {
  const slots = tileSlots(21, "sugar");
  const frameOf = (m: CockpitModel) => composeCockpit(m, backend);
  it("an unchanged state draws the same frame, tile for tile", () => {
    const a = frameOf(glucoseModel(state())); const b = frameOf(glucoseModel(state()));
    expect(tiles(a).map(frameKey)).toEqual(tiles(b).map(frameKey));
  });
  it("the clock alone changes only the top right tile", () => {
    const base = glucoseModel(state());
    const a = tiles(frameOf(base)).map(frameKey); const b = tiles(frameOf({ ...base, clock: "14:06" })).map(frameKey);
    expect(b.map((key, i) => (key === a[i] ? 0 : 1))).toEqual([0, 1, 0, 0]);
  });
  it("the sender sends all four tiles once, then nothing for an identical frame, then only what changed", async () => {
    const sent: number[] = [];
    const sender = createTileSender(slots, async (slot) => { sent.push(slot.id); return true; }, (frame) => new Uint8Array(frame.pixels));
    const base = glucoseModel(state());
    await sender.push(frameOf(base));
    expect(sent).toHaveLength(4);
    await sender.push(frameOf(glucoseModel(state())));
    expect(sent).toHaveLength(4);
    await sender.push(frameOf({ ...base, clock: "14:06" }));
    expect(sent.slice(4)).toEqual([slots[1].id]);
  });
  it("modelKey changes exactly with what is drawn", () => {
    const a = glucoseModel(state());
    expect(modelKey(a)).toBe(modelKey(glucoseModel(state())));
    expect(modelKey(a)).not.toBe(modelKey({ ...a, clock: "14:06" }));
  });
});

describe("phone view models", () => {
  const ok = { kind: "ok" } as const;
  it("has exactly three tabs, Jetzt / Verlauf / Einstellungen", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["now", "history", "settings"]);
    expect(TABS.map((tab) => t("de", tab.key))).toEqual(["Jetzt", "Verlauf", "Einstellungen"]);
  });
  it("the hero value is the glucose, the stats are trend, target, IOB and reservoir, one refresh button, a card per pump fact", () => {
    const html = nowInner(state(), ok);
    expect(html).toContain("hero-card");
    expect(html).toContain('id="refresh"');
    expect(html).toContain('class="strip"');
    expect((html.match(/<div class="host/g) ?? []).length).toBe(4);
    expect(html).toContain("1,2 E");
    expect(html).toContain("70–180");
  });
  it("the banner carries the one message that counts", () => {
    expect(bannerFor(state(), ok).tone).toBe("ok");
    expect(bannerFor(state({ scene: "low" }), ok).tone).toBe("critical");
    expect(bannerFor(state({ scene: "stale" }), ok).tone).toBe("offline");
    expect(bannerFor(state(), { kind: "demo" }).tone).toBe("none");
    expect(bannerFor(state(), { kind: "error", reason: "nicht erreichbar" }).text).toContain("nicht erreichbar");
  });
  it("the pill shows the value, or the state in a word", () => {
    expect(pillOf(state(), ok).text).toMatch(/^\d+ mg\/dL$/);
    expect(pillOf(noData, { kind: "loading" }).text).toBe("lädt …");
    expect(pillOf(noData, { kind: "none" }).text).toBe("kein Server");
  });
  it("the history tab lists the latest values as cards and the last meal", () => {
    const html = historyInner(state());
    expect((html.match(/<div class="host/g) ?? []).length).toBe(12);
    expect(html).toContain("45 g");
    expect(historyInner(noData)).toContain("Noch keine Werte");
  });
  it("the first-run checklist has three steps and ticks them off", () => {
    expect(isFirstRun(EMPTY_SETTINGS, "")).toBe(true);
    expect(isFirstRun({ ...EMPTY_SETTINGS, url: "https://ns.example" }, "")).toBe(false);
    expect(setupInner(EMPTY_SETTINGS, false, "de", "").match(/<li/g)).toHaveLength(3);
    expect(setupInner({ ...EMPTY_SETTINGS, url: "https://ns.example" }, true, "de", "").match(/class="done"/g)).toHaveLength(3);
    expect(setupInner(EMPTY_SETTINGS, false, "de", "")).toContain("Demo");
  });
});

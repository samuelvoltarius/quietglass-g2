import { describe, expect, it } from "vitest";
import { cockpitHint, cockpitModel, cockpitPages, demoHistory, feedLabel, feedTone, feedWord, overviewCells, positionCells, type CockpitPage, type FeedStatus } from "../src/cockpit/model";
import { cellBoxes, composeCockpit, modelKey, type CockpitModel } from "../src/cockpit/compose";
import { createTileSender, tileSlots } from "../src/screen/sender";
import { createFrame, frameKey, tiles } from "../src/screen/frame";
import { pixelBackend } from "../src/screen/text";
import { footer, ROW_WIDTH } from "../src/glasses/footer";
import { LINE_WIDTH, VISIBLE_ROWS, listView, positionRow, startRows, startView } from "../src/glasses/view";
import { locales } from "../src/i18n";
import { TEXT, t } from "../src/text";
import { demoPositions, type Position } from "../src/markets/model";
import { TABS, bannerFor, isFirstRun, nowInner, positionsInner, setupInner, summarize, type PhoneState } from "../src/ui/phone";

// QUS v1: the pure parts of the cockpit and the start page - cells, headline, start rows, footer text, tile diff.
const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const backend = pixelBackend();
const live: FeedStatus = { source: "live", updatedAt: NOW - 5_000, failed: false, errors: [] };
const demo: FeedStatus = { source: "demo", updatedAt: NOW, failed: false, errors: [] };
const overview: CockpitPage = { kind: "overview" };
const long = (over: Partial<Position> = {}): Position => ({ provider: "polymarket", title: "T".repeat(80), outcome: "O".repeat(40), quantity: 1, currentValue: 1, pnl: 12345.67, price: 0.5, ...over });
const many = Array.from({ length: 7 }, (_, i) => long({ title: `Market ${i}`, pnl: i - 3 }));
const model = (positions: Position[], status = live, page: CockpitPage = overview, locale: "de" | "en" = "de"): CockpitModel =>
  cockpitModel({ positions, status, history: demoHistory(NOW), page, now: NOW, locale });

describe("cockpit headline", () => {
  it("the overview headline is the portfolio value, then the signed profit", () => {
    expect(model(demoPositions()).headline).toEqual(["$21.65", "+$1.90"]);
  });
  it("without positions it is a dash", () => {
    expect(model([]).headline).toEqual(["–"]);
  });
  it("a position's headline is its profit, then its outcome", () => {
    expect(model(demoPositions(), live, { kind: "position", index: 1 }).headline).toEqual(["-$0.60", "YES"]);
  });
});

describe("cockpit cells", () => {
  it("overview: positions, profit, realized, best, worst, source", () => {
    const cells = overviewCells(demoPositions(), demo, "en");
    expect(cells.map((c) => c.label)).toEqual(["Positions", "Profit", "Realized", "Best", "Worst", "Source"]);
    expect(cells.map((c) => c.value)).toEqual(["2", "+$1.90", "–", "+$2.50", "-$0.60", "Demo"]);
    expect(cells[4]?.alert).toBe(true);
  });
  it("never more than six cells, fitted to two rows of three", () => {
    expect(overviewCells(many, live, "de")).toHaveLength(6);
    expect(positionCells(many[0]!, 0, many.length, "de")).toHaveLength(6);
    const boxes = cellBoxes(overviewCells(many, live, "de"));
    expect(new Set(boxes.map((b) => b.y)).size).toBe(2);
  });
  it("a position: value, quantity, realized, provider, price and its place", () => {
    const cells = positionCells(demoPositions()[0]!, 0, 2, "en");
    expect(cells.map((c) => c.value)).toEqual(["$16.25", "25", "–", "Polymarket", "65c", "1/2"]);
  });
});

describe("cockpit pages, caption and hint", () => {
  it("walks the overview and every position", () => {
    expect(cockpitPages(demoPositions())).toEqual([{ kind: "overview" }, { kind: "position", index: 0 }, { kind: "position", index: 1 }]);
    expect(cockpitPages([])).toEqual([{ kind: "overview" }]);
  });
  it("the caption says when the data is from, and stale data says since when", () => {
    expect(model(demoPositions()).caption).toBe("Stand 14:04");
    expect(model(demoPositions(), { ...live, updatedAt: NOW - 120_000 }).caption).toBe("Alt seit 14:03");
    expect(model(demoPositions(), demo).caption).toBe("Demo");
  });
  it("the tone follows the feed: stale is offline, a failed provider is a warning", () => {
    expect(feedTone(live, NOW)).toBe("ok");
    expect(feedTone({ ...live, failed: true }, NOW)).toBe("offline");
    expect(feedTone({ ...live, errors: [{ provider: "kalshi", message: "x" }] }, NOW)).toBe("warn");
    expect(feedTone(demo, NOW)).toBe("ok");
  });
  it("the state words: ● live, Demo, veraltet with the age", () => {
    expect(feedLabel(feedWord(live, NOW), "de")).toBe("● live");
    expect(feedLabel(feedWord(demo, NOW), "de")).toBe("Demo");
    expect(feedLabel(feedWord({ ...live, updatedAt: NOW - 180_000 }, NOW), "de")).toBe("veraltet 3m");
  });
  it("the hint is one footer line, swipe only with more than one page", () => {
    expect(cockpitHint("de", 3)).toBe("Tippen = neu · Wischen = Seite · 2× = zurück");
    expect(cockpitHint("de", 1)).toBe("Tippen = neu · 2× = zurück");
  });
  it("the portfolio graphic is a curve of the value over time", () => {
    const m = model(demoPositions());
    expect(m.graphic.kind).toBe("spark");
    if (m.graphic.kind === "spark") { expect(m.graphic.points).toHaveLength(9); expect(m.graphic.bottom).toBe("seit 14:03"); }
    const one = cockpitModel({ positions: demoPositions(), status: live, history: [], page: overview, now: NOW, locale: "de" });
    if (one.graphic.kind === "spark") expect(one.graphic.bottom).toBe("");
  });
  it("a position's graphic is a gauge filled to its price", () => {
    const m = model(demoPositions(), live, { kind: "position", index: 0 });
    expect(m.graphic).toMatchObject({ kind: "gauge", value: 0.65, center: "65c" });
  });
});

describe("start rows and text pages", () => {
  it("at most three entries: here the overview and the positions", () => {
    expect(startRows(demoPositions())).toEqual([{ kind: "overview" }, { kind: "positions", count: 2 }]);
    expect(startRows([]).length).toBeLessThanOrEqual(3);
  });
  it("renders the cursor as a dot and the demo says so in one line", () => {
    const view = startView(demoPositions(), 1, demo, NOW, "de");
    expect(view.header).toBe("Market Glance · Demo");
    expect(view.body).toEqual(["  Übersicht · $21.65", "● Positionen · 2", "Demo · Verbindung am Handy einrichten"]);
    expect(view.footer).toBe("Tippen = öffnen · Wischen = wählen · 2× = Ende");
  });
  it("running screens carry `Modus · ● live` and one footer line ending with 2×", () => {
    const view = listView(many, 0, live, NOW, "en");
    expect(view.header).toBe("Positions · ● live");
    expect(view.footer).toBe("Tap = open · Swipe = select · 2× = back");
  });
  it("the list shows five rows at most, the cursor window follows, rows fit one line", () => {
    const view = listView(many, 6, live, NOW, "de");
    expect(view.body).toHaveLength(VISIBLE_ROWS);
    expect(view.body.filter((row) => row.startsWith("●"))).toHaveLength(1);
    expect(view.body.at(-1)?.startsWith("●")).toBe(true);
    for (const row of view.body) expect(Array.from(row).length).toBeLessThanOrEqual(LINE_WIDTH);
  });
  it("a row keeps price and profit whole, whatever the title length", () => {
    expect(positionRow(long({ price: 0.54 }), true).endsWith(" 54c +$12345.67")).toBe(true);
  });
  it("an empty list says so", () => {
    expect(listView([], 0, live, NOW, "en").body).toEqual(["No open positions"]);
  });
  for (const locale of locales) {
    it(`${locale}: header, footer and rows fit one line`, () => {
      const views = [startView(many, 0, demo, NOW, locale), listView(many, 0, live, NOW, locale), listView([], 0, live, NOW, locale)];
      for (const view of views) {
        expect(Array.from(view.header).length).toBeLessThanOrEqual(ROW_WIDTH);
        expect(Array.from(view.footer).length).toBeLessThanOrEqual(ROW_WIDTH);
        expect(view.footer.split(" · ").at(-1)?.startsWith("2× = ")).toBe(true);
      }
      expect(Array.from(cockpitHint(locale, 3)).length).toBeLessThanOrEqual(ROW_WIDTH);
    });
  }
  it("the footer drops the swipe, then the hold, never the 2×", () => {
    expect(footer("de", { tap: "x".repeat(10), swipe: "y".repeat(20), hold: "z" }, "exit")).toBe(`Tippen = ${"x".repeat(10)} · Halten = z · 2× = Ende`);
  });
});

describe("words", () => {
  it("every language has every key", () => {
    const keys = Object.keys(TEXT.de).sort();
    for (const locale of locales) expect(Object.keys(TEXT[locale]).sort(), locale).toEqual(keys);
  });
  it("fills placeholders", () => { expect(t("en", "dataAt", { time: "09:05" })).toBe("As of 09:05"); });
});

describe("tile diff", () => {
  const slots = tileSlots(21, "market");
  const frameOf = (m: CockpitModel) => composeCockpit(m, backend);
  it("an unchanged state draws the same frame, tile for tile", () => {
    const a = frameOf(model(demoPositions())); const b = frameOf(model(demoPositions()));
    expect(tiles(a).map(frameKey)).toEqual(tiles(b).map(frameKey));
    expect(frameKey(a)).not.toBe(frameKey(createFrame()));
  });
  it("the clock alone changes only the top right tile", () => {
    const base = model(demoPositions());
    const a = tiles(frameOf(base)).map(frameKey); const b = tiles(frameOf({ ...base, clock: "14:06" })).map(frameKey);
    expect(b.map((key, i) => (key === a[i] ? 0 : 1))).toEqual([0, 1, 0, 0]);
  });
  it("the sender sends all four tiles once, then nothing for an identical frame, then only what changed", async () => {
    const sent: number[] = [];
    const sender = createTileSender(slots, async (slot) => { sent.push(slot.id); return true; }, (frame) => new Uint8Array(frame.pixels));
    const base = model(demoPositions());
    await sender.push(frameOf(base));
    expect(sent).toHaveLength(4);
    await sender.push(frameOf(model(demoPositions())));
    expect(sent).toHaveLength(4);
    await sender.push(frameOf({ ...base, clock: "14:06" }));
    expect(sent.slice(4)).toEqual([slots[1].id]);
  });
  it("modelKey changes exactly with what is drawn", () => {
    const a = model(demoPositions());
    expect(modelKey(a)).toBe(modelKey(model(demoPositions())));
    expect(modelKey(a)).not.toBe(modelKey({ ...a, clock: "14:06" }));
  });
});

describe("phone view models", () => {
  const state = (over: Partial<PhoneState> = {}): PhoneState => ({ positions: demoPositions(), status: live, lastError: "", now: NOW, ...over });
  it("has exactly three tabs, Jetzt / Positionen / Einstellungen", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["now", "positions", "settings"]);
    expect(TABS.map((tab) => t("de", tab.key))).toEqual(["Jetzt", "Positionen", "Einstellungen"]);
  });
  it("the hero value is the portfolio, the stats are profit, realized, count and source", () => {
    expect(summarize(demoPositions())).toMatchObject({ count: 2, pnl: 1.9, sources: "P K" });
    const html = nowInner(state(), "de");
    expect(html).toContain("$21.65");
    expect(html).toContain("hero-card");
    expect(html).toContain('id="refresh"');
    expect(html).toContain('class="strip"');
  });
  it("the banner carries the one message that counts", () => {
    expect(bannerFor(state({ status: demo }), "de").tone).toBe("none");
    expect(bannerFor(state(), "de").tone).toBe("ok");
    expect(bannerFor(state({ status: { ...live, failed: true } }), "de").tone).toBe("offline");
    expect(bannerFor(state({ status: { ...live, errors: [{ provider: "kalshi", message: "x" }] } }), "de").text).toContain("Kalshi");
  });
  it("the positions tab lists a card per position", () => {
    expect(positionsInner(state(), "de").match(/class="card server/g)).toHaveLength(2);
    expect(positionsInner(state({ positions: [] }), "de")).toContain("Keine offenen Positionen");
  });
  it("the first-run checklist has three steps and ticks them off", () => {
    expect(isFirstRun(false)).toBe(true);
    expect(setupInner(false, false, "de").match(/<li/g)).toHaveLength(3);
    expect(setupInner(true, true, "de").match(/class="done"/g)).toHaveLength(3);
    expect(setupInner(false, false, "de")).toContain("Demo");
  });
});

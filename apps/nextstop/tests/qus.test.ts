import { describe, expect, it } from "vitest";
import {
  awayLabel, boardCells, boardHint, boardModel, boardRing, delayCell, lineLabel, modelKey, whenLabel, HINT_WIDTH, RING_MINUTES,
  type BoardInput,
} from "../src/cockpit/model";
import { arcStyle, cellBoxes, cellValueLayout, composeCockpit, composeTiles, headlineLayout } from "../src/cockpit/compose";
import { cockpitScene } from "../src/cockpit/scene";
import { createFrame, frameKey, tiles } from "../src/screen/frame";
import { createTileSender, tileSlots } from "../src/screen/sender";
import { pixelBackend } from "../src/screen/text";
import { headerLine, liveWord, startLabel, startRows, startView } from "../src/start";
import { TABS, delayText, isFirstRun, nowInner, pillOf, sampleBoard, setupInner, type PhoneBoard } from "../src/ui/phone";
import { EMPTY_PLACES, addFavorite } from "../src/route/places";
import type { Departure, Stop } from "../src/transit/types";

// QUS v1: the pure parts of the departures cockpit and the start page - cells, headline, start rows, footer text, tile diff.
const NOW = new Date(2026, 9, 17, 14, 5);
const backend = pixelBackend();
const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60000);
const STOP: Stop = { id: "s", name: "Salzburg Mirabellplatz (Schloss)", lat: 47.8, lon: 13.04 };

function dep(minutes: number, over: Partial<Departure> = {}): Departure {
  return {
    line: "3", headsign: "Salzburg Hbf via Kiesel", inMinutes: minutes, scheduled: at(minutes), expected: at(minutes),
    source: "realtime", track: "B", cancelled: false, tripId: `t${minutes}`, ...over,
  };
}

const input = (departures: Departure[], selected = 0, over: Partial<BoardInput> = {}): BoardInput =>
  ({ stop: STOP, departures, selected, metresAway: 120, now: NOW, locale: "de", ...over });

describe("cockpit headline", () => {
  it("is the line and the minutes on one big line, the direction under it", () => {
    const model = boardModel(input([dep(4), dep(9)]));
    expect(model.headline).toBe("BUS 3 · 4 MIN");
    expect(model.direction).toBe("→ SALZBURG HBF");
    expect(model.title).toBe("NEXTSTOP");
    expect(model.clock).toBe("14:05");
  });

  it("keeps a line the operator names itself, upper case, and says the moment in words", () => {
    expect(lineLabel("O-Bus 6", "de")).toBe("O-BUS 6");
    expect(lineLabel("S3", "en")).toBe("S3");
    expect(lineLabel("25", "en")).toBe("BUS 25");
    expect(whenLabel(dep(0), NOW, "de")).toBe("JETZT");
    expect(whenLabel(dep(0), NOW, "en")).toBe("NOW");
    expect(whenLabel(dep(75), NOW, "de")).toBe("1H15");
    expect(whenLabel(dep(5, { cancelled: true }), NOW, "de")).toBe("FÄLLT AUS");
  });

  it("the selection moves the headline, a selection past the end stays on the last departure", () => {
    const list = [dep(4), dep(9, { line: "6", headsign: "Itzling" })];
    expect(boardModel(input(list, 1)).headline).toBe("BUS 6 · 9 MIN");
    expect(boardModel(input(list, 7)).headline).toBe("BUS 6 · 9 MIN");
  });
});

describe("cockpit cells", () => {
  it("are the next departure, the track, the delay, the stop, the walk and the clock time", () => {
    const cells = boardCells(input([dep(4, { source: "realtime", expected: at(6) }), dep(9)]), dep(4), 0);
    expect(cells.map((cell) => cell.label)).toEqual(["DANACH", "STEIG", "VERSPÄTUNG", "HALT", "WEG", "ABFAHRT"]);
    expect(cells.map((cell) => cell.value)).toEqual(["9 MIN", "B", "0 MIN", "SALZBURG MIRABELLPLATZ", "120 M", "14:09"]);
    expect(boardCells(input([dep(4)], 0, { locale: "en" }), dep(4), 0).map((cell) => cell.label)).toEqual(["THEN", "TRACK", "DELAY", "STOP", "WALK", "LEAVES"]);
  });

  it("a late bus is framed, a timetable-only time is not passed off as live, a cancelled one says so", () => {
    expect(delayCell(dep(4, { expected: at(7), scheduled: at(4) }), "de")).toEqual({ label: "VERSPÄTUNG", value: "+3 MIN", alert: true });
    expect(delayCell(dep(4, { source: "scheduled" }), "de")).toEqual({ label: "VERSPÄTUNG", value: "FAHRPLAN" });
    expect(delayCell(dep(4, { cancelled: true }), "de")).toEqual({ label: "VERSPÄTUNG", value: "FÄLLT AUS", alert: true });
  });

  it("an unknown track, no following departure and no position are dashes", () => {
    const cells = boardCells(input([dep(4, { track: "" })], 0, { metresAway: null }), dep(4, { track: "" }), 0);
    expect(cells[0]!.value).toBe("–");
    expect(cells[1]!.value).toBe("–");
    expect(cells[4]!.value).toBe("–");
  });

  it("the walk is rounded the way a walker reads it", () => {
    expect(awayLabel(99, "de")).toBe("100 M");
    expect(awayLabel(3, "de")).toBe("10 M");
    expect(awayLabel(1234, "de")).toBe("1,2 KM");
    expect(awayLabel(1234, "en")).toBe("1.2 KM");
  });
});

describe("cockpit ring and hint", () => {
  it("fills as the bus comes: empty at 15 minutes, full when it is here", () => {
    expect(boardRing(dep(RING_MINUTES), NOW, "de")).toMatchObject({ progress: 0, center: "15", sub: "MIN", tone: "ok" });
    expect(boardRing(dep(5), NOW, "de").progress).toBeCloseTo(1 - 5 / RING_MINUTES);
    expect(boardRing(dep(0), NOW, "de")).toMatchObject({ progress: 1, center: "JETZT", sub: "" });
    expect(boardRing(dep(4, { expected: at(7), scheduled: at(4) }), NOW, "de").tone).toBe("warn");
    expect(boardRing(dep(4, { cancelled: true }), NOW, "de")).toMatchObject({ progress: 0, center: "–", tone: "offline" });
  });

  it("the hint is one line: counter first, the gestures in the fixed order, 2× = zurück last", () => {
    expect(boardHint("de", 2, 4)).toBe("2/4 · Tippen = folgen · Wischen = wählen · Halten = Ziel · 2× = zurück");
    expect(boardHint("en", 1, 3)).toBe("1/3 · Tap = follow · Swipe = select · Hold = destination · 2× = back");
    // A single departure has nothing to swipe to.
    expect(boardHint("de", 1, 1)).toBe("Tippen = folgen · Halten = Ziel · 2× = zurück");
    for (const locale of ["de", "en"] as const) expect(boardHint(locale, 3, 9).length).toBeLessThanOrEqual(HINT_WIDTH);
  });
});

describe("start page", () => {
  it("has at most three big entries: the departures and the goals", () => {
    expect(startRows()).toEqual(["board", "goals"]);
    expect(startRows().length).toBeLessThanOrEqual(3);
  });

  it("names the app and the state in the header, marks the cursor, ends with one footer line", () => {
    const view = startView(0, { locale: "de", word: "live", stopName: "Salzburg Mirabellplatz (Schloss)" });
    expect(view.header).toBe("NEXTSTOP · ● live");
    expect(view.body).toEqual(["● Abfahrten · Salzburg Mirabellplatz", "  Ziele und Route"]);
    expect(view.footer).toBe("Tippen = öffnen · Halten = Ziel · 2× = Ende");
    expect(startView(1, { locale: "de", word: "live", stopName: null }).body).toEqual(["  Abfahrten", "● Ziele und Route"]);
    expect(startView(9, { locale: "en", word: "live", stopName: null }).body[1]).toBe("● Goals and route");
  });

  it("says demo, waiting and offline as words instead of the live dot", () => {
    expect(liveWord({ demo: true, hasPosition: true, failed: false })).toBe("demo");
    expect(liveWord({ demo: false, hasPosition: false, failed: false })).toBe("waiting");
    expect(liveWord({ demo: false, hasPosition: true, failed: true })).toBe("offline");
    expect(headerLine("de", "waiting")).toBe("NEXTSTOP · kein Standort");
    expect(headerLine("en", "offline")).toBe("NEXTSTOP · offline");
    const demo = startView(0, { locale: "de", word: "demo", stopName: null });
    expect(demo.header).toBe("NEXTSTOP · Demo");
    expect(demo.body.at(-1)).toBe("Demo · Standort in der Even-App erlauben");
    expect(startLabel("goals", { locale: "en", word: "live", stopName: null })).toBe("Goals and route");
  });
});

describe("cockpit drawing", () => {
  const model = boardModel(input([dep(4), dep(9)]));

  it("draws a non-empty, repeatable frame", () => {
    const frame = composeCockpit(model, backend);
    expect(frame.pixels.some((level) => level > 0)).toBe(true);
    expect(frameKey(composeCockpit(model, backend))).toBe(frameKey(frame));
  });

  it("lays six cells out in two rows of three, and sets the headline in the biggest size that fits", () => {
    const boxes = cellBoxes(model.cells);
    expect(new Set(boxes.map((box) => box.y)).size).toBe(2);
    expect(new Set(boxes.map((box) => box.x)).size).toBe(3);
    const short = headlineLayout(backend, "BUS 3 · 4 MIN", "→ HBF");
    const long = headlineLayout(backend, "O-BUS 150 · 1H05 MIN LANG", "→ " + "X".repeat(60));
    expect(short.headFont.size).toBeGreaterThan(long.headFont.size);
    expect(long.dir.endsWith("…")).toBe(true);
    const value = cellValueLayout(backend, "SALZBURG MIRABELLPLATZ", 90);
    expect(value.font.size).toBeLessThanOrEqual(14);
    expect(arcStyle("ok").thickness).toBeGreaterThan(arcStyle("offline").thickness);
  });

  it("a late bus and a cancelled one look different from an on-time one", () => {
    const late = composeCockpit(boardModel(input([dep(4, { expected: at(7), scheduled: at(4) })])), backend);
    const cancelled = composeCockpit(boardModel(input([dep(4, { cancelled: true })])), backend);
    const fine = composeCockpit(boardModel(input([dep(4)])), backend);
    expect(new Set([frameKey(late), frameKey(cancelled), frameKey(fine)]).size).toBe(3);
  });

  it("the model key changes exactly with what is drawn", () => {
    const again = boardModel(input([dep(4), dep(9)]));
    expect(modelKey(again)).toBe(modelKey(model));
    expect(modelKey(boardModel(input([dep(4), dep(9)], 1)))).not.toBe(modelKey(model));
    expect(composeTiles(again, backend)).toBe(composeTiles(model, backend));
  });
});

describe("tile diff", () => {
  const slots = tileSlots(4, "cockpit");

  async function run(frames: ReturnType<typeof createFrame>[]): Promise<number[]> {
    const sentIds: number[] = [];
    const sender = createTileSender(slots, async (slot) => { sentIds.push(slot.id); return true; });
    for (const frame of frames) await sender.push(frame);
    return sentIds;
  }

  it("sends all four tiles once, then nothing for an unchanged frame", async () => {
    const frame = composeCockpit(boardModel(input([dep(4), dep(9)])), backend);
    const ids = await run([frame, composeCockpit(boardModel(input([dep(4), dep(9)])), backend)]);
    expect(ids).toEqual([4, 5, 6, 7]);
  });

  it("a new minute sends exactly the tiles whose pixels changed", async () => {
    const before = composeCockpit(boardModel(input([dep(4), dep(9)])), backend);
    const next = composeCockpit(boardModel(input([dep(4), dep(9)], 0, { now: at(1) })), backend);
    const changed = tiles(next).map((tile, index) => frameKey(tile) !== frameKey(tiles(before)[index]!));
    expect(changed.some(Boolean)).toBe(true);
    const sentIds: number[] = [];
    const sender = createTileSender(slots, async (slot) => { sentIds.push(slot.id); return true; });
    await sender.push(before);
    sentIds.length = 0;
    await sender.push(next);
    expect(sentIds).toEqual(slots.filter((_, index) => changed[index]).map((slot) => slot.id));
    sentIds.length = 0;
    await sender.push(next);
    expect(sentIds).toEqual([]);
  });

  it("the scene's tile keys are the pixel keys: equal scenes send nothing", () => {
    const one = cockpitScene(model(), backend);
    const two = cockpitScene(model(), backend);
    expect(one.images.map((image) => image.key)).toEqual(two.images.map((image) => image.key));
    expect(one.images.map((image) => image.id)).toEqual([4, 5, 6, 7]);
    function model() { return boardModel(input([dep(4)])); }
  });
});

describe("phone page", () => {
  const board: PhoneBoard = {
    stop: "Mirabellplatz", metres: 120,
    departures: [
      { line: "3", headsign: "Salzburg Hbf", minutes: 4, delay: 2, cancelled: false, track: "B", clock: NOW.getTime() + 4 * 60000 },
      { line: "6", headsign: "Itzling", minutes: 9, delay: 0, cancelled: false, track: "A", clock: NOW.getTime() + 9 * 60000 },
    ],
  };

  it("has exactly three tabs in one row", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["now", "trips", "settings"]);
  });

  it("Jetzt: one big value, four key figures, one primary button, a card strip for the rest", () => {
    const html = nowInner(board, NOW.getTime(), "de");
    expect(html.match(/class="hero-card"/g) ?? html.match(/hero-card/g)).toHaveLength(1);
    expect(html).toContain("<strong>4 min</strong>");
    expect(html.match(/<small>/g)).toHaveLength(4);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("+2 min");
    expect(html).toContain('<div class="strip">');
    expect(html.match(/class="host /g)).toHaveLength(1);
  });

  it("shows sample departures without a board, and says so", () => {
    expect(nowInner(null, NOW.getTime(), "de")).toContain("Beispieldaten");
    expect(nowInner({ stop: "x", metres: null, departures: [] }, NOW.getTime(), "en")).toContain("Sample data");
    expect(sampleBoard(NOW.getTime()).departures.length).toBeGreaterThan(2);
  });

  it("escapes what comes from the operator", () => {
    const evil: PhoneBoard = { stop: "<b>x</b>", metres: null, departures: [{ ...board.departures[0]!, headsign: "<script>", line: "<i>" }] };
    const html = nowInner(evil, NOW.getTime(), "de");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>x</b>");
  });

  it("says the delay in words", () => {
    expect(delayText(board.departures[0]!, "de")).toBe("+2 min");
    expect(delayText(board.departures[1]!, "de")).toBe("pünktlich");
    expect(delayText({ ...board.departures[1]!, delay: null }, "en")).toBe("timetable");
    expect(delayText({ ...board.departures[1]!, cancelled: true }, "en")).toBe("cancelled");
  });

  it("first run: Einstellungen first with the three steps; the pill says what is missing", () => {
    expect(isFirstRun(null, [])).toBe(true);
    expect(isFirstRun({ lat: 1, lon: 1 }, [STOP])).toBe(false);
    const open = setupInner(null, [], EMPTY_PLACES, "de");
    expect(open.match(/<li/g)).toHaveLength(3);
    expect(open.match(/class="done"/g)).toBeNull();
    expect(open).toContain("Beispieldaten");
    const done = setupInner({ lat: 1, lon: 1 }, [STOP], addFavorite(EMPTY_PLACES, { name: "Heim", lat: 1, lon: 1 }, "h"), "de");
    expect(done.match(/class="done"/g)).toHaveLength(3);
    expect(pillOf(null, [], "de")).toEqual({ text: "kein Standort", on: false });
    expect(pillOf({ lat: 1, lon: 1 }, [STOP], "en")).toEqual({ text: "● live", on: true });
  });
});

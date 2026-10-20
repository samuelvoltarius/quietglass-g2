import { describe, expect, it } from "vitest";
import type { CallSheet } from "../src/api/types";
import { dayKey, dayModel, lightCell, timedRows, TIMELINE_ROWS, type DayModel } from "../src/day/model";
import { cellBoxes, composeDay, headlineLayout } from "../src/day/compose";
import { createFrame, frameKey, tiles, type Frame } from "../src/screen/frame";
import { createTileSender, tileSlots } from "../src/screen/sender";
import { pixelBackend } from "../src/screen/text";
import { CUSTOMER_MENU, MENU, SUB_ENTRIES, buildView, liveText, liveWord, startLines, type ViewState } from "../src/glasses/views";
import { footer } from "../src/glasses/footer";
import { lightModel } from "../src/sun/model";
import { bannerFor, heroOf, isFirstRun, nowInner, projectsInner, TABS, type DayPhone } from "../src/ui/phone";
import { VERSION } from "../src/version";

// QUS v1: the pure parts of the day cockpit and the start page - cells, headline, start rows, footer text, tile diff.
const NOW = new Date(2026, 9, 17, 14, 5);
const backend = pixelBackend();

const SHEET: CallSheet = {
  date: "2026-10-17", call: "08:00", location: "Bäckerei Sonnenschein", contact: "Anna", notes: "",
  schedule: [
    { time: "08:00", what: "Aufbau" },
    { time: "12:30", what: "Interview" },
    { time: "14:30", what: "Außenaufnahme am Fluss" },
    { time: "16:00", what: "Gegenlicht" },
    { time: "18:30", what: "Abbau" },
  ],
  latitude: 47.8, longitude: 13.04,
};
const light = (locale: "de" | "en" = "de") => lightModel({ at: NOW.getTime(), now: NOW.getTime(), place: { latitude: 47.8, longitude: 13.04 }, source: "demo", locale, sheet: SHEET });
const model = (patch: Partial<Parameters<typeof dayModel>[0]> = {}, locale: "de" | "en" = "de"): DayModel =>
  dayModel({ sheet: SHEET, now: NOW, locale, customer: "Anna Beispiel", light: light(locale), demo: false, ...patch });

describe("day cockpit headline", () => {
  it("the one big headline is the next scene: its time and what", () => {
    expect(model().headline).toEqual(["14:30", "AUSSENAUFNAHME AM FLUSS"]);
    expect(model({ now: new Date(2026, 9, 17, 7, 0) }).headline).toEqual(["08:00", "AUFBAU"]);
  });
  it("after the last entry the day is done; without a plan it says so", () => {
    expect(model({ now: new Date(2026, 9, 17, 19, 0) }).headline).toEqual(["FEIERABEND"]);
    expect(model({ now: new Date(2026, 9, 17, 19, 0) }, "en").headline).toEqual(["DAY DONE"]);
    expect(model({ sheet: { ...SHEET, schedule: [] } }).headline).toEqual(["KEIN PLAN"]);
    expect(model({ sheet: { ...SHEET, schedule: [{ time: "bald", what: "x" }] } }).headline).toEqual(["KEIN PLAN"]);
  });
  it("the headline fits the right half at some size, both lines at one size", () => {
    const layout = headlineLayout(backend, model().headline);
    expect(layout.lines).toHaveLength(2);
    expect(layout.font.size).toBeLessThanOrEqual(40);
  });
});

describe("day cockpit cells", () => {
  it("scene, place, client, call, end, light - in this order, in both languages", () => {
    expect(model().cells.map((c) => c.label)).toEqual(["SZENE", "ORT", "KUNDE", "RUF", "ENDE", "LICHT"]);
    expect(model({}, "en").cells.map((c) => c.label)).toEqual(["SCENE", "PLACE", "CLIENT", "CALL", "WRAP", "LIGHT"]);
  });
  it("values: the number of the next scene, place, customer, call time, last entry", () => {
    const cells = model().cells;
    expect(cells[0]!.value).toBe("3/5");
    expect(cells[1]!.value).toBe("Bäckerei Sonnenschein");
    expect(cells[2]!.value).toBe("Anna Beispiel");
    expect(cells[3]!.value).toBe("08:00");
    expect(cells[4]!.value).toBe("18:30");
    expect(cells[5]!.value).toMatch(/^(\d\d:\d\d|jetzt)$/);
  });
  it("missing data is a dash, never an empty cell; the contact stands in for a missing customer", () => {
    const bare = model({ sheet: { ...SHEET, location: "", call: "", schedule: [] }, customer: "", light: null }).cells;
    expect(bare.map((c) => c.value)).toEqual(["–", "–", "Anna", "–", "–", "–"]);
    expect(lightCell(null, "de")).toBe("–");
  });
  it("the cells are laid out in rows of three", () => {
    const boxes = cellBoxes(model().cells);
    expect(new Set(boxes.map((b) => b.y)).size).toBe(2);
    expect(boxes.filter((b) => b.y === boxes[0]!.y)).toHaveLength(3);
  });
});

describe("day timeline", () => {
  it("keeps the running or next row in the window and marks past, now, next, later", () => {
    const m = model();
    expect(m.timeline.length).toBeLessThanOrEqual(TIMELINE_ROWS);
    expect(m.timeline.map((e) => e.state)).toEqual(["past", "now", "next", "later"]);
    expect(m.timeline.find((e) => e.state === "next")!.time).toBe("14:30");
    expect(m.hiddenBefore).toBe(0);
    expect(m.hiddenAfter).toBe(1);
  });
  it("rows without a readable time are left out and the rest is in clock order", () => {
    const rows = timedRows({ ...SHEET, schedule: [{ time: "18:00", what: "b" }, { time: "?", what: "x" }, { time: "09.30", what: "a" }] });
    expect(rows.map((r) => r.row.what)).toEqual(["a", "b"]);
  });
  it("the caption says how long it is to the next scene, else the date", () => {
    expect(model().caption).toBe("in 25 min");
    expect(model({ now: new Date(2026, 9, 17, 19, 0) }).caption).toBe("2026-10-17");
    expect(model({ now: new Date(2026, 9, 17, 19, 0), demo: true }).caption).toBe("Demo");
  });
});

describe("hint and start page", () => {
  it("the hint is one footer line in the fixed order", () => {
    expect(model().hint).toBe("Tippen = Licht · 2× = zurück");
    expect(model({}, "en").hint).toBe("Tap = light · 2× = back");
    expect(model().hint).toBe(footer("de", { tap: "Licht" }, "back"));
  });
  it("at most three big entries; the storyboard and the packing list hang under them", () => {
    const big = (list: readonly string[]): string[] => list.filter((e) => !(SUB_ENTRIES as readonly string[]).includes(e));
    expect(big(MENU)).toEqual(["takes", "prompter", "day"]);
    expect(big(CUSTOMER_MENU)).toEqual(["takes", "prompter", "day"]);
    expect(MENU).toEqual(["takes", "prompter", "day", "pack"]);
    expect(CUSTOMER_MENU).toEqual(["takes", "board", "prompter", "day", "pack"]);
    expect(startLines("de", false, 0)).toEqual(["● Takes", "  Teleprompter", "  Drehtag", "    Packliste"]);
    expect(startLines("en", true, 2)).toEqual(["  Takes", "    Storyboard", "● Teleprompter", "  Shoot day", "    Packing list"]);
  });
  it("the run views read `Modus · ● live`, `Demo` or `offline`, with one footer line", () => {
    expect(liveText("de", "live")).toBe("● live");
    expect(liveText("en", "offline")).toBe("offline");
    const base = { locale: "de", demo: false, configured: true, now: NOW, mode: "prompter", menuCursor: 0, project: "P", pendingCount: 0, load: { kind: "ready" }, message: "", rec: null } as unknown as ViewState;
    const view = (patch: Partial<ViewState>) => buildView({ ...base, prompter: { lines: ["Erste", "Zweite"], pos: 0, speed: 0.4, playing: false }, ...patch } as ViewState);
    expect(view({}).header).toBe("TELEPROMPTER · Pause · Tempo 0.4 · ● live");
    expect(view({ demo: true }).header.endsWith(" · Demo")).toBe(true);
    expect(view({ load: { kind: "error", code: "network" } }).header.endsWith(" · offline")).toBe(true);
    expect(liveWord({ ...base, load: { kind: "error", code: "x" } } as ViewState)).toBe("offline");
    expect(view({}).footer.includes("\n")).toBe(false);
  });
});

describe("tile diff", () => {
  const tileKeys = (frame: Frame): string[] => tiles(frame).map(frameKey);
  const frameOf = (m: DayModel): Frame => composeDay(m, backend);

  it("an unchanged state draws the same frame, tile for tile", () => {
    expect(tileKeys(frameOf(model()))).toEqual(tileKeys(frameOf(model())));
    expect(dayKey(model())).toBe(dayKey(model()));
  });
  it("the clock changes the top right tile, never the lower right one", () => {
    const before = tileKeys(frameOf(model()));
    const after = tileKeys(frameOf(model({ now: new Date(2026, 9, 17, 14, 6) })));
    const changed = before.map((key, index) => (key !== after[index] ? index : -1)).filter((i) => i >= 0);
    expect(changed).toContain(1);
    expect(changed).not.toContain(3);
  });
  it("the sender sends all four tiles once, then nothing for an identical frame, then only what changed", async () => {
    const sent: string[] = [];
    const sender = createTileSender(tileSlots(21, "t"), async (slot) => { sent.push(slot.name); return true; }, () => new Uint8Array(1));
    await sender.push(frameOf(model()));
    expect(sent).toHaveLength(4);
    await sender.push(frameOf(model()));
    expect(sent).toHaveLength(4);
    await sender.push(frameOf(model({ now: new Date(2026, 9, 17, 14, 6) })));
    expect(sent.length).toBeGreaterThan(4);
    expect(sent.length).toBeLessThan(8);
    const before = sent.length;
    sender.reset();
    await sender.push(frameOf(model({ now: new Date(2026, 9, 17, 14, 6) })));
    expect(sent.length).toBe(before + 4);
  });
  it("draws something for every state, also without a plan", () => {
    for (const m of [model(), model({ sheet: { ...SHEET, schedule: [] } }), model({ now: new Date(2026, 9, 17, 19, 0) })]) {
      expect(frameOf(m).pixels.some((level) => level > 0)).toBe(true);
    }
    expect(frameOf(model()).pixels.length).toBe(createFrame().pixels.length);
  });
});

describe("phone (QUS v1)", () => {
  const day: DayPhone = { model: model(), sheet: SHEET, minutes: 14 * 60 + 5 };
  it("exactly three tabs", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["now", "projects", "settings"]);
  });
  it("first run needs an empty address", () => {
    expect(isFirstRun({ serverUrl: "", invertScroll: false })).toBe(true);
    expect(isFirstRun({ serverUrl: "https://x.example", invertScroll: false })).toBe(false);
  });
  it("the banner is the one message that counts", () => {
    expect(bannerFor({ kind: "demo" }, 0, "de").text).toContain("Demo");
    expect(bannerFor({ kind: "ok", project: "P" }, 2, "de")).toEqual({ tone: "warn", text: "2 Takes warten aufs Senden." });
    expect(bannerFor({ kind: "ok", project: "P" }, 0, "de").tone).toBe("ok");
    expect(bannerFor({ kind: "error", reason: "x" }, 0, "de").tone).toBe("critical");
  });
  it("hero card: one big value (the next time), 2 x 2 figures, one primary button, a card per scene", () => {
    expect(heroOf(day.model, "de")).toMatchObject({ value: "14:30", side: "in 25 min", what: "AUSSENAUFNAHME AM FLUSS" });
    const html = nowInner(day, { kind: "ok", project: "P" }, 0, "de", null);
    expect(html).toContain('class="hero"');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html.match(/<span>[A-ZÄÖÜ]+<\/span><b>/g)).toHaveLength(4);
    expect(html.match(/class="host scene/g)).toHaveLength(5);
    expect(html).toContain("host scene next");
  });
  it("projects list customers and projects, or says there is nothing", () => {
    expect(projectsInner(null, "de", "")).toContain("Keine Einträge");
    const html = projectsInner({ customers: [{ id: "c1", name: "Anna", company: "", projectCount: 1 }], projects: [{ id: "p1", name: "Reel", date: "", place: "" }], activeProject: "p1", project: "Reel" }, "de", "https://x/");
    expect(html).toContain("Anna");
    expect(html).toContain("aktiv");
  });
  it("is version 0.8.0", () => {
    expect(VERSION).toBe("0.8.0");
  });
});

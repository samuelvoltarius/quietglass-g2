import { describe, expect, it } from "vitest";
import {
  cellsFor, cockpitHint, cockpitModel, cockpitState, headlineFor, modelKey, ringFor, shiftFigures, type CockpitInput, type CockpitModel,
} from "../src/cockpit/model";
import { arcStyle, cellBoxes, composeCockpit, ringArcs } from "../src/cockpit/compose";
import { frameKey, tiles } from "../src/screen/frame";
import { createTileSender } from "../src/screen/sender";
import { pixelBackend } from "../src/screen/text";
import { COCKPIT_TILES } from "../src/glasses/render";
import { startRows, startView, headerLine } from "../src/glasses/view";
import { STOPPED, type ClockState, type TimeEntry } from "../src/tracking/clock";

// QUS v1: the pure parts of the cockpit and the start page - cells, headline, start rows, footer text, tile diff.
const at = (day: number, h: number, m = 0): number => new Date(2026, 9, day, h, m).getTime();
const NOW = at(14, 12); // Wednesday 12:00
const backend = pixelBackend();
const entry = (id: string, day: number, from: [number, number], to: [number, number], project = "Arbeit"): TimeEntry =>
  ({ id, project, startedAt: at(day, ...from), endedAt: at(day, ...to) });

/** Tuesday 4 h, today 08:00-10:00. */
const history: TimeEntry[] = [entry("t", 13, [8, 0], [12, 0]), entry("a", 14, [8, 0], [10, 0])];

function model(over: Partial<CockpitInput> = {}): CockpitModel {
  return cockpitModel({ clock: STOPPED, entries: history, now: NOW, locale: "de", targetHours: 8, armed: false, demo: false, projectCount: 1, ...over });
}
const runningSince = (h: number, m = 0): ClockState => ({ project: "Arbeit", startedAt: at(14, h, m) });
const values = (m: CockpitModel): string[] => m.cells.map((cell) => `${cell.label} ${cell.value}`);

describe("cockpit headline", () => {
  it("running with a target: NOCH h:mm, the time left", () => {
    const m = model({ clock: runningSince(10, 30) });
    expect(m.state).toBe("running");
    expect(m.headline).toEqual(["NOCH 4:30"]);
    expect(model({ clock: runningSince(10, 30), locale: "en" }).headline).toEqual(["LEFT 4:30"]);
  });

  it("stopped between two spells: PAUSE h:mm since the last stop", () => {
    const m = model();
    expect(m.state).toBe("pause");
    expect(m.headline).toEqual(["PAUSE 2:00"]);
    expect(model({ now: at(14, 10, 12) }).headline).toEqual(["PAUSE 0:12"]);
    expect(model({ now: at(14, 10, 12), locale: "en" }).headline).toEqual(["BREAK 0:12"]);
  });

  it("target reached and stopped: FEIERABEND", () => {
    const m = model({ targetHours: 2 });
    expect(m.state).toBe("done");
    expect(m.headline).toEqual(["FEIERABEND"]);
    expect(model({ targetHours: 2, locale: "en" }).headline).toEqual(["DONE"]);
  });

  it("running past the target counts the overtime, without a target the entry's time", () => {
    expect(model({ clock: runningSince(10, 30), targetHours: 3 }).headline).toEqual(["PLUS 0:30"]);
    expect(model({ clock: runningSince(10, 30), targetHours: null }).headline).toEqual(["LÄUFT 1:30"]);
  });

  it("the first tap of a stop asks: STOPP?", () => {
    const m = model({ clock: runningSince(10, 30), armed: true });
    expect(m.state).toBe("armed");
    expect(m.headline).toEqual(["STOPP?"]);
    expect(m.hint).toBe("Nochmal tippen = stoppen · Wischen/2× = abbrechen");
  });

  it("nothing recorded today: BEREIT", () => {
    const m = model({ entries: [] });
    expect(m.state).toBe("idle");
    expect(m.headline).toEqual(["BEREIT"]);
    expect(headlineFor(shiftFigures(STOPPED, [], NOW, null), cockpitState(shiftFigures(STOPPED, [], NOW, null), false), "en")).toEqual(["READY"]);
  });

  it("a headline is one line", () => {
    for (const clock of [STOPPED, runningSince(10, 30)]) for (const armed of [false, true]) expect(model({ clock, armed }).headline).toHaveLength(1);
  });
});

describe("cockpit cells", () => {
  it("pause: Start, Ende (last stop), Pause, Heute, Woche", () => {
    expect(values(model())).toEqual(["Start 08:00", "Ende 10:00", "Pause 2:00", "Heute 2:00", "Woche 6:00"]);
    expect(values(model({ locale: "en" }))).toEqual(["Start 08:00", "End 10:00", "Break 2:00", "Today 2:00", "Week 6:00"]);
  });

  it("running: the end is now plus what is left, the break is what was not worked since the first start", () => {
    // 2 h recorded, running since 10:30: 1.5 h more -> 3.5 h worked, 4.5 h to go.
    expect(values(model({ clock: runningSince(10, 30) }))).toEqual(["Start 08:00", "Ende 16:30", "Pause 0:30", "Heute 3:30", "Woche 7:30"]);
  });

  it("running without a target or past it has no expected end", () => {
    expect(model({ clock: runningSince(10, 30), targetHours: null }).cells[1]).toEqual({ label: "Ende", value: "–" });
    expect(model({ clock: runningSince(10, 30), targetHours: 3 }).cells[1]).toEqual({ label: "Ende", value: "–" });
  });

  it("nothing today: dashes, zero time", () => {
    expect(values(model({ entries: [] }))).toEqual(["Start –", "Ende –", "Pause –", "Heute 0:00", "Woche 0:00"]);
  });

  it("the week starts on Monday and includes the running entry", () => {
    // Sunday: Monday-Saturday of the same week count, last Sunday does not.
    const sunday = at(18, 12);
    const old: TimeEntry[] = [entry("s", 11, [8, 0], [10, 0]), entry("m", 12, [8, 0], [9, 0]), entry("w", 18, [8, 0], [9, 30])];
    expect(cellsFor(shiftFigures(STOPPED, old, sunday, null), sunday, "de")[4]).toEqual({ label: "Woche", value: "2:30" });
  });

  it("five cells fill two rows of three columns", () => {
    const boxes = cellBoxes(model().cells);
    expect(boxes.map((box) => box.y)).toEqual([118, 118, 118, 174, 174]);
    expect(new Set(boxes.map((box) => box.x)).size).toBe(3);
  });

  it("a break after the target was reached does not keep growing", () => {
    const done = shiftFigures(STOPPED, history, at(14, 20), 2);
    expect(done.pause).toBe(0);
    const open = shiftFigures(STOPPED, history, at(14, 20), 8);
    expect(open.pause).toBe(10 * 3600); // 08:00-20:00 minus 2 h worked
  });
});

describe("cockpit ring", () => {
  it("shows the share of the target, quantized so the picture changes only a few times an hour", () => {
    const ring = ringFor(shiftFigures(STOPPED, history, NOW, 8), 8, "de");
    expect(ring).toMatchObject({ hasTarget: true, reached: false, running: false, center: "25%", sub: "VON 8 H" });
    expect(ring.total).toBeCloseTo(0.25, 2);
    // Two seconds later nothing moves.
    expect(ringFor(shiftFigures(STOPPED, history, NOW + 2000, 8), 8, "de")).toEqual(ring);
  });

  it("without a target it shows the time worked against ten hours", () => {
    const ring = ringFor(shiftFigures(STOPPED, history, NOW, null), null, "en");
    expect(ring).toMatchObject({ hasTarget: false, center: "2:00", sub: "TODAY" });
    expect(ring.total).toBeCloseTo(0.2, 2);
  });

  it("the running part follows the recorded part; a reached target fills the ring", () => {
    const run = ringFor(shiftFigures(runningSince(10, 30), history, NOW, 8), 8, "de");
    expect(run.recorded).toBeLessThan(run.total);
    expect(run.running).toBe(true);
    const arcs = ringArcs(run);
    expect(arcs.recorded?.[0]).toBe(0);
    expect(arcs.running?.[0]).toBe(arcs.recorded?.[1]);
    const done = ringFor(shiftFigures(STOPPED, history, NOW, 2), 2, "de");
    expect(done).toMatchObject({ reached: true, total: 1, center: "100%" });
    expect(arcStyle("reached").thickness).toBeGreaterThan(arcStyle("recorded").thickness);
  });
});

describe("hint line", () => {
  it("names only the gestures that do something, ending in 2×", () => {
    expect(cockpitHint("de", "running", 3)).toBe("Tippen = stoppen · 2× = Ende");
    expect(cockpitHint("de", "pause", 1)).toBe("Tippen = weiter · 2× = Ende");
    expect(cockpitHint("de", "pause", 3)).toBe("Tippen = weiter · Wischen = Projekt · 2× = Ende");
    expect(cockpitHint("en", "pause", 3)).toBe("Tap = resume · Swipe = project · 2× = exit");
    expect(cockpitHint("en", "idle", 1)).toBe("Tap = start · 2× = exit");
    expect(cockpitHint("en", "armed", 1)).toBe("Tap again = stop · Swipe/2× = cancel");
  });
});

describe("start page", () => {
  it("lists the projects, the most recently used first, and creates the first one when there is none", () => {
    const used: TimeEntry[] = [entry("1", 13, [8, 0], [9, 0], "B"), entry("2", 14, [8, 0], [9, 0], "C")];
    expect(startRows(["A", "B", "C"], used, "de").map((row) => row.kind === "project" ? row.name : "?")).toEqual(["C", "B", "A"]);
    expect(startRows(["A", "B"], [], "de").map((row) => row.kind === "project" ? row.name : "?")).toEqual(["A", "B"]);
    expect(startRows([], [], "de")).toEqual([{ kind: "create", name: "Arbeit" }]);
    expect(startRows([], [], "en")).toEqual([{ kind: "create", name: "Work" }]);
  });

  it("shows at most three big entries, the cursor is a dot, header Schicht · ● live, one footer line", () => {
    const rows = startRows(["A", "B", "C", "D", "E"], [], "de");
    const view = startView(rows, 0, { locale: "de", demo: false, canGoBack: false });
    expect(view.header).toBe("Schicht · ● live");
    expect(view.body).toEqual(["● A", "  B", "  C"]);
    expect(view.footer).toBe("Tippen = starten · Wischen = wählen · 2× = Ende");
    expect(startView(rows, 4, { locale: "de", demo: false, canGoBack: false }).body).toEqual(["  C", "  D", "● E"]);
    expect(startView(rows, 0, { locale: "en", demo: false, canGoBack: true }).footer).toBe("Tap = start · Swipe = choose · 2× = back");
  });

  it("one project: no swipe hint; no project: the row creates it", () => {
    expect(startView(startRows(["A"], [], "de"), 0, { locale: "de", demo: false, canGoBack: false }).footer).toBe("Tippen = starten · 2× = Ende");
    const none = startView(startRows([], [], "de"), 0, { locale: "de", demo: false, canGoBack: false });
    expect(none.body).toEqual(["● Projekt „Arbeit“ anlegen"]);
    expect(none.footer).toBe("Tippen = anlegen · 2× = Ende");
  });

  it("the header names the mode and the state; the demo says so", () => {
    expect(headerLine("en", "live")).toBe("Shift · ● live");
    expect(headerLine("en", "demo")).toBe("Shift · demo");
    expect(startView(startRows(["A"], [], "de"), 0, { locale: "de", demo: true, canGoBack: false }).header).toBe("Schicht · demo");
  });
});

describe("tile diff", () => {
  const frameOf = (m: CockpitModel) => composeCockpit(m, backend);

  it("composes a 576 x 288 frame that is repeatable", () => {
    const frame = frameOf(model());
    expect(frame.width).toBe(576);
    expect(frame.height).toBe(288);
    expect(frame.pixels.some((level) => level > 0)).toBe(true);
    expect(frameKey(frameOf(model()))).toBe(frameKey(frame));
  });

  it("an unchanged model sends nothing; a minute tick leaves the left half alone", async () => {
    const sent: string[] = [];
    const sender = createTileSender(COCKPIT_TILES, async (slot) => { sent.push(slot.name); return true; });
    await sender.push(frameOf(model()));
    expect(sent).toHaveLength(4);
    sent.length = 0;
    await sender.push(frameOf(model({ now: NOW + 5_000 })));
    expect(sent).toEqual([]);
    // One minute later: the clock, the headline and the break cell change - the ring, caption and hint do not.
    await sender.push(frameOf(model({ now: NOW + 60_000 })));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThanOrEqual(2);
    expect(sent.every((name) => name === "shift-ne" || name === "shift-se")).toBe(true);
  });

  it("the armed hint changes only the bottom tiles and the headline", async () => {
    const sent: string[] = [];
    const sender = createTileSender(COCKPIT_TILES, async (slot) => { sent.push(slot.name); return true; });
    const running = model({ clock: runningSince(10, 30) });
    await sender.push(frameOf(running));
    sent.length = 0;
    await sender.push(frameOf(model({ clock: runningSince(10, 30), armed: true })));
    expect(sent).not.toContain("shift-nw");
    expect(sent.length).toBeGreaterThan(0);
  });

  it("a page rebuild blanks every tile again", async () => {
    const sent: string[] = [];
    const sender = createTileSender(COCKPIT_TILES, async (slot) => { sent.push(slot.name); return true; });
    await sender.push(frameOf(model()));
    sender.reset();
    sent.length = 0;
    await sender.push(frameOf(model()));
    expect(sent).toHaveLength(4);
  });

  it("the model key and the tile keys move together", () => {
    const a = model();
    const b = model({ now: NOW + 60_000 });
    expect(modelKey(a)).not.toBe(modelKey(b));
    expect(modelKey(a)).toBe(modelKey(model({ now: NOW + 5_000 })));
    expect(tiles(frameOf(a)).map(frameKey)).toHaveLength(4);
  });
});

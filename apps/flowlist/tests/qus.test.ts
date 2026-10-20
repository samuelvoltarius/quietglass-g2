import { describe, expect, it, vi } from "vitest";
import {
  cockpitHint, cockpitModel, counts, flowCells, hhmm, MAX_ARCS, modelKey, nextStepText, ringTones, statusLines, type CockpitModel,
} from "../src/cockpit/model";
import { cellBoxes, composeCockpit } from "../src/cockpit/compose";
import { createFrame, frameKey, tiles, type Frame } from "../src/screen/frame";
import { createTileSender, tileSlots } from "../src/screen/sender";
import { pixelBackend } from "../src/screen/text";
import { complete, skip, startRun, type RunState } from "../src/checklist/run";
import type { Checklist, Step } from "../src/checklist/model";
import { sampleChecklists } from "../src/checklist/sample";
import { startRows, startView, tasksView } from "../src/glasses/screens";
import { COCKPIT_TILES, guardedTileSend } from "../src/glasses/render";
import { FOOTER_WIDTH } from "../src/glasses/view";
import { bannerFor, isFirstRun, nowInner, setupInner, TABS, upcoming } from "../src/ui/phone";
import { EMPTY_DATA, firstRunData } from "../src/storage/persist";
import { parseUi } from "../src/ui-state";
import type { Locale } from "../src/i18n";

// QUS v1: the pure parts of the cockpit, the start page and the task list - cells, headline, start rows, footer text, tile diff.
const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const backend = pixelBackend();

const home = (locale: Locale = "de"): Checklist => sampleChecklists(locale)[0]!;
const empty: Checklist = { id: "e", title: "", steps: [] };
const step = (id: string, over: Partial<Step> = {}): Step => ({ id, text: "step " + id, kind: "normal", ...over });

/** The run after the first `n` steps were ticked off (the choice step takes its first answer). */
function after(list: Checklist, n: number): RunState {
  let state = startRun(list, NOW);
  for (let i = 0; i < n; i += 1) {
    state = complete(list, state, "done", NOW);
    if (state.awaitingConfirm) state = complete(list, state, "done", NOW);
  }
  return state;
}
const finished = (list: Checklist): RunState => {
  let state = startRun(list, NOW);
  for (let guard = 0; guard < 50 && state.currentId !== null; guard += 1) {
    state = complete(list, state, "done", NOW);
    if (state.awaitingConfirm) state = complete(list, state, "done", NOW);
  }
  return state;
};

const model = (list: Checklist, state: RunState, locale: Locale = "de", now = NOW): CockpitModel => cockpitModel({ list, state, now, locale });

describe("cockpit headline", () => {
  it("counts what is open, says ALLES ERLEDIGT when nothing is, KEINE LISTE without steps", () => {
    const list = home();
    expect(statusLines(list, startRun(list, NOW), "de")).toEqual(["7 OFFEN"]);
    expect(statusLines(list, after(list, 2), "de")).toEqual(["5 OFFEN"]);
    expect(statusLines(list, after(list, 6), "de")).toEqual(["1 OFFEN"]);
    expect(statusLines(list, finished(list), "de")).toEqual(["ALLES ERLEDIGT"]);
    expect(statusLines(empty, startRun(empty, NOW), "de")).toEqual(["KEINE LISTE"]);
  });

  it("speaks English too", () => {
    const list = home("en");
    expect(statusLines(list, startRun(list, NOW), "en")).toEqual(["7 OPEN"]);
    expect(statusLines(list, finished(list), "en")).toEqual(["ALL DONE"]);
    expect(statusLines(empty, startRun(empty, NOW), "en")).toEqual(["NO LIST"]);
  });

  it("is always one line, so one statement carries the page", () => {
    const list = home();
    for (const state of [startRun(list, NOW), after(list, 3), finished(list)]) expect(model(list, state).headline).toHaveLength(1);
  });
});

describe("cockpit cells", () => {
  it("six cells: step, done, critical, optional, skipped, next", () => {
    const list = home();
    const cells = flowCells(list, startRun(list, NOW), "de");
    expect(cells.map((cell) => cell.label)).toEqual(["Schritt", "Erledigt", "Kritisch", "Optional", "Ausgelassen", "Nächste"]);
    expect(cells.map((cell) => cell.value)).toEqual(["1/7", "0", "1", "0", "0", "Herd und Backofen aus"]);
    // The important step still ahead is framed.
    expect(cells[2]!.alert).toBe(true);
    expect(cells[0]!.alert).toBeUndefined();
  });

  it("moves only when the run moves", () => {
    const list = home();
    const cells = flowCells(list, after(list, 2), "de");
    expect(cells.map((cell) => cell.value).slice(0, 3)).toEqual(["3/7", "2", "0"]);
    expect(cells[2]!.alert).toBeUndefined();
    expect(nextStepText(list, after(list, 2))).toBe("Ist Regen angesagt?");
  });

  it("a finished run shows the last step, nothing critical and no next step", () => {
    const list = home();
    const cells = flowCells(list, finished(list), "de");
    expect(cells.map((cell) => cell.value)).toEqual(["7/7", "7", "0", "0", "0", "–"]);
  });

  it("optional and skipped steps are counted apart and never inflate the open count", () => {
    const list: Checklist = { id: "x", title: "X", steps: [step("a"), step("b", { kind: "optional" }), step("c")] };
    let state = complete(list, startRun(list, NOW), "done", NOW);
    expect(counts(list, state)).toMatchObject({ total: 2, done: 1, open: 1, optionalLeft: 1, skipped: 0 });
    state = skip(list, state, NOW);
    expect(counts(list, state)).toMatchObject({ done: 1, open: 1, optionalLeft: 0, skipped: 1 });
    expect(flowCells(list, state, "de").map((cell) => cell.value).slice(1, 5)).toEqual(["1", "0", "0", "1"]);
  });

  it("no list: every cell is a dash", () => {
    expect(flowCells(empty, startRun(empty, NOW), "de").every((cell) => cell.value === "–")).toBe(true);
  });

  it("the cells fit the right half in two rows of three", () => {
    const list = home();
    const boxes = cellBoxes(model(list, startRun(list, NOW)).cells);
    expect(boxes.map((box) => [box.x > 288, box.y])).toEqual([[true, 118], [true, 118], [true, 118], [true, 174], [true, 174], [true, 174]]);
    expect(boxes.every((box) => box.x + box.width <= 576)).toBe(true);
  });
});

describe("cockpit ring, caption and hint", () => {
  it("one arc per required step: done calm, the step to do now bright, the rest faint", () => {
    const list = home();
    expect(ringTones(list, startRun(list, NOW))).toEqual(["warn", "offline", "offline", "offline", "offline", "offline", "offline"]);
    expect(ringTones(list, after(list, 2))).toEqual(["ok", "ok", "warn", "offline", "offline", "offline", "offline"]);
    expect(ringTones(list, finished(list)).filter((tone) => tone === "ok").length).toBeGreaterThanOrEqual(6);
  });

  it("long lists are merged into at most MAX_ARCS arcs", () => {
    const long: Checklist = { id: "l", title: "L", steps: Array.from({ length: 60 }, (_, i) => step("s" + i)) };
    expect(ringTones(long, startRun(long, NOW))).toHaveLength(MAX_ARCS);
    expect(ringTones(long, after(long, 60))).toEqual(Array(MAX_ARCS).fill("ok"));
  });

  it("the centre says how many are done, the caption names the list, the hint is one footer line", () => {
    const list = home();
    const m = model(list, after(list, 3));
    expect(m.graphic).toMatchObject({ kind: "ring", center: "3/7", sub: "erledigt" });
    expect(m.caption).toBe("Haus verlassen");
    expect(m.title).toBe("FLOWLIST");
    expect(m.clock).toBe("14:05");
    expect(m.hint).toBe("Tippen = Ablauf · 2× = zurück");
    expect(cockpitHint("en")).toBe("Tap = run · 2× = back");
    expect(m.hint.length).toBeLessThanOrEqual(FOOTER_WIDTH);
    expect(model(empty, startRun(empty, NOW)).graphic).toMatchObject({ center: "–", segments: [] });
    expect(hhmm(NOW)).toBe("14:05");
  });
});

describe("start page", () => {
  it("at most three entries: run, overview, tasks; none without a list", () => {
    expect(startRows(home()).map((row) => row.kind)).toEqual(["run", "cockpit", "tasks"]);
    expect(startRows(empty)).toEqual([]);
  });

  it("renders the cursor as a dot, header with ● live, one footer line", () => {
    const list = home();
    const view = startView(list, startRun(list, NOW), 0, "de");
    expect(view.header).toBe("FLOWLIST · ● live");
    expect(view.body).toEqual(["● Ablauf · 1/7", "  Übersicht · 7 offen", "  Aufgaben · 7"]);
    expect(view.footer).toBe("Tippen = öffnen · Wischen = wählen · 2× = Ende");
    expect(startView(list, after(list, 2), 1, "de").body).toEqual(["  Ablauf · 3/7", "● Übersicht · 5 offen", "  Aufgaben · 7"]);
    expect(startView(home("en"), startRun(home("en"), NOW), 2, "en").body).toEqual(["  Run · 1/7", "  Overview · 7 open", "● Tasks · 7"]);
    expect(startView(home("en"), startRun(home("en"), NOW), 0, "en").footer).toBe("Tap = open · Swipe = choose · 2× = exit");
  });

  it("a finished run says so in two entries", () => {
    const list = home();
    expect(startView(list, finished(list), 0, "de").body).toEqual(["● Ablauf · fertig", "  Übersicht · alles erledigt", "  Aufgaben · 7"]);
  });

  it("without a list it says where to make one, with no dot", () => {
    const view = startView(empty, startRun(empty, NOW), 0, "de");
    expect(view.body).toEqual(["Noch keine Checkliste.", "Leg am Handy in FlowList eine an."]);
    expect(view.footer).toBe("2× = Ende");
  });
});

describe("task list", () => {
  const long: Checklist = { id: "l", title: "L", steps: Array.from({ length: 12 }, (_, i) => step("s" + (i + 1))) };

  it("shows five rows at most, the dot on the cursor, → on the step to do now, — on finished ones", () => {
    const state = after(long, 3);
    const view = tasksView(long, state, 3, "de");
    expect(view.header).toBe("Aufgaben · ● live");
    expect(view.body).toHaveLength(5);
    expect(view.body.some((row) => row.startsWith("● "))).toBe(true);
    expect(view.footer).toBe("Tippen = Ablauf · Wischen = blättern · 2× = zurück");
  });

  it("marks done, now and ahead with fixed prefixes", () => {
    const state = after(long, 3);
    // Cursor on the current step (index 3): the window is steps 2..6.
    expect(tasksView(long, state, 3, "de").body).toEqual(["  — step s2", "  — step s3", "● → step s4", "    step s5", "    step s6"]);
    // Cursor at the start: the window starts at the top.
    expect(tasksView(long, state, 0, "de").body[0]).toBe("● — step s1");
    // Cursor at the end: the last five.
    const end = tasksView(long, state, 11, "de").body;
    expect(end).toHaveLength(5);
    expect(end.at(-1)).toBe("●   step s12");
  });

  it("every row fits one display row, in both languages", () => {
    const wide: Checklist = { id: "w", title: "W", steps: [step("a", { text: "Ein sehr langer Schritt mit vielen Worten und einer Zusatzinformation die kaum ein Ende nimmt" })] };
    for (const locale of ["de", "en"] as const) {
      const view = tasksView(wide, startRun(wide, NOW), 0, locale);
      for (const row of view.body) expect(row.length).toBeLessThanOrEqual(56);
      expect(view.footer.length).toBeLessThanOrEqual(FOOTER_WIDTH);
    }
  });

  it("one step: no scroll hint in the footer", () => {
    const one: Checklist = { id: "o", title: "O", steps: [step("a")] };
    expect(tasksView(one, startRun(one, NOW), 0, "de").footer).toBe("Tippen = Ablauf · 2× = zurück");
  });
});

describe("tile diff", () => {
  const frameOf = (list: Checklist, state: RunState, now = NOW): Frame => composeCockpit(model(list, state, "de", now), backend);
  const tileKeys = (frame: Frame): string[] => tiles(frame).map(frameKey);
  const list = home();

  it("an unchanged state draws the same frame, tile for tile", () => {
    expect(tileKeys(frameOf(list, after(list, 2)))).toEqual(tileKeys(frameOf(list, after(list, 2))));
    expect(modelKey(model(list, after(list, 2)))).toBe(modelKey(model(list, after(list, 2))));
    expect(frameOf(list, startRun(list, NOW)).pixels.some((level) => level > 0)).toBe(true);
    expect(createFrame().pixels.some((level) => level > 0)).toBe(false);
  });

  it("the clock alone changes only the top right tile", () => {
    const before = tileKeys(frameOf(list, after(list, 2)));
    const later = tileKeys(frameOf(list, after(list, 2), NOW + 60_000));
    const changed = before.map((key, index) => (key === later[index] ? -1 : index)).filter((index) => index >= 0);
    expect(changed).toEqual([1]);
  });

  it("a finished step changes the picture; the state decides, not the clock", () => {
    expect(tileKeys(frameOf(list, after(list, 2)))).not.toEqual(tileKeys(frameOf(list, after(list, 3))));
    expect(tileKeys(frameOf(list, after(list, 2))).join()).not.toBe(tileKeys(frameOf(list, finished(list))).join());
  });

  it("the sender sends all four tiles once, then nothing for an identical frame, then only what changed", async () => {
    const sent: string[] = [];
    const sender = createTileSender(tileSlots(21, "t"), async (slot) => { sent.push(slot.name); return true; }, () => new Uint8Array(1));
    await sender.push(frameOf(list, after(list, 2)));
    expect(sent).toEqual(["t-nw", "t-ne", "t-sw", "t-se"]);
    await sender.push(frameOf(list, after(list, 2)));
    expect(sent).toHaveLength(4);
    await sender.push(frameOf(list, after(list, 2), NOW + 60_000));
    expect(sent.slice(4)).toEqual(["t-ne"]);
    // A rebuilt page starts blank: everything goes out again.
    sender.reset();
    await sender.push(frameOf(list, after(list, 2), NOW + 60_000));
    expect(sent).toHaveLength(9);
  });
});

describe("tile writes", () => {
  it("write nothing while the exit dialog may be on screen or after the cockpit was left", async () => {
    const update = vi.fn(async () => "success");
    let allowed = false;
    const send = guardedTileSend({ updateImageRawData: update } as never, () => allowed);
    expect(await send(COCKPIT_TILES[0], new Uint8Array(1))).toBe(false);
    expect(update).not.toHaveBeenCalled();
    allowed = true;
    expect(await send(COCKPIT_TILES[0], new Uint8Array(1))).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("the cockpit has four 288 x 144 tiles that cover the display", () => {
    expect(COCKPIT_TILES.map((tile) => [tile.x, tile.y, tile.width, tile.height])).toEqual([[0, 0, 288, 144], [288, 0, 288, 144], [0, 144, 288, 144], [288, 144, 288, 144]]);
  });
});

describe("footers and rows", () => {
  it("start page, task list and cockpit hint fit one row in German and English", () => {
    for (const locale of ["de", "en"] as const) {
      const list = home(locale);
      const state = after(list, 2);
      const views = [startView(list, state, 0, locale), startView(empty, startRun(empty, NOW), 0, locale), tasksView(list, state, 2, locale), tasksView(empty, startRun(empty, NOW), 0, locale)];
      for (const view of views) {
        expect(view.header.length).toBeLessThanOrEqual(56);
        expect(view.footer.length).toBeLessThanOrEqual(FOOTER_WIDTH);
        expect(view.body.length).toBeLessThanOrEqual(5);
        for (const row of view.body) expect(row.length).toBeLessThanOrEqual(56);
        // The last part of a footer is the 2x part (QIS v1).
        expect(view.footer).toMatch(/2× = (zurück|Ende|back|exit)$/);
      }
    }
  });
});

describe("saved screen", () => {
  it("keeps a known screen and a small cursor, drops the rest", () => {
    expect(parseUi('{"screen":"cockpit","startCursor":1}')).toEqual({ screen: "cockpit", startCursor: 1 });
    expect(parseUi('{"screen":"nonsense","startCursor":99}')).toEqual({});
    expect(parseUi("not json")).toEqual({});
    expect(parseUi("")).toEqual({});
  });
});

describe("phone view models", () => {
  it("have exactly three tabs, Jetzt / Aufgaben / Einstellungen", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["now", "lists", "settings"]);
  });

  it("the hero value is what is open; the stats are step, done, critical, skipped; a strip of coming steps", () => {
    const list = home();
    const html = nowInner(list, after(list, 2), "de");
    expect(html).toContain("<strong>5</strong>");
    expect(html).toContain("Haus verlassen");
    expect(html.match(/<b>/g)!.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('class="strip"');
    expect(html.match(/class="step-card/g)).toHaveLength(5);
    expect(html).not.toContain("<button");
  });

  it("the banner carries the one message that counts", () => {
    const list = home();
    expect(bannerFor(list, startRun(list, NOW), "de")).toEqual({ tone: "ok", text: "Jetzt: Fenster zu" });
    expect(bannerFor(list, after(list, 1), "de").tone).toBe("warn");
    expect(bannerFor(list, finished(list), "de")).toEqual({ tone: "ok", text: "Alles erledigt." });
    expect(bannerFor(empty, startRun(empty, NOW), "de").tone).toBe("none");
    const confirming = complete(list, after(list, 1), "done", NOW);
    expect(confirming.awaitingConfirm).toBe(true);
    expect(bannerFor(list, confirming, "de").text).toContain("nochmal tippen");
  });

  it("upcoming starts at the current step", () => {
    const list = home();
    expect(upcoming(list, after(list, 2)).map((s) => s.id)[0]).toBe("lights");
    expect(upcoming(list, finished(list))).toEqual([]);
  });

  it("the first-run checklist has three steps and ticks them off", () => {
    expect(isFirstRun(EMPTY_DATA)).toBe(true);
    expect(isFirstRun(firstRunData("de"))).toBe(true);
    const none = setupInner(firstRunData("de"), "de");
    expect(none.match(/<li/g)).toHaveLength(3);
    expect(none).not.toContain("✓");
    const own = { ...firstRunData("de"), lists: [...firstRunData("de").lists, { id: "l3", title: "Mine", steps: [step("a")] }] };
    expect(isFirstRun(own)).toBe(false);
    expect(setupInner(own, "de").match(/✓/g)).toHaveLength(1);
    expect(setupInner({ ...own, activeId: "l3" }, "de").match(/✓/g)).toHaveLength(3);
  });
});

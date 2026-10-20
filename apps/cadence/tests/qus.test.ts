import { describe, expect, it } from "vitest";
import {
  beatDots, cockpitCells, cockpitModel, hhmm, minutesShort, runWord, type CockpitInput, type CockpitModel,
} from "../src/cockpit/model";
import { cellBoxes, composeCockpit, drawDots } from "../src/cockpit/compose";
import { createFrame, frameKey, tiles, type Frame } from "../src/screen/frame";
import { createTileSender, tileSlots } from "../src/screen/sender";
import { pixelBackend } from "../src/screen/text";
import { DEFAULT_SETTINGS, createState, msPerBeat, start, type MetronomeSettings } from "../src/metronome/engine";
import { EMPTY_DATA } from "../src/storage/persist";
import { bannerFor, dayTotals, isFirstRun, logInner, nowInner, pillOf, setupInner, TABS } from "../src/ui/phone";

// QUS v1: the pure parts of the cockpit - cells, headline, hint, tile diff - and of the phone page.
const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const backend = pixelBackend();
const T0 = NOW - 12 * 60_000;
const running = start(createState(), T0);

const input = (patch: Partial<CockpitInput> = {}): CockpitInput => ({
  state: running, settings: DEFAULT_SETTINGS, now: NOW, locale: "de", item: "Tonleitern", sessionSeconds: 720, todaySeconds: 2040, todayCount: 2, best: 112, ...patch,
});
const model = (patch: Partial<CockpitInput> = {}): CockpitModel => cockpitModel(input(patch));
const frameOf = (m: CockpitModel): Frame => composeCockpit(m, backend);
const tileKeys = (m: CockpitModel): string[] => tiles(frameOf(m)).map(frameKey);
const changed = (a: string[], b: string[]): number[] => a.map((key, index) => (key === b[index] ? -1 : index)).filter((index) => index >= 0);

function inkBelow(frame: Frame, row: number): number {
  let sum = 0;
  for (let y = row; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) sum += frame.pixels[y * frame.width + x]!;
  return sum;
}

describe("cockpit headline", () => {
  it("is the tempo on top and the state word below", () => {
    expect(model().headline).toEqual(["100 BPM", "LÄUFT"]);
    expect(model({ state: createState() }).headline).toEqual(["100 BPM", "BEREIT"]);
    expect(model({ state: { running: false, startedAt: null, beatsBefore: 8 } }).headline).toEqual(["100 BPM", "PAUSE"]);
    expect(model({ armed: true }).headline).toEqual(["100 BPM", "PAUSE?"]);
    expect(model({ locale: "en" }).headline).toEqual(["100 BPM", "RUNNING"]);
    expect(runWord(createState(), true)).toBe("ready");
  });

  it("the header is the app name and the clock", () => {
    expect(model().title).toBe("CADENCE");
    expect(model().clock).toBe("14:05");
    expect(hhmm(new Date(2026, 0, 2, 3, 4).getTime())).toBe("03:04");
  });
});

describe("cockpit cells", () => {
  it("six cells: signature, marker, today, time, best, sessions", () => {
    const cells = cockpitCells(input());
    expect(cells.map((cell) => cell.label)).toEqual(["TAKTART", "MARKE", "HEUTE", "ZEIT", "BESTE", "EINHEITEN"]);
    expect(cells.map((cell) => cell.value)).toEqual(["4/4", "Schlag", "34 min", "12 min", "112", "2"]);
  });

  it("shows dashes before there is a session or a best tempo", () => {
    const cells = cockpitCells(input({ sessionSeconds: 0, best: null, todaySeconds: 0, todayCount: 0 }));
    expect(cells[3]!.value).toBe("–");
    expect(cells[4]!.value).toBe("–");
    expect(cells[2]!.value).toBe("0 min");
  });

  it("counts minutes only, so the time cell changes once a minute", () => {
    expect(minutesShort(59)).toBe("0 min");
    expect(minutesShort(60)).toBe("1 min");
    expect(minutesShort(7500)).toBe("2:05 h");
  });

  it("lays the cells out in two rows of three inside the right half", () => {
    const boxes = cellBoxes(model().cells);
    expect(boxes.map((box) => [box.x > 288, box.y])).toEqual([[true, 118], [true, 118], [true, 118], [true, 174], [true, 174], [true, 174]]);
    expect(boxes.every((box) => box.x + box.width <= 576)).toBe(true);
    expect(createFrame().pixels.some((level) => level > 0)).toBe(false);
  });
});

describe("beat dots and graphic", () => {
  it("carries the bar number in the graphic and the pendulum swing", () => {
    expect(model().graphic).toMatchObject({ kind: "beat", sub: "TAKT" });
    expect(model({ settings: { ...DEFAULT_SETTINGS, bpm: 200 } }).graphic.swing).toBeNull();
    expect(model({ state: createState() }).graphic.swing).toBe(0);
  });

  it("draws big dots in the middle when the pendulum is off, small ones on top otherwise, inside the upper left tile", () => {
    const small = createFrame(); drawDots(small, [true, false, false, false], false);
    const big = createFrame(); drawDots(big, [true, false, false, false], true);
    const ink = (frame: Frame): number => frame.pixels.reduce((sum, level) => sum + (level > 0 ? 1 : 0), 0);
    expect(ink(big)).toBeGreaterThan(ink(small));
    expect(inkBelow(small, 144)).toBe(0);
    expect(inkBelow(big, 144)).toBe(0);
  });

  it("any signature gets one dot per beat", () => {
    const settings: MetronomeSettings = { ...DEFAULT_SETTINGS, signature: { beats: 16, unit: 16 } };
    expect(beatDots(settings, 3, true)).toHaveLength(16);
  });
});

describe("tile diff", () => {
  it("an unchanged state draws the same frame, tile for tile", () => {
    expect(tileKeys(model())).toEqual(tileKeys(model()));
  });

  it("the next beat changes only the upper left tile", () => {
    const period = msPerBeat(100);
    const before = tileKeys(model({ now: T0 + 5 * period + 10 }));
    const after = tileKeys(model({ now: T0 + 6 * period + 10 }));
    expect(changed(before, after)).toEqual([0]);
  });

  it("the next bar changes the dots and the bar number: upper and lower left, nothing on the right", () => {
    const period = msPerBeat(100);
    const before = tileKeys(model({ now: T0 + 7 * period + 10 }));
    const after = tileKeys(model({ now: T0 + 8 * period + 10 }));
    expect(changed(before, after)).toEqual([0, 2]);
  });

  it("a full minute of practice changes only the lower right tile", () => {
    const before = tileKeys(model({ sessionSeconds: 720 }));
    const after = tileKeys(model({ sessionSeconds: 780 }));
    expect(changed(before, after)).toEqual([3]);
  });

  it("the clock alone changes only the upper right tile", () => {
    expect(changed(tileKeys(model({ state: createState() })), tileKeys(model({ state: createState(), now: NOW + 60_000 })))).toEqual([1]);
  });

  it("the sender sends four tiles once, nothing for an identical frame, then only what changed", async () => {
    const sent: string[] = [];
    const sender = createTileSender(tileSlots(21, "t"), async (slot) => { sent.push(slot.name); return true; }, () => new Uint8Array(1));
    const period = msPerBeat(100);
    await sender.push(frameOf(model({ now: T0 + 5 * period + 10 })));
    expect(sent).toEqual(["t-nw", "t-ne", "t-sw", "t-se"]);
    await sender.push(frameOf(model({ now: T0 + 5 * period + 10 })));
    expect(sent).toHaveLength(4);
    await sender.push(frameOf(model({ now: T0 + 6 * period + 10 })));
    expect(sent.slice(4)).toEqual(["t-nw"]);
    sender.reset();
    await sender.push(frameOf(model({ now: T0 + 6 * period + 10 })));
    expect(sent).toHaveLength(9);
  });
});

describe("phone view models", () => {
  const live = { running: true, paused: false, bar: 26, sessionSeconds: 720 };
  const logged = {
    ...EMPTY_DATA, items: ["Tonleitern"], activeItem: "Tonleitern",
    sessions: [{ id: "p1", item: "Tonleitern", bpm: 100, startedAt: NOW - 3_600_000, endedAt: NOW - 3_600_000 + 600_000 }],
  };

  it("has exactly three tabs, Jetzt / Verlauf / Einstellungen", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["now", "log", "settings"]);
  });

  it("the hero value is the tempo, one big button starts or pauses, 2 x 2 key figures", () => {
    const html = nowInner(logged, live, NOW, "de");
    expect(html).toContain("<strong>100</strong>");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("Takt pausieren");
    expect(nowInner(logged, { ...live, running: false }, NOW, "de")).toContain("Takt starten");
    expect(html.match(/<b>/g)!.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('class="strip"');
  });

  it("the banner carries the one message that counts", () => {
    expect(bannerFor(live, "Tonleitern", "de")).toEqual({ tone: "ok", text: "Der Takt läuft: Takt 26 · Tonleitern" });
    expect(bannerFor({ ...live, running: false }, "", "de").tone).toBe("none");
    expect(bannerFor({ ...live, running: false, paused: true }, "", "de").tone).toBe("warn");
    expect(pillOf(live, "de")).toEqual({ text: "● läuft", on: true });
  });

  it("the history tab shows seven day cards and the totals", () => {
    const days = dayTotals(logged.sessions, NOW, 7);
    expect(days).toHaveLength(7);
    expect(days[6]!.seconds).toBe(600);
    expect(days[0]!.seconds).toBe(0);
    const html = logInner(logged, NOW, "de");
    expect(html.match(/class="host /g)).toHaveLength(7);
    expect(html).toContain("10 min");
    expect(logInner(EMPTY_DATA, NOW, "de")).toContain("Noch nichts aufgezeichnet");
  });

  it("the first-run checklist has three steps and ticks them off", () => {
    expect(isFirstRun(EMPTY_DATA)).toBe(true);
    expect(isFirstRun(logged)).toBe(false);
    const none = setupInner(EMPTY_DATA, "de");
    expect(none.match(/<li/g)).toHaveLength(3);
    expect(none).not.toContain("✓");
    expect(setupInner(logged, "de").match(/✓/g)).toHaveLength(2);
  });
});

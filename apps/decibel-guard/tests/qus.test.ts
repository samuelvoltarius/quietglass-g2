import { describe, expect, it } from "vitest";
import {
  cockpitBars, cockpitCells, cockpitModel, headlineLines, hhmm, hintLine, levelText, minutesShort, type CockpitInput, type CockpitModel,
} from "../src/cockpit/model";
import { cellBoxes, composeCockpit, drawBar } from "../src/cockpit/compose";
import { createFrame, frameKey, tiles, type Frame } from "../src/screen/frame";
import { createTileSender, tileSlots } from "../src/screen/sender";
import { pixelBackend } from "../src/screen/text";
import { accumulate, averageDb, createDose, DEFAULT_DOSE, type DoseState } from "../src/noise/dose";
import { dosePercent, meterLevel, meterShare, quantize } from "../src/glasses/quant";
import { PEAK_FALL_DB_PER_S, PEAK_HOLD_MS, updatePeak } from "../src/glasses/peak";
import { EMPTY_DATA, parseDose } from "../src/storage/persist";
import { allowedTimes, bannerFor, isFirstRun, nowInner, pillOf, setupInner, TABS, todayInner } from "../src/ui/phone";

// QUS v1: the pure parts of the cockpit - headline, cells, bars, hint, tile diff - and of the phone page.
const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const backend = pixelBackend();

const measured = (fraction: number, seconds = 1800): DoseState => ({
  ...createDose(), fraction, measuredSeconds: seconds, peakDb: 92, levelSeconds: seconds * 78, overSeconds: 240,
});
const input = (patch: Partial<CockpitInput> = {}): CockpitInput => ({
  dose: measured(0.34), settings: DEFAULT_DOSE, listening: true, level: 72, barLevel: 72, peak: 78, calibrated: true, locale: "de", now: NOW, ...patch,
});
const model = (patch: Partial<CockpitInput> = {}): CockpitModel => cockpitModel(input(patch));
const frameOf = (m: CockpitModel): Frame => composeCockpit(m, backend);
const tileKeys = (m: CockpitModel): string[] => tiles(frameOf(m)).map(frameKey);
const changed = (a: string[], b: string[]): number[] => a.map((key, index) => (key === b[index] ? -1 : index)).filter((index) => index >= 0);

describe("cockpit headline", () => {
  it("the level on top, the dose band below", () => {
    expect(headlineLines(input())).toEqual(["72 DB", "DOSIS ZÄHLT"]);
    expect(headlineLines(input({ dose: measured(0) }))).toEqual(["72 DB", "RUHIG"]);
    expect(headlineLines(input({ dose: measured(0.6) }))).toEqual(["72 DB", "HALBE DOSIS"]);
    expect(headlineLines(input({ dose: measured(1.2) }))).toEqual(["72 DB", "LIMIT ERREICHT"]);
    expect(headlineLines(input({ level: null }))).toEqual(["– DB", "DOSIS ZÄHLT"]);
  });

  it("marks an estimate with a tilde and says READY when not measuring", () => {
    expect(levelText(72.4, false, "de")).toBe("~72 DB");
    expect(levelText(72.4, true, "en")).toBe("72 DB");
    expect(headlineLines(input({ listening: false, dose: createDose() }))).toEqual(["BEREIT", "NICHT AKTIV"]);
    expect(headlineLines(input({ listening: false }))).toEqual(["BEREIT", "HEUTE 34%"]);
  });

  it("the questions replace the headline", () => {
    expect(headlineLines(input({ armed: "reset" }))).toEqual(["DOSIS", "LÖSCHEN?"]);
    expect(headlineLines(input({ armed: "stop" }))).toEqual(["MESSUNG", "STOPPEN?"]);
    expect(headlineLines(input({ listening: false, micError: true }))).toEqual(["MIKROFON", "NICHT BEREIT"]);
  });

  it("the header is the app name and the clock", () => {
    expect(model().title).toBe("DECIBELGUARD");
    expect(model().clock).toBe("14:05");
    expect(hhmm(new Date(2026, 0, 2, 3, 4).getTime())).toBe("03:04");
  });
});

describe("cockpit cells", () => {
  it("six cells: max, average, limit, time, time over the limit, time left", () => {
    const cells = cockpitCells(input());
    expect(cells.map((cell) => cell.label)).toEqual(["MAX", "MITTEL", "GRENZE", "DAUER", "ÜBER 85", "REST"]);
    expect(cells.slice(0, 5).map((cell) => cell.value)).toEqual(["92", "78", "85", "30 min", "4 min"]);
    expect(cells[4]!.alert).toBe(true);
    expect(cells[5]!.value).toMatch(/\d/);
  });

  it("shows dashes before anything was measured", () => {
    const cells = cockpitCells(input({ dose: createDose(), listening: false, level: null }));
    expect(cells.map((cell) => cell.value)).toEqual(["–", "–", "85", "0 min", "0 min", "–"]);
    expect(cells[4]!.alert).toBeUndefined();
  });

  it("the average and the time over the limit come from the dose", () => {
    let dose = createDose();
    dose = accumulate(dose, 70, 60, DEFAULT_DOSE, 0);
    dose = accumulate(dose, 90, 60, DEFAULT_DOSE, 1000);
    expect(averageDb(dose)).toBe(80);
    expect(dose.overSeconds).toBe(60);
    expect(averageDb(createDose())).toBeNull();
  });

  it("the new dose fields survive a restart, and an older stored dose still loads", () => {
    const saved = JSON.stringify({ day: "2026-10-17", fraction: 0.2, measuredSeconds: 100, peakDb: 80, levelSeconds: 7000, overSeconds: 5 });
    const day = new Date(2026, 9, 17, 12).getTime();
    expect(parseDose(saved, day)).toMatchObject({ levelSeconds: 7000, overSeconds: 5 });
    const old = JSON.stringify({ day: "2026-10-17", fraction: 0.2, measuredSeconds: 100, peakDb: 80 });
    expect(parseDose(old, day)).toMatchObject({ levelSeconds: 0, overSeconds: 0 });
  });

  it("lays the cells out in two rows of three inside the right half", () => {
    const boxes = cellBoxes(model().cells);
    expect(boxes.map((box) => [box.x > 288, box.y])).toEqual([[true, 118], [true, 118], [true, 118], [true, 174], [true, 174], [true, 174]]);
    expect(createFrame().pixels.some((level) => level > 0)).toBe(false);
  });

  it("counts minutes only", () => {
    expect(minutesShort(59)).toBe("0 min");
    expect(minutesShort(3900)).toBe("1:05 h");
  });
});

describe("bars", () => {
  it("level and dose, each against its own scale with ticks at the limits", () => {
    const [level, dose] = cockpitBars(input());
    expect(level).toMatchObject({ label: "PEGEL", text: "72 dB", tone: "ok", peak: meterShare(78) });
    expect(level!.marks).toEqual([meterShare(85)]);
    expect(dose).toMatchObject({ label: "DOSIS HEUTE", text: "34%", value: 34, tone: "ok", marks: [50] });
  });

  it("the tones follow the limits", () => {
    expect(cockpitBars(input({ barLevel: 90 }))[0]!.tone).toBe("warn");
    expect(cockpitBars(input({ dose: measured(0.6) }))[1]!.tone).toBe("warn");
    expect(cockpitBars(input({ dose: measured(1.5) }))[1]).toMatchObject({ tone: "critical", value: 100, text: "150%" });
    expect(cockpitBars(input({ listening: false }))[0]).toMatchObject({ value: null, text: "–", tone: "offline" });
  });

  it("draws inside the upper left tile", () => {
    const frame = createFrame();
    cockpitBars(input()).forEach((bar, index) => drawBar(frame, bar, 12 + index * 66, backend));
    let below = 0;
    for (let y = 144; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) below += frame.pixels[y * frame.width + x]!;
    expect(below).toBe(0);
  });
});

describe("the microphone indicator is never optional", () => {
  it("is in the hint and the caption of every state while measuring", () => {
    for (const locale of ["de", "en"] as const) {
      for (const armed of [null, "reset", "stop"] as const) {
        for (const fraction of [0, 0.6, 1.2]) {
          const m = model({ locale, armed, dose: measured(fraction) });
          expect(m.hint, m.hint).toMatch(/^● MI/);
          expect(m.caption).toMatch(/^● MI/);
        }
      }
    }
    expect(hintLine(input({ listening: false }))).not.toContain("●");
  });
});

describe("quantising keeps the pictures calm", () => {
  it("snaps with hysteresis, floors the dose, scales the bar", () => {
    expect(meterLevel(null, 76.4)).toBe(75);
    expect(meterLevel(75, 76.6)).toBe(75);
    expect(meterLevel(75, 77.4)).toBe(78);
    expect(meterLevel(75, null)).toBeNull();
    expect(quantize(10, 11, 2)).toBe(10);
    expect(dosePercent(0.415)).toBe(40);
    expect(dosePercent(5)).toBe(200);
    expect(meterShare(40)).toBe(0);
    expect(meterShare(110)).toBe(100);
    expect(meterShare(200)).toBe(100);
  });

  it("peak hold rises at once, holds, then falls slowly", () => {
    const p1 = updatePeak(null, 80, 1000)!;
    expect(updatePeak(p1, 60, 1000 + PEAK_HOLD_MS - 1)!.db).toBe(80);
    expect(updatePeak(p1, 85, 4000)!.db).toBe(85);
    const p2 = updatePeak(updatePeak(null, 80, 0)!, 50, PEAK_HOLD_MS + 2000)!;
    expect(p2.db).toBeCloseTo(80 - 2 * PEAK_FALL_DB_PER_S, 5);
    expect(updatePeak(p1, null, 99)).toBe(p1);
  });
});

describe("tile diff", () => {
  it("an unchanged state draws the same frame, tile for tile", () => {
    expect(tileKeys(model())).toEqual(tileKeys(model()));
  });

  it("a moving level changes the bar and headline tiles and the time left, never the lower left one", () => {
    const after = changed(tileKeys(model()), tileKeys(model({ level: 74, barLevel: 75 })));
    expect(after).toContain(0);
    expect(after).not.toContain(2);
  });

  it("the clock alone changes only the upper right tile", () => {
    expect(changed(tileKeys(model()), tileKeys(model({ now: NOW + 60_000 })))).toEqual([1]);
  });

  it("a minute more of measuring changes only the lower right tile", () => {
    const more = { dose: measured(0.34, 1860) };
    expect(changed(tileKeys(model()), tileKeys(model(more)))).toEqual([3]);
  });

  it("the sender sends four tiles once, nothing for an identical frame, then only what changed", async () => {
    const sent: string[] = [];
    const sender = createTileSender(tileSlots(21, "t"), async (slot) => { sent.push(slot.name); return true; }, () => new Uint8Array(1));
    await sender.push(frameOf(model()));
    expect(sent).toEqual(["t-nw", "t-ne", "t-sw", "t-se"]);
    await sender.push(frameOf(model()));
    expect(sent).toHaveLength(4);
    await sender.push(frameOf(model({ now: NOW + 60_000 })));
    expect(sent.slice(4)).toEqual(["t-ne"]);
    sender.reset();
    await sender.push(frameOf(model({ now: NOW + 60_000 })));
    expect(sent).toHaveLength(9);
  });
});

describe("phone view models", () => {
  const live = { listening: true, micError: false, dbfs: -48, level: 72, dose: measured(0.34) };
  const idle = { listening: false, micError: false, dbfs: null, level: null, dose: createDose() };

  it("has exactly three tabs, Jetzt / Heute / Einstellungen", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["now", "today", "settings"]);
  });

  it("the hero value is the level, one big button measures or stops, 2 x 2 key figures", () => {
    const html = nowInner(EMPTY_DATA, live, "de");
    expect(html).toContain("<strong>~72</strong>");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("Messen stoppen");
    expect(nowInner(EMPTY_DATA, idle, "de")).toContain("Messen starten");
    expect(nowInner(EMPTY_DATA, idle, "de")).toContain("<strong>–</strong>");
    expect(html.match(/<b>/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it("the banner carries the one message that counts", () => {
    expect(bannerFor(idle, "de").tone).toBe("none");
    expect(bannerFor(live, "de")).toMatchObject({ tone: "ok" });
    expect(bannerFor({ ...live, dose: measured(0.6) }, "de").tone).toBe("warn");
    expect(bannerFor({ ...live, dose: measured(1.2) }, "de").tone).toBe("critical");
    expect(bannerFor({ ...idle, micError: true }, "de").tone).toBe("warn");
    expect(pillOf(live, "de")).toEqual({ text: "● misst", on: true });
  });

  it("the today tab shows the dose and the allowed time at a few levels as cards", () => {
    const cards = allowedTimes(DEFAULT_DOSE);
    expect(cards.map((row) => row.db)).toEqual([80, 85, 88, 91, 94, 100]);
    expect(cards[1]!.seconds).toBe(8 * 3600);
    expect(cards[2]!.seconds).toBe(4 * 3600);
    const html = todayInner(EMPTY_DATA, live, "de");
    expect(html.match(/class="host /g)).toHaveLength(6);
    expect(html).toContain("34%");
  });

  it("the first-run checklist has three steps and ticks them off", () => {
    expect(isFirstRun(EMPTY_DATA, createDose())).toBe(true);
    expect(isFirstRun(EMPTY_DATA, measured(0.1))).toBe(false);
    const none = setupInner(EMPTY_DATA, createDose(), "de");
    expect(none.match(/<li/g)).toHaveLength(3);
    expect(none).not.toContain("✓");
    expect(setupInner(EMPTY_DATA, measured(0.1), "de").match(/✓/g)).toHaveLength(2);
    expect(setupInner({ ...EMPTY_DATA, calibrationOffset: 100 }, measured(0.1), "de").match(/✓/g)).toHaveLength(3);
  });
});

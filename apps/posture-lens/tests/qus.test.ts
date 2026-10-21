import { describe, expect, it } from "vitest";
import {
  cockpitCells, cockpitHint, cockpitModel, formatDuration, headlineLines, hhmm, postureWord, warningIn, type CockpitInput, type CockpitModel,
} from "../src/cockpit/model";
import { cellBoxes, composeCockpit, drawGauge, gaugePoint, GAUGE_MAX } from "../src/cockpit/compose";
import { createFrame, frameKey, tiles, type Frame } from "../src/screen/frame";
import { createTileSender, tileSlots } from "../src/screen/sender";
import { pixelBackend } from "../src/screen/text";
import { addSample, calibrate, createMonitor, DEFAULT_SETTINGS, type PostureMonitor } from "../src/posture/monitor";
import { BUCKET_MS, bucketShare, EMPTY_BUCKETS, updateBuckets } from "../src/posture/buckets";
import { gaugeAngle, quantize } from "../src/glasses/quant";
import { buildMenuView, MENU_ENTRIES } from "../src/glasses/menu-view";
import { EMPTY_DATA } from "../src/storage/persist";
import { bannerFor, isFirstRun, nowInner, pillOf, setupInner, TABS, todayInner, type PhoneLive } from "../src/ui/phone";

// QUS v1: the pure parts of the cockpit - headline, cells, hint, gauge, tile diff - and of the phone page.
const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const backend = pixelBackend();
const settings = { ...DEFAULT_SETTINGS, smoothing: 1, sustainSeconds: 60, warnAngle: 25 };
const UPRIGHT = { x: 0, y: 0, z: 1 };
const TILTED = { x: 0, y: 1, z: 1 };

const saved: PostureMonitor = calibrate(createMonitor(), UPRIGHT, NOW - 600_000);
const good: PostureMonitor = addSample(saved, UPRIGHT, settings, NOW - 300_000);
const leaning: PostureMonitor = addSample(addSample(good, TILTED, settings, NOW - 30_000), TILTED, settings, NOW - 20_000);
const warned: PostureMonitor = { ...leaning, state: "warned", leaningSince: NOW - 90_000, lastWarnAt: NOW - 1000 };

const input = (monitor: PostureMonitor, patch: Partial<CockpitInput> = {}): CockpitInput => ({ monitor, settings, locale: "de", now: NOW, ...patch });
const model = (monitor: PostureMonitor, patch: Partial<CockpitInput> = {}): CockpitModel => cockpitModel(input(monitor, patch));
const frameOf = (m: CockpitModel): Frame => composeCockpit(m, backend);
const tileKeys = (m: CockpitModel): string[] => tiles(frameOf(m)).map(frameKey);
const changed = (a: string[], b: string[]): number[] => a.map((key, index) => (key === b[index] ? -1 : index)).filter((index) => index >= 0);

describe("cockpit headline", () => {
  it("says one calm word upright, and gets prominent only when something must change", () => {
    expect(headlineLines(input(good))).toEqual(["AUFRECHT"]);
    expect(headlineLines(input(leaning))).toEqual(["GENEIGT"]);
    expect(headlineLines(input(warned))).toEqual(["KOPF NACH", "VORNE"]);
    expect(headlineLines(input(createMonitor()))).toEqual(["HALTUNG", "SPEICHERN"]);
    expect(headlineLines(input(good, { justCalibrated: true }))).toEqual(["GESPEICHERT"]);
    expect(headlineLines(input(good, { confirm: "calibrate" }))).toEqual(["NEU", "SPEICHERN?"]);
    expect(headlineLines(input(good, { sensorOff: true }))).toEqual(["KEIN", "SENSOR"]);
    expect(headlineLines(input(warned, { locale: "en" }))).toEqual(["HEAD", "FORWARD"]);
    expect(postureWord(input(good, { sensorOff: true, confirm: "calibrate" }))).toBe("off");
  });

  it("the header is the app name and the clock", () => {
    expect(model(good).title).toBe("POSTURE");
    expect(model(good).clock).toBe("14:05");
    expect(hhmm(new Date(2026, 0, 2, 3, 4).getTime())).toBe("03:04");
  });
});

describe("cockpit cells", () => {
  it("six cells: limit, share upright, minutes leaning, time to warning, time held, sensor", () => {
    const cells = cockpitCells(input(leaning));
    expect(cells.map((cell) => cell.label)).toEqual(["GRENZE", "AUFRECHT", "GENEIGT", "HINWEIS IN", "GEHALTEN", "SENSOR"]);
    expect(cells[0]!.value).toBe("25°");
    expect(cells[5]!.value).toBe("OK");
  });

  it("counts down to the warning in 5 s steps and holds the time while leaning", () => {
    expect(warningIn(input(leaning))).toBe(30);
    expect(warningIn(input(good))).toBeNull();
    expect(warningIn(input(warned))).toBeNull();
    const cells = cockpitCells(input(leaning));
    expect(cells[3]!.value).toBe("30 s");
    expect(cells[4]!.value).toBe("30 s");
    expect(cockpitCells(input(warned))[4]).toMatchObject({ value: "1 min", alert: true });
  });

  it("shows dashes while upright and when nothing is tracked yet", () => {
    const cells = cockpitCells(input(createMonitor()));
    expect(cells.map((cell) => cell.value)).toEqual(["25°", "–", "0 min", "–", "–", "OK"]);
    expect(cockpitCells(input(good, { sensorOff: true }))[5]).toEqual({ label: "SENSOR", value: "AUS", alert: true });
  });

  it("lays the cells out in two rows of three inside the right half", () => {
    const boxes = cellBoxes(model(good).cells);
    expect(boxes.map((box) => [box.x > 288, box.y])).toEqual([[true, 118], [true, 118], [true, 118], [true, 174], [true, 174], [true, 174]]);
    expect(createFrame().pixels.some((level) => level > 0)).toBe(false);
  });

  it("writes durations short", () => {
    expect(formatDuration(45, "de")).toBe("45 s");
    expect(formatDuration(120, "de")).toBe("2 min");
    expect(formatDuration(125, "en")).toBe("2m 5s");
  });
});

describe("hint", () => {
  it("one line: tap saves, hold opens the list, 2× leaves; armed and sensorless variants", () => {
    expect(cockpitHint(input(createMonitor()))).toBe("Tippen = Haltung speichern · Wischen = Menü · 2× = Ende");
    expect(cockpitHint(input(good))).toBe("Tippen = neu speichern · Wischen = Menü · 2× = Ende");
    expect(cockpitHint(input(good, { confirm: "calibrate", locale: "en" }))).toBe("Tap again = save again · Swipe/2× = cancel");
    expect(cockpitHint(input(good, { sensorOff: true }))).toBe("2× = Ende");
  });
});

describe("the gauge", () => {
  it("good posture costs no attention: no needle and OK in the middle, unless the angle is asked for", () => {
    const calm = model({ ...good, angle: 6 });
    expect(calm.graphic).toMatchObject({ angle: null, alert: false, center: "OK", sub: "HALTUNG" });
    const asked = model({ ...good, angle: 6 }, { showAngleWhenGood: true, digitsAngle: 6, gaugeAngle: 6 });
    expect(asked.graphic).toMatchObject({ angle: 6, center: "6°", sub: "NACH VORNE" });
  });

  it("leaning lights it up: needle, bright, the angle as the big number", () => {
    const m = model({ ...leaning, angle: 31.2 }, { digitsAngle: 31, gaugeAngle: 32 });
    expect(m.graphic).toMatchObject({ angle: 32, alert: true, center: "31°", warnAngle: 25 });
    expect(m.tone).toBe("warn");
    expect(model(warned).tone).toBe("critical");
  });

  it("not calibrated or no sensor: dashes, no needle", () => {
    expect(model(createMonitor()).graphic).toMatchObject({ angle: null, center: "–" });
    expect(model(good, { sensorOff: true }).graphic).toMatchObject({ angle: null, center: "–" });
    expect(model(good, { sensorOff: true }).tone).toBe("offline");
    expect(model(createMonitor()).caption).toBe("Nicht gespeichert");
    expect(model(good).caption).toBe("Gespeichert");
  });

  it("maps degrees onto the dial: 0 at the left end, the maximum at the right end, inside the upper left tile", () => {
    const [x0, y0] = gaugePoint(0, 100);
    const [x1, y1] = gaugePoint(GAUGE_MAX, 100);
    expect(x0).toBeLessThan(144);
    expect(x1).toBeGreaterThan(144);
    expect(y0).toBe(y1);
    expect(gaugePoint(GAUGE_MAX / 2, 100)[0]).toBe(144);
    const frame = createFrame();
    drawGauge(frame, { kind: "gauge", angle: 30, warnAngle: 25, alert: true, center: "30°", sub: "" });
    let below = 0;
    for (let y = 144; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) below += frame.pixels[y * frame.width + x]!;
    expect(below).toBe(0);
    expect(frame.pixels.some((level) => level > 0)).toBe(true);
  });

  it("quantises with hysteresis", () => {
    expect(gaugeAngle(null, 11.2)).toBe(12);
    expect(gaugeAngle(12, 12.9)).toBe(12);
    expect(gaugeAngle(12, 13.6)).toBe(14);
    expect(gaugeAngle(12, null)).toBeNull();
    expect(quantize(10, 10.5, 1)).toBe(10);
  });
});

describe("the list", () => {
  it("has at most three entries: the sensor test and the tally (the help lives on the phone)", () => {
    expect(MENU_ENTRIES).toEqual(["sensor", "reset"]);
    const view = buildMenuView({ locale: "de", cursor: 1, resetArmed: false });
    expect(view.body).toEqual(["  Sensor-Test", "● Zählung heute löschen"]);
    expect(view.header).toBe("POSTURE · Menü");
    expect(view.footer).toBe("Tippen = wählen · Wischen = Liste · 2× = zurück");
    expect(buildMenuView({ locale: "de", cursor: 1, resetArmed: true }).body[1]).toBe("● SICHER? Zählung heute löschen");
  });
});

describe("tile diff", () => {
  it("an unchanged state draws the same frame, tile for tile", () => {
    expect(tileKeys(model(good))).toEqual(tileKeys(model(good)));
  });

  it("the clock alone changes only the upper right tile", () => {
    expect(changed(tileKeys(model(good)), tileKeys(model(good, { now: NOW + 60_000 })))).toEqual([1]);
  });

  it("a needle that moves changes the gauge and the number tile, nothing on the right", () => {
    const a = tileKeys(model({ ...leaning, angle: 30 }, { digitsAngle: 30, gaugeAngle: 30 }));
    const b = tileKeys(model({ ...leaning, angle: 34 }, { digitsAngle: 34, gaugeAngle: 34 }));
    expect(changed(a, b)).toEqual([0, 2]);
  });

  it("the sender sends four tiles once, nothing for an identical frame, then only what changed", async () => {
    const sent: string[] = [];
    const sender = createTileSender(tileSlots(21, "t"), async (slot) => { sent.push(slot.name); return true; }, () => new Uint8Array(1));
    await sender.push(frameOf(model(good)));
    expect(sent).toEqual(["t-nw", "t-ne", "t-sw", "t-se"]);
    await sender.push(frameOf(model(good)));
    expect(sent).toHaveLength(4);
    await sender.push(frameOf(model(good, { now: NOW + 60_000 })));
    expect(sent.slice(4)).toEqual(["t-ne"]);
    sender.reset();
    await sender.push(frameOf(model(good, { now: NOW + 60_000 })));
    expect(sent).toHaveLength(9);
  });
});

describe("the tally in slices", () => {
  it("adds what was tallied since the last call to the slice of the moment, and starts again after a clear", () => {
    let state = updateBuckets(EMPTY_BUCKETS, 0, 0, NOW);
    state = updateBuckets(state, 30, 0, NOW + 30_000);
    state = updateBuckets(state, 50, 10, NOW + 60_000);
    expect(state.buckets).toHaveLength(1);
    expect(state.buckets[0]).toMatchObject({ goodSeconds: 50, leaningSeconds: 10 });
    expect(bucketShare(state.buckets[0]!)).toBeCloseTo(50 / 60, 5);
    state = updateBuckets(state, 55, 10, NOW + BUCKET_MS + 60_000);
    expect(state.buckets).toHaveLength(2);
    const cleared = updateBuckets(state, 0, 0, NOW + BUCKET_MS + 120_000);
    expect(cleared.buckets).toEqual([]);
    expect(bucketShare({ start: 0, goodSeconds: 0, leaningSeconds: 0 })).toBeNull();
  });

  it("keeps twelve slices", () => {
    let state = updateBuckets(EMPTY_BUCKETS, 0, 0, NOW);
    for (let i = 1; i <= 20; i += 1) state = updateBuckets(state, i * 10, 0, NOW + i * BUCKET_MS);
    expect(state.buckets).toHaveLength(12);
  });
});

describe("phone view models", () => {
  const live = (monitor: PostureMonitor, patch: Partial<PhoneLive> = {}): PhoneLive => ({ monitor, sensorOff: false, buckets: [], ...patch });
  const data = { ...EMPTY_DATA, reference: UPRIGHT };

  it("has exactly three tabs, Jetzt / Heute / Einstellungen", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["now", "today", "settings"]);
  });

  it("the hero value is the lean, one big button saves the posture, 2 x 2 key figures", () => {
    const html = nowInner(data, live({ ...leaning, angle: 31.4 }), "de", NOW);
    expect(html).toContain("<strong>31°</strong>");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("Neu speichern");
    expect(nowInner(EMPTY_DATA, live(createMonitor()), "de", NOW)).toContain("Haltung speichern");
    expect(nowInner(EMPTY_DATA, live(createMonitor()), "de", NOW)).toContain("<strong>–</strong>");
    expect(html.match(/<b>/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it("the banner carries the one message that counts", () => {
    expect(bannerFor(EMPTY_DATA, live(createMonitor()), "de").tone).toBe("none");
    expect(bannerFor(data, live(good), "de").tone).toBe("ok");
    expect(bannerFor(data, live(leaning), "de").tone).toBe("warn");
    expect(bannerFor(data, live(warned), "de").tone).toBe("critical");
    expect(bannerFor(data, live(good, { sensorOff: true }), "de").tone).toBe("warn");
    expect(pillOf(data, live(good), "de")).toEqual({ text: "kalibriert", on: true });
    expect(pillOf(EMPTY_DATA, live(createMonitor()), "en")).toEqual({ text: "not calibrated", on: false });
  });

  it("the today tab shows the share upright, the figures and one card per ten minutes", () => {
    const buckets = [
      { start: NOW - 2 * BUCKET_MS, goodSeconds: 540, leaningSeconds: 60 },
      { start: NOW - BUCKET_MS, goodSeconds: 200, leaningSeconds: 400 },
      { start: NOW, goodSeconds: 0, leaningSeconds: 0 },
    ];
    const html = todayInner(data, live({ ...good, goodSeconds: 600, leaningSeconds: 0 }, { buckets }), "de");
    expect(html.match(/class="host /g)).toHaveLength(3);
    expect(html).toContain("tone-ok");
    expect(html).toContain("tone-critical");
    expect(html).toContain("<strong>100%</strong>");
    expect(todayInner(data, live(createMonitor()), "de")).toContain("Noch nichts gemessen.");
  });

  it("the first-run checklist has three steps and ticks them off", () => {
    expect(isFirstRun(EMPTY_DATA)).toBe(true);
    expect(isFirstRun(data)).toBe(false);
    const none = setupInner(EMPTY_DATA, false, "de");
    expect(none.match(/<li/g)).toHaveLength(3);
    expect(none.match(/✓/g)).toHaveLength(1);
    expect(setupInner(data, false, "de").match(/✓/g)).toHaveLength(3);
    expect(setupInner(EMPTY_DATA, true, "de")).not.toContain("✓");
  });
});

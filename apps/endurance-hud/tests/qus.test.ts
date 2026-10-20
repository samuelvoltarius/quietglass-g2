import { describe, expect, it } from "vitest";
import {
  averageText, cockpitCells, cockpitHint, cockpitModel, hhmm, mainValue, modeWord, type CockpitInput, type CockpitModel,
} from "../src/cockpit/model";
import { cellBoxes, composeCockpit, ringSegments, zoneArcStyle } from "../src/cockpit/compose";
import { createFrame, frameKey, tiles, type Frame } from "../src/screen/frame";
import { createTileSender, tileSlots } from "../src/screen/sender";
import { pixelBackend } from "../src/screen/text";
import { locales } from "../src/i18n";
import { qis } from "../src/qis";
import { words } from "../src/words";
import { GESTURE_WORDS, ROW_WIDTH } from "../src/glasses/footer";
import {
  addSample, averageHr, averageOf, averagePower, demoSession, demoTelemetry, EMPTY_SESSION, hrZone, modeOf, type Mode, type Telemetry,
} from "../src/telemetry/model";
import { bannerFor, heroValue, isFirstRun, logInner, nowInner, pillOf, setupInner, TABS, type PhoneState } from "../src/ui/phone";

// QUS v1: the pure parts of the cockpit - headline, cells, hint, tile diff - and of the phone page.
const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const backend = pixelBackend();
const live: Telemetry = { ...demoTelemetry(), source: "garmin", sport: "bike", speedKph: 31.4, paceSecPerKm: 0, powerWatts: 238, heartRate: 154, cadence: 91, distanceKm: 22.7, elapsedSeconds: 2540 };
const LIVE: Mode = { kind: "live" };

const input = (patch: Partial<CockpitInput> = {}): CockpitInput => ({ locale: "de", sport: "bike", data: live, mode: LIVE, maxHr: 190, now: NOW, hrMax: 158, ...patch });
const model = (patch: Partial<CockpitInput> = {}): CockpitModel => cockpitModel(input(patch));
const frameOf = (m: CockpitModel): Frame => composeCockpit(m, backend);
const tileKeys = (m: CockpitModel): string[] => tiles(frameOf(m)).map(frameKey);
const changed = (a: string[], b: string[]): number[] => a.map((key, index) => (key === b[index] ? -1 : index)).filter((index) => index >= 0);

describe("cockpit headline", () => {
  it("is one big value: speed on the bike, pace on foot", () => {
    expect(model().headline).toEqual(["31.4 KM/H"]);
    expect(model({ sport: "run", data: { ...live, speedKph: 0, paceSecPerKm: 342 } }).headline).toEqual(["5:42 /KM"]);
    // Only one of the two is reported: the other is derived.
    expect(mainValue("run", { ...live, speedKph: 30, paceSecPerKm: 0 })).toBe("2:00 /KM");
    expect(mainValue("bike", { ...live, speedKph: 0, paceSecPerKm: 120 })).toBe("30.0 KM/H");
    expect(mainValue("bike", { ...live, speedKph: 0, paceSecPerKm: 0 })).toBe("– KM/H");
  });

  it("the header is the app name and the clock", () => {
    expect(model().title).toBe("ENDURANCE HUD");
    expect(model().clock).toBe("14:05");
    expect(hhmm(new Date(2026, 0, 2, 3, 4).getTime())).toBe("03:04");
  });

  it("the caption says the sport and how the data stands", () => {
    expect(model().caption).toBe("RAD · LIVE");
    expect(model({ locale: "en", mode: { kind: "demo" } }).caption).toBe("BIKE · DEMO");
    expect(model({ mode: { kind: "stale", age: "12s" } }).caption).toBe("RAD · VERALTET 12s");
    expect(model({ mode: { kind: "stale", age: "12s" } }).tone).toBe("offline");
    expect(modeWord({ kind: "live" }, "fr")).toBe("LIVE");
  });
});

describe("cockpit cells", () => {
  it("six cells: sport, time, distance, average, zone, highest pulse", () => {
    const cells = cockpitCells(input());
    expect(cells.map((cell) => cell.label)).toEqual(["SPORT", "ZEIT", "DISTANZ", "Ø TEMPO", "ZONE", "PULS MAX"]);
    expect(cells.map((cell) => cell.value)).toEqual(["RAD", "42:20", "22.7", "32.2", "Z4", "158"]);
    expect(cockpitCells(input({ sport: "run" }))[3]).toEqual({ label: "Ø PACE", value: "1:52" });
  });

  it("zone 5 gets a frame; no reading shows dashes", () => {
    expect(cockpitCells(input({ data: { ...live, heartRate: 182 } }))[4]).toEqual({ label: "ZONE", value: "Z5", alert: true });
    const none = cockpitCells(input({ data: { ...live, heartRate: 0, distanceKm: 0, elapsedSeconds: 0 }, hrMax: 0 }));
    expect(none.map((cell) => cell.value)).toEqual(["RAD", "0:00", "–", "–", "–", "–"]);
  });

  it("derives the zones and the averages", () => {
    expect([0, 100, 120, 135, 160, 175].map((hr) => hrZone(hr, 190))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(hrZone(150, 0)).toBe(0);
    expect(averageOf(live, "bike")).toBeCloseTo(32.18, 1);
    expect(averageOf(live, "run")).toBeCloseTo(111.9, 0);
    expect(averageOf({ ...live, distanceKm: 0 }, "bike")).toBe(0);
    expect(averageText("bike", live)).toBe("32.2");
  });

  it("lays the cells out in two rows of three inside the right half", () => {
    const boxes = cellBoxes(model().cells);
    expect(boxes.map((box) => [box.x > 288, box.y])).toEqual([[true, 118], [true, 118], [true, 118], [true, 174], [true, 174], [true, 174]]);
    expect(createFrame().pixels.some((level) => level > 0)).toBe(false);
  });
});

describe("the ring", () => {
  it("shows the pulse in the middle and power and cadence below", () => {
    const graphic = model().graphic;
    expect(graphic).toEqual({ kind: "ring", zone: 4, center: "154", sub: "PULS", stats: [{ label: "LEISTUNG", value: "238 W" }, { label: "KADENZ", value: "91 RPM" }] });
    expect(model({ data: { ...live, heartRate: 0, powerWatts: 0, cadence: 0 } }).graphic).toMatchObject({ zone: 0, center: "–", stats: [{ value: "–" }, { value: "–" }] });
  });

  it("five arcs; the zone is thick and bright, lower zones calm, higher zones faint dots", () => {
    expect(ringSegments(5)).toHaveLength(5);
    expect(zoneArcStyle(2, 3).thickness).toBeGreaterThan(zoneArcStyle(0, 3).thickness);
    expect(zoneArcStyle(4, 3).dash).toBeGreaterThan(zoneArcStyle(4, 3).gap - 6);
    expect(zoneArcStyle(0, 0).thickness).toBeLessThan(zoneArcStyle(0, 3).thickness);
  });
});

describe("hint and wording", () => {
  it("one line: tap reloads, swipe changes the sport, 2× leaves", () => {
    expect(cockpitHint("de")).toBe("Tippen = neu · Wischen = Sport · 2× = Ende");
    expect(cockpitHint("en")).toBe("Tap = refresh · Swipe = sport · 2× = exit");
    for (const locale of locales) {
      const row = cockpitHint(locale);
      expect(row.length, row).toBeLessThanOrEqual(ROW_WIDTH);
      expect(row.endsWith(`2× = ${GESTURE_WORDS[locale].exit}`), row).toBe(true);
    }
  });

  it("every language has every key, and the glasses labels stay short enough for a cell", () => {
    const keys = Object.keys(qis.de).sort();
    for (const locale of locales) {
      expect(Object.keys(qis[locale]).sort(), locale).toEqual(keys);
      const m = model({ locale });
      for (const cell of m.cells) expect(cell.label.length, `${locale} ${cell.label}`).toBeLessThanOrEqual(11);
      expect(m.hint.length).toBeLessThanOrEqual(ROW_WIDTH);
      expect(words[locale].heart.length).toBeLessThanOrEqual(11);
    }
  });

  it("the glossary: German has no Tap, Wisch, 2x or Doppeltipp", () => {
    const german = [...Object.values(qis.de), ...Object.values(words.de)].join("\n");
    expect(german).not.toMatch(/\bTap\b|\bWisch\b|\b2x\b|Doppeltipp/);
  });
});

describe("tile diff", () => {
  it("an unchanged state draws the same frame, tile for tile", () => {
    expect(tileKeys(model())).toEqual(tileKeys(model()));
  });

  it("the clock alone changes only the upper right tile", () => {
    expect(changed(tileKeys(model()), tileKeys(model({ now: NOW + 60_000 })))).toEqual([1]);
  });

  it("a new power reading changes only the lower left tile", () => {
    expect(changed(tileKeys(model()), tileKeys(model({ data: { ...live, powerWatts: 251 } })))).toEqual([2]);
  });

  it("a new heart rate in the same zone changes the ring tile only", () => {
    expect(changed(tileKeys(model()), tileKeys(model({ data: { ...live, heartRate: 156 } })))).toEqual([0]);
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

describe("telemetry state", () => {
  it("modeOf says demo, live or stale with its age", () => {
    expect(modeOf(demoTelemetry(), NOW, NOW, false)).toEqual({ kind: "demo" });
    expect(modeOf({ ...live, updatedAt: new Date(NOW).toISOString() }, NOW, NOW + 1000, false)).toEqual({ kind: "live" });
    expect(modeOf({ ...live, updatedAt: new Date(NOW).toISOString() }, NOW, NOW + 12_000, false)).toEqual({ kind: "stale", age: "12s" });
    expect(modeOf({ ...live, updatedAt: new Date(NOW).toISOString() }, NOW, NOW + 1000, true).kind).toBe("stale");
  });

  it("the session keeps averages and a snapshot a minute, in memory only", () => {
    let session = EMPTY_SESSION;
    session = addSample(session, { ...live, heartRate: 140, powerWatts: 200 }, NOW);
    session = addSample(session, { ...live, heartRate: 160, powerWatts: 260 }, NOW + 30_000);
    session = addSample(session, { ...live, heartRate: 150, powerWatts: 230 }, NOW + 61_000);
    expect(session.samples).toBe(3);
    expect(session.history).toHaveLength(2);
    expect(session.hrMax).toBe(160);
    expect(averageHr(session)).toBe(150);
    expect(averagePower(session)).toBeCloseTo(230, 5);
  });

  it("a new workout (the elapsed time runs backwards) starts the session again", () => {
    const old = addSample(EMPTY_SESSION, { ...live, elapsedSeconds: 3000 }, NOW);
    const next = addSample(old, { ...live, elapsedSeconds: 5 }, NOW + 5000);
    expect(next.samples).toBe(1);
  });

  it("the demo session has eight cards", () => {
    expect(demoSession(NOW).history).toHaveLength(8);
  });
});

describe("phone view models", () => {
  const state = (patch: Partial<PhoneState> = {}): PhoneState => ({
    data: live, mode: LIVE, sport: "bike", choice: null, lastError: "", session: demoSession(NOW), endpoint: "http://bridge.local/live", maxHr: 190, invert: false, ...patch,
  });

  it("has exactly three tabs, Jetzt / Verlauf / Einstellungen", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["now", "log", "settings"]);
    expect(TABS.map((tab) => qis.de[tab.key])).toEqual(["Jetzt", "Verlauf", "Einstellungen"]);
  });

  it("the hero value is the main value, one big button reloads, 2 x 2 key figures", () => {
    const html = nowInner(state(), "de");
    expect(html).toContain("<strong>31.4</strong>");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('id="refresh"');
    expect(html.match(/<b>/g)).toHaveLength(4);
    expect(heroValue("run", { ...live, speedKph: 0, paceSecPerKm: 342 })).toEqual({ value: "5:42", unit: "/km" });
  });

  it("the banner carries the one message that counts", () => {
    expect(bannerFor(state(), "de")).toEqual({ tone: "ok", text: "Live-Daten von garmin." });
    expect(bannerFor(state({ mode: { kind: "demo" } }), "de").tone).toBe("none");
    expect(bannerFor(state({ mode: { kind: "stale", age: "12s" } }), "de").text).toBe("Seit 12s keine frischen Werte.");
    expect(bannerFor(state({ mode: { kind: "stale", age: "2s" }, lastError: "Failed to fetch" }), "en")).toEqual({ tone: "warn", text: "Bridge not reachable: Failed to fetch" });
    expect(pillOf(state(), "de")).toEqual({ text: "● LIVE", on: true });
    expect(pillOf(state({ mode: { kind: "demo" } }), "en")).toEqual({ text: "DEMO", on: false });
  });

  it("the history tab shows distance, figures and one card per minute (at most twelve)", () => {
    const html = logInner(state(), "de");
    expect(html.match(/class="host /g)).toHaveLength(8);
    expect(html).toContain("<strong>22.7</strong>");
    expect(logInner(state({ session: EMPTY_SESSION }), "de")).toContain("Noch keine Werte.");
  });

  it("the first-run checklist has three steps and ticks them off", () => {
    expect(isFirstRun(state({ endpoint: "", mode: { kind: "demo" } }))).toBe(true);
    expect(isFirstRun(state())).toBe(false);
    const none = setupInner(state({ endpoint: "", mode: { kind: "demo" } }), "de");
    expect(none.match(/<li/g)).toHaveLength(3);
    expect(none).not.toContain("✓");
    expect(setupInner(state({ choice: "run" }), "de").match(/✓/g)).toHaveLength(3);
  });
});

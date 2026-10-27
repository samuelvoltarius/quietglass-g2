import { describe, expect, it } from "vitest";
import { composeStart, startPicture, startTiles, tileBox } from "../src/cockpit/start";
import { carPage, dayPage, printerPage, serverPage, sugarPage } from "../src/cockpit/area-pages";
import { buildView, createModel, decide, type HubModel } from "../src/hub/model";
import { agentTiles, homeDetail, homeTiles } from "../src/cockpit/home-pictures";
import { initialZuhause } from "../src/hub/zuhause";
import type { HomeEntity } from "../src/api/types";
import { composeCockpit } from "../src/cockpit/compose";
import { drawRingAt, weatherKind, WEATHER_PATTERNS } from "../src/cockpit/widgets";
import { createFrame, frameKey, tiles } from "../src/screen/frame";
import { pixelBackend } from "../src/screen/text";
import { demoReport } from "../src/api/demo";
import type { Brief, HubReport } from "../src/api/types";

const NOW = 1_793_118_098_634;
const backend = pixelBackend();
const quiet = (report: HubReport = demoReport()): HubReport => ({ ...report, approvals: [], inbox: { selected: 0, events: [] } });
const brief = (patch: Partial<Brief> = {}): Brief => ({
  at: NOW - 60_000, date: "2026-10-27",
  calendar: { status: "ok", events: [{ title: "Probe Band", allDay: false, startMs: NOW + 3_600_000, endMs: NOW + 7_200_000, start: "19:00", end: "21:00" }], total: 1 },
  weather: { status: "ok", tempC: 9.4, code: 3, maxC: 15, minC: 6, rain: { kind: "later", from: "14:00", until: "", mm: 1 } },
  car: { status: "ok", soc: 60, rangeKm: 188, locked: true },
  sugar: { status: "ok", current: { mgdl: 118, direction: "Flat", ageMin: 3 }, low: 70, high: 180 },
  printer: { status: "ok", state: "standby" },
  servers: { status: "ok", machines: [{ name: "Pi5", ok: true, newDevices: null }, { name: "ns1", ok: false, newDevices: null }], down: 1 },
  ...patch,
});

describe("start page picture", () => {
  it("six tiles in area order with a picture and one big value each", () => {
    const tilesOf = startTiles(quiet(), brief(), "de");
    expect(tilesOf.map((tile) => tile.key)).toEqual(["area:agent", "area:home", "area:car", "area:printer", "area:server", "area:brief"]);
    expect(tilesOf.map((tile) => tile.graphic.kind)).toEqual(["mascot", "icon", "ring", "ring", "segments", "icon"]);
    const car = tilesOf[2]!;
    expect(car).toMatchObject({ label: "AUTO", value: "60 %", sub: "188 km · zu", alert: false });
    expect(tilesOf[4]).toMatchObject({ value: "1/2", alert: true });
    expect(tilesOf[5]).toMatchObject({ value: "9°", sub: "1 Termin · 118 →" });
  });

  it("Panoptes' car wins: a locked car never shows as open, an open one is framed", () => {
    const open = startTiles({ ...quiet(), car: { status: "ok", soc: 57, rangeKm: 176, locked: false, at: NOW } }, brief(), "de")[2]!;
    expect(open).toMatchObject({ value: "57 %", alert: true });
    expect(open.sub).toContain("OFFEN");
    const shut = startTiles({ ...quiet(), car: { status: "ok", soc: 57, rangeKm: 176, locked: true, at: NOW } }, brief({ car: { status: "ok", locked: false } }), "de")[2]!;
    expect(shut.sub).toContain("zu");
  });

  it("the cursor frame follows the key; tiles change only where the picture changes", () => {
    const report = quiet();
    const a = composeStart(startPicture(report, brief(), "de", "area:car", 0, "19:25", "hint"), backend, NOW);
    const b = composeStart(startPicture(report, brief(), "de", "area:home", 0, "19:25", "hint"), backend, NOW);
    expect(frameKey(a)).not.toBe(frameKey(b));
    expect(tileBox(2)).toEqual({ x: 384, y: 34, width: 192, height: 109 });
    // A charging car pulses: the frames of two beats differ, but only in the top right tile.
    // (printer off, so only the car moves besides the agents' face top left)
    const charging: HubReport = { ...report, printer: { ...report.printer, offline: true }, car: { status: "ok", soc: 50, rangeKm: 150, locked: true, charging: true, at: NOW } };
    const t0 = tiles(composeStart(startPicture(charging, brief(), "de", "area:home", 0, "19:25", "hint"), backend, 1000));
    const t1 = tiles(composeStart(startPicture(charging, brief(), "de", "area:home", 0, "19:25", "hint"), backend, 1500));
    const changed = t0.map((tile, i) => frameKey(tile) !== frameKey(t1[i]!));
    expect(changed[1]).toBe(true);
    expect(changed[2]).toBe(false);
    expect(changed[3]).toBe(false);
  });
});

describe("area page pictures", () => {
  it("Auto: battery ring, lock as the headline, the commands only when paired", () => {
    const report: HubReport = { ...quiet(), car: { status: "ok", soc: 57, rangeKm: 176, locked: true, doorOpen: false, climateOn: false, outsideC: 13, at: NOW - 10_000 } };
    const page = carPage(report, brief(), 0, "de", NOW, "hint");
    expect(page.headline).toEqual(["ZUGESPERRT"]);
    expect(page.graphic).toMatchObject({ kind: "ring", percent: 57, center: "57 %" });
    expect(page.cells.map((cell) => `${cell.label} ${cell.value}`)).toEqual(["REICHWEITE 176 km", "TÜREN ZU", "LADEN NEIN", "KLIMA AUS", "AUSSEN 13°", "STAND gerade eben"]);
    expect(page.caption).toBe("nur Anzeige");
    expect(carPage({ ...report, carControl: true }, brief(), 3, "de", NOW, "hint").caption).toBe("> Aufsperren  4/4");
    expect(carPage({ ...report, car: { ...report.car!, locked: false } }, brief(), 0, "de", NOW, "hint").headline).toEqual(["OFFEN"]);
  });

  it("Server: one segment per machine, the down one framed", () => {
    const page = serverPage(brief(), "de", NOW, "hint");
    expect(page.headline).toEqual(["1 AUSGEFALLEN"]);
    expect(page.graphic).toMatchObject({ kind: "segments", segments: ["ok", "critical"], center: "1/2" });
    expect(page.cells[1]).toMatchObject({ label: "NS1", value: "AUS", alert: true });
  });

  it("Drucker: off shows the dim printer; printing a running ring", () => {
    const report = quiet();
    expect(printerPage({ ...report, printer: { ...report.printer, offline: true } }, "de", NOW, "h")).toMatchObject({ headline: ["AUS"], graphic: { kind: "icon", dim: true } });
    const printing = printerPage({ ...report, printer: { ...report.printer, offline: false, state: "printing", progress: 72 } }, "de", NOW, "h");
    expect(printing).toMatchObject({ headline: ["DRUCKT"], graphic: { kind: "ring", percent: 72, spin: true }, caption: "> Pause" });
  });

  it("Tag: weather pictogram, temperature and word, the next timed appointment", () => {
    const page = dayPage(brief(), "de", NOW, "h");
    expect(page.headline[0]).toMatch(/^9° /);
    expect(page.caption).toBe("Probe Band");
    expect(page.cells.map((cell) => cell.value).slice(0, 4)).toEqual(["15°/6°", "ab 14:00", "1", "19:00"]);
    expect(page.graphic).toMatchObject({ kind: "icon", rows: WEATHER_PATTERNS.cloud });
    expect(weatherKind(0)).toBe("clear");
    expect(weatherKind(63)).toBe("rain");
  });

  it("Zucker: the curve of the last 3 h with the target band, state framed when out of range", () => {
    const curve = [100, 120, 160, 190, 170, 140, 62];
    const page = sugarPage(brief({ sugar: { status: "ok", current: { mgdl: 62, direction: "SingleDown", ageMin: 2 }, low: 70, high: 180, curve, night: { min: 80, max: 200, belowMin: 0, aboveMin: 10, count: 90 } } }), "de", NOW, "h");
    expect(page.headline).toEqual(["62 ↓"]);
    expect(page.cells[0]).toMatchObject({ label: "STATUS", value: "NIEDRIG", alert: true });
    expect(page.graphic).toMatchObject({ kind: "spark", points: curve, band: { low: 70, high: 180 }, arrow: 180 });
    expect(composeCockpit(page, backend, NOW).width).toBe(576);
  });

  it("Tag pages: day picture, glucose curve picture, then the text pages", () => {
    const withCurve = brief({ sugar: { status: "ok", current: { mgdl: 118, direction: "Flat", ageMin: 2 }, low: 70, high: 180, curve: [100, 110, 118] } });
    let m: HubModel = { ...createModel(quiet()), screen: "brief", brief: withCurve, briefLoad: "ready", briefPage: 0 };
    m = decide(m, "scrollDown", NOW, "de").model;
    expect(m.briefPage).toBe(1);
    m = decide(m, "scrollDown", NOW, "de").model;
    expect(m.briefPage).toBe(2);
    expect(buildView(m, "de", NOW).footer).toMatch(/^3\//);
    // Without a curve the text follows the day picture directly.
    const noCurve = { ...m, brief: brief(), briefPage: 0 };
    expect(decide(noCurve, "scrollDown", NOW, "de").model.briefPage).toBe(1);
    expect(buildView({ ...noCurve, briefPage: 1 }, "de", NOW).footer).toMatch(/^2\//);
  });

  it("every page draws without throwing, inside the frame", () => {
    const report: HubReport = { ...quiet(), carControl: true, car: { status: "ok", soc: 57, rangeKm: 176, locked: true, at: NOW } };
    for (const page of [carPage(report, brief(), 1, "en", NOW, "h"), serverPage(brief(), "en", NOW, "h"), printerPage(report, "en", NOW, "h"), dayPage(brief(), "en", NOW, "h")]) {
      expect(composeCockpit(page, backend, NOW).width).toBe(576);
    }
  });

  it("a printing ring's marker runs: two beats, two pictures", () => {
    const a = createFrame(); const b = createFrame();
    drawRingAt(a, 144, 104, 82, 12, 50, "ok", 0, { spin: true });
    drawRingAt(b, 144, 104, 82, 12, 50, "ok", 500, { spin: true });
    expect(frameKey(a)).not.toBe(frameKey(b));
  });
});

describe("Zuhause and agents as pictures", () => {
  const tv: HomeEntity = { id: "media_player.wohnzimmer", name: "TV", kind: "media", state: "playing", on: true, available: true, volume: 24, muted: false, value: "Netflix" };

  it("favourites and rooms as tiles: the TV with its app and volume, lights with their level, rooms with lights on", () => {
    const view = demoReport().homeView!;
    const tiles = homeTiles({ ...view, favorites: [tv.id, ...view.favorites], entities: { ...view.entities, [tv.id]: tv } }, initialZuhause(), "de");
    expect(tiles[0]).toMatchObject({ label: "TV", value: "Netflix", sub: "LAUTSTÄRKE 24 %" });
    expect(tiles.find((tile) => tile.label === "BÜRO DECKE")).toMatchObject({ value: "60 %" });
    expect(tiles.at(-1)).toMatchObject({ key: "area:schlafzimmer", graphic: { kind: "icon" } });
  });

  it("the TV opened: TV Glance's TV with the volume bar, the remote keys as cells, the chosen one framed", () => {
    const page = homeDetail(tv, 1, "de", NOW, "h");
    expect(page.graphic).toMatchObject({ kind: "tv", screen: "playing", volume: 24, muted: false });
    expect(page.cells.map((cell) => cell.value)).toEqual(["Lauter", "Leiser", "Stumm", "Play / Pause", "Aus"]);
    expect(page.cells[1]).toMatchObject({ alert: true, label: "TIPPEN" });
    expect(homeDetail({ ...tv, on: false, state: "off" }, 0, "de", NOW, "h").graphic).toMatchObject({ kind: "tv", screen: "off" });
    expect(composeCockpit(page, backend, NOW).width).toBe(576);
  });

  it("agents as faces in their mood", () => {
    const report = { ...quiet(), approvals: [{ id: "c", agentId: "claude-win", title: "Bash: ls", detail: "ls", createdAt: "", expiresAt: NOW }] } as unknown as HubReport;
    const tiles = agentTiles(report, "de");
    expect(tiles.find((tile) => tile.key === "agent:claude-win")).toMatchObject({ value: "wartet", alert: true, graphic: { kind: "mascot", mood: "waiting" } });
  });
});

describe("ring page picker", () => {
  it("has one overview only, in the start page's order", async () => {
    const { pickerEntries } = await import("../src/hub/model");
    const labels = pickerEntries(createModel(quiet()), "de").map((entry) => entry.label);
    expect(labels).toEqual(["Übersicht", "Agenten", "Zuhause", "Auto", "Drucker", "Server", "Tag", "Meldungen"]);
  });
});

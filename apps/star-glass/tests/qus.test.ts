import { describe, expect, it, vi } from "vitest";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { locales, type Locale } from "../src/i18n";
import { messages } from "../src/messages";
import { createDemoNina, type DemoScene } from "../src/nina/demo";
import { parseStatus, type StarStatus } from "../src/nina/status";
import {
  HEADER_WIDTH, MODES, MODE_PAGES, PAGES, ROW_WIDTH, buildControlView, buildStartView, modeOf, startLabel,
  type Connection, type Page, type ViewState,
} from "../src/glasses/views";
import { sceneFor } from "../src/glasses/scene";
import { COCKPIT_TILES, guardedTileSend } from "../src/glasses/render";
import { frameFromRgba } from "../src/glasses/preview";
import { agoText, cockpitHint, cockpitModel, deviceTones, headlineOf, hhmm, modelKey, type CockpitModel } from "../src/cockpit/model";
import { CELL_WIDTH, EXPOSURE_RING, RING, arcStyle, cellBoxes, cellValueLayout, composeCockpit, headlineLayout, ringSegments } from "../src/cockpit/compose";
import { createFrame, frameKey, tiles, type Frame } from "../src/screen/frame";
import { createTileSender, tileSlots } from "../src/screen/sender";
import { pixelBackend } from "../src/screen/text";
import { TABS, bannerFor, heroFor, hourCards, isFirstRun, logInner, nowInner, pillFor, setupInner, statsFor } from "../src/ui/phone";
import { EMPTY_SETTINGS } from "../src/storage/persist";
import { demoForecast } from "../src/weather/demo";
import { DEFAULT_THRESHOLDS } from "../src/weather/warnings";

// QUS v1: the pure parts of the glasses - start rows, cockpit headline and cells, footer text, tile diff - and the phone's view models.
const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const backend = pixelBackend();
const demo = async (scene: DemoScene = "run"): Promise<StarStatus> => createDemoNina(() => 0, scene).status();

const state = (status: StarStatus | null, over: Partial<ViewState> = {}): ViewState => ({
  locale: "de", demo: false, connection: { kind: "ok" }, status, ageSeconds: 0, screen: "run", page: "overview", startCursor: 0, cursor: 0,
  armed: null, sending: false, message: "", hasPreview: false, now: NOW, ...over,
});
const model = (status: StarStatus | null, page: Page = "overview", over: Partial<ViewState> = {}): CockpitModel => cockpitModel(state(status, { page, ...over }));

/** A status with every text at its longest. */
const worst = parseStatus({
  online: true, version: "2.2.15.2-very-long-build",
  sequence: { state: "running", target: "NGC 7000 North America Nebula Wide Field Mosaic Panel 12", step: "Smart Exposure With A Long Plugin Name", frame: 1234, frames: 9999 },
  exposure: { active: true, total: 1800, remaining: 1799.9, progress: 0 },
  filter: "Hydrogen-Alpha 3nm Custom", camera: { connected: true, temp: -25.5, setpoint: -25, cooler: true, power: 100, canCool: true, atTarget: false },
  mount: { connected: true, tracking: true, alt: -88.8, az: 359.9, flipMinutes: 1439, pier: "west" },
  focuser: { connected: true, position: 1234567, temp: -18.25, moving: false },
  guider: { connected: true, guiding: false, rms: 12.34, ra: 10.11, dec: 11.22 },
  last: { index: 9999, at: "2026-10-13T01:00:00Z", type: "LIGHT", filter: "Hydrogen-Alpha 3nm Custom", exposure: 1800, hfr: 12.34, stars: 99999, target: "NGC 7000 North America Nebula Wide Field" },
  images: 99999, history: { hfr: [1, 2], temp: [], rms: [3] },
  events: [{ name: "ERROR-PLATESOLVE-WITH-LONG-NAME", ageSeconds: 1 }, { name: "SEQUENCE-FINISHED", ageSeconds: 2 }],
  preview: "k", controllable: true,
});

describe("start page", () => {
  it("has exactly three big entries, the cursor is a dot, and the first start says how to set up", async () => {
    expect(MODES).toEqual(["capture", "weather", "image"]);
    const view = buildStartView(state(await demo(), { screen: "start", startCursor: 1 }));
    expect(view.header).toBe("Star Glass · ● live");
    expect(view.body).toEqual(["  Aufnahme · läuft", "● Wetter", "  Letztes Bild · 22 Bilder"]);
    expect(view.footer).toBe("Tippen = öffnen · Wischen = wählen · 2× = Ende");
    const first = buildStartView(state(await demo(), { screen: "start", demoHint: true }));
    expect(first.header).toBe("Star Glass · Demo");
    expect(first.body.filter(Boolean)).toEqual(["● Aufnahme · läuft", "  Wetter", "  Letztes Bild · 22 Bilder", "Demo · Verbindung am Handy einrichten"]);
  });

  it("names what needs attention below the entries and the connection in the header", async () => {
    const lost = buildStartView(state(await demo("lost"), { screen: "start", locale: "en" }));
    expect(lost.body.at(-1)).toBe("! Guiding lost");
    expect(buildStartView(state(null, { screen: "start", connection: { kind: "loading" } })).header).toBe("Star Glass · lädt …");
    expect(buildStartView(state(null, { screen: "start", connection: { kind: "error", code: "http", status: 503 } })).header).toBe("Star Glass · offline");
    expect(buildStartView(state(parseStatus({ online: false, reason: "nina-silent" }), { screen: "start" })).header).toBe("Star Glass · offline");
  });

  it("a swipe walks the pages of the open mode only; weather and image are single pages", () => {
    expect(MODE_PAGES.capture).toEqual(["overview", "guiding", "equipment"]);
    expect(PAGES).toEqual(["overview", "guiding", "equipment", "weather", "image"]);
    expect(PAGES.map(modeOf)).toEqual(["capture", "capture", "capture", "weather", "image"]);
    expect(sceneFor(state(null, { screen: "start" })).kind).toBe("text");
    expect(sceneFor(state(null, { screen: "control" })).kind).toBe("text");
    expect(sceneFor(state(null, { screen: "run" })).kind).toBe("cockpit");
  });

  it("every start row, header and footer fits in both languages, in every state", async () => {
    const connections: Connection[] = [{ kind: "setup" }, { kind: "loading" }, { kind: "ok" }, { kind: "error", code: "http", status: 503 }];
    const statuses: Array<StarStatus | null> = [null, worst, await demo(), await demo("done"), await demo("lost"), parseStatus({ online: false, reason: "nina-silent" })];
    for (const locale of locales as Locale[]) for (const connection of connections) for (const status of statuses) for (const demoHint of [false, true]) {
      const view = buildStartView(state(status, { locale, connection, screen: "start", demoHint }));
      expect(view.header.length, view.header).toBeLessThanOrEqual(HEADER_WIDTH);
      expect(view.footer.length, view.footer).toBeLessThanOrEqual(ROW_WIDTH);
      for (const row of view.body) expect(row.length, `${locale} ${row}`).toBeLessThanOrEqual(ROW_WIDTH);
      expect(view.body.filter((row) => row.startsWith("●"))).toHaveLength(1);
      for (const mode of MODES) expect(startLabel(mode, state(status, { locale })).length).toBeLessThanOrEqual(ROW_WIDTH);
    }
  });

  it("control keeps its armed footer: tap arms, the footer says so, 2× and swipe cancel", async () => {
    const run = await demo();
    expect(buildControlView(state(run, { screen: "control" })).footer).toBe("Tippen = anwählen · Wischen = Zeile · 2× = zurück");
    expect(buildControlView(state(run, { screen: "control", armed: "stop" })).footer).toBe("Nochmal tippen = anhalten · Wischen/2× = abbrechen");
    expect(buildControlView(state(run, { screen: "control", armed: "stop", locale: "en" })).footer).toBe("Tap again = stop · Swipe/2× = cancel");
    expect(buildControlView(state(run, { screen: "control", armed: "stop" })).header).toBe("STARGLASS · Anhalten?");
  });
});

describe("cockpit headline", () => {
  it("says the frame while imaging, and the one alert that matters otherwise", async () => {
    expect(model(await demo()).headline).toEqual(["BILD 23/60"]);
    expect(model(await demo("lost")).headline).toEqual(["GUIDING", "VERLOREN"]);
    expect(model(await demo("flip")).headline).toEqual(["FLIP IN", "6 MIN"]);
    expect(model(await demo("warm")).headline).toEqual(["KÜHLUNG AUS"]);
    expect(model(await demo("done")).headline).toEqual(["SEQUENZ FERTIG"].flatMap((line) => headlineOf(line)));
    expect(model(await demo("lost"), "overview", { locale: "en" }).headline).toEqual(["GUIDING", "LOST"]);
  });

  it("splits a long headline at the space nearest the middle, never more than two lines", () => {
    expect(headlineOf("Bild 4/10")).toEqual(["BILD 4/10"]);
    expect(headlineOf("Wolken in ~30 min (90 %)")).toEqual(["WOLKEN IN ~30", "MIN (90 %)"]);
    expect(headlineOf("Kein Standort.")).toEqual(["KEIN", "STANDORT"]);
    expect(headlineOf("Montierungsgetrenntheitsanzeige")).toHaveLength(1);
  });

  it("no data says why instead of inventing numbers", async () => {
    const loading = model(null, "overview", { connection: { kind: "loading" } });
    expect(loading.headline).toEqual(["VERBINDE …"]);
    expect(loading.cells.every((cell) => cell.value === "–")).toBe(true);
    const failed = model(null, "overview", { connection: { kind: "error", code: "http", status: 503 } });
    expect(failed.headline).toEqual(["KEINE", "VERBINDUNG"]);
    expect(failed.caption).toBe("Bridge: Serverfehler");
    expect(failed.caption + failed.hint + failed.headline.join("")).not.toMatch(/HTTP|503/);
    const off = model(parseStatus({ online: false, reason: "nina-silent" }), "guiding");
    expect(off.headline).toEqual(["N.I.N.A. AUS"].flatMap((line) => headlineOf(line)));
    expect(off.caption).toBe("N.I.N.A. antwortet nicht.");
    expect(off.cells).toHaveLength(6);
    // The weather needs no bridge.
    expect(model(null, "weather", { connection: { kind: "setup" } }).graphic.kind).toBe("cloud");
  });

  it("a page that is not about the alert carries a mark in its title", async () => {
    expect(model(await demo("lost"), "guiding").title).toBe("STAR !");
    expect(model(await demo("lost"), "overview").title).toBe("STAR");
    expect(model(await demo(), "guiding").title).toBe("STAR");
  });
});

describe("cockpit cells", () => {
  it("overview: filter, exposure, camera, guiding, flip, altitude - the alert frames its cell", async () => {
    const cells = model(await demo()).cells;
    expect(cells.map((cell) => cell.label)).toEqual(["FILTER", "BELICHT.", "KAMERA", "GUIDING", "FLIP", "HÖHE"]);
    expect(cells.map((cell) => cell.value)).toEqual(["Ha", "180 s", "-10,0°", "0,52\"", "41 min", "64°"]);
    expect(cells.every((cell) => cell.alert === undefined)).toBe(true);
    expect((await model(await demo("lost")).cells)[3]).toEqual({ label: "GUIDING", value: "3,80\"", alert: true });
    expect(model(await demo("flip")).cells[4]).toMatchObject({ value: "6 min", alert: true });
    expect(model(await demo("warm")).cells[2]).toMatchObject({ alert: true });
    expect(model(await demo(), "overview", { locale: "en" }).cells.map((cell) => cell.label)).toEqual(["FILTER", "EXPOS.", "CAMERA", "GUIDING", "FLIP", "ALT"]);
  });

  it("guiding: RA, Dec, HFR, stars, focus position and temperature; the panels carry the series", async () => {
    const m = model(await demo(), "guiding");
    expect(m.headline).toEqual(['RMS 0,52"']);
    expect(m.cells.map((cell) => cell.label)).toEqual(["RA", "DEC", "HFR", "STERNE", "FOKUS", "F-TEMP"]);
    expect(m.cells.map((cell) => cell.value)).toEqual(['0,41"', '0,47"', "2,55", "1842", "25310", "8,4°"]);
    expect(m.graphic.kind).toBe("panels");
    if (m.graphic.kind === "panels") { expect(m.graphic.rms.series.length).toBeGreaterThan(10); expect(m.graphic.rms.alarm).toBe(false); }
    const lost = model(await demo("lost"), "guiding");
    expect(lost.headline).toEqual(["GUIDING", "VERLOREN"]);
    if (lost.graphic.kind === "panels") expect(lost.graphic.rms.alarm).toBe(true);
    const none = parseStatus({ online: true, sequence: { state: "idle" }, guider: { connected: false } });
    expect(model(none, "guiding").headline).toEqual(["KEIN GUIDER"]);
  });

  it("equipment: a ring of devices, the headline counts what is missing", async () => {
    const run = await demo();
    const m = model(run, "equipment");
    expect(m.headline).toEqual(["ALLES", "BEREIT"]);
    expect(m.graphic).toEqual({ kind: "ring", segments: ["ok", "ok", "ok", "ok"], center: "4/4", sub: "GERÄTE OK" });
    expect(m.cells.map((cell) => cell.label)).toEqual(["KAMERA", "KÜHLUNG", "MONTIER.", "FOKUSSIER.", "GUIDER", "FILTER"]);
    expect(m.cells.map((cell) => cell.value)).toEqual(["-10,0°", "38%", "FÜHRT", "25310", "AKTIV", "Ha"]);
    if (!run.online) throw new Error("online");
    const down = { ...run, camera: { ...run.camera, connected: false }, guider: { ...run.guider, connected: false } };
    expect(deviceTones(down)).toEqual(["offline", "ok", "ok", "offline"]);
    expect(model(down, "equipment").headline).toEqual(["2 GERÄTE", "FEHLEN"]);
    expect(model(down, "equipment").graphic).toMatchObject({ center: "2/4" });
    const one = { ...run, focuser: { ...run.focuser, connected: false } };
    expect(model(one, "equipment").headline).toEqual(["1 GERÄT", "FEHLT"]);
    const warm = await demo("warm");
    expect(model(warm, "equipment").headline).toEqual(["1 PRÜFEN"]);
    expect(model(warm, "equipment").cells[1]).toMatchObject({ value: "AUS", alert: true });
  });

  it("image: the quality of the newest frame is the headline", async () => {
    const m = model(await demo(), "image", { hasPreview: true });
    expect(m.headline).toEqual(["HFR 2,55"]);
    expect(m.cells.map((cell) => cell.label)).toEqual(["FILTER", "BELICHT.", "STERNE", "BILDER", "TYP", "VOR"]);
    expect(m.cells.map((cell) => cell.value)).toEqual(["Ha", "180 s", "1842", "22", "LIGHT", "–"]);
    expect(m.graphic).toEqual({ kind: "preview", key: "demo-22" });
    expect(m.caption).toBe("M 31 Andromeda");
    expect(m.note).toBe("");
    expect(model(await demo(), "image").note).toBe("Vorschau aus");
    const none = parseStatus({ online: true, sequence: { state: "idle" }, images: 0 });
    expect(model(none, "image").headline).toEqual(["KEIN BILD"]);
    expect(agoText(30)).toBe("30 s");
    expect(agoText(600)).toBe("10 min");
    expect(agoText(7200)).toBe("2 h");
  });

  it("the first-start demo says so in the caption of every night page", async () => {
    for (const page of ["overview", "guiding", "equipment", "image"] as const) expect(model(await demo(), page, { demoHint: true }).caption).toBe("Demo · am Handy einrichten");
    expect(model(await demo(), "overview", { demoHint: true, locale: "en" }).caption).toBe("Demo · set up on phone");
  });

  it("every cell, headline and caption fits its place in both languages, worst case", async () => {
    const statuses: Array<StarStatus | null> = [null, worst, await demo(), await demo("lost"), await demo("done"), parseStatus({ online: false, reason: "starting" })];
    const connections: Connection[] = [{ kind: "setup" }, { kind: "loading" }, { kind: "ok" }, { kind: "error", code: "http", status: 503 }];
    for (const locale of locales as Locale[]) for (const connection of connections) for (const status of statuses) for (const page of PAGES) {
      const m = model(status, page, { locale, connection, demoHint: false, ageSeconds: 99 });
      expect(m.cells, `${locale} ${page}`).toHaveLength(6);
      expect(m.headline.length).toBeLessThanOrEqual(2);
      // Nothing is cut: the laid-out text is the text.
      expect(headlineLayout(backend, m.headline).lines, m.headline.join("|")).toEqual(m.headline);
      // Free text from N.I.N.A. (the filter's and the frame type's name) may be cut with an ellipsis; every number and word of ours may not.
      for (const cell of m.cells.filter((c) => !["FILTER", "TYP", "TYPE"].includes(c.label))) expect(cellValueLayout(backend, cell.value, CELL_WIDTH).text, `${locale} ${page} ${cell.label}`).toBe(cell.value);
      expect(m.hint.length, m.hint).toBeLessThanOrEqual(ROW_WIDTH);
      expect(composeCockpit(m, backend).pixels.some((level) => level > 0)).toBe(true);
    }
  });
});

describe("cockpit hint", () => {
  it("is one footer line with only the gestures that do something here", async () => {
    const run = await demo();
    expect(cockpitHint(state(run, { page: "overview" }))).toBe("1/3 · Tippen = steuern · Wischen = Seite · 2× = zurück");
    expect(cockpitHint(state(run, { page: "equipment", locale: "en" }))).toBe("3/3 · Tap = control · Swipe = page · 2× = back");
    expect(cockpitHint(state(run, { page: "weather" }))).toBe("Tippen = neu laden · 2× = zurück");
    expect(cockpitHint(state(run, { page: "image" }))).toBe("Tippen = neu laden · 2× = zurück");
    // Without control (display only, or no connection) a tap refreshes.
    if (!run.online) throw new Error("online");
    expect(cockpitHint(state({ ...run, controllable: false }, { page: "overview" }))).toBe("1/3 · Tippen = neu laden · Wischen = Seite · 2× = zurück");
    expect(cockpitHint(state(null, { page: "overview", connection: { kind: "loading" } }))).toBe("1/3 · Tippen = neu laden · Wischen = Seite · 2× = zurück");
  });

  it("every hint ends in back and keeps the gesture order", async () => {
    const run = await demo();
    for (const locale of locales as Locale[]) for (const page of PAGES) {
      const hint = cockpitHint(state(run, { page, locale }));
      expect(hint).toMatch(locale === "de" ? /2× = zurück$/ : /2× = back$/);
      const order = locale === "de" ? ["Tippen", "Wischen", "2×"] : ["Tap", "Swipe", "2×"];
      const positions = order.map((word) => hint.indexOf(word)).filter((i) => i >= 0);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it("the clock is the phone's HH:MM", () => {
    expect(hhmm(NOW)).toBe("14:05");
    expect(hhmm(Date.UTC(2026, 9, 17, 12, 5), 120)).toBe("14:05");
    expect(model(null).clock).toBe("14:05");
  });
});

describe("tile diff", () => {
  const frameOf = async (over: Partial<ViewState> = {}, status?: StarStatus): Promise<Frame> => composeCockpit(model(status ?? await demo(), "overview", over), backend);
  const tileKeys = (frame: Frame): string[] => tiles(frame).map(frameKey);
  const changed = (a: string[], b: string[]): number[] => a.map((key, index) => (key === b[index] ? -1 : index)).filter((index) => index >= 0);

  it("an unchanged state draws the same frame, tile for tile", async () => {
    expect(tileKeys(await frameOf())).toEqual(tileKeys(await frameOf()));
    expect(modelKey(model(await demo()))).toBe(modelKey(model(await demo())));
  });

  it("the clock alone changes only the top right tile", async () => {
    expect(changed(tileKeys(await frameOf()), tileKeys(await frameOf({ now: NOW + 60_000 })))).toEqual([1]);
  });

  it("a countdown step changes only the ring's tile (top left), nothing else", async () => {
    const run = await demo();
    // 63 s -> 60 s is one step of the shown countdown (5 s steps above 30 s; the ring's percent steps are 2 %).
    const a = await frameOf({ ageSeconds: 0 }, run);
    const b = await frameOf({ ageSeconds: 5 }, run);
    expect(frameKey(a)).not.toBe(frameKey(b));
    expect(changed(tileKeys(a), tileKeys(b))).toEqual([0]);
    expect(EXPOSURE_RING.y + 144).toBeLessThanOrEqual(144);
  });

  it("the sender sends all four tiles once, then nothing for an identical frame, then only what changed", async () => {
    const sent: string[] = [];
    const sender = createTileSender(tileSlots(21, "t"), async (slot) => { sent.push(slot.name); return true; }, () => new Uint8Array(1));
    await sender.push(await frameOf());
    expect(sent).toEqual(["t-nw", "t-ne", "t-sw", "t-se"]);
    await sender.push(await frameOf());
    expect(sent).toHaveLength(4);
    await sender.push(await frameOf({ now: NOW + 60_000 }));
    expect(sent.slice(4)).toEqual(["t-ne"]);
    // A rebuilt page starts blank: everything goes out again.
    sender.reset();
    await sender.push(await frameOf({ now: NOW + 60_000 }));
    expect(sent).toHaveLength(9);
  });

  it("no tile is written while the exit dialog may be up: the guarded sender refuses before any bridge call", async () => {
    const updateImageRawData = vi.fn(async () => "success");
    const bridge = { updateImageRawData } as unknown as EvenAppBridge;
    let allowed = false;
    const send = guardedTileSend(bridge, () => allowed);
    expect(await send(COCKPIT_TILES[0], new Uint8Array(1))).toBe(false);
    expect(updateImageRawData).not.toHaveBeenCalled();
    allowed = true;
    expect(await send(COCKPIT_TILES[0], new Uint8Array(1))).toBe(true);
    expect(updateImageRawData).toHaveBeenCalledTimes(1);
    expect(COCKPIT_TILES.map((tile) => tile.name)).toEqual(["star-nw", "star-ne", "star-sw", "star-se"]);
  });

  it("lays the six cells out in two rows of three inside the right half", async () => {
    const boxes = cellBoxes(model(await demo()).cells);
    expect(boxes.map((box) => [box.x > 288, box.y])).toEqual([[true, 118], [true, 118], [true, 118], [true, 174], [true, 174], [true, 174]]);
    expect(boxes.every((box) => box.x + box.width <= 576)).toBe(true);
    expect(createFrame().pixels.some((level) => level > 0)).toBe(false);
    expect(RING.x).toBe(144);
    expect(ringSegments(4)).toHaveLength(4);
    expect(arcStyle("warn").dash).toBeGreaterThan(1);
  });
});

describe("preview picture", () => {
  it("turns camera pixels into grey levels, stretched so faint stars show", () => {
    const rgba = new Uint8Array(200 * 4);
    for (let i = 0; i < 200; i += 1) { const v = [0, 15, 30, 60][i % 4]!; rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; }
    const frame = frameFromRgba(rgba, 20, 10);
    expect(Array.from(frame.pixels.slice(0, 4))).toEqual([0, 4, 8, 15]);
    expect(Math.max(...frame.pixels)).toBe(15);
  });
});

describe("phone", () => {
  const ok = { kind: "ok" } as const;
  const weather = { location: "nina", fetchedAt: NOW, error: null, forecast: demoForecast(NOW), warnings: [] } as const;

  it("has exactly three tabs, Jetzt / Verlauf / Einstellungen", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["now", "log", "settings"]);
    expect(TABS.map((tab) => messages.de[tab.key])).toEqual(["Jetzt", "Verlauf", "Einstellungen"]);
  });

  it("the pill and the banner carry the connection and the one message that counts", async () => {
    const run = await demo();
    expect(pillFor(ok, run, "de")).toEqual({ on: true, text: "● verbunden" });
    expect(pillFor({ kind: "none" }, null, "de").text).toBe("Beispiel");
    expect(pillFor({ kind: "error", reason: "x" }, null, "de").text).toBe("offline");
    expect(bannerFor(ok, run, [], "de")).toEqual({ tone: "ok", text: "Alles in Ordnung." });
    expect(bannerFor(ok, await demo("lost"), [], "de")).toEqual({ tone: "critical", text: "! Guiding verloren" });
    expect(bannerFor(ok, await demo("flip"), [], "en")).toEqual({ tone: "warn", text: "Meridian flip in 6 min" });
    expect(bannerFor(ok, run, [{ kind: "clouds", level: "warn", minutes: 40, value: 75, source: "forecast" }], "de")).toEqual({ tone: "warn", text: "Wolken in ~40 min (75 %)" });
    expect(bannerFor({ kind: "demo" }, run, [], "de").tone).toBe("none");
    expect(bannerFor({ kind: "error", reason: "Serverfehler (HTTP 503)" }, null, [], "de")).toEqual({ tone: "offline", text: "Bridge: Serverfehler (HTTP 503)" });
    expect(bannerFor(ok, parseStatus({ online: false, reason: "x" }), [], "de").tone).toBe("offline");
  });

  it("the hero value is the frame, the stats are HFR, guiding, camera and clouds, one button", async () => {
    const run = await demo();
    expect(heroFor(run, "de")).toEqual({ label: "Bild", value: "23/60", side: "M 31 Andromeda" });
    expect(heroFor(null, "de").value).toBe("–");
    expect(statsFor(run, weather, NOW, "de").map((stat) => [stat.label, stat.value])).toEqual([["HFR", "2,55"], ["Guiding", "0,52"], ["Kamera", "-10,0"], ["Wolken", "15"]]);
    const html = nowInner(ok, run, weather, DEFAULT_THRESHOLDS, NOW, "de");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('id="refresh"');
    expect(html.split('class="strip"')[0]!.match(/<b>/g)).toHaveLength(4);
    expect(html).toContain('class="strip"');
    expect(html).toContain("23/60");
    expect(hourCards(weather.forecast, DEFAULT_THRESHOLDS, NOW, "de")).toHaveLength(8);
    expect(hourCards(null, DEFAULT_THRESHOLDS, NOW, "de")).toEqual([]);
    expect(nowInner(ok, run, null, DEFAULT_THRESHOLDS, NOW, "de")).not.toContain('class="strip"');
  });

  it("the log tab is strips of readings and a list of events", async () => {
    const html = logInner(await demo("lost"), "de");
    expect(html.match(/class="strip"/g)).toHaveLength(2);
    expect(html).toContain("GUIDER-STOP");
    expect(logInner(null, "de")).toContain("Noch keine Messwerte.");
  });

  it("the first-run checklist has three steps and ticks them off", async () => {
    expect(isFirstRun(EMPTY_SETTINGS)).toBe(true);
    const none = setupInner(EMPTY_SETTINGS, { kind: "none" }, null, "de");
    expect(none.match(/<li/g)).toHaveLength(3);
    expect(none).not.toContain("✓");
    const set = { ...EMPTY_SETTINGS, bridgeUrl: "https://bridge.example:8460" };
    expect(isFirstRun(set)).toBe(false);
    expect(setupInner(set, { kind: "loading" }, null, "de").match(/✓/g)).toHaveLength(1);
    expect(setupInner(set, ok, await demo(), "de").match(/✓/g)).toHaveLength(3);
  });
});

describe("texts", () => {
  it("German and English have the same keys", () => {
    expect(Object.keys(messages.de).sort()).toEqual(Object.keys(messages.en).sort());
  });

  it("side menu labels fit 32 bytes in both languages", () => {
    for (const locale of locales) for (const key of ["m.refresh", "m.swipeNormal", "m.swipeInverted"]) {
      expect(new TextEncoder().encode(messages[locale][key] ?? "").length, `${locale} ${key}`).toBeLessThanOrEqual(32);
    }
  });

  it("uses the glossary: German has no Tap, Wisch, 2x or Doppeltipp; English has no 2x or Double tap", () => {
    const glasses = (locale: Locale): string =>
      Object.entries(messages[locale]).filter(([key]) => /^(g|p\.c)\./.test(key)).map(([, text]) => text).join(String.fromCharCode(10));
    expect(glasses("de")).not.toMatch(/\bTap\b|\bWisch\b|\b2x\b|Doppeltipp/);
    expect(glasses("en")).not.toMatch(/\b2x\b|Double tap|Doppeltipp/);
  });

  it("the glasses show no help page any more (QUS: no help pages)", () => {
    expect(Object.keys(messages.de).filter((key) => /^g\.help\.|^g\.h\.help$|^m\.help$/.test(key))).toEqual([]);
  });
});

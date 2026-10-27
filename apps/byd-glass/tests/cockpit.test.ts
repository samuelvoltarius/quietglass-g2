import { describe, expect, it } from "vitest";
import { validateEvenHubPageContainer, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { deriveRaw } from "../src/car/derive";
import { demoTelemetry, type DemoScene } from "../src/car/demo";
import { parseState, type CarState } from "../src/car/model";
import { buildView, type ViewState } from "../src/glasses/views";
import { COCKPIT_TILES, buildPage, guardedTileSend } from "../src/glasses/render";
import { cockpitModel, modelKey } from "../src/cockpit/model";
import { arcStyle, cellBoxes, composeCockpit, headlineLayout, sweepFor } from "../src/cockpit/compose";
import { frameKey } from "../src/screen/frame";
import { createTileSender } from "../src/screen/sender";
import { pixelBackend } from "../src/screen/text";
import type { Page } from "../src/pages";
import { bannerFor, isFirstRun, nowInner, setupInner, TABS } from "../src/ui/phone";
import { EMPTY_SETTINGS } from "../src/storage/persist";
import { greenPng } from "./green-png";

// QUS v1: the pure parts of the cockpit and the phone - headline, cells, hint, tile diff, tabs.
const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const backend = pixelBackend();

function car(scene: DemoScene, over: Record<string, unknown> = {}): CarState {
  return parseState({
    ...deriveRaw(demoTelemetry(scene, 1_000), 1, {}),
    rev: 1,
    ...over,
  });
}

const state = (page: Page, c: CarState | null, extra: Partial<ViewState> = {}): ViewState => ({
  locale: "de", demo: false, connection: { kind: "ok" }, car: c, page, overlay: null, now: NOW, ...extra,
});

describe("cockpit model", () => {
  it("status (parked): the range is the headline, the charge is the ring, six cells", () => {
    const c = car("parked");
    const model = cockpitModel(state("status", c));
    expect(model.headline[1]).toBe("REICHWEITE");
    expect(model.headline[0]).toMatch(/^\d+ KM$/);
    expect(model.cells.map((cell) => cell.label)).toEqual(["SCHLOSS", "TÜREN", "REIFEN", "KLIMA", "KM", "STAND"]);
    expect(model.cells.map((cell) => cell.value)).toEqual(["ZU", "ZU", "OK", "AUS", "28015", "LIVE"]);
    expect(model.graphic.percent).toBe(c.battery.soc);
    expect(model.graphic.center).toBe(`${Math.round(c.battery.soc!)}%`);
    expect(model.title).toBe("BYD");
    expect(model.clock).toBe("14:05");
    expect(cockpitModel(state("status", c, { demo: true })).title).toBe("BYD · DEMO");
  });

  it("drive: the speed is the headline; charge: the power while charging, DONE when finished", () => {
    const drive = cockpitModel(state("drive", car("drive")));
    expect(drive.headline[0]).toMatch(/^\d+ KM\/H$/);
    expect(drive.cells.map((cell) => cell.label)).toEqual(["LEISTUNG", "VERBR.", "REICHW.", "KLIMA", "AUSSEN", "TRIP"]);
    // Climate: on/off and the fan level, never a temperature (no cabin sensor; the setpoint is no reading).
    expect(drive.cells.find((cell) => cell.label === "KLIMA")!.value).toBe("AN · STUFE 2");
    expect(cockpitModel(state("drive", car("drive"), { locale: "en" })).cells.find((cell) => cell.label === "CLIMATE")!.value).toBe("ON · FAN 2");
    const charging = cockpitModel(state("charge", car("charge")));
    expect(charging.headline[0]).toMatch(/^[\d,]+ KW$/);
    expect(charging.headline[1]).toMatch(/^LÄDT (AC|DC)$/);
    expect(charging.graphic.charging).toBe(true);
    expect(charging.cells.map((cell) => cell.label)).toEqual(["REICHW.", "GELADEN", "REST", "TYP", "ZELLEN", "STAND"]);
    const c = car("charge");
    const done = cockpitModel(state("charge", { ...c, charge: { ...c.charge, active: false, done: true } }));
    expect(done.headline[0]).toBe("FERTIG");
    const idle = cockpitModel(state("charge", { ...c, charge: { ...c.charge, active: false, done: false } }));
    expect(idle.headline[1]).toBe("NICHT LADEND");
  });

  it("English labels; a value the car does not report leaves its cell out (other BYD models), never 0", () => {
    const model = cockpitModel(state("status", car("parked"), { locale: "en" }));
    expect(model.headline[1]).toBe("RANGE");
    expect(model.cells.map((cell) => cell.label)).toEqual(["LOCK", "DOORS", "TYRES", "CLIMATE", "KM", "AS OF"]);
    const c = car("parked");
    const bare = cockpitModel(state("status", {
      ...c,
      battery: { ...c.battery, soc: null, rangeKm: null, odometerKm: null },
      body: { ...c.body, acOn: null, acFan: null, locked: null, doorOpen: null, trunkOpen: null, hoodOpen: null },
    }));
    expect(bare.headline[0]).toBe("– KM");
    expect(bare.graphic.percent).toBeNull();
    expect(bare.graphic.center).toBe("–");
    // Lock, doors, climate and km are unknown: they drop out, 12 V, outside and SoH move up.
    expect(bare.cells.map((cell) => cell.label)).toEqual(["REIFEN", "STAND", "12 V", "AUSSEN", "SOH"]);
    for (const cell of bare.cells) expect(cell.value).not.toMatch(/^(–|0)$/);
    // A car that reports nothing but its charge level: no cell invents a value.
    const empty = parseState({ mode: "parked", stale: false, battery: { soc: 70 } });
    const only = cockpitModel(state("status", empty));
    expect(only.cells.map((cell) => cell.label)).toEqual(["STAND"]);
  });

  it("an open door, an unlocked car and a leaking tyre frame their cells and name the warning in the caption; a critical warning is critical", () => {
    const model = cockpitModel(state("status", car("warn")));
    expect(model.cells.find((cell) => cell.label === "REIFEN")).toMatchObject({ value: "PRÜFEN", alert: true });
    expect(model.tone).toBe("critical");
    expect(model.caption).toContain("REIFEN");
  });

  it("stale or unreachable data is offline: no live clock claims, the caption says why", () => {
    const stale = cockpitModel(state("status", { ...car("parked"), stale: true, ageS: 7_200 }));
    expect(stale.tone).toBe("offline");
    expect(stale.cells.find((cell) => cell.label === "STAND")!.value).toMatch(/^VOR 2 H/);
    const error = cockpitModel(state("status", car("parked"), { connection: { kind: "error", code: "unreachable" } }));
    expect(error.caption).toContain("nicht erreichbar");
    expect(error.tone).toBe("offline");
  });

  it("the one hint line keeps the gestures in order and ends with 2× = Ende, within the row, in both languages", () => {
    for (const locale of ["de", "en"] as const) {
      for (const page of ["drive", "charge", "status"] as const) {
        const hint = cockpitModel(state(page, car("parked"), { locale })).hint;
        expect(hint.length).toBeLessThanOrEqual(56);
        expect(hint.endsWith(locale === "de" ? "2× = Ende" : "2× = exit")).toBe(true);
      }
    }
    expect(cockpitModel(state("status", car("parked"))).hint).toBe("Wischen = Seite · 2× = Ende");
  });

  it("the key changes with a value and not with the second hand", () => {
    const a = cockpitModel(state("status", car("parked")));
    expect(modelKey(cockpitModel(state("status", car("parked"))))).toBe(modelKey(a));
    expect(modelKey(cockpitModel(state("status", car("parked"), { now: NOW + 60_000 })))).not.toBe(modelKey(a));
  });
});

describe("cockpit page and drawing", () => {
  it("the cockpit page is four image tiles over an input container and passes the SDK validator", () => {
    const page = buildPage(buildView(state("status", car("parked"))));
    expect(page.imageObject ?? []).toHaveLength(4);
    expect((page.textObject ?? []).filter((c) => c.isEventCapture === 1)).toHaveLength(1);
    expect(validateEvenHubPageContainer(page).valid).toBe(true);
    const warn = car("warn");
    const plain = buildPage(buildView(state("status", warn, { overlay: warn.warnings })));
    expect(plain.imageObject ?? []).toHaveLength(0);
    expect(validateEvenHubPageContainer(plain).valid).toBe(true);
  });

  const frameFor = (patch: Partial<ViewState> = {}, page: Page = "status", scene: DemoScene = "parked") => composeCockpit(cockpitModel(state(page, car(scene), patch)), backend);

  it("draws a repeatable frame with ink on both halves; the three pages differ", () => {
    const frame = frameFor();
    expect(frameKey(frameFor())).toBe(frameKey(frame));
    expect(frame.pixels.some((level, index) => level > 0 && index % frame.width < 288)).toBe(true);
    expect(frame.pixels.some((level, index) => level > 0 && index % frame.width >= 288)).toBe(true);
    expect(frameKey(frameFor({}, "drive", "drive"))).not.toBe(frameKey(frame));
    expect(frameKey(frameFor({}, "charge", "charge"))).not.toBe(frameKey(frame));
  });

  it("fits the worst case: long numbers, every warning, both languages", () => {
    const base = car("warn");
    const worst: CarState = {
      ...base, stale: true, ageS: 7_200,
      drive: { ...base.drive, speed: 188, cons50: 288.8, tripKm: 1234.5, gear: "D", powerKw: -150 },
      battery: { ...base.battery, soc: 100, rangeKm: 1000, cellTMin: -20, cellTMax: 55, odometerKm: 999999 },
      charge: { active: true, dc: true, kw: 150, etaMin: 599, kwh: 100.5, done: false },
    };
    for (const locale of ["de", "en"] as const) {
      for (const page of ["drive", "charge", "status"] as const) {
        const model = cockpitModel(state(page, worst, { locale }));
        expect(headlineLayout(backend, model.headline).lines.length).toBeGreaterThan(0);
        for (const box of cellBoxes(model.cells)) expect(box.x + box.width).toBeLessThanOrEqual(576);
        expect(composeCockpit(model, backend).pixels.some((level) => level > 0)).toBe(true);
      }
    }
  });

  it("the ring fills clockwise from twelve o'clock; a warning draws dashes", () => {
    expect(sweepFor(25)).toBeCloseTo(Math.PI / 2);
    expect(sweepFor(150)).toBeCloseTo(Math.PI * 2);
    expect(arcStyle("warn").gap).toBeGreaterThan(0);
    expect(arcStyle("ok").gap).toBe(0);
  });

  it("an unchanged state sends no tile again; a new value sends only the changed tiles; the clock alone one tile", async () => {
    const sent: string[] = [];
    const sender = createTileSender(COCKPIT_TILES, async (slot) => { sent.push(slot.name); return true; });
    await sender.push(frameFor());
    expect(sent).toHaveLength(4);
    sent.length = 0;
    await sender.push(frameFor());
    expect(sent).toEqual([]);
    const c = car("parked");
    await sender.push(composeCockpit(cockpitModel(state("status", { ...c, battery: { ...c.battery, soc: 12 } })), backend));
    expect(sent.length).toBeGreaterThan(0);
    await sender.push(frameFor());
    sent.length = 0;
    // A minute later only the clock (top right) and the "Stand 14:06" caption (bottom left) differ.
    await sender.push(frameFor({ now: NOW + 60_000 }));
    expect([...sent].sort()).toEqual(["byd-ne", "byd-sw"]);
  });

  it("the guarded write sends nothing while it is not allowed (exit dialog, other page)", async () => {
    let allowed = false;
    const writes: number[] = [];
    const bridge = { updateImageRawData: async () => { writes.push(1); return "success"; } } as unknown as EvenAppBridge;
    const send = guardedTileSend(bridge, () => allowed);
    expect(await send(COCKPIT_TILES[0], new Uint8Array([1]))).toBe(false);
    expect(writes).toEqual([]);
    allowed = true;
    await send(COCKPIT_TILES[0], new Uint8Array([1]));
    expect(writes).toEqual([1]);
  });
});

describe("phone (QUS v1)", () => {
  it("has exactly three tabs", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["now", "car", "settings"]);
  });

  it("the banner says the one thing that counts", () => {
    expect(bannerFor({ kind: "demo" }, null, "de").text).toContain("Keine Bridge");
    expect(bannerFor({ kind: "error", reason: "nicht erreichbar" }, null, "de").tone).toBe("offline");
    expect(bannerFor({ kind: "ok" }, car("parked"), "de").tone).toBe("ok");
    expect(bannerFor({ kind: "ok" }, car("warn"), "de").tone).toBe("critical");
  });

  it("Jetzt: hero with the charge, 2 x 2 key figures, a strip of tyre cards", () => {
    const html = nowInner({ kind: "ok" }, car("parked"), "de");
    expect(html).toContain('class="card hero-card"');
    expect(html.match(/<div[ >][^<]*<span>/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(html.match(/class="host /g)).toHaveLength(4);
  });

  it("first run: a checklist with three steps, Einstellungen first; once set up the checklist is done", () => {
    expect(isFirstRun(EMPTY_SETTINGS)).toBe(true);
    const html = setupInner(EMPTY_SETTINGS, { kind: "demo" }, null, "de");
    expect(html.match(/<li/g)).toHaveLength(3);
    expect(html).toContain("Bis dahin läuft die Demo");
    const done = setupInner({ ...EMPTY_SETTINGS, url: "https://car.example:8471" }, { kind: "ok" }, car("parked"), "de");
    expect(done.match(/class="done"/g)).toHaveLength(3);
  });
});

/**
 * Glasses previews for review (not shipped): the cockpit frame, green on black like the glasses.
 *
 *   QG_PREVIEW=1 npx vitest run tests/cockpit.test.ts
 *
 * writes store/preview-cockpit.png (parked) and store/preview-cockpit-warn.png (a tyre loses pressure).
 * Node has no canvas, so these use the 5 x 7 pixel font; on the glasses the system font draws the text.
 */
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined>; cwd(): string } }).process;
describe("cockpit previews", () => {
  it.skipIf(env.env["QG_PREVIEW"] === undefined)("writes the preview PNGs to store/", async () => {
    const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as unknown as { writeFileSync(path: string, data: Uint8Array): void };
    const states: [string, ViewState][] = [
      ["preview-cockpit.png", state("status", car("parked"))],
      ["preview-cockpit-warn.png", state("drive", car("warn"))],
    ];
    for (const [file, view] of states) fs.writeFileSync(`${env.cwd()}/store/${file}`, await greenPng(composeCockpit(cockpitModel(view), backend)));
  });
});

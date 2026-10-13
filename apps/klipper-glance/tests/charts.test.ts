import { describe, expect, it } from "vitest";
import { validateEvenHubPageContainer, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { CURVE_HEIGHT, CURVE_WIDTH, RING_SIZE, curveFrame, ringFrame } from "../src/glasses/charts";
import { bitmapKey, getPixel } from "../src/glasses/gfx";
import { CURVE_WINDOW_MS, TempHistory, demoTempSamples } from "../src/printer/history";
import { parseStatus, type PrinterStatus } from "../src/printer/status";
import { buildPrintView, buildView, layoutFor, SIDE_ROWS, SIDE_WIDTH, type ViewState } from "../src/glasses/views";
import { CURVE, RING, buildPage, createPage, rebuildPage, updatePage } from "../src/glasses/render";
import { locales } from "../src/i18n";

const online = (patch: Record<string, unknown> = {}): PrinterStatus => parseStatus({
  online: true, state: "printing", file: "halterung_v3.gcode", progress: 42, layer: 75, layers: 180, minutesLeft: 80,
  nozzle: { now: 219, target: 220 }, bed: { now: 60, target: 60 }, speed: 100, message: "", controllable: true, ...patch,
});

function state(patch: Partial<ViewState> = {}): ViewState {
  return {
    locale: "de", demo: false, connection: { kind: "ok" }, status: online(), ageSeconds: 0,
    screen: "hud", cursor: 0, armed: null, sending: false, message: "", ...patch,
  };
}

describe("progress ring", () => {
  it("is 144 x 144 with ink, and a pure function of the percentage", () => {
    const a = ringFrame(42);
    expect(a.width).toBe(RING_SIZE);
    expect(a.height).toBe(RING_SIZE);
    expect(RING_SIZE).toBeLessThanOrEqual(144);
    expect(a.pixels.some((v) => v === 255)).toBe(true);
    expect(bitmapKey(a)).toBe(bitmapKey(ringFrame(42)));
    expect(bitmapKey(a)).not.toBe(bitmapKey(ringFrame(43)));
  });

  it("fills clockwise from twelve o'clock", () => {
    const quarter = ringFrame(30);
    // Ring band at the top (12 o'clock side) and the right (3 o'clock) is full, the left (9 o'clock) and bottom are dim.
    expect(getPixel(quarter, 72, 8)).toBe(255);
    expect(getPixel(quarter, 135, 72)).toBe(255);
    expect(getPixel(quarter, 8, 72)).toBe(85);
    expect(getPixel(quarter, 72, 135)).toBe(85);
    expect(getPixel(ringFrame(100), 8, 72)).toBe(255);
    expect(getPixel(ringFrame(0), 72, 8)).toBe(85);
  });

  it("copes with out-of-range and broken percentages and draws every number from 0 to 100", () => {
    for (const value of [-5, 0, 7, 10, 99, 100, 250, Number.NaN]) {
      const b = ringFrame(value);
      expect(b.pixels).toHaveLength(RING_SIZE * RING_SIZE);
    }
    const keys = new Set(Array.from({ length: 101 }, (_, i) => bitmapKey(ringFrame(i))));
    expect(keys.size).toBe(101);
  });
});

describe("nozzle history and curve", () => {
  it("keeps five minutes and ignores a missing nozzle", () => {
    const history = new TempHistory();
    history.add(0, { now: 20, target: 0 });
    history.add(CURVE_WINDOW_MS + 5_000, { now: 210, target: 210 });
    history.add(CURVE_WINDOW_MS + 6_000, null);
    expect(history.samples().map((s) => s.now)).toEqual([210]);
    history.clear();
    expect(history.samples()).toEqual([]);
  });

  it("drops samples from the future when the clock jumps back", () => {
    const history = new TempHistory();
    history.add(10_000, { now: 100, target: 0 });
    history.add(5_000, { now: 90, target: 0 });
    expect(history.samples().map((s) => s.now)).toEqual([90]);
  });

  it("curve is 288 x 64 and changes only with new samples", () => {
    const samples = demoTempSamples(1_000_000);
    const a = curveFrame(samples);
    expect(a.width).toBe(CURVE_WIDTH);
    expect(a.height).toBe(CURVE_HEIGHT);
    expect(CURVE_HEIGHT).toBeLessThanOrEqual(64);
    expect(a.pixels.some((v) => v > 0)).toBe(true);
    expect(bitmapKey(a)).toBe(bitmapKey(curveFrame(demoTempSamples(1_000_000))));
    const more = [...samples, { t: 1_005_000, now: 223, target: 220 }];
    expect(bitmapKey(curveFrame(more))).not.toBe(bitmapKey(a));
  });

  it("copes with no samples, one sample, a flat line and a cold printer without target", () => {
    expect(curveFrame([]).pixels).toHaveLength(CURVE_WIDTH * CURVE_HEIGHT);
    for (const samples of [
      [{ t: 1, now: 25, target: 0 }],
      [{ t: 1, now: 200, target: 200 }, { t: 2, now: 200, target: 200 }],
      [{ t: 1, now: 25, target: 0 }, { t: 5_000, now: 26, target: 0 }],
    ]) {
      expect(curveFrame(samples).pixels.some((v) => v > 0)).toBe(true);
    }
  });
});

describe("print layout", () => {
  it("is used while a printer is online on the HUD, otherwise the plain page", () => {
    expect(layoutFor(state())).toBe("print");
    expect(layoutFor(state({ screen: "control" }))).toBe("plain");
    expect(layoutFor(state({ status: null }))).toBe("plain");
    expect(layoutFor(state({ status: parseStatus({ online: false, reason: "searching" }) }))).toBe("plain");
    expect(layoutFor(state({ connection: { kind: "setup" } }))).toBe("plain");
  });

  it("keeps the side text and temperature lines inside their boxes, in both languages, with worst-case content", () => {
    const long = "sehr_langer_dateiname_fuer_eine_halterung_mit_vielen_varianten_v12_final_final.gcode";
    for (const locale of locales) {
      const view = buildPrintView(state({
        locale, message: long, ageSeconds: 9999,
        status: online({ file: long, progress: 100, layer: 99999, layers: 99999, minutesLeft: 99999, message: long, nozzle: { now: 300, target: 300 }, bed: { now: 120, target: 120 } }),
      }));
      expect(view.body.length).toBeLessThanOrEqual(SIDE_ROWS);
      for (const row of view.body) expect(row.length).toBeLessThanOrEqual(SIDE_WIDTH);
      expect(view.temps).toHaveLength(2);
      for (const row of view.temps) expect(row.length).toBeLessThanOrEqual(28);
      expect(view.header.length).toBeLessThanOrEqual(56);
      expect(view.footer.length).toBeLessThanOrEqual(56);
    }
  });

  it("shows nozzle and bed temperatures, and a dash when a heater is unknown", () => {
    const view = buildPrintView(state({ status: online({ bed: null }) }));
    expect(view.temps[0]).toBe("Düse 219/220 °C");
    expect(view.temps[1]).toBe("Bett – °C");
  });

  it("the plain view stays as before", () => {
    expect(buildView(state()).body.some((row) => row.includes("42 %"))).toBe(true);
  });

  it("both pages stay inside the SDK limits", () => {
    const print = buildPage(buildPrintView(state()), "print");
    expect(print.imageObject ?? []).toHaveLength(2);
    expect((print.textObject ?? []).length).toBeLessThanOrEqual(8);
    expect((print.textObject ?? []).filter((c) => c.isEventCapture === 1)).toHaveLength(1);
    expect(validateEvenHubPageContainer(print).valid).toBe(true);
    const plain = buildPage(buildView(state({ screen: "control" })), "plain");
    expect(plain.imageObject ?? []).toHaveLength(0);
    expect(validateEvenHubPageContainer(plain).valid).toBe(true);
    expect(RING.width).toBeLessThanOrEqual(288);
    expect(CURVE.width).toBeLessThanOrEqual(288);
    // The ring and the text column do not overlap; the curve sits below both.
    const body = (print.textObject ?? []).find((c) => c.containerName === "body")!;
    expect(body.xPosition).toBeGreaterThanOrEqual(RING.x + RING.width);
    expect(CURVE.y).toBeGreaterThanOrEqual(RING.y + RING.height);
    expect(CURVE.y + CURVE.height).toBeLessThanOrEqual(252);
  });

  function fakeBridge() {
    const calls: string[] = [];
    const bridge = {
      createStartUpPageContainer: async () => { calls.push("create"); return 0; },
      rebuildPageContainer: async () => { calls.push("rebuild"); return true; },
      textContainerUpgrade: async (c: { containerName?: string }) => { calls.push(`text:${c.containerName}`); return true; },
      updateImageRawData: async (c: { containerName?: string }) => { calls.push(`image:${c.containerName}`); return "success"; },
    } as unknown as EvenAppBridge;
    return { bridge, calls };
  }

  it("creates the page once (after one first rebuild) and rebuilds for another layout", async () => {
    const { bridge, calls } = fakeBridge();
    const s = state();
    const frames = { ring: ringFrame(42), curve: curveFrame(demoTempSamples(0)) };
    await createPage(bridge, buildPrintView(s), "print", frames);
    await rebuildPage(bridge, buildView(state({ screen: "control" })), "plain", frames);
    await rebuildPage(bridge, buildPrintView(s), "print", frames);
    expect(calls.filter((c) => c === "create" || c === "rebuild")).toEqual(["rebuild", "create", "rebuild", "rebuild"]);
  });

  it("sends the ring only when the percentage changed and the curve only with new data", async () => {
    const { bridge, calls } = fakeBridge();
    const s = state();
    const view = buildPrintView(s);
    const samples = demoTempSamples(0);
    await createPage(bridge, view, "print", { ring: ringFrame(42), curve: curveFrame(samples) });
    expect(calls.filter((c) => c.startsWith("image:")).sort()).toEqual(["image:curve", "image:ring"]);
    calls.length = 0;
    await updatePage(bridge, view, "print", { ring: ringFrame(42), curve: curveFrame(samples) }, view);
    expect(calls).toEqual([]);
    await updatePage(bridge, view, "print", { ring: ringFrame(43), curve: curveFrame(samples) }, view);
    expect(calls).toEqual(["image:ring"]);
    calls.length = 0;
    const next = { ...view, temps: ["Düse 221/220 °C", "Bett 60/60 °C"] };
    await updatePage(bridge, next, "print", { ring: ringFrame(43), curve: curveFrame([...samples, { t: 5_000, now: 221, target: 220 }]) }, view);
    expect(calls.sort()).toEqual(["image:curve", "text:temps"]);
  });
});

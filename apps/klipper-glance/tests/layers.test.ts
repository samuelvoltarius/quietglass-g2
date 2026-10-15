import { describe, expect, it } from "vitest";
import {
  VIEW_HEIGHT, VIEW_WIDTH, currentLayerIndex, demoLayerModel, layerFrame, messageFrame, parseLayerModel, tiles,
} from "../src/glasses/layers";
import { bitmapKey } from "../src/glasses/gfx";
import { buildPage } from "../src/glasses/render";
import { buildView, layoutFor, type ViewState } from "../src/glasses/views";
import { ROW_WIDTH } from "../src/glasses/screen";
import { parseStatus } from "../src/printer/status";

/** The bridge's JSON for a 20 mm square, 3 layers. */
function bridgeJson(): Record<string, unknown> {
  const ints = new Int16Array([1000, 1000, 1200, 1000, 1200, 1000, 1200, 1200, 1000, 1000, 1200, 1000, 1000, 1000, 1200, 1000]);
  return {
    file: "cube.gcode",
    bounds: [100, 100, 0.2, 120, 120, 0.6],
    z: [0.2, 0.4, 0.6],
    start: [0, 2, 3],
    segs: btoa(String.fromCharCode(...new Uint8Array(ints.buffer))),
    layersTotal: 3,
  };
}

describe("the layer model from the bridge", () => {
  it("decodes the segments", () => {
    const model = parseLayerModel(bridgeJson())!;
    expect(model.z).toEqual([0.2, 0.4, 0.6]);
    expect(model.segs.length).toBe(16);
    expect(model.segs[2]).toBe(1200);
  });

  it("refuses broken replies", () => {
    expect(parseLayerModel(null)).toBeNull();
    expect(parseLayerModel({ ...bridgeJson(), z: [0.2] })).toBeNull();
    expect(parseLayerModel({ ...bridgeJson(), start: [0, 9, 3] })).toBeNull();
    expect(parseLayerModel({ ...bridgeJson(), segs: "abc" })).toBeNull();
    expect(parseLayerModel({ ...bridgeJson(), bounds: [1, 2] })).toBeNull();
  });

  it("finds the layer being printed by height, then by layer count, then by progress", () => {
    const model = parseLayerModel(bridgeJson())!;
    expect(currentLayerIndex(model, { z: 0.41, layer: null, layers: null, progress: 0 })).toBe(1);
    expect(currentLayerIndex(model, { z: null, layer: 60, layers: 60, progress: 0 })).toBe(2);
    expect(currentLayerIndex(model, { z: null, layer: null, layers: null, progress: 34 })).toBe(0);
  });
});

describe("the layer picture", () => {
  const model = demoLayerModel();

  it("fills the view and lights the printed part", () => {
    const frame = layerFrame(model, 30, 35);
    expect(frame.width).toBe(VIEW_WIDTH);
    expect(frame.height).toBe(VIEW_HEIGHT);
    let full = 0, faint = 0;
    for (const v of frame.pixels) { if (v === 255) full += 1; else if (v > 0 && v <= 60) faint += 1; }
    expect(full).toBeGreaterThan(50);       // the current layer
    expect(faint).toBeGreaterThan(50);      // layers still to come
  });

  it("changes with the layer and the angle, not otherwise", () => {
    const a = bitmapKey(layerFrame(model, 30, 35));
    expect(bitmapKey(layerFrame(model, 30, 35))).toBe(a);
    expect(bitmapKey(layerFrame(model, 31, 35))).not.toBe(a);
    expect(bitmapKey(layerFrame(model, 30, 65))).not.toBe(a);
  });

  it("splits into four SDK-sized tiles that put the picture back together", () => {
    const frame = layerFrame(model, 30, 35);
    const parts = tiles(frame);
    expect(parts).toHaveLength(4);
    for (const part of parts) { expect(part.width).toBeLessThanOrEqual(288); expect(part.height).toBeLessThanOrEqual(144); }
    expect(parts[3]!.pixels[0]).toBe(frame.pixels[(VIEW_HEIGHT / 2) * VIEW_WIDTH + VIEW_WIDTH / 2]);
  });

  it("shows an empty box instead of words (the pixel font has only digits: text came out in fragments, 15.10.)", () => {
    const frame = messageFrame("Kein Modell zu diesem Druck");
    expect(frame.pixels.some((v) => v > 0)).toBe(true);
    // Same picture whatever the text: no letters are drawn.
    expect(Array.from(messageFrame("x").pixels)).toEqual(Array.from(frame.pixels));
  });
});

describe("the model screen", () => {
  const base: ViewState = {
    locale: "de", demo: false, connection: { kind: "ok" },
    status: parseStatus({ online: true, state: "printing", file: "x.gcode", progress: 42, layer: 75, layers: 180, controllable: false }),
    ageSeconds: 1, screen: "model", cursor: 0, armed: null, sending: false, message: "", model: "ready",
  };

  it("has its own page: header, footer and four image tiles", () => {
    expect(layoutFor(base)).toBe("model");
    const view = buildView(base);
    expect(view.header).toBe("KLIPPER · Modell · Schicht 75/180 · 42 %");
    expect(view.footer).toBe("Tippen = neu · Wischen = drehen · 2× = zurück");
    const page = buildPage(view, "model");
    expect(page.containerTotalNum).toBe(6);
    expect(page.imageObject).toHaveLength(4);
    expect(page.textObject?.filter((c) => c.isEventCapture === 1)).toHaveLength(1);
  });

  it("fits in both languages and every model state", () => {
    for (const locale of ["de", "en"] as const) {
      for (const model of ["none", "preparing", "ready", "failed"] as const) {
        const view = buildView({ ...base, locale, model });
        for (const row of [view.header, view.footer]) expect(row.length).toBeLessThanOrEqual(ROW_WIDTH);
      }
    }
  });
});

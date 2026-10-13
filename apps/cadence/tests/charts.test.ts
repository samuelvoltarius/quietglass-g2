import { describe, expect, it } from "vitest";
import { validateEvenHubPageContainer, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import {
  BPM_HEIGHT, BPM_WIDTH, PENDULUM_HEIGHT, PENDULUM_MAX_BPM, PENDULUM_MIDSWING_MAX_BPM, PENDULUM_WIDTH,
  bpmFrame, pendulumFrame, pendulumSwing, type Swing,
} from "../src/glasses/charts";
import { bitmapKey, iconBitmap } from "../src/glasses/gfx";
import { BPM, ICON, PENDULUM, buildPage, createPage, updatePage, type Frames } from "../src/glasses/render";
import { buildView } from "../src/glasses/view";
import { DEFAULT_SETTINGS, MAX_BPM, MIN_BPM, createState, msPerBeat, start, type MetronomeSettings } from "../src/metronome/engine";

const at = (bpm: number): MetronomeSettings => ({ ...DEFAULT_SETTINGS, bpm });

describe("tempo number", () => {
  it("is 224 x 72 with ink for every tempo from 30 to 240, and every tempo looks different", () => {
    const keys = new Set<string>();
    for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 1) {
      const b = bpmFrame(bpm);
      expect(b.width).toBe(BPM_WIDTH);
      expect(b.height).toBe(BPM_HEIGHT);
      expect(BPM_WIDTH).toBeLessThanOrEqual(288);
      expect(b.pixels.some((v) => v > 0)).toBe(true);
      keys.add(bitmapKey(b));
    }
    expect(keys.size).toBe(MAX_BPM - MIN_BPM + 1);
  });

  it("copes with broken input", () => {
    for (const value of [Number.NaN, -3, 0, 1e6]) expect(bpmFrame(value).pixels).toHaveLength(BPM_WIDTH * BPM_HEIGHT);
  });

  it("is a pure function of the tempo", () => {
    expect(bitmapKey(bpmFrame(100))).toBe(bitmapKey(bpmFrame(100)));
  });
});

describe("pendulum position", () => {
  it("hangs upright when stopped, and is not drawn above 120 bpm", () => {
    expect(pendulumSwing(createState(), at(100), 0)).toBe(0);
    expect(pendulumSwing(start(createState(), 0), at(PENDULUM_MAX_BPM + 1), 10)).toBeNull();
    expect(pendulumSwing(start(createState(), 0), at(240), 10)).toBeNull();
    expect(pendulumSwing(start(createState(), 0), at(PENDULUM_MAX_BPM), 10)).not.toBeNull();
  });

  it("stands at the far side on each beat and alternates left and right", () => {
    const settings = at(100);
    const running = start(createState(), 1000);
    const period = msPerBeat(100);
    const sides = [0, 1, 2, 3, 4, 5].map((beat) => pendulumSwing(running, settings, 1000 + beat * period + 5));
    expect(sides).toEqual([-2, 2, -2, 2, -2, 2]);
  });

  it("passes through the middle half-way only at slow tempi", () => {
    const slow = at(PENDULUM_MIDSWING_MAX_BPM);
    const running = start(createState(), 0);
    const period = msPerBeat(slow.bpm);
    expect(pendulumSwing(running, slow, 10)).toBe(-2);
    expect(pendulumSwing(running, slow, period * 0.6)).toBe(0);
    expect(pendulumSwing(running, slow, period + 10)).toBe(2);
    const medium = at(100);
    expect(pendulumSwing(running, medium, msPerBeat(100) * 0.6)).toBe(-2);
  });

  it("every position is a distinct 200 x 96 picture, and null is empty", () => {
    const swings: Swing[] = [-2, -1, 0, 1, 2];
    const keys = swings.map((s) => bitmapKey(pendulumFrame(s)));
    expect(new Set(keys).size).toBe(5);
    for (const s of swings) {
      const b = pendulumFrame(s);
      expect(b.width).toBe(PENDULUM_WIDTH);
      expect(b.height).toBe(PENDULUM_HEIGHT);
      expect(b.pixels.some((v) => v > 0)).toBe(true);
    }
    expect(pendulumFrame(null).pixels.every((v) => v === 0)).toBe(true);
  });
});

describe("page", () => {
  const view = buildView(createState(), DEFAULT_SETTINGS, { locale: "en" }, 0);
  const frames = (bpm: number, swing: Swing | null): Frames => ({
    icon: iconBitmap(["#.#", ".#."], 64, 30), bpm: bpmFrame(bpm), pendulum: pendulumFrame(swing),
  });

  it("stays inside the SDK limits and the images do not overlap the text", () => {
    const page = buildPage(view);
    expect(page.imageObject ?? []).toHaveLength(3);
    expect((page.textObject ?? []).filter((c) => c.isEventCapture === 1)).toHaveLength(1);
    expect(validateEvenHubPageContainer(page).valid).toBe(true);
    const body = (page.textObject ?? []).find((c) => c.containerName === "body")!;
    expect(BPM.y + BPM.height).toBeLessThanOrEqual(body.yPosition ?? 0);
    expect(PENDULUM.y + PENDULUM.height).toBeLessThanOrEqual(body.yPosition ?? 0);
    expect(BPM.x + BPM.width).toBeLessThanOrEqual(PENDULUM.x);
    expect(PENDULUM.x + PENDULUM.width).toBeLessThanOrEqual(576);
    expect(ICON.x).toBe(512);
    expect((page.textObject ?? []).find((c) => c.containerName === "header")?.width).toBe(512);
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

  it("creates the page once (after one first rebuild) and rebuilds afterwards", async () => {
    const { bridge, calls } = fakeBridge();
    await createPage(bridge, view, frames(100, 0));
    await createPage(bridge, view, frames(100, 0));
    expect(calls.filter((c) => c === "create" || c === "rebuild")).toEqual(["rebuild", "create", "rebuild"]);
  });

  it("sends the tempo number only when the tempo changed and the pendulum only when it moved", async () => {
    const { bridge, calls } = fakeBridge();
    await createPage(bridge, view, frames(100, -2));
    expect(calls.filter((c) => c.startsWith("image:")).sort()).toEqual(["image:bpm", "image:pendulum", "image:pixel-icon"]);
    calls.length = 0;
    await updatePage(bridge, view, frames(100, -2), view);
    expect(calls).toEqual([]);
    await updatePage(bridge, view, frames(100, 2), view);
    expect(calls).toEqual(["image:pendulum"]);
    calls.length = 0;
    await updatePage(bridge, view, frames(104, 2), view);
    expect(calls).toEqual(["image:bpm"]);
    calls.length = 0;
    await updatePage(bridge, view, frames(104, null), view);
    expect(calls).toEqual(["image:pendulum"]);
  });
});

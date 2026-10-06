import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pixel, type Bitmap } from "../src/glasses/bitmap";
import { GAUGE, drawGauge, gaugeAngle, gaugeKey, gaugePivot, gaugePoint, gaugeRadius, gaugeRange, headCentre, type GaugeState } from "../src/glasses/gauge";
import { createImageLane, type ImageTarget } from "../src/glasses/lane";

const PIVOT = gaugePivot(gaugeRange(25));
const state = (over: Partial<GaugeState> = {}): GaugeState => ({ calibrated: true, angle: 0, warnAngle: 25, alert: false, ...over });
const lit = (bitmap: Bitmap): number => bitmap.pixels.filter((value) => value > 0).length;

describe("quantisation", () => {
  it("moves the needle in 2° steps, with hysteresis", () => {
    expect(gaugeAngle(null, 13.2)).toBe(14);
    expect(gaugeAngle(14, 15.2)).toBe(14);
    expect(gaugeAngle(14, 15.6)).toBe(16);
    expect(gaugeAngle(14, 9)).toBe(10);
    expect(gaugeAngle(14, null)).toBeNull();
  });

  it("keys only what the picture shows", () => {
    expect(gaugeKey(state({ angle: 12 }))).toBe(gaugeKey(state({ angle: 12 })));
    expect(gaugeKey(state({ angle: 12 }))).not.toBe(gaugeKey(state({ angle: 14 })));
    expect(gaugeKey(state({ angle: 30, alert: true }))).not.toBe(gaugeKey(state({ angle: 30 })));
    expect(gaugeKey(state({ calibrated: false, angle: 5 }))).toBe(gaugeKey(state({ calibrated: false, angle: 40 })));
  });
});

describe("head gauge", () => {
  it("fits its image container", () => {
    const bitmap = drawGauge(state());
    expect([bitmap.width, bitmap.height]).toEqual([GAUGE.width, GAUGE.height]);
    expect(GAUGE.width).toBeLessThanOrEqual(288);
    expect(GAUGE.height).toBeLessThanOrEqual(144);
    expect(Math.max(...bitmap.pixels)).toBeLessThanOrEqual(15);
  });

  it("shows room past the warning angle, up to 90°", () => {
    expect(gaugeRange(25)).toBe(40);
    expect(gaugeRange(5)).toBe(20);
    expect(gaugeRange(80)).toBe(90);
  });

  it("keeps the head inside the column for every setting", () => {
    for (const warn of [5, 15, 25, 45, 60, 80]) {
      for (const angle of [0, warn, gaugeRange(warn), 180]) {
        const head = headCentre(angle, warn);
        expect(head.x + 15, `warn ${warn} angle ${angle}`).toBeLessThanOrEqual(GAUGE.width - 3);
        expect(head.y - 15, `warn ${warn} angle ${angle}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("draws the neck at the real angle", () => {
    for (const angle of [0, 10, 24, 36]) {
      const head = headCentre(angle, 25);
      const drawn = (Math.atan2(head.x - PIVOT.x, PIVOT.y - head.y) * 180) / Math.PI;
      expect(Math.abs(drawn - angle), `angle ${angle}`).toBeLessThan(1);
      expect(pixel(drawGauge(state({ angle })), head.x, head.y)).toBeGreaterThan(0);
    }
  });

  it("puts the head upright on the saved line and further forward as the head tilts", () => {
    expect(headCentre(0, 25).x).toBe(PIVOT.x);
    expect(headCentre(20, 25).x).toBeGreaterThan(headCentre(10, 25).x);
    // Past the sweep the head rests at its end.
    expect(headCentre(90, 25)).toEqual(headCentre(gaugeRange(25), 25));
  });

  it("marks the warning angle with a bright tick", () => {
    const radius = gaugeRadius(gaugeRange(25));
    const tick = gaugePoint(25, radius + 6, gaugeRange(25));
    expect(pixel(drawGauge(state({ angle: 0 })), Math.round(tick.x), Math.round(tick.y))).toBe(15);
  });

  it("stays dim while upright and lights up when leaning", () => {
    const head = headCentre(30, 25);
    expect(pixel(drawGauge(state({ angle: 30 })), head.x, head.y)).toBe(8);
    expect(pixel(drawGauge(state({ angle: 30, alert: true })), head.x, head.y)).toBe(15);
  });

  it("draws no head before the first sample, and the figure before calibration", () => {
    const empty = drawGauge(state({ angle: null }));
    const head = headCentre(0, 25);
    expect(pixel(empty, head.x + 6, head.y)).toBe(0);
    expect(lit(drawGauge(state({ calibrated: false }))))
      .not.toBe(lit(empty));
  });
});

describe("image lane", () => {
  const target: ImageTarget = { id: 4, name: "pixel-icon" };
  let sent: number[];
  const send = async (_image: ImageTarget, data: Uint8Array): Promise<boolean> => { sent.push(data[0] ?? -1); return true; };
  beforeEach(() => { vi.useFakeTimers(); sent = []; });
  afterEach(() => { vi.useRealTimers(); });

  it("sends a change once, throttled, and nothing for an unchanged state", async () => {
    const lane = createImageLane(send, 3000);
    lane.request(target, "g:0", () => new Uint8Array([0]));
    lane.request(target, "g:0", () => new Uint8Array([0]));
    await vi.advanceTimersByTimeAsync(100);
    lane.request(target, "g:2", () => new Uint8Array([2]));
    lane.request(target, "g:4", () => new Uint8Array([4]));
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual([0]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual([0, 4]);
    lane.request(target, "g:4", () => new Uint8Array([4]));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual([0, 4]);
  });
});

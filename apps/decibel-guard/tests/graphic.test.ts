import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBitmap, drawText, pixel, quantize, textWidth, type Bitmap } from "../src/glasses/bitmap";
import { DOSE_BAR, METER, doseKey, dosePercent, doseX, drawDoseBar, drawMeter, meterKey, meterLevel, meterY } from "../src/glasses/gauge";
import { createImageLane, type ImageTarget } from "../src/glasses/lane";

/** Lit pixels in row `y`, as the length of the run starting at `from`. */
function runLength(bitmap: Bitmap, y: number, from: number): number {
  let x = from;
  while (x < bitmap.width && pixel(bitmap, x, y) > 0) x += 1;
  return x - from;
}
const TRACK_MID = 30;

describe("quantisation", () => {
  it("floors the dose to 2 % steps and never shows more than measured", () => {
    expect(dosePercent(0)).toBe(0);
    expect(dosePercent(0.019)).toBe(0);
    expect(dosePercent(0.415)).toBe(40);
    expect(dosePercent(0.42)).toBe(42);
    expect(dosePercent(5)).toBe(200);
    expect(dosePercent(Number.NaN)).toBe(0);
  });

  it("moves the level in 3 dB steps, with hysteresis at the boundary", () => {
    expect(meterLevel(null, 76.4)).toBe(75);
    // 76.6 would round to 78, but it is less than ¾ of a step from 75.
    expect(meterLevel(75, 76.6)).toBe(75);
    expect(meterLevel(75, 77.4)).toBe(78);
    expect(meterLevel(75, 64)).toBe(63);
    expect(meterLevel(75, null)).toBeNull();
    expect(quantize(10, 11, 2)).toBe(10);
  });

  it("gives equal keys for states that draw the same picture", () => {
    expect(doseKey(dosePercent(0.401))).toBe(doseKey(dosePercent(0.419)));
    expect(doseKey(dosePercent(0.401))).not.toBe(doseKey(dosePercent(0.421)));
    expect(meterKey({ listening: false, level: 80, criterionDb: 85 })).toBe(meterKey({ listening: false, level: null, criterionDb: 85 }));
  });
});

describe("dose bar", () => {
  it("fits its image container", () => {
    const bitmap = drawDoseBar(40);
    expect([bitmap.width, bitmap.height]).toEqual([DOSE_BAR.width, DOSE_BAR.height]);
    expect(DOSE_BAR.width).toBeLessThanOrEqual(288);
    expect(DOSE_BAR.height).toBeLessThanOrEqual(144);
    expect(Math.max(...bitmap.pixels)).toBeLessThanOrEqual(15);
  });

  it("fills in proportion to the dose", () => {
    const quarter = runLength(drawDoseBar(24), TRACK_MID, 2);
    const half = runLength(drawDoseBar(48), TRACK_MID, 2);
    expect(quarter).toBe(doseX(24) - 2);
    expect(half / quarter).toBeCloseTo(2, 1);
    expect(runLength(drawDoseBar(0), TRACK_MID, 2)).toBe(0);
  });

  it("marks the warning at 50 % and keeps the mark visible inside the fill", () => {
    const marker = doseX(50);
    expect(marker).toBe(Math.round((2 + 246) / 2));
    const empty = drawDoseBar(10);
    expect(pixel(empty, marker, TRACK_MID)).toBe(15);
    expect(pixel(empty, marker, 6)).toBe(15);
    const full = drawDoseBar(80);
    expect(pixel(full, marker, TRACK_MID)).toBe(0);
    expect(pixel(full, marker - 3, TRACK_MID)).toBe(15);
    expect(pixel(full, marker, 6)).toBe(15);
  });

  it("fills the overflow box only past 100 %", () => {
    expect(pixel(drawDoseBar(98), 260, TRACK_MID)).toBe(0);
    expect(pixel(drawDoseBar(100), 260, TRACK_MID)).toBe(15);
    expect(runLength(drawDoseBar(150), TRACK_MID, 2)).toBe(runLength(drawDoseBar(100), TRACK_MID, 2));
  });
});

describe("level meter", () => {
  const column = 40;
  it("fits the icon column", () => {
    const bitmap = drawMeter({ listening: true, level: 70, criterionDb: 85 });
    expect([bitmap.width, bitmap.height]).toEqual([METER.width, METER.height]);
  });

  it("fills up to the level, brighter from the criterion on", () => {
    const quiet = drawMeter({ listening: true, level: 70, criterionDb: 85 });
    expect(pixel(quiet, column, meterY(70) + 2)).toBe(9);
    expect(pixel(quiet, column, meterY(70) - 3)).toBe(0);
    const loud = drawMeter({ listening: true, level: 94, criterionDb: 85 });
    expect(pixel(loud, column, meterY(94) + 2)).toBe(15);
    expect(meterY(94)).toBeLessThan(meterY(70));
  });

  it("puts the criterion tick where the scale says", () => {
    const bitmap = drawMeter({ listening: true, level: null, criterionDb: 85 });
    expect(pixel(bitmap, 24, meterY(85))).toBe(15);
    expect(pixel(bitmap, 24, meterY(85) + 6)).toBe(0);
    expect(meterY(110)).toBeLessThan(meterY(85));
    expect(meterY(200)).toBe(meterY(110));
  });

  it("shows the speaker icon while not measuring", () => {
    const idle = drawMeter({ listening: false, level: null, criterionDb: 85 });
    expect(idle.pixels.some((value) => value === 15)).toBe(true);
    expect(pixel(idle, 24, meterY(85))).toBe(0);
  });
});

describe("pixel font", () => {
  it("draws labels at the expected width", () => {
    const bitmap = createBitmap(40, 12);
    expect(drawText(bitmap, "50%", 0, 0, 2, 15)).toBe(textWidth("50%", 2));
    expect(textWidth("50%", 2)).toBe(22);
    expect(bitmap.pixels.some((value) => value === 15)).toBe(true);
  });
});

describe("image lane", () => {
  const target: ImageTarget = { id: 5, name: "dose-bar" };
  const other: ImageTarget = { id: 4, name: "pixel-icon" };
  let sent: string[];
  let inFlight: number;
  let maxInFlight: number;
  const send = async (image: ImageTarget, data: Uint8Array): Promise<boolean> => {
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 200));
    inFlight -= 1;
    sent.push(`${image.name}:${data[0]}`);
    return true;
  };
  const render = (value: number) => () => new Uint8Array([value]);

  beforeEach(() => { vi.useFakeTimers(); sent = []; inFlight = 0; maxInFlight = 0; });
  afterEach(() => { vi.useRealTimers(); });

  it("sends nothing when the drawn state is unchanged", async () => {
    const lane = createImageLane(send, 3000);
    lane.request(target, "dose:40", render(40));
    await vi.advanceTimersByTimeAsync(10_000);
    for (let i = 0; i < 20; i += 1) { lane.request(target, "dose:40", render(40)); await vi.advanceTimersByTimeAsync(500); }
    expect(sent).toEqual(["dose-bar:40"]);
  });

  it("throttles changes and sends only the newest", async () => {
    const lane = createImageLane(send, 3000);
    lane.request(target, "dose:40", render(40));
    await vi.advanceTimersByTimeAsync(300);
    lane.request(target, "dose:42", render(42));
    lane.request(target, "dose:44", render(44));
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual(["dose-bar:40"]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent).toEqual(["dose-bar:40", "dose-bar:44"]);
  });

  it("drops a pending change that was undone before it went out", async () => {
    const lane = createImageLane(send, 3000);
    lane.request(target, "dose:40", render(40));
    await vi.advanceTimersByTimeAsync(300);
    lane.request(target, "dose:42", render(42));
    lane.request(target, "dose:40", render(40));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual(["dose-bar:40"]);
  });

  it("never has two transfers in flight", async () => {
    const lane = createImageLane(send, 3000);
    lane.request(target, "a", render(1));
    lane.request(other, "b", render(2));
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual(["dose-bar:1", "pixel-icon:2"]);
    expect(maxInFlight).toBe(1);
  });

  it("does not render an image it will not send", async () => {
    const lane = createImageLane(send, 3000);
    let renders = 0;
    const counted = () => { renders += 1; return new Uint8Array([1]); };
    lane.request(target, "a", counted);
    await vi.advanceTimersByTimeAsync(1000);
    lane.request(target, "a", counted);
    lane.request(target, "a", counted);
    await vi.advanceTimersByTimeAsync(5000);
    expect(renders).toBe(1);
  });

  it("resends at once after the page was created anew", async () => {
    const lane = createImageLane(send, 3000);
    lane.request(target, "a", render(1));
    await vi.advanceTimersByTimeAsync(500);
    lane.invalidate();
    lane.request(target, "a", render(1));
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toEqual(["dose-bar:1", "dose-bar:1"]);
  });

  it("retries a failed transfer once, then waits for the next request", async () => {
    let attempts = 0;
    const lane = createImageLane(async () => { attempts += 1; return false; }, 3000);
    lane.request(target, "a", render(1));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(attempts).toBe(2);
    lane.request(target, "a", render(1));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(attempts).toBe(4);
  });

  it("stops after close", async () => {
    const lane = createImageLane(send, 3000);
    lane.request(target, "a", render(1));
    await vi.advanceTimersByTimeAsync(300);
    lane.request(target, "b", render(2));
    lane.close();
    lane.request(target, "c", render(3));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual(["dose-bar:1"]);
  });
});

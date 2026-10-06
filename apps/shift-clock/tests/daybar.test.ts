import { describe, expect, it, vi } from "vitest";
import {
  BAR_HEIGHT, DAY_BAR_HEIGHT, DAY_BAR_WIDTH, DEFAULT_SCALE_HOURS, FULL, STEP_SECONDS,
  dayBarState, drawDayBar, getPixel, measureFill, sameDayBar, stepsToPixels,
} from "../src/glasses/daybar";
import { createImageSync } from "../src/glasses/image-sync";
import { dayBarFor } from "../src/glasses/view";
import { startOfDay, startProject, STOPPED } from "../src/tracking/clock";

const H = 3600;

describe("day bar: quantization", () => {
  it("counts whole five-minute steps only", () => {
    expect(STEP_SECONDS).toBe(300);
    expect(dayBarState(299, 0, false).recordedSteps).toBe(0);
    expect(dayBarState(300, 0, false).recordedSteps).toBe(1);
    expect(dayBarState(H, 0, false).recordedSteps).toBe(12);
  });

  it("splits the total so recorded and running always add up", () => {
    // 290 s recorded + 20 s running = one step, which belongs to the running entry.
    const state = dayBarState(290, 20, true);
    expect(state.recordedSteps + state.runningSteps).toBe(1);
    expect(state.recordedSteps).toBe(0);
    expect(state.runningSteps).toBe(1);
  });

  it("does not change within a five-minute step, so no image is resent", () => {
    const at = (s: number) => dayBarState(2 * H, s, true);
    expect(sameDayBar(at(60), at(61))).toBe(true);
    expect(sameDayBar(at(60), at(299))).toBe(true);
    expect(sameDayBar(at(299), at(300))).toBe(false);
    expect(sameDayBar(null, at(0))).toBe(false);
  });

  it("changes when the clock starts or stops, or the target changes", () => {
    expect(sameDayBar(dayBarState(H, 0, false), dayBarState(H, 0, true))).toBe(false);
    expect(sameDayBar(dayBarState(H, 0, false, 8), dayBarState(H, 0, false, 7.5))).toBe(false);
  });

  it("makes room above a long target", () => {
    expect(dayBarState(0, 0, false).scaleHours).toBe(DEFAULT_SCALE_HOURS);
    expect(dayBarState(0, 0, false, 8).scaleHours).toBe(10);
    expect(dayBarState(0, 0, false, 10).scaleHours).toBe(11);
    expect(dayBarState(0, 0, false, 12.5).scaleHours).toBe(14);
    expect(dayBarState(0, 0, false, 0).targetSteps).toBeNull();
  });

  it("follows today's part of a shift that started yesterday", () => {
    const day = startOfDay(new Date(2026, 9, 7, 12).getTime());
    const clock = startProject(STOPPED, "A", day - H * 1000, () => "e1").state;
    const bar = dayBarFor(clock, [], null, day + 2 * H * 1000);
    expect(bar.runningSteps).toBe(24);
    expect(bar.running).toBe(true);
  });
});

describe("day bar: drawing", () => {
  it("is a 96 x 144 grayscale buffer, within the image container limits", () => {
    const bmp = drawDayBar(dayBarState(0, 0, false));
    expect([bmp.width, bmp.height]).toEqual([DAY_BAR_WIDTH, DAY_BAR_HEIGHT]);
    expect(bmp.width).toBeLessThanOrEqual(288);
    expect(bmp.height).toBeLessThanOrEqual(144);
    expect(bmp.pixels.length).toBe(DAY_BAR_WIDTH * DAY_BAR_HEIGHT);
  });

  it("fills in proportion to the time worked: one pixel per step at the 10 h scale", () => {
    expect(BAR_HEIGHT).toBe(DEFAULT_SCALE_HOURS * 12);
    for (const hours of [0, 0.5, 1, 4, 7.25, 10]) {
      const fill = measureFill(drawDayBar(dayBarState(hours * H, 0, false)));
      expect(fill.solid, `${hours} h`).toBe(hours * 12);
      expect(fill.striped).toBe(0);
    }
  });

  it("doubles the bar when the time doubles", () => {
    const two = measureFill(drawDayBar(dayBarState(2 * H, 0, false))).solid;
    const four = measureFill(drawDayBar(dayBarState(4 * H, 0, false))).solid;
    expect(four).toBe(2 * two);
  });

  it("stripes the running entry on top of the recorded time", () => {
    const fill = measureFill(drawDayBar(dayBarState(3 * H, H, true)));
    expect(fill.solid).toBe(36);
    expect(fill.striped).toBe(12);
  });

  it("stays proportional on a stretched scale", () => {
    const state = dayBarState(7 * H, 0, false, 12);
    expect(state.scaleHours).toBe(13);
    expect(measureFill(drawDayBar(state)).solid).toBe(stepsToPixels(state.recordedSteps, 13));
    expect(stepsToPixels(13 * 12, 13)).toBe(BAR_HEIGHT);
  });

  it("never draws past the frame, and points beyond it instead", () => {
    const over = drawDayBar(dayBarState(14 * H, 0, false));
    expect(measureFill(over).solid).toBe(BAR_HEIGHT);
    const under = drawDayBar(dayBarState(9 * H, 0, false));
    const arrowRow = (bmp: typeof over) => Array.from({ length: 19 }, (_, i) => getPixel(bmp, 40 + i, 8));
    expect(arrowRow(over)).toContain(FULL);
    expect(arrowRow(under)).not.toContain(FULL);
  });

  it("draws the 'now' pointer only while the clock runs", () => {
    const lit = (bmp: ReturnType<typeof drawDayBar>) => {
      let n = 0;
      for (let y = 0; y < DAY_BAR_HEIGHT; y++) for (let x = 67; x < 80; x++) if (getPixel(bmp, x, y) === FULL) n++;
      return n;
    };
    expect(lit(drawDayBar(dayBarState(H, 600, true)))).toBeGreaterThan(10);
    expect(lit(drawDayBar(dayBarState(H, 0, false)))).toBe(0);
  });

  it("marks the daily target, and the mark moves with it", () => {
    const rowsWithStub = (target: number): number[] => {
      const bmp = drawDayBar(dayBarState(0, 0, false, target));
      const rows: number[] = [];
      for (let y = 0; y < DAY_BAR_HEIGHT; y++) if (getPixel(bmp, 64, y) === FULL) rows.push(y);
      return rows;
    };
    const eight = rowsWithStub(8);
    const four = rowsWithStub(4);
    expect(eight.length).toBeGreaterThan(0);
    // Four hours lower is 48 px further down at the 10 h scale.
    expect((four[0] ?? 0) - (eight[0] ?? 0)).toBe(48);
    expect(rowsWithStub(0)).toEqual([]);
  });
});

describe("image lane", () => {
  const same = (a: number | null, b: number): boolean => a === b;
  const flush = () => new Promise((done) => setTimeout(done, 0));

  it("sends nothing when the state on the glasses already matches", async () => {
    const send = vi.fn(async () => true);
    const lane = createImageSync(same, send);
    lane.request(1);
    await lane.idle();
    lane.request(1);
    lane.request(1);
    await lane.idle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never makes the caller wait for a transfer, and collapses requests to the newest", async () => {
    let finish!: (ok: boolean) => void;
    const send = vi.fn((_state: number) => new Promise<boolean>((done) => { finish = done; }));
    const lane = createImageSync(same, send);
    lane.request(1); // in flight, never answered yet
    lane.request(2);
    lane.request(3);
    expect(send).toHaveBeenCalledTimes(1);
    finish(true);
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toBe(3);
  });

  it("does not retry a failed state in a loop, but tries the next change", async () => {
    const send = vi.fn(async (state: number) => state !== 1);
    const lane = createImageSync(same, send);
    lane.request(1);
    await lane.idle();
    lane.request(1);
    await lane.idle();
    expect(send).toHaveBeenCalledTimes(1);
    lane.request(2);
    await lane.idle();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("resends after the page was rebuilt", async () => {
    const send = vi.fn(async () => true);
    const lane = createImageSync(same, send);
    lane.request(5);
    await lane.idle();
    lane.reset();
    lane.request(5);
    await lane.idle();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a thrown transfer error is contained", async () => {
    const lane = createImageSync(same, async () => { throw new Error("ble"); });
    lane.request(1);
    await expect(lane.idle()).resolves.toBeUndefined();
  });
});

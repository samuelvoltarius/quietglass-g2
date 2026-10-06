import { describe, expect, it } from "vitest";
import {
  BAR_IMAGE_HEIGHT, BAR_IMAGE_WIDTH, FULL, continuousFill, countSolidSegments, drawProgressBar,
  getPixel, measureContinuousFill, sameProgressBar, segmentWidth, type ProgressBarState, type SegmentStatus,
} from "../src/glasses/progressbar";
import { buildView, HEADER_TEXT_WIDTH, progressBarFor } from "../src/glasses/view";
import { back, complete, startRun } from "../src/checklist/run";
import type { Checklist, Step } from "../src/checklist/model";

const bar = (statuses: SegmentStatus[], critical: number[] = []): ProgressBarState => ({
  segments: statuses.map((status, i) => ({ status, critical: critical.includes(i) })),
});
const doneOf = (n: number, total: number): ProgressBarState =>
  bar(Array.from({ length: total }, (_, i): SegmentStatus => (i < n ? "done" : i === n ? "current" : "open")));

const list = (steps: Array<Partial<Step> & { id: string }>): Checklist => ({
  id: "l", title: "Packen",
  steps: steps.map((s) => ({ text: "Schritt " + s.id, kind: "normal", ...s })),
});

describe("progress bar: drawing", () => {
  it("fits an image container: 280 x 24, grayscale", () => {
    const bmp = drawProgressBar(doneOf(0, 7));
    expect([bmp.width, bmp.height]).toEqual([BAR_IMAGE_WIDTH, BAR_IMAGE_HEIGHT]);
    expect(bmp.width).toBeLessThanOrEqual(288);
    expect(bmp.height).toBeGreaterThanOrEqual(20);
    expect(bmp.pixels.length).toBe(280 * 24);
  });

  it("fills one segment per step done", () => {
    for (let done = 0; done <= 7; done++) {
      expect(countSolidSegments(drawProgressBar(doneOf(done, 7)), 7), `${done}/7`).toBe(done);
    }
  });

  it("switches to one continuous bar when segments would get too thin, filled in proportion", () => {
    expect(segmentWidth(7)).toBeGreaterThan(30);
    expect(segmentWidth(60)).toBe(0);
    const of60 = (done: number) => bar(Array.from({ length: 60 }, (_, i): SegmentStatus => (i < done ? "done" : "open")));
    expect(measureContinuousFill(drawProgressBar(of60(60)))).toBe(BAR_IMAGE_WIDTH - 2);
    expect(measureContinuousFill(drawProgressBar(of60(0)))).toBe(0);
    const half = measureContinuousFill(drawProgressBar(of60(30)));
    const quarter = measureContinuousFill(drawProgressBar(of60(15)));
    expect(half).toBe(continuousFill(30, 60));
    expect(Math.abs(half - 2 * quarter)).toBeLessThanOrEqual(1);
    expect(Math.abs(half - (BAR_IMAGE_WIDTH - 2) / 2)).toBeLessThanOrEqual(1);
  });

  it("marks critical steps above their segment", () => {
    const marks = (state: ProgressBarState): number => {
      const bmp = drawProgressBar(state);
      let lit = 0;
      for (let x = 0; x < BAR_IMAGE_WIDTH; x++) if (getPixel(bmp, x, 1) === FULL) lit++;
      return lit;
    };
    expect(marks(doneOf(2, 7))).toBe(0);
    const one = marks(bar(["done", "current", "open", "open"], [2]));
    const two = marks(bar(["done", "current", "open", "open"], [0, 2]));
    expect(one).toBeGreaterThan(0);
    expect(two).toBe(2 * one);
    // Also on a long, continuous bar.
    expect(marks(bar(Array.from({ length: 60 }, (): SegmentStatus => "open"), [10]))).toBe(one);
  });

  it("frames the current step brighter than the steps still to come", () => {
    const bmp = drawProgressBar(bar(["current", "open"]));
    const each = segmentWidth(2);
    const left = Math.floor((BAR_IMAGE_WIDTH - (2 * each + 2)) / 2);
    expect(getPixel(bmp, left, 12)).toBe(FULL);
    expect(getPixel(bmp, left + each + 2, 12)).toBeLessThan(FULL);
    expect(getPixel(bmp, left + each + 2, 12)).toBeGreaterThan(0);
  });

  it("is blank for an empty list", () => {
    expect(drawProgressBar(bar([])).pixels.every((p) => p === 0)).toBe(true);
  });
});

describe("progress bar: when it changes", () => {
  const checklist = list([{ id: "a" }, { id: "b", kind: "critical" }, { id: "c", kind: "optional" }, { id: "d" }]);

  it("one segment per required step; optional steps have none", () => {
    const state = progressBarFor(checklist, startRun(checklist, 0));
    expect(state.segments.map((s) => s.status)).toEqual(["current", "open", "open"]);
    expect(state.segments.map((s) => s.critical)).toEqual([false, true, false]);
  });

  it("does not change with the clock or an armed confirmation, only when a step is done", () => {
    const run = complete(checklist, startRun(checklist, 0), "done", 0);
    const armed = complete(checklist, run, "done", 0); // critical: the first tap only arms
    expect(armed.awaitingConfirm).toBe(true);
    expect(sameProgressBar(progressBarFor(checklist, run), progressBarFor(checklist, armed))).toBe(true);
    const confirmed = complete(checklist, armed, "done", 0);
    expect(sameProgressBar(progressBarFor(checklist, armed), progressBarFor(checklist, confirmed))).toBe(false);
    expect(progressBarFor(checklist, confirmed).segments.map((s) => s.status)).toEqual(["done", "done", "open"]);
  });

  it("follows going back", () => {
    const run = complete(checklist, startRun(checklist, 0), "done", 0);
    expect(progressBarFor(checklist, back(checklist, run))).toEqual(progressBarFor(checklist, startRun(checklist, 0)));
    expect(sameProgressBar(null, progressBarFor(checklist, run))).toBe(false);
  });
});

describe("header beside the bar", () => {
  it("keeps the position and gives way on a long section name", () => {
    const long = list([{ id: "a", section: "Ein sehr langer Abschnittsname für die Küche" }, { id: "b" }]);
    const header = buildView(long, startRun(long, 0), { locale: "de" }, 0).header;
    expect(header.length).toBeLessThanOrEqual(HEADER_TEXT_WIDTH);
    expect(header.endsWith("  1/2")).toBe(true);
    expect(header).toContain("…");
  });

  it("no longer repeats progress as a percentage in the footer", () => {
    const short = list([{ id: "a" }, { id: "b" }]);
    for (const locale of ["de", "en"] as const) {
      const run = { ...complete(short, startRun(short, 0), "done", 0), startedAt: 0 };
      const view = buildView(short, run, { locale }, 65_000);
      expect(view.footer).not.toContain("%");
      expect(view.footer).toContain("1:05");
    }
  });
});

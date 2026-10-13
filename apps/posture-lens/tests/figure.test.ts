import { describe, expect, it } from "vitest";
import { pixel } from "../src/glasses/bitmap";
import { ANGLE_IMAGE, angleKey, angleLabel, drawAngle, fitScale, textColumns } from "../src/glasses/digits";
import { FIGURE_IMAGE, drawFigure, figureKey, figurePattern, figureStage, nextStage, type FigureStage } from "../src/glasses/figure";

const STAGES: FigureStage[] = [0, 1, 2, 3];

describe("figure", () => {
  it("fits the 64 x 30 header image with its 11 x 9 pattern at 3x", () => {
    expect([FIGURE_IMAGE.width, FIGURE_IMAGE.height]).toEqual([64, 30]);
    expect(FIGURE_IMAGE.x + FIGURE_IMAGE.width).toBe(576);
    for (const stage of STAGES) {
      const pattern = figurePattern(stage);
      expect(pattern).toHaveLength(9);
      for (const row of pattern) expect(row).toMatch(/^[.#]{11}$/);
      const bitmap = drawFigure({ stage, alert: true });
      expect([bitmap.width, bitmap.height]).toEqual([64, 30]);
      expect(Math.max(...bitmap.pixels)).toBe(15);
    }
  });

  it("draws four different pictures", () => {
    const keys = new Set(STAGES.map((stage) => Array.from(drawFigure({ stage, alert: false }).pixels).join("")));
    expect(keys.size).toBe(4);
  });

  it("slumps in four steps as the angle grows past the warning angle", () => {
    const stages = [0, 5, 10, 18, 25, 30, 40].map((deg) => figureStage(deg, 25));
    expect(stages).toEqual([0, 0, 1, 1, 2, 2, 3]);
    expect(figureStage(null, 25)).toBe(0);
    expect(figureStage(Number.NaN, 25)).toBe(0);
    expect(figureStage(30, 0)).toBe(0);
  });

  it("moves only past a boundary with a margin, so it does not flicker", () => {
    // Boundary between 1 and 2 is 0.75 × 25 = 18.75°; slack is 1.25°.
    expect(nextStage(1, 18.9, 25)).toBe(1);
    expect(nextStage(1, 20.1, 25)).toBe(2);
    expect(nextStage(2, 18.0, 25)).toBe(2);
    expect(nextStage(2, 17.0, 25)).toBe(1);
    expect(nextStage(null, 18.9, 25)).toBe(2);
  });

  it("keys equal pictures equally", () => {
    expect(figureKey({ stage: 2, alert: true })).toBe(figureKey({ stage: 2, alert: true }));
    expect(figureKey({ stage: 2, alert: true })).not.toBe(figureKey({ stage: 3, alert: true }));
  });
});

describe("angle digits", () => {
  it("words the angle", () => {
    expect(angleLabel(17.6)).toBe("18°");
    expect(angleLabel(null)).toBe("--°");
    expect(angleLabel(-3)).toBe("0°");
    expect(angleLabel(250)).toBe("99°");
  });

  it("is 56 px tall at full scale and fits its container", () => {
    expect(ANGLE_IMAGE.width).toBeLessThanOrEqual(288);
    expect(ANGLE_IMAGE.height).toBeLessThanOrEqual(144);
    expect(fitScale("88°", ANGLE_IMAGE.width - 8)).toBe(8);
    expect(textColumns("88°") * 8).toBeLessThanOrEqual(ANGLE_IMAGE.width - 8);
    const bitmap = drawAngle({ show: true, deg: 18, alert: true });
    let top = -1, bottom = -1;
    for (let y = 0; y < bitmap.height; y++) {
      let lit = false;
      for (let x = 0; x < bitmap.width; x++) if (pixel(bitmap, x, y) > 0) { lit = true; break; }
      if (lit) { if (top < 0) top = y; bottom = y; }
    }
    expect(bottom - top + 1).toBe(56);
  });

  it("stays black while upright and hidden, and keys that state once", () => {
    expect(Math.max(...drawAngle({ show: false, deg: 3, alert: false }).pixels)).toBe(0);
    expect(angleKey({ show: false, deg: 3, alert: false })).toBe(angleKey({ show: false, deg: null, alert: true }));
    expect(angleKey({ show: true, deg: 18, alert: true })).not.toBe(angleKey({ show: true, deg: 19, alert: true }));
  });

  it("is dimmer when shown without an alert", () => {
    expect(Math.max(...drawAngle({ show: true, deg: 4, alert: false }).pixels)).toBeLessThan(15);
    expect(Math.max(...drawAngle({ show: true, deg: 4, alert: true }).pixels)).toBe(15);
  });
});

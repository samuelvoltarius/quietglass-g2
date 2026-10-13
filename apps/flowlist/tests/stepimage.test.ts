import { describe, expect, it } from "vitest";
import {
  MARGIN, MAX_SIZE, MIN_SIZE, STEP_HEIGHT, STEP_HALF, STEP_LEFT, STEP_RIGHT, STEP_WIDTH,
  estimateWidth, layoutKey, layoutStep, lineHeight, linePositions, sameLayout, wrapByWidth,
} from "../src/glasses/stepimage";

const fixed = (text: string, size: number): number => text.length * size * 0.5;
const AVAILABLE = STEP_WIDTH - 2 * MARGIN;

describe("step picture geometry", () => {
  it("is two image containers of 288 x 96 that make up the full width", () => {
    expect(STEP_LEFT.width + STEP_RIGHT.width).toBe(STEP_WIDTH);
    expect(STEP_LEFT.x).toBe(0);
    expect(STEP_RIGHT.x).toBe(STEP_HALF);
    for (const half of [STEP_LEFT, STEP_RIGHT]) {
      expect(half.width).toBeLessThanOrEqual(288);
      expect(half.height).toBeLessThanOrEqual(144);
      expect(half.height).toBe(STEP_HEIGHT);
    }
    expect(STEP_LEFT.id).not.toBe(STEP_RIGHT.id);
  });
});

describe("layoutStep", () => {
  it("uses the largest type for a short step, on one line", () => {
    const layout = layoutStep(fixed, "Open valve");
    expect(layout.size).toBe(MAX_SIZE);
    expect(layout.lines).toEqual(["Open valve"]);
    expect(layout.truncated).toBe(false);
  });

  it("wraps word by word and shrinks as the text grows, never past the box", () => {
    let previous = Infinity;
    for (const words of [2, 8, 14, 22, 30]) {
      const layout = layoutStep(fixed, Array.from({ length: words }, (_, i) => `word${i}`).join(" "));
      expect(layout.size).toBeLessThanOrEqual(previous);
      previous = layout.size;
      expect(layout.lines.length * lineHeight(layout.size)).toBeLessThanOrEqual(STEP_HEIGHT);
      for (const line of layout.lines) expect(fixed(line, layout.size), line).toBeLessThanOrEqual(AVAILABLE);
      if (!layout.truncated) expect(layout.lines.join(" ")).toBe(layout.text);
    }
  });

  it("cuts only at the smallest size, marking the cut, and says so", () => {
    const long = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
    const layout = layoutStep(fixed, long);
    expect(layout.truncated).toBe(true);
    expect(layout.size).toBe(MIN_SIZE);
    expect(layout.lines.at(-1)).toMatch(/…$/);
    expect(layout.lines.length * lineHeight(MIN_SIZE)).toBeLessThanOrEqual(STEP_HEIGHT);
    expect(fixed(layout.lines.at(-1) ?? "", MIN_SIZE)).toBeLessThanOrEqual(AVAILABLE);
  });

  it("splits a word wider than the line instead of overflowing", () => {
    const lines = wrapByWidth(fixed, "x".repeat(120), 40, AVAILABLE);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(fixed(line, 40)).toBeLessThanOrEqual(AVAILABLE);
    expect(lines.join("")).toBe("x".repeat(120));
  });

  it("is blank for no text, and equal layouts have equal keys", () => {
    expect(layoutStep(fixed, "  ").lines).toEqual([]);
    expect(layoutKey(layoutStep(fixed, ""))).toBe("blank");
    expect(sameLayout(layoutStep(fixed, "a  b"), layoutStep(fixed, "a b"))).toBe(true);
    expect(sameLayout(layoutStep(fixed, "a b"), layoutStep(fixed, "a c"))).toBe(false);
    expect(sameLayout(null, layoutStep(fixed, ""))).toBe(true);
  });

  it("centres the block vertically inside the picture", () => {
    const layout = layoutStep(fixed, "Check the oil level and top up");
    const rows = linePositions(layout);
    const top = rows[0]!.y;
    const bottom = rows.at(-1)!.y + lineHeight(layout.size);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThanOrEqual(STEP_HEIGHT);
    expect(Math.abs(top - (STEP_HEIGHT - bottom))).toBeLessThanOrEqual(1);
    expect(rows.every((row) => row.x === MARGIN)).toBe(true);
  });

  it("the estimate keeps caps wider than lower case and narrow letters narrow", () => {
    expect(estimateWidth("WWW", 10)).toBeGreaterThan(estimateWidth("www", 10) * 0.9);
    expect(estimateWidth("WWW", 10)).toBeGreaterThan(estimateWidth("abc", 10));
    expect(estimateWidth("iii", 10)).toBeLessThan(estimateWidth("abc", 10));
  });
});

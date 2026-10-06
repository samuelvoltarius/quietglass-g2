import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drawRoute, gridLines, nearestPixel, northArrow, renderRoutePng, OVERVIEW_HEIGHT, OVERVIEW_WIDTH, type MapContext,
} from "../src/overview/draw";
import { project, thinPoints, wrapLongitude } from "../src/overview/project";
import type { LatLng } from "../src/geo/geometry";

// Ported from apps/map-glass (tests/map.test.ts and tests/draw.test.ts) with
// the drawing logic; the regressions they pin travelled with the code.

const span = (values: readonly number[]): number => Math.max(...values) - Math.min(...values);
const DEMO_ROUTE: LatLng[] = [
  { lat: 47.806, lon: 13.052 }, { lat: 47.807, lon: 13.053 }, { lat: 47.808, lon: 13.054 },
  { lat: 47.809, lon: 13.056 }, { lat: 47.8105, lon: 13.057 }, { lat: 47.811, lon: 13.059 },
];

describe("overview projection", () => {
  it("projects the route into the viewport", () => {
    // Uniform scale: a 1°×1° box near the equator is a square, centred in a 100×50 viewport.
    const result = project([{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }], 100, 50, 10);
    expect(result[0]?.y).toBeCloseTo(40); expect(result[1]?.y).toBeCloseTo(10);
    expect(result[0]?.x).toBeCloseTo(35, 1); expect(result[1]?.x).toBeCloseTo(65, 1);
  });
  it("returns nothing for an empty route", () => { expect(project([], 100, 100)).toEqual([]); });
  it("puts a single repeated point in the centre instead of a corner", () => {
    expect(project([{ lat: 5, lon: 5 }, { lat: 5, lon: 5 }], 100, 60, 10)).toEqual([{ x: 50, y: 30 }, { x: 50, y: 30 }]);
  });
  it("centres a due-north route horizontally", () => {
    // Regression (Map Glass): lonSpan was clamped, so every x became `padding` and the route hugged the left edge.
    const pixels = project([{ lat: 47.80, lon: 13.05 }, { lat: 47.81, lon: 13.05 }], 288, 144, 28);
    expect(pixels.every((pixel) => Math.abs(pixel.x - 144) < 1e-6)).toBe(true);
    expect(pixels[0]?.y).toBeCloseTo(144 - 28); expect(pixels[1]?.y).toBeCloseTo(28);
  });
  it("does not blow sub-metre jitter up into a full-width zigzag", () => {
    // Regression (Map Glass): x and y were stretched independently, so ~1 m of GPS noise filled the width.
    const route = [{ lat: 47.800, lon: 13.05 }, { lat: 47.803, lon: 13.05001 }, { lat: 47.806, lon: 13.05 }, { lat: 47.809, lon: 13.05001 }];
    expect(span(project(route, 288, 144, 28).map((pixel) => pixel.x))).toBeLessThan(2);
  });
  it("keeps a right-angle turn a right angle", () => {
    // 1 km east then 1 km north at 60°N: lon degrees are half as long there.
    const pixels = project([{ lat: 60, lon: 10 }, { lat: 60, lon: 10.018 }, { lat: 60.009, lon: 10.018 }], 400, 400, 0);
    const [a, b, c] = pixels as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
    const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
    expect(Math.abs(dot)).toBeLessThan(1e-6);
    expect(Math.abs(b.x - a.x)).toBeCloseTo(Math.abs(c.y - b.y), -1);
  });
  it("keeps every point inside the padded viewport", () => {
    for (const pixel of project(DEMO_ROUTE, 288, 144, 28)) {
      expect(pixel.x).toBeGreaterThanOrEqual(28 - 1e-9); expect(pixel.x).toBeLessThanOrEqual(260 + 1e-9);
      expect(pixel.y).toBeGreaterThanOrEqual(28 - 1e-9); expect(pixel.y).toBeLessThanOrEqual(116 + 1e-9);
    }
  });
  it("draws north up and east right", () => {
    const [start, end] = project([{ lat: 0, lon: 0 }, { lat: 0.01, lon: 0.01 }], 100, 100, 0);
    expect(end!.x).toBeGreaterThan(start!.x); expect(end!.y).toBeLessThan(start!.y);
  });
  it("keeps a route across the antimeridian contiguous", () => {
    // Regression (Map Glass): 179.99 → -179.99 was treated as a 360° span, flinging the points to opposite edges.
    const crossing = project([{ lat: -17, lon: 179.99 }, { lat: -17.01, lon: -179.99 }], 288, 144, 28);
    const sameShapeElsewhere = project([{ lat: -17, lon: 9.99 }, { lat: -17.01, lon: 10.01 }], 288, 144, 28);
    crossing.forEach((pixel, index) => { expect(pixel.x).toBeCloseTo(sameShapeElsewhere[index]!.x, 6); expect(pixel.y).toBeCloseTo(sameShapeElsewhere[index]!.y, 6); });
  });
  it("wraps longitude differences into -180…180", () => {
    expect(wrapLongitude(0)).toBe(0); expect(wrapLongitude(359.98)).toBeCloseTo(-0.02); expect(wrapLongitude(-359.98)).toBeCloseTo(0.02); expect(wrapLongitude(190)).toBe(-170);
  });
  it("survives routes at the poles", () => {
    const pixels = project([{ lat: 90, lon: 0 }, { lat: 89.99, lon: 90 }], 100, 100, 10);
    expect(pixels.every((pixel) => Number.isFinite(pixel.x) && Number.isFinite(pixel.y))).toBe(true);
  });
  it("handles a route far longer than a spread call could take", () => {
    // A cross-country Valhalla shape has well over 100 000 points.
    const long = Array.from({ length: 200_000 }, (_, i) => ({ lat: 47 + i * 1e-5, lon: 13 + i * 1e-5 }));
    const pixels = project(long, 288, 144, 28);
    expect(pixels).toHaveLength(200_000);
    expect(Number.isFinite(pixels[199_999]!.x)).toBe(true);
  });
});

describe("thinning the route for the image", () => {
  it("keeps short routes untouched", () => { expect(thinPoints([1, 2, 3], 10)).toEqual([1, 2, 3]); });
  it("caps the point count and always keeps both ends", () => {
    const points = Array.from({ length: 10_001 }, (_, i) => i);
    const thinned = thinPoints(points, 600);
    expect(thinned).toHaveLength(600);
    expect(thinned[0]).toBe(0);
    expect(thinned[599]).toBe(10_000);
  });
});

describe("marker placement", () => {
  it("snaps the position to the nearest route point", () => {
    const geo = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 0, lon: 2 }];
    const pixels = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
    expect(nearestPixel({ lat: 0.1, lon: 1.2 }, geo, pixels)).toEqual({ x: 1, y: 0 });
  });
  it("measures across the antimeridian the short way", () => {
    const geo = [{ lat: 0, lon: 170 }, { lat: 0, lon: 179.9 }];
    const pixels = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
    expect(nearestPixel({ lat: 0, lon: -179.9 }, geo, pixels)).toEqual({ x: 1, y: 0 });
  });
});

// Records every canvas call with the style that was active at that moment, so drawing can be checked without a real canvas.
interface Call { readonly op: string; readonly args: readonly number[]; readonly fill: string; readonly stroke: string; readonly lineWidth: number; }
function fakeContext(): { ctx: MapContext; calls: Call[] } {
  const calls: Call[] = [];
  const state = { fillStyle: "", strokeStyle: "", lineWidth: 1, lineCap: "butt", lineJoin: "miter", font: "" };
  const record = (op: string) => (...args: unknown[]): void => { calls.push({ op, args: args.filter((value): value is number => typeof value === "number"), fill: state.fillStyle, stroke: state.strokeStyle, lineWidth: state.lineWidth }); };
  const ctx = Object.assign(state, { fillRect: record("fillRect"), beginPath: record("beginPath"), moveTo: record("moveTo"), lineTo: record("lineTo"), stroke: record("stroke"), arc: record("arc"), fill: record("fill"), strokeRect: record("strokeRect"), fillText: record("fillText") });
  return { ctx: ctx as unknown as MapContext, calls };
}
const route: LatLng[] = [{ lat: 47.80, lon: 13.05 }, { lat: 47.805, lon: 13.055 }, { lat: 47.81, lon: 13.06 }];

describe("overview drawing", () => {
  it("lays the grid across the whole image", () => {
    const lines = gridLines(288, 144);
    expect(lines).toHaveLength(Math.ceil((288 - 40) / 70) + Math.ceil((144 - 35) / 55));
    for (const line of lines) expect([line.from, line.to].every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    expect(gridLines(0, 0)).toEqual([]);
  });
  it("points the north arrow up, below the N, inside the image", () => {
    // Regression (Map Glass): the triangle's apex was at the bottom, so "north" pointed south.
    const { label, triangle: [apex, left, right] } = northArrow(288);
    expect(apex.y).toBeLessThan(left.y); expect(left.y).toBe(right.y);
    expect(apex.x).toBe((left.x + right.x) / 2);
    expect(apex.y).toBeGreaterThan(label.y);
    for (const point of [apex, left, right]) { expect(point.x).toBeLessThan(288); expect(point.x).toBeGreaterThan(0); }
  });
  it("clears to black and draws the route as one white polyline through the projected points", () => {
    const { ctx, calls } = fakeContext();
    drawRoute(ctx, route, null, 288, 144);
    expect(calls[0]).toMatchObject({ op: "fillRect", args: [0, 0, 288, 144], fill: "#000" });
    const pixels = project(route, 288, 144, 28);
    const white = calls.filter((call) => call.stroke === "#fff" && call.lineWidth === 8 && (call.op === "moveTo" || call.op === "lineTo"));
    expect(white.map((call) => call.op)).toEqual(["moveTo", "lineTo", "lineTo"]);
    white.forEach((call, index) => { expect(call.args[0]).toBeCloseTo(pixels[index]!.x); expect(call.args[1]).toBeCloseTo(pixels[index]!.y); });
  });
  it("puts the marker on the route point nearest the position and the destination square on the last point", () => {
    const { ctx, calls } = fakeContext();
    drawRoute(ctx, route, { lat: 47.8049, lon: 13.0551 }, 288, 144);
    const pixels = project(route, 288, 144, 28);
    const arcs = calls.filter((call) => call.op === "arc");
    expect(arcs).toHaveLength(2);
    for (const arc of arcs) { expect(arc.args[0]).toBeCloseTo(pixels[1]!.x); expect(arc.args[1]).toBeCloseTo(pixels[1]!.y); }
    const square = calls.find((call) => call.op === "strokeRect");
    expect(square?.args[0]).toBeCloseTo(pixels[2]!.x - 9); expect(square?.args[1]).toBeCloseTo(pixels[2]!.y - 9);
  });
  it("rings the next manoeuvre", () => {
    const { ctx, calls } = fakeContext();
    drawRoute(ctx, route, route[0]!, 288, 144, route[1]!);
    const pixels = project(route, 288, 144, 28);
    const ring = calls.find((call) => call.op === "arc" && call.args[2] === 14);
    expect(ring?.args[0]).toBeCloseTo(pixels[1]!.x);
    expect(ring?.args[1]).toBeCloseTo(pixels[1]!.y);
  });
  it("puts the marker on the start when there is no position", () => {
    const { ctx, calls } = fakeContext();
    drawRoute(ctx, route, null, 288, 144);
    const start = project(route, 288, 144, 28)[0]!;
    expect(calls.find((call) => call.op === "arc")?.args.slice(0, 2)).toEqual([start.x, start.y]);
  });
  it("draws only the background and north arrow for an empty route", () => {
    const { ctx, calls } = fakeContext();
    drawRoute(ctx, [], { lat: 1, lon: 1 }, 288, 144, { lat: 1, lon: 1 });
    expect(calls.some((call) => call.op === "arc" || call.op === "strokeRect")).toBe(false);
    expect(calls.some((call) => call.lineWidth === 8)).toBe(false);
    expect(calls.filter((call) => call.op === "fillText")).toHaveLength(1);
  });
});

describe("encoding the overview PNG", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  function stubCanvas(ctx: MapContext | null, blob: Blob | null): { width: number; height: number } {
    const canvas = { width: 0, height: 0, getContext: () => ctx, toBlob: (done: (value: Blob | null) => void) => done(blob) };
    vi.stubGlobal("document", { createElement: () => canvas });
    return canvas;
  }
  it("uses the largest image the glasses accept and returns the PNG bytes", async () => {
    const { ctx, calls } = fakeContext();
    const canvas = stubCanvas(ctx, new Blob([new Uint8Array([137, 80, 78, 71])]));
    expect([...await renderRoutePng(route, null)]).toEqual([137, 80, 78, 71]);
    expect(canvas).toMatchObject({ width: OVERVIEW_WIDTH, height: OVERVIEW_HEIGHT });
    expect([OVERVIEW_WIDTH, OVERVIEW_HEIGHT]).toEqual([288, 144]);
    expect(calls.length).toBeGreaterThan(0);
  });
  it("rejects when there is no 2D context or the encoder fails", async () => {
    stubCanvas(null, null);
    await expect(renderRoutePng(route, null)).rejects.toThrow("2d canvas unavailable");
    stubCanvas(fakeContext().ctx, null);
    await expect(renderRoutePng(route, null)).rejects.toThrow("PNG encode failed");
  });
});

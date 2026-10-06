import { afterEach, describe, expect, it, vi } from "vitest";
import { drawRoute, gridLines, northArrow, renderRoutePng, type MapContext } from "../src/map/draw";
import { project, type GeoPoint } from "../src/map/model";

// Records every canvas call with the style that was active at that moment, so drawing can be checked without a real canvas.
interface Call { readonly op: string; readonly args: readonly number[]; readonly fill: string; readonly stroke: string; readonly lineWidth: number; }
function fakeContext(): { ctx: MapContext; calls: Call[] } {
  const calls: Call[] = [];
  const state = { fillStyle: "", strokeStyle: "", lineWidth: 1, lineCap: "butt", lineJoin: "miter", font: "" };
  const record = (op: string) => (...args: unknown[]): void => { calls.push({ op, args: args.filter((value): value is number => typeof value === "number"), fill: state.fillStyle, stroke: state.strokeStyle, lineWidth: state.lineWidth }); };
  const ctx = Object.assign(state, { fillRect: record("fillRect"), beginPath: record("beginPath"), moveTo: record("moveTo"), lineTo: record("lineTo"), stroke: record("stroke"), arc: record("arc"), fill: record("fill"), strokeRect: record("strokeRect"), fillText: record("fillText") });
  return { ctx: ctx as unknown as MapContext, calls };
}
const route: GeoPoint[] = [{ lat: 47.80, lon: 13.05 }, { lat: 47.805, lon: 13.055 }, { lat: 47.81, lon: 13.06 }];

describe("map drawing geometry", () => {
  it("lays the street grid across the whole image", () => {
    const lines = gridLines(288, 144);
    expect(lines).toHaveLength(Math.ceil((288 - 40) / 70) + Math.ceil((144 - 35) / 55));
    for (const line of lines) expect([line.from, line.to].every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    expect(gridLines(0, 0)).toEqual([]);
  });
  it("points the north arrow up, below the N, inside the image", () => {
    // Regression: the triangle's apex was at the bottom, so the "north" arrow pointed south.
    const { label, triangle: [apex, left, right] } = northArrow(288);
    expect(apex.y).toBeLessThan(left.y); expect(left.y).toBe(right.y);
    expect(apex.x).toBe((left.x + right.x) / 2);
    expect(apex.y).toBeGreaterThan(label.y);
    for (const point of [apex, left, right]) { expect(point.x).toBeLessThan(288); expect(point.x).toBeGreaterThan(0); }
  });
});

describe("drawing the route", () => {
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
  it("puts the marker on the start when there is no position", () => {
    const { ctx, calls } = fakeContext();
    drawRoute(ctx, route, null, 288, 144);
    const start = project(route, 288, 144, 28)[0]!;
    expect(calls.find((call) => call.op === "arc")?.args.slice(0, 2)).toEqual([start.x, start.y]);
  });
  it("draws only the background and north arrow for an empty route", () => {
    // Used while waiting for a GPS fix: no marker, no destination, no route line.
    const { ctx, calls } = fakeContext();
    drawRoute(ctx, [], { lat: 1, lon: 1 }, 288, 144);
    expect(calls.some((call) => call.op === "arc" || call.op === "strokeRect")).toBe(false);
    expect(calls.some((call) => call.lineWidth === 8)).toBe(false);
    expect(calls.filter((call) => call.op === "fillText")).toHaveLength(1);
  });
});

describe("encoding the PNG", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  function stubCanvas(ctx: MapContext | null, blob: Blob | null): { width: number; height: number } {
    const canvas = { width: 0, height: 0, getContext: () => ctx, toBlob: (done: (value: Blob | null) => void) => done(blob) };
    vi.stubGlobal("document", { createElement: () => canvas });
    return canvas;
  }
  it("sizes the canvas, draws and returns the PNG bytes", async () => {
    const { ctx, calls } = fakeContext();
    const canvas = stubCanvas(ctx, new Blob([new Uint8Array([137, 80, 78, 71])]));
    expect([...await renderRoutePng(route, null, 288, 144)]).toEqual([137, 80, 78, 71]);
    expect(canvas).toMatchObject({ width: 288, height: 144 });
    expect(calls.length).toBeGreaterThan(0);
  });
  it("rejects when there is no 2D context or the encoder fails", async () => {
    stubCanvas(null, null);
    await expect(renderRoutePng(route, null)).rejects.toThrow("2d canvas unavailable");
    stubCanvas(fakeContext().ctx, null);
    await expect(renderRoutePng(route, null)).rejects.toThrow("PNG encode failed");
  });
});

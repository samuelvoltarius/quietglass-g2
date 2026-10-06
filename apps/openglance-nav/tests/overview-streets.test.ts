import { describe, expect, it, vi } from "vitest";
import { drawRoute, STREET_STYLE, type MapContext } from "../src/overview/draw";
import { overviewProjector, OVERVIEW_HEIGHT, OVERVIEW_WIDTH } from "../src/overview/layout";
import { project } from "../src/overview/project";
import { createStreetSource, streetsForRoute, type StreetSegment } from "../src/overview/streets";
import { encodePng, grayOf } from "../src/glasses/png";
import type { LatLng } from "../src/geo/geometry";
import { createRaster } from "./support/raster";

// A made-up walk through a made-up town: a route with three turns, and an
// Overpass answer holding a slightly irregular street grid around it — two
// main roads, side streets, a few footpaths.
const ROUTE: LatLng[] = [
  { lat: 47.8020, lon: 13.0380 }, { lat: 47.8045, lon: 13.0381 }, { lat: 47.8046, lon: 13.0420 },
  { lat: 47.8070, lon: 13.0421 }, { lat: 47.8071, lon: 13.0460 }, { lat: 47.8085, lon: 13.0462 },
];

function fakeOverpass(): unknown {
  const way = (points: Array<[number, number]>) => ({ type: "way", id: 1, geometry: points.map(([lat, lon]) => ({ lat, lon })) });
  const major = [
    way([[47.7950, 13.0300], [47.8100, 13.0330], [47.8200, 13.0350]]),
    way([[47.8058, 13.0200], [47.8060, 13.0400], [47.8065, 13.0600]]),
  ];
  const minor: unknown[] = [];
  for (let i = 0; i < 12; i++) {
    const lat = 47.7990 + i * 0.0013;
    minor.push(way([[lat, 13.0250], [lat + 0.0002, 13.0400], [lat + 0.0001, 13.0560]]));
    const lon = 13.0300 + i * 0.0022;
    minor.push(way([[47.7950, lon], [47.8040, lon + 0.0002], [47.8150, lon + 0.0001]]));
  }
  const path = [way([[47.8030, 13.0395], [47.8052, 13.0440], [47.8078, 13.0445]]), way([[47.8075, 13.0380], [47.8080, 13.0430]])];
  return { elements: [...major, { type: "count" }, ...minor, { type: "count" }, ...path, { type: "count" }] };
}

async function streetsFor(route: readonly LatLng[]): Promise<readonly StreetSegment[]> {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(fakeOverpass()), { status: 200 }));
  const result = await streetsForRoute(createStreetSource({ fetchImpl: fetchImpl as never }), overviewProjector(route), "walking", OVERVIEW_WIDTH, OVERVIEW_HEIGHT);
  expect(result.error).toBeNull();
  expect(fetchImpl).toHaveBeenCalledOnce();
  return result.segments;
}

interface Call { readonly op: string; readonly stroke: string; readonly lineWidth: number; }
function recorder(): { ctx: MapContext; calls: Call[] } {
  const calls: Call[] = [];
  const state = { fillStyle: "", strokeStyle: "", lineWidth: 1, lineCap: "butt", lineJoin: "miter", font: "" };
  const record = (op: string) => (): void => { calls.push({ op, stroke: state.strokeStyle, lineWidth: state.lineWidth }); };
  const ctx = Object.assign(state, { fillRect: record("fillRect"), beginPath: record("beginPath"), moveTo: record("moveTo"), lineTo: record("lineTo"), stroke: record("stroke"), arc: record("arc"), fill: record("fill"), strokeRect: record("strokeRect"), fillText: record("fillText") });
  return { ctx: ctx as unknown as MapContext, calls };
}

describe("overview with real streets", () => {
  it("draws streets faintest first, under a black-edged route, one stroke per class", async () => {
    const streets = await streetsFor(ROUTE);
    const { ctx, calls } = recorder();
    drawRoute(ctx, ROUTE, ROUTE[1]!, OVERVIEW_WIDTH, OVERVIEW_HEIGHT, ROUTE[2]!, streets);
    const strokes = calls.filter((call) => call.op === "stroke").map((call) => call.stroke);
    expect(strokes.slice(0, 5)).toEqual([STREET_STYLE.path.color, STREET_STYLE.minor.color, STREET_STYLE.major.color, "#000", "#fff"]);
    expect(calls.find((call) => call.stroke === STREET_STYLE.major.color && call.op === "stroke")?.lineWidth).toBeGreaterThan(STREET_STYLE.minor.width);
  });

  it("draws the route alone when there are no streets — no fake grid", () => {
    const { ctx, calls } = recorder();
    drawRoute(ctx, ROUTE, null, OVERVIEW_WIDTH, OVERVIEW_HEIGHT);
    const strokes = calls.filter((call) => call.op === "stroke").map((call) => call.stroke);
    expect(strokes.every((stroke) => stroke === "#fff")).toBe(true);
  });

  it("renders to pixels the glasses can tell apart, and writes a preview on request", async () => {
    const streets = await streetsFor(ROUTE);
    expect(streets.some((s) => s.cls === "major") && streets.some((s) => s.cls === "minor") && streets.some((s) => s.cls === "path")).toBe(true);
    const raster = createRaster(OVERVIEW_WIDTH, OVERVIEW_HEIGHT);
    drawRoute(raster.ctx, ROUTE, ROUTE[1]!, OVERVIEW_WIDTH, OVERVIEW_HEIGHT, ROUTE[3]!, streets);

    const values = new Set(raster.pixels);
    for (const cls of ["major", "minor"] as const) expect(values.has(grayOf(STREET_STYLE[cls].color))).toBe(true);
    // The route stays white along its whole length, streets or not.
    const [a, b] = project(ROUTE, OVERVIEW_WIDTH, OVERVIEW_HEIGHT, 28);
    const mid = { x: Math.round((a!.x + b!.x) / 2), y: Math.round((a!.y + b!.y) / 2) };
    expect(raster.pixels[mid.y * OVERVIEW_WIDTH + mid.x]).toBe(255);
    // Grey levels the G2 can show (it converts to 16): no more than a handful are used.
    expect(values.size).toBeLessThanOrEqual(6);

    const png = await encodePng(OVERVIEW_WIDTH, OVERVIEW_HEIGHT, raster.pixels);
    expect([...png.slice(1, 4)]).toEqual([80, 78, 71]);
    const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    if (env?.["OPENGLANCE_PREVIEW"] === "1") {
      const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as { writeFileSync(path: string, data: Uint8Array): void };
      fs.writeFileSync(new URL("../docs/overview-preview.png", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), png);
    }
  });
});

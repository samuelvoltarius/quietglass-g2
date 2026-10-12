import { describe, expect, it, vi } from "vitest";
import { drawMap, STREET_STYLE, type MapContext } from "../src/overview/draw";
import { mapProjector, MARKER_AT, MAP_HEIGHT, MAP_WIDTH, rangeFor, courseAhead } from "../src/overview/camera";
import { overviewProjector } from "../src/overview/layout";
import { createStreetSource, loadStreets, type Street } from "../src/overview/streets";
import { encodePng, grayOf } from "../src/glasses/png";
import type { LatLng } from "../src/geo/geometry";
import { createRaster } from "./support/raster";

// A made-up drive through a made-up town: a route with three turns, and an
// Overpass answer holding a slightly irregular street grid around it - two
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

async function streetsFor(route: readonly LatLng[], mode: "walking" | "driving" = "walking"): Promise<readonly Street[]> {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(fakeOverpass()), { status: 200 }));
  const result = await loadStreets(createStreetSource({ fetchImpl: fetchImpl as never }), overviewProjector(route), mode);
  expect(result.error).toBeNull();
  expect(fetchImpl).toHaveBeenCalledOnce();
  return result.streets;
}

interface Call { readonly op: string; readonly stroke: string; readonly lineWidth: number; }
function recorder(): { ctx: MapContext; calls: Call[] } {
  const calls: Call[] = [];
  const state = { fillStyle: "", strokeStyle: "", lineWidth: 1, lineCap: "butt", lineJoin: "miter", font: "" };
  const record = (op: string) => (): void => { calls.push({ op, stroke: state.strokeStyle, lineWidth: state.lineWidth }); };
  const ctx = Object.assign(state, { fillRect: record("fillRect"), beginPath: record("beginPath"), moveTo: record("moveTo"), lineTo: record("lineTo"), stroke: record("stroke"), arc: record("arc"), fill: record("fill"), strokeRect: record("strokeRect"), fillText: record("fillText") });
  return { ctx: ctx as unknown as MapContext, calls };
}

/** The map as the glasses would get it at `position`, heading along the route. */
function scene(streets: readonly Street[], position: LatLng, next: LatLng | null) {
  const bearing = courseAhead(ROUTE, position);
  return { route: ROUTE, next, streets, view: { center: position, bearing, range: rangeFor(600) } };
}

describe("map with real streets", () => {
  it("loads the streets once for the route, as geometry the moving map can project itself", async () => {
    const streets = await streetsFor(ROUTE);
    expect(streets.some((s) => s.cls === "major") && streets.some((s) => s.cls === "minor") && streets.some((s) => s.cls === "path")).toBe(true);
    expect(streets[0]?.points[0]).toHaveProperty("lat");
  });

  it("falls back to no streets, never an exception, when anything fails", async () => {
    const broken = { load: async () => { throw new Error("boom"); } };
    expect(await loadStreets(broken, overviewProjector(ROUTE), "walking")).toEqual({ streets: [], error: "server" });
    expect(await loadStreets(broken, null, "walking")).toEqual({ streets: [], error: null });
  });

  it("draws streets faintest first, under a black-edged route, one stroke per class", async () => {
    const streets = await streetsFor(ROUTE);
    const { ctx, calls } = recorder();
    drawMap(ctx, scene(streets, ROUTE[1]!, ROUTE[2]!));
    const strokes = calls.filter((call) => call.op === "stroke").map((call) => call.stroke);
    expect(strokes.slice(0, 5)).toEqual([STREET_STYLE.path.color, STREET_STYLE.minor.color, STREET_STYLE.major.color, "#000", "#fff"]);
    expect(calls.find((call) => call.stroke === STREET_STYLE.major.color && call.op === "stroke")?.lineWidth).toBeGreaterThan(STREET_STYLE.minor.width);
  });

  it("draws the route alone when there are no streets - no fake grid", () => {
    const { ctx, calls } = recorder();
    drawMap(ctx, scene([], ROUTE[1]!, null));
    const strokes = calls.filter((call) => call.op === "stroke").map((call) => call.stroke);
    // The route is the first stroke, white, and no black edge is drawn first.
    expect(strokes[0]).toBe("#fff");
  });

  it("renders to pixels the glasses can tell apart", async () => {
    const streets = await streetsFor(ROUTE);
    expect(streets.length).toBeGreaterThan(0);
    const raster = createRaster(MAP_WIDTH, MAP_HEIGHT);
    // 300 m before the second turn, looking up the road.
    const view = { center: ROUTE[2]!, bearing: courseAhead(ROUTE, ROUTE[2]!), range: 1200 };
    drawMap(raster.ctx, { route: ROUTE, next: ROUTE[3]!, streets, view });

    const values = new Set(raster.pixels);
    for (const cls of ["major", "minor"] as const) expect(values.has(grayOf(STREET_STYLE[cls].color))).toBe(true);
    // The route is white on its way to the next point: a pixel halfway between the car and the next route point.
    const toPixel = mapProjector(view);
    const a = toPixel(ROUTE[2]!), b = toPixel(ROUTE[3]!);
    const mid = { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) };
    expect(raster.pixels[mid.y * MAP_WIDTH + mid.x]).toBe(255);
    // Grey levels the G2 can show (it converts to 16): no more than a handful are used.
    expect(values.size).toBeLessThanOrEqual(8);
    const png = await encodePng(MAP_WIDTH, MAP_HEIGHT, raster.pixels);
    expect([...png.slice(1, 4)]).toEqual([80, 78, 71]);
    expect(MARKER_AT.y).toBeLessThan(MAP_HEIGHT);
  });
});

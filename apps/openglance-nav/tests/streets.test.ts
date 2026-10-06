import { describe, expect, it, vi } from "vitest";
import {
  buildOverpassQuery, classesFor, clipSegment, containsBox, createStreetSource, DEFAULT_OVERPASS_URLS, fetchBox,
  MAX_SEGMENTS, parseOverpass, prepareStreets, spanMeters, streetsForRoute, type Street,
} from "../src/overview/streets";
import { fitProjection } from "../src/overview/project";
import { overviewProjector } from "../src/overview/layout";
import { needsOverviewImage, MARKER_MIN_INTERVAL_MS, type OverviewFrame } from "../src/overview/refresh";

const box = (south: number, west: number, north: number, east: number) => ({ south, west, north, east });
/** About 1.1 km × 0.75 km in Salzburg. */
const SMALL = box(47.800, 13.035, 47.810, 13.045);

describe("which streets are worth drawing", () => {
  it("measures a box in metres, longitude shrunk by latitude", () => {
    expect(spanMeters(box(0, 0, 0.01, 0.01))).toBeCloseTo(1113, -1);
    expect(spanMeters(box(60, 10, 60.001, 10.02))).toBeCloseTo(1113, -1);
  });

  it("adds footpaths only on foot and only zoomed in; drops minor roads zoomed out; nothing for huge areas", () => {
    expect(classesFor(SMALL, "walking")).toEqual(["major", "minor", "path"]);
    expect(classesFor(SMALL, "cycling")).toEqual(["major", "minor"]);
    expect(classesFor(SMALL, "driving")).toEqual(["major", "minor"]);
    expect(classesFor(box(47.8, 13.0, 47.83, 13.04), "walking")).toEqual(["major", "minor"]);
    expect(classesFor(box(47.8, 13.0, 47.9, 13.1), "driving")).toEqual(["major"]);
    expect(classesFor(box(47, 13, 48, 14), "driving")).toEqual([]);
    expect(classesFor(box(1, 1, 1, 1), "walking")).toEqual([]);
  });

  it("fetches a slightly larger box, rounded outwards to 4 decimals", () => {
    const fetched = fetchBox(SMALL)!;
    expect(containsBox(fetched, SMALL)).toBe(true);
    expect(fetched.south).toBeCloseTo(47.7985, 6); expect(fetched.north).toBeCloseTo(47.8115, 6);
    for (const value of Object.values(fetched)) expect(Math.round(value * 1e4) / 1e4).toBeCloseTo(value, 9);
    expect(fetchBox(box(-17, 179.9, -16.9, 180.05))).toBeNull();
    expect(fetchBox(box(Number.NaN, 0, 1, 1))).toBeNull();
  });

  it("asks for ids and box-cut geometry per class, each set closed by a count", () => {
    const query = buildOverpassQuery(SMALL, ["major", "minor"]);
    expect(query.startsWith("[out:json][timeout:10];")).toBe(true);
    expect(query).toContain("(47.8000,13.0350,47.8100,13.0450)");
    expect(query.match(/out ids geom\(/g)).toHaveLength(2);
    expect(query.match(/out count;/g)).toHaveLength(2);
    expect(query).toContain("motorway|trunk|primary|secondary");
    expect(query).not.toContain("service");
    expect(query).not.toContain("footway");
  });
});

describe("reading the Overpass answer", () => {
  const way = (...points: Array<[number, number] | null>) => ({ type: "way", id: 1, geometry: points.map((p) => p && { lat: p[0], lon: p[1] }) });

  it("assigns each way the class of its section", () => {
    const streets = parseOverpass({ elements: [way([0, 0], [0, 1]), { type: "count" }, way([1, 0], [1, 1]), way([2, 0], [2, 1]), { type: "count" }] }, ["major", "minor"]);
    expect(streets?.map((s) => s.cls)).toEqual(["major", "minor", "minor"]);
  });

  it("breaks a line where the box cut dropped nodes, and skips junk", () => {
    const streets = parseOverpass({ elements: [
      way([0, 0], [0, 1], null, [0, 2], [0, 3]),
      way([0, 0]),
      { type: "way", geometry: "nope" },
      { type: "node", lat: 1, lon: 1 },
      way([0, 0], [Number.NaN, 1] as [number, number], [0, 2]),
      { type: "count" },
      way([5, 5], [5, 6]), // beyond the classes asked for
    ] }, ["path"]);
    expect(streets?.map((s) => s.points.length)).toEqual([2, 2]);
  });

  it("refuses something that is not an Overpass result, and a partial result after a server error", () => {
    expect(parseOverpass(null, ["major"])).toBeNull();
    expect(parseOverpass({ elements: "x" }, ["major"])).toBeNull();
    expect(parseOverpass({ remark: "runtime error: Query timed out", elements: [way([0, 0], [0, 1])] }, ["major"])).toBeNull();
    expect(parseOverpass({ elements: [] }, ["major"])).toEqual([]);
  });
});

describe("fitting streets into the picture", () => {
  it("clips segments to the image", () => {
    expect(clipSegment({ x: -10, y: 5 }, { x: 20, y: 5 }, 0, 0, 10, 10)).toEqual([{ x: 0, y: 5 }, { x: 10, y: 5 }]);
    expect(clipSegment({ x: -10, y: -10 }, { x: -1, y: 20 }, 0, 0, 10, 10)).toBeNull();
    expect(clipSegment({ x: 2, y: 2 }, { x: 3, y: 3 }, 0, 0, 10, 10)).toEqual([{ x: 2, y: 2 }, { x: 3, y: 3 }]);
    expect(clipSegment({ x: 5, y: -5 }, { x: 5, y: 15 }, 0, 0, 10, 10)).toEqual([{ x: 5, y: 0 }, { x: 5, y: 10 }]);
  });

  const identity = { toPixel: (p: { lat: number; lon: number }) => ({ x: p.lon, y: p.lat }) };
  it("drops points closer than a pixel and a half, keeps the ends, cuts at the edge", () => {
    const street: Street = { cls: "minor", points: [{ lat: 5, lon: 1 }, { lat: 5, lon: 1.5 }, { lat: 5, lon: 2 }, { lat: 5, lon: 5 }, { lat: 5, lon: 50 }] };
    const segments = prepareStreets([street], identity, 20, 10);
    expect(segments.map((s) => [s.from.x, s.to.x])).toEqual([[1, 5], [5, 20]]);
    expect(segments.every((s) => s.cls === "minor")).toBe(true);
  });

  it("caps the segment count, keeping major roads before minor roads before paths", () => {
    const line = (cls: Street["cls"], y: number): Street => ({ cls, points: [{ lat: y, lon: 0 }, { lat: y, lon: 10 }] });
    const streets = [line("path", 1), line("path", 2), line("minor", 3), line("major", 4), line("minor", 5)];
    expect(prepareStreets(streets, identity, 20, 20, 3).map((s) => s.cls)).toEqual(["major", "minor", "minor"]);
    const many = Array.from({ length: MAX_SEGMENTS + 50 }, (_, i) => line("minor", i % 20));
    expect(prepareStreets(many, identity, 20, 20)).toHaveLength(MAX_SEGMENTS);
  });

  it("knows the area the overview shows, edge to edge", () => {
    const route = [{ lat: 47.80, lon: 13.05 }, { lat: 47.81, lon: 13.06 }];
    const projector = fitProjection(route, 288, 144, 28)!;
    const b = projector.bounds!;
    const sw = projector.toPixel({ lat: b.south, lon: b.west });
    const ne = projector.toPixel({ lat: b.north, lon: b.east });
    expect(sw.x).toBeCloseTo(0, 6); expect(sw.y).toBeCloseTo(144, 6);
    expect(ne.x).toBeCloseTo(288, 6); expect(ne.y).toBeCloseTo(0, 6);
    expect(fitProjection([{ lat: 1, lon: 1 }, { lat: 1, lon: 1 }], 288, 144, 28)!.bounds).toBeNull();
  });
});

describe("asking Overpass politely", () => {
  const answer = { elements: [{ type: "way", geometry: [{ lat: 47.801, lon: 13.036 }, { lat: 47.809, lon: 13.044 }] }, { type: "count" }] };
  const ok = (body: unknown = answer, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers });

  it("POSTs the query as a form (no CORS preflight) to the public server first", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ok());
    const outcome = await createStreetSource({ fetchImpl: fetchImpl as never }).load(SMALL, ["major"]);
    expect(outcome.error).toBeNull();
    expect(outcome.streets).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(DEFAULT_OVERPASS_URLS[0]);
    expect(url).toBe("https://overpass-api.de/api/interpreter");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    expect((init?.body as URLSearchParams).get("data")).toBe(buildOverpassQuery(SMALL, ["major"]));
    expect(init?.headers).toBeUndefined();
  });

  it("answers a box inside an earlier one from memory", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const source = createStreetSource({ fetchImpl: fetchImpl as never });
    await source.load(SMALL, ["major", "minor"]);
    const again = await source.load(box(47.801, 13.036, 47.809, 13.044), ["major"]);
    expect(again.error).toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
    await source.load(box(47.79, 13.036, 47.809, 13.044), ["major"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up on a server that does not answer in time and tries the next one once", async () => {
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => url === DEFAULT_OVERPASS_URLS[0]
      ? new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
      : Promise.resolve(ok()));
    const outcome = await createStreetSource({ fetchImpl: fetchImpl as never, timeoutMs: 20 }).load(SMALL, ["major"]);
    expect(outcome.error).toBeNull();
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([...DEFAULT_OVERPASS_URLS]);
  });

  it("reports a timeout when every server is too slow, then pauses before asking again", async () => {
    let now = 0;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const source = createStreetSource({ fetchImpl: fetchImpl as never, timeoutMs: 10, clock: () => now });
    expect((await source.load(SMALL, ["major"])).error).toBe("timeout");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    now = 30_000;
    expect((await source.load(SMALL, ["major"])).error).toBe("cooldown");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    now = 61_000;
    await source.load(SMALL, ["major"]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("treats 429, 406 and 504 as busy and other failures as server errors", async () => {
    for (const [status, error] of [[429, "busy"], [406, "busy"], [504, "busy"], [500, "server"]] as const) {
      const fetchImpl = vi.fn(async () => new Response("no", { status }));
      expect((await createStreetSource({ fetchImpl: fetchImpl as never, urls: ["https://o.test"] }).load(SMALL, ["major"])).error).toBe(error);
    }
  });

  it("refuses an oversized answer, by header or by length", async () => {
    const big = vi.fn(async () => ok(answer, { "content-length": "999999999" }));
    expect((await createStreetSource({ fetchImpl: big as never, urls: ["https://o.test"] }).load(SMALL, ["major"])).error).toBe("oversized");
    const long = vi.fn(async () => ok({ elements: [], padding: "x".repeat(5_000) }));
    const outcome = await createStreetSource({ fetchImpl: long as never, urls: ["https://o.test"], maxBytes: 1_000 }).load(SMALL, ["major"]);
    expect(outcome).toEqual({ streets: [], error: "oversized" });
  });

  it("refuses malformed JSON and a runtime-error remark", async () => {
    const junk = vi.fn(async () => new Response("<html>busy</html>", { status: 200 }));
    expect((await createStreetSource({ fetchImpl: junk as never, urls: ["https://o.test"] }).load(SMALL, ["major"])).error).toBe("invalid");
    const remark = vi.fn(async () => ok({ remark: "runtime error: out of memory", elements: [] }));
    expect((await createStreetSource({ fetchImpl: remark as never, urls: ["https://o.test"] }).load(SMALL, ["major"])).error).toBe("invalid");
  });

  it("stops at once when the phone is offline, without trying the other server", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    expect((await createStreetSource({ fetchImpl: fetchImpl as never }).load(SMALL, ["major"])).error).toBe("offline");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("sends nothing when no class is worth fetching", async () => {
    const fetchImpl = vi.fn(async () => ok());
    expect(await createStreetSource({ fetchImpl: fetchImpl as never }).load(SMALL, [])).toEqual({ streets: [], error: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("streets for a route", () => {
  const route = [{ lat: 47.802, lon: 13.038 }, { lat: 47.806, lon: 13.040 }, { lat: 47.808, lon: 13.043 }];

  it("loads once for the visible area and returns segments inside the image", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ elements: [
      { type: "way", geometry: [{ lat: 47.79, lon: 13.039 }, { lat: 47.82, lon: 13.039 }] }, { type: "count" },
    ] }), { status: 200 }));
    const result = await streetsForRoute(createStreetSource({ fetchImpl: fetchImpl as never }), overviewProjector(route), "driving", 288, 144);
    expect(result.error).toBeNull();
    expect(result.segments.length).toBeGreaterThan(0);
    for (const s of result.segments) for (const p of [s.from, s.to]) {
      expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(288);
      expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(144);
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("falls back to no streets — never an exception — when anything fails", async () => {
    const broken = { load: async () => { throw new Error("boom"); } };
    expect(await streetsForRoute(broken, overviewProjector(route), "walking", 288, 144)).toEqual({ segments: [], error: "server" });
    expect(await streetsForRoute(broken, null, "walking", 288, 144)).toEqual({ segments: [], error: null });
  });
});

describe("resending the overview image", () => {
  const frame = (over: Partial<OverviewFrame> = {}): OverviewFrame => ({ route: 1, streets: 0, maneuver: 0, marker: { x: 100, y: 50 }, at: 0, ...over });

  it("sends the first picture and any new route, streets or turn at once", () => {
    expect(needsOverviewImage(null, frame())).toBe(true);
    expect(needsOverviewImage(frame(), frame({ route: 2 }))).toBe(true);
    expect(needsOverviewImage(frame(), frame({ streets: 1 }))).toBe(true);
    expect(needsOverviewImage(frame(), frame({ maneuver: 1 }))).toBe(true);
  });

  it("moves the marker only after it moved visibly and some seconds passed", () => {
    expect(needsOverviewImage(frame(), frame({ marker: { x: 102, y: 51 }, at: 60_000 }))).toBe(false);
    expect(needsOverviewImage(frame(), frame({ marker: { x: 110, y: 50 }, at: 1_000 }))).toBe(false);
    expect(needsOverviewImage(frame(), frame({ marker: { x: 110, y: 50 }, at: MARKER_MIN_INTERVAL_MS }))).toBe(true);
    expect(needsOverviewImage(frame(), frame({ marker: null }))).toBe(true);
    expect(needsOverviewImage(frame({ marker: null }), frame({ marker: null, at: 99_000 }))).toBe(false);
  });
});

describe("the street-map setting", () => {
  it("is on after install, remembers off, and ignores garbage", async () => {
    const { EMPTY_DATA, parseData } = await import("../src/storage/persist");
    expect(EMPTY_DATA.streets).toBe(true);
    expect(parseData(JSON.stringify({ streets: false })).streets).toBe(false);
    expect(parseData(JSON.stringify({ streets: "no" })).streets).toBe(true);
    expect(parseData(JSON.stringify({})).streets).toBe(true);
  });
});

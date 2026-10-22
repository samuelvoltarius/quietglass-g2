import { describe, expect, it } from "vitest";
import recorded from "../src/demo/plan-salzburg.json";
import { demoJourneys } from "../src/demo/demo";
import { departureOf, type TransitLeg, type WalkLeg } from "../src/route/journey";
import { walkNav, type LatLon } from "../src/route/walk";
import {
  MAP_H, MAP_W, MIN_REDRAW_MS, SPAN_LEVELS_M, cameraFor, courseAhead, mapProjector, remainingRoute, settleView, worthRedrawing,
  type MapView,
} from "../src/map/camera";
import {
  OVERPASS_ORIGINS, OVERPASS_URLS, PUBLIC_OVERPASS_URLS, buildOverpassQuery, classesFor, createStreetSource, legBox, normalizeOverpassUrl,
  overpassUrlsFor, parseOverpass, prepareStreets,
} from "../src/map/streets";
import { LABEL_CHARS, LABEL_HEIGHT, LABEL_PAD_X, MAX_LABELS, overlaps, placeLabels, shortenName } from "../src/map/labels";
import { MAP_LEVELS, drawWalkMap, edgePoint, scaleBar, type WalkMapInput } from "../src/map/draw";
import { createFrame, frameKey, type Frame } from "../src/screen/frame";
import { pixelBackend } from "../src/screen/text";
import { bufferMinutes, composeWalkTiles, walkCells, walkHeadline, walkModel, walkDirection } from "../src/cockpit/walk";
import { ft } from "../src/footer";
import { WALK_ROUTE, walkStreetsAnswer } from "./fixtures/walk-streets";
import { greenPng } from "./fixtures/green-png";

const backend = pixelBackend();
const shape = WALK_ROUTE.shape;
const END = shape[shape.length - 1]!;
const START = shape[0]!;
const here = (fraction: number): LatLon => shape[Math.floor((shape.length - 1) * fraction)]!;
const metresNorth = (point: LatLon, metres: number): LatLon => ({ lat: point.lat + metres / 110540, lon: point.lon });

describe("the camera", () => {
  it("puts the walker at the marker, and turns the map so the route runs up", () => {
    const user = here(0.3);
    const view = cameraFor(shape, user, END);
    expect(view.bearing).not.toBeNull();
    const toPixel = mapProjector(view);
    expect(toPixel(user).x).toBeCloseTo(144, 5);
    // A point 100 m ahead along the heading is above the walker, straight up.
    const theta = (view.bearing! * Math.PI) / 180;
    const ahead = { lat: user.lat + (100 * Math.cos(theta)) / 110540, lon: user.lon + (100 * Math.sin(theta)) / (111320 * Math.cos((user.lat * Math.PI) / 180)) };
    const p = toPixel(ahead);
    expect(p.x).toBeCloseTo(144, 0);
    expect(p.y).toBeLessThan(toPixel(user).y);
  });

  it("north is up (a dot, centred) when the walk has no length left", () => {
    const view = cameraFor(shape, END, END);
    expect(view.bearing).toBeNull();
    expect(mapProjector(view)(END).y).toBe(127);
  });

  it("scales in steps between 150 m and 1.2 km and fits the rest of the walk", () => {
    const near = cameraFor(shape, metresNorth(END, 20), END);
    expect(near.spanM).toBe(SPAN_LEVELS_M[0]);
    const mid = here(0.5);
    const whole = cameraFor(shape, mid, END);
    expect(SPAN_LEVELS_M).toContain(whole.spanM);
    const toPixel = mapProjector(whole);
    for (const point of remainingRoute(shape, mid)) {
      const p = toPixel(point);
      expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(MAP_W);
      expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(MAP_H);
    }
    const far = cameraFor([START, metresNorth(START, 5000)], START, metresNorth(START, 5000));
    expect(far.spanM).toBe(1200);
  });

  it("takes the course from the rest of the route", () => {
    expect(courseAhead([START])).toBeNull();
    expect(courseAhead([START, metresNorth(START, 100)])).toBe(0);
  });
});

describe("when the map is worth sending again", () => {
  const view: MapView = cameraFor(shape, here(0.3), END);
  const moved = (metres: number): MapView => ({ ...view, user: metresNorth(view.user, metres) });

  it("keeps the same view for a small move, a small turn, or too soon", () => {
    const first = settleView(null, view, 1000);
    expect(settleView(first, moved(5), 20_000)).toBe(first);
    expect(settleView(first, { ...view, bearing: ((view.bearing ?? 0) + 5) % 360 }, 20_000)).toBe(first);
    expect(settleView(first, moved(30), 1000 + MIN_REDRAW_MS - 1)).toBe(first);
  });

  it("takes over 8 m, 10 degrees or a step of the scale, but not more often than every 4 s", () => {
    const first = settleView(null, view, 1000);
    const later = 1000 + MIN_REDRAW_MS;
    expect(settleView(first, moved(9), later).view.user).toEqual(moved(9).user);
    expect(settleView(first, { ...view, bearing: ((view.bearing ?? 0) + 11) % 360 }, later)).not.toBe(first);
    expect(settleView(first, { ...view, spanM: view.spanM === 1200 ? 150 : 1200 }, later)).not.toBe(first);
    expect(worthRedrawing(view, moved(7))).toBe(false);
    expect(worthRedrawing(view, moved(8.5))).toBe(true);
  });
});

describe("the streets", () => {
  it("builds one query for the classes that suit the size of the leg", () => {
    const box = legBox([START, END])!;
    expect(classesFor(box)).toEqual(["major", "minor", "path"]);
    expect(classesFor(legBox([START, metresNorth(START, 3000)])!)).toEqual(["major", "minor"]);
    expect(classesFor(legBox([START, metresNorth(START, 30_000)])!)).toEqual([]);
    const query = buildOverpassQuery(box, ["major", "minor"]);
    expect(query).toContain("[out:json]");
    expect(query.match(/out count/g)).toHaveLength(2);
    expect(legBox([])).toBeNull();
  });

  it("only ever calls the two Overpass origins of the whitelist", () => {
    expect(OVERPASS_ORIGINS).toEqual(["https://overpass-api.de", "https://overpass.private.coffee"]);
    for (const url of OVERPASS_URLS) expect(OVERPASS_ORIGINS.some((origin) => url.startsWith(`${origin}/`))).toBe(true);
  });

  it("reads an answer section by section and rejects partial or broken ones", () => {
    const streets = parseOverpass(walkStreetsAnswer(), ["major", "minor", "path"])!;
    expect(new Set(streets.map((s) => s.cls))).toEqual(new Set(["major", "minor", "path"]));
    expect(parseOverpass({ elements: [], remark: "runtime error: Query timed out" }, ["major"])).toBeNull();
    expect(parseOverpass({ nope: 1 }, ["major"])).toBeNull();
  });

  it("caps and clips the segments", () => {
    const streets = parseOverpass(walkStreetsAnswer(), ["major", "minor", "path"])!;
    const view = cameraFor(shape, here(0.5), END);
    const segments = prepareStreets(streets, mapProjector(view), MAP_W, MAP_H, 20);
    expect(segments).toHaveLength(20);
    expect(segments.every((s) => s.from.x >= 0 && s.to.x <= MAP_W && s.from.y >= 0 && s.to.y <= MAP_H)).toBe(true);
  });

  const okResponse = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) }) as unknown as Response;
  const box = legBox([START, END])!;

  it("tries the second endpoint when the first fails, and remembers the answer for the same area", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return url.startsWith("https://overpass-api.de") ? ({ ok: false, status: 429, headers: { get: () => null } } as unknown as Response) : okResponse(walkStreetsAnswer());
    }) as unknown as typeof fetch;
    const source = createStreetSource({ fetchImpl });
    const outcome = await source.load(box, ["major", "minor", "path"]);
    expect(outcome.error).toBeNull();
    expect(outcome.streets.length).toBeGreaterThan(10);
    expect(calls).toEqual(OVERPASS_URLS);
    await source.load(box, ["major"]);
    expect(calls).toHaveLength(2);
  });

  it("gives no streets, and no exception, when every endpoint fails", async () => {
    for (const fetchImpl of [
      (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch,
      (async () => ({ ok: false, status: 500, headers: { get: () => null } }) as unknown as Response) as typeof fetch,
      (async () => okResponse({ garbage: true })) as typeof fetch,
      (async () => okResponse({ elements: [], padding: "x".repeat(100) })) as typeof fetch,
    ]) {
      const outcome = await createStreetSource({ fetchImpl, maxChars: 50 }).load(box, ["major"]);
      expect(outcome.streets).toEqual([]);
      expect(outcome.error).not.toBeNull();
    }
  });

  it("asks the own server from the phone first, then the build's, then the public ones", () => {
    const user = "https://map.home.test/api/interpreter";
    const build = "https://map.build.test/api/interpreter";
    expect(overpassUrlsFor("https://map.home.test", "https://map.build.test/")).toEqual([user, build, ...PUBLIC_OVERPASS_URLS]);
    expect(overpassUrlsFor("", "https://map.build.test")).toEqual([build, ...PUBLIC_OVERPASS_URLS]);
    expect(overpassUrlsFor("https://map.home.test", "")).toEqual([user, ...PUBLIC_OVERPASS_URLS]);
    expect(overpassUrlsFor("", "")).toEqual([...PUBLIC_OVERPASS_URLS]);
    // The same server twice is asked once; junk is ignored.
    expect(overpassUrlsFor(build, "https://map.build.test")).toEqual([build, ...PUBLIC_OVERPASS_URLS]);
    expect(overpassUrlsFor("ftp://x", "map.build.test")).toEqual([...PUBLIC_OVERPASS_URLS]);
  });

  it("normalises an Overpass address to …/api/interpreter", () => {
    expect(normalizeOverpassUrl(" https://map.home.test/ ")).toBe("https://map.home.test/api/interpreter");
    expect(normalizeOverpassUrl("http://192.168.1.5:12345/api/interpreter")).toBe("http://192.168.1.5:12345/api/interpreter");
    expect(normalizeOverpassUrl("https://map.home.test/osm")).toBe("https://map.home.test/osm/api/interpreter");
    expect(normalizeOverpassUrl("map.home.test")).toBe("");
    expect(normalizeOverpassUrl("https://map.home.test/?data=x")).toBe("");
    expect(normalizeOverpassUrl(undefined)).toBe("");
  });

  it("picks up a changed server on the next load, without a new source", async () => {
    const calls: string[] = [];
    let own = "";
    const fetchImpl = (async (url: string) => { calls.push(url); return okResponse(walkStreetsAnswer()); }) as unknown as typeof fetch;
    const source = createStreetSource({ fetchImpl, urls: () => overpassUrlsFor(own, "") });
    await source.load(box, ["major"]);
    own = "https://map.home.test";
    const farAway = legBox([{ lat: 48.2, lon: 16.37 }, { lat: 48.201, lon: 16.371 }])!;
    await source.load(farAway, ["major"]);
    expect(calls).toEqual([PUBLIC_OVERPASS_URLS[0], "https://map.home.test/api/interpreter"]);
  });

  it("falls back to the public servers when the own one is offline, but stops when a public one is", async () => {
    const own = "https://map.home.test/api/interpreter";
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url === own) throw new TypeError("Failed to fetch");
      return okResponse(walkStreetsAnswer());
    }) as unknown as typeof fetch;
    const outcome = await createStreetSource({ fetchImpl, urls: () => overpassUrlsFor(own, "") }).load(box, ["major", "minor", "path"]);
    expect(outcome.error).toBeNull();
    expect(outcome.streets.length).toBeGreaterThan(10);
    expect(calls).toEqual([own, PUBLIC_OVERPASS_URLS[0]]);

    // Truly offline: the own server and the first public one fail, the second public one is not tried in vain.
    const offlineCalls: string[] = [];
    const offline = (async (url: string) => { offlineCalls.push(url); throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    const none = await createStreetSource({ fetchImpl: offline, urls: () => overpassUrlsFor(own, "") }).load(box, ["major"]);
    expect(none).toEqual({ streets: [], error: "offline" });
    expect(offlineCalls).toEqual([own, PUBLIC_OVERPASS_URLS[0]]);
  });

  it("gives up after the total time even when the request never answers or ignores the abort", async () => {
    const never = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const started = Date.now();
    const outcome = await createStreetSource({ fetchImpl: never, timeoutMs: 150, totalMs: 400 }).load(box, ["major"]);
    expect(outcome.error).toBe("timeout");
    expect(outcome.streets).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("drawing the map", () => {
  const user = here(0.35);
  const input = (streets: WalkMapInput["streets"], over: Partial<WalkMapInput> = {}): WalkMapInput => ({
    view: cameraFor(shape, user, END), shape, target: END, targetKind: "stop", streets, routeKey: "r", streetsKey: streets ? "s" : "none", ...over,
  });
  const levels = (frame: Frame): Set<number> => new Set(frame.pixels);
  const draw = (i: WalkMapInput): Frame => { const f = createFrame(MAP_W, MAP_H); drawWalkMap(f, i, backend); return f; };

  it("draws the route and the markers without streets (a failed load never blocks)", () => {
    const frame = draw(input(null));
    expect(levels(frame).has(MAP_LEVELS.route)).toBe(true);
    expect(levels(frame).has(MAP_LEVELS.major)).toBe(false);
    expect(levels(frame).has(MAP_LEVELS.minor)).toBe(false);
    expect(levels(draw(input([]))).has(MAP_LEVELS.minor)).toBe(false);
  });

  it("draws the streets in their dim levels, below the route", () => {
    const streets = parseOverpass(walkStreetsAnswer(), ["major", "minor", "path"])!;
    const frame = draw(input(streets));
    for (const level of [MAP_LEVELS.major, MAP_LEVELS.minor, MAP_LEVELS.path, MAP_LEVELS.route]) expect(levels(frame).has(level), String(level)).toBe(true);
    expect(frameKey(frame)).not.toBe(frameKey(draw(input(null))));
  });

  it("marks a stop and a destination differently, and a target beyond the picture at the edge", () => {
    const stop = draw(input(null, { view: cameraFor(shape, here(0.9), END) }));
    const goal = draw(input(null, { view: cameraFor(shape, here(0.9), END), targetKind: "goal" }));
    expect(frameKey(stop)).not.toBe(frameKey(goal));
    const edge = edgePoint({ x: 144, y: 178 }, { x: 144, y: -900 });
    expect(edge.y).toBeLessThanOrEqual(12.01);
    expect(scaleBar(150).metres).toBeGreaterThan(0);
  });
});

describe("street names", () => {
  it("are kept by the parser (name, else the first ref), never for footpaths", () => {
    const streets = parseOverpass(walkStreetsAnswer(), ["major", "minor", "path"])!;
    expect(streets.filter((s) => s.cls === "path").every((s) => s.name === undefined)).toBe(true);
    expect(streets.filter((s) => s.cls !== "path").map((s) => s.name)).toContain("Schwarzstraße");
    const ref = parseOverpass({ elements: [{ type: "way", tags: { ref: "B1;E55" }, geometry: [{ lat: 1, lon: 1 }, { lat: 1, lon: 2 }] }, { type: "count" }] }, ["major"])!;
    expect(ref[0]!.name).toBe("B1");
    expect(buildOverpassQuery(legBox([START, END])!, ["major", "path"])).toMatch(/out ids tags geom.*out ids geom/);
  });

  const streets = parseOverpass(walkStreetsAnswer(), ["major", "minor", "path"])!;
  const measure = (text: string): number => text.length * 7;
  const labels = (bearing: number | null, user = here(0.85), over: Partial<Parameters<typeof placeLabels>[0]> = {}) => {
    const view: MapView = { user, bearing, spanM: 320 };
    const rest = remainingRoute(shape, user);
    return placeLabels({
      width: MAP_W, height: MAP_H, toPixel: mapProjector(view), rest, turn: rest[Math.floor(rest.length / 2)]!,
      nextStreet: "Rainerstraße", currentStreet: "Sterneckstraße", streets, reserved: [], measure, ...over,
    });
  };

  it("puts the street of the turn and the street walked on first, then other streets, at most six", () => {
    const placed = labels(0);
    expect(placed[0]).toMatchObject({ text: "RAINERSTR.", rank: "next" });
    expect(placed[1]).toMatchObject({ text: "STERNECKSTR.", rank: "current" });
    expect(placed.length).toBeGreaterThan(2);
    expect(placed.length).toBeLessThanOrEqual(MAX_LABELS);
    expect(placed.slice(2).every((l) => l.rank === "other")).toBe(true);
    expect(labels(0, here(0.85), { nextStreet: undefined, currentStreet: undefined }).every((l) => l.rank === "other")).toBe(true);
  });

  it("never overlaps, leaves the reserved places free and stays inside the picture, at any heading (upright after rotation)", () => {
    const reserved = [{ x: 100, y: 150, w: 90, h: 60 }];
    for (const bearing of [null, 0, 45, 90, 180, 270]) {
      const placed = labels(bearing, here(0.85), { reserved });
      expect(placed.length, String(bearing)).toBeGreaterThan(0);
      placed.forEach((a, i) => {
        // A label is an upright plate whose size is that of its text, whatever the heading.
        expect(a.rect.h).toBe(LABEL_HEIGHT);
        expect(a.rect.w).toBe(measure(a.text) + 2 * LABEL_PAD_X);
        expect(a.rect.x).toBeGreaterThanOrEqual(0); expect(a.rect.x + a.rect.w).toBeLessThanOrEqual(MAP_W);
        expect(a.rect.y).toBeGreaterThanOrEqual(0); expect(a.rect.y + a.rect.h).toBeLessThanOrEqual(MAP_H);
        expect(overlaps(a.rect, reserved[0]!)).toBe(false);
        placed.slice(i + 1).forEach((b) => expect(overlaps(a.rect, b.rect), `${a.text} / ${b.text} at ${bearing}`).toBe(false));
      });
    }
  });

  it("shortens long names and is the same for the same scene", () => {
    expect(shortenName("Paris-Lodron-Straße")).toBe("Paris-Lodron-St.");
    expect(shortenName("Sterneckstraße")).toBe("Sterneckstr.");
    expect(shortenName("Schallmooser Hauptstraße").length).toBeLessThanOrEqual(LABEL_CHARS + 1);
    expect(labels(30)).toEqual(labels(30));
  });

  it("draws the names into the map (and the map without names differs)", () => {
    const user = here(0.4);
    const base: WalkMapInput = { view: cameraFor(shape, user, END), shape, target: END, targetKind: "stop", streets, routeKey: "r", streetsKey: "s" };
    const named = createFrame(MAP_W, MAP_H); drawWalkMap(named, { ...base, nextStreet: "Rainerstraße", currentStreet: "Sterneckstraße", turn: shape[Math.floor(shape.length / 2)]! }, backend);
    const plain = createFrame(MAP_W, MAP_H); drawWalkMap(plain, { ...base, streets: streets.map((s) => ({ cls: s.cls, points: s.points })) }, backend);
    expect(frameKey(named)).not.toBe(frameKey(plain));
  });
});

describe("the words of the walking page", () => {
  const T0 = new Date(2026, 9, 17, 14, 5);
  const journey = demoJourneys(recorded, new Date(T0), { name: "Heim", lat: 47.796, lon: 13.016 }, "de")[0]!;
  const bus = journey.legs[1] as TransitLeg;
  const base = journey.legs[0] as WalkLeg;
  const now = new Date(departureOf(bus).getTime() - 9 * 60000);
  const leg: WalkLeg = { ...base, toDestination: false, toName: "Salzburg Mirabellplatz (Bus)", toLat: END.lat, toLon: END.lon, fromLat: START.lat, fromLon: START.lon };
  const nav = walkNav(WALK_ROUTE, here(0.4));

  it("says the turn or the arrival with the distance, in capitals", () => {
    const left = { ...nav, toNext: 82, next: { ...nav.next, type: "left" as const, street: "Sterneckstraße" } };
    expect(walkHeadline(left, leg, "de")).toBe("LINKS · 80 M");
    expect(walkHeadline(left, leg, "en")).toBe("LEFT · 80 M");
    const arrive = { ...nav, toNext: 320, next: { type: "arrive" as const, length: 0, shapeIndex: 1 } };
    expect(walkHeadline(arrive, leg, "de")).toBe("HALTESTELLE · 320 M");
    expect(walkHeadline({ ...arrive, toNext: 120 }, { ...leg, toDestination: true }, "de")).toBe("ZIEL · 120 M");
    expect(walkDirection(left, leg, "de")).toBe("IN STERNECKSTRASSE");
    expect(walkDirection(left, leg, "en")).toBe("ONTO STERNECKSTRASSE");
    expect(walkDirection(arrive, leg, "de")).toBe("SALZBURG MIRABELLPLATZ");
    // No street on the turn: the street walked on, then the place.
    const bare = { ...left, next: { ...left.next, street: undefined as unknown as string }, current: "Linzer Gasse" };
    expect(walkDirection(bare, leg, "de")).toBe("LINZER GASSE");
    expect(walkDirection({ ...bare, current: undefined as unknown as string }, leg, "de")).toBe("SALZBURG MIRABELLPLATZ");
  });

  it("counts the buffer from the departure, the clock and the walk left, and frames it under 2 minutes", () => {
    expect(bufferMinutes(new Date(now.getTime() + 9 * 60000), now, 320)).toBe(5);
    const cells = walkCells({ ...nav, remaining: 320 }, leg, bus, undefined, now, "de");
    expect(cells.map((c) => c.label)).toEqual(["WEG", "ABFAHRT", "PUFFER", "LINIE", "STEIG", "HALT"]);
    expect(cells[0]!.value).toBe("320 M");
    expect(cells[2]!.value).toBe("5 MIN");
    expect(cells[2]!.alert).toBeUndefined();
    const tight = walkCells({ ...nav, remaining: 700 }, leg, bus, undefined, now, "de");
    expect(tight[2]!.value).toBe("0 MIN");
    expect(tight[2]!.alert).toBe(true);
  });

  it("a walk to the destination shows the way, the arrival and the time instead", () => {
    const cells = walkCells({ ...nav, remaining: 240 }, { ...leg, toDestination: true }, undefined, new Date(2026, 9, 17, 15, 2), now, "de");
    expect(cells.map((c) => [c.label, c.value])).toEqual([["WEG", "240 M"], ["ANKUNFT", "15:02"], ["ZEIT", "3 MIN"], ["ZIEL", "SALZBURG MIRABELLPLATZ (BUS)"]]);
  });

  const hint = ft("de", "exit", { tap: "next" }, "1/5 · GPS");
  const mapFor = (user: LatLon, over: Partial<WalkMapInput> = {}): WalkMapInput => ({
    view: cameraFor(shape, user, END), shape, target: END, targetKind: "stop",
    streets: parseOverpass(walkStreetsAnswer(), ["major", "minor", "path"]), routeKey: "r", streetsKey: "s", ...over,
  });
  const modelAt = (when: Date, remaining = 320) =>
    walkModel({ nav: { ...nav, remaining, toNext: remaining }, leg, next: bus, arrival: undefined, now: when, locale: "de", hint });

  it("sends nothing when nothing changed, nothing of the map for a small move, and only the top right for the clock", () => {
    const user = here(0.4);
    const first = composeWalkTiles(modelAt(now), mapFor(user), backend);
    expect(composeWalkTiles(modelAt(now), mapFor(user), backend).keys).toEqual(first.keys);

    // A small move settles on the same view, so the map is the very same picture.
    const settled = settleView(settleView(null, cameraFor(shape, user, END), 0), cameraFor(shape, metresNorth(user, 4), END), 10_000);
    const small = composeWalkTiles(modelAt(now), mapFor(user, { view: settled.view }), backend);
    expect(small.keys).toEqual(first.keys);

    // Another minute with the same words: only the clock changes - the tile at the top right.
    const clock = composeWalkTiles({ ...modelAt(now), clock: "14:06" }, mapFor(user), backend);
    const changed = clock.keys.map((key, index) => (key !== first.keys[index] ? index : -1)).filter((i) => i >= 0);
    expect(changed).toEqual([1]);

    // A real move redraws the left tiles.
    const far = composeWalkTiles(modelAt(now), mapFor(here(0.5)), backend);
    expect(far.keys[0] !== first.keys[0] || far.keys[2] !== first.keys[2]).toBe(true);
  });

  const env = (globalThis as unknown as { process: { env: Record<string, string | undefined>; cwd(): string } }).process;

  it.skipIf(env.env["QG_PREVIEW"] === undefined)("writes store/preview-walk.png and store/preview-walk-transfer.png", async () => {
    const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as unknown as { writeFileSync(path: string, data: Uint8Array): void };
    const draw = async (file: string, model: ReturnType<typeof modelAt>, map: WalkMapInput): Promise<void> => {
      const frame = createFrame();
      const parts = composeWalkTiles(model, map, backend).tiles;
      parts.forEach((tile, index) => {
        for (let y = 0; y < 144; y += 1) for (let x = 0; x < 288; x += 1) {
          frame.pixels[((index >> 1) * 144 + y) * 576 + (index & 1) * 288 + x] = tile.pixels[y * 288 + x]!;
        }
      });
      fs.writeFileSync(`${env.cwd()}/store/${file}`, await greenPng(frame));
    };
    const user = here(0.4);
    const turnIndex = Math.floor(shape.length * 0.55);
    const navHere = { ...walkNav(WALK_ROUTE, user), toNext: 120, current: "Sterneckstraße", next: { type: "left" as const, street: "Rainerstraße", length: 200, shapeIndex: turnIndex } };
    await draw("preview-walk.png", walkModel({ nav: navHere, leg, next: bus, arrival: undefined, now, locale: "de", hint }),
      mapFor(user, { turn: shape[turnIndex]!, nextStreet: "Rainerstraße", currentStreet: "Sterneckstraße" }));
    // The transfer: the way back along the same streets, the connection about to leave (buffer under two minutes).
    const back = { ...WALK_ROUTE, shape: [...shape].reverse() };
    const backNav0 = walkNav({ ...back, along: back.shape.map((_, i) => WALK_ROUTE.along[WALK_ROUTE.along.length - 1]! - WALK_ROUTE.along[back.shape.length - 1 - i]!) }, shape[Math.floor(shape.length * 0.6)]!);
    const backUser = shape[Math.floor(shape.length * 0.6)]!;
    const backTurn = back.shape[Math.floor(back.shape.length * 0.75)]!;
    const backNav = { ...backNav0, current: "Rainerstraße", next: { type: "slightRight" as const, street: "Linzer Gasse", length: 150, shapeIndex: Math.floor(back.shape.length * 0.75) } };
    const transferLeg: WalkLeg = { ...leg, fromLat: END.lat, fromLon: END.lon, toLat: START.lat, toLon: START.lon, toName: "Salzburg Vogelweiderstraße" };
    const soon = new Date(departureOf(bus).getTime() - 5 * 60000);
    await draw("preview-walk-transfer.png",
      walkModel({ nav: { ...backNav, remaining: 330 }, leg: transferLeg, next: bus, arrival: undefined, now: soon, locale: "de", hint: ft("de", "exit", { tap: "next" }, "3/5 · GPS") }),
      { view: cameraFor(back.shape, backUser, START), shape: back.shape, target: START, targetKind: "stop", turn: backTurn, nextStreet: "Linzer Gasse", currentStreet: "Rainerstraße", streets: parseOverpass(walkStreetsAnswer(), ["major", "minor", "path"]), routeKey: "b", streetsKey: "s" });
  });
});

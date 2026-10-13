import { describe, expect, it } from "vitest";
import { drawMap } from "../src/overview/draw";
import { mapProjector, MARKER_AT, MAP_HEIGHT, MAP_WIDTH, PLATE, rangeFor, courseAhead } from "../src/overview/camera";
import { LABEL_HEIGHT, LABEL_MAX_CHARS, labelText, placeLabels, reservedRects, shortenName, textWidth, type Rect } from "../src/overview/labels";
import { parseOverpass, nameOf, buildOverpassQuery, type Street } from "../src/overview/streets";
import { demoStreets } from "../src/overview/demo";
import { createMockProvider } from "../src/routing/provider";
import { buildView } from "../src/glasses/view";
import { progressOf, startNavigation, update } from "../src/nav/navigator";
import { encodePng } from "../src/glasses/png";
import type { LatLng } from "../src/geo/geometry";
import { createRaster } from "./support/raster";

import FIXTURE from "./fixtures/overpass-salzburg.json";

describe("shortening street names", () => {
  it("turns Straße into Str. and leaves short names alone", () => {
    expect(shortenName("Imbergstraße")).toBe("Imbergstr.");
    expect(shortenName("Linzer Gasse")).toBe("Linzer Gasse");
    expect(shortenName("Hauptstrasse")).toBe("Hauptstr.");
    expect(shortenName("Strasse")).toBe("Str.");
  });
  it("never exceeds the limit, cutting with a dot as the last resort", () => {
    for (const name of ["Friedrich-Gehmacher-Straße", "Straße zu Johannesschlössl", "Müllner Hauptstraße", "Bundesstraße Nord", "Sankt-Julien-Straße", "A".repeat(60)]) {
      expect(labelText(shortenName(name)).length).toBeLessThanOrEqual(LABEL_MAX_CHARS);
    }
    expect(shortenName("Straße zu Johannesschlössl")).toMatch(/\.$/);
    expect(shortenName("Müllner Hauptstraße")).toBe("Müllner Hauptst.");
  });
  it("counts ß as two letters since it is written SS", () => {
    expect(labelText("Maßweg")).toBe("MASSWEG");
    expect(labelText(shortenName("Maßmannstraße-Ost-Weg")).length).toBeLessThanOrEqual(LABEL_MAX_CHARS);
  });
});

describe("reading street names from Overpass", () => {
  it("takes name, else the first ref, from the shortened real answer", () => {
    const streets = parseOverpass(FIXTURE, ["major", "minor"])!;
    expect(streets).not.toBeNull();
    const names = streets.map((s) => s.name);
    expect(names).toContain("Schwarzstraße");
    expect(names).toContain("Getreidegasse");
    expect(streets.some((s) => s.cls === "major" && s.name === "B1")).toBe(true);
    expect(streets.filter((s) => s.cls === "minor" && !s.name)).toHaveLength(1);
    expect(streets.filter((s) => s.cls === "major").length).toBeGreaterThanOrEqual(6);
    expect(streets.filter((s) => s.cls === "minor").length).toBeGreaterThanOrEqual(6);
  });
  it("keeps the old behaviour for answers without tags, and picks the first of several refs", () => {
    const plain = parseOverpass({ elements: [{ type: "way", geometry: [{ lat: 1, lon: 1 }, { lat: 1, lon: 2 }] }, { type: "count" }] }, ["major"])!;
    expect(plain).toHaveLength(1);
    expect(plain[0]).not.toHaveProperty("name");
    expect(nameOf({ ref: "A1;E 60" })).toBe("A1");
    expect(nameOf({ name: " Hauptstraße ", ref: "B1" })).toBe("Hauptstraße");
    expect(nameOf(undefined)).toBeUndefined();
  });
  it("asks for the tags of roads", () => {
    expect(buildOverpassQuery({ south: 47.8, west: 13.03, north: 47.81, east: 13.05 }, ["major"])).toContain("out ids tags geom");
  });
});

const CENTER: LatLng = { lat: 47.8, lon: 13.04 };
const offset = (north: number, east: number): LatLng => ({
  lat: CENTER.lat + north / 110_540,
  lon: CENTER.lon + east / (111_320 * Math.cos((CENTER.lat * Math.PI) / 180)),
});
/** North for 600 m, then east. The car is at the start; the turn is at index 3. */
const ROUTE: LatLng[] = [offset(0, 0), offset(200, 0), offset(400, 0), offset(600, 0), offset(600, 200), offset(600, 400), offset(600, 600)];
const line = (name: string, cls: "major" | "minor" | "path", pts: Array<[number, number]>): Street => ({ cls, name, points: pts.map(([n, e]) => offset(n, e)) });
const STREETS: Street[] = [
  line("Hauptstraße", "major", [[-100, -300], [300, -300], [700, -300]]),
  line("Getreidegasse", "minor", [[250, -500], [250, 400]]),
  line("Imbergstraße", "major", [[100, 200], [500, 250], [900, 280]]),
  line("Museumsplatz", "minor", [[450, -400], [450, 300]]),
  line("Kai", "minor", [[700, -450], [700, 450]]),
];

const viewAt = (position: LatLng, bearing: number | null) => ({ center: position, bearing, range: rangeFor(500) });
const sceneFor = (position: LatLng, bearing: number | null) => ({
  route: ROUTE, next: ROUTE[3]!, nextIndex: 3, streets: STREETS, nextStreet: "Linzer Gasse", currentStreet: "Rainerstraße", view: viewAt(position, bearing),
});
const inputFor = (position: LatLng, bearing: number | null, streets: readonly Street[] = STREETS) => ({
  width: MAP_WIDTH, height: MAP_HEIGHT, toPixel: mapProjector(viewAt(position, bearing)), route: ROUTE, nextIndex: 3 as number | null,
  nextStreet: "Linzer Gasse" as string | undefined, currentStreet: "Rainerstraße" as string | undefined, streets,
});
const apart = (a: Rect, b: Rect): boolean => a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;

describe("placing labels", () => {
  const labels = placeLabels(inputFor(ROUTE[0]!, 0));

  it("puts the street of the turn first, then the current one, then at most three others", () => {
    expect(labels[0]).toMatchObject({ text: "LINZER GASSE", rank: "next" });
    expect(labels[1]).toMatchObject({ text: "RAINERSTR.", rank: "current" });
    const others = labels.filter((l) => l.rank === "other");
    expect(others.length).toBeGreaterThan(0);
    expect(others.length).toBeLessThanOrEqual(3);
    expect(new Set(labels.map((l) => l.text)).size).toBe(labels.length);
  });
  it("makes every label a 26 px box around 14 px type, inside the picture", () => {
    for (const label of labels) {
      expect(label.rect.h).toBe(LABEL_HEIGHT);
      expect(label.rect.w).toBe(textWidth(label.text) + 12);
      expect(label.rect.x).toBeGreaterThanOrEqual(0);
      expect(label.rect.y).toBeGreaterThanOrEqual(0);
      expect(label.rect.x + label.rect.w).toBeLessThanOrEqual(MAP_WIDTH);
      expect(label.rect.y + label.rect.h).toBeLessThanOrEqual(MAP_HEIGHT);
      expect(label.text.length).toBeLessThanOrEqual(LABEL_MAX_CHARS);
    }
  });
  it("never overlaps another label, the car, the turn ring, the compass or the text plate", () => {
    const toPixel = mapProjector(viewAt(ROUTE[0]!, 0));
    const reserved = reservedRects(MAP_WIDTH, toPixel(ROUTE[3]!), toPixel(ROUTE[ROUTE.length - 1]!));
    for (const [i, a] of labels.entries()) {
      for (const b of labels.slice(i + 1)) expect(apart(a.rect, b.rect)).toBe(true);
      for (const r of reserved) expect(apart(a.rect, r)).toBe(true);
      expect(apart(a.rect, { x: MARKER_AT.x - 27, y: MARKER_AT.y - 36, w: 54, h: 60 })).toBe(true);
      expect(apart(a.rect, { x: 0, y: 0, w: PLATE.width, h: PLATE.height })).toBe(true);
    }
  });
  it("is deterministic and keeps labels horizontal whatever way the map is turned", () => {
    expect(placeLabels(inputFor(ROUTE[0]!, 0))).toEqual(labels);
    for (const bearing of [null, 45, 123, 270]) {
      const turned = placeLabels(inputFor(ROUTE[0]!, bearing));
      expect(turned.find((l) => l.rank === "next")).toBeDefined();
      for (const l of turned) expect(l.rect.h).toBe(LABEL_HEIGHT);
    }
  });
  it("skips names the font cannot write, and does not label footpaths or unnamed ways", () => {
    const odd: Street[] = [
      line("Невский проспект", "major", [[300, -300], [300, 300]]),
      { cls: "major", points: [offset(350, -300), offset(350, 300)] },
      line("Waldweg", "path", [[400, -300], [400, 300]]),
    ];
    expect(placeLabels({ ...inputFor(ROUTE[0]!, 0, odd), nextStreet: undefined, currentStreet: undefined })).toEqual([]);
  });
  it("labels nothing without a route, and shows the current street only if it differs from the next", () => {
    expect(placeLabels({ ...inputFor(ROUTE[0]!, 0), route: [], nextIndex: null })).toEqual([]);
    const same = placeLabels({ ...inputFor(ROUTE[0]!, 0), currentStreet: "linzer gasse" });
    expect(same.filter((l) => l.text === "LINZER GASSE")).toHaveLength(1);
  });
  it("finds room for the turn street when the turn is right at the car", () => {
    expect(placeLabels(inputFor(ROUTE[2]!, 0)).some((l) => l.rank === "next")).toBe(true);
  });
});

describe("drawing labels", () => {
  it("draws white type on a black box with a 1 px border, and umlauts with dots", () => {
    const raster = createRaster(MAP_WIDTH, MAP_HEIGHT);
    drawMap(raster.ctx, { ...sceneFor(ROUTE[0]!, 0), nextStreet: "Ünter Gasse" });
    const label = placeLabels({ ...inputFor(ROUTE[0]!, 0), nextStreet: "Ünter Gasse" }).find((l) => l.rank === "next")!;
    const px = (x: number, y: number): number => raster.pixels[y * MAP_WIDTH + x]!;
    const { x, y, w, h } = label.rect;
    expect(px(x, y + 10)).toBeGreaterThan(200);
    expect(px(x + w - 1, y + 10)).toBeGreaterThan(200);
    expect(px(x + 2, y + 10)).toBe(0);
    let lit = 0;
    for (let yy = y + 1; yy < y + h - 1; yy++) for (let xx = x + 2; xx < x + w - 2; xx++) if (px(xx, yy) > 200) lit++;
    expect(lit).toBeGreaterThan(150);
    // The dots of Ü sit above the capitals (box top + 8), inside the first letter's width.
    let dots = 0;
    for (let xx = x + 6; xx < x + 6 + 11; xx++) for (let yy = y + 4; yy < y + 6; yy++) if (px(xx, yy) > 200) dots++;
    expect(dots).toBeGreaterThan(0);
  });
});

describe("text line over the map", () => {
  const progress = (street: string | undefined, meters = 300) => ({
    maneuver: { type: "right" as const, instruction: "Turn right", ...(street ? { street } : {}), length: 400, time: 60, shapeIndex: 3 },
    distanceToManeuver: meters, distanceRemaining: 2000, secondsRemaining: 300, offRoute: false, arrived: false,
  });
  const opts = { mode: "driving" as const, navigating: true, rerouting: false, error: null, mock: false, waitingForFix: false, layout: "overview" as const, locale: "de" as const };
  it("adds the street of the next turn when there is room", () => {
    expect(buildView(progress("Linzer Gasse"), opts).body).toEqual(["→ 300 m · Linzer Gasse"]);
  });
  it("shortens the street to the room that is left, or leaves it out", () => {
    const long = buildView(progress("Friedrich-Gehmacher-Straße", 1200), opts).body[0]!;
    expect(long.length).toBeLessThanOrEqual(22);
    expect(long).toContain(" · ");
    expect(buildView(progress(undefined), opts).body[0]).toMatch(/^→ +300 m$/);
  });
});

describe("the demo scene", () => {
  it("gives the mock route street names and named streets around it, and renders the labelled map", async () => {
    const outcome = await createMockProvider().route({ from: { lat: 47.805, lon: 13.042 }, to: { lat: 47.815, lon: 13.048 }, mode: "driving" });
    const route = outcome.route!;
    expect(route.maneuvers.map((m) => m.street).filter(Boolean)).toEqual(["Rainerstraße", "Linzer Gasse", "Hellbrunner Allee"]);
    const streets = demoStreets(route.shape, route.maneuvers.filter((m) => m.street).map((m) => ({ from: m.shapeIndex, name: m.street as string })));
    expect(streets.filter((s) => s.name).length).toBeGreaterThanOrEqual(8);
    expect(demoStreets([], [])).toEqual([]);

    const nav = update(startNavigation(route), route.shape[11]!);
    const progress = progressOf(nav);
    const center = nav.position!;
    const view = { center, bearing: courseAhead(route.shape, center), range: rangeFor(progress.distanceToManeuver) };
    const scene = {
      route: route.shape, next: route.shape[progress.maneuver!.shapeIndex]!, nextIndex: progress.maneuver!.shapeIndex, streets,
      nextStreet: progress.maneuver!.street, currentStreet: route.maneuvers[nav.maneuverIndex]!.street, view,
    };
    const placed = placeLabels({
      width: MAP_WIDTH, height: MAP_HEIGHT, toPixel: mapProjector(view), route: route.shape, nextIndex: scene.nextIndex,
      nextStreet: scene.nextStreet, currentStreet: scene.currentStreet, streets,
    });
    expect(placed.map((l) => l.rank).slice(0, 2)).toEqual(["next", "current"]);
    const raster = createRaster(MAP_WIDTH, MAP_HEIGHT);
    drawMap(raster.ctx, scene);
    const target = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.OGN_PREVIEW;
    if (target) {
      const fs = await import(/* @vite-ignore */ ["node", "fs"].join(":")) as { writeFileSync(path: string, data: Uint8Array): void };
      fs.writeFileSync(target, await encodePng(MAP_WIDTH, MAP_HEIGHT, raster.pixels));
    }
  });
});

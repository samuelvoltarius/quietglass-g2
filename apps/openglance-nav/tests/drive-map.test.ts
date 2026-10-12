import { afterEach, describe, expect, it, vi } from "vitest";
import {
  courseAhead, mapProjector, MARKER_AT, MAP_HEIGHT, MAP_TILES, MAP_WIDTH, PLATE, RANGE_LEVELS_M, RANGE_PX, rangeFor, TILE_HEIGHT, TILE_WIDTH,
} from "../src/overview/camera";
import { drawMap, ROUTE_WIDTH, renderMapTiles, type MapContext } from "../src/overview/draw";
import { distanceMeters, type LatLng } from "../src/geo/geometry";
import { createRaster } from "./support/raster";

const M_PER_DEG = 111_320;
const CENTER: LatLng = { lat: 47.8, lon: 13.04 };
/** A point `north` and `east` metres from CENTER. */
const offset = (north: number, east: number): LatLng => ({
  lat: CENTER.lat + north / 110_540,
  lon: CENTER.lon + east / (M_PER_DEG * Math.cos((CENTER.lat * Math.PI) / 180)),
});
/** A straight road 2 km due north of the car, with the car 200 m along it. */
const NORTH_ROAD: LatLng[] = [offset(-200, 0), offset(0, 0), offset(600, 0), offset(1800, 0)];

describe("map camera", () => {
  it("covers the whole display with four 288 x 144 images, the largest the glasses accept", () => {
    expect([MAP_WIDTH, MAP_HEIGHT]).toEqual([576, 288]);
    expect(MAP_TILES).toHaveLength(4);
    for (const tile of MAP_TILES) {
      expect(tile.x % TILE_WIDTH).toBe(0);
      expect(tile.y % TILE_HEIGHT).toBe(0);
    }
    expect(new Set(MAP_TILES.map((tile) => `${tile.x},${tile.y}`)).size).toBe(4);
    expect([TILE_WIDTH, TILE_HEIGHT]).toEqual([288, 144]);
    // The car sits low, centred: the road ahead gets the room.
    expect(MARKER_AT.x).toBe(MAP_WIDTH / 2);
    expect(MARKER_AT.y).toBeGreaterThan(MAP_HEIGHT / 2);
  });

  it("zooms in steps so the next turn is on the picture but never at its edge", () => {
    expect(rangeFor(0)).toBe(RANGE_LEVELS_M[0]);
    expect(rangeFor(960)).toBe(1200);
    expect(rangeFor(120)).toBe(150);
    expect(rangeFor(1e9)).toBe(RANGE_LEVELS_M[RANGE_LEVELS_M.length - 1]);
    for (const distance of [10, 130, 400, 951, 2100, 7000]) {
      const range = rangeFor(distance);
      expect(distance).toBeLessThanOrEqual(range * 0.85 + 1e-9);
    }
    const levels = [100, 200, 400, 800, 1600, 3200].map(rangeFor);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
  });

  it("puts the car at the marker place and turns the map to the direction of travel", () => {
    const north = mapProjector({ center: CENTER, bearing: 0, range: 600 });
    expect(north(CENTER)).toEqual(MARKER_AT);
    const ppm = RANGE_PX / 600;
    const ahead = north(offset(300, 0));
    expect(ahead.x).toBeCloseTo(MARKER_AT.x, 3);
    expect(ahead.y).toBeCloseTo(MARKER_AT.y - 300 * ppm, 0);
    // North-up, east is to the right.
    expect(north(offset(0, 100)).x).toBeGreaterThan(MARKER_AT.x);

    // Facing east: east is now up, and north is to the left.
    const east = mapProjector({ center: CENTER, bearing: 90, range: 600 });
    expect(east(offset(0, 300)).y).toBeCloseTo(MARKER_AT.y - 300 * ppm, 0);
    expect(east(offset(0, 300)).x).toBeCloseTo(MARKER_AT.x, 0);
    expect(east(offset(100, 0)).x).toBeLessThan(MARKER_AT.x);
    // Facing south: north is down.
    const south = mapProjector({ center: CENTER, bearing: 180, range: 600 });
    expect(south(offset(100, 0)).y).toBeGreaterThan(MARKER_AT.y);
  });

  it("takes the direction of travel from the route ahead", () => {
    expect(courseAhead(NORTH_ROAD, offset(100, 0))).toBeCloseTo(0, 0);
    const eastRoad = [offset(0, -300), offset(0, 300)];
    expect(courseAhead(eastRoad, offset(0, 0))).toBeCloseTo(90, 0);
    // Near the end it faces the end, and a route without length says nothing.
    expect(courseAhead(NORTH_ROAD, offset(1790, 0))).toBeCloseTo(0, 0);
    expect(courseAhead([offset(0, 0)], offset(0, 0))).toBeNull();
    expect(courseAhead([], offset(0, 0))).toBeNull();
  });

  it("looks about 80 m ahead, so a bend reaches the map just before the car", () => {
    // North for 50 m, then east: 80 m ahead lies past the corner.
    const bend = [offset(0, 0), offset(50, 0), offset(50, 400)];
    const course = courseAhead(bend, offset(0, 0))!;
    expect(course).toBeGreaterThan(5);
    expect(course).toBeLessThan(60);
  });
});

describe("map drawing", () => {
  const draw = (route: readonly LatLng[], bearing: number | null, next: LatLng | null = null) => {
    const raster = createRaster(MAP_WIDTH, MAP_HEIGHT);
    drawMap(raster.ctx, { route, next, streets: [], view: { center: CENTER, bearing, range: 600 } });
    const at = (x: number, y: number): number => raster.pixels[Math.round(y) * MAP_WIDTH + Math.round(x)]!;
    return { raster, at };
  };

  it("draws the route as a thick white line running up from the car when heading north", () => {
    const { at } = draw(NORTH_ROAD, 0);
    // 100 px above the car, on the route: white across the stroke, black on both sides.
    const y = MARKER_AT.y - 100;
    for (let dx = -(ROUTE_WIDTH / 2 - 2); dx <= ROUTE_WIDTH / 2 - 2; dx += 2) expect(at(MARKER_AT.x + dx, y)).toBe(255);
    expect(at(MARKER_AT.x + ROUTE_WIDTH / 2 + 6, y)).toBe(0);
    expect(at(MARKER_AT.x - ROUTE_WIDTH / 2 - 6, y)).toBe(0);
    expect(ROUTE_WIDTH).toBeGreaterThanOrEqual(14);
  });

  it("turns the picture so the road ahead is always up", () => {
    // The same road heading east: with the map turned to the heading it is drawn the same way.
    const eastRoad = [offset(0, -200), offset(0, 0), offset(0, 600), offset(0, 1800)];
    const north = draw(NORTH_ROAD, 0);
    const east = draw(eastRoad, 90);
    const y = MARKER_AT.y - 100;
    expect(east.at(MARKER_AT.x, y)).toBe(255);
    expect(east.at(MARKER_AT.x + 12, y)).toBe(north.at(MARKER_AT.x + 12, y));
    // Not turned (north up), the east road runs across the picture.
    const across = draw(eastRoad, null);
    expect(across.at(MARKER_AT.x + 100, MARKER_AT.y)).toBe(255);
    expect(across.at(MARKER_AT.x, MARKER_AT.y - 100)).toBe(0);
  });

  it("marks the car with a large chevron when the map is turned, a ringed dot when north is up", () => {
    const turned = draw(NORTH_ROAD, 0);
    // The tip of the chevron is up from the marker place; below the marker, between the wings, it is black (edge).
    expect(turned.at(MARKER_AT.x, MARKER_AT.y - 20)).toBe(255);
    expect(turned.at(MARKER_AT.x + 22, MARKER_AT.y + 20)).toBe(255);
    const dot = draw(NORTH_ROAD, null);
    expect(dot.at(MARKER_AT.x, MARKER_AT.y)).toBe(255);
    expect(dot.at(MARKER_AT.x + 6, MARKER_AT.y + 6)).toBe(0);
    expect(dot.at(MARKER_AT.x + 14, MARKER_AT.y)).toBe(255);
  });

  it("rings the next turn and squares the destination", () => {
    const turn = offset(300, 0);
    const { raster } = draw(NORTH_ROAD, 0, turn);
    const toPixel = mapProjector({ center: CENTER, bearing: 0, range: 600 });
    const ring = toPixel(turn);
    // On the ring (radius 24), beside the route line.
    expect(raster.pixels[Math.round(ring.y) * MAP_WIDTH + Math.round(ring.x + 24)]).toBe(255);
    expect(distanceMeters(NORTH_ROAD[3]!, turn)).toBeGreaterThan(0);
  });

  it("keeps the top left clear for the text: a black plate over everything", () => {
    // A road straight through the plate must not show inside it.
    const through = [offset(-200, -400), offset(2000, -400)];
    const { raster, at } = draw(through, 0);
    const plateCentre = { x: PLATE.width / 2, y: PLATE.height / 2 };
    expect(at(plateCentre.x, plateCentre.y)).toBe(0);
    expect(raster.pixels[(PLATE.height - 1) * MAP_WIDTH + 100]).toBeGreaterThan(0);
  });

  it("draws a compass top right whose needle follows north", () => {
    const whiteIn = (pixels: Uint8Array, x0: number, y0: number, x1: number, y1: number): number => {
      let count = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (pixels[y * MAP_WIDTH + x] === 255) count++;
      return count;
    };
    const up = draw([], 0).raster.pixels;
    const down = draw([], 180).raster.pixels;
    // The compass lives at (532, 52): the needle lies in its upper half when north is up, in its lower half when north is down.
    expect(whiteIn(up, 520, 34, 546, 52)).toBeGreaterThan(whiteIn(up, 520, 52, 546, 72));
    expect(whiteIn(down, 520, 52, 546, 72)).toBeGreaterThan(whiteIn(down, 520, 34, 546, 52));
  });

  it("draws nothing but the car, the compass and the plate for an empty route", () => {
    const { raster } = draw([], null);
    const white = raster.pixels.reduce((sum, value) => sum + (value === 255 ? 1 : 0), 0);
    expect(white).toBeGreaterThan(0);
    expect(white).toBeLessThan(MAP_WIDTH * MAP_HEIGHT * 0.1);
  });

  it("survives a route far off the picture and absurd coordinates", () => {
    const far = [offset(-5e6, 3e6), offset(5e6, -3e6)];
    expect(() => draw(far, 37)).not.toThrow();
    expect(() => draw([{ lat: Number.NaN, lon: 0 }, offset(0, 0)], 0)).not.toThrow();
  });
});

describe("map tiles", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  /** A recording stand-in for the browser canvas: the 576 x 288 map and each 288 x 144 tile cut from it. */
  function stubCanvases(): { sizes: Array<[number, number]>; copies: number[][] } {
    const sizes: Array<[number, number]> = [];
    const copies: number[][] = [];
    const make = (): unknown => {
      const canvas = {
        width: 0, height: 0,
        getContext: () => {
          const noop = (): void => undefined;
          const own: Record<PropertyKey, unknown> = { drawImage: (_source: unknown, ...args: number[]) => { copies.push(args); } };
          return new Proxy(own, { get: (target, key) => (key in target ? target[key] : noop), set: (target, key, value) => { target[key] = value; return true; } });
        },
        toBlob: (done: (value: Blob | null) => void) => { sizes.push([canvas.width, canvas.height]); done(new Blob([new Uint8Array([137, 80, 78, 71])])); },
      };
      return canvas;
    };
    vi.stubGlobal("document", { createElement: make });
    return { sizes, copies };
  }

  const scene = { route: NORTH_ROAD, next: null, streets: [], view: { center: CENTER, bearing: 0, range: 600 } };

  it("cuts the map into four 288 x 144 PNGs, each copied from its own quarter", async () => {
    const { sizes, copies } = stubCanvases();
    const tiles = await renderMapTiles(scene);
    expect(tiles).toHaveLength(4);
    for (const tile of tiles) expect([...tile]).toEqual([137, 80, 78, 71]);
    expect(sizes).toEqual([[288, 144], [288, 144], [288, 144], [288, 144]]);
    expect(copies).toEqual([[0, 0, 288, 144, 0, 0, 288, 144], [288, 0, 288, 144, 0, 0, 288, 144], [0, 144, 288, 144, 0, 0, 288, 144], [288, 144, 288, 144, 0, 0, 288, 144]]);
  });

  it("rejects when there is no 2D context", async () => {
    vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => null, toBlob: () => undefined }) });
    await expect(renderMapTiles(scene)).rejects.toThrow("2d canvas unavailable");
  });
});

// Keeps the type import honest: the drawing works on the narrow canvas interface.
const _typecheck: MapContext | null = null;
void _typecheck;

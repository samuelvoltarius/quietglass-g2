import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pixel } from "../src/glasses/bitmap";
import { CUT_LEVEL, LEVEL, MAX_LABELS, TRANSPARENT, allPlaces, baseMapFor, drawBaseMap, mapName, nearestPlace } from "../src/radar/basemap";
import { ANCHOR, MAP, composeFrame, neededTiles, rainLevel, splitTiles } from "../src/radar/frame";
import { labelText, labelWidth } from "../src/radar/label-font";
import { decodeTileInBrowser, syntheticRadar } from "../src/radar/load";
import { createRadarSession, LOAD_TIMEOUT_MS, STEP_MS } from "../src/radar/session";
import { RADAR_ZOOM, TILE_SIZE } from "../src/radar/tiles";
import { BORDERS, COAST, LAKES, PLACES, RIVERS } from "../src/radar/map-data";

const SALZBURG = { latitude: 47.8095, longitude: 13.055 };
const ZURICH = { latitude: 47.37, longitude: 8.54 };

describe("embedded map data", () => {
  it("stays small enough for the radar chunk", () => {
    const bytes = [BORDERS, COAST, LAKES, RIVERS, PLACES].reduce((sum, part) => sum + new TextEncoder().encode(part).length, 0);
    expect(bytes).toBeLessThan(150 * 1024);
  });

  it("knows the towns around Salzburg, in German and English", () => {
    const munich = allPlaces().find((place) => place.en === "Munich");
    expect(munich?.de).toBe("München");
    expect(allPlaces().some((place) => place.de === "Salzburg")).toBe(true);
    // Most populous first.
    const populations = allPlaces().map((place) => place.population);
    expect(populations.every((value, index) => index === 0 || value <= populations[index - 1]!)).toBe(true);
  });
});

describe("label font", () => {
  it("writes capitals, keeps umlauts and drops other accents", () => {
    expect(labelText("Zürich")).toBe("ZÜRICH");
    expect(labelText("Kraków")).toBe("KRAKOW");
    expect(labelText("Łódź")).toBe("LODZ");
    expect(labelText("Straßburg")).toBe("STRASSBURG");
    expect(labelText("Besançon")).toBe("BESANCON");
    expect(labelText("Москва")).toBeNull();
  });

  it("is proportional: an I is narrower than an M", () => {
    expect(labelWidth("I")).toBeLessThan(labelWidth("M"));
    expect(labelWidth("")).toBe(0);
  });

  it("prefers the short name when the German one is long", () => {
    const fribourg = { de: "Freiburg im Üechtland", en: "Fribourg", x: 0, y: 0, population: 1 };
    expect(mapName(fribourg, "de")).toBe("FRIBOURG");
    expect(mapName({ de: "München", en: "Munich", x: 0, y: 0, population: 1 }, "de")).toBe("MÜNCHEN");
    expect(mapName({ de: "München", en: "Munich", x: 0, y: 0, population: 1 }, "en")).toBe("MUNICH");
  });
});

describe("base map", () => {
  it("draws borders, coast or lakes dim, below the rain levels", () => {
    const base = drawBaseMap(SALZBURG, RADAR_ZOOM, "de");
    const lit = Array.from(base.lines).filter((level) => level > 0);
    expect(lit.length).toBeGreaterThan(500);
    expect(Math.max(...lit)).toBeLessThanOrEqual(LEVEL.border);
    expect(Math.max(...lit)).toBeLessThan(rainLevel(1));
    // Header and footer rows stay black.
    for (let x = 0; x < 576; x += 1) { expect(base.lines[10 * 576 + x]).toBe(0); expect(base.lines[270 * 576 + x]).toBe(0); }
  });

  it("names the big towns around, never on top of each other, the cross or the edge", () => {
    const base = drawBaseMap(SALZBURG, RADAR_ZOOM, "de");
    const names = base.labels.map((label) => label.name);
    expect(names).toEqual(expect.arrayContaining(["MÜNCHEN", "LINZ", "INNSBRUCK"]));
    expect(names.length).toBeLessThanOrEqual(MAX_LABELS);
    const cx = MAP.x + ANCHOR.x; const cy = MAP.y + ANCHOR.y;
    base.labels.forEach((a, i) => {
      expect(a.x).toBeGreaterThanOrEqual(MAP.x); expect(a.x + a.width).toBeLessThanOrEqual(MAP.x + MAP.width);
      expect(a.y).toBeGreaterThanOrEqual(MAP.y); expect(a.y + a.height).toBeLessThanOrEqual(MAP.y + MAP.height);
      expect(a.x < cx + 14 && cx - 14 < a.x + a.width && a.y < cy + 14 && cy - 14 < a.y + a.height, `${a.name} on the cross`).toBe(false);
      base.labels.forEach((b, j) => {
        if (i >= j) return;
        expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height, `${a.name} / ${b.name}`).toBe(false);
      });
    });
    expect(drawBaseMap(SALZBURG, RADAR_ZOOM, "en").labels.map((label) => label.name)).toContain("MUNICH");
  });

  it("names the nearest town for the header", () => {
    expect(nearestPlace(SALZBURG)?.de).toBe("Salzburg");
    expect(drawBaseMap(ZURICH, RADAR_ZOOM, "de").nearest).toBe("Zürich");
    expect(nearestPlace({ latitude: 40, longitude: -40 })).toBeNull();
  });

  it("is drawn once per place, zoom and language", () => {
    const a = baseMapFor(SALZBURG, RADAR_ZOOM, "de");
    expect(baseMapFor({ latitude: 47.8096, longitude: 13.0551 }, RADAR_ZOOM, "de")).toBe(a);
    expect(baseMapFor(SALZBURG, RADAR_ZOOM, "en")).not.toBe(a);
    expect(baseMapFor(ZURICH, RADAR_ZOOM, "en").key).not.toBe(a.key);
  });

  it("puts rain above the map, cuts lines dark into it and keeps names on top", () => {
    const base = drawBaseMap(SALZBURG, RADAR_ZOOM, "de");
    const rain = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(1);
    const frame = composeFrame(SALZBURG, () => rain, RADAR_ZOOM, base);
    let cut = 0; let rainy = 0; let named = 0;
    for (let at = MAP.y * 576; at < (MAP.y + MAP.height) * 576; at += 1) {
      const level = frame.pixels[at]!;
      if (base.overlay[at] !== TRANSPARENT) { if (level === base.overlay[at]) named += 1; continue; }
      if (base.lines[at]! > 0) { if (level === CUT_LEVEL) cut += 1; } else if (level === rainLevel(1)) rainy += 1;
    }
    expect(cut).toBeGreaterThan(300);
    expect(rainy).toBeGreaterThan(50_000);
    expect(named).toBeGreaterThan(100);
    // The weakest rain is still brighter than any map line.
    expect(rainLevel(1)).toBeGreaterThan(LEVEL.border);
    expect(rainLevel(15)).toBe(15);
  });

  it("leaves rain-free tiles unchanged from frame to frame, so they are not sent again", () => {
    const data = syntheticRadar(SALZBURG, 1_000_000, RADAR_ZOOM, "de");
    const keys = data.frames.map((frame) => frame.keys);
    const empty = splitTiles(composeFrame(SALZBURG, () => null, RADAR_ZOOM, baseMapFor(SALZBURG, RADAR_ZOOM, "de")));
    expect(empty).toHaveLength(4);
    // Every frame has the map: no tile is blank.
    expect(data.frames.every((frame) => frame.tiles.every((tile) => tile.pixels.some((level) => level > 0)))).toBe(true);
    expect(keys).toHaveLength(6);
    expect(neededTiles(SALZBURG).length).toBeGreaterThan(0);
    expect(pixel(empty[0], 0, 0)).toBe(0);
  });
});

describe("tile decoding without createImageBitmap", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function stubCanvas(): { drawn: unknown[] } {
    const drawn: unknown[] = [];
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0, height: 0,
        getContext: () => ({ drawImage: (source: unknown) => { drawn.push(source); }, getImageData: () => ({ data: new Uint8ClampedArray(256 * 256 * 4).fill(255) }) }),
      }),
    });
    return { drawn };
  }

  class FakeImage { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_value: string) { queueMicrotask(() => this.onload?.()); } }

  it("falls back to an <img> from a blob URL when createImageBitmap is missing", async () => {
    const { drawn } = stubCanvas();
    vi.stubGlobal("createImageBitmap", undefined);
    vi.stubGlobal("Image", FakeImage);
    const revoked: string[] = [];
    vi.stubGlobal("URL", { createObjectURL: () => "blob:tile", revokeObjectURL: (url: string) => { revoked.push(url); } });
    const levels = await decodeTileInBrowser(new Blob([new Uint8Array(4)]));
    expect(levels).toHaveLength(TILE_SIZE * TILE_SIZE);
    expect(drawn[0]).toBeInstanceOf(FakeImage);
    expect(revoked).toEqual(["blob:tile"]);
  });

  it("falls back as well when createImageBitmap refuses the blob", async () => {
    const { drawn } = stubCanvas();
    vi.stubGlobal("createImageBitmap", async () => { throw new Error("not supported"); });
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("URL", { createObjectURL: () => "blob:tile", revokeObjectURL: () => undefined });
    await decodeTileInBrowser(new Blob([new Uint8Array(4)]));
    expect(drawn[0]).toBeInstanceOf(FakeImage);
  });

  it("uses createImageBitmap when it works and frees the bitmap", async () => {
    const { drawn } = stubCanvas();
    let closed = 0;
    const bitmap = { close: () => { closed += 1; } };
    vi.stubGlobal("createImageBitmap", async () => bitmap);
    await decodeTileInBrowser(new Blob([new Uint8Array(4)]));
    expect(drawn[0]).toBe(bitmap);
    expect(closed).toBe(1);
  });
});

describe("radar page with the map", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const messages: Record<string, string> = { radar: "RADAR", radarCredit: "Radar: RainViewer", radarControls: "Tap", radarLoading: "Loading radar", radarLoadingShort: "Loading", radarNoLocation: "No location", radarError: "Radar unreachable", radarErrorShort: "Unreachable · Tap = retry", radarLocating: "Finding you", radarSample: "SAMPLE" };
  const t = (key: string): string => messages[key] ?? key;
  const lane = () => {
    const keys: string[] = [];
    return { keys, lane: { request: (_target: unknown, key: string) => { keys.push(key); }, invalidate: () => undefined, close: () => undefined, settled: async () => undefined } };
  };

  it("shows the map while the radar loads, and the town in the header", () => {
    const session = createRadarSession({ position: () => SALZBURG, t, locale: () => "de", redraw: () => undefined, load: () => new Promise(() => undefined), now: () => Date.now() });
    session.start();
    expect(session.status()).toBe("loading");
    expect(session.text().header).toBe("RAINLENS · RADAR  Salzburg  Loading");
    const { keys, lane: target } = lane();
    session.requestImages(target);
    expect(keys).toHaveLength(4);
    session.stop();
  });

  it("gives up after the load timeout and says how to retry", async () => {
    const session = createRadarSession({ position: () => SALZBURG, t, locale: () => "de", redraw: () => undefined, load: () => new Promise(() => undefined), now: () => Date.now() });
    session.start();
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - 100);
    expect(session.status()).toBe("loading");
    await vi.advanceTimersByTimeAsync(200);
    expect(session.status()).toBe("error");
    expect(session.text().header).toContain("Unreachable · Tap = retry");
    // The map stays up.
    const { keys, lane: target } = lane();
    session.requestImages(target);
    expect(keys).toHaveLength(4);
    session.stop();
  });

  it("says it is still looking for the place instead of 'no location'", () => {
    let locating = true;
    const session = createRadarSession({ position: () => null, t, locale: () => "de", redraw: () => undefined, now: () => Date.now(), locating: () => locating });
    session.start();
    expect(session.text().note).toBe("Finding you");
    locating = false;
    expect(session.text().note).toBe("No location");
    session.stop();
  });

  it("steps the loop only once the glasses have the last frame", async () => {
    let idle = false;
    const data = syntheticRadar(SALZBURG, Date.now(), RADAR_ZOOM, "de");
    const session = createRadarSession({ position: () => SALZBURG, t, locale: () => "de", redraw: () => undefined, load: async () => data, now: () => Date.now(), imagesIdle: () => idle });
    session.start();
    await vi.advanceTimersByTimeAsync(0);
    const first = session.frameIndex();
    await vi.advanceTimersByTimeAsync(STEP_MS * 3);
    expect(session.frameIndex()).toBe(first);
    idle = true;
    await vi.advanceTimersByTimeAsync(STEP_MS * 2);
    expect(session.frameIndex()).toBe(first + 2);
    session.stop();
  });
});

describe("image lane on a stuck link", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does not wait forever for a transfer that never answers", async () => {
    const { createImageLane, SEND_TIMEOUT_MS } = await import("../src/glasses/lane");
    const sent: string[] = [];
    let first = true;
    const lane = createImageLane(async (target) => {
      sent.push(target.name);
      if (first) { first = false; return new Promise<boolean>(() => undefined); }
      return true;
    }, 0);
    lane.request({ id: 1, name: "a" }, "1", () => new Uint8Array([1]));
    lane.request({ id: 2, name: "b" }, "1", () => new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual(["a"]);
    expect(lane.idle?.()).toBe(false);
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    expect(sent).toContain("b");
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    expect(lane.idle?.()).toBe(true);
    lane.close();
  });
});

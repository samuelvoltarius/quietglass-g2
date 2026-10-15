import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pixel } from "../src/glasses/bitmap";
import { levelOf, levelsFromRgba } from "../src/radar/intensity";
import {
  ANCHOR, MAP, RADAR_TILES, TILE_HEIGHT, TILE_WIDTH, bitmapKey, composeFrame, neededTiles, rainLevel, splitTiles,
} from "../src/radar/frame";
import {
  CONCURRENCY, FRAME_COUNT, INDEX_URL, frameAt, isStale, loadRadar, parseIndex, syntheticRadar,
} from "../src/radar/load";
import { RADAR_ZOOM, TILE_SIZE, metersPerPixel, tileUrl, windowTiles, worldPixel } from "../src/radar/tiles";
import { createRadarSession, STEP_MS } from "../src/radar/session";

const SALZBURG = { latitude: 47.8095, longitude: 13.055 };

describe("tile arithmetic", () => {
  it("puts Salzburg in tile 68/44 at zoom 7", () => {
    const at = worldPixel(SALZBURG, 7);
    expect([Math.floor(at.x / TILE_SIZE), Math.floor(at.y / TILE_SIZE)]).toEqual([68, 44]);
  });

  it("knows the equator and the date line", () => {
    expect(worldPixel({ latitude: 0, longitude: 0 }, 1)).toEqual({ x: 256, y: 256 });
    expect(worldPixel({ latitude: 0, longitude: -180 }, 2).x).toBe(0);
  });

  it("measures about 820 m per pixel at 48 degrees and zoom 7", () => {
    expect(metersPerPixel(47.8, 7)).toBeGreaterThan(800);
    expect(metersPerPixel(47.8, 7)).toBeLessThan(840);
  });

  it("covers the window with the tiles that touch it, and nothing else", () => {
    const placements = neededTiles(SALZBURG);
    expect(placements.length).toBeGreaterThanOrEqual(3);
    expect(placements.length).toBeLessThanOrEqual(12);
    // Every pixel of the map area lies inside exactly one tile.
    for (const [x, y] of [[0, 0], [MAP.width - 1, 0], [0, MAP.height - 1], [MAP.width - 1, MAP.height - 1], [ANCHOR.x, ANCHOR.y]] as const) {
      const hits = placements.filter((p) => x >= p.x && x < p.x + TILE_SIZE && y >= p.y && y < p.y + TILE_SIZE);
      expect(hits, `${x},${y}`).toHaveLength(1);
    }
    for (const p of placements) {
      const touches = p.x < MAP.width && p.x + TILE_SIZE > 0 && p.y < MAP.height && p.y + TILE_SIZE > 0;
      expect(touches).toBe(true);
    }
  });

  it("wraps the date line and drops rows beyond the poles", () => {
    const spec = { width: 576, height: 218, anchorX: 288, anchorY: 109 };
    const east = windowTiles({ latitude: 0, longitude: 179.9 }, spec, 3);
    expect(east.every((p) => p.tx >= 0 && p.tx < 8)).toBe(true);
    expect(east.some((p) => p.tx === 0)).toBe(true);
    const pole = windowTiles({ latitude: 85, longitude: 0 }, spec, 3);
    expect(pole.every((p) => p.ty >= 0)).toBe(true);
  });

  it("builds the documented tile URL", () => {
    expect(tileUrl("/v2/radar/abc123", 7, 68, 44)).toBe("https://tilecache.rainviewer.com/v2/radar/abc123/256/7/68/44/2/1_1.png");
  });
});

describe("radar colours", () => {
  it("is nothing where the tile is transparent", () => {
    expect(levelOf(0, 0, 0, 0)).toBe(0);
    expect(levelOf(124, 117, 101, 5)).toBe(0);
  });

  it("keeps the order faint, rain, heavy, extreme", () => {
    const faint = levelOf(124, 117, 101, 62);
    const lightRain = levelOf(136, 221, 238, 255);
    const strongRain = levelOf(0, 71, 104, 255);
    const heavy = levelOf(255, 210, 0, 255);
    const red = levelOf(242, 54, 0, 255);
    const extreme = levelOf(255, 129, 255, 255);
    const ordered = [faint, lightRain, strongRain, heavy, red, extreme];
    expect(ordered.every((v, i, all) => i === 0 || v >= all[i - 1]!)).toBe(true);
    expect(faint).toBeGreaterThan(0);
    expect(extreme).toBe(15);
  });

  it("stays within 1 to 15 for anything with opacity", () => {
    for (const color of [[255, 255, 255, 255], [10, 10, 10, 255], [206, 255, 255, 38], [0, 0, 255, 200], [255, 0, 0, 255]] as const) {
      const level = levelOf(color[0], color[1], color[2], color[3]);
      expect(level).toBeGreaterThanOrEqual(1);
      expect(level).toBeLessThanOrEqual(15);
    }
  });

  it("converts an RGBA buffer pixel by pixel", () => {
    const rgba = new Uint8Array([0, 0, 0, 0, 255, 129, 255, 255]);
    expect(Array.from(levelsFromRgba(rgba, 2))).toEqual([0, 15]);
  });
});

describe("radar frame", () => {
  const rainEverywhere = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(9);

  it("splits the display into four 288 x 144 containers that tile it exactly", () => {
    expect(RADAR_TILES).toHaveLength(4);
    expect(RADAR_TILES.map((t) => [t.x, t.y])).toEqual([[0, 0], [288, 0], [0, 144], [288, 144]]);
    for (const tile of RADAR_TILES) { expect(tile.width).toBe(TILE_WIDTH); expect(tile.height).toBe(TILE_HEIGHT); }
    expect(new Set(RADAR_TILES.map((t) => t.id)).size).toBe(4);
    const pieces = splitTiles(composeFrame(SALZBURG, () => rainEverywhere));
    expect(pieces.map((p) => [p.width, p.height])).toEqual(Array(4).fill([288, 144]));
  });

  it("is black where there is no radar, except rings and the cross", () => {
    const [nw] = splitTiles(composeFrame(SALZBURG, () => null, RADAR_ZOOM, null));
    expect(pixel(nw, 5, 40)).toBe(0);
    expect(Math.max(...nw.pixels)).toBeLessThanOrEqual(15);
  });

  it("keeps the header and footer rows free for text", () => {
    const frame = composeFrame(SALZBURG, () => rainEverywhere);
    for (const y of [0, 20, 33, 252, 270, 287]) for (const x of [0, 288, 575]) expect(pixel(frame, x, y), `${x},${y}`).toBe(0);
    expect(pixel(composeFrame(SALZBURG, () => rainEverywhere, RADAR_ZOOM, null), 20, 60)).toBe(rainLevel(9));
  });

  it("draws the place as a bright cross in the middle of the map area", () => {
    const frame = composeFrame(SALZBURG, () => rainEverywhere);
    const cx = ANCHOR.x; const cy = MAP.y + ANCHOR.y;
    expect(pixel(frame, cx, cy)).toBe(15);
    expect(pixel(frame, cx + 6, cy)).toBe(15);
    expect(pixel(frame, cx, cy - 6)).toBe(15);
    // The black halo keeps it readable over rain.
    expect(pixel(frame, cx + 6, cy + 2)).toBe(0);
    expect([rainLevel(9), 1]).toContain(pixel(frame, cx + 15, cy));
  });

  it("shows rain where the tile has it, at 1:1 pixels", () => {
    const target = neededTiles(SALZBURG).find((p) => ANCHOR.x >= p.x && ANCHOR.x < p.x + TILE_SIZE && ANCHOR.y >= p.y && ANCHOR.y < p.y + TILE_SIZE)!;
    const spot = new Uint8Array(TILE_SIZE * TILE_SIZE);
    // Thirty pixels east of the place, away from the cross.
    const column = ANCHOR.x - target.x + 30; const row = ANCHOR.y - target.y;
    spot[row * TILE_SIZE + column] = 12;
    // Without the base map, so only the rain is there.
    const frame = composeFrame(SALZBURG, (tx, ty) => (tx === target.tx && ty === target.ty ? spot : null), RADAR_ZOOM, null);
    expect(pixel(frame, ANCHOR.x + 30, MAP.y + ANCHOR.y)).toBe(rainLevel(12));
    expect(pixel(frame, ANCHOR.x + 31, MAP.y + ANCHOR.y)).toBe(0);
  });

  it("keys equal pictures equally", () => {
    const a = splitTiles(composeFrame(SALZBURG, () => rainEverywhere));
    const b = splitTiles(composeFrame(SALZBURG, () => rainEverywhere));
    expect(bitmapKey(a[0])).toBe(bitmapKey(b[0]));
    const c = splitTiles(composeFrame(SALZBURG, () => null));
    expect(bitmapKey(a[0])).not.toBe(bitmapKey(c[0]));
  });
});

describe("loading", () => {
  const index = { version: "2.0", host: "https://tilecache.rainviewer.com", radar: { past: Array.from({ length: 13 }, (_, i) => ({ time: 1_000_000 + i * 600, path: `/v2/radar/frame${i}abc` })), nowcast: [] } };
  const ok = (): Response => new Response(new Blob([new Uint8Array(4)]));

  it("takes the newest six frames, oldest first", () => {
    const parsed = parseIndex(index);
    expect(parsed.frames).toHaveLength(FRAME_COUNT);
    expect(parsed.frames[0]!.time).toBe(1_000_000 + 7 * 600);
    expect(parsed.frames.at(-1)!.time).toBe(1_000_000 + 12 * 600);
  });

  it("refuses paths that are not RainViewer's and an empty list", () => {
    expect(() => parseIndex({ radar: { past: [{ time: 1, path: "https://evil.example/x" }] } })).toThrow();
    expect(() => parseIndex({ radar: { past: [{ time: 1, path: "/v2/radar/../../etc" }] } })).toThrow();
    expect(() => parseIndex({})).toThrow();
    expect(() => parseIndex(null)).toThrow();
  });

  it("fetches each needed tile of each frame once and composes six frames", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return url === INDEX_URL ? new Response(JSON.stringify(index)) : ok();
    }) as unknown as typeof fetch;
    const rain = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(8);
    const data = await loadRadar(SALZBURG, { fetchImpl, decode: async () => rain, now: () => 5000 });
    const tileUrls = urls.filter((u) => u !== INDEX_URL);
    expect(tileUrls).toHaveLength(FRAME_COUNT * neededTiles(SALZBURG).length);
    expect(new Set(tileUrls).size).toBe(tileUrls.length);
    expect(tileUrls.every((u) => u.startsWith("https://tilecache.rainviewer.com/v2/radar/") && u.includes(`/256/${RADAR_ZOOM}/`) && u.endsWith("/2/1_1.png"))).toBe(true);
    expect(urls[0]).toBe(INDEX_URL);
    expect(data.frames).toHaveLength(FRAME_COUNT);
    expect(data.loadedAt).toBe(5000);
    expect(data.frames[0]!.tiles).toHaveLength(4);
  });

  it("never asks for more than a handful of tiles at once", async () => {
    let inFlight = 0; let peak = 0;
    const fetchImpl = (async (url: string) => {
      if (url === INDEX_URL) return new Response(JSON.stringify(index));
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return ok();
    }) as unknown as typeof fetch;
    await loadRadar(SALZBURG, { fetchImpl, decode: async () => new Uint8Array(TILE_SIZE * TILE_SIZE) });
    expect(peak).toBeLessThanOrEqual(CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });

  it("treats a failed tile as blank but a total failure as an error", async () => {
    let n = 0;
    const flaky = (async (url: string) => {
      if (url === INDEX_URL) return new Response(JSON.stringify(index));
      n += 1;
      return n % 2 === 0 ? new Response("no", { status: 500 }) : ok();
    }) as unknown as typeof fetch;
    const data = await loadRadar(SALZBURG, { fetchImpl: flaky, decode: async () => new Uint8Array(TILE_SIZE * TILE_SIZE).fill(7) });
    expect(data.frames).toHaveLength(FRAME_COUNT);
    const dead = (async (url: string) => (url === INDEX_URL ? new Response(JSON.stringify(index)) : new Response("no", { status: 503 }))) as unknown as typeof fetch;
    await expect(loadRadar(SALZBURG, { fetchImpl: dead })).rejects.toThrow(/could not be loaded/);
    const offline = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await expect(loadRadar(SALZBURG, { fetchImpl: offline })).rejects.toThrow();
  });

  it("knows when a loaded radar is stale", () => {
    const data = syntheticRadar(SALZBURG, 10_000);
    expect(isStale(null, SALZBURG, 0)).toBe(true);
    expect(isStale(data, SALZBURG, 10_000 + 60_000)).toBe(false);
    expect(isStale(data, SALZBURG, 10_000 + 6 * 60_000)).toBe(true);
    expect(isStale(data, { latitude: 48.5, longitude: 13.055 }, 10_000)).toBe(true);
  });

  it("makes a demo radar of six frames that all differ", () => {
    const data = syntheticRadar(SALZBURG, 1_000_000);
    expect(data.synthetic).toBe(true);
    expect(data.frames).toHaveLength(FRAME_COUNT);
    const keys = data.frames.map((f) => f.keys.join(","));
    expect(new Set(keys).size).toBe(FRAME_COUNT);
    expect(data.frames.some((f) => Math.max(...f.tiles[0].pixels) >= 6)).toBe(true);
  });
});

describe("the loop", () => {
  it("runs oldest to newest, holds the newest one step longer, then starts over", () => {
    expect(Array.from({ length: 8 }, (_, tick) => frameAt(tick, 6))).toEqual([0, 1, 2, 3, 4, 5, 5, 0]);
    expect(frameAt(0, 0)).toBe(0);
    expect(frameAt(-1, 6)).toBe(5);
  });
});

describe("session", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const messages: Record<string, string> = { radar: "RADAR", radarCredit: "Radar: RainViewer", radarControls: "Tap: reload", radarLoading: "Loading radar", radarLoadingShort: "Loading", radarNoLocation: "No location", radarError: "Radar unreachable", radarErrorShort: "Unreachable · Tap = retry", radarLocating: "Finding you", radarSample: "SAMPLE" };
  const t = (key: string): string => messages[key] ?? key;

  function make(options: { position?: typeof SALZBURG | null; load?: () => Promise<ReturnType<typeof syntheticRadar>>; demo?: boolean } = {}) {
    const redraws = { count: 0 };
    const data = syntheticRadar(SALZBURG, Date.now(), RADAR_ZOOM, "en");
    const load = vi.fn(options.load ?? (async () => data));
    const session = createRadarSession({
      position: () => (options.position === undefined ? SALZBURG : options.position),
      t, locale: () => "en", redraw: () => { redraws.count += 1; }, load, now: () => Date.now(), ...(options.demo ? { demo: true } : {}),
    });
    return { session, redraws, load };
  }

  it("loads on entering, then steps every 700 ms only while on screen", async () => {
    const { session, redraws } = make();
    session.start();
    expect(session.status()).toBe("loading");
    // The map is already up: the state is in the header, with the nearest town.
    expect(session.text().note).toBe("");
    expect(session.text().header).toBe("RAINLENS · RADAR  Salzburg  Loading");
    await vi.advanceTimersByTimeAsync(0);
    expect(session.status()).toBe("ready");
    expect(session.text().note).toBe("");
    const before = redraws.count; const first = session.frameIndex();
    await vi.advanceTimersByTimeAsync(STEP_MS * 3);
    expect(redraws.count - before).toBe(3);
    expect(session.frameIndex()).toBe(first + 3);
    session.stop();
    const stopped = redraws.count;
    await vi.advanceTimersByTimeAsync(STEP_MS * 10);
    expect(redraws.count).toBe(stopped);
  });

  it("carries the source credit on the page and the frame time and position dots in the header", async () => {
    const { session } = make();
    session.start();
    await vi.advanceTimersByTimeAsync(0);
    const text = session.text();
    expect(text.footer).toContain("Radar: RainViewer");
    expect(text.header).toMatch(/RADAR/);
    expect(text.header).toMatch(/\d{2}:\d{2}/);
    expect((text.header.match(/[●○]/g) ?? []).length).toBe(6);
    expect((text.header.match(/●/g) ?? []).length).toBe(1);
    // The loading and error pages carry the credit too.
    expect(make({ position: null }).session.text().footer).toContain("Radar: RainViewer");
  });

  it("says so without a place, and loads once the place is there", async () => {
    let position: typeof SALZBURG | null = null;
    const data = syntheticRadar(SALZBURG, Date.now(), RADAR_ZOOM, "en");
    const load = vi.fn(async () => data);
    const session = createRadarSession({ position: () => position, t, locale: () => "en", redraw: () => undefined, load, now: () => Date.now() });
    session.start();
    expect(session.status()).toBe("noLocation");
    expect(session.text().note).toBe("No location");
    expect(load).not.toHaveBeenCalled();
    position = SALZBURG;
    session.reload();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.status()).toBe("ready");
  });

  it("reports a failed first load, keeps old pictures when a reload fails, and tries again on a tap", async () => {
    let fail = true;
    const data = syntheticRadar(SALZBURG, Date.now(), RADAR_ZOOM, "en");
    const { session, load } = make({ load: async () => { if (fail) throw new Error("offline"); return data; } });
    session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.status()).toBe("error");
    expect(session.text().header).toBe("RAINLENS · RADAR  Unreachable · Tap = retry");
    expect(session.text().note).toBe("");
    fail = false; session.reload();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.status()).toBe("ready");
    fail = true; session.reload();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.status()).toBe("ready");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("falls back to a made-up radar in the demo, marked as a sample", async () => {
    const { session } = make({ demo: true, load: async () => { throw new Error("offline"); } });
    session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.status()).toBe("ready");
    expect(session.text().header).toContain("SAMPLE");
  });

  it("does not reload fresh data when the page comes back, and asks for each tile only on change", async () => {
    const { session, load } = make();
    session.start();
    await vi.advanceTimersByTimeAsync(0);
    session.stop();
    session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    const requests: string[] = [];
    session.requestImages({ request: (_target, key) => { requests.push(key); }, invalidate: () => undefined, close: () => undefined, settled: async () => undefined });
    expect(requests).toHaveLength(4);
    expect(requests.every((key) => key.startsWith("r:"))).toBe(true);
  });
});

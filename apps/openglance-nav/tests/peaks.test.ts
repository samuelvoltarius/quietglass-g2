import { describe, expect, it } from "vitest";
import fixture from "./fixtures/overpass-peaks-salzburg.json";
import {
  addToCache, areaFor, bandPicks, buildPeakQuery, capPeaks, CELL_MARGIN_M, compassPoint, createPeakSource,
  facingFor, findCached, MAX_AREAS, parseCache, parseEle, parsePeaks, relativeBearing, serializeCache, sightsFrom,
  type CachedArea, type Peak,
} from "../src/peaks/peaks";
import { distanceMeters } from "../src/geo/geometry";

const SALZBURG = { lat: 47.8, lon: 13.05 };

/** A point `east`/`north` metres from `from`. */
function offset(from: { lat: number; lon: number }, east: number, north: number): { lat: number; lon: number } {
  return { lat: from.lat + north / 111_320, lon: from.lon + east / (111_320 * Math.cos((from.lat * Math.PI) / 180)) };
}
const peak = (id: number, name: string, ele: number, east: number, north: number): Peak => ({ id, name, ele, at: offset(SALZBURG, east, north) });

describe("bearing and distance to a peak", () => {
  it("measures distance and bearing for the four directions", () => {
    const sights = sightsFrom(SALZBURG, [peak(1, "N", 1000, 0, 5000), peak(2, "O", 1000, 5000, 0), peak(3, "S", 1000, 0, -5000), peak(4, "W", 1000, -5000, 0)]);
    const byName = Object.fromEntries(sights.map((s) => [s.peak.name, s]));
    expect(byName["N"]!.bearing).toBeCloseTo(0, 0);
    expect(byName["O"]!.bearing).toBeCloseTo(90, 0);
    expect(byName["S"]!.bearing).toBeCloseTo(180, 0);
    expect(byName["W"]!.bearing).toBeCloseTo(270, 0);
    for (const s of sights) expect(s.distance).toBeGreaterThan(4980), expect(s.distance).toBeLessThan(5020);
  });

  it("matches a known distance: Salzburg Dom to Gaisberg summit is about 5 km", () => {
    const dom = { lat: 47.7979, lon: 13.0471 };
    const gaisberg = { lat: 47.8048, lon: 13.1116 };
    expect(distanceMeters(dom, gaisberg) / 1000).toBeCloseTo(4.9, 0);
  });

  it("sorts nearest first and drops what lies beyond the radius", () => {
    const sights = sightsFrom(SALZBURG, [peak(1, "far", 900, 0, 30_000), peak(2, "near", 600, 0, 2000), peak(3, "mid", 800, 9000, 0)], 25_000);
    expect(sights.map((s) => s.peak.name)).toEqual(["near", "mid"]);
  });

  it("gives the bearing relative to the facing direction, across north", () => {
    expect(relativeBearing(350, 10)).toBe(20);
    expect(relativeBearing(10, 350)).toBe(-20);
    expect(relativeBearing(90, 270)).toBe(-180);
    expect(relativeBearing(0, 90)).toBe(90);
  });

  it("names the nearest compass point in German and English", () => {
    expect(compassPoint(44, "de")).toBe("NO");
    expect(compassPoint(44, "en")).toBe("NE");
    expect(compassPoint(91, "de")).toBe("O");
    expect(compassPoint(359, "en")).toBe("N");
    expect(compassPoint(-90, "en")).toBe("W");
  });
});

describe("which way the band faces", () => {
  const now = 1_000_000;
  it("follows the GPS course while moving", () => {
    expect(facingFor({ heading: 245, speed: 1.4, at: now - 1000 }, now, 90)).toEqual({ deg: 245, source: "gps" });
  });
  it("uses the direction set on the phone when standing still or the course is old", () => {
    expect(facingFor({ heading: 245, speed: 0.2, at: now }, now, 90)).toEqual({ deg: 90, source: "set" });
    expect(facingFor({ heading: 245, speed: 3, at: now - 60_000 }, now, 90)).toEqual({ deg: 90, source: "set" });
  });
  it("is north up without either", () => {
    expect(facingFor(null, now, null)).toEqual({ deg: 0, source: "north" });
    expect(facingFor({ heading: -1, speed: 3, at: now }, now, null)).toEqual({ deg: 0, source: "north" });
  });
});

describe("band picks", () => {
  const sights = sightsFrom(SALZBURG, [
    peak(1, "ahead near", 700, 0, 2000), peak(2, "ahead high", 2500, 1000, 20_000), peak(3, "behind", 3000, 0, -5000),
    peak(4, "far left", 1500, -20_000, 1000), peak(5, "right edge", 1200, 9000, 6000),
  ]);
  it("keeps what lies within ±60° and counts the rest by side", () => {
    const picks = bandPicks(sights, 0, "near");
    expect(picks.shown.map((s) => s.peak.name)).toEqual(["ahead near", "right edge", "ahead high"]);
    expect(picks.left).toBe(1 + 1); // far left (W) and behind (S, -180)
    expect(picks.right).toBe(0);
  });
  it("orders by height when asked for the highest, and limits the number", () => {
    expect(bandPicks(sights, 0, "high", 2).shown.map((s) => s.peak.name)).toEqual(["ahead high", "right edge"]);
  });
});

describe("Overpass", () => {
  it("asks for named peaks with an elevation around a point", () => {
    const query = buildPeakQuery(SALZBURG, 29_000);
    expect(query).toBe('[out:json][timeout:25];node["natural"="peak"]["name"]["ele"](around:29000,47.8000,13.0500);out qt;');
  });

  it("reads elevations as mapped in OSM", () => {
    expect(parseEle("2522")).toBe(2522);
    expect(parseEle("2522.6")).toBe(2523);
    expect(parseEle("1287 m")).toBe(1287);
    expect(parseEle("1287,4")).toBe(1287);
    expect(parseEle("ca. 900")).toBe(900);
    expect(parseEle("2.522")).toBe(2522);
    expect(parseEle(1973)).toBe(1973);
    expect(parseEle("unknown")).toBeNull();
    expect(parseEle("12000")).toBeNull();
    expect(parseEle("")).toBeNull();
    expect(parseEle(undefined)).toBeNull();
  });

  it("parses a real answer (Salzburg, 10 km, 2026-10-14)", () => {
    const peaks = parsePeaks(fixture)!;
    expect(peaks.length).toBeGreaterThan(30);
    const kuehstein = peaks.find((p) => p.name === "Kühstein")!;
    expect(kuehstein).toMatchObject({ id: 648692306, ele: 1430 });
    for (const p of peaks) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(Number.isInteger(p.ele)).toBe(true);
      expect(distanceMeters(SALZBURG, p.at)).toBeLessThan(10_100);
    }
  });

  it("leaves out nodes without a name, a usable elevation or a position, and duplicates", () => {
    const peaks = parsePeaks({ elements: [
      { type: "node", id: 1, lat: 47, lon: 13, tags: { name: " Hoher  Göll ", ele: "2522" } },
      { type: "node", id: 1, lat: 47, lon: 13, tags: { name: "Hoher Göll", ele: "2522" } },
      { type: "node", id: 2, lat: 47, lon: 13, tags: { ele: "100" } },
      { type: "node", id: 3, lat: 47, lon: 13, tags: { name: "X", ele: "?" } },
      { type: "way", id: 4, tags: { name: "Y", ele: "100" } },
      { type: "node", id: 5, lat: 99, lon: 13, tags: { name: "Z", ele: "100" } },
    ] });
    expect(peaks).toEqual([{ id: 1, name: "Hoher Göll", ele: 2522, at: { lat: 47, lon: 13 } }]);
  });

  it("is not fooled by something that is not an Overpass answer", () => {
    expect(parsePeaks(null)).toBeNull();
    expect(parsePeaks({ remark: "runtime error" })).toBeNull();
  });
});

describe("areas and the cache", () => {
  it("puts nearby points into the same 5 km cell, and the cell is covered by the query", () => {
    const a = areaFor(SALZBURG, 25);
    const b = areaFor(offset(SALZBURG, 300, 300), 25);
    expect(b.key).toBe(a.key);
    expect(a.queryRadiusM).toBe(25_000 + CELL_MARGIN_M);
    // Every point of the cell is within the extra margin of its centre.
    expect(distanceMeters(SALZBURG, a.center)).toBeLessThan(CELL_MARGIN_M);
    expect(areaFor(offset(SALZBURG, 20_000, 0), 25).key).not.toBe(a.key);
  });

  const entry = (key: string, radiusKm: 10 | 25 | 50, time = 0): CachedArea => ({ key, radiusKm, time, peaks: [peak(1, "Gaisberg", 1287, 100, 100)] });

  it("serves a smaller radius from a larger one, never the other way round", () => {
    const area = areaFor(SALZBURG, 25);
    expect(findCached([entry(area.key, 50)], area, 1)).not.toBeNull();
    expect(findCached([entry(area.key, 10)], area, 1)).toBeNull();
    expect(findCached([entry("other", 50)], area, 1)).toBeNull();
    expect(findCached([entry(area.key, 50, 0)], area, 40 * 24 * 3600_000)).toBeNull();
  });

  it("keeps at most a few areas, the newest first, replacing what a new one covers", () => {
    let cache: CachedArea[] = [];
    for (let i = 0; i < MAX_AREAS + 2; i++) cache = addToCache(cache, entry("k" + i, 25, i));
    expect(cache).toHaveLength(MAX_AREAS);
    expect(cache[0]!.key).toBe("k" + (MAX_AREAS + 1));
    cache = addToCache(cache, entry(cache[1]!.key, 50, 99));
    expect(cache.filter((c) => c.key === cache[0]!.key)).toHaveLength(1);
  });

  it("survives a round trip through storage, and ignores garbage", () => {
    const cache = [entry("1:2", 25, 5)];
    const back = parseCache(serializeCache(cache));
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ key: "1:2", radiusKm: 25, time: 5 });
    expect(back[0]!.peaks[0]).toMatchObject({ id: 1, name: "Gaisberg", ele: 1287 });
    // Stored to five decimals (about a metre).
    expect(distanceMeters(back[0]!.peaks[0]!.at, cache[0]!.peaks[0]!.at)).toBeLessThan(1.5);
    expect(parseCache("{")).toEqual([]);
    expect(parseCache(JSON.stringify({ v: 2 }))).toEqual([]);
    expect(parseCache("")).toEqual([]);
  });

  it("caps a huge answer, keeping the highest peaks", () => {
    const many = Array.from({ length: 50 }, (_, i) => peak(i, "P" + i, i * 10, i, i));
    expect(capPeaks(many, 5).map((p) => p.ele)).toEqual([490, 480, 470, 460, 450]);
  });
});

describe("the peak source", () => {
  const answer = (): Response => new Response(JSON.stringify(fixture), { status: 200 });

  function memoryStorage(initial = ""): { raw: string; load: () => Promise<string>; save: (raw: string) => Promise<void> } {
    const store = { raw: initial, load: async () => store.raw, save: async (raw: string) => { store.raw = raw; } };
    return store;
  }

  it("asks once per area, as a form POST, then answers from the cache", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    let now = 0;
    const storage = memoryStorage();
    const source = createPeakSource({
      fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return answer(); },
      clock: () => now, storage,
    });
    const first = await source.get(SALZBURG, 10);
    expect(first.error).toBeNull();
    expect(first.fromCache).toBeUndefined();
    expect(first.peaks.length).toBeGreaterThan(30);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers).toBeUndefined();
    expect(String(calls[0]!.init?.body)).toContain("natural");
    now = 60_000;
    const again = await source.get(offset(SALZBURG, 200, 200), 10);
    expect(again.fromCache).toBe(true);
    expect(calls).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storage.raw).toContain("Kühstein");

    // A new start of the app reads the cache from the phone: still no request.
    const later = createPeakSource({ fetchImpl: async () => { throw new Error("no network expected"); }, clock: () => now, storage });
    expect(await later.has(SALZBURG, 10)).toBe(true);
    expect((await later.get(SALZBURG, 10)).fromCache).toBe(true);
    expect(later.requests()).toBe(0);
  });

  it("asks the next server when one is busy", async () => {
    const urls: string[] = [];
    const source = createPeakSource({
      urls: ["https://a.test/api/interpreter", "https://b.test/api/interpreter"],
      fetchImpl: async (url) => { urls.push(String(url)); return urls.length === 1 ? new Response("busy", { status: 504 }) : answer(); },
    });
    const outcome = await source.get(SALZBURG, 10);
    expect(outcome.error).toBeNull();
    expect(urls).toEqual(["https://a.test/api/interpreter", "https://b.test/api/interpreter"]);
  });

  it("does not ask again within 20 s, and says how long to wait", async () => {
    let now = 0;
    const source = createPeakSource({ urls: ["https://a.test/"], fetchImpl: async () => new Response("", { status: 504 }), clock: () => now });
    expect((await source.get(SALZBURG, 10)).error).toBe("busy");
    now = 5_000;
    const outcome = await source.get(SALZBURG, 10);
    expect(outcome).toMatchObject({ error: "cooldown", waitS: 15 });
    expect(source.requests()).toBe(1);
  });

  it("reports an offline phone at once, without trying every server", async () => {
    let calls = 0;
    const source = createPeakSource({ urls: ["https://a.test/", "https://b.test/"], fetchImpl: async () => { calls++; throw new TypeError("Failed to fetch"); } });
    expect((await source.get(SALZBURG, 10)).error).toBe("offline");
    expect(calls).toBe(1);
  });

  it("shares one request between two callers asking for the same area at once", async () => {
    let calls = 0;
    const source = createPeakSource({ fetchImpl: async () => { calls++; return answer(); } });
    const [a, b] = await Promise.all([source.get(SALZBURG, 25), source.get(SALZBURG, 25)]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect(calls).toBe(1);
  });
});

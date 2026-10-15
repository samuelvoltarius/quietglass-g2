import { describe, expect, it, vi } from "vitest";
import {
  bestDetour, buildTrafficUrl, createTrafficClient, delayAhead, detourText, lineAhead, parseTraffic, pickerTrafficText,
  TRAFFIC_MIN_GAP_MS, TRAFFIC_POLL_MS, TrafficPoller, trafficAhead, trafficText, type TrafficState,
} from "../src/traffic/traffic";
import { decodePolyline, distanceMeters } from "../src/geo/geometry";
import { buildHud, HUD_WIDTH } from "../src/glasses/hud";
import { locales } from "../src/i18n";
import type { Progress } from "../src/nav/navigator";

/** What glass-traffic answers (shape as in selfhost/services/glass-traffic). */
const ANSWER = {
  incidents: [
    { id: "tt:1", type: "jam", alongM: 4200, offM: 3, delayMin: 9, lengthKm: 1.5, text: "Stau", source: "asfinag+tomtom", point: [47.8, 13.05], geometry: [] },
    { id: "asf:2", type: "roadwork", alongM: 6000, delayMin: null, text: "Baustelle", source: "asfinag" },
    { id: "tt:3", type: "closure", alongM: 9000, text: "", source: "tomtom" },
    { id: "bad", type: "meteor", alongM: 100 },
    { id: "neg", type: "jam", alongM: -5 },
  ],
  delayMin: 9,
  sources: { tomtom: "ok", asfinag: "ok" },
};

describe("traffic answer", () => {
  it("reads incidents, skips what it does not know", () => {
    const report = parseTraffic(ANSWER)!;
    expect(report.incidents.map((i) => i.id)).toEqual(["tt:1", "asf:2", "tt:3"]);
    expect(report.delayMin).toBe(9);
    expect(report.closure).toBe(true);
    expect(report.incidents[1]!.delayMin).toBeNull();
    expect(parseTraffic({ error: "x" })).toBeNull();
    expect(parseTraffic(null)).toBeNull();
  });

  it("finds the next relevant incident ahead, measured from where the line started", () => {
    const state: TrafficState = { route: 1, startAlong: 1000, report: parseTraffic(ANSWER)! };
    // Line started 1 km into the route; at 1.0 km the jam is 4.2 km ahead.
    expect(trafficAhead(state, 1000)).toEqual({ type: "jam", distance: 4200, delayMin: 9 });
    // Roadworks without delay are skipped; past the jam the closure comes next.
    expect(trafficAhead(state, 5500)).toEqual({ type: "closure", distance: 4500, delayMin: null });
    // A little past the jam's start it still counts (you are in it), shown as 0.
    expect(trafficAhead(state, 5300)!.distance).toBe(0);
    expect(trafficAhead(state, 10_300)).toBeNull();
    expect(delayAhead(state, 1000)).toBe(9);
    expect(delayAhead(state, 5500)).toBe(0);
    expect(trafficAhead(null, 0)).toBeNull();
  });

  it("words: `Stau in 4,2 km · +9 min`, `Sperre in …`, the detour and the picker, all within the alert line", () => {
    expect(trafficText({ type: "jam", distance: 4200, delayMin: 9 }, "de")).toBe("Stau in 4,2 km · +9 min");
    expect(trafficText({ type: "jam", distance: 4200, delayMin: 9 }, "en")).toBe("Jam in 4.2 km · +9 min");
    expect(trafficText({ type: "closure", distance: 800, delayMin: 30 }, "de")).toBe("Sperre in 800 m");
    expect(detourText(7, "de")).toBe("Umfahrung spart 7 min · Tippen");
    expect(detourText(7, "en")).toBe("Detour saves 7 min · Tap");
    expect(pickerTrafficText({ incidents: [], delayMin: 12, closure: false }, "de")).toBe("+12 min Stau");
    expect(pickerTrafficText({ incidents: [], delayMin: 0, closure: false }, "de")).toBe("");
    for (const locale of locales) {
      for (const type of ["jam", "closure", "roadwork", "accident", "other"] as const) {
        const text = trafficText({ type, distance: 29_999, delayMin: 245 }, locale);
        expect(text.length, text).toBeLessThanOrEqual(HUD_WIDTH.alert);
      }
      expect(detourText(125, locale).length).toBeLessThanOrEqual(HUD_WIDTH.alert);
    }
  });
});

describe("traffic requests", () => {
  it("is off without VITE_TRAFFIC_URL", () => {
    expect(buildTrafficUrl("")).toBe("");
    expect(buildTrafficUrl("ftp://x")).toBe("");
    expect(buildTrafficUrl("https://traffic.example:8472/")).toBe("https://traffic.example:8472");
  });

  it("POSTs only the line ahead as text/plain (no preflight), thinned, to the own service", async () => {
    const shape = Array.from({ length: 400 }, (_, i) => ({ lat: 47.8, lon: 13 + i * 0.0001 })); // a point every ~7.5 m
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(ANSWER), { status: 200 }));
    const fetchTraffic = createTrafficClient("https://traffic.example", fetchImpl as never);
    const line = lineAhead(shape, 100);
    expect(line[0]).toEqual(shape[100]);
    expect(line[line.length - 1]).toEqual(shape[399]);
    for (let i = 1; i < line.length - 1; i++) expect(distanceMeters(line[i - 1]!, line[i]!)).toBeGreaterThanOrEqual(25);
    const report = await fetchTraffic(line);
    expect(report!.delayMin).toBe(9);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://traffic.example/traffic/route");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "text/plain" });
    const body = JSON.parse(init.body as string) as { shape: string; buffer_m: number };
    expect(decodePolyline(body.shape, 6)).toHaveLength(line.length);
    expect(Object.keys(body).sort()).toEqual(["buffer_m", "shape"]);
  });

  it("returns null on failures instead of throwing", async () => {
    const down = createTrafficClient("https://traffic.example", (async () => { throw new TypeError("offline"); }) as never);
    expect(await down([{ lat: 1, lon: 1 }, { lat: 1, lon: 2 }])).toBeNull();
    const bad = createTrafficClient("https://traffic.example", (async () => new Response("no", { status: 502 })) as never);
    expect(await bad([{ lat: 1, lon: 1 }, { lat: 1, lon: 2 }])).toBeNull();
  });
});

describe("polling without storms", () => {
  it("asks every 2 min, after a new route at once but not within 15 s, never twice at a time", () => {
    const poller = new TrafficPoller();
    const asked: number[] = [];
    let now = 0;
    let route = 1;
    const tick = (): void => {
      if (poller.due(route, now)) { poller.begin(route, now); asked.push(now); poller.end(); }
    };
    // 10 minutes of the 2-s tick on one route.
    for (; now <= 10 * 60_000; now += 2_000) tick();
    expect(asked).toEqual([0, 120_000, 240_000, 360_000, 480_000, 600_000]);
    // A burst of reroutes (one per second for 30 s): at most one request per 15 s.
    asked.length = 0;
    const start = now;
    for (let s = 0; s < 30; s++) { route += 1; now = start + s * 1_000; tick(); }
    expect(asked.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < asked.length; i++) expect(asked[i]! - asked[i - 1]!).toBeGreaterThanOrEqual(TRAFFIC_MIN_GAP_MS);
    expect(TRAFFIC_POLL_MS).toBe(120_000);
  });

  it("does not start a second request while one is out", () => {
    const poller = new TrafficPoller();
    expect(poller.due(1, 0)).toBe(true);
    poller.begin(1, 0);
    expect(poller.due(2, 60_000)).toBe(false);
    expect(poller.due(1, 300_000)).toBe(false);
    poller.end();
    expect(poller.due(2, 60_000)).toBe(true);
  });
});

describe("detour", () => {
  it("is offered from 5 min saving, counting each way's own traffic; closures are unusable", () => {
    // Current: 30 min left + 12 min jam = 42 min.
    expect(bestDetour(1800, 12, false, [
      { durationS: 1800, delayMin: 12, closure: false }, // the same way
      { durationS: 2100, delayMin: 0, closure: false }, // 35 min: saves 7
      { durationS: 1900, delayMin: 0, closure: true },
    ])).toEqual({ index: 1, savesMin: 7 });
    expect(bestDetour(1800, 3, false, [{ durationS: 1700, delayMin: 0, closure: false }])).toBeNull();
    // A closure ahead on the current way: any open way helps.
    expect(bestDetour(1800, 0, true, [{ durationS: 2400, delayMin: 0, closure: false }])!.savesMin).toBeGreaterThanOrEqual(5);
  });

  it("owns the alert line below near traffic and the speed hint, above far traffic; the HUD reports it so a tap can take it", () => {
    const progress: Progress = {
      maneuver: { type: "right", instruction: "Turn right", street: "Hauptstraße", shapeIndex: 5, length: 500, time: 60 },
      distanceToManeuver: 400, distanceRemaining: 12_000, secondsRemaining: 900, offRoute: false, arrived: false,
    };
    const far = { type: "jam" as const, distance: 8_000, delayMin: 12 };
    const near = { type: "jam" as const, distance: 2_000, delayMin: 12 };
    const hud = buildHud(progress, { locale: "de", traffic: far, detour: { savesMin: 7 } });
    expect(hud.alert.trim()).toBe("Umfahrung spart 7 min · Tippen");
    expect(hud.alertKind).toBe("detour");
    expect(buildHud(progress, { locale: "de", traffic: near, detour: { savesMin: 7 } }).alertKind).toBe("trafficNear");
    expect(buildHud(progress, { locale: "de", camera: { distance: 100, limit: 50 }, detour: { savesMin: 7 } }).alertKind).toBe("camera");
    // A navigation state (off route) owns the line: no detour tap then.
    expect(buildHud(progress, { locale: "de", detour: { savesMin: 7 }, state: "offRoute" }).alertKind).toBeNull();
  });
});

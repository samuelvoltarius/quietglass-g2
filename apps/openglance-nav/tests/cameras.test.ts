import { describe, expect, it, vi } from "vitest";
import {
  buildCameraQuery, cameraAhead, camerasAlong, cameraText, CAMERA_WARN_M, createCameraSource, parseCameras, parseMaxspeed, warnDistance,
} from "../src/nav/cameras";
import { CameraCountryGate, cellOf, coarseCountry, photonCountry } from "../src/geo/country";
import { alertCandidates, buildHud, HUD_WIDTH } from "../src/glasses/hud";
import { messages } from "../src/messages";
import { locales } from "../src/i18n";
import type { Progress } from "../src/nav/navigator";

/** About 3 km due east along 47.8 N (Salzburg area): a point every ~75 m. */
const ROUTE = Array.from({ length: 41 }, (_, i) => ({ lat: 47.8, lon: 13.1 + i * 0.001 }));
const metresAt = (lon: number): number => (lon - 13.1) * 111_320 * Math.cos((47.8 * Math.PI) / 180);

const OVERPASS = {
  elements: [
    { type: "node", id: 1, lat: 47.8, lon: 13.11, tags: { highway: "speed_camera", maxspeed: "50" } },
    { type: "node", id: 2, lat: 47.8002, lon: 13.12, tags: {} },
    { type: "node", id: 3, lat: 47.81, lon: 13.125, tags: { highway: "speed_camera" } },
    { type: "node", id: 4, lat: 47.8001, lon: 13.13, tags: { highway: "speed_camera", maxspeed: "AT:urban" } },
    { type: "relation", id: 9, tags: { type: "enforcement", enforcement: "maxspeed", maxspeed: "70" }, members: [
      { type: "node", ref: 2, role: "device" }, { type: "node", ref: 99, role: "from" },
    ] },
  ],
};

describe("fixed enforcement points from OpenStreetMap", () => {
  it("asks for camera nodes and enforcement relations with their devices in the route corridor", () => {
    const query = buildCameraQuery(ROUTE)!;
    expect(query).toContain('node["highway"="speed_camera"]');
    expect(query).toContain('relation["type"="enforcement"]["enforcement"="maxspeed"]');
    expect(query).toContain('node(r.r:"device")');
    expect(buildCameraQuery([])).toBeNull();
  });

  it("reads nodes and relation devices, taking the relation's limit when the device has none", () => {
    const cams = parseCameras(OVERPASS)!;
    const byId = new Map(cams.map((c) => [c.id, c]));
    expect(byId.get("n1")!.maxspeed).toBe(50);
    expect(byId.get("n2")!.maxspeed).toBe(70);
    expect(byId.get("n4")!.maxspeed).toBeNull();
    expect(parseCameras({ remark: "runtime error: timeout", elements: [] })).toBeNull();
    expect(parseMaxspeed("30 mph")).toBe(48);
    expect(parseMaxspeed("none")).toBeNull();
  });

  it("keeps only points on the route, measured along it", () => {
    const along = camerasAlong(ROUTE, parseCameras(OVERPASS)!);
    // n3 is ~1.1 km off the road.
    expect(along.map((c) => c.camera.id)).toEqual(["n1", "n2", "n4"]);
    expect(along[0]!.along).toBeCloseTo(metresAt(13.11), -1);
  });

  it("starts the hint about 300 m before, earlier at speed (>= 10 s), until just past the point", () => {
    const list = camerasAlong(ROUTE, parseCameras(OVERPASS)!);
    const cam = list[0]!.along;
    expect(warnDistance(50)).toBe(CAMERA_WARN_M);
    expect(warnDistance(130)).toBeCloseTo((130 / 3.6) * 10, 6);
    expect(cameraAhead(list, cam - 400, 50, 50)).toBeNull();
    expect(cameraAhead(list, cam - 290, 50, 60)).toEqual({ distance: expect.closeTo(290, 0), limit: 50 });
    expect(cameraAhead(list, cam - 350, 130, 100)).not.toBeNull();
    expect(cameraAhead(list, cam + 10, 50, null)).not.toBeNull();
    // Past n1, n2 is more than 300 m ahead: nothing.
    expect(cameraAhead(list, cam + 30, 50, null)).toBeNull();
    // The point's own limit wins; without one the current limit; without both no number.
    const n4 = list[2]!.along;
    expect(cameraAhead(list, n4 - 100, 50, 80)!.limit).toBe(80);
    expect(cameraAhead(list, n4 - 100, 50, null)!.limit).toBeNull();
  });

  it("says it neutrally: never the words for the devices, within the alert line", () => {
    for (const locale of locales) {
      for (const limit of [30, 130, null]) {
        const text = cameraText({ distance: 100, limit }, locale);
        expect(text.length).toBeLessThanOrEqual(HUD_WIDTH.alert);
        expect(text).not.toMatch(/blitz|radar|camera|kamera|flash/i);
      }
    }
    expect(cameraText({ distance: 100, limit: 50 }, "de")).toBe("Tempo beachten · 50");
    expect(cameraText({ distance: 100, limit: null }, "en")).toBe("Mind your speed");
    for (const locale of locales) {
      for (const [key, text] of Object.entries(messages[locale])) {
        if (key.startsWith("s.") || key.startsWith("g.") || key.startsWith("h.")) expect(text, key).not.toMatch(/blitzer|radar/i);
      }
    }
  });

  it("asks Overpass once per line and at most every 30 s", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(OVERPASS), { status: 200 }));
    const source = createCameraSource({ urls: ["https://overpass.test"], fetchImpl: fetchImpl as never, clock: () => now });
    expect((await source.along(ROUTE)).cameras).toHaveLength(4);
    expect((await source.along(ROUTE)).cameras).toHaveLength(4);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const other = ROUTE.map((p) => ({ ...p, lat: p.lat + 0.01 }));
    expect((await source.along(other)).error).toBe("cooldown");
    now = 31_000;
    expect((await source.along(other)).error).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("off in Germany (StVO § 23 Abs. 1c)", () => {
  it("knows deep Germany, deep Austria/Italy and the border band", () => {
    expect(coarseCountry({ lat: 52.52, lon: 13.4 })).toBe("DE"); // Berlin
    expect(coarseCountry({ lat: 48.14, lon: 11.58 })).toBe("DE"); // München
    expect(coarseCountry({ lat: 48.21, lon: 16.37 })).toBe("other"); // Wien
    expect(coarseCountry({ lat: 47.07, lon: 15.44 })).toBe("other"); // Graz
    expect(coarseCountry({ lat: 46.5, lon: 11.35 })).toBe("other"); // Bozen
    expect(coarseCountry({ lat: 47.81, lon: 13.04 })).toBe("border"); // Salzburg
    expect(coarseCountry({ lat: 47.84, lon: 12.98 })).toBe("border"); // Freilassing
  });

  it("never allows the hint in Germany, allows it deep in Austria", () => {
    const gate = new CameraCountryGate(async () => "AT");
    expect(gate.allowed({ lat: 52.52, lon: 13.4 }, 0)).toBe(false);
    expect(gate.allowed({ lat: 48.21, lon: 16.37 }, 0)).toBe(true);
    expect(gate.allowed(null, 0)).toBe(false);
  });

  it("near the border stays off until the reverse lookup says which country; one lookup per cell, rate-limited", async () => {
    const lookup = vi.fn(async (p: { lat: number; lon: number }) => (p.lon < 13.0 ? "DE" : "AT"));
    const answered = vi.fn();
    const gate = new CameraCountryGate(lookup, answered);
    const salzburg = { lat: 47.813, lon: 13.045 };
    expect(gate.allowed(salzburg, 0)).toBe(false);
    await vi.waitFor(() => expect(answered).toHaveBeenCalled());
    expect(gate.allowed(salzburg, 1)).toBe(true);
    expect(gate.allowed({ lat: 47.8135, lon: 13.0455 }, 2)).toBe(true); // same cell, no new lookup
    expect(lookup).toHaveBeenCalledTimes(1);
    // Freilassing (DE side), too soon for another lookup: off, and still off after the answer.
    const freilassing = { lat: 47.84, lon: 12.98 };
    expect(gate.allowed(freilassing, 3)).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(gate.allowed(freilassing, 20_000)).toBe(false);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(answered).toHaveBeenCalledTimes(2));
    expect(gate.allowed(freilassing, 20_001)).toBe(false);
    // Lookup sends only the cell centre, rounded to two decimals.
    expect(lookup.mock.calls[0]![0]).toEqual(cellOf(salzburg).centre);
  });

  it("treats a failed lookup as unknown (off)", async () => {
    const gate = new CameraCountryGate(async () => null);
    const p = { lat: 47.813, lon: 13.045 };
    expect(gate.allowed(p, 0)).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(gate.allowed(p, 1)).toBe(false);
    expect(new CameraCountryGate(null).allowed(p, 0)).toBe(false);
  });

  it("reads Photon's reverse answer", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://photon.test/reverse?lat=47.81&lon=13.05&limit=1");
      return new Response(JSON.stringify({ features: [{ properties: { countrycode: "at" } }] }), { status: 200 });
    });
    expect(await photonCountry("https://photon.test/", fetchImpl as never)({ lat: 47.8149, lon: 13.0451 })).toBe("AT");
  });
});

describe("speed hint in the alert line", () => {
  const progress: Progress = {
    maneuver: { type: "right", instruction: "Turn right", street: "Hauptstraße", shapeIndex: 5, length: 500, time: 60 },
    distanceToManeuver: 400, distanceRemaining: 12_000, secondsRemaining: 900, offRoute: false, arrived: false,
  };
  const now = new Date(2026, 9, 14, 10, 0).getTime();
  const camera = { distance: 250, limit: 50 };
  const brake = { phase: "coast" as const, target: 50, distance: 300 };
  const lowFalling = { mgdl: 72, arrow: "↘", stale: false, warning: "lowFalling" as const };
  const battery = { soc: 12, arrival: 4, low: true };

  it("sits below the brake hint and glucose low & falling, above battery, appointment and charger", () => {
    expect(buildHud(progress, { locale: "de", camera, brake }, now).alert.trim()).toBe("▼ 50 in 300 m – vom Gas");
    expect(buildHud(progress, { locale: "de", camera, sugar: lowFalling }, now).alert.trim()).toBe("! 72↘ niedrig & fallend");
    const hud = buildHud(progress, { locale: "de", camera, battery, charger: "Laden in 12 km", appointment: { startMs: now + 3_600_000, title: "x" } }, now);
    expect(hud.alert.trim()).toBe("Tempo beachten · 50");
    expect(hud.alertKind).toBe("camera");
    const kinds = alertCandidates(progress, { locale: "de", camera, battery, charger: "x", brake }, now).map((a) => a.kind);
    expect(kinds).toEqual(["brake", "camera", "lowBattery", "charger"]);
  });

  it("gives way to a jam or closure less than 3 km ahead, but not to one further away", () => {
    const near = { type: "closure" as const, distance: 1_200, delayMin: null };
    const far = { type: "jam" as const, distance: 8_000, delayMin: 9 };
    expect(buildHud(progress, { locale: "de", camera, traffic: near }, now).alert.trim()).toBe("Sperre in 1,2 km");
    expect(buildHud(progress, { locale: "de", camera, traffic: far }, now).alert.trim()).toBe("Tempo beachten · 50");
  });
});

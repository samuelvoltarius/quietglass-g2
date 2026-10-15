import { resetGestureDedupe } from "../src/input/gestures";
import { decodePolyline } from "../src/geo/geometry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app in the car with VITE_TRAFFIC_URL against a fake bridge,
// a fake Valhalla (which offers a second way) and a fake glass-traffic service:
// the route choice before the start, the jam on the HUD, the detour on tap -
// and how many requests that takes.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const START = { lat: 47.8, lon: 13.04 };
const STEP = 0.0009; // ≈ 100 m

function encode(points: readonly { lat: number; lon: number }[]): string {
  let out = "";
  let lastLat = 0, lastLon = 0;
  const push = (delta: number): void => {
    let value = delta < 0 ? ~(delta << 1) : delta << 1;
    while (value >= 0x20) { out += String.fromCharCode((0x20 | (value & 0x1f)) + 63); value >>= 5; }
    out += String.fromCharCode(value + 63);
  };
  for (const point of points) {
    const lat = Math.round(point.lat * 1e6), lon = Math.round(point.lon * 1e6);
    push(lat - lastLat); push(lon - lastLon);
    lastLat = lat; lastLon = lon;
  }
  return out;
}

/** A: 5 km due north on the motorway. B: east first, then north - slower on paper. */
const SHAPE_A = Array.from({ length: 51 }, (_, i) => ({ lat: START.lat + i * STEP, lon: START.lon }));
const SHAPE_B = [
  ...Array.from({ length: 6 }, (_, i) => ({ lat: START.lat, lon: START.lon + i * STEP })),
  ...Array.from({ length: 50 }, (_, i) => ({ lat: START.lat + (i + 1) * STEP, lon: START.lon + 5 * STEP })),
];
const TRIP_A = {
  legs: [{ shape: encode(SHAPE_A), maneuvers: [
    { type: 1, instruction: "Head north", street_names: ["A1"], length: 5, time: 300, begin_shape_index: 0 },
    { type: 4, instruction: "Arrive", length: 0, time: 0, begin_shape_index: 50 },
  ] }],
  summary: { length: 5, time: 300, has_highway: true },
};
const TRIP_B = {
  legs: [{ shape: encode(SHAPE_B), maneuvers: [
    { type: 1, instruction: "Head east", street_names: ["East Road"], length: 0.5, time: 60, begin_shape_index: 0 },
    { type: 15, instruction: "Turn left", street_names: ["Detour Lane"], length: 5, time: 340, begin_shape_index: 5 },
    { type: 4, instruction: "Arrive", length: 0, time: 0, begin_shape_index: 55 },
  ] }],
  summary: { length: 5.5, time: 400, has_highway: false },
};

/** The jam lies 4 km along A; B is free. */
function trafficFor(body: string): unknown {
  const line = decodePolyline((JSON.parse(body) as { shape: string }).shape, 6);
  const east = line.some((p) => p.lon > START.lon + STEP);
  return east
    ? { incidents: [], delayMin: 0 }
    : { incidents: [{ id: "tt:1", type: "jam", alongM: 4000, delayMin: 9, lengthKm: 1.2, text: "Stau", source: "tomtom" }], delayMin: 9 };
}

const HEADER = 1, BODY = 2, ALERT = 3, TURN = 9;
/** The HUD shows distance and street as two lines of one box (8 containers per page, 15.10.). */
const STREET = TURN;
const TAP = 0, SWIPE_DOWN = 2, DOUBLE_TAP = 3;
const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function fakeBridge() {
  let onEvent: ((event: unknown) => void) | undefined;
  let onLocation: ((location: unknown) => void) | undefined;
  const state = { texts: new Map<number, string>() };
  const takePage = (page: { textObject?: { containerID?: number; content?: string }[] }): void => {
    state.texts.clear();
    for (const text of page.textObject ?? []) if (text.containerID !== undefined) state.texts.set(text.containerID, text.content ?? "");
  };
  const bridge = {
    getLocalStorage: async () => JSON.stringify({
      valhallaUrl: "https://valhalla.test", mode: "driving", glassView: "turns",
      places: [{ id: "p1", label: "Office", at: SHAPE_A[50] }], destinationId: "p1",
    }),
    setLocalStorage: async () => true,
    rebuildPageContainer: async (page: never) => { takePage(page); return true; },
    createStartUpPageContainer: async (page: never) => { takePage(page); return 0; },
    textContainerUpgrade: async (upgrade: { containerID?: number; content?: string }) => {
      if (upgrade.containerID !== undefined) state.texts.set(upgrade.containerID, upgrade.content ?? "");
      return true;
    },
    updateImageRawData: async () => "success",
    startAppLocationUpdates: async () => true,
    stopAppLocationUpdates: async () => true,
    getAppLocation: async () => ({ latitude: START.lat, longitude: START.lon }),
    shutDownPageContainer: async () => true,
    onAppLocationChanged: (callback: (location: unknown) => void) => { onLocation = callback; return () => { onLocation = undefined; }; },
    onEvenHubEvent: (callback: (event: unknown) => void) => { onEvent = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge,
    ready: () => onEvent !== undefined,
    gesture: (eventType: number) => (resetGestureDedupe(), onEvent?.({ sysEvent: { eventType, eventSource: 1 } })),
    at: (metres: number, speed: number) => onLocation?.({ latitude: START.lat + (metres / 100) * STEP, longitude: START.lon, speed }),
    fix: (lat: number, lon: number) => onLocation?.({ latitude: lat, longitude: lon, speed: 10 }),
    text: (id: number) => state.texts.get(id) ?? "",
  };
}

describe("route choice, traffic and detour in the car (0.15.0)", () => {
  let routeRequests: { alternates?: number }[];
  let trafficCalls: string[];

  beforeEach(() => {
    routeRequests = [];
    trafficCalls = [];
    vi.stubEnv("VITE_TRAFFIC_URL", "https://traffic.test");
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("navigator", { language: "en-US", onLine: true });
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("document", { getElementById: () => null });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("https://traffic.test")) { trafficCalls.push(String(init?.body)); return new Response(JSON.stringify(trafficFor(String(init?.body))), { status: 200 }); }
      if (u.includes("trace_attributes")) return new Response(JSON.stringify({ edges: [] }), { status: 200 });
      if (u.includes("overpass") || u.includes("interpreter")) return new Response(JSON.stringify({ elements: [] }), { status: 200 });
      const request = JSON.parse(decodeURIComponent(u.split("?json=")[1] ?? "{}")) as { alternates?: number };
      routeRequests.push(request);
      return new Response(JSON.stringify(request.alternates ? { trip: TRIP_A, alternates: [{ trip: TRIP_B }] } : { trip: TRIP_A }), { status: 200 });
    }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function boot(): Promise<ReturnType<typeof fakeBridge>> {
    const fake = fakeBridge();
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    return fake;
  }

  it("lists the ways with their traffic before the start; swipe moves, 2× goes back without starting", async () => {
    const fake = await boot();
    fake.gesture(TAP);
    await vi.waitFor(() => expect(fake.text(HEADER)).toBe("OPENGLANCE · choose route"));
    expect(routeRequests[0]!.alternates).toBe(2);
    // Both ways get their traffic, then the rows show it.
    await vi.waitFor(() => expect(fake.text(BODY)).toContain("+9 min traffic"));
    const rows = fake.text(BODY).split("\n");
    expect(rows[0]).toBe("→ A 5 min · 5,0 km · A1 · +9 min traffic".replace("5,0", "5.0"));
    expect(rows[1]).toMatch(/^ {4}B 7 min · 5\.5 km/);
    expect(trafficCalls).toHaveLength(2);
    fake.gesture(SWIPE_DOWN);
    await vi.waitFor(() => expect(fake.text(BODY).split("\n")[1]).toMatch(/^→ B/));
    fake.gesture(DOUBLE_TAP);
    await vi.waitFor(() => expect(fake.text(HEADER)).not.toBe("OPENGLANCE · choose route"));
    expect(fake.text(BODY)).toContain("Office");
  });

  it("shows the jam, offers the detour, and a tap takes it - one traffic poll, not one per fix", async () => {
    const fake = await boot();
    fake.gesture(TAP);
    await vi.waitFor(() => expect(fake.text(HEADER)).toBe("OPENGLANCE · choose route"));
    await vi.waitFor(() => expect(trafficCalls).toHaveLength(2));
    fake.gesture(TAP);
    // The HUD on way A; the 2-s tick asks for traffic once.
    await vi.waitFor(() => expect(fake.text(STREET).split("\n")[1]).toBe("Arrive"), { timeout: 3000 });
    for (let m = 10; m <= 80; m += 10) { fake.at(m, 25); await settle(10); }
    // The jam is 4 km ahead (beyond 3 km): the detour offer outranks it.
    await vi.waitFor(() => expect(fake.text(ALERT).trim()).toBe("Detour saves 7 min · Tap"), { timeout: 6000 });
    // 2 for the picker, 1 poll, 2 for the candidates of the detour check (A again and B).
    expect(trafficCalls).toHaveLength(5);
    expect(routeRequests.filter((r) => r.alternates)).toHaveLength(2);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(fake.text(STREET).split("\n")[1]).toBe("Detour Lane"));
    await settle(200);
    expect(trafficCalls).toHaveLength(5);
    fake.gesture(7); // system exit: closes the app (2× while navigating only asks to stop now)
    await settle(50);
  }, 15_000);

  it("a reroute takes the fastest way without asking", async () => {
    const fake = await boot();
    fake.gesture(TAP);
    await vi.waitFor(() => expect(fake.text(HEADER)).toBe("OPENGLANCE · choose route"));
    fake.gesture(TAP);
    await vi.waitFor(() => expect(fake.text(STREET).split("\n")[1]).toBe("Arrive"), { timeout: 3000 });
    const before = routeRequests.length;
    // 300 m east of the route for a few fixes: off route; the tap reroutes at once.
    for (let i = 0; i < 4; i++) { fake.fix(START.lat + 2 * STEP, START.lon + 0.004); await settle(10); }
    await vi.waitFor(() => expect(fake.text(ALERT).trim()).toBe("Off route · Tap = reroute"));
    fake.gesture(TAP);
    await vi.waitFor(() => expect(routeRequests.length).toBe(before + 1), { timeout: 3000 });
    expect(routeRequests[before]!.alternates).toBeUndefined();
    await settle(100);
    expect(fake.text(HEADER)).not.toBe("OPENGLANCE · choose route");
    fake.gesture(7); // system exit: closes the app (2× while navigating only asks to stop now)
    await settle(50);
  });
});

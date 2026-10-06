import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app against a fake bridge (as main.test.ts does) to pin
// what crosses Bluetooth and the network: the exit confirmation, how often
// the images are resent, and that streets are fetched once per route.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
vi.mock("../src/glasses/pixel", () => ({ renderPixelIcon: async () => new Uint8Array([1]) }));
vi.mock("../src/overview/draw", () => ({ renderRoutePng: async () => new Uint8Array([2]) }));

const START = { lat: 47.8, lon: 13.04 };

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

/** 2 km due north in 21 points, a turn in the middle. */
function valhalla(): unknown {
  const shape = Array.from({ length: 21 }, (_, i) => ({ lat: START.lat + i * 0.0009, lon: START.lon }));
  return {
    trip: {
      legs: [{
        shape: encode(shape),
        maneuvers: [
          { type: 1, instruction: "Head north", street_names: ["Start Road"], length: 1, time: 600, begin_shape_index: 0 },
          { type: 10, instruction: "Turn right", street_names: ["Card Street"], length: 1, time: 600, begin_shape_index: 10 },
          { type: 4, instruction: "Arrive", length: 0, time: 0, begin_shape_index: 20 },
        ],
      }],
      summary: { length: 2, time: 1200 },
    },
  };
}

const OVERPASS = { elements: [{ type: "way", geometry: [{ lat: START.lat, lon: START.lon - 0.002 }, { lat: START.lat + 0.01, lon: START.lon - 0.002 }] }, { type: "count" }] };

function fakeBridge(glassView: "turns" | "overview") {
  let onEvent: ((event: unknown) => void) | undefined;
  let onLocation: ((location: unknown) => void) | undefined;
  const state = { images: [] as string[], exitModes: [] as unknown[], exitAnswer: true as boolean, locationStops: 0, body: "" };
  const bridge = {
    getLocalStorage: async () => JSON.stringify({
      valhallaUrl: "https://valhalla.test", mode: "walking", glassView,
      places: [{ id: "p1", label: "Office", at: { lat: START.lat + 0.018, lon: START.lon } }], destinationId: "p1",
    }),
    setLocalStorage: async () => true,
    rebuildPageContainer: async () => false,
    createStartUpPageContainer: async (page: { textObject?: { containerID?: number; content?: string }[] }) => {
      for (const text of page.textObject ?? []) if (text.containerID === 2) state.body = text.content ?? "";
      return 0;
    },
    textContainerUpgrade: async (upgrade: { containerID?: number; content?: string }) => { if (upgrade.containerID === 2) state.body = upgrade.content ?? ""; return true; },
    updateImageRawData: async (update: { containerName?: string }) => { state.images.push(update.containerName ?? ""); return "success"; },
    startAppLocationUpdates: async () => true,
    stopAppLocationUpdates: async () => { state.locationStops += 1; return true; },
    getAppLocation: async () => ({ latitude: START.lat, longitude: START.lon }),
    shutDownPageContainer: async (mode?: number) => { state.exitModes.push(mode); return state.exitAnswer; },
    onAppLocationChanged: (callback: (location: unknown) => void) => { onLocation = callback; return () => { onLocation = undefined; }; },
    onEvenHubEvent: (callback: (event: unknown) => void) => { onEvent = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, state,
    ready: () => onEvent !== undefined,
    gesture: (eventType: number) => onEvent?.({ sysEvent: { eventType, eventSource: 1 } }),
    move: (lat: number, lon: number) => onLocation?.({ latitude: lat, longitude: lon }),
    listening: () => onLocation !== undefined,
  };
}

const TAP = 0;
const DOUBLE_TAP = 3;

describe("what OpenGlance sends to the glasses and the network", () => {
  let routerCalls: number;
  let overpassCalls: string[];

  beforeEach(() => {
    routerCalls = 0;
    overpassCalls = [];
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("navigator", { language: "en-US", onLine: true });
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("document", { getElementById: () => null });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("overpass")) { overpassCalls.push(String(url)); return new Response(JSON.stringify(OVERPASS), { status: 200 }); }
      routerCalls += 1;
      return new Response(JSON.stringify(valhalla()), { status: 200 });
    }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function boot(fake: ReturnType<typeof fakeBridge>): Promise<void> {
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
  }
  const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it("asks the user to confirm the exit, and only then stops", async () => {
    const fake = fakeBridge("turns");
    await boot(fake);
    fake.gesture(DOUBLE_TAP);
    await vi.waitFor(() => expect(fake.state.exitModes).toEqual([1]));
    await settle();
    expect(fake.listening()).toBe(false);
    expect(fake.state.locationStops).toBe(1);
    // Closed: a tap no longer starts a route.
    fake.gesture(TAP);
    await settle();
    expect(routerCalls).toBe(0);
  });

  it("keeps running when the user cancels the exit", async () => {
    const fake = fakeBridge("turns");
    fake.state.exitAnswer = false;
    await boot(fake);
    fake.gesture(DOUBLE_TAP);
    await vi.waitFor(() => expect(fake.state.exitModes).toEqual([1]));
    await settle();
    expect(fake.listening()).toBe(true);
    expect(fake.state.locationStops).toBe(0);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(routerCalls).toBe(1));
    await vi.waitFor(() => expect(fake.state.body).toContain("Card Street"));
  });

  it("shows the distance large on the card and resends the arrow only when the turn changes", async () => {
    const fake = fakeBridge("turns");
    await boot(fake);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(fake.state.body).toContain("Card Street"));
    await settle();
    // The distance is on the card, not repeated in the text.
    expect(fake.state.body).not.toMatch(/\d+ m/);
    const arrowsBefore = fake.state.images.filter((name) => name === "pixel-icon").length;
    for (let i = 1; i <= 4; i++) { fake.move(START.lat + i * 0.0001, START.lon); await settle(5); }
    await settle();
    expect(fake.state.images.filter((name) => name === "pixel-icon").length).toBe(arrowsBefore);
  });

  it("fetches the overview streets once per route, after the overview has been up a moment", async () => {
    const fake = fakeBridge("overview");
    await boot(fake);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(routerCalls).toBe(1));
    await vi.waitFor(() => expect(fake.state.images).toContain("overview-map"));
    expect(overpassCalls).toHaveLength(0);
    // Streets arrive after the dwell, and the picture is sent once more with them.
    const before = fake.state.images.length;
    await vi.waitFor(() => expect(overpassCalls).toHaveLength(1), { timeout: 3000 });
    await vi.waitFor(() => expect(fake.state.images.length).toBe(before + 1));
    // GPS fixes a few metres apart neither refetch streets nor resend the map.
    const afterStreets = fake.state.images.length;
    for (let i = 1; i <= 3; i++) { fake.move(START.lat + i * 0.00003, START.lon); await settle(5); }
    await settle(100);
    expect(overpassCalls).toHaveLength(1);
    expect(fake.state.images.length).toBe(afterStreets);
  });
});

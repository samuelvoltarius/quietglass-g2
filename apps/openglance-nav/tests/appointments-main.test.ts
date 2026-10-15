import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app against a fake bridge (like main.test.ts) to check the
// appointment feature end to end: off without configuration, one request at
// start, no request storms, the row, the drive there and the HUD line.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
vi.mock("../src/glasses/pixel", () => ({ renderPixelIcon: async () => new Uint8Array([1]) }));
vi.mock("../src/glasses/street", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/glasses/street")>()),
  renderStreetPngs: async () => [new Uint8Array([3]), new Uint8Array([4])],
}));
vi.mock("../src/overview/draw", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/overview/draw")>()),
  renderMapTiles: async () => [1, 2, 3, 4].map((n) => new Uint8Array([n])),
}));

const START = { lat: 47.8, lon: 13.04 };
const PLACE = { lat: 47.9, lon: 13.12 };

function encode(points: readonly { lat: number; lon: number }[]): string {
  let out = "";
  let lastLat = 0;
  let lastLon = 0;
  const push = (delta: number): void => {
    let value = delta < 0 ? ~(delta << 1) : delta << 1;
    while (value >= 0x20) { out += String.fromCharCode((0x20 | (value & 0x1f)) + 63); value >>= 5; }
    out += String.fromCharCode(value + 63);
  };
  for (const point of points) {
    const lat = Math.round(point.lat * 1e6);
    const lon = Math.round(point.lon * 1e6);
    push(lat - lastLat); push(lon - lastLon);
    lastLat = lat; lastLon = lon;
  }
  return out;
}

/** A 10-minute drive (summary time 600 s) with a first turn far ahead. */
function valhalla(): unknown {
  const shape = [0, 1, 2].map((i) => ({ lat: START.lat + i * 0.01, lon: START.lon }));
  return {
    trip: {
      legs: [{
        shape: encode(shape),
        maneuvers: [
          { type: 1, instruction: "Head north", street_names: ["Start Road"], length: 1.1, time: 300, begin_shape_index: 0 },
          { type: 10, instruction: "Turn right", street_names: ["Far Road"], length: 1.1, time: 300, begin_shape_index: 1 },
          { type: 4, instruction: "Arrive", length: 0, time: 0, begin_shape_index: 2 },
        ],
      }],
      summary: { length: 2.2, time: 600 },
    },
  };
}

function fakeBridge() {
  let onEvent: ((event: unknown) => void) | undefined;
  let onLocation: ((location: unknown) => void) | undefined;
  const state = { texts: [] as string[], body: "", footer: "" };
  const record = (id: number | undefined, content: string | undefined): void => {
    state.texts.push(content ?? "");
    if (id === 2) state.body = content ?? "";
    if (id === 3) state.footer = content ?? "";
  };
  type Page = { textObject?: { containerID?: number; content?: string }[] };
  const bridge = {
    getLocalStorage: async () => JSON.stringify({
      valhallaUrl: "https://valhalla.test", mode: "walking", invertScroll: false,
      places: [{ id: "p1", label: "Office", at: { lat: START.lat + 0.004, lon: START.lon } }],
      destinationId: "p1",
    }),
    setLocalStorage: async () => true,
    rebuildPageContainer: async (page: Page) => { for (const t of page.textObject ?? []) record(t.containerID, t.content); return true; },
    createStartUpPageContainer: async (page: Page) => { for (const t of page.textObject ?? []) record(t.containerID, t.content); return 0; },
    textContainerUpgrade: async (u: { containerID?: number; content?: string }) => { record(u.containerID, u.content); return true; },
    updateImageRawData: async () => "success",
    audioControl: async () => true,
    startAppLocationUpdates: async () => true,
    stopAppLocationUpdates: async () => true,
    getAppLocation: async () => ({ latitude: START.lat, longitude: START.lon }),
    shutDownPageContainer: async () => true,
    onAppLocationChanged: (callback: (location: unknown) => void) => { onLocation = callback; return () => undefined; },
    onEvenHubEvent: (callback: (event: unknown) => void) => { onEvent = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
    getUserInfo: async () => ({}),
    getDeviceInfo: async () => ({}),
  };
  return {
    bridge, state,
    ready: () => onEvent !== undefined,
    fix: () => onLocation?.({ latitude: START.lat, longitude: START.lon, speed: 0 }),
    gesture: (eventType: number) => (resetGestureDedupe(), onEvent?.({ sysEvent: { eventType, eventSource: 1 } })),
  };
}

const TAP = 0;
const SWIPE_UP = 1;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("appointments in the running app", () => {
  let calls: string[];
  let briefBody: () => Response | Promise<Response>;

  beforeEach(() => {
    resetGestureDedupe();
    calls = [];
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("navigator", { language: "en-US", onLine: true });
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("document", { getElementById: () => null });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const startMs = Date.now() + 40 * 60_000;
    briefBody = () => new Response(JSON.stringify({
      date: "2026-10-14",
      events: [{ time: "", title: "Testkunde Termin", place: "Hauptstr. 5, Musterdorf", allDay: false, startIso: new Date(startMs).toISOString(), lat: PLACE.lat, lon: PLACE.lon, placeLabel: "Musterdorf" }],
    }));
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push(url + (init?.headers ? " auth=" + ((init.headers as Record<string, string>).Authorization ?? "") : ""));
      if (url.includes("/brief/")) return briefBody();
      if (url.includes("valhalla.test")) return new Response(JSON.stringify(valhalla()));
      throw new TypeError("unexpected " + url);
    }));
  });

  let current: ReturnType<typeof fakeBridge> | null = null;
  afterEach(async () => {
    // Leave the app (system exit) so its timers stop - 2x while navigating only asks to stop.
    current?.gesture(7);
    current = null;
    harness.bridge = null;
    await pause(20);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function boot(fake: ReturnType<typeof fakeBridge>): Promise<void> {
    harness.bridge = fake.bridge;
    current = fake;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
  }
  const briefCalls = (): string[] => calls.filter((c) => c.includes("/brief/"));
  const routeCalls = (): string[] => calls.filter((c) => c.includes("valhalla.test"));

  it("is off without an address: no request, no row", async () => {
    vi.stubEnv("VITE_BRIEF_URL", "");
    vi.stubEnv("VITE_BRIEF_TOKEN", "tok");
    const fake = fakeBridge();
    await boot(fake);
    fake.fix();
    await pause(2300);
    expect(briefCalls()).toEqual([]);
    expect(routeCalls()).toEqual([]);
    expect(fake.state.body).not.toContain("▸");
  });

  it("asks once at start, lists the appointment first, one drive-time request, no storm", { timeout: 15_000 }, async () => {
    vi.stubEnv("VITE_BRIEF_URL", "https://hub.test/");
    vi.stubEnv("VITE_BRIEF_TOKEN", "tok");
    const fake = fakeBridge();
    await boot(fake);
    fake.fix();
    await vi.waitFor(() => expect(fake.state.body).toMatch(/leave in \d+ min/), { timeout: 5000 });
    expect(briefCalls()).toEqual(["https://hub.test/brief/appointments auth=Bearer tok"]);
    // 40 min to the start, 10 min drive, 5 min buffer: leave in 24 or 25 min.
    // Next to the departure the title gives way (42 characters); time and place stay.
    expect(fake.state.body).toMatch(/▸ \d\d:\d\d Musterdorf · leave in 2[45] min/);
    expect(fake.state.texts.join("\n")).toMatch(/▸ \d\d:\d\d Testkunde Termin · Musterdorf/); // before the drive time was known
    expect(fake.state.body.split("\n")[0]).toMatch(/^ {2}▸/); // the cursor stayed on the active destination
    expect(fake.state.body.split("\n")[1]).toContain("→ ● Office");
    await pause(4500); // two more ticks
    expect(briefCalls()).toHaveLength(1);
    expect(routeCalls()).toHaveLength(1);

    // Swipe onto the appointment, tap: driving there, the footer compares arrival and start.
    fake.gesture(SWIPE_UP);
    await pause(50);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(routeCalls()).toHaveLength(2), { timeout: 3000 });
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/Arrive \d\d:\d\d · 3\d min early/), { timeout: 3000 });
  });

  it("a failing daemon changes nothing and is not asked again before 5 min", { timeout: 15_000 }, async () => {
    vi.stubEnv("VITE_BRIEF_URL", "https://hub.test");
    vi.stubEnv("VITE_BRIEF_TOKEN", "tok");
    briefBody = () => { throw new TypeError("Failed to fetch"); };
    const fake = fakeBridge();
    await boot(fake);
    fake.fix();
    await pause(4500);
    expect(briefCalls()).toHaveLength(1);
    expect(routeCalls()).toEqual([]);
    expect(fake.state.body).toContain("→ ● Office");
    expect(fake.state.body).not.toContain("▸");
  });
});

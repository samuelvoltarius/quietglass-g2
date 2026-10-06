import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app against a fake bridge, so route ordering, stopping and
// the close path can be checked without glasses, GPS or a Valhalla server.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
// Canvas is unavailable in node; the arrow bitmap is not what these tests are about.
vi.mock("../src/glasses/pixel", () => ({ renderPixelIcon: async () => new Uint8Array([1]) }));

// tsconfig carries no node types; reach the process object structurally.
const nodeProcess = (globalThis as unknown as {
  process: {
    on(event: string, listener: (reason: unknown) => void): void;
    off(event: string, listener: (reason: unknown) => void): void;
  };
}).process;

const START = { lat: 47.8, lon: 13.04 };

/** Encodes points the way Valhalla does, at precision 6. */
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

/** A Valhalla answer whose second manoeuvre joins `street`. */
function valhalla(street: string): unknown {
  const shape = [0, 1, 2].map((i) => ({ lat: START.lat + i * 0.002, lon: START.lon }));
  return {
    trip: {
      legs: [{
        shape: encode(shape),
        maneuvers: [
          { type: 1, instruction: "Head north", street_names: ["Start Road"], length: 0.22, time: 60, begin_shape_index: 0 },
          { type: 10, instruction: "Turn right", street_names: [street], length: 0.22, time: 60, begin_shape_index: 1 },
          { type: 4, instruction: "Arrive", length: 0, time: 0, begin_shape_index: 2 },
        ],
      }],
      summary: { length: 0.44, time: 120 },
    },
  };
}

// Plain functions rather than vi.fn: spies attach handlers to returned
// promises, which would hide exactly the rejections these tests look for.
function fakeBridge() {
  let onEvent: ((event: unknown) => void) | undefined;
  const state = { locationStarts: 0, shutdowns: 0, shutdownFails: false, draws: 0, body: "" };
  const record = (id: number | undefined, content: string | undefined): void => {
    state.draws += 1;
    if (id === 2) state.body = content ?? "";
  };
  const bridge = {
    getLocalStorage: async () => JSON.stringify({
      valhallaUrl: "https://valhalla.test", mode: "walking", invertScroll: false,
      places: [{ id: "p1", label: "Office", at: { lat: START.lat + 0.004, lon: START.lon } }],
      destinationId: "p1",
    }),
    setLocalStorage: async () => true,
    rebuildPageContainer: async () => false,
    createStartUpPageContainer: async (page: { textObject?: { containerID?: number; content?: string }[] }) => {
      for (const text of page.textObject ?? []) record(text.containerID, text.content);
      return 0;
    },
    textContainerUpgrade: async (upgrade: { containerID?: number; content?: string }) => {
      record(upgrade.containerID, upgrade.content);
      return true;
    },
    updateImageRawData: async () => "success",
    startAppLocationUpdates: async () => { state.locationStarts += 1; return true; },
    stopAppLocationUpdates: async () => true,
    getAppLocation: async () => ({ latitude: START.lat, longitude: START.lon }),
    shutDownPageContainer: (): Promise<boolean> => {
      state.shutdowns += 1;
      return state.shutdownFails ? Promise.reject(new Error("page already gone")) : Promise.resolve(true);
    },
    onAppLocationChanged: () => () => undefined,
    onEvenHubEvent: (callback: (event: unknown) => void) => { onEvent = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, state,
    ready: () => onEvent !== undefined,
    gesture: (eventType: number) => onEvent?.({ sysEvent: { eventType, eventSource: 1 } }),
  };
}

const TAP = 0;
const DOUBLE_TAP = 3;
const HOLD = 9;

describe("openglance lifecycle", () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  let replies: ((body: unknown) => void)[];

  beforeEach(() => {
    unhandled = [];
    replies = [];
    nodeProcess.on("unhandledRejection", onUnhandled);
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("document", { getElementById: () => null });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      replies.push((body) => resolve(new Response(JSON.stringify(body), { status: 200 })));
    })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(unhandled).toEqual([]);
  });

  async function boot(fake: ReturnType<typeof fakeBridge>): Promise<void> {
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  it("never lets an older route answer overwrite a newer one", async () => {
    // Regression: each tap started a request without retiring the last, so a
    // slow first answer landed after the second and replaced it.
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(2));

    replies[1]?.(valhalla("New Street"));
    await vi.waitFor(() => expect(fake.state.body).toContain("New Street"));
    replies[0]?.(valhalla("Old Street"));
    await settle();
    expect(fake.state.body).toContain("New Street");
    expect(fake.state.body).not.toContain("Old Street");
  });

  it("stays stopped when a route arrives after a hold", async () => {
    // Regression: holding while the route was loading cleared navigation, and
    // then the answer arrived and switched it straight back on.
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    fake.gesture(HOLD);
    await settle();
    replies[0]?.(valhalla("Late Street"));
    await settle();
    expect(fake.state.body).toContain("No route.");
    expect(fake.state.body).not.toContain("Late Street");
  });

  it("turns location updates back on when navigation starts again after a hold", async () => {
    // Regression: the hold stopped location updates and nothing restarted
    // them, so the second trip's arrow never moved past the first fix.
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    replies[0]?.(valhalla("First Street"));
    await vi.waitFor(() => expect(fake.state.body).toContain("First Street"));

    fake.gesture(HOLD);
    await settle();
    const before = fake.state.locationStarts;
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(fake.state.locationStarts).toBeGreaterThan(before);
  });

  it("closes cleanly on double tap: no unhandled rejection and no redraw afterwards", async () => {
    // Regression: a failing shutDownPageContainer escaped as an unhandled
    // rejection, and the 2 s redraw kept running after the page was closed.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fake = fakeBridge();
    fake.state.shutdownFails = true;
    await boot(fake);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    replies[0]?.(valhalla("Main Street"));
    await vi.waitFor(() => expect(fake.state.body).toContain("Main Street"));

    fake.gesture(DOUBLE_TAP);
    await vi.waitFor(() => expect(fake.state.shutdowns).toBe(1));
    await settle();
    const drawsAtClose = fake.state.draws;
    fake.gesture(TAP);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fake.state.draws).toBe(drawsAtClose);
    expect(replies).toHaveLength(1);
  });
});

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
vi.mock("../src/overview/draw", () => ({ renderRoutePng: async () => new Uint8Array([2]) }));

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
  const state = {
    locationStarts: 0, shutdowns: 0, shutdownFails: false, draws: 0, body: "", header: "",
    noFix: false, pages: [] as string[], images: [] as string[], saved: "",
  };
  const record = (id: number | undefined, content: string | undefined): void => {
    state.draws += 1;
    if (id === 2) state.body = content ?? "";
    if (id === 1) state.header = content ?? "";
  };
  const bridge = {
    getLocalStorage: async () => JSON.stringify({
      valhallaUrl: "https://valhalla.test", mode: "walking", invertScroll: false,
      places: [{ id: "p1", label: "Office", at: { lat: START.lat + 0.004, lon: START.lon } }],
      destinationId: "p1",
    }),
    setLocalStorage: async (_key: string, value: string) => { state.saved = value; return true; },
    rebuildPageContainer: async () => false,
    createStartUpPageContainer: async (page: { textObject?: { containerID?: number; content?: string }[]; imageObject?: { containerName?: string }[] }) => {
      state.pages.push(page.imageObject?.[0]?.containerName ?? "text-only");
      for (const text of page.textObject ?? []) record(text.containerID, text.content);
      return 0;
    },
    textContainerUpgrade: async (upgrade: { containerID?: number; content?: string }) => {
      record(upgrade.containerID, upgrade.content);
      return true;
    },
    updateImageRawData: async (update: { containerName?: string }) => { state.images.push(update.containerName ?? ""); return "success"; },
    startAppLocationUpdates: async () => { state.locationStarts += 1; return true; },
    stopAppLocationUpdates: async () => true,
    getAppLocation: async () => (state.noFix ? null : { latitude: START.lat, longitude: START.lon }),
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
const SWIPE = 1;
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
    // The glasses text follows the device language; pin it so assertions
    // do not depend on the machine running the tests.
    vi.stubGlobal("navigator", { language: "en-US", onLine: true });
    vi.stubGlobal("localStorage", undefined);
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
    // The second request waits out the one-per-second limit of the public router.
    await vi.waitFor(() => expect(replies).toHaveLength(2), { timeout: 3000 });

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
    // Idle again, with the destination still chosen and ready to restart.
    expect(fake.state.body).toContain("Tap to start.");
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
    await vi.waitFor(() => expect(replies).toHaveLength(2), { timeout: 3000 });
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
  it("switches to the overview map on a swipe, and back", async () => {
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    replies[0]?.(valhalla("Map Street"));
    await vi.waitFor(() => expect(fake.state.body).toContain("Map Street"));

    fake.gesture(SWIPE);
    await vi.waitFor(() => expect(fake.state.pages.at(-1)).toBe("overview-map"));
    await vi.waitFor(() => expect(fake.state.images).toContain("overview-map"));
    expect(fake.state.header).toBe("Overview");
    expect(fake.state.body).toContain("Map Street");
    // The choice is remembered for next time.
    expect(JSON.parse(fake.state.saved).glassView).toBe("overview");

    fake.gesture(SWIPE);
    await vi.waitFor(() => expect(fake.state.pages.at(-1)).toBe("pixel-icon"));
    // Switching views is local: it never asks the router again.
    expect(replies).toHaveLength(1);
  });

  it("says in plain German that there is no GPS, without asking the router", async () => {
    vi.stubGlobal("navigator", { language: "de-DE", onLine: true });
    const fake = fakeBridge();
    fake.state.noFix = true;
    await boot(fake);
    expect(fake.state.body).toContain("Ziel: Office");
    fake.gesture(TAP);
    await vi.waitFor(() => expect(fake.state.body).toContain("Kein GPS — geh ins Freie"));
    expect(replies).toHaveLength(0);
  });

  it("says there is no connection when the phone is offline", async () => {
    vi.stubGlobal("navigator", { language: "en-US", onLine: false });
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(fake.state.body).toContain("No connection"));
    expect(replies).toHaveLength(0);
  });
});

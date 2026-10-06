import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app against a fake bridge so the render/route lifecycle can be checked without hardware.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
// Canvas is unavailable in node; the PNG bytes are not what these tests are about.
vi.mock("../src/map/draw", () => ({ renderRoutePng: async () => new Uint8Array([1]) }));

// tsconfig carries no node types; reach the process object structurally.
const nodeProcess = (globalThis as unknown as { process: { on(event: string, listener: (reason: unknown) => void): void; off(event: string, listener: (reason: unknown) => void): void } }).process;

// Plain functions rather than vi.fn: vitest's spies attach handlers to returned promises, which would hide rejections.
function fakeBridge() {
  let onEvent: ((event: unknown) => void) | undefined;
  let onLocation: ((location: { latitude: number; longitude: number }) => void) | undefined;
  const state = { createFails: false, imageFailures: 0, imageCalls: 0, stopFails: false, shutdowns: 0 };
  const bridge = {
    createStartUpPageContainer: (): Promise<number> => state.createFails ? Promise.reject(new Error("not connected")) : Promise.resolve(0),
    updateImageRawData: (): Promise<number> => { state.imageCalls += 1; if (state.imageFailures > 0) { state.imageFailures -= 1; return Promise.reject(new Error("ble busy")); } return Promise.resolve(0); },
    textContainerUpgrade: (): Promise<boolean> => Promise.resolve(true),
    getAppLocation: (): Promise<null> => Promise.resolve(null),
    startAppLocationUpdates: (): Promise<boolean> => Promise.resolve(true),
    stopAppLocationUpdates: (): Promise<boolean> => state.stopFails ? Promise.reject(new Error("gps gone")) : Promise.resolve(true),
    shutDownPageContainer: (): Promise<boolean> => { state.shutdowns += 1; return Promise.resolve(true); },
    onAppLocationChanged: (callback: typeof onLocation) => { onLocation = callback; return () => undefined; },
    onEvenHubEvent: (callback: (event: unknown) => void) => { onEvent = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, state,
    ready: () => onEvent !== undefined,
    tap: (eventType: number) => onEvent?.({ sysEvent: { eventType, eventSource: 1 } }),
    move: (latitude: number, longitude: number) => onLocation?.({ latitude, longitude }),
  };
}

const routeBody = { points: [{ lat: 47.8, lon: 13.0 }, { lat: 47.81, lon: 13.01 }], instruction: "Links", distanceMeters: 40, road: "A" };

describe("map-glass lifecycle", () => {
  let store: Map<string, string>;
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  beforeEach(() => {
    store = new Map();
    unhandled = [];
    nodeProcess.on("unhandledRejection", onUnhandled);
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("document", { querySelector: () => null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(routeBody), { status: 200 })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    vi.unstubAllGlobals(); vi.restoreAllMocks();
    expect(unhandled).toEqual([]);
  });

  async function boot(fake: ReturnType<typeof fakeBridge>): Promise<void> {
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
  }

  it("keeps updating the map after one image transfer fails", async () => {
    // Regression: `sending = sending.then(...)` stayed rejected after one failure, so the map froze for good.
    const fake = fakeBridge();
    fake.state.imageFailures = 1;
    await boot(fake);
    await vi.waitFor(() => expect(fake.state.imageCalls).toBeGreaterThanOrEqual(1));
    const before = fake.state.imageCalls;
    fake.move(47.805, 13.005);
    await vi.waitFor(() => expect(fake.state.imageCalls).toBeGreaterThan(before));
  });

  it("still wires up input when the first page create fails", async () => {
    // Regression: a rejected createStartUpPageContainer rejected boot() before any handler was registered.
    const fake = fakeBridge();
    fake.state.createFails = true;
    await boot(fake);
    expect(fake.ready()).toBe(true);
  });

  it("routes to the default destination when the stored latitude is blank", async () => {
    store.set("mapglass.destLat", ""); store.set("mapglass.destLon", "");
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    const url = vi.mocked(fetch).mock.calls[0]?.[0] as URL;
    expect(url.searchParams.get("destLat")).toBe("47.8131");
    expect(url.searchParams.get("destLon")).toBe("13.0458");
  });

  it("survives a bridge address without a scheme", async () => {
    // Regression: `new URL("127.0.0.1:8791/route")` threw outside the try → unhandled rejection on every tap.
    store.set("mapglass.bridge", "127.0.0.1:8791/route");
    const fake = fakeBridge();
    await boot(fake);
    fake.tap(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shuts down on double tap even if stopping location updates fails", async () => {
    const fake = fakeBridge();
    await boot(fake);
    fake.state.stopFails = true;
    fake.tap(3);
    await vi.waitFor(() => expect(fake.state.shutdowns).toBe(1));
  });
});

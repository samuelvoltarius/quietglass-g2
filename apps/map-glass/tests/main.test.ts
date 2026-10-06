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
  const state = { createFails: false, imageFailures: 0, imageCalls: 0, stopFails: false, shutdowns: 0, fix: { latitude: 47.79, longitude: 13.04 } as { latitude: number; longitude: number } | null, footers: [] as string[] };
  const bridge = {
    createStartUpPageContainer: (): Promise<number> => state.createFails ? Promise.reject(new Error("not connected")) : Promise.resolve(0),
    updateImageRawData: (): Promise<number> => { state.imageCalls += 1; if (state.imageFailures > 0) { state.imageFailures -= 1; return Promise.reject(new Error("ble busy")); } return Promise.resolve(0); },
    textContainerUpgrade: (upgrade: { content?: string }): Promise<boolean> => { state.footers.push(upgrade.content ?? ""); return Promise.resolve(true); },
    getAppLocation: (): Promise<{ latitude: number; longitude: number } | null> => Promise.resolve(state.fix),
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

  const lastFooter = (fake: ReturnType<typeof fakeBridge>): string => fake.state.footers[fake.state.footers.length - 1] ?? "";

  it("waits for a GPS fix instead of routing from the Salzburg demo point", async () => {
    // Regression: without a fix the route silently started at the hard-coded demo origin.
    const fake = fakeBridge();
    fake.state.fix = null;
    await boot(fake);
    await vi.waitFor(() => expect(lastFooter(fake)).toBe("Waiting for GPS fix..."));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
    fake.move(48.2, 16.37);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const url = vi.mocked(fetch).mock.calls[0]?.[0] as URL;
    expect([url.searchParams.get("lat"), url.searchParams.get("lon")]).toEqual(["48.2", "16.37"]);
    await vi.waitFor(() => expect(lastFooter(fake)).toBe("40 m  Links"));
  });

  it("uses the demo origin only in explicit demo mode, and labels it", async () => {
    store.set("mapglass.demo", "1");
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    const url = vi.mocked(fetch).mock.calls[0]?.[0] as URL;
    expect([url.searchParams.get("lat"), url.searchParams.get("lon")]).toEqual(["47.806", "13.052"]);
    await vi.waitFor(() => expect(lastFooter(fake)).toBe("40 m  Links  [DEMO]"));
  });

  it("shows the translated demo route when the bridge is down in demo mode", async () => {
    // Regression: the demo instruction was German ("Rechts auf Sterneckstrasse") in every language.
    store.set("mapglass.demo", "1"); store.set("quietglass.locale", "fr");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 502 })));
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(lastFooter(fake)).toBe("180 m  Tournez à droite sur Sterneckstrasse  [DÉMO]\nItinéraire indisponible : HTTP 502"));
  });

  it("translates the fallback instruction when the bridge sends none", async () => {
    store.set("quietglass.locale", "it");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...routeBody, instruction: undefined }), { status: 200 })));
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(lastFooter(fake)).toBe("40 m  Segui il percorso"));
  });

  it("tells the user when the route cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(lastFooter(fake)).toBe("Route unavailable: HTTP 503"));
  });

  it("never lets an older route reply overwrite a newer one", async () => {
    // Regression: each tap started a request without cancelling the last; a slow first reply landed after the second.
    const replies: Array<(body: unknown) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { replies.push((body) => resolve(new Response(JSON.stringify(body), { status: 200 }))); })));
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    fake.tap(0);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    replies[1]?.({ ...routeBody, instruction: "Newer", distanceMeters: 10 });
    await vi.waitFor(() => expect(lastFooter(fake)).toBe("10 m  Newer"));
    replies[0]?.({ ...routeBody, instruction: "Older", distanceMeters: 99 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.state.footers.some((footer) => footer.includes("Older"))).toBe(false);
    expect(lastFooter(fake)).toBe("10 m  Newer");
  });

  it("shows the waiting state on the phone, even when the glasses page is not there", async () => {
    // Regression: drawMap returned before renderPhone when the page was not created, so the phone never updated.
    const app = { innerHTML: "" };
    vi.stubGlobal("document", { querySelector: (selector: string) => selector === "#app" ? app : null });
    const fake = fakeBridge();
    fake.state.createFails = true; fake.state.fix = null;
    await boot(fake);
    await vi.waitFor(() => expect(app.innerHTML).toContain("Waiting for GPS fix..."));
    fake.move(48.2, 16.37);
    await vi.waitFor(() => expect(app.innerHTML).toContain("<span>Links</span>"));
  });

  it("escapes bridge text on the phone", async () => {
    const app = { innerHTML: "" };
    vi.stubGlobal("document", { querySelector: (selector: string) => selector === "#app" ? app : null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...routeBody, instruction: "<img src=x onerror=alert(1)>", road: "<b>" }), { status: 200 })));
    await boot(fakeBridge());
    await vi.waitFor(() => expect(app.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;"));
    expect(app.innerHTML).not.toContain("<img");
  });

  it("shuts down on double tap even if stopping location updates fails", async () => {
    const fake = fakeBridge();
    await boot(fake);
    fake.state.stopFails = true;
    fake.tap(3);
    await vi.waitFor(() => expect(fake.state.shutdowns).toBe(1));
  });
});

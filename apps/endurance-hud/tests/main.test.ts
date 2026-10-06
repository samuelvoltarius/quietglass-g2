import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app against a fake bridge to check the polling loop without hardware.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
// Canvas is unavailable in node; the icon is not what these tests are about.
vi.mock("../src/glasses/pixel", () => ({ renderPixelIcon: async () => new Uint8Array([1]) }));

// tsconfig carries no node types; reach the process object structurally.
const nodeProcess = (globalThis as unknown as { process: { on(event: string, listener: (reason: unknown) => void): void; off(event: string, listener: (reason: unknown) => void): void } }).process;

function fakeBridge() {
  let handler: ((event: unknown) => void) | undefined;
  // Plain functions, not vi.fn: vitest's spies attach handlers to returned promises, which would hide unhandled rejections.
  const shutdown = { calls: 0, fail: false };
  const pages: string[][] = [];
  const bridge = {
    rebuildPageContainer: vi.fn(async () => true),
    createStartUpPageContainer: vi.fn(async (page: { textObject?: { content?: string }[] }) => { pages.push((page.textObject ?? []).map((part) => part.content ?? "")); return 0; }),
    textContainerUpgrade: vi.fn(async (update: { containerID?: number; content?: string }) => { if (update.containerID === 1) pages.push([]); pages.at(-1)?.push(update.content ?? ""); return true; }),
    updateImageRawData: vi.fn(async () => 0),
    shutDownPageContainer: (): Promise<boolean> => { shutdown.calls += 1; return shutdown.fail ? Promise.reject(new Error("ble gone")) : Promise.resolve(true); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return { bridge, shutdown, pages, emit: (eventType: number) => handler?.({ sysEvent: { eventType, eventSource: 1 } }), ready: () => handler !== undefined };
}

describe("endurance polling loop", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("document", { querySelector: () => null });
    // A bridge that accepts the connection and never answers.
    fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function boot() {
    const fake = fakeBridge();
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    return fake;
  }

  it("keeps at most one request in flight against a stalled bridge", async () => {
    // Regression: setInterval fired refresh() every 2 s regardless, stacking unbounded pending fetches.
    await boot();
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500); // first poll times out at 4 s
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops polling and shuts down on double tap even if shutdown rejects", async () => {
    // Regression: `void bridge.shutDownPageContainer()` left a rejection unhandled.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    nodeProcess.on("unhandledRejection", onUnhandled);
    const fake = await boot();
    fake.shutdown.fail = true;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10000);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(fake.shutdown.calls).toBe(1);
    // Only the boot poll and at most one interval poll before the double tap.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("endurance gestures, staleness and phone page", () => {
  let store: Map<string, string>;
  let app: { innerHTML: string };
  let reply: () => Promise<Response>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12));
    store = new Map();
    app = { innerHTML: "" };
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } });
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("document", { activeElement: null, querySelector: (selector: string) => selector === "#app" ? app : null });
    reply = async () => new Response(JSON.stringify({ sport: "bike", speedKph: 30, source: "garmin", updatedAt: new Date().toISOString() }), { status: 200 });
    vi.stubGlobal("fetch", vi.fn(() => reply()));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function boot() {
    const fake = fakeBridge();
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.advanceTimersByTimeAsync(10);
    return fake;
  }

  it("regression: swipe cycles the sport and saves it instead of only refreshing", async () => {
    const fake = await boot();
    expect(fake.pages.at(-1)?.[1]).toMatch(/^BIKE/);
    expect(fake.pages.at(-1)?.[2]).toBe("Tap: refresh   Swipe: sport   2x: close");
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    fake.emit(2); // scroll down
    await vi.advanceTimersByTimeAsync(10);
    expect(store.get("endurance.sport")).toBe("run");
    expect(fake.pages.at(-1)?.[1]).toMatch(/^RUN .*\n\nPACE {2}2:00 \/km/s);
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
    fake.emit(1); // scroll up
    await vi.advanceTimersByTimeAsync(10);
    expect(store.get("endurance.sport")).toBe("bike");
  });

  it("restores the saved sport on start", async () => {
    store.set("endurance.sport", "run");
    const fake = await boot();
    expect(fake.pages.at(-1)?.[1]).toMatch(/^RUN/);
  });

  it("tap refreshes", async () => {
    const fake = await boot();
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(10);
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls + 1);
  });

  it("regression: values stop being LIVE when the watch stops sending", async () => {
    const sentAt = new Date().toISOString();
    reply = async () => new Response(JSON.stringify({ sport: "bike", speedKph: 30, source: "garmin", updatedAt: sentAt }), { status: 200 });
    const fake = await boot();
    expect(fake.pages.at(-1)?.[0]).toBe("ENDURANCE HUD  LIVE WORKOUT");
    await vi.advanceTimersByTimeAsync(12000);
    expect(fake.pages.at(-1)?.[0]).toBe("ENDURANCE HUD  STALE 12s");
  });

  it("regression: a dead bridge shows STALE and the error on the phone", async () => {
    const fake = await boot();
    reply = async () => { throw new TypeError("Failed to fetch"); };
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.pages.at(-1)?.[0]).toBe("ENDURANCE HUD  STALE 2s");
    expect(app.innerHTML).toContain("Last error: Failed to fetch");
  });

  it("regression: the saved endpoint is escaped in the phone page", async () => {
    store.set("endurance.endpoint", 'http://x/"><img src=x onerror=alert(1)>');
    await boot();
    expect(app.innerHTML).not.toContain("<img");
    expect(app.innerHTML).toContain('value="http://x/&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
  });
});

import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app (demo mode, no backend) against a fake bridge to check the exit dialog wiring.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => {
  // main.ts only boots when `window` exists, but the real SDK would then try to
  // attach to a WebView host. Load it with `window` hidden; only the enums and
  // page classes are used from it.
  const scope = globalThis as { window?: unknown };
  const saved = scope.window;
  scope.window = undefined;
  try {
    return { ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()), waitForEvenAppBridge: async () => harness.bridge };
  } finally {
    scope.window = saved;
  }
});

// tsconfig carries no node types; reach the process object structurally.
const nodeProcess = (globalThis as unknown as { process: { on(event: string, listener: (reason: unknown) => void): void; off(event: string, listener: (reason: unknown) => void): void } }).process;

function fakeBridge() {
  let handler: ((event: unknown) => void) | undefined;
  // Plain functions, not vi.fn: vitest's spies attach handlers to returned promises, which would hide unhandled rejections.
  const shutdown = { modes: [] as (number | undefined)[], answer: (): Promise<boolean> => Promise.resolve(true) };
  const writes = { count: 0, creates: 0, rebuilds: 0 };
  const storage = { value: "" };
  let deviceHandler: ((status: unknown) => void) | undefined;
  const bridge = {
    getLocalStorage: async () => storage.value,
    setLocalStorage: async () => true,
    rebuildPageContainer: async () => { writes.rebuilds += 1; return true; },
    createStartUpPageContainer: async () => {
      writes.count += 1;
      writes.creates += 1;
      // A page write takes a while over BLE; overlapping draws would show here.
      await new Promise((done) => setTimeout(done, 300));
      return 0;
    },
    textContainerUpgrade: async () => { writes.count += 1; return true; },
    updateImageRawData: async () => { writes.count += 1; return "success"; },
    shutDownPageContainer: (mode?: number): Promise<boolean> => { shutdown.modes.push(mode); return shutdown.answer(); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: (callback: (status: unknown) => void) => { deviceHandler = callback; return () => undefined; },
  };
  return { bridge, shutdown, writes, storage, reconnect: () => deviceHandler?.({ connectType: "connected" }), emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })), ready: () => handler !== undefined };
}

describe("agent-glass exit dialog", () => {
  beforeEach(() => {
  resetGestureDedupe();
    vi.useFakeTimers();
    // main.ts only boots inside a browser window.
    vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal("location", { search: "?demo=1", pathname: "/", hash: "" });
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null, addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function boot() {
    const fake = fakeBridge();
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    // Let the first page land (the fake takes 300 ms per creation).
    await vi.advanceTimersByTimeAsync(400);
    return fake;
  }

  it("asks for the system dialog (mode 1) and stops drawing once the user confirms", async () => {
    const fake = await boot();
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    const writesAtClose = fake.writes.count;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.writes.count).toBe(writesAtClose);
  });

  it("keeps the elapsed counter running when the user cancels", async () => {
    const fake = await boot();
    fake.shutdown.answer = () => Promise.resolve(false);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    const writesAtCancel = fake.writes.count;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.writes.count).toBeGreaterThan(writesAtCancel);
  });

  it("keeps running when the exit call rejects, without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    nodeProcess.on("unhandledRejection", onUnhandled);
    const fake = await boot();
    fake.shutdown.answer = () => Promise.reject(new Error("ble gone"));
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    const writesAtFailure = fake.writes.count;
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(fake.writes.count).toBeGreaterThan(writesAtFailure);
  });

  it("regression: a dead backend never makes the glasses deaf — the double tap exits at once", async () => {
    vi.stubGlobal("location", { search: "", pathname: "/", hash: "" });
    // Even Terminal never answers.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const fake = fakeBridge();
    fake.storage.value = JSON.stringify({ provider: "even-terminal", baseUrl: "http://127.0.0.1:3456", token: "t0ken", sessionId: "s1" });
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
  });

  it("regression: the ticker and the first draw never create the start-up page twice", async () => {
    const fake = await boot();
    await vi.advanceTimersByTimeAsync(3000);
    expect(fake.writes.creates).toBe(1);
  });

  it("a reconnect rebuilds the page instead of creating it again", async () => {
    const fake = await boot();
    await vi.advanceTimersByTimeAsync(1000);
    const rebuilds = fake.writes.rebuilds;
    fake.reconnect();
    await vi.advanceTimersByTimeAsync(400);
    expect(fake.writes.rebuilds).toBe(rebuilds + 1);
    expect(fake.writes.creates).toBe(1);
  });

  it("leaving through the system stops drawing; coming back rebuilds; a system exit ends it", async () => {
    const fake = await boot();
    await vi.advanceTimersByTimeAsync(1000);
    fake.emit(5);
    await vi.advanceTimersByTimeAsync(400);
    const writes = fake.writes.count;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.writes.count).toBe(writes);
    const rebuilds = fake.writes.rebuilds;
    fake.emit(4);
    await vi.advanceTimersByTimeAsync(400);
    expect(fake.writes.rebuilds).toBe(rebuilds + 1);
    fake.emit(7);
    await vi.advanceTimersByTimeAsync(400);
    const after = fake.writes.count;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.writes.count).toBe(after);
  });
});


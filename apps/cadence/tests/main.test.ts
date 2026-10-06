import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app against a fake bridge to check the run loop without hardware.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
// Canvas is unavailable in node; the icon is not what these tests are about.
vi.mock("../src/glasses/pixel", () => ({ renderPixelIcon: async () => new Uint8Array([1]) }));

// tsconfig carries no node types; reach the process object structurally.
const nodeProcess = (globalThis as unknown as { process: { on(event: string, listener: (reason: unknown) => void): void; off(event: string, listener: (reason: unknown) => void): void } }).process;

function fakeBridge(writeDelayMs = 0) {
  let handler: ((event: unknown) => void) | undefined;
  // Plain functions, not vi.fn: vitest's spies attach handlers to returned promises, which would hide unhandled rejections.
  const shutdown = { calls: 0, fail: false, confirm: true, modes: [] as (number | undefined)[] };
  const writes = { count: 0, inFlight: 0, maxInFlight: 0, body: "" };
  const write = async (content: string, isBody: boolean): Promise<void> => {
    writes.count += 1;
    writes.inFlight += 1;
    writes.maxInFlight = Math.max(writes.maxInFlight, writes.inFlight);
    if (writeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
    if (isBody) writes.body = content;
    writes.inFlight -= 1;
  };
  const bridge = {
    getLocalStorage: async () => "",
    setLocalStorage: async () => true,
    rebuildPageContainer: async () => true,
    createStartUpPageContainer: async (page: { textObject?: { containerID?: number; content?: string }[] }) => {
      await write((page.textObject ?? []).find((part) => part.containerID === 2)?.content ?? "", true);
      return 0;
    },
    textContainerUpgrade: async (update: { containerID?: number; content?: string }) => {
      await write(update.content ?? "", update.containerID === 2);
      return true;
    },
    updateImageRawData: async () => 0,
    shutDownPageContainer: (mode?: number): Promise<boolean> => { shutdown.calls += 1; shutdown.modes.push(mode); return shutdown.fail ? Promise.reject(new Error("ble gone")) : Promise.resolve(shutdown.confirm); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return { bridge, shutdown, writes, emit: (eventType: number) => handler?.({ sysEvent: { eventType, eventSource: 1 } }), ready: () => handler !== undefined };
}

describe("cadence run loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null });
    // The glasses follow the device language; these assertions read the English text.
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => undefined });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function boot(writeDelayMs = 0) {
    const fake = fakeBridge(writeDelayMs);
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    return fake;
  }

  it("keeps the bar count when the tempo changes mid-run", async () => {
    // Regression: the whole run was re-counted at the new tempo, so a swipe from 100 to 104 bpm after a minute jumped from bar 26 to bar 27.
    const fake = await boot();
    fake.emit(0); // start
    await vi.advanceTimersByTimeAsync(60_000); // 100 beats at 100 bpm
    expect(fake.writes.body).toContain("100 bpm");
    expect(fake.writes.body).toContain("bar 26");
    fake.emit(1); // tempo +4
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.writes.body).toContain("104 bpm");
    expect(fake.writes.body).toContain("bar 26");
  });

  it("never writes two frames to the glasses at once", async () => {
    // Regression: beat timer, the 1 s tick and gestures each started a page write, interleaving over BLE.
    const fake = await boot(120);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(5000);
    fake.emit(1);
    fake.emit(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.writes.count).toBeGreaterThan(3);
    expect(fake.writes.maxInFlight).toBe(1);
  });

  it("asks for the system exit dialog and stops drawing once the user confirms", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(2000);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    const writesAtClose = fake.writes.count;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.writes.count).toBe(writesAtClose);
  });

  it("keeps the beat running when the user cancels the exit dialog", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(2000);
    fake.shutdown.confirm = false;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    const writesAtCancel = fake.writes.count;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.writes.count).toBeGreaterThan(writesAtCancel);
    // Gestures still work after staying.
    fake.emit(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.writes.body).toContain("104 bpm");
  });

  it("keeps running when the exit call rejects, without an unhandled rejection", async () => {
    // Regression: `void bridge.shutDownPageContainer()` left a rejection unhandled. A rejected call means no dialog appeared, so the app stays.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    nodeProcess.on("unhandledRejection", onUnhandled);
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(2000);
    fake.shutdown.fail = true;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    const writesAtFailure = fake.writes.count;
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(fake.shutdown.calls).toBe(1);
    expect(fake.writes.count).toBeGreaterThan(writesAtFailure);
  });
});

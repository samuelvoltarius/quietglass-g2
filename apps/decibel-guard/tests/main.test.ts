import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app against a fake bridge to check the microphone and redraw loop without hardware.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
// Canvas is unavailable in node; the icon is not what these tests are about.
vi.mock("../src/glasses/pixel", () => ({ renderPixelIcon: async () => new Uint8Array([1]) }));

// tsconfig carries no node types; reach the process object structurally.
const nodeProcess = (globalThis as unknown as { process: { on(event: string, listener: (reason: unknown) => void): void; off(event: string, listener: (reason: unknown) => void): void } }).process;

function fakeBridge(options: { writeDelayMs?: number; micDelayMs?: number } = {}) {
  let handler: ((event: unknown) => void) | undefined;
  // Plain functions, not vi.fn: vitest's spies attach handlers to returned promises, which would hide unhandled rejections.
  const shutdown = { calls: 0, fail: false };
  const mic: boolean[] = [];
  const writes = { count: 0, inFlight: 0, maxInFlight: 0 };
  const write = async (): Promise<void> => {
    writes.count += 1;
    writes.inFlight += 1;
    writes.maxInFlight = Math.max(writes.maxInFlight, writes.inFlight);
    if (options.writeDelayMs) await new Promise((resolve) => setTimeout(resolve, options.writeDelayMs));
    writes.inFlight -= 1;
  };
  const bridge = {
    getLocalStorage: async () => "",
    setLocalStorage: async () => true,
    rebuildPageContainer: async () => true,
    createStartUpPageContainer: async () => { await write(); return 0; },
    textContainerUpgrade: async () => { await write(); return true; },
    updateImageRawData: async () => 0,
    audioControl: async (on: boolean) => {
      if (on && options.micDelayMs) await new Promise((resolve) => setTimeout(resolve, options.micDelayMs));
      mic.push(on);
      return true;
    },
    shutDownPageContainer: (): Promise<boolean> => { shutdown.calls += 1; return shutdown.fail ? Promise.reject(new Error("ble gone")) : Promise.resolve(true); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, shutdown, mic, writes,
    emit: (eventType: number) => handler?.({ sysEvent: { eventType, eventSource: 1 } }),
    audio: (amplitude: number) => {
      const pcm = new Uint8Array(320);
      for (let i = 0; i < pcm.length; i += 2) { pcm[i] = amplitude & 0xff; pcm[i + 1] = (amplitude >> 8) & 0x7f; }
      handler?.({ audioEvent: { audioPcm: pcm } });
    },
    ready: () => handler !== undefined,
  };
}

describe("decibelguard loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function boot(options: { writeDelayMs?: number; micDelayMs?: number } = {}) {
    const fake = fakeBridge(options);
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    return fake;
  }

  it("does not leave the microphone open when closed while it was opening", async () => {
    // Regression: stopListening() saw listening=false and returned, then the pending
    // audioControl(true) resolved after the double tap and left the mic open.
    const fake = await boot({ micDelayMs: 500 });
    fake.emit(0); // tap: start measuring
    await vi.advanceTimersByTimeAsync(100);
    fake.emit(3); // double tap while the mic is still opening
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.mic).toEqual([true, false]);
    expect(fake.shutdown.calls).toBe(1);
  });

  it("never writes two frames to the glasses at once while audio streams in", async () => {
    // Regression: every audio block started its own page write, piling them up over BLE.
    const fake = await boot({ writeDelayMs: 80 });
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 40; i++) {
      fake.audio(500 + i * 300);
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.writes.count).toBeGreaterThan(3);
    expect(fake.writes.maxInFlight).toBe(1);
  });

  it("stops drawing after a double tap, even if shutdown rejects", async () => {
    // Regression: the shutdown rejection after stopListening() was unhandled, and the 1 s tick kept drawing.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    nodeProcess.on("unhandledRejection", onUnhandled);
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(100);
    fake.shutdown.fail = true;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(100);
    const writesAtClose = fake.writes.count;
    fake.audio(20000);
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(fake.mic.at(-1)).toBe(false);
    expect(fake.writes.count).toBe(writesAtClose);
  });
});

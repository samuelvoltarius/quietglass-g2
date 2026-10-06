import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app (demo captions) against a fake bridge to check the exit dialog wiring.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

// tsconfig carries no node types; reach the process object structurally.
const nodeProcess = (globalThis as unknown as { process: { on(event: string, listener: (reason: unknown) => void): void; off(event: string, listener: (reason: unknown) => void): void } }).process;

function fakeBridge() {
  let handler: ((event: unknown) => void) | undefined;
  // Plain functions, not vi.fn: vitest's spies attach handlers to returned promises, which would hide unhandled rejections.
  const shutdown = { modes: [] as (number | undefined)[], answer: (): Promise<boolean> => Promise.resolve(true) };
  const writes = { count: 0 };
  const bridge = {
    rebuildPageContainer: async () => true,
    createStartUpPageContainer: async () => { writes.count += 1; return 0; },
    textContainerUpgrade: async () => { writes.count += 1; return true; },
    shutDownPageContainer: (mode?: number): Promise<boolean> => { shutdown.modes.push(mode); return shutdown.answer(); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return { bridge, shutdown, writes, emit: (eventType: number) => handler?.({ sysEvent: { eventType, eventSource: 1 } }), ready: () => handler !== undefined };
}

describe("podcaption exit dialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("document", { querySelector: () => null });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function bootPlaying() {
    const fake = fakeBridge();
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    fake.emit(0); // tap: play
    await vi.advanceTimersByTimeAsync(10);
    return fake;
  }

  it("asks for the system dialog (mode 1) and stops playback once the user confirms", async () => {
    const fake = await bootPlaying();
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    const writesAtClose = fake.writes.count;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fake.writes.count).toBe(writesAtClose);
  });

  it("keeps playing when the user cancels", async () => {
    const fake = await bootPlaying();
    fake.shutdown.answer = () => Promise.resolve(false);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    const writesAtCancel = fake.writes.count;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.writes.count).toBeGreaterThan(writesAtCancel);
  });

  it("keeps playing when the exit call rejects, without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    nodeProcess.on("unhandledRejection", onUnhandled);
    const fake = await bootPlaying();
    fake.shutdown.answer = () => Promise.reject(new Error("ble gone"));
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    const writesAtFailure = fake.writes.count;
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(fake.writes.count).toBeGreaterThan(writesAtFailure);
  });
});

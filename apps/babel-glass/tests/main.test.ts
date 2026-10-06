import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app (mock recogniser, no server) against a fake bridge to check the exit dialog and the microphone.
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
  const mic = { open: false, calls: [] as boolean[] };
  const writes = { count: 0, body: "" };
  const bridge = {
    getLocalStorage: async () => "",
    setLocalStorage: async () => true,
    rebuildPageContainer: async () => true,
    createStartUpPageContainer: async () => { writes.count += 1; return 0; },
    textContainerUpgrade: async (update: { content?: string }) => { writes.count += 1; writes.body = update.content ?? writes.body; return true; },
    audioControl: async (isOpen: boolean) => { mic.calls.push(isOpen); mic.open = isOpen; return true; },
    shutDownPageContainer: (mode?: number): Promise<boolean> => { shutdown.modes.push(mode); return shutdown.answer(); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return { bridge, shutdown, mic, writes, emit: (eventType: number) => handler?.({ sysEvent: { eventType, eventSource: 1 } }), ready: () => handler !== undefined };
}

describe("babel-glass exit dialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function bootListening() {
    const fake = fakeBridge();
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    fake.emit(0); // tap: start captions
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.mic.open).toBe(true);
    return fake;
  }

  it("closes the microphone, asks for the system dialog (mode 1) and stays closed on confirm", async () => {
    const fake = await bootListening();
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    expect(fake.mic.open).toBe(false);
    const writesAtClose = fake.writes.count;
    fake.emit(0); // a tap after leaving must not reopen the microphone
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.mic.open).toBe(false);
    expect(fake.writes.count).toBe(writesAtClose);
  });

  it("reopens the microphone and keeps captioning when the user cancels", async () => {
    const fake = await bootListening();
    fake.shutdown.answer = () => Promise.resolve(false);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    expect(fake.mic.calls).toEqual([true, false, true]);
    expect(fake.mic.open).toBe(true);
    const writesAtCancel = fake.writes.count;
    await vi.advanceTimersByTimeAsync(10_000); // the mock recogniser keeps producing lines
    expect(fake.writes.count).toBeGreaterThan(writesAtCancel);
  });

  it("does not open the microphone on cancel if captions were off", async () => {
    const fake = await bootListening();
    fake.emit(0); // tap: stop captions
    await vi.advanceTimersByTimeAsync(10);
    fake.shutdown.answer = () => Promise.resolve(false);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.mic.open).toBe(false);
    expect(fake.mic.calls).toEqual([true, false]);
  });

  it("restores the microphone when the exit call rejects, without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    nodeProcess.on("unhandledRejection", onUnhandled);
    const fake = await bootListening();
    fake.shutdown.answer = () => Promise.reject(new Error("ble gone"));
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(fake.shutdown.modes).toEqual([1]);
    expect(fake.mic.open).toBe(true);
  });
});

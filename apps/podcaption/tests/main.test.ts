import { resetGestureDedupe } from "../src/input/gestures";
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
  const writes = { count: 0, creates: 0 };
  const bridge = {
    rebuildPageContainer: async () => true,
    createStartUpPageContainer: async () => { writes.count += 1; writes.creates += 1; return 0; },
    textContainerUpgrade: async () => { writes.count += 1; return true; },
    shutDownPageContainer: (mode?: number): Promise<boolean> => { shutdown.modes.push(mode); return shutdown.answer(); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return { bridge, shutdown, writes, emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })), ready: () => handler !== undefined };
}

describe("podcaption exit dialog", () => {
  beforeEach(() => {
  resetGestureDedupe();
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

  it("asks for the system dialog (mode 1); the call resolving true (dialog shown) does not stop playback", async () => {
    const fake = await bootPlaying();
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    const writesAtAsk = fake.writes.count;
    await vi.advanceTimersByTimeAsync(10_000);
    // While the dialog may be on screen no timer draws (a page call could cover it).
    expect(fake.writes.count).toBe(writesAtAsk);
    fake.emit(1); // the next input restores the page; playback never stopped
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.writes.count).toBeGreaterThan(writesAtAsk);
  });

  it("stops playback once the system ends the app (sysEvent 7) after the dialog", async () => {
    const fake = await bootPlaying();
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    fake.emit(7);
    await vi.advanceTimersByTimeAsync(10);
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
    // While the dialog may be on screen no timer draws (a page call could cover it).
    expect(fake.writes.count).toBe(writesAtCancel);
    fake.emit(1); // the next input restores the page
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.writes.count).toBeGreaterThan(writesAtCancel);
  });

  it("no timer, poll or stream draws while the exit dialog may be on screen; a single 2x right after restores the page first and asks the dialog only then", async () => {
    const fake = await bootPlaying();
    const creates = fake.writes.creates;
    // The call resolves true as soon as the dialog is SHOWN, whatever the user answers later.
    fake.shutdown.answer = () => Promise.resolve(true);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    const callsAtAsk = fake.writes.count;
    await vi.advanceTimersByTimeAsync(10_000);
    // Timers, polls and streams keep collecting data but make no page call while the dialog may be on screen.
    expect(fake.writes.count).toBe(callsAtAsk);
    expect(fake.writes.creates).toBe(creates);
    // "No", then a single 2x as the very first event: the restore (create) must finish BEFORE the dialog is asked again
    // (hardware, Klipper 0.5.8: a dialog call issued while the page is being created is lost).
    const order: string[] = [];
    let releaseCreate!: () => void;
    const gate = new Promise<void>((done) => { releaseCreate = done; });
    const host = fake.bridge as unknown as Record<string, (...args: unknown[]) => unknown>;
    const realCreate = host["createStartUpPageContainer"]!;
    const realShutDown = host["shutDownPageContainer"]!;
    host["createStartUpPageContainer"] = async (...args: unknown[]) => { order.push("create:start"); await gate; const result = await realCreate.apply(fake.bridge, args); order.push("create:done"); return result; };
    host["shutDownPageContainer"] = (...args: unknown[]) => { order.push("shutdown"); return realShutDown.apply(fake.bridge, args); };
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(order).toEqual(["create:start"]); // the dialog is not asked while the page is still being created
    releaseCreate();
    await vi.advanceTimersByTimeAsync(1500);
    expect(order).toEqual(["create:start", "create:done", "shutdown"]); // restore first, then the dialog, exactly once more
  });

  it("hardware order (step log): 4 = dialog up -> nothing drawn; 5 = dialog gone after No -> page up again without a gesture, playback on, next 2x asks", async () => {
    const fake = await bootPlaying();
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(70);
    expect(fake.shutdown.modes).toEqual([1]);
    fake.emit(4);                                            // the dialog is on screen
    const atShown = fake.writes.count;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fake.writes.count).toBe(atShown);                 // nothing drawn over the dialog
    const creates = fake.writes.creates;
    fake.emit(5);                                            // "No": the dialog is gone
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.writes.creates).toBeGreaterThan(creates);    // page created again, no gesture needed
    const afterRestore = fake.writes.count;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.writes.count).toBeGreaterThan(afterRestore); // playback was never stopped
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.shutdown.modes).toEqual([1, 1]);             // the very first 2x opens the dialog again
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
    fake.emit(1);
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(fake.writes.count).toBeGreaterThan(writesAtFailure);
  });
});

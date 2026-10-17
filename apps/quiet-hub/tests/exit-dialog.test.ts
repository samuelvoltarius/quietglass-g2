import { ImageRawDataUpdateResult } from "@evenrealities/even_hub_sdk";
import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app (demo mode: no server set) against a fake bridge to check the exit dialog wiring.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

// Canvas is unavailable in node; the pixel icon is not what this test is about.
vi.mock("../src/glasses/pixel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/glasses/pixel")>()),
  renderPixelIcon: async () => new Uint8Array([1]),
}));

const DOUBLE_CLICK = 3;

function fakeBridge() {
  let handler: ((event: unknown) => void) | undefined;
  const shutdown = { modes: [] as (number | undefined)[], answer: (): Promise<boolean> => Promise.resolve(true) };
  const calls = { creates: 0, rebuilds: 0 };
  const bridge = {
    getLocalStorage: async () => "",
    setLocalStorage: async () => true,
    rebuildPageContainer: async () => { calls.rebuilds += 1; return true; },
    createStartUpPageContainer: async () => { calls.creates += 1; return 0; },
    textContainerUpgrade: async () => true,
    updateImageRawData: async () => ImageRawDataUpdateResult.success,
    audioControl: async () => true,
    shutDownPageContainer: (mode?: number): Promise<boolean> => { shutdown.modes.push(mode); return shutdown.answer(); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onLaunchSource: () => () => undefined,
    onDeviceStatusChanged: () => () => undefined,
  };
  return { bridge, shutdown, calls, emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })), ready: () => handler !== undefined };
}

const warns: string[] = [];

describe("quiet hub exit dialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("document", { querySelector: () => null });
    vi.spyOn(console, "warn").mockImplementation((...a) => { warns.push(a.map(String).join(" ")); });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    warns.length = 0;
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function boot() {
    const fake = fakeBridge();
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.advanceTimersByTimeAsync(200);
    return fake;
  }

  it("no timer, poll or stream draws while the exit dialog may be on screen; a single 2x right after restores the page first and asks the dialog only then", async () => {
    const fake = await boot();
    expect(warns).toEqual([]);
    expect(fake.calls.creates).toBe(1);
    // The call resolves true as soon as the dialog is SHOWN, whatever the user answers later.
    fake.shutdown.answer = () => Promise.resolve(true);
    fake.emit(DOUBLE_CLICK);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.shutdown.modes).toEqual([1]);
    const callsAtAsk = fake.calls.creates + fake.calls.rebuilds;
    await vi.advanceTimersByTimeAsync(5000);
    // Timers, polls and streams keep collecting data but make no page call while the dialog may be on screen.
    expect(fake.calls.creates + fake.calls.rebuilds).toBe(callsAtAsk);
    expect(fake.calls.creates).toBe(1);
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
    fake.emit(DOUBLE_CLICK);
    await vi.advanceTimersByTimeAsync(500);
    expect(order).toEqual(["create:start"]); // the dialog is not asked while the page is still being created
    releaseCreate();
    await vi.advanceTimersByTimeAsync(1500);
    expect(order).toEqual(["create:start", "create:done", "shutdown"]); // restore first, then the dialog, exactly once more
  });

  it("hardware order (step log 0.5.11): 4 = dialog up -> nothing drawn; 5 = dialog gone after No -> page up again, timers on, next 2x asks", async () => {
    const fake = await boot();
    const pageCalls = (): number => fake.calls.creates + fake.calls.rebuilds;
    fake.shutdown.answer = () => Promise.resolve(true);
    fake.emit(DOUBLE_CLICK);
    await vi.advanceTimersByTimeAsync(70);
    expect(fake.shutdown.modes).toEqual([1]);
    fake.emit(4);                                            // the dialog is on screen
    const atShown = pageCalls();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(pageCalls()).toBe(atShown);                       // nothing drawn over the dialog
    const timersBefore = vi.getTimerCount();
    fake.emit(5);                                            // "No": the dialog is gone
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pageCalls()).toBeGreaterThan(atShown);            // page up again at once, no gesture needed
    expect(fake.calls.creates).toBe(2);
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(timersBefore); // nothing was stopped
    await vi.advanceTimersByTimeAsync(12_000);
    expect(vi.getTimerCount()).toBeGreaterThan(0);           // timers still running
    fake.emit(DOUBLE_CLICK);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.shutdown.modes).toEqual([1, 1]);             // the very first 2x opens the dialog again
  });

  it("the exit call resolving does not put the page up again or close the app; the system ending it (sysEvent 7) does", async () => {
    const fake = await boot();
    fake.emit(DOUBLE_CLICK);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.shutdown.modes).toEqual([1]);
    expect(fake.calls.creates).toBe(1);
    fake.emit(7);
    await vi.advanceTimersByTimeAsync(100);
    // Closed for good: neither a new page nor another dialog.
    fake.emit(DOUBLE_CLICK);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.shutdown.modes).toEqual([1]);
    expect(fake.calls.creates).toBe(1);
  });
});

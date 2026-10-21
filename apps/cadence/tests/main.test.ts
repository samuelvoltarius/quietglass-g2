import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app against a fake bridge to check the run loop without hardware.
const harness = vi.hoisted(() => ({ bridge: null as unknown, models: [] as import("../src/cockpit/model").CockpitModel[] }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
// The cockpit is an image: the tests read the model that was drawn last.
vi.mock("../src/cockpit/compose", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/cockpit/compose")>();
  return { ...real, composeCockpit: (model: import("../src/cockpit/model").CockpitModel, backend: import("../src/screen/text").TextBackend) => { harness.models.push(model); return real.composeCockpit(model, backend); } };
});
const last = (): import("../src/cockpit/model").CockpitModel => harness.models[harness.models.length - 1]!;

// tsconfig carries no node types; reach the process object structurally.
const nodeProcess = (globalThis as unknown as { process: { on(event: string, listener: (reason: unknown) => void): void; off(event: string, listener: (reason: unknown) => void): void } }).process;

function fakeBridge(writeDelayMs = 0, storage = new Map<string, string>()) {
  let handler: ((event: unknown) => void) | undefined;
  // Plain functions, not vi.fn: vitest's spies attach handlers to returned promises, which would hide unhandled rejections.
  const shutdown = { calls: 0, fail: false, confirm: true, modes: [] as (number | undefined)[] };
  const writes = { count: 0, creates: 0, rebuilds: 0, inFlight: 0, maxInFlight: 0, tiles: 0 };
  const write = async (): Promise<void> => {
    writes.count += 1;
    writes.inFlight += 1;
    writes.maxInFlight = Math.max(writes.maxInFlight, writes.inFlight);
    if (writeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
    writes.inFlight -= 1;
  };
  const bridge = {
    getLocalStorage: async (key: string) => storage.get(key) ?? "",
    setLocalStorage: async (key: string, value: string) => { storage.set(key, value); return true; },
    rebuildPageContainer: async () => { writes.rebuilds += 1; return true; },
    createStartUpPageContainer: async () => { writes.creates += 1;
      await write();
      return 0;
    },
    textContainerUpgrade: async () => true,
    updateImageRawData: async () => { writes.tiles += 1; await write(); return "success"; },
    shutDownPageContainer: (mode?: number): Promise<boolean> => { shutdown.calls += 1; shutdown.modes.push(mode); return shutdown.fail ? Promise.reject(new Error("ble gone")) : Promise.resolve(shutdown.confirm); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return { bridge, shutdown, writes, storage, emit: (eventType: number, eventSource = 1) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource } })), ready: () => handler !== undefined };
}

describe("cadence run loop", () => {
  beforeEach(() => {
  resetGestureDedupe();
    harness.models.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null });
    // The glasses follow the device language; these assertions read the English text.
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => undefined });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function boot(writeDelayMs = 0, storage = new Map<string, string>()) {
    const fake = fakeBridge(writeDelayMs, storage);
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
    expect(last().headline[0]).toBe("100 BPM");
    expect(last().graphic.center).toBe("26");
    fake.emit(1); // tempo +4
    await vi.advanceTimersByTimeAsync(10);
    expect(last().headline[0]).toBe("104 BPM");
    expect(last().graphic.center).toBe("26");
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

  it("asks for the system exit dialog; the call resolving true (dialog shown) does not stop the beat", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(2000);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    const writesAtAsk = fake.writes.count;
    await vi.advanceTimersByTimeAsync(5000);
    // While the dialog may be on screen no timer draws (a page call could cover it).
    expect(fake.writes.count).toBe(writesAtAsk);
    // The beat kept running: after the next input it draws again.
    fake.emit(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.writes.count).toBeGreaterThan(writesAtAsk);
  });

  it("the system ending the app (sysEvent 7) after the dialog stops drawing", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(2000);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    fake.emit(7);
    await vi.advanceTimersByTimeAsync(100);
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
    // While the dialog may be on screen no timer draws (a page call could cover it).
    expect(fake.writes.count).toBe(writesAtCancel);
    // Gestures still work after staying.
    fake.emit(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(last().headline[0]).toBe("104 BPM");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.writes.count).toBeGreaterThan(writesAtCancel);
  });

  it("no timer, poll or stream draws while the exit dialog may be on screen; a single 2x right after restores the page first and asks the dialog only then", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(2000);
    const creates = fake.writes.creates;
    // The call resolves true as soon as the dialog is SHOWN, whatever the user answers later.
    fake.shutdown.confirm = true;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.shutdown.modes).toEqual([1]);
    const callsAtAsk = fake.writes.count;
    await vi.advanceTimersByTimeAsync(5000);
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

  it("hardware order (step log): 4 = dialog up -> nothing drawn; 5 = dialog gone after No -> page up again without a gesture, beat running, next 2x asks", async () => {
    const fake = await boot();
    fake.emit(0); // the beat runs
    await vi.advanceTimersByTimeAsync(2000);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(70);
    expect(fake.shutdown.modes).toEqual([1]);
    fake.emit(4); // the dialog is on screen
    const atShown = fake.writes.count;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fake.writes.count).toBe(atShown); // nothing drawn over the dialog
    const creates = fake.writes.creates;
    fake.emit(5); // "No": the dialog is gone
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.writes.creates).toBeGreaterThan(creates); // page created again, no gesture needed
    const afterRestore = fake.writes.count;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.writes.count).toBeGreaterThan(afterRestore); // the beat and the tick were never stopped
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.shutdown.modes).toEqual([1, 1]); // the very first 2x opens the dialog again
  });

  it("a 2x while backgrounded (a 5 without a dialog) comes back and asks again after the restore draw", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(2000);
    fake.emit(5); // genuinely backgrounded
    await vi.advanceTimersByTimeAsync(200);
    const built = fake.writes.creates + fake.writes.rebuilds;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fake.writes.creates + fake.writes.rebuilds).toBeGreaterThan(built); // the page was put up again
    expect(fake.shutdown.modes).toEqual([1]); // and the dialog was asked, not swallowed
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
    fake.emit(1);
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(fake.shutdown.calls).toBe(1);
    expect(fake.writes.count).toBeGreaterThan(writesAtFailure);
  });

  it("starting again after a pause begins at bar 1 (no hold needed: the temple pad never delivers one)", async () => {
    const fake = await boot();
    fake.emit(0); // start
    await vi.advanceTimersByTimeAsync(60_000);
    expect(last().graphic.center).toBe("26");
    fake.emit(0); // arm
    await vi.advanceTimersByTimeAsync(100);
    fake.emit(0); // pause
    await vi.advanceTimersByTimeAsync(100);
    expect(last().headline[1]).toBe("PAUSED");
    fake.emit(0); // start again
    await vi.advanceTimersByTimeAsync(10);
    expect(last().graphic.center).toBe("1");
    expect(last().headline[1]).toBe("RUNNING");
    await vi.advanceTimersByTimeAsync(2400);
    expect(last().graphic.center).toBe("2");
  });

  it("an R1 ring hold (optional extra) starts the bar count over and keeps a running beat running", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(last().graphic.center).toBe("26");
    fake.emit(9, 2);
    await vi.advanceTimersByTimeAsync(700);
    expect(last().graphic.center).toBe("1");
    expect(last().headline[1]).toBe("RUNNING");
    await vi.advanceTimersByTimeAsync(2400);
    expect(last().graphic.center).toBe("2");
  });

  it("picks the beat up again after a restart (phone locked, app unloaded)", async () => {
    const storage = new Map<string, string>();
    const first = await boot(0, storage);
    first.emit(0);
    await vi.advanceTimersByTimeAsync(30_000);
    first.emit(5); // the system takes the app off the glasses
    await vi.advanceTimersByTimeAsync(10);
    expect(storage.get("quietglass.cadence.run.v1")).toContain('"running":true');

    await boot(0, storage);
    await vi.advanceTimersByTimeAsync(1100);
    expect(last().headline[1]).toBe("RUNNING");
    expect(Number(last().graphic.center)).toBeGreaterThan(1);
  });

  it("stops drawing in the background and rebuilds on return", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(2000);
    fake.emit(5);
    await vi.advanceTimersByTimeAsync(10);
    const count = fake.writes.count;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.writes.count).toBe(count);
    fake.emit(4);
    await vi.advanceTimersByTimeAsync(1100);
    expect(fake.writes.count).toBeGreaterThan(count);
  });
});

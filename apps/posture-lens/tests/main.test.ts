import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageRawDataUpdateResult } from "@evenrealities/even_hub_sdk";

// Boots the real app against a fake bridge to check the IMU loop without hardware.
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

const IMU_DATA_REPORT = 8;

function fakeBridge(writeDelayMs = 0, stored = JSON.stringify({ reference: { x: 0, y: 0, z: 1 }, showAngleWhenGood: true })) {
  let handler: ((event: unknown) => void) | undefined;
  let statusHandler: ((status: unknown) => void) | undefined;
  // Plain functions, not vi.fn: vitest's spies attach handlers to returned promises, which would hide unhandled rejections.
  const shutdown = { calls: 0, fail: false, confirm: true, modes: [] as (number | undefined)[] };
  const imu: boolean[] = [];
  const saved: string[] = [];
  const images: string[] = [];
  const pages: { menuObject?: { menuItems?: { itemName?: string; itemID?: number }[] } }[] = [];
  const writes = { count: 0, inFlight: 0, maxInFlight: 0, creates: 0, rebuilds: 0, footer: "", header: "", body: "" };
  const paces: (number | undefined)[] = [];
  const imuAnswer = { hang: false };
  const write = async (): Promise<void> => {
    writes.count += 1;
    writes.inFlight += 1;
    writes.maxInFlight = Math.max(writes.maxInFlight, writes.inFlight);
    if (writeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
    writes.inFlight -= 1;
  };
  const capture = (page: { textObject?: { containerID?: number; content?: string }[] }): void => {
    for (const part of page.textObject ?? []) {
      if (part.containerID === 1) writes.header = part.content ?? "";
      if (part.containerID === 2) writes.body = part.content ?? "";
      if (part.containerID === 3) writes.footer = part.content ?? "";
    }
  };
  const bridge = {
    // Stored calibration, so the app starts measuring straight away.
    getLocalStorage: async () => stored,
    setLocalStorage: async (_key: string, value: string) => { saved.push(value); return true; },
    rebuildPageContainer: async (page: { textObject?: { containerID?: number; content?: string }[] }) => { writes.rebuilds += 1; capture(page); return true; },
    createStartUpPageContainer: async (page: { menuObject?: { menuItems?: { itemName?: string; itemID?: number }[] }; textObject?: { containerID?: number; content?: string }[] }) => { pages.push(page); capture(page); writes.creates += 1; await write(); return 0; },
    textContainerUpgrade: async (update: { containerID?: number; content?: string }) => {
      if (update.containerID === 3) writes.footer = update.content ?? "";
      if (update.containerID === 1) writes.header = update.content ?? "";
      if (update.containerID === 2) writes.body = update.content ?? "";
      await write();
      return true;
    },
    updateImageRawData: async (update: { containerName?: string }) => { await write(); images.push(update.containerName ?? ""); return ImageRawDataUpdateResult.success; },
    imuControl: (on: boolean, pace?: number): Promise<boolean> => { imu.push(on); if (on) paces.push(pace); return imuAnswer.hang ? new Promise(() => undefined) : Promise.resolve(true); },
    shutDownPageContainer: (mode?: number): Promise<boolean> => { shutdown.calls += 1; shutdown.modes.push(mode); return shutdown.fail ? Promise.reject(new Error("ble gone")) : Promise.resolve(shutdown.confirm); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: (callback: (status: unknown) => void) => { statusHandler = callback; return () => undefined; },
  };
  return {
    bridge, shutdown, imu, paces, writes, saved, images, imuAnswer, pages,
    menu: (itemID: number) => (resetGestureDedupe(), handler?.({ menuItemClickEvent: { itemID } })),
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
    sample: (y: number) => handler?.({ sysEvent: { eventType: IMU_DATA_REPORT, imuData: { x: 0, y, z: 1 } } }),
    longPress: () => (resetGestureDedupe(), handler?.({ sysEvent: { eventType: 9, eventSource: 1 } })),
    reconnect: () => statusHandler?.({ connectType: "connected" }),
    ready: () => handler !== undefined,
  };
}

describe("posturelens loop", () => {
  beforeEach(() => {
  resetGestureDedupe();
    harness.models.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function boot(writeDelayMs = 0, stored?: string) {
    const fake = stored === undefined ? fakeBridge(writeDelayMs) : fakeBridge(writeDelayMs, stored);
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    return fake;
  }

  it("asks for the system dialog; the call resolving true (dialog shown) keeps monitoring, and the IMU stream does not redraw over the dialog", async () => {
    const fake = await boot();
    fake.sample(0.1);
    await vi.advanceTimersByTimeAsync(600);
    const creates = fake.writes.creates;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    const writesAtAsk = fake.writes.count;
    for (let i = 1; i <= 5; i++) { fake.sample(i * 0.2); await vi.advanceTimersByTimeAsync(1000); }
    // While the dialog may be on screen no timer draws (a page call could cover it).
    expect(fake.writes.count).toBe(writesAtAsk);
    expect(fake.writes.creates).toBe(creates);
    fake.emit(1); // the next input restores the page; monitoring never stopped
    for (let i = 1; i <= 5; i++) { fake.sample(i * 0.2); await vi.advanceTimersByTimeAsync(1000); }
    expect(fake.writes.count).toBeGreaterThan(writesAtAsk);
    expect(fake.imu).not.toContain(false);
  });

  it("asks for the system dialog, then stops drawing and leaves the IMU off once the system ends the app (sysEvent 7)", async () => {
    // Regression: IMU samples and the 1 s tick kept writing to the closed page,
    // and a reconnect switched the IMU back on.
    const fake = await boot();
    fake.sample(0.1);
    await vi.advanceTimersByTimeAsync(600);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    fake.emit(7);
    await vi.advanceTimersByTimeAsync(10);
    const writesAtClose = fake.writes.count;
    for (let i = 1; i <= 5; i++) { fake.sample(i * 0.2); await vi.advanceTimersByTimeAsync(500); }
    fake.reconnect();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.writes.count).toBe(writesAtClose);
    expect(fake.imu.at(-1)).toBe(false);
  });

  it("keeps monitoring with the IMU on when the exit dialog is cancelled", async () => {
    const fake = await boot();
    fake.sample(0.1);
    await vi.advanceTimersByTimeAsync(600);
    fake.shutdown.confirm = false;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    const writesAtCancel = fake.writes.count;
    fake.emit(1);
    for (let i = 1; i <= 5; i++) { fake.sample(i * 0.2); await vi.advanceTimersByTimeAsync(1000); }
    expect(fake.writes.count).toBeGreaterThan(writesAtCancel);
    expect(fake.imu).not.toContain(false);
  });

  it("no timer, poll or stream draws while the exit dialog may be on screen; a single 2x right after restores the page first and asks the dialog only then", async () => {
    const fake = await boot();
    fake.sample(0.1);
    await vi.advanceTimersByTimeAsync(600);
    const creates = fake.writes.creates;
    // The call resolves true as soon as the dialog is SHOWN, whatever the user answers later.
    fake.shutdown.confirm = true;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.shutdown.modes).toEqual([1]);
    const callsAtAsk = fake.writes.count + fake.images.length;
    for (let i = 1; i <= 5; i++) { fake.sample(i * 0.2); await vi.advanceTimersByTimeAsync(1000); }
    // Timers, polls and streams keep collecting data but make no page call while the dialog may be on screen.
    expect(fake.writes.count + fake.images.length).toBe(callsAtAsk);
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

  it("hardware order (step log): 4 = dialog up -> nothing drawn; 5 = dialog gone after No -> page up again without a gesture, IMU on, next 2x asks", async () => {
    const fake = await boot();
    fake.sample(0.1);
    await vi.advanceTimersByTimeAsync(600);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(70);
    expect(fake.shutdown.modes).toEqual([1]);
    fake.emit(4);                                            // the dialog is on screen
    const atShown = fake.writes.count + fake.writes.rebuilds + fake.images.length;
    for (let i = 1; i <= 12; i++) { fake.sample(i * 0.2); await vi.advanceTimersByTimeAsync(1000); }
    expect(fake.writes.count + fake.writes.rebuilds + fake.images.length).toBe(atShown); // nothing drawn over the dialog
    const creates = fake.writes.creates;
    fake.emit(5);                                            // "No": the dialog is gone
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.writes.creates).toBeGreaterThan(creates);    // page created again, no gesture needed
    const afterRestore = fake.writes.count + fake.writes.rebuilds + fake.images.length;
    for (let i = 1; i <= 5; i++) { fake.sample(i * 0.1); await vi.advanceTimersByTimeAsync(1000); }
    expect(fake.writes.count + fake.writes.rebuilds + fake.images.length).toBeGreaterThan(afterRestore); // monitoring never stopped
    expect(fake.imu).not.toContain(false);                   // the 4/5 paused nothing
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.shutdown.modes).toEqual([1, 1]);             // the very first 2x opens the dialog again
  });

  it("a 2x while the app thinks it is in the background (5 without a dialog) comes back and asks again", async () => {
    const fake = await boot();
    fake.sample(0.1);
    await vi.advanceTimersByTimeAsync(600);
    fake.emit(5);                                            // genuine background: paused, IMU off
    await vi.advanceTimersByTimeAsync(500);
    const rebuilt = fake.writes.creates + fake.writes.rebuilds;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.writes.creates + fake.writes.rebuilds).toBeGreaterThan(rebuilt); // the page is back first
    expect(fake.shutdown.modes).toEqual([1]);                // and the dialog is asked, not swallowed
  });

  it("keeps monitoring when the exit call rejects, without an unhandled rejection", async () => {
    // Regression: the shutdown rejection was unhandled.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    nodeProcess.on("unhandledRejection", onUnhandled);
    const fake = await boot();
    fake.sample(0.1);
    await vi.advanceTimersByTimeAsync(600);
    fake.shutdown.fail = true;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    const writesAtFailure = fake.writes.count;
    fake.emit(1);
    for (let i = 1; i <= 5; i++) { fake.sample(i * 0.2); await vi.advanceTimersByTimeAsync(1000); }
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(fake.shutdown.calls).toBe(1);
    expect(fake.writes.count).toBeGreaterThan(writesAtFailure);
    expect(fake.imu).not.toContain(false);
  });

  it("never writes two frames to the glasses at once", async () => {
    // Regression: each IMU sample and the 1 s tick started its own page write.
    const fake = await boot(150);
    for (let i = 0; i < 20; i++) { fake.sample((i % 7) * 0.15); await vi.advanceTimersByTimeAsync(100); }
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.writes.count).toBeGreaterThan(3);
    expect(fake.writes.maxInFlight).toBe(1);
  });

  it("keeps a first-run tap that arrives before the motion sensor does", async () => {
    // A beginner taps as soon as the glasses say so; that tap must not be lost.
    const fake = await boot(0, "");
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.saved).toEqual([]);
    fake.sample(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.saved).toHaveLength(1);
    expect(JSON.parse(fake.saved[0] ?? "{}").reference).toEqual({ x: 0, y: 0, z: 1 });
  });

  it("sends the four tiles once and does not resend them while the head holds still (the clock tile aside)", async () => {
    const fake = await boot();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i++) { fake.sample(0); await vi.advanceTimersByTimeAsync(500); }
    expect([...new Set(fake.images)].sort()).toEqual(["posture-ne", "posture-nw", "posture-se", "posture-sw"]);
    const settled = fake.images.length;
    for (let i = 0; i < 60; i++) { fake.sample(0.001 * (i % 3)); await vi.advanceTimersByTimeAsync(500); }
    // 30 s of a still head: only the clock in the upper right tile may have moved on.
    expect(fake.images.slice(settled).every((name) => name === "posture-ne")).toBe(true);
    expect(fake.images.length - settled).toBeLessThanOrEqual(1);
  });

  it("redraws the gauge when the head tilts: never more than one write per tile and sample", async () => {
    const fake = await boot();
    fake.sample(0);
    await vi.advanceTimersByTimeAsync(5000);
    const start = fake.images.length;
    // The head nods back and forth for 10 s: 20 samples.
    for (let i = 0; i < 20; i++) { fake.sample(i % 2 === 0 ? 0.6 : 0); await vi.advanceTimersByTimeAsync(500); }
    const sent = fake.images.slice(start);
    expect(sent.length).toBeGreaterThan(0);
    for (const name of ["posture-nw", "posture-ne", "posture-sw", "posture-se"]) {
      expect(sent.filter((n) => n === name).length, name).toBeLessThanOrEqual(21);
    }
  });

  it("regression: a hanging IMU call never makes the glasses deaf — the double tap exits", async () => {
    const fake = fakeBridge();
    fake.imuAnswer.hang = true;
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.imu).toEqual([true]);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
  });

  it("a hanging IMU call ends in the no-sensor screen instead of waiting forever", async () => {
    const fake = fakeBridge();
    fake.imuAnswer.hang = true;
    harness.bridge = fake.bridge;
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.advanceTimersByTimeAsync(6000);
    expect(last().headline).toEqual(["NO", "SENSOR"]);
    expect(last().hint).toBe("2× = exit");
    expect(last().cells[5]).toEqual({ label: "SENSOR", value: "OFF", alert: true });
  });

  it("one tap does not overwrite a saved posture; a second tap within the window does", async () => {
    vi.stubGlobal("navigator", { language: "en-US" });
    const fake = await boot();
    fake.sample(0.2);
    await vi.advanceTimersByTimeAsync(600);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(1100);
    expect(fake.saved).toEqual([]);
    expect(last().hint).toBe("Tap again = save again · Swipe/2× = cancel");
    expect(last().headline).toEqual(["SAVE", "AGAIN?"]);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.saved).toHaveLength(1);
  });

  it("an armed tap runs out after a few seconds", async () => {
    vi.stubGlobal("navigator", { language: "en-US" });
    const fake = await boot();
    fake.sample(0.2);
    await vi.advanceTimersByTimeAsync(600);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(last().hint).not.toContain("Tap again");
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.saved).toEqual([]);
  });

  it("a swipe never clears today's tally or arms anything", async () => {
    // QIS v1: a swipe only moves. It used to clear the tally on the second swipe.
    vi.stubGlobal("navigator", { language: "en-US" });
    const fake = await boot();
    for (let i = 0; i < 6; i++) { fake.sample(0); await vi.advanceTimersByTimeAsync(500); }
    await vi.advanceTimersByTimeAsync(1100);
    expect(last().headline).toEqual(["UPRIGHT"]);
    expect(last().cells[1]!.value).toBe("100%");
    for (const swipe of [1, 2, 1, 2]) { fake.emit(swipe); await vi.advanceTimersByTimeAsync(600); }
    await vi.advanceTimersByTimeAsync(1100);
    expect(last().cells[1]!.value).toBe("100%");
    expect(last().hint).toBe("Tap = save again · Hold = menu · 2× = exit");
  });

  describe("QUS v1: list, arm-and-confirm", () => {
    const HOLD = 9;
    const CLICK = 0;
    const DOWN = 2;
    const DOUBLE = 3;
    const step = async (fake: Awaited<ReturnType<typeof boot>>, type: number, ms = 600): Promise<void> => {
      fake.emit(type);
      await vi.advanceTimersByTimeAsync(ms);
    };
    async function booted() {
      vi.stubGlobal("navigator", { language: "en-US" });
      const fake = await boot();
      for (let i = 0; i < 6; i++) { fake.sample(0); await vi.advanceTimersByTimeAsync(500); }
      return fake;
    }


    it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
      const fake = await booted();
      expect(fake.pages.length).toBeGreaterThan(0);
      for (const page of fake.pages) expect(page.menuObject).toBeUndefined();
      // The hold opens the app's own list (at most three entries), not a side menu.
      await step(fake, HOLD);
      expect(fake.writes.header).toBe("POSTURE · menu");
      expect(fake.writes.body).toBe("● Sensor test\n  Clear today's tally");
      expect(fake.writes.footer).toBe("Tap = choose · Swipe = list · 2× = back");
      await step(fake, DOUBLE);
      expect(last().headline).toEqual(["UPRIGHT"]);
      expect(last().hint).toBe("Tap = save again · Hold = menu · 2× = exit");
      expect(fake.shutdown.modes).toEqual([]);
      for (const page of fake.pages) expect(page.menuObject).toBeUndefined();
    });

    it("clearing the tally by gesture: hold, swipe to the entry, tap arms, a second tap clears", async () => {
      const fake = await booted();
      expect(last().cells[1]!.value).toBe("100%");
      await step(fake, HOLD);
      await step(fake, DOWN);
      expect(fake.writes.body).toContain("● Clear today's tally");
      await step(fake, CLICK);
      expect(fake.writes.body).toContain("SURE? Clear today's tally");
      expect(fake.writes.footer).toBe("Tap again = clear tally · Swipe/2× = cancel");
      await step(fake, CLICK);
      expect(fake.writes.header).toBe("POSTURE · Tally cleared");
      await step(fake, DOUBLE);
      expect(last().cells[1]!.value).toBe("–");
    });

    it("a swipe, 2× or 4 s cancel the armed tally reset; nothing is cleared", async () => {
      const fake = await booted();
      await step(fake, HOLD);
      await step(fake, DOWN);
      await step(fake, CLICK);
      expect(fake.writes.body).toContain("SURE? ");
      await step(fake, DOWN);
      expect(fake.writes.body).not.toContain("SURE? ");
      await step(fake, CLICK);
      expect(fake.writes.body).toContain("SURE? ");
      await vi.advanceTimersByTimeAsync(4200);
      expect(fake.writes.body).not.toContain("SURE? ");
      await step(fake, CLICK);
      expect(fake.writes.body).toContain("SURE? ");
      await step(fake, DOUBLE);
      expect(last().cells[1]!.value).toBe("100%");
      expect(fake.shutdown.modes).toEqual([]);
    });

    it("a swipe cancels an armed re-calibration and saves nothing", async () => {
      const fake = await booted();
      await step(fake, CLICK);
      expect(last().hint).toBe("Tap again = save again · Swipe/2× = cancel");
      await step(fake, DOWN);
      expect(last().hint).toBe("Tap = save again · Hold = menu · 2× = exit");
      expect(fake.saved).toEqual([]);
    });

    it("the list holds the sensor test and the tally only (the help lives on the phone): 2× goes back to the posture screen, a further 2× leaves", async () => {
      const fake = await booted();
      await step(fake, HOLD);
      expect(fake.writes.body.split("\n")).toHaveLength(2);
      await step(fake, DOWN); await step(fake, DOWN); await step(fake, DOWN);
      expect(fake.writes.body).toContain("● Clear today's tally");
      await step(fake, HOLD); // a hold in the list does nothing
      expect(fake.writes.header).toBe("POSTURE · menu");
      await step(fake, DOUBLE);
      expect(last().headline).toEqual(["UPRIGHT"]);
      expect(fake.shutdown.modes).toEqual([]);
      await step(fake, DOUBLE);
      expect(fake.shutdown.modes).toEqual([1]);
    });

    it("the sensor test by gesture: hold, tap the first entry; 2× goes back to the list, then the posture screen", async () => {
      const fake = await booted();
      await step(fake, HOLD);
      await step(fake, CLICK);
      expect(fake.writes.header).toMatch(/Sensor/);
      await step(fake, HOLD);
      expect(fake.writes.header).toMatch(/Sensor/);
      await step(fake, DOUBLE);
      expect(fake.writes.header).toBe("POSTURE · menu");
      await step(fake, DOUBLE);
      expect(last().headline).toEqual(["UPRIGHT"]);
      expect(fake.shutdown.modes).toEqual([]);
    });
  });

  it("leaving through the system switches the IMU off; coming back rebuilds and switches it on", async () => {
    const fake = await boot();
    await vi.advanceTimersByTimeAsync(100);
    fake.emit(5);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.imu.at(-1)).toBe(false);
    const writes = fake.writes.count;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.writes.count).toBe(writes);
    const rebuilds = fake.writes.rebuilds;
    fake.emit(4);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.writes.rebuilds).toBe(rebuilds + 1);
    expect(fake.writes.creates).toBe(1);
    expect(fake.imu.at(-1)).toBe(true);
  });

  it("a system exit switches the IMU off and stops drawing", async () => {
    const fake = await boot();
    await vi.advanceTimersByTimeAsync(100);
    fake.emit(6);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.imu.at(-1)).toBe(false);
    const writes = fake.writes.count;
    for (let i = 1; i <= 5; i++) { fake.sample(i * 0.2); await vi.advanceTimersByTimeAsync(500); }
    expect(fake.writes.count).toBe(writes);
  });

  it("a reconnect rebuilds the page, never creates it twice, and restarts the IMU", async () => {
    const fake = await boot();
    await vi.advanceTimersByTimeAsync(100);
    const imuCalls = fake.imu.length;
    fake.reconnect();
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.writes.creates).toBe(1);
    expect(fake.writes.rebuilds).toBe(2);
    expect(fake.imu.length).toBe(imuCalls + 1);
  });

  describe("sensor test", () => {
    it("switches to raw values from the side menu and back on 2×, text upgrades only", async () => {
      vi.stubGlobal("navigator", { language: "en-US" });
      const fake = await boot();
      fake.sample(0.1);
      await vi.advanceTimersByTimeAsync(600);
      const createsBefore = fake.writes.creates;
      const rebuildsBefore = fake.writes.rebuilds;
      fake.menu(1); // side menu: the sensor test
      for (let i = 1; i <= 4; i++) { fake.sample(i * 0.25); await vi.advanceTimersByTimeAsync(100); }
      await vi.advanceTimersByTimeAsync(300);
      expect(fake.writes.header).toMatch(/Sensor/);
      expect(fake.writes.body).toContain("y   1.00");
      expect(fake.writes.body).toMatch(/y .*●/);
      expect(fake.writes.creates).toBe(createsBefore);
      // Leaving the cockpit for the text page is one rebuild; after that text upgrades only.
      expect(fake.writes.rebuilds).toBe(rebuildsBefore + 1);
      fake.emit(3); // 2x: back out of the test
      await vi.advanceTimersByTimeAsync(300);
      expect(last().headline).toEqual(["UPRIGHT"]);
    });

    it("redraws at most five times a second, however fast the samples come", async () => {
      const fake = await boot();
      fake.sample(0.1);
      await vi.advanceTimersByTimeAsync(600);
      fake.menu(1);
      await vi.advanceTimersByTimeAsync(300);
      const before = fake.writes.count;
      // 50 samples in one second (20 ms apart), each one different.
      for (let i = 0; i < 50; i++) { fake.sample(i * 0.01); await vi.advanceTimersByTimeAsync(20); }
      // Three containers per redraw; at most ~5 redraws plus the 1 s tick.
      expect(fake.writes.count - before).toBeLessThanOrEqual(6 * 3);
    });

    it("does not calibrate on a tap while the test is open", async () => {
      const fake = await boot(0, JSON.stringify({ reference: null }));
      fake.sample(0.1);
      await vi.advanceTimersByTimeAsync(600);
      fake.menu(1); // the sensor test
      await vi.advanceTimersByTimeAsync(300);
      fake.emit(0);
      await vi.advanceTimersByTimeAsync(300);
      fake.emit(0);
      await vi.advanceTimersByTimeAsync(600);
      expect(fake.saved.some((value) => value.includes('"reference":{'))).toBe(false);
    });
  });
});


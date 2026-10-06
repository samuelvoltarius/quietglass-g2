import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageRawDataUpdateResult } from "@evenrealities/even_hub_sdk";

// Boots the real app against a fake bridge to check the IMU loop without hardware.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
// Canvas is unavailable in node; the icon is not what these tests are about.
vi.mock("../src/glasses/pixel", () => ({ encodePng: async () => new Uint8Array([1]) }));

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
  const writes = { count: 0, inFlight: 0, maxInFlight: 0 };
  const write = async (): Promise<void> => {
    writes.count += 1;
    writes.inFlight += 1;
    writes.maxInFlight = Math.max(writes.maxInFlight, writes.inFlight);
    if (writeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
    writes.inFlight -= 1;
  };
  const bridge = {
    // Stored calibration, so the app starts measuring straight away.
    getLocalStorage: async () => stored,
    setLocalStorage: async (_key: string, value: string) => { saved.push(value); return true; },
    rebuildPageContainer: async () => true,
    createStartUpPageContainer: async () => { await write(); return 0; },
    textContainerUpgrade: async () => { await write(); return true; },
    updateImageRawData: async (update: { containerName?: string }) => { images.push(update.containerName ?? ""); return ImageRawDataUpdateResult.success; },
    imuControl: async (on: boolean) => { imu.push(on); return true; },
    shutDownPageContainer: (mode?: number): Promise<boolean> => { shutdown.calls += 1; shutdown.modes.push(mode); return shutdown.fail ? Promise.reject(new Error("ble gone")) : Promise.resolve(shutdown.confirm); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: (callback: (status: unknown) => void) => { statusHandler = callback; return () => undefined; },
  };
  return {
    bridge, shutdown, imu, writes, saved, images,
    emit: (eventType: number) => handler?.({ sysEvent: { eventType, eventSource: 1 } }),
    sample: (y: number) => handler?.({ sysEvent: { eventType: IMU_DATA_REPORT, imuData: { x: 0, y, z: 1 } } }),
    reconnect: () => statusHandler?.({ connectType: "connected" }),
    ready: () => handler !== undefined,
  };
}

describe("posturelens loop", () => {
  beforeEach(() => {
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

  it("asks for the system dialog, then stops drawing and leaves the IMU off once confirmed", async () => {
    // Regression: IMU samples and the 1 s tick kept writing to the closed page,
    // and a reconnect switched the IMU back on.
    const fake = await boot();
    fake.sample(0.1);
    await vi.advanceTimersByTimeAsync(600);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
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
    for (let i = 1; i <= 5; i++) { fake.sample(i * 0.2); await vi.advanceTimersByTimeAsync(1000); }
    expect(fake.writes.count).toBeGreaterThan(writesAtCancel);
    expect(fake.imu).not.toContain(false);
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

  it("does not resend the head gauge while the head holds still", async () => {
    const fake = await boot();
    for (let i = 0; i < 10; i++) { fake.sample(0); await vi.advanceTimersByTimeAsync(500); }
    // Before the first sample the gauge has no head yet; with it, the head appears.
    expect(fake.images).toEqual(["pixel-icon", "pixel-icon"]);
    for (let i = 0; i < 60; i++) { fake.sample(0.001 * (i % 3)); await vi.advanceTimersByTimeAsync(500); }
    expect(fake.images).toHaveLength(2);
  });

  it("redraws the gauge when the head tilts, at most every few seconds", async () => {
    const fake = await boot();
    fake.sample(0);
    await vi.advanceTimersByTimeAsync(5000);
    const start = fake.images.length;
    // The head nods back and forth for 10 s.
    for (let i = 0; i < 20; i++) { fake.sample(i % 2 === 0 ? 0.6 : 0); await vi.advanceTimersByTimeAsync(500); }
    const sent = fake.images.length - start;
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThanOrEqual(4);
  });
});

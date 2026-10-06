import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageRawDataUpdateResult } from "@evenrealities/even_hub_sdk";

// Boots the real app against a fake bridge to check the microphone and redraw loop without hardware.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
// Canvas is unavailable in node; the icon is not what these tests are about.
vi.mock("../src/glasses/pixel", () => ({ encodePng: async () => new Uint8Array([1]) }));

// tsconfig carries no node types; reach the process object structurally.
const nodeProcess = (globalThis as unknown as { process: { on(event: string, listener: (reason: unknown) => void): void; off(event: string, listener: (reason: unknown) => void): void } }).process;

function fakeBridge(options: { writeDelayMs?: number; micDelayMs?: number; micRefusals?: number; imageDelayMs?: number } = {}) {
  let handler: ((event: unknown) => void) | undefined;
  // Plain functions, not vi.fn: vitest's spies attach handlers to returned promises, which would hide unhandled rejections.
  const shutdown = { calls: 0, fail: false, confirm: true, modes: [] as (number | undefined)[] };
  const mic: boolean[] = [];
  const texts: string[] = [];
  const images: string[] = [];
  let refusals = options.micRefusals ?? 0;
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
    createStartUpPageContainer: async (page: { textObject?: { content?: string }[] }) => { texts.push(...(page.textObject ?? []).map((part) => part.content ?? "")); await write(); return 0; },
    textContainerUpgrade: async (update: { content?: string }) => { texts.push(update.content ?? ""); await write(); return true; },
    updateImageRawData: async (update: { containerName?: string }) => {
      if (options.imageDelayMs) await new Promise((resolve) => setTimeout(resolve, options.imageDelayMs));
      images.push(update.containerName ?? "");
      return ImageRawDataUpdateResult.success;
    },
    audioControl: async (on: boolean) => {
      if (on && options.micDelayMs) await new Promise((resolve) => setTimeout(resolve, options.micDelayMs));
      if (on && refusals > 0) { refusals -= 1; return false; }
      mic.push(on);
      return true;
    },
    shutDownPageContainer: (mode?: number): Promise<boolean> => { shutdown.calls += 1; shutdown.modes.push(mode); return shutdown.fail ? Promise.reject(new Error("ble gone")) : Promise.resolve(shutdown.confirm); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, shutdown, mic, writes, texts, images,
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

  async function boot(options: { writeDelayMs?: number; micDelayMs?: number; micRefusals?: number; imageDelayMs?: number } = {}) {
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

  it("closes the microphone, asks for the system dialog (mode 1) and stops drawing once confirmed", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(100);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.shutdown.modes).toEqual([1]);
    expect(fake.mic).toEqual([true, false]);
    const writesAtClose = fake.writes.count;
    fake.audio(20000);
    fake.emit(0); // a tap after leaving must not reopen the microphone
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.mic).toEqual([true, false]);
    expect(fake.writes.count).toBe(writesAtClose);
  });

  it("reopens the microphone and keeps measuring when the exit dialog is cancelled", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(100);
    fake.shutdown.confirm = false;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.shutdown.modes).toEqual([1]);
    expect(fake.mic).toEqual([true, false, true]);
    const writesAtCancel = fake.writes.count;
    fake.audio(20000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fake.writes.count).toBeGreaterThan(writesAtCancel);
  });

  it("leaves the microphone off on cancel when it was off before", async () => {
    const fake = await boot();
    fake.shutdown.confirm = false;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.shutdown.modes).toEqual([1]);
    expect(fake.mic).toEqual([]);
  });

  it("restores the microphone when the exit call rejects, without an unhandled rejection", async () => {
    // Regression: the shutdown rejection after stopListening() was unhandled.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    nodeProcess.on("unhandledRejection", onUnhandled);
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(100);
    fake.shutdown.fail = true;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(100);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(fake.shutdown.calls).toBe(1);
    expect(fake.mic).toEqual([true, false, true]);
  });

  it("says what to do when the microphone is refused, and a tap retries", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => undefined });
    const fake = await boot({ micRefusals: 1 });
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.mic).toEqual([]);
    expect(fake.texts.join(" | ")).toContain("Microphone not available.");
    expect(fake.texts.join(" | ")).toContain("tap = try again");
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.mic).toEqual([true]);
    expect(fake.texts.at(-1)).toContain("● MIC");
  });

  it("draws the meter and the dose bar once, and not again while nothing changes", async () => {
    const fake = await boot();
    await vi.advanceTimersByTimeAsync(5000);
    expect([...fake.images].sort()).toEqual(["dose-bar", "pixel-icon"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.images).toHaveLength(2);
  });

  it("keeps updating text while an image transfer is slow", async () => {
    // Images go through their own lane; a stalled transfer must not hold up the readout.
    const fake = await boot({ imageDelayMs: 60_000 });
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(100);
    const before = fake.writes.count;
    for (let i = 0; i < 10; i++) {
      fake.audio(2000 + i * 2500);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(fake.writes.count).toBeGreaterThan(before);
    expect(fake.images).toEqual([]);
    expect(fake.texts.at(-1)).toContain("●");
  });

  it("sends the meter at most every few seconds while the level moves", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(5000);
    const start = fake.images.length;
    for (let i = 0; i < 100; i++) {
      fake.audio(i % 2 === 0 ? 500 : 20_000);
      await vi.advanceTimersByTimeAsync(100);
    }
    // 10 s of a level jumping every block: at most one meter write per 3 s (+ dose bar steps).
    const meterWrites = fake.images.slice(start).filter((name) => name === "pixel-icon").length;
    expect(meterWrites).toBeGreaterThan(0);
    expect(meterWrites).toBeLessThanOrEqual(4);
  });
});

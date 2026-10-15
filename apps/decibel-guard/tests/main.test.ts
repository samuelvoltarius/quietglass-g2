import { resetGestureDedupe } from "../src/input/gestures";
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

function fakeBridge(options: { writeDelayMs?: number; micDelayMs?: number; micRefusals?: number; imageDelayMs?: number; storage?: Map<string, string> } = {}) {
  const storage = options.storage ?? new Map<string, string>();
  let handler: ((event: unknown) => void) | undefined;
  // Plain functions, not vi.fn: vitest's spies attach handlers to returned promises, which would hide unhandled rejections.
  const shutdown = { calls: 0, fail: false, confirm: true, modes: [] as (number | undefined)[] };
  const mic: boolean[] = [];
  const texts: string[] = [];
  const images: string[] = [];
  const pages: { menuObject?: { menuItems?: { itemName?: string; itemID?: number }[] } }[] = [];
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
    getLocalStorage: async (key: string) => storage.get(key) ?? "",
    setLocalStorage: async (key: string, value: string) => { storage.set(key, value); return true; },
    rebuildPageContainer: async () => true,
    createStartUpPageContainer: async (page: { textObject?: { content?: string }[]; menuObject?: { menuItems?: { itemName?: string; itemID?: number }[] } }) => { pages.push(page); texts.push(...(page.textObject ?? []).map((part) => part.content ?? "")); await write(); return 0; },
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
    bridge, shutdown, mic, writes, texts, images, storage, pages,
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
    menu: (itemID: number) => (resetGestureDedupe(), handler?.({ menuItemClickEvent: { itemID } })),
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
  resetGestureDedupe();
    vi.useFakeTimers();
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function boot(options: { writeDelayMs?: number; micDelayMs?: number; micRefusals?: number; imageDelayMs?: number; storage?: Map<string, string> } = {}) {
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

  it("QIS v1.2: the exit dialog opens without stopping first; measuring ends only once it is confirmed", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(100);
    let microphoneDuringDialog: boolean[] = [];
    fake.shutdown.confirm = true;
    const original = fake.bridge.shutDownPageContainer;
    fake.bridge.shutDownPageContainer = (mode?: number) => { microphoneDuringDialog = [...fake.mic]; return original(mode); };
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(microphoneDuringDialog).toEqual([true]);
    expect(fake.mic).toEqual([true, false]);
  });

  it("keeps measuring, without reopening anything, when the exit dialog is cancelled", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(100);
    fake.shutdown.confirm = false;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.shutdown.modes).toEqual([1]);
    expect(fake.mic).toEqual([true]);
    const writesAtCancel = fake.writes.count + fake.images.length;
    fake.audio(20000);
    await vi.advanceTimersByTimeAsync(3000);
    // The level is a picture now, so measuring shows up as image writes.
    expect(fake.writes.count + fake.images.length).toBeGreaterThan(writesAtCancel);
  });

  it("leaves the microphone off on cancel when it was off before", async () => {
    const fake = await boot();
    fake.shutdown.confirm = false;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.shutdown.modes).toEqual([1]);
    expect(fake.mic).toEqual([]);
  });

  it("keeps measuring when the exit call rejects, without an unhandled rejection", async () => {
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
    expect(fake.mic).toEqual([true]);
  });

  it("says what to do when the microphone is refused, and a tap retries", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => undefined });
    const fake = await boot({ micRefusals: 1 });
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.mic).toEqual([]);
    expect(fake.texts.join(" | ")).toContain("Microphone not available.");
    expect(fake.texts.join(" | ")).toContain("Tap = try again");
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.mic).toEqual([true]);
    expect(fake.texts.at(-1)).toContain("● MIC");
  });

  it("draws the meter, the level digits and the dose bar once, and not again while nothing changes", async () => {
    const fake = await boot();
    await vi.advanceTimersByTimeAsync(5000);
    expect([...fake.images].sort()).toEqual(["dose-bar", "level-digits", "pixel-icon"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.images).toHaveLength(3);
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

  it("sends each picture at most every 700 ms while the level moves", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(5000);
    const start = fake.images.length;
    for (let i = 0; i < 100; i++) {
      fake.audio(i % 2 === 0 ? 500 : 20_000);
      await vi.advanceTimersByTimeAsync(100);
    }
    // 10 s of a level jumping every block: at most one write per 700 ms and picture.
    for (const name of ["pixel-icon", "level-digits"]) {
      const writes = fake.images.slice(start).filter((n) => n === name).length;
      expect(writes, name).toBeGreaterThan(0);
      expect(writes, name).toBeLessThanOrEqual(15);
    }
  });

  /** Measures loud audio for `seconds`, one block every 100 ms. */
  async function loud(fake: ReturnType<typeof fakeBridge>, seconds: number): Promise<void> {
    for (let i = 0; i < seconds * 10; i++) {
      fake.audio(20000);
      await vi.advanceTimersByTimeAsync(100);
    }
  }

  const savedFraction = (fake: { storage: Map<string, string> }): number =>
    JSON.parse(fake.storage.get("quietglass.decibelguard.today.v1") ?? "{}").fraction ?? 0;

  it("QIS v1: a plain tap, a hold, or two holds never clear today's dose", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(10);
    await loud(fake, 20);
    fake.emit(5); // background: persists the dose
    await vi.advanceTimersByTimeAsync(50);
    fake.emit(4); // and back
    await vi.advanceTimersByTimeAsync(100);
    const before = savedFraction(fake);
    expect(before).toBeGreaterThan(0);

    fake.emit(9); // hold: only asks
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.texts.some((text) => /Nochmal tippen = (Dosis )?löschen|Tap again = clear dose/.test(text))).toBe(true);
    // Left alone, the question goes away and nothing is cleared.
    await vi.advanceTimersByTimeAsync(4500);
    expect(fake.texts.at(-1)).not.toMatch(/Nochmal tippen|Tap again/);
    expect(savedFraction(fake)).toBe(before);
    // A second hold while armed cancels instead of confirming.
    fake.emit(9);
    await vi.advanceTimersByTimeAsync(500);
    fake.emit(9);
    await vi.advanceTimersByTimeAsync(50);
    expect(savedFraction(fake)).toBe(before);
  });

  it("QIS v1: a swipe or a double tap cancels the question; a later tap does not clear", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(10);
    await loud(fake, 10);
    fake.emit(5);
    await vi.advanceTimersByTimeAsync(50);
    fake.emit(4);
    await vi.advanceTimersByTimeAsync(100);
    const before = savedFraction(fake);
    for (const cancel of [1, 3]) {
      fake.emit(9);
      await vi.advanceTimersByTimeAsync(600);
      fake.emit(cancel);
      await vi.advanceTimersByTimeAsync(600);
      fake.emit(0); // a plain tap: only asks to stop measuring, never clears
      await vi.advanceTimersByTimeAsync(4500);
      expect(savedFraction(fake)).toBe(before);
    }
    expect(fake.shutdown.calls).toBe(0);
    expect(fake.mic).toEqual([true, false, true]);
  });

  it("QIS v1: a hold followed by ONE tap within 4 s clears the dose and does not stop measuring", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(10);
    await loud(fake, 5);
    fake.emit(9);
    await vi.advanceTimersByTimeAsync(600);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.mic).toEqual([true]);
    expect(savedFraction(fake)).toBe(0);
  });

  it("QIS v1: a tap right on the heels of the hold is not a confirmation", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(10);
    await loud(fake, 5);
    fake.emit(5);
    await vi.advanceTimersByTimeAsync(50);
    fake.emit(4);
    await vi.advanceTimersByTimeAsync(100);
    const before = savedFraction(fake);
    fake.emit(9);
    await vi.advanceTimersByTimeAsync(100);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(savedFraction(fake)).toBe(before);
  });

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    const fake = await boot();
    expect(fake.pages.length).toBeGreaterThan(0);
    for (const page of fake.pages) expect(page.menuObject).toBeUndefined();
    // A menu click that might still arrive does not break anything.
    fake.menu(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.texts.some((text) => /(help|Hilfe) 1\/2/.test(text))).toBe(true);
  });

  it("the help opens by a swipe on the main screen, a swipe turns the page, 2× goes back and only then leaves", async () => {
    const fake = await boot();
    fake.emit(1); // swipe on the main screen
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.texts.some((text) => /DECIBELGUARD · (help|Hilfe) 1\/2/.test(text))).toBe(true);
    fake.emit(2); // scroll bottom = next page
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.texts.some((text) => /(help|Hilfe) 2\/2/.test(text))).toBe(true);
    fake.emit(0); // a tap in the help does nothing
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.mic).toEqual([]);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.shutdown.calls).toBe(0);
    expect(fake.texts.at(-1)).toMatch(/(Tap|Tippen) = (start|messen)/);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.shutdown.calls).toBe(1);
  });

  it("the help pages follow the invertScroll setting", async () => {
    const storage = new Map<string, string>([["quietglass.decibelguard.v1", JSON.stringify({ invertScroll: true })]]);
    const fake = await boot({ storage });
    fake.emit(1); // swipe: opens the help
    await vi.advanceTimersByTimeAsync(50);
    fake.emit(1); // SCROLL_TOP arrives as "down" when inverted: next page
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.texts.some((text) => /(help|Hilfe) 2\/2/.test(text))).toBe(true);
    fake.emit(2); // and SCROLL_BOTTOM goes back
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.texts.at(-1)).toMatch(/Wischen = blättern|Swipe = page/);
    expect(fake.texts.filter((text) => /(help|Hilfe) 1\/2/.test(text)).length).toBeGreaterThan(1);
  });

  it("QIS v1.2: a tap while measuring only asks; a second tap within 4 s stops", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.mic).toEqual([true]);
    fake.emit(0); // asks
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.mic).toEqual([true]);
    expect(fake.texts.some((text) => /Tap again = stop|Nochmal tippen = stoppen/.test(text))).toBe(true);
    fake.emit(0); // confirms
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.mic).toEqual([true, false]);
  });

  it("QIS v1.2: the stop question lapses after 4 s, and a swipe or 2× cancels it", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(100);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(4500);
    fake.emit(0); // a new question, not a confirmation
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.mic).toEqual([true]);
    fake.emit(1); // swipe cancels
    await vi.advanceTimersByTimeAsync(100);
    fake.emit(0); // asks again
    await vi.advanceTimersByTimeAsync(100);
    fake.emit(3); // 2× cancels (does not open the exit dialog)
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.shutdown.calls).toBe(0);
    expect(fake.mic).toEqual([true]);
  });

  it("keeps today's dose across a restart (phone locked, app unloaded)", async () => {
    const storage = new Map<string, string>();
    const first = await boot({ storage });
    first.emit(0);
    await vi.advanceTimersByTimeAsync(10);
    await loud(first, 40);
    first.emit(5);
    await vi.advanceTimersByTimeAsync(50);
    const saved = JSON.parse(storage.get("quietglass.decibelguard.today.v1") ?? "{}");
    expect(saved.fraction).toBeGreaterThan(0);

    const second = await boot({ storage });
    await vi.advanceTimersByTimeAsync(1100);
    expect(second.texts.some((text) => /heute \d+% vom Limit|today \d+% of limit/.test(text))).toBe(true);
    // The microphone opens only on a tap.
    expect(second.mic).toEqual([]);
  });

  it("closes the microphone when left through the system and reopens it on return", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(10);
    fake.emit(5);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.mic).toEqual([true, false]);
    const writes = fake.writes.count;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.writes.count).toBe(writes);
    fake.emit(4);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.mic).toEqual([true, false, true]);
  });

  it("closes the microphone for good on a system exit", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(10);
    fake.emit(7);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.mic).toEqual([true, false]);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.mic).toEqual([true, false]);
  });
});

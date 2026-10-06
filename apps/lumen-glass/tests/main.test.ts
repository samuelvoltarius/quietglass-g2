import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app against a fake bridge and a fake LUMEN to check the polling loop without hardware.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
// Canvas is unavailable in node; the icon is not what these tests are about.
vi.mock("../src/glasses/pixel", () => ({ renderPixelIcon: async () => new Uint8Array([1]) }));

// tsconfig carries no node types; reach the process object structurally.
const nodeProcess = (globalThis as unknown as { process: { on(event: string, listener: (reason: unknown) => void): void; off(event: string, listener: (reason: unknown) => void): void } }).process;

function fakeBridge() {
  let handler: ((event: unknown) => void) | undefined;
  // Plain functions, not vi.fn: vitest's spies attach handlers to returned promises, which would hide unhandled rejections.
  const shutdown = { calls: 0, fail: false };
  const writes = { count: 0, body: "" };
  const bridge = {
    getLocalStorage: async () => "",
    setLocalStorage: async () => true,
    rebuildPageContainer: async () => true,
    createStartUpPageContainer: async (page: { textObject?: { containerID?: number; content?: string }[] }) => {
      writes.count += 1;
      writes.body = (page.textObject ?? []).find((part) => part.containerID === 2)?.content ?? "";
      return 0;
    },
    textContainerUpgrade: async (update: { containerID?: number; content?: string }) => {
      writes.count += 1;
      if (update.containerID === 2) writes.body = update.content ?? "";
      return true;
    },
    updateImageRawData: async () => 0,
    shutDownPageContainer: (): Promise<boolean> => { shutdown.calls += 1; return shutdown.fail ? Promise.reject(new Error("ble gone")) : Promise.resolve(true); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return { bridge, shutdown, writes, emit: (eventType: number) => handler?.({ sysEvent: { eventType, eventSource: 1 } }), ready: () => handler !== undefined };
}

const payload = (gesture: string) => ({
  kreatur: { licht: 60, zustand: "wach", geste: gesture, streak: 1 },
  quest: null,
});

/** A LUMEN that answers each request after `delayMs`, with the gesture it was given when asked. */
function fakeLumen(delayMs: number) {
  let gesture = "first";
  const fetchMock = vi.fn(() => {
    const answer = gesture;
    return new Promise<Response>((resolve) => {
      setTimeout(() => resolve({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => payload(answer),
      } as unknown as Response), delayMs);
    });
  });
  return { fetchMock, setGesture: (next: string) => { gesture = next; } };
}

describe("lumen polling loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function boot() {
    const fake = fakeBridge();
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    // Boot waits for the first status, which only arrives as fake time passes.
    for (let i = 0; i < 100 && !fake.ready(); i++) await vi.advanceTimersByTimeAsync(100);
    expect(fake.ready()).toBe(true);
    return fake;
  }

  it("shares one status request between swipes instead of stacking them", async () => {
    // Regression: every swipe started its own fetch against a slow LUMEN.
    const lumen = fakeLumen(3000);
    vi.stubGlobal("fetch", lumen.fetchMock);
    const fake = await boot();
    lumen.fetchMock.mockClear();
    fake.emit(1);
    fake.emit(2);
    fake.emit(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(lumen.fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    fake.emit(1);
    expect(lumen.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops polling and drawing after a double tap during a request, even if shutdown rejects", async () => {
    // Regression: a refresh in flight at the double tap re-armed the 60 s poll via
    // `.then(schedule)` and drew to the closed page; the shutdown rejection was unhandled.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    nodeProcess.on("unhandledRejection", onUnhandled);
    const lumen = fakeLumen(3000);
    vi.stubGlobal("fetch", lumen.fetchMock);
    const fake = await boot();

    await vi.advanceTimersByTimeAsync(60_000); // the poll fires and its request is in flight
    const fetchesAtClose = lumen.fetchMock.mock.calls.length;
    fake.shutdown.fail = true;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    const writesAtClose = fake.writes.count;
    lumen.setGesture("after close");
    await vi.advanceTimersByTimeAsync(200_000);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);

    expect(unhandled).toEqual([]);
    expect(fake.shutdown.calls).toBe(1);
    expect(lumen.fetchMock.mock.calls.length).toBe(fetchesAtClose);
    expect(fake.writes.count).toBe(writesAtClose);
  });
});

import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app against a fake bridge and a fake LUMEN to check the polling loop without hardware.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
// Canvas is unavailable in node; the icon is not what these tests are about.
vi.mock("../src/glasses/pixel", () => ({ ICON_WIDTH: 64, ICON_HEIGHT: 30, renderPixelIcon: async () => new Uint8Array([1]) }));

// tsconfig carries no node types; reach the process object structurally.
const nodeProcess = (globalThis as unknown as { process: { on(event: string, listener: (reason: unknown) => void): void; off(event: string, listener: (reason: unknown) => void): void } }).process;

function fakeBridge() {
  let handler: ((event: unknown) => void) | undefined;
  // Plain functions, not vi.fn: vitest's spies attach handlers to returned promises, which would hide unhandled rejections.
  const shutdown = { calls: 0, fail: false, confirm: true, modes: [] as (number | undefined)[] };
  const writes = { count: 0, body: "", footer: "" };
  const pages = { creates: 0, rebuilds: 0 };
  let deviceHandler: ((status: unknown) => void) | undefined;
  const camera = { next: null as null | { base64: string; mimeType: string; name: string } };
  const bridge = {
    getLocalStorage: async () => "",
    setLocalStorage: async () => true,
    rebuildPageContainer: async () => { pages.rebuilds += 1; return true; },
    captureImageFromCamera: async () => camera.next,
    createStartUpPageContainer: async (page: { textObject?: { containerID?: number; content?: string }[] }) => {
      writes.count += 1;
      pages.creates += 1;
      writes.body = (page.textObject ?? []).find((part) => part.containerID === 2)?.content ?? "";
      writes.footer = (page.textObject ?? []).find((part) => part.containerID === 3)?.content ?? "";
      return 0;
    },
    textContainerUpgrade: async (update: { containerID?: number; content?: string }) => {
      writes.count += 1;
      if (update.containerID === 2) writes.body = update.content ?? "";
      if (update.containerID === 3) writes.footer = update.content ?? "";
      return true;
    },
    updateImageRawData: async () => 0,
    shutDownPageContainer: (mode?: number): Promise<boolean> => { shutdown.calls += 1; shutdown.modes.push(mode); return shutdown.fail ? Promise.reject(new Error("ble gone")) : Promise.resolve(shutdown.confirm); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: (callback: (status: unknown) => void) => { deviceHandler = callback; return () => undefined; },
  };
  return { bridge, shutdown, writes, pages, camera, reconnect: () => deviceHandler?.({ connectType: "connected" }), emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })), ready: () => handler !== undefined };
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
  resetGestureDedupe();
    vi.useFakeTimers();
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null });
    vi.stubGlobal("navigator", { language: "en-US" });
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
    // Let the first status request land.
    await vi.advanceTimersByTimeAsync(3100);
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

  it("asks for the system dialog and stops polling and drawing once the user confirms, even during a request", async () => {
    // Regression: a refresh in flight at the double tap re-armed the 60 s poll via
    // `.then(schedule)` and drew to the closed page.
    const lumen = fakeLumen(3000);
    vi.stubGlobal("fetch", lumen.fetchMock);
    const fake = await boot();

    await vi.advanceTimersByTimeAsync(60_000); // the poll fires and its request is in flight
    const fetchesAtClose = lumen.fetchMock.mock.calls.length;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    const writesAtClose = fake.writes.count;
    lumen.setGesture("after close");
    await vi.advanceTimersByTimeAsync(200_000);

    expect(lumen.fetchMock.mock.calls.length).toBe(fetchesAtClose);
    expect(fake.writes.count).toBe(writesAtClose);
  });

  it("keeps polling when the user cancels the exit dialog", async () => {
    const lumen = fakeLumen(10);
    vi.stubGlobal("fetch", lumen.fetchMock);
    const fake = await boot();
    fake.shutdown.confirm = false;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    const fetchesAtCancel = lumen.fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(130_000);
    expect(lumen.fetchMock.mock.calls.length).toBeGreaterThanOrEqual(fetchesAtCancel + 2);
    fake.emit(1); // swipes still refresh
    await vi.advanceTimersByTimeAsync(10);
    expect(lumen.fetchMock.mock.calls.length).toBeGreaterThanOrEqual(fetchesAtCancel + 3);
  });

  it("keeps polling when the exit call rejects, without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    nodeProcess.on("unhandledRejection", onUnhandled);
    const lumen = fakeLumen(10);
    vi.stubGlobal("fetch", lumen.fetchMock);
    const fake = await boot();
    fake.shutdown.fail = true;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    const fetchesAtFailure = lumen.fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(70_000);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(fake.shutdown.calls).toBe(1);
    expect(lumen.fetchMock.mock.calls.length).toBeGreaterThan(fetchesAtFailure);
  });

  it("regression: an unreachable LUMEN never makes the glasses deaf — the double tap still exits", async () => {
    // LUMEN never answers at all.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const fake = fakeBridge();
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    for (let i = 0; i < 20 && !fake.ready(); i++) await vi.advanceTimersByTimeAsync(10);
    expect(fake.ready()).toBe(true);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
  });

  it("regression: a reconnect rebuilds the page even when nothing changed, and never creates it twice", async () => {
    const lumen = fakeLumen(10);
    vi.stubGlobal("fetch", lumen.fetchMock);
    const fake = await boot();
    expect(fake.pages.creates).toBe(1);
    const rebuilds = fake.pages.rebuilds;
    fake.reconnect();
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.pages.rebuilds).toBe(rebuilds + 1);
    expect(fake.pages.creates).toBe(1);
  });

  it("leaving through the system stops polling; coming back rebuilds and polls again", async () => {
    const lumen = fakeLumen(10);
    vi.stubGlobal("fetch", lumen.fetchMock);
    const fake = await boot();
    fake.emit(5);
    const fetches = lumen.fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(200_000);
    expect(lumen.fetchMock.mock.calls.length).toBe(fetches);
    const rebuilds = fake.pages.rebuilds;
    fake.emit(4);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.pages.rebuilds).toBe(rebuilds + 1);
    expect(lumen.fetchMock.mock.calls.length).toBe(fetches + 1);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(lumen.fetchMock.mock.calls.length).toBe(fetches + 2);
  });

  it("a system exit stops polling and drawing for good", async () => {
    const lumen = fakeLumen(10);
    vi.stubGlobal("fetch", lumen.fetchMock);
    const fake = await boot();
    fake.emit(7);
    const fetches = lumen.fetchMock.mock.calls.length;
    const writes = fake.writes.count;
    await vi.advanceTimersByTimeAsync(200_000);
    fake.emit(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(lumen.fetchMock.mock.calls.length).toBe(fetches);
    expect(fake.writes.count).toBe(writes);
  });
});

/** A LUMEN with an open quest that records what was asked of it. */
function questLumen(options: { tickOnUpload: boolean; unreadable?: boolean }) {
  let questId = 9;
  const calls: string[] = [];
  const json = (body: unknown) => ({ ok: true, status: 200, type: "basic", headers: { get: () => "application/json" }, json: async () => body } as unknown as Response);
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push((init?.method ?? "GET") + " " + url.replace(/^https?:\/\/[^/]+/, ""));
    if (url.endsWith("/api/quest/neu")) { questId += 1; return json({}); }
    if (url.includes("/abgeben")) {
      if (options.unreadable) {
        if (options.tickOnUpload) questId += 1;
        throw new TypeError("Failed to fetch");
      }
      if (options.tickOnUpload) { questId += 1; return json({ ergebnis: "erledigt", meldung: "Angenommen" }); }
      return json({ ergebnis: "abgelehnt", meldung: "Kein Baum zu sehen." });
    }
    return json({ kreatur: { licht: 50, zustand: "wach", geste: "g", streak: 0 }, quest: { id: questId, titel: "Q" + questId, aufgabe: "Task " + questId, medium: "foto" } });
  });
  return { fetchMock, calls };
}

describe("lumen gestures with an open quest", () => {
  beforeEach(() => {
    resetGestureDedupe();
    vi.useFakeTimers();
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null });
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function bootWith(fetchMock: unknown) {
    vi.stubGlobal("fetch", fetchMock);
    const fake = fakeBridge();
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    for (let i = 0; i < 20 && !fake.ready(); i++) await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(100);
    return fake;
  }

  it("one hold only arms the new quest and says so; a second hold within the window replaces it", async () => {
    const lumen = questLumen({ tickOnUpload: true });
    const fake = await bootWith(lumen.fetchMock);
    fake.emit(9);
    await vi.advanceTimersByTimeAsync(50);
    expect(lumen.calls.some((call) => call.includes("/api/quest/neu"))).toBe(false);
    expect(fake.writes.footer).toContain("hold again");
    fake.emit(9);
    await vi.advanceTimersByTimeAsync(50);
    expect(lumen.calls.filter((call) => call.includes("/api/quest/neu"))).toHaveLength(1);
  });

  it("an armed hold runs out: a late second hold only arms again", async () => {
    const lumen = questLumen({ tickOnUpload: true });
    const fake = await bootWith(lumen.fetchMock);
    fake.emit(9);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.writes.footer).not.toContain("hold again");
    fake.emit(9);
    await vi.advanceTimersByTimeAsync(50);
    expect(lumen.calls.some((call) => call.includes("/api/quest/neu"))).toBe(false);
  });

  it("a photo LUMEN ticked off shows as done straight from its JSON answer", async () => {
    const lumen = questLumen({ tickOnUpload: true });
    const fake = await bootWith(lumen.fetchMock);
    fake.camera.next = { base64: "aGVsbG8=", mimeType: "image/jpeg", name: "p.jpg" };
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(lumen.calls.some((call) => call.startsWith("POST /quest/9/abgeben"))).toBe(true);
    expect(fake.writes.body).toContain("Quest done");
  });

  it("a photo LUMEN rejected shows LUMEN's reason", async () => {
    const lumen = questLumen({ tickOnUpload: false });
    const fake = await bootWith(lumen.fetchMock);
    fake.camera.next = { base64: "aGVsbG8=", mimeType: "image/jpeg", name: "p.jpg" };
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.writes.body).toContain("Kein Baum zu sehen.");
  });

  it("fallback: an unreadable answer is settled through the status (ticked off)", async () => {
    const lumen = questLumen({ tickOnUpload: true, unreadable: true });
    const fake = await bootWith(lumen.fetchMock);
    fake.camera.next = { base64: "aGVsbG8=", mimeType: "image/jpeg", name: "p.jpg" };
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(lumen.calls.some((call) => call.startsWith("POST /quest/9/abgeben"))).toBe(true);
    expect(fake.writes.body).toContain("Quest done");
  });

  it("fallback: an unreadable answer and an open quest says so instead of claiming success", async () => {
    const lumen = questLumen({ tickOnUpload: false, unreadable: true });
    const fake = await bootWith(lumen.fetchMock);
    fake.camera.next = { base64: "aGVsbG8=", mimeType: "image/jpeg", name: "p.jpg" };
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.writes.body).toContain("kept the quest open");
  });
});


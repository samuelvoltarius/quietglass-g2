import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app against a fake bridge and a fake LUMEN to check the polling loop without hardware.
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
  const shutdown = { calls: 0, fail: false, confirm: true, modes: [] as (number | undefined)[] };
  const writes = { count: 0, header: "", body: "", footer: "" };
  const pages = { creates: 0, rebuilds: 0, menus: [] as Array<Array<[number, string]>> };
  let deviceHandler: ((status: unknown) => void) | undefined;
  const camera = { calls: 0, next: null as null | { base64: string; mimeType: string; name: string }, gate: null as null | Promise<void> };
  const config = { stored: JSON.stringify({ baseUrl: "http://lumen.test:8077", invertScroll: false }) };
  const bridge = {
    getLocalStorage: async (key: string) => (key === "quietglass.lumenglass.v1" ? config.stored : ""),
    setLocalStorage: async () => true,
    rebuildPageContainer: async () => { pages.rebuilds += 1; return true; },
    captureImageFromCamera: async () => { camera.calls += 1; if (camera.gate) await camera.gate; return camera.next; },
    createStartUpPageContainer: async (page: { textObject?: { containerID?: number; content?: string }[]; menuObject?: { menuItems?: Array<{ itemID: number; itemName: string }> } }) => {
      writes.count += 1;
      pages.creates += 1;
      pages.menus.push((page.menuObject?.menuItems ?? []).map((item): [number, string] => [item.itemID, item.itemName]));
      writes.header = (page.textObject ?? []).find((part) => part.containerID === 1)?.content ?? "";
      writes.body = (page.textObject ?? []).find((part) => part.containerID === 2)?.content ?? "";
      writes.footer = (page.textObject ?? []).find((part) => part.containerID === 3)?.content ?? "";
      return 0;
    },
    textContainerUpgrade: async (update: { containerID?: number; content?: string }) => {
      writes.count += 1;
      if (update.containerID === 1) writes.header = update.content ?? "";
      if (update.containerID === 2) writes.body = update.content ?? "";
      if (update.containerID === 3) writes.footer = update.content ?? "";
      return true;
    },
    updateImageRawData: async () => 0,
    shutDownPageContainer: (mode?: number): Promise<boolean> => { shutdown.calls += 1; shutdown.modes.push(mode); return shutdown.fail ? Promise.reject(new Error("ble gone")) : Promise.resolve(shutdown.confirm); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: (callback: (status: unknown) => void) => { deviceHandler = callback; return () => undefined; },
  };
  return { bridge, shutdown, writes, pages, camera, config, menu: (itemID: number) => handler?.({ menuItemClickEvent: { itemID } }), reconnect: () => deviceHandler?.({ connectType: "connected" }), emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })), ready: () => handler !== undefined };
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

  it("shares one status request between taps on the moth instead of stacking them", async () => {
    // Regression: every tap started its own fetch against a slow LUMEN.
    const lumen = fakeLumen(3000);
    vi.stubGlobal("fetch", lumen.fetchMock);
    const fake = await boot();
    fake.emit(2); // start page: down to "Motte", tap opens the cockpit
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(100);
    lumen.fetchMock.mockClear();
    fake.emit(0);
    fake.emit(0);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(lumen.fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    fake.emit(0);
    expect(lumen.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("the exit call resolving true (dialog shown) does not stop polling", async () => {
    const lumen = fakeLumen(10);
    vi.stubGlobal("fetch", lumen.fetchMock);
    const fake = await boot();
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    const fetchesAtAsk = lumen.fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(130_000);
    expect(lumen.fetchMock.mock.calls.length).toBeGreaterThanOrEqual(fetchesAtAsk + 2);
  });

  it("asks for the system dialog and stops polling and drawing once the system ends the app (sysEvent 7), even during a request", async () => {
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
    fake.emit(7);
    await vi.advanceTimersByTimeAsync(10);
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
    fake.menu(1); // the menu opens the help; the poll goes on behind it
    await vi.advanceTimersByTimeAsync(61_000);
    expect(lumen.fetchMock.mock.calls.length).toBeGreaterThanOrEqual(fetchesAtCancel + 3);
  });

  it("no timer, poll or stream draws while the exit dialog may be on screen; a single 2x right after restores the page first and asks the dialog only then", async () => {
    vi.stubGlobal("fetch", fakeLumen(10).fetchMock);
    const fake = await boot();
    await vi.advanceTimersByTimeAsync(50);
    const creates = fake.pages.creates;
    // The call resolves true as soon as the dialog is SHOWN, whatever the user answers later.
    fake.shutdown.confirm = true;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.shutdown.modes).toEqual([1]);
    const callsAtAsk = fake.writes.count + fake.pages.creates;
    await vi.advanceTimersByTimeAsync(130_000);
    // Timers, polls and streams keep collecting data but make no page call while the dialog may be on screen.
    expect(fake.writes.count + fake.pages.creates).toBe(callsAtAsk);
    expect(fake.pages.creates).toBe(creates);
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

  it("hardware order (step log): 4 = dialog up -> nothing drawn; 5 = dialog gone after No -> page up again without a gesture, polling on, next 2x asks", async () => {
    const lumen = fakeLumen(10);
    vi.stubGlobal("fetch", lumen.fetchMock);
    const fake = await boot();
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(70);
    expect(fake.shutdown.modes).toEqual([1]);
    fake.emit(4);                                            // the dialog is on screen
    const atShown = fake.writes.count + fake.pages.rebuilds;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fake.writes.count + fake.pages.rebuilds).toBe(atShown); // nothing drawn over the dialog
    const creates = fake.pages.creates;
    const fetches = lumen.fetchMock.mock.calls.length;
    fake.emit(5);                                            // "No": the dialog is gone
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.pages.creates).toBeGreaterThan(creates);     // page created again, no gesture needed
    await vi.advanceTimersByTimeAsync(61_000);
    expect(lumen.fetchMock.mock.calls.length).toBeGreaterThan(fetches); // the poll was never paused
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.shutdown.modes).toEqual([1, 1]);             // the very first 2x opens the dialog again
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

  async function bootWith(fetchMock: unknown, stored?: string, options: { start?: boolean } = {}) {
    vi.stubGlobal("fetch", fetchMock);
    const fake = fakeBridge();
    if (stored !== undefined) fake.config.stored = stored;
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    for (let i = 0; i < 20 && !fake.ready(); i++) await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(100);
    // QUS v1: the app opens on the start page; most tests work on the quest, one tap away (the first entry).
    if (!options.start) { fake.emit(0); await vi.advanceTimersByTimeAsync(50); }
    return fake;
  }

  const newQuests = (lumen: ReturnType<typeof questLumen>): number => lumen.calls.filter((call) => call.includes("/api/quest/neu")).length;

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    const lumen = questLumen({ tickOnUpload: true });
    const fake = await bootWith(lumen.fetchMock);
    fake.emit(9);
    await vi.advanceTimersByTimeAsync(50);
    fake.emit(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.pages.creates).toBeGreaterThan(0);
    expect(fake.pages.menus.every((items) => items.length === 0)).toBe(true);
  });

  it("QIS v1: a hold only arms the new quest and says so; one single tap after it replaces the quest (no side menu)", async () => {
    const lumen = questLumen({ tickOnUpload: true });
    const fake = await bootWith(lumen.fetchMock);
    fake.emit(9);
    await vi.advanceTimersByTimeAsync(500);
    expect(newQuests(lumen)).toBe(0);
    expect(fake.writes.header).toBe("Quest · New quest?");
    expect(fake.writes.footer).toBe("Tap again = new quest · Swipe/2× = cancel");
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(newQuests(lumen)).toBe(1);
    expect(fake.camera.calls).toBe(0);
  });

  it("a click in the side menu never runs anything (the menu is off while its clicks do not arrive on the glasses)", async () => {
    const lumen = questLumen({ tickOnUpload: true });
    const fake = await bootWith(lumen.fetchMock);
    fake.menu(2);
    fake.menu(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(newQuests(lumen)).toBe(0);
    expect(fake.writes.footer).not.toContain("Tap again");
    expect(fake.camera.calls).toBe(0);
  });

  it("QIS v1: a swipe, 2× or a second hold cancels the question without replacing anything or leaving the app", async () => {
    for (const cancel of [1, 2, 3, 9]) {
      const lumen = questLumen({ tickOnUpload: true });
      const fake = await bootWith(lumen.fetchMock);
      fake.emit(9);
      await vi.advanceTimersByTimeAsync(500);
      fake.emit(cancel);
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.writes.footer, "event " + cancel).toBe("Tap = photo · Hold = quest · 2× = back");
      expect(newQuests(lumen), "event " + cancel).toBe(0);
      expect(fake.shutdown.modes, "event " + cancel).toEqual([]);
      fake.emit(0); // the next tap is a normal photo tap again, not a confirmation
      await vi.advanceTimersByTimeAsync(50);
      expect(newQuests(lumen), "event " + cancel).toBe(0);
    }
  });

  it("QIS v1: an armed question runs out after 4 seconds; a late tap only takes a photo", async () => {
    const lumen = questLumen({ tickOnUpload: true });
    const fake = await bootWith(lumen.fetchMock);
    fake.emit(9);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fake.writes.footer).toContain("Tap again");
    await vi.advanceTimersByTimeAsync(1500);
    expect(fake.writes.footer).not.toContain("Tap again");
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(newQuests(lumen)).toBe(0);
  });

  it("QUS v1: a swipe does nothing on the quest, 2× goes back to the start page, 2× there asks the exit dialog (no help page)", async () => {
    const lumen = questLumen({ tickOnUpload: true });
    const fake = await bootWith(lumen.fetchMock);
    const header = fake.writes.header;
    expect(header).toBe("Quest · ● live");
    for (const swipe of [1, 2]) {
      fake.emit(swipe);
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.writes.header).toBe(header);
    }
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.writes.header).toBe("Lumen · ● live");
    expect(fake.shutdown.modes).toEqual([]);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.shutdown.modes).toEqual([1]);
    expect(fake.camera.calls).toBe(0);
  });

  it("QIS v1.2 no. 2: 2× during the shot opens the exit dialog without stopping it; confirmed, the photo is never sent", async () => {
    const lumen = questLumen({ tickOnUpload: true });
    const fake = await bootWith(lumen.fetchMock);
    let release!: () => void;
    fake.camera.gate = new Promise<void>((done) => { release = done; });
    fake.camera.next = { base64: "aGVsbG8=", mimeType: "image/jpeg", name: "p.jpg" };
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.writes.header).toBe("Lumen · photo");
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.shutdown.modes).toEqual([1]);
    fake.emit(7); // the user confirmed: the system ends the app
    release();
    await vi.advanceTimersByTimeAsync(200);
    expect(lumen.calls.some((call) => call.startsWith("POST /quest/9/abgeben"))).toBe(false);
  });

  it("QIS v1.2 no. 2: when the exit dialog is cancelled, the shot carries on and is sent after the shutter", async () => {
    const lumen = questLumen({ tickOnUpload: true });
    const fake = await bootWith(lumen.fetchMock);
    fake.shutdown.confirm = false;
    let release!: () => void;
    fake.camera.gate = new Promise<void>((done) => { release = done; });
    fake.camera.next = { base64: "aGVsbG8=", mimeType: "image/jpeg", name: "p.jpg" };
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.shutdown.modes).toEqual([1]);
    expect(fake.writes.header).toBe("Lumen · photo");
    fake.emit(1); // "No": the next input restores the page
    release();
    await vi.advanceTimersByTimeAsync(200);
    expect(lumen.calls.some((call) => call.startsWith("POST /quest/9/abgeben"))).toBe(true);
    expect(fake.writes.body).toContain("Quest done");
  });

  it("QIS v1.2 no. 7: a first start (nothing saved) shows demo data with the hint line and talks to nobody", async () => {
    const lumen = questLumen({ tickOnUpload: true });
    const fake = await bootWith(lumen.fetchMock, "");
    expect(fake.writes.body).toContain("Demo · set up the connection on your phone");
    expect(fake.writes.body).toContain("Photograph a reflection");
    expect(lumen.fetchMock).not.toHaveBeenCalled();
    // The shutter is not needed in the demo: tapping shows what a ticked-off quest looks like.
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.writes.body).toContain("Quest done");
    expect(fake.camera.calls).toBe(0);
    // A new quest in the demo swaps the sample quest, again without a request.
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    fake.emit(9);
    await vi.advanceTimersByTimeAsync(500);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.writes.body).toContain("shadow");
    await vi.advanceTimersByTimeAsync(130_000);
    expect(lumen.fetchMock).not.toHaveBeenCalled();
  });

  it("a saved address (even the default) is no first start: no demo hint, real requests", async () => {
    const lumen = questLumen({ tickOnUpload: true });
    const fake = await bootWith(lumen.fetchMock, JSON.stringify({ baseUrl: "http://127.0.0.1:8077", invertScroll: false }));
    expect(fake.writes.body).not.toContain("Demo");
    expect(lumen.fetchMock).toHaveBeenCalled();
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


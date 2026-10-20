import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app against a fake bridge to check the polling loop without hardware.
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

function fakeBridge() {
  let handler: ((event: unknown) => void) | undefined;
  // Plain functions, not vi.fn: vitest's spies attach handlers to returned promises, which would hide unhandled rejections.
  const shutdown = { calls: 0, fail: false, confirm: true, modes: [] as (number | undefined)[] };
  const pages: string[][] = [];
  const menus: string[][] = [];
  const bridge = {
    rebuildPageContainer: vi.fn(async () => true),
    createStartUpPageContainer: vi.fn(async (page: { textObject?: { content?: string }[]; menuObject?: { menuItems?: { itemName?: string }[] } }) => { menus.push((page.menuObject?.menuItems ?? []).map((item) => item.itemName ?? "")); pages.push((page.textObject ?? []).map((part) => part.content ?? "")); return 0; }),
    textContainerUpgrade: vi.fn(async (update: { containerID?: number; content?: string }) => { if (update.containerID === 1) pages.push([]); pages.at(-1)?.push(update.content ?? ""); return true; }),
    updateImageRawData: vi.fn(async () => "success"),
    shutDownPageContainer: (mode?: number): Promise<boolean> => { shutdown.calls += 1; shutdown.modes.push(mode); return shutdown.fail ? Promise.reject(new Error("ble gone")) : Promise.resolve(shutdown.confirm); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return { bridge, shutdown, pages, menus, menu: (itemID: number) => handler?.({ menuItemClickEvent: { itemID } }), emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })), ready: () => handler !== undefined };
}

describe("endurance polling loop", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
  resetGestureDedupe();
    harness.models.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("document", { querySelector: () => null });
    // A bridge that accepts the connection and never answers.
    fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function boot() {
    const fake = fakeBridge();
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    return fake;
  }

  it("keeps at most one request in flight against a stalled bridge", async () => {
    // Regression: setInterval fired refresh() every 2 s regardless, stacking unbounded pending fetches.
    await boot();
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500); // first poll times out at 4 s
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks for the system exit dialog; the call resolving true (dialog shown) does not stop polling", async () => {
    const fake = await boot();
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fake.shutdown.modes).toEqual([1]);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("stops polling once the system ends the app (sysEvent 7) after the dialog", async () => {
    const fake = await boot();
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    fake.emit(7);
    await vi.advanceTimersByTimeAsync(10000);
    // Only the boot poll: the interval was cleared at the system exit.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("keeps polling when the user cancels the exit dialog", async () => {
    const fake = await boot();
    fake.shutdown.confirm = false;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("no timer, poll or stream draws while the exit dialog may be on screen; a single 2x right after restores the page first and asks the dialog only then", async () => {
    const fake = await boot();
    const creates = fake.bridge.createStartUpPageContainer.mock.calls.length;
    // The call resolves true as soon as the dialog is SHOWN, whatever the user answers later.
    fake.shutdown.confirm = true;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.shutdown.modes).toEqual([1]);
    const pageCalls = (): number => ["createStartUpPageContainer", "rebuildPageContainer", "textContainerUpgrade", "updateImageRawData"].reduce((sum, name) => sum + ((fake.bridge as unknown as Record<string, { mock?: { calls: unknown[] } } | undefined>)[name]?.mock?.calls.length ?? 0), 0);
    const callsAtAsk = pageCalls();
    await vi.advanceTimersByTimeAsync(5000);
    // Timers, polls and streams keep collecting data but make no page call while the dialog may be on screen.
    expect(pageCalls()).toBe(callsAtAsk);
    expect(fake.bridge.createStartUpPageContainer.mock.calls.length).toBe(creates);
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
    const fake = await boot();
    const pageCalls = (): number => ["createStartUpPageContainer", "rebuildPageContainer", "textContainerUpgrade", "updateImageRawData"].reduce((sum, name) => sum + ((fake.bridge as unknown as Record<string, { mock?: { calls: unknown[] } } | undefined>)[name]?.mock?.calls.length ?? 0), 0);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(70);
    expect(fake.shutdown.modes).toEqual([1]);
    fake.emit(4); // the dialog is on screen
    const atShown = pageCalls();
    const fetchesAtShown = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(pageCalls()).toBe(atShown); // nothing drawn over the dialog
    expect(fetchMock.mock.calls.length).toBeGreaterThan(fetchesAtShown); // polling keeps running
    const creates = fake.bridge.createStartUpPageContainer.mock.calls.length;
    fake.emit(5); // "No": the dialog is gone
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.bridge.createStartUpPageContainer.mock.calls.length).toBeGreaterThan(creates); // page created again, no gesture needed
    const fetchesAfterRestore = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(fetchesAfterRestore); // polling was never stopped
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.shutdown.modes).toEqual([1, 1]); // the very first 2x opens the dialog again
  });

  it("keeps polling when the exit call rejects, without an unhandled rejection", async () => {
    // Regression: `void bridge.shutDownPageContainer()` left a rejection unhandled. A rejected call shows no dialog, so the app stays.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    nodeProcess.on("unhandledRejection", onUnhandled);
    const fake = await boot();
    fake.shutdown.fail = true;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10000);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(fake.shutdown.calls).toBe(1);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("endurance gestures, staleness and phone page", () => {
  let store: Map<string, string>;
  let app: { innerHTML: string };
  let reply: () => Promise<Response>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12));
    harness.models.length = 0;
    store = new Map();
    app = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] } as unknown as { innerHTML: string };
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } });
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("document", { activeElement: null, querySelector: (selector: string) => selector === "#app" ? app : null });
    reply = async () => new Response(JSON.stringify({ sport: "bike", speedKph: 30, source: "garmin", updatedAt: new Date().toISOString() }), { status: 200 });
    vi.stubGlobal("fetch", vi.fn(() => reply()));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function boot() {
    const fake = fakeBridge();
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.advanceTimersByTimeAsync(10);
    return fake;
  }

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    const fake = await boot();
    expect(fake.menus.length).toBeGreaterThan(0);
    expect(fake.menus.every((items) => items.length === 0)).toBe(true);
    expect(last().hint).toBe("Tap = refresh · Swipe = sport · 2× = exit");
  });

  it("a swipe on the live screen cycles the sport and saves it again (no side menu)", async () => {
    const fake = await boot();
    expect(last().cells[0]!.value).toBe("BIKE");
    expect(last().headline).toEqual(["30.0 KM/H"]);
    fake.emit(2); // scroll down
    await vi.advanceTimersByTimeAsync(10);
    expect(store.get("endurance.sport")).toBe("run");
    expect(last().cells[0]!.value).toBe("RUN");
    expect(last().headline).toEqual(["2:00 /KM"]);
    fake.emit(1); // scroll up
    await vi.advanceTimersByTimeAsync(10);
    expect(store.get("endurance.sport")).toBe("bike");
  });

  it("the side menu code stays dormant: a menu click does nothing while the menu is off", async () => {
    const fake = await boot();
    fake.menu(1);
    fake.menu(2);
    await vi.advanceTimersByTimeAsync(10);
    // Menu clicks still reach the handler; they are handled, but no page carries a menu to click.
    expect(fake.menus.every((items) => items.length === 0)).toBe(true);
  });

  it("restores the saved sport on start", async () => {
    store.set("endurance.sport", "run");
    await boot();
    expect(last().cells[0]!.value).toBe("RUN");
  });

  it("tap refreshes", async () => {
    const fake = await boot();
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(10);
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls + 1);
  });

  it("regression: values stop being LIVE when the watch stops sending", async () => {
    const sentAt = new Date().toISOString();
    reply = async () => new Response(JSON.stringify({ sport: "bike", speedKph: 30, source: "garmin", updatedAt: sentAt }), { status: 200 });
    await boot();
    expect(last().caption).toBe("BIKE · LIVE");
    await vi.advanceTimersByTimeAsync(12000);
    expect(last().caption).toBe("BIKE · STALE 12s");
  });

  it("regression: a dead bridge shows STALE on the glasses", async () => {
    await boot();
    reply = async () => { throw new TypeError("Failed to fetch"); };
    await vi.advanceTimersByTimeAsync(2000);
    expect(last().caption).toBe("BIKE · STALE 2s");
    expect(last().tone).toBe("offline");
  });

  it("regression: the saved endpoint is escaped in the phone page", async () => {
    store.set("endurance.endpoint", 'http://x/"><img src=x onerror=alert(1)>');
    store.set("endurance.tab", "bridge");
    await boot();
    expect(app.innerHTML).not.toContain("<img");
    expect(app.innerHTML).toContain('value="http://x/&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
  });

  it("a hold does nothing (the help lives on the phone); 2× asks the exit dialog", async () => {
    const fake = await boot();
    const shown = last().hint;
    fake.emit(9); // hold
    await vi.advanceTimersByTimeAsync(10);
    expect(last().hint).toBe(shown);
    expect(store.get("endurance.sport")).toBeUndefined();
    expect(fake.shutdown.modes).toEqual([]);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
  });

  it("QIS v1: the invert-scroll setting reverses the swipe direction", async () => {
    store.set("endurance.invert", "1");
    store.set("endurance.sport", "run");
    const fake = await boot();
    fake.emit(2); // scroll down is read as scroll up: the sport steps back (bike <-> run on a two-item cycle either way)
    await vi.advanceTimersByTimeAsync(10);
    expect(store.get("endurance.sport")).toBe("bike");
  });

  it("QUS v1: the phone page has exactly the tabs Now, History, Settings in that order, with the invert switch under Settings", async () => {
    store.set("endurance.endpoint", "http://bridge.local:8792/live");
    store.set("endurance.tab", "settings");
    await boot();
    const labels = [...app.innerHTML.matchAll(/id="tab-\w+"[^>]*>(?:<span[^>]*>[^<]*<\/span>)?([^<]+)</g)].map((m) => m[1]);
    expect(labels).toEqual(["Now", "History", "Settings"]);
    expect(app.innerHTML).toContain('id="invert"');
    expect(app.innerHTML.indexOf('id="invert"')).toBeGreaterThan(app.innerHTML.indexOf('data-tab="settings"'));
  });
});

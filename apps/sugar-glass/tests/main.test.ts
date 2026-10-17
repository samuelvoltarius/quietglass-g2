import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRoot, type FakeRoot } from "./fake-dom";

// Boots the real app against a fake glasses bridge and a fake Nightscout.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const CLICK = 0, DOWN = 2, DOUBLE = 3, HOLD = 9;
const SETTINGS = "quietglass.sugarglass.v1";

type Page = { textObject?: Array<{ containerID?: number; content?: string }>; imageObject?: unknown[]; menuObject?: { menuItems?: Array<{ itemName?: string; itemID?: number }> } };

function fakeGlasses(stored: Record<string, string> = {}, options: { hangStorage?: boolean } = {}) {
  let handler: ((event: unknown) => void) | undefined;
  const storage = new Map(Object.entries(stored));
  const screen = new Map<number, string>();
  const pages: Page[] = [];
  const exit = { calls: [] as unknown[], answer: true };
  const show = (page: Page): void => {
    pages.push(page);
    for (const text of page.textObject ?? []) screen.set(text.containerID ?? 0, text.content ?? "");
  };
  const bridge = {
    getLocalStorage: vi.fn((key: string) => (options.hangStorage ? new Promise<string>(() => undefined) : Promise.resolve(storage.get(key) ?? ""))),
    setLocalStorage: vi.fn(async (key: string, value: string) => { storage.set(key, value); return true; }),
    getUserInfo: vi.fn(async () => ({ country: "AT" })),
    updateImageRawData: vi.fn(async (_update: { containerName?: string }) => "success"),
    rebuildPageContainer: vi.fn(async (page: Page) => { show(page); return true; }),
    createStartUpPageContainer: vi.fn(async (page: Page) => { show(page); return 0; }),
    textContainerUpgrade: vi.fn(async (update: { containerID?: number; content?: string }) => { screen.set(update.containerID ?? 0, update.content ?? ""); return true; }),
    shutDownPageContainer: (mode?: number): Promise<boolean> => { exit.calls.push(mode); return Promise.resolve(exit.answer); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, exit, pages, storage,
    header: () => screen.get(1) ?? "",
    body: () => screen.get(2) ?? "",
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
    menu: (itemID: number) => handler?.({ menuItemClickEvent: { itemID } }),
    menus: () => pages.map((page) => (page.menuObject?.menuItems ?? []).map((item) => item.itemID + ":" + item.itemName)),
    ready: () => handler !== undefined,
  };
}

function fakeNightscout() {
  const state = { calls: [] as Array<{ url: string; init: RequestInit }>, pumpFails: false, sgv: 123 };
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}): Promise<Response> => {
    state.calls.push({ url: input, init });
    const url = new URL(input);
    const now = Date.now();
    if (url.pathname === "/api/v1/entries/sgv.json") {
      return new Response(JSON.stringify([
        { type: "sgv", sgv: state.sgv, date: now - 60_000, direction: "Flat" },
        { type: "sgv", sgv: state.sgv - 3, date: now - 360_000, direction: "Flat" },
      ]));
    }
    if (url.pathname === "/api/v1/devicestatus.json") {
      if (state.pumpFails) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify([{ created_at: new Date(now - 120_000).toISOString(), device: "MiniMed 780G", pump: { reservoir: 80, battery: { percent: 50 }, iob: { bolusiob: 0.8 } }, uploader: { battery: 40 } }]));
    }
    if (url.pathname === "/api/v1/treatments.json") return new Response("[]");
    return new Response("{}", { status: 404 });
  });
  return { state, fetchMock };
}

async function boot(fake: ReturnType<typeof fakeGlasses>, waitForPage = true): Promise<FakeRoot> {
  const root = fakeRoot();
  vi.stubGlobal("document", { getElementById: () => root, activeElement: null });
  vi.stubGlobal("navigator", { language: "en-US" });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  harness.bridge = fake.bridge;
  vi.resetModules();
  await import("../src/main");
  await vi.waitFor(() => expect(fake.ready()).toBe(true));
  if (waitForPage) await vi.waitFor(() => expect(fake.pages.length).toBeGreaterThan(0));
  return root;
}

const configured = (token?: string): Record<string, string> => ({ [SETTINGS]: JSON.stringify({ url: "https://ns.example:8462", ...(token ? { token } : {}) }) });

describe("Sugar Glass lifecycle", () => {
  let server: ReturnType<typeof fakeNightscout>;
  beforeEach(() => {
    resetGestureDedupe();
    server = fakeNightscout();
    vi.stubGlobal("fetch", server.fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("first run: starts in demo with the hint line and the notice, explains the setup on the phone and fetches nothing", async () => {
    const fake = fakeGlasses();
    const root = await boot(fake);
    // QIS v1.2 no. 7: no empty setup page, demo values with the hint to set up the connection.
    await vi.waitFor(() => expect(fake.body()).toContain("Demo · Verbindung am Handy einrichten"));
    expect(fake.header()).toContain("DEMO");
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body()).toContain("Nur Info – maßgeblich sind Pumpe und Sensor."));
    await vi.waitFor(() => expect(root.innerHTML).toContain("Erster Start"));
    expect(root.innerHTML).toContain("maßgeblich sind Pumpe und Sensor");
    // The phone page is split into tabs, with the bar at the bottom.
    expect(root.innerHTML).toContain('<nav class="tabbar"');
    for (const tab of ["now", "glasses", "link", "more"]) expect(root.innerHTML).toContain(`data-tab="${tab}"`);
    expect(root.innerHTML).toContain("</span>Brille</button>");
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it("the gesture handler is there before storage answers: a double tap still leaves", async () => {
    const fake = fakeGlasses({}, { hangStorage: true });
    await boot(fake, false);
    fake.emit(DOUBLE);
    expect(fake.exit.calls).toEqual([1]);
  });

  it("no timer, poll or stream draws while the exit dialog may be on screen; a single 2x right after restores the page first and asks the dialog only then", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).not.toBe(""));
    await new Promise((done) => setTimeout(done, 20));
    const creates = fake.bridge.createStartUpPageContainer.mock.calls.length;
    // The call resolves true as soon as the dialog is SHOWN, whatever the user answers later.
    fake.exit.answer = true;
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.exit.calls).toEqual([1]));
    const pageCalls = (): number => ["createStartUpPageContainer", "rebuildPageContainer", "textContainerUpgrade", "updateImageRawData"].reduce((sum, name) => sum + ((fake.bridge as unknown as Record<string, { mock?: { calls: unknown[] } } | undefined>)[name]?.mock?.calls.length ?? 0), 0);
    const callsAtAsk = pageCalls();
    await new Promise((done) => setTimeout(done, 1500));
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
    fake.emit(DOUBLE);
    await new Promise((done) => setTimeout(done, 500));
    expect(order).toEqual(["create:start"]); // the dialog is not asked while the page is still being created
    releaseCreate();
    await new Promise((done) => setTimeout(done, 1500));
    expect(order).toEqual(["create:start", "create:done", "shutdown"]); // restore first, then the dialog, exactly once more
  });

  it("hardware order (step log 0.5.11): 4 = dialog up -> nothing drawn; 5 = dialog gone after No -> page up again, polling on, next 2x asks", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.advanceTimersByTimeAsync(10);
    const host = fake.bridge as unknown as Record<string, { mock?: { calls: unknown[] } } | undefined>;
    const pageCalls = (): number => ["createStartUpPageContainer", "rebuildPageContainer", "textContainerUpgrade", "updateImageRawData"].reduce((sum, name) => sum + (host[name]?.mock?.calls.length ?? 0), 0);
    fake.exit.answer = true;
    fake.emit(DOUBLE);
    await vi.advanceTimersByTimeAsync(70);
    expect(fake.exit.calls).toEqual([1]);
    fake.emit(4);                                            // the dialog is on screen
    const atShown = pageCalls();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(pageCalls()).toBe(atShown);                       // nothing drawn over the dialog
    const pagesBefore = fake.pages.length;
    const polls = server.fetchMock.mock.calls.length;
    fake.emit(5);                                            // "No": the dialog is gone
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.pages.length).toBeGreaterThan(pagesBefore);  // page up again at once, no gesture needed
    await vi.advanceTimersByTimeAsync(70_000);
    expect(server.fetchMock.mock.calls.length).toBeGreaterThan(polls); // still polling Nightscout
    fake.emit(DOUBLE);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.exit.calls).toEqual([1, 1]);                 // the very first 2x opens the dialog again
  });

  it("the system ending the app (sysEvent 7) after the dialog shuts it down: a further double tap does nothing", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).not.toBe(""));
    await new Promise((done) => setTimeout(done, 20));
    fake.exit.answer = true;
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.exit.calls).toEqual([1]));
    fake.emit(7);
    await new Promise((done) => setTimeout(done, 20));
    fake.emit(DOUBLE);
    await new Promise((done) => setTimeout(done, 50));
    expect(fake.exit.calls).toEqual([1]);
  });

  it("shows the value; one ignored rebuild, one create, then only rebuilds between pages", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("SUGARGLASS · 123 mg/dL · vor 1 min"));
    expect(fake.body()).toContain("IOB 0,80 E · Reservoir 80 E · Modus –");
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
    expect(fake.bridge.rebuildPageContainer.mock.invocationCallOrder[0]).toBeLessThan(fake.bridge.createStartUpPageContainer.mock.invocationCallOrder[0]!);
    await vi.waitFor(() => expect(fake.bridge.updateImageRawData.mock.calls.some((c) => c[0].containerName === "curve")).toBe(true));
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.header()).toBe("SUGARGLASS · PUMPE · MiniMed 780G"));
    expect(fake.body()).toContain("Reservoir: 80 E · Pumpen-Akku: 50 %");
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.header()).toBe("SUGARGLASS · 123 mg/dL · vor 1 min"));
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
    for (const page of fake.pages) expect((page.imageObject ?? []).length).toBeLessThanOrEqual(4);
  });

  it("a hold opens the help page; only 2× leaves it (back), then 2× on the value exits", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("SUGARGLASS · 123 mg/dL · vor 1 min"));
    fake.emit(HOLD);
    await vi.waitFor(() => expect(fake.header()).toBe("SUGARGLASS · Hilfe"));
    expect(fake.body()).toContain("Halten = diese Hilfe");
    fake.emit(DOWN);
    fake.emit(CLICK);
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.header()).toBe("SUGARGLASS · Hilfe");
    expect(fake.exit.calls).toEqual([]);
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.header()).toBe("SUGARGLASS · 123 mg/dL · vor 1 min"));
    expect(fake.exit.calls).toEqual([]);
    fake.emit(DOUBLE);
    expect(fake.exit.calls).toEqual([1]);
  });

  it("requests carry no custom header; a token goes into the query", async () => {
    const fake = fakeGlasses(configured("tok-123"));
    await boot(fake);
    await vi.waitFor(() => expect(server.state.calls.length).toBeGreaterThanOrEqual(3));
    for (const call of server.state.calls) {
      expect(call.init.headers).toBeUndefined();
      expect(new URL(call.url).searchParams.get("token")).toBe("tok-123");
    }
  });

  it("a failing devicestatus never hides the glucose value; tap refreshes", async () => {
    server.state.pumpFails = true;
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("SUGARGLASS · 123 mg/dL · vor 1 min"));
    server.state.sgv = 64;
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toMatch(/NIEDRIG 64 mg\/dL/));
  });

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("SUGARGLASS · 123 mg/dL · vor 1 min"));
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.header()).toBe("SUGARGLASS · PUMPE · MiniMed 780G"));
    expect(fake.pages.length).toBeGreaterThan(0);
    for (const page of fake.pages) expect(page.menuObject).toBeUndefined();
    expect(fake.menus().every((menu) => menu.length === 0)).toBe(true);
  });

  it("a tap still refreshes the values", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("SUGARGLASS · 123 mg/dL · vor 1 min"));
    server.state.sgv = 64;
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toMatch(/NIEDRIG 64 mg\/dL/));
  });

  it("QIS v1.2: a server that answers with an error shows no HTTP code on the glasses; the phone keeps it", async () => {
    server.fetchMock.mockImplementation(async () => new Response("{}", { status: 503 }));
    const fake = fakeGlasses(configured());
    const root = await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Server: Serverfehler"));
    expect(fake.body() + fake.header()).not.toMatch(/HTTP|503/);
    await vi.waitFor(() => expect(root.innerHTML).toContain("HTTP 503"));
  });

  it("an unreachable server is named, not hidden", async () => {
    server.fetchMock.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Server: nicht erreichbar"));
    expect(fake.header()).toBe("SUGARGLASS · keine Verbindung");
  });
});

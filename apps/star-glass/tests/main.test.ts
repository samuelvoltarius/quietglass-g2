import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRoot, type FakeRoot } from "./fake-dom";

// Boots the real app against a fake glasses bridge and a fake Star Glass bridge server.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const CLICK = 0, DOWN = 2, DOUBLE = 3, HOLD = 9;
const SETTINGS = "quietglass.starglass.v1";
const NL = String.fromCharCode(10);

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
    footer: () => screen.get(3) ?? "",
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
    menu: (itemID: number) => handler?.({ menuItemClickEvent: { itemID } }),
    menus: () => pages.map((page) => (page.menuObject?.menuItems ?? []).map((item) => item.itemID + ":" + item.itemName)),
    ready: () => handler !== undefined,
    /** Whether the page on the glasses is the cockpit (four image tiles) or a text page. */
    cockpit: () => (pages[pages.length - 1]?.imageObject?.length ?? 0) === 4,
    /** The names of every image tile sent so far. */
    tiles: () => bridge.updateImageRawData.mock.calls.map((call) => call[0].containerName ?? ""),
  };
}

const STATUS = {
  online: true, version: "2.2.15.2",
  sequence: { state: "running", target: "M 42", step: "Take Exposure", frame: 4, frames: 10 },
  exposure: { active: true, total: 60, remaining: 30, progress: 50 },
  filter: "L",
  camera: { connected: true, temp: -10, setpoint: -10, cooler: true, power: 40, canCool: true, atTarget: true },
  mount: { connected: true, tracking: true, alt: 41, az: 160, flipMinutes: 50, pier: "east" },
  focuser: { connected: true, position: 12000, temp: 6.2 },
  guider: { connected: true, guiding: true, rms: 0.64, ra: 0.4, dec: 0.5 },
  last: { index: 2, type: "LIGHT", filter: "L", exposure: 60, hfr: 2.31, stars: 920, target: "M 42" },
  images: 3, history: { hfr: [2.4, 2.2, 2.31], temp: [-10], rms: [0.6, 0.64] }, events: [],
  preview: "abc123", controllable: true,
};

function fakeServer() {
  const state = { status: { ...STATUS } as Record<string, unknown>, commands: [] as string[], previews: 0 };
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    if (url.pathname === "/api/star") return new Response(JSON.stringify(state.status));
    if (url.pathname === "/api/star/preview.png") { state.previews++; return new Response(new Uint8Array([137, 80, 78, 71])); }
    if (url.pathname === "/api/star/cmd") {
      const command = (JSON.parse(String(init.body)) as { command: string }).command;
      state.commands.push(command);
      state.status = { ...state.status, sequence: { ...STATUS.sequence, state: "idle" }, exposure: { active: false } };
      return new Response(JSON.stringify({ ok: true, command }));
    }
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

const configured = (): Record<string, string> => ({ [SETTINGS]: JSON.stringify({ bridgeUrl: "https://bridge.example:8460" }) });

describe("Star Glass lifecycle", () => {
  let server: ReturnType<typeof fakeServer>;
  beforeEach(() => {
    resetGestureDedupe();
    server = fakeServer();
    vi.stubGlobal("fetch", server.fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  /** The start page, then a tap on its entry number `entry` (0 = Aufnahme, 1 = Wetter, 2 = Letztes Bild). */
  async function open(fake: ReturnType<typeof fakeGlasses>, entry: number): Promise<void> {
    await vi.waitFor(() => expect(fake.header()).toBe("Star Glass · ● live"));
    for (let i = 0; i < entry; i++) fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body()).toContain("● " + ["Aufnahme", "Wetter", "Letztes Bild"][entry]));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.cockpit()).toBe(true));
  }

  it("first run: starts in demo with the hint line, explains the setup on the phone and fetches nothing", async () => {
    const fake = fakeGlasses();
    const root = await boot(fake);
    // No empty setup page: a demo night with the hint to set up the connection.
    await vi.waitFor(() => expect(fake.body()).toContain("Demo · Verbindung am Handy einrichten"));
    expect(fake.header()).toBe("Star Glass · Demo");
    expect(fake.body().split(NL).filter((row) => row.trim().length > 0)).toHaveLength(4);
    await vi.waitFor(() => expect(root.innerHTML).toContain("Erster Start"));
    // The phone page is split into exactly three tabs, with the bar at the bottom.
    expect(root.innerHTML).toContain('<nav class="tabbar"');
    for (const tab of ["now", "log", "settings"]) expect(root.innerHTML).toContain(`data-tab="${tab}"`);
    expect(root.innerHTML.match(/data-tab-go=/g)).toHaveLength(3);
    expect(root.innerHTML).toContain("</span>Jetzt</button>");
    expect(root.innerHTML).toContain("</span>Verlauf</button>");
    expect(root.innerHTML).toContain("</span>Einstellungen</button>");
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

  it("the dialog sends the app to the background (5): after No the very first 2x is not swallowed, it restores and asks again", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).not.toBe(""));
    fake.exit.answer = true;
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.exit.calls).toEqual([1]));
    await new Promise((done) => setTimeout(done, 20));
    fake.emit(5);                                            // the dialog: FOREGROUND_EXIT
    await new Promise((done) => setTimeout(done, 20));
    const pagesBefore = fake.pages.length;
    fake.emit(DOUBLE);                                       // "No", then one 2x as the first thing
    await vi.waitFor(() => expect(fake.exit.calls).toEqual([1, 1]), { timeout: 3000 });
    expect(fake.pages.length).toBeGreaterThan(pagesBefore);  // the page went up again before the dialog
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
    await vi.advanceTimersByTimeAsync(40_000);
    expect(server.fetchMock.mock.calls.length).toBeGreaterThan(polls); // still polling the bridge
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

  it("while the cockpit is up the dialog is never asked by 2x (it goes back to the start page); there it asks, and no tile follows", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await open(fake, 0);
    await vi.waitFor(() => expect(new Set(fake.tiles()).size).toBe(4));
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.cockpit()).toBe(false));
    expect(fake.exit.calls).toEqual([]);
    const tilesBefore = fake.tiles().length;
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.exit.calls).toEqual([1]));
    await new Promise((done) => setTimeout(done, 1500));
    expect(fake.tiles().length).toBe(tilesBefore);
  });

  it("start page -> cockpit -> start page: one ignored rebuild, one create, then only rebuilds; the cockpit is four image tiles", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("Star Glass · ● live"));
    expect(fake.cockpit()).toBe(false);
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
    expect(fake.bridge.rebuildPageContainer.mock.invocationCallOrder[0]).toBeLessThan(fake.bridge.createStartUpPageContainer.mock.invocationCallOrder[0]!);
    fake.emit(CLICK);                                        // Aufnahme
    await vi.waitFor(() => expect(fake.cockpit()).toBe(true));
    await vi.waitFor(() => expect(new Set(fake.tiles())).toEqual(new Set(["star-nw", "star-ne", "star-sw", "star-se"])));
    // A swipe walks Übersicht -> Guiding -> Ausrüstung and stops there; every page changes tiles, none rebuilds.
    const rebuilds = fake.bridge.rebuildPageContainer.mock.calls.length;
    const before = fake.tiles().length;
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.tiles().length).toBeGreaterThan(before));
    fake.emit(DOWN);
    fake.emit(DOWN);
    await new Promise((done) => setTimeout(done, 50));
    expect(fake.bridge.rebuildPageContainer.mock.calls.length).toBe(rebuilds);
    fake.emit(DOUBLE);                                       // 2× = back to the start page, not the end of the app
    await vi.waitFor(() => expect(fake.cockpit()).toBe(false));
    await vi.waitFor(() => expect(fake.header()).toBe("Star Glass · ● live"));
    expect(fake.exit.calls).toEqual([]);
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
    for (const page of fake.pages) expect((page.imageObject ?? []).length).toBeLessThanOrEqual(4);
  });

  it("the newest frame is fetched for the image entry only, once per key", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("Star Glass · ● live"));
    expect(server.state.previews).toBe(0);
    fake.emit(DOWN);
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body()).toContain("● Letztes Bild"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(server.state.previews).toBe(1));
    fake.emit(CLICK);                                        // tap = refresh on this page
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(server.state.previews).toBe(1);
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.cockpit()).toBe(false));
  });

  it("stopping the sequence needs two taps", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await open(fake, 0);
    fake.emit(CLICK);                                        // the control list
    await vi.waitFor(() => expect(fake.body()).toContain("> Sequenz anhalten"));
    expect(fake.cockpit()).toBe(false);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.footer()).toBe("Nochmal tippen = anhalten · Wischen/2× = abbrechen"));
    expect(server.state.commands).toEqual([]);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(server.state.commands).toEqual(["stop"]));
    await vi.waitFor(() => expect(fake.cockpit()).toBe(true)); // back on the cockpit page, status refreshed
  });

  it("2× or a swipe cancels the armed stop and sends nothing; 2× then goes back to the cockpit", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await open(fake, 0);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("> Sequenz anhalten"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.footer()).toContain("Nochmal tippen = anhalten"));
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = anwählen · Wischen = Zeile · 2× = zurück"));
    expect(fake.body()).toContain("> Sequenz anhalten");
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.footer()).toContain("Nochmal tippen = anhalten"));
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = anwählen · Wischen = Zeile · 2× = zurück"));
    expect(server.state.commands).toEqual([]);
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.cockpit()).toBe(true));
    expect(fake.exit.calls).toEqual([]);
  });

  it("the armed stop expires after 4 s", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await open(fake, 0);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("> Sequenz anhalten"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.footer()).toContain("Nochmal tippen = anhalten"));
    await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = anwählen · Wischen = Zeile · 2× = zurück"), { timeout: 5_500 });
    expect(server.state.commands).toEqual([]);
  });

  it("a hold does nothing: no help page, no menu - on the start page and in the cockpit", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("Star Glass · ● live"));
    const pagesBefore = fake.pages.length;
    fake.emit(HOLD);
    await new Promise((r) => setTimeout(r, 40));
    expect(fake.pages.length).toBe(pagesBefore);
    expect(fake.header()).toBe("Star Glass · ● live");
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.cockpit()).toBe(true));
    await vi.waitFor(() => expect(new Set(fake.tiles()).size).toBe(4));
    await new Promise((r) => setTimeout(r, 50));
    const tilesBefore = fake.tiles().length;
    const rebuilds = fake.bridge.rebuildPageContainer.mock.calls.length;
    fake.emit(HOLD);
    await new Promise((r) => setTimeout(r, 40));
    expect(fake.cockpit()).toBe(true);
    expect(fake.bridge.rebuildPageContainer.mock.calls.length).toBe(rebuilds);
    expect(fake.tiles().length).toBe(tilesBefore);
    expect(server.state.commands).toEqual([]);
    expect(fake.exit.calls).toEqual([]);
  });

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await open(fake, 0);
    fake.emit(DOWN);
    expect(fake.pages.length).toBeGreaterThan(1);
    for (const page of fake.pages) expect(page.menuObject).toBeUndefined();
    expect(fake.menus().every((menu) => menu.length === 0)).toBe(true);
  });

  it("a bridge that answers with an error shows no HTTP code on the glasses; the phone keeps it", async () => {
    server.fetchMock.mockImplementation(async () => new Response("{}", { status: 503 }));
    const fake = fakeGlasses(configured());
    const root = await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("Star Glass · offline"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.cockpit()).toBe(true));
    for (const page of fake.pages) for (const text of page.textObject ?? []) expect(text.content ?? "").not.toMatch(/HTTP|503/);
    await vi.waitFor(() => expect(root.innerHTML).toContain("HTTP 503"));
  });

  it("an unreachable bridge is named, not hidden", async () => {
    server.fetchMock.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
    const fake = fakeGlasses(configured());
    const root = await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("Star Glass · offline"));
    await vi.waitFor(() => expect(root.innerHTML).toContain("Bridge: nicht erreichbar"));
  });

  it("comes back where it was after a restart (phone locked, app unloaded): the cockpit page, or the start page with its cursor", async () => {
    const first = fakeGlasses(configured());
    await boot(first);
    await open(first, 0);
    first.emit(DOWN);
    first.emit(DOWN);
    await vi.waitFor(() => expect(first.bridge.setLocalStorage.mock.calls.some((call) => String(call[1]).includes('"page":"equipment"'))).toBe(true));
    const second = fakeGlasses(Object.fromEntries(first.storage));
    await boot(second);
    await vi.waitFor(() => expect(second.bridge.createStartUpPageContainer).toHaveBeenCalled());
    // The first page of the restart is created as the cockpit straight away.
    expect(((second.bridge.createStartUpPageContainer.mock.calls[0]![0] as Page).imageObject ?? []).length).toBe(4);
    await vi.waitFor(() => expect(second.cockpit()).toBe(true));
    second.emit(DOUBLE);
    await vi.waitFor(() => expect(second.header()).toBe("Star Glass · ● live"));
    second.emit(DOWN);
    await vi.waitFor(() => expect(second.body()).toContain("● Wetter"));
    const third = fakeGlasses(Object.fromEntries(second.storage));
    await boot(third);
    await vi.waitFor(() => expect(third.body()).toContain("● Wetter"));
  });

  it("fetches the forecast for N.I.N.A.'s site (rounded), flags the weather entry and shows the cloud warning on the start page", async () => {
    server.state.status = { ...STATUS, site: { lat: 47.8123, lon: 13.0456 } };
    const asked: URL[] = [];
    const bridgeFetch = server.fetchMock.getMockImplementation()!;
    server.fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.hostname !== "api.open-meteo.com") return bridgeFetch(input, init);
      asked.push(url);
      const start = Math.floor(Date.now() / 3_600_000) * 3600 - 3600;
      const time = Array.from({ length: 15 }, (_, i) => start + i * 3600);
      const all = (v: number): number[] => time.map(() => v);
      return new Response(JSON.stringify({ hourly: {
        time, cloud_cover: all(90), cloud_cover_low: all(80), cloud_cover_mid: all(50), cloud_cover_high: all(20), precipitation_probability: all(5),
        precipitation: all(0), relative_humidity_2m: all(70), dew_point_2m: all(1), temperature_2m: all(8), wind_speed_10m: all(5), wind_gusts_10m: all(9),
      } }));
    });
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Bewölkt: 90 %"));
    expect(fake.body()).toContain("Wetter · Warnung");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.searchParams.get("latitude")).toBe("47.81");
    expect(asked[0]!.searchParams.get("longitude")).toBe("13.05");
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body()).toContain("● Wetter · Warnung"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.cockpit()).toBe(true));
    await vi.waitFor(() => expect(new Set(fake.tiles()).size).toBe(4));
  });

  it("without a site, coordinates or phone location the weather asks for a location and nothing is fetched", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await open(fake, 1);
    await vi.waitFor(() => expect(fake.tiles().length).toBeGreaterThan(0));
    expect(server.fetchMock.mock.calls.some((call) => String(call[0]).includes("open-meteo"))).toBe(false);
  });

  it("an unchanged cockpit sends no tile at all: nothing crosses Bluetooth while nothing changes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.advanceTimersByTimeAsync(50);
    fake.emit(DOWN);
    await vi.advanceTimersByTimeAsync(50);
    fake.emit(CLICK);                                        // Wetter: no countdown, no clock change within seconds
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.cockpit()).toBe(true);
    const sent = fake.tiles().length;
    expect(sent).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(8_000);                // eight ticks, two polls
    expect(fake.tiles().length).toBe(sent);
  });

  it("stops asking N.I.N.A. in the background and starts again on return; no tile goes out while away", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(server.fetchMock).toHaveBeenCalled());
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.tiles().length).toBeGreaterThan(0));
    fake.emit(5);
    const calls = server.fetchMock.mock.calls.length;
    const tilesAway = fake.tiles().length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.fetchMock.mock.calls.length).toBe(calls);
    expect(fake.tiles().length).toBe(tilesAway);
    fake.emit(4);
    await vi.waitFor(() => expect(server.fetchMock.mock.calls.length).toBeGreaterThan(calls));
  });
});

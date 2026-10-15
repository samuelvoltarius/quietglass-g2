import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRoot, type FakeRoot } from "./fake-dom";

// Boots the real app against a fake glasses bridge and a fake Star Glass bridge server.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const CLICK = 0, UP = 1, DOWN = 2, DOUBLE = 3, HOLD = 9;
const SETTINGS = "quietglass.starglass.v1";

type Page = { textObject?: Array<{ containerID?: number; content?: string }>; imageObject?: unknown[]; menuObject?: { menuItems?: Array<{ itemName?: string; itemID?: number }> } };

function fakeGlasses(stored: Record<string, string> = {}, options: { hangStorage?: boolean } = {}) {
  let handler: ((event: unknown) => void) | undefined;
  const storage = new Map(Object.entries(stored));
  const screen = new Map<number, string>();
  const pages: Page[] = [];
  const exit = { calls: [] as unknown[] };
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
    shutDownPageContainer: (mode?: number): Promise<boolean> => { exit.calls.push(mode); return Promise.resolve(true); },
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

  it("first run: starts in demo with the hint line, explains the setup on the phone and fetches nothing", async () => {
    const fake = fakeGlasses();
    const root = await boot(fake);
    // QIS v1.2 no. 7: no empty setup page, a demo night with the hint to set up the connection.
    await vi.waitFor(() => expect(fake.body()).toContain("Demo · Verbindung am Handy einrichten"));
    expect(fake.header()).toContain("DEMO");
    await vi.waitFor(() => expect(root.innerHTML).toContain("Erster Start"));
    // The phone page is split into tabs, with the bar at the bottom.
    expect(root.innerHTML).toContain('<nav class="tabbar"');
    for (const tab of ["night", "weather", "glasses", "more"]) expect(root.innerHTML).toContain(`data-tab="${tab}"`);
    expect(root.innerHTML).toContain("</span>Nacht</button>");
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it("the gesture handler is there before storage answers: a double tap still leaves", async () => {
    const fake = fakeGlasses({}, { hangStorage: true });
    await boot(fake, false);
    fake.emit(DOUBLE);
    expect(fake.exit.calls).toEqual([1]);
  });

  it("one ignored rebuild, one create, then only rebuilds while swiping through the pages", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("STARGLASS · ÜBERSICHT · läuft"));
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
    expect(fake.bridge.rebuildPageContainer.mock.invocationCallOrder[0]).toBeLessThan(fake.bridge.createStartUpPageContainer.mock.invocationCallOrder[0]!);
    const headers = ["STARGLASS · WETTER · läuft", "STARGLASS · GUIDING & FOKUS · läuft", "STARGLASS · AUSRÜSTUNG · läuft", "STARGLASS · LETZTES BILD · läuft", "STARGLASS · ÜBERSICHT · läuft"];
    for (const expected of headers) {
      fake.emit(DOWN);
      await vi.waitFor(() => expect(fake.header()).toBe(expected));
    }
    fake.emit(UP);
    await vi.waitFor(() => expect(fake.header()).toBe("STARGLASS · LETZTES BILD · läuft"));
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
    for (const page of fake.pages) expect((page.imageObject ?? []).length).toBeLessThanOrEqual(4);
  });

  it("the newest frame is fetched for the image page only, once per key", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("STARGLASS · ÜBERSICHT · läuft"));
    expect(server.state.previews).toBe(0);
    fake.emit(UP);
    await vi.waitFor(() => expect(server.state.previews).toBe(1));
    await vi.waitFor(() => expect(fake.bridge.updateImageRawData.mock.calls.some((call) => call[0].containerName === "frame")).toBe(true));
    fake.emit(CLICK); // tap = control (allowed) - leave it again
    fake.emit(DOUBLE);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.state.previews).toBe(1);
  });

  it("stopping the sequence needs two taps", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("STARGLASS · ÜBERSICHT · läuft"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("> Sequenz anhalten"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.footer()).toBe("Nochmal tippen = anhalten · Wischen/2× = abbrechen"));
    expect(server.state.commands).toEqual([]);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(server.state.commands).toEqual(["stop"]));
    await vi.waitFor(() => expect(fake.header()).toBe("STARGLASS · ÜBERSICHT · bereit"));
  });

  it("2× or a swipe cancels the armed stop and sends nothing; 2× then goes back", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("STARGLASS · ÜBERSICHT · läuft"));
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
    await vi.waitFor(() => expect(fake.header()).toBe("STARGLASS · ÜBERSICHT · läuft"));
    expect(fake.exit.calls).toEqual([]);
  });

  it("the armed stop expires after 4 s", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("STARGLASS · ÜBERSICHT · läuft"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("> Sequenz anhalten"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.footer()).toContain("Nochmal tippen = anhalten"));
    await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = anwählen · Wischen = Zeile · 2× = zurück"), { timeout: 5_500 });
    expect(server.state.commands).toEqual([]);
  });

  it("a hold opens the help page; only 2× leaves it", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("STARGLASS · ÜBERSICHT · läuft"));
    fake.emit(HOLD);
    await vi.waitFor(() => expect(fake.header()).toBe("STARGLASS · Hilfe"));
    expect(fake.footer()).toBe("2× = zurück");
    fake.emit(DOWN);
    fake.emit(CLICK);
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.header()).toBe("STARGLASS · Hilfe");
    expect(server.state.commands).toEqual([]);
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.header()).toBe("STARGLASS · ÜBERSICHT · läuft"));
    expect(fake.exit.calls).toEqual([]);
  });

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("STARGLASS · ÜBERSICHT · läuft"));
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.header()).not.toBe("STARGLASS · ÜBERSICHT · läuft"));
    expect(fake.pages.length).toBeGreaterThan(0);
    for (const page of fake.pages) expect(page.menuObject).toBeUndefined();
    expect(fake.menus().every((menu) => menu.length === 0)).toBe(true);
  });

  it("QIS v1.2: a bridge that answers with an error shows no HTTP code on the glasses; the phone keeps it", async () => {
    server.fetchMock.mockImplementation(async () => new Response("{}", { status: 503 }));
    const fake = fakeGlasses(configured());
    const root = await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Bridge: Serverfehler"));
    expect(fake.body() + fake.header() + fake.footer()).not.toMatch(/HTTP|503/);
    await vi.waitFor(() => expect(root.innerHTML).toContain("HTTP 503"));
  });

  it("an unreachable bridge is named, not hidden", async () => {
    server.fetchMock.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Bridge: nicht erreichbar"));
    expect(fake.header()).toBe("STARGLASS · keine Verbindung");
  });

  it("comes back on the same page after a restart (phone locked, app unloaded)", async () => {
    const first = fakeGlasses(configured());
    await boot(first);
    await vi.waitFor(() => expect(first.header()).toBe("STARGLASS · ÜBERSICHT · läuft"));
    first.emit(DOWN);
    first.emit(DOWN);
    await vi.waitFor(() => expect(first.header()).toBe("STARGLASS · GUIDING & FOKUS · läuft"));
    const second = fakeGlasses(Object.fromEntries(first.storage));
    await boot(second);
    await vi.waitFor(() => expect(second.header()).toBe("STARGLASS · GUIDING & FOKUS · läuft"));
  });

  it("fetches the forecast for N.I.N.A.'s site (rounded) and pops a cloud warning up over the page", async () => {
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
    await vi.waitFor(() => expect(fake.header()).toBe("STARGLASS · Bewölkt: 90 %"));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.searchParams.get("latitude")).toBe("47.81");
    expect(asked[0]!.searchParams.get("longitude")).toBe("13.05");
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body()).toContain("Bewölkt, kein Aufklaren"));
    await vi.waitFor(() => expect(fake.bridge.updateImageRawData.mock.calls.some((call) => call[0].containerName === "clouds")).toBe(true));
  });

  it("without a site, coordinates or phone location the weather page asks for a location and nothing is fetched", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("STARGLASS · ÜBERSICHT · läuft"));
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body()).toContain("Kein Standort bekannt."));
    expect(server.fetchMock.mock.calls.some((call) => String(call[0]).includes("open-meteo"))).toBe(false);
  });

  it("stops asking N.I.N.A. in the background and starts again on return", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(server.fetchMock).toHaveBeenCalled());
    fake.emit(5);
    const calls = server.fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.fetchMock.mock.calls.length).toBe(calls);
    fake.emit(4);
    await vi.waitFor(() => expect(server.fetchMock.mock.calls.length).toBeGreaterThan(calls));
  });
});

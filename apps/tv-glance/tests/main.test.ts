import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRoot, type FakeRoot } from "./fake-dom";
import { fakeHaWs, type FakeHaOptions } from "./fake-ha";

// Boots the real app against a fake glasses bridge and a fake Home Assistant / bridge (fetch stub).
// Nothing here talks to a real TV, Home Assistant or server.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const CLICK = 0, UP = 1, DOWN = 2, DOUBLE = 3, HOLD = 9, HOLD_RELEASE = 10;
const SETTINGS = "quietglass.tvglance.v1";
const BASE = "https://ha.example:8123";
const ENTITY = "media_player.living_room_tv";
const REMOTE = "remote.living_room_tv";

type Page = { textObject?: Array<{ containerID?: number; content?: string }>; imageObject?: unknown[]; menuObject?: unknown };

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
    ready: () => handler !== undefined,
  };
}

interface Call { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null }

/**
 * A fake Home Assistant: the WebSocket API (global WebSocket stubbed with tests/fake-ha.ts) is the main path;
 * fetch is the REST fallback and must stay unused unless the socket is refused.
 */
function fakeHa(options: FakeHaOptions & { restStatus?: number } = {}) {
  const ws = fakeHaWs(options);
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}): Promise<Response> => {
    calls.push({ url: input, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
    return new Response("{}", { status: options.restStatus ?? 500 });
  });
  /** Service calls as `{name, body}` with body = entity_id + service data, like the REST body. */
  const services = (name?: string): { name: string; body: Record<string, unknown> }[] => ws.services
    .map((c) => ({ name: `${c.domain}/${c.service}`, body: { entity_id: c.target.entity_id, ...c.service_data } }))
    .filter((c) => name === undefined || c.name === name);
  return { ws, calls, tv: ws.tv(), fetchMock, services };
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

const haSettings = (over: Record<string, unknown> = {}): Record<string, string> => ({
  [SETTINGS]: JSON.stringify({ backend: "ha", haUrl: BASE, haToken: "xxxxxxxxxxxxxxxxxxx", entityId: ENTITY, remoteId: REMOTE, ...over }),
});
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

describe("TV Glance on the glasses", () => {
  let ha: ReturnType<typeof fakeHa>;
  beforeEach(() => {
    resetGestureDedupe();
    ha = fakeHa();
    vi.stubGlobal("fetch", ha.fetchMock);
    vi.stubGlobal("WebSocket", ha.ws.WebSocket);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("first run: a demo TV labelled DEMO on the start page, the setup on the phone, nothing fetched", async () => {
    const fake = fakeGlasses();
    const root = await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("● Fernbedienung · an · Netflix · 18"));
    expect(fake.header()).toBe("TV Glance · DEMO");
    expect(fake.body()).toContain("  Apps & Eingang");
    expect(fake.body()).toContain("  Steuerkreuz");
    expect(fake.body()).toContain("DEMO · Fernseher am Handy einrichten");
    expect(fake.footer()).toBe("Tippen = öffnen · Wischen = wählen · 2× = Ende");
    await vi.waitFor(() => expect(root.innerHTML).toContain("In drei Schritten"));
    expect((root.innerHTML.match(/data-tab-go=/g) ?? []).length).toBe(3);
    for (const tab of ["now", "tv", "settings"]) expect(root.innerHTML).toContain(`data-tab="${tab}"`);
    expect(ha.fetchMock).not.toHaveBeenCalled();
  });

  it("the gesture handler is there before storage answers: a double tap still leaves", async () => {
    const fake = fakeGlasses({}, { hangStorage: true });
    await boot(fake, false);
    fake.emit(DOUBLE);
    expect(fake.exit.calls).toEqual([1]);
  });

  it("hardware order (step log 0.5.11): 4 = dialog up -> nothing drawn; 5 = gone after No -> page up again, polling on, next 2x asks", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const fake = fakeGlasses(haSettings());
    await boot(fake);
    await vi.advanceTimersByTimeAsync(10);
    const host = fake.bridge as unknown as Record<string, { mock?: { calls: unknown[] } } | undefined>;
    const pageCalls = (): number => ["createStartUpPageContainer", "rebuildPageContainer", "textContainerUpgrade", "updateImageRawData"].reduce((sum, name) => sum + (host[name]?.mock?.calls.length ?? 0), 0);
    fake.emit(DOUBLE);
    await vi.advanceTimersByTimeAsync(70);
    expect(fake.exit.calls).toEqual([1]);
    fake.emit(4);
    const atShown = pageCalls();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(pageCalls()).toBe(atShown);
    const pagesBefore = fake.pages.length;
    const sockets = ha.ws.sockets.length;
    fake.emit(5);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.pages.length).toBeGreaterThan(pagesBefore);
    await vi.advanceTimersByTimeAsync(11_000);
    // Still connected: the same live socket, no reconnect, nothing over REST.
    expect(ha.ws.sockets.length).toBe(sockets);
    expect(ha.ws.sockets.every((socket) => socket.readyState === 1)).toBe(true);
    expect(ha.fetchMock).not.toHaveBeenCalled();
    fake.emit(DOUBLE);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.exit.calls).toEqual([1, 1]);
  });

  it("a single 2x right after No restores the page first and asks the dialog only then", async () => {
    const fake = fakeGlasses(haSettings());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("TV Glance · ● live"));
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.exit.calls).toEqual([1]));
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const host = fake.bridge as unknown as Record<string, (...args: unknown[]) => unknown>;
    const realCreate = host["createStartUpPageContainer"]!;
    const realShutDown = host["shutDownPageContainer"]!;
    host["createStartUpPageContainer"] = async (...args: unknown[]) => { order.push("create:start"); await gate; const r = await realCreate.apply(fake.bridge, args); order.push("create:done"); return r; };
    host["shutDownPageContainer"] = (...args: unknown[]) => { order.push("shutdown"); return realShutDown.apply(fake.bridge, args); };
    fake.emit(DOUBLE);
    await pause(400);
    expect(order).toEqual(["create:start"]);
    release();
    await pause(1200);
    expect(order).toEqual(["create:start", "create:done", "shutdown"]);
  });

  it("the system ending the app (sysEvent 7) shuts it down: a further double tap does nothing", async () => {
    const fake = fakeGlasses(haSettings());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).not.toBe(""));
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.exit.calls).toEqual([1]));
    fake.emit(7);
    await pause(20);
    fake.emit(DOUBLE);
    await pause(50);
    expect(fake.exit.calls).toEqual([1]);
  });

  it("start page with Home Assistant: live state, three entries, one ignored rebuild and one create", async () => {
    const fake = fakeGlasses(haSettings());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("TV Glance · ● live"));
    expect(fake.body()).toContain("● Fernbedienung · an · Netflix · 20");
    expect(fake.body().split("\n")).toHaveLength(3);
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
    expect(fake.bridge.rebuildPageContainer.mock.invocationCallOrder[0]).toBeLessThan(fake.bridge.createStartUpPageContainer.mock.invocationCallOrder[0]!);
    // The token went only into the Authorization header to the entered address.
    // One WebSocket to the entered address; the token only in the auth message; no REST (no CORS needed).
    expect(ha.ws.urls).toEqual(["wss://ha.example:8123/api/websocket"]);
    expect(ha.ws.sent[0]).toEqual({ type: "auth", access_token: "xxxxxxxxxxxxxxxxxxx" });
    expect(ha.fetchMock).not.toHaveBeenCalled();
  });

  it("remote: tap = play/pause, quick swipes = one burst of volume steps, 2x = back to the start page", async () => {
    const fake = fakeGlasses(haSettings());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("TV Glance · ● live"));
    fake.emit(CLICK);                                   // open the remote (cockpit image)
    await vi.waitFor(() => expect(fake.bridge.updateImageRawData).toHaveBeenCalledTimes(4));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(ha.services("media_player/media_play_pause")).toHaveLength(1));
    fake.emit(UP); fake.emit(UP); fake.emit(UP);
    await pause(100);
    expect(ha.services("remote/send_command").filter((c) => c.body["command"] === "VOLUME_UP")).toHaveLength(0);   // still collecting
    await vi.waitFor(() => expect(ha.services("remote/send_command").filter((c) => c.body["command"] === "VOLUME_UP")).toHaveLength(3));
    fake.emit(DOWN); fake.emit(UP);                     // cancels out
    await pause(600);
    expect(ha.services("remote/send_command").filter((c) => c.body["command"] === "VOLUME_UP")).toHaveLength(3);
    expect(ha.services("remote/send_command").filter((c) => c.body["command"] === "VOLUME_DOWN")).toHaveLength(0);
    fake.emit(DOWN);
    await vi.waitFor(() => expect(ha.services("remote/send_command").filter((c) => c.body["command"] === "VOLUME_DOWN")).toHaveLength(1));
    expect(fake.exit.calls).toEqual([]);
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.header()).toBe("TV Glance · ● live"));
    expect(fake.exit.calls).toEqual([]);
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
    for (const page of fake.pages) expect((page.imageObject ?? []).length).toBeLessThanOrEqual(4);
  });

  it("remote: while the TV is off a tap switches it on", async () => {
    ha.tv.state = "off";
    ha.ws.remote().state = "off";
    const fake = fakeGlasses(haSettings());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Fernbedienung · aus"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.bridge.updateImageRawData).toHaveBeenCalled());
    fake.emit(CLICK);
    await vi.waitFor(() => expect(ha.services("media_player/turn_on")).toHaveLength(1));
    expect(ha.services("media_player/media_play_pause")).toHaveLength(0);
  });

  it("apps & input: switching off needs a second tap within 4 s; 2x cancels; sources go to select_source", async () => {
    const fake = fakeGlasses(haSettings());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("TV Glance · ● live"));
    fake.emit(DOWN);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toBe("Apps & Eingang · ● live"));
    expect(fake.body()).toContain("● Ausschalten");
    expect(fake.body()).toContain("  Ton aus");
    expect(fake.body()).toContain("  YouTube");
    fake.emit(CLICK);                                   // arms
    await vi.waitFor(() => expect(fake.footer()).toBe("Nochmal tippen = ausschalten · Wischen/2× = abbrechen"));
    expect(fake.body()).toContain("Ausschalten? Nochmal tippen (4 s)");
    expect(ha.services("media_player/turn_off")).toHaveLength(0);
    fake.emit(DOUBLE);                                  // cancels, stays on the list
    await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = senden · Wischen = wählen · 2× = zurück"));
    expect(fake.header()).toBe("Apps & Eingang · ● live");
    fake.emit(CLICK);                                   // arms again
    await pause(30);
    fake.emit(CLICK);                                   // confirms
    await vi.waitFor(() => expect(ha.services("media_player/turn_off")).toHaveLength(1));
    // Back to the TV's sources: on again first (the list now offers "Einschalten").
    await vi.waitFor(() => expect(fake.body()).toContain("● Einschalten"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(ha.services("media_player/turn_on")).toHaveLength(1));
    await vi.waitFor(() => expect(fake.body()).toContain("Ton aus"));
    fake.emit(DOWN); fake.emit(DOWN); fake.emit(DOWN);  // power, mute, Netflix, YouTube
    fake.emit(CLICK);
    await vi.waitFor(() => expect(ha.services("media_player/select_source")).toHaveLength(1));
    expect(ha.services("media_player/select_source")[0]?.body).toEqual({ entity_id: ENTITY, source: "YouTube" });
    await vi.waitFor(() => expect(fake.body()).toContain("→ YouTube"));
  });

  it("apps & input: the arming runs out after 4 s, then a tap only arms again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const fake = fakeGlasses(haSettings());
    await boot(fake);
    await vi.advanceTimersByTimeAsync(50);
    fake.emit(DOWN);
    fake.emit(CLICK);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.header()).toBe("Apps & Eingang · ● live");
    fake.emit(CLICK);
    await vi.advanceTimersByTimeAsync(4_200);
    expect(fake.footer()).toBe("Tippen = senden · Wischen = wählen · 2× = zurück");
    fake.emit(CLICK);
    await vi.advanceTimersByTimeAsync(100);
    expect(ha.services("media_player/turn_off")).toHaveLength(0);
    expect(fake.footer()).toContain("Nochmal tippen");
  });

  it("D-pad: keys go to remote.send_command; without a remote entity the entry is not offered", async () => {
    const fake = fakeGlasses(haSettings());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Steuerkreuz"));
    fake.emit(DOWN); fake.emit(DOWN);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toBe("Steuerkreuz · ● live"));
    expect(fake.body().split("\n").slice(0, 5)).toEqual(["● Hoch", "  Runter", "  Links", "  Rechts", "  OK"]);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(ha.services("remote/send_command")).toHaveLength(1));
    expect(ha.services("remote/send_command")[0]?.body).toEqual({ entity_id: REMOTE, command: "DPAD_UP" });
    fake.emit(DOWN); fake.emit(DOWN); fake.emit(DOWN); fake.emit(DOWN); fake.emit(DOWN); fake.emit(DOWN);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(ha.services("remote/send_command")).toHaveLength(2));
    expect(ha.services("remote/send_command")[1]?.body).toEqual({ entity_id: REMOTE, command: "HOME" });
    await vi.waitFor(() => expect(fake.body()).toContain("● Home"));
  });

  it("without a remote entity the start page has two entries and no D-pad", async () => {
    const fake = fakeGlasses(haSettings({ remoteId: "-" }));
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("TV Glance · ● live"));
    expect(fake.body()).not.toContain("Steuerkreuz");
    expect(fake.body().split("\n")).toHaveLength(2);
  });

  it("a hold does nothing anywhere, and no footer offers it", async () => {
    const fake = fakeGlasses(haSettings());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("TV Glance · ● live"));
    const before = fake.body();
    fake.emit(HOLD); fake.emit(HOLD_RELEASE);
    await pause(30);
    expect(fake.body()).toBe(before);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.bridge.updateImageRawData).toHaveBeenCalled());
    fake.emit(HOLD); fake.emit(HOLD_RELEASE);
    await pause(30);
    expect(ha.services()).toHaveLength(0);
    expect(fake.exit.calls).toEqual([]);
    expect(fake.footer() + fake.body()).not.toMatch(/Halten|Hold/);
    for (const page of fake.pages) expect(page.menuObject).toBeUndefined();
  });

  it("a refused token: the glasses say offline without a code, the phone names it; the token is never shown", async () => {
    ha = fakeHa({ token: "a-different-token" });
    vi.stubGlobal("fetch", ha.fetchMock);
    vi.stubGlobal("WebSocket", ha.ws.WebSocket);
    const fake = fakeGlasses(haSettings());
    const root = await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("TV Glance · offline"));
    await vi.waitFor(() => expect(fake.body()).toContain("Zugang abgelehnt"));
    expect(fake.body() + fake.header()).not.toMatch(/401|HTTP/);
    await vi.waitFor(() => expect(root.innerHTML).toContain("Zugang abgelehnt"));
    expect(root.innerHTML).not.toContain("xxxxxxxxxxxxxxxxxxx");
    expect(root.innerHTML).toContain("gesetzt (19 Zeichen)");
    const logged = [...(console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls, ...(console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls].flat().map(String).join(" ");
    expect(logged).not.toContain("xxxxxxxxxxxxxxxxxxx");
  });

  it("a server error is shown on the phone with its status, never on the glasses", async () => {
    // WebSocket blocked, so the REST fallback is tried, and that answers 503.
    ha = fakeHa({ refuse: true, restStatus: 503 });
    vi.stubGlobal("fetch", ha.fetchMock);
    vi.stubGlobal("WebSocket", ha.ws.WebSocket);
    const fake = fakeGlasses(haSettings());
    const root = await boot(fake);
    await vi.waitFor(() => expect(ha.fetchMock).toHaveBeenCalled());
    expect(ha.calls[0]?.url).toBe(BASE + "/api/states/" + ENTITY);
    await vi.waitFor(() => expect(fake.header()).toBe("TV Glance · offline"));
    await vi.waitFor(() => expect(root.innerHTML).toContain("HTTP 503"));
    expect(fake.body()).not.toContain("503");
  });

  it("the phone shows the page's origin for Home Assistant's cors_allowed_origins", async () => {
    vi.stubGlobal("location", { search: "", origin: "http://127.0.0.1:54321" });
    const fake = fakeGlasses(haSettings());
    const root = await boot(fake);
    await vi.waitFor(() => expect(root.innerHTML).toContain("cors_allowed_origins"));
    expect(root.innerHTML).toContain("- http://127.0.0.1:54321");
  });

  it("the bridge backend sends text/plain without a header when no token is set", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
      calls.push({ url: input, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
      if (input.endsWith("/state")) return new Response(JSON.stringify({ name: "Shield", on: true, app_label: "Kodi", volume: 30, muted: false }));
      return new Response("{\"ok\":true}");
    }));
    const fake = fakeGlasses({ [SETTINGS]: JSON.stringify({ backend: "bridge", bridgeUrl: "http://192.168.1.20:8477" }) });
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("● Fernbedienung · an · Kodi · 30"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.bridge.updateImageRawData).toHaveBeenCalled());
    fake.emit(CLICK);
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith("/key"))).toBe(true));
    const key = calls.find((c) => c.url.endsWith("/key"))!;
    expect(key.body).toEqual({ key: "MEDIA_PLAY_PAUSE" });
    expect(key.headers).toEqual({ "Content-Type": "text/plain" });
    expect(calls.find((c) => c.url.endsWith("/state"))?.headers).toEqual({});
  });
});

// Several devices (0.2.0): a TV and a projector, switched with a tap on the start page's "Gerät" row.
describe("several devices on the glasses", () => {
  const PROJ = "media_player.miprojm05";
  const PROJ_REMOTE = "remote.miprojm05";
  let ha: ReturnType<typeof fakeHa>;
  const twoDevices = (over: Record<string, unknown> = {}): Record<string, string> => haSettings({
    devices: [{ entityId: ENTITY, remoteId: REMOTE, name: "TV" }, { entityId: PROJ, remoteId: PROJ_REMOTE, name: "Beamer" }],
    activeDevice: 0, ...over,
  });
  beforeEach(() => {
    resetGestureDedupe();
    ha = fakeHa();
    // The projector sleeps: Home Assistant reports it (and its remote) as unavailable.
    ha.ws.entities.set(PROJ, { entity_id: PROJ, state: "unavailable", attributes: { friendly_name: "Projector" } });
    ha.ws.entities.set(PROJ_REMOTE, { entity_id: PROJ_REMOTE, state: "unavailable", attributes: {} });
    vi.stubGlobal("fetch", ha.fetchMock);
    vi.stubGlobal("WebSocket", ha.ws.WebSocket);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("one device: no switch row and no name in the header", async () => {
    const fake = fakeGlasses(haSettings({ devices: [{ entityId: ENTITY, remoteId: REMOTE, name: "TV" }] }));
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("TV Glance · ● live"));
    expect(fake.body()).not.toContain("Gerät");
    expect(fake.body().split("\n")).toHaveLength(3);
  });

  it("tap on the Gerät row switches TV -> projector -> TV: header, state, commands and storage follow; an unavailable device takes no commands", async () => {
    const fake = fakeGlasses(twoDevices());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("TV Glance · TV · ● live"));
    expect(fake.body()).toContain("● Fernbedienung · an · Netflix · 20");
    expect(fake.body()).toContain("  Gerät: TV (1/2)");
    // Only temple gestures: swipe down three times to the last row, tap.
    fake.emit(DOWN); fake.emit(DOWN); fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body()).toContain("● Gerät: TV (1/2)"));
    expect(fake.footer()).toBe("Tippen = Gerät wechseln · Wischen = wählen · 2× = Ende");
    expect(fake.footer().toLowerCase()).not.toMatch(/halten|hold/);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toBe("TV Glance · Beamer · ● live"));
    expect(fake.body()).toContain("  Fernbedienung · nicht verfügbar");
    expect(fake.body()).toContain("● Gerät: Beamer (2/2)");
    expect(JSON.parse(fake.storage.get(SETTINGS)!)).toMatchObject({ activeDevice: 1 });
    // Both devices were subscribed on the one connection; the switch did not resubscribe.
    const subscribe = ha.ws.sent.filter((m) => m["type"] === "subscribe_entities");
    expect(subscribe).toHaveLength(1);
    expect(subscribe[0]).toMatchObject({ entity_ids: expect.arrayContaining([ENTITY, REMOTE, PROJ, PROJ_REMOTE]) });
    expect(ha.ws.sockets).toHaveLength(1);

    // Open the remote of the sleeping projector: a tap sends nothing.
    fake.emit(UP); fake.emit(UP); fake.emit(UP);
    await pause(20);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.bridge.updateImageRawData).toHaveBeenCalled());
    fake.emit(CLICK);
    await pause(400);
    expect(ha.services()).toHaveLength(0);

    // It wakes up: the live update arrives and the next tap goes to the projector, not the TV.
    ha.ws.entities.get(PROJ)!.state = "paused";
    ha.ws.push(PROJ);
    await pause(300);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(ha.services("media_player/media_play_pause")).toHaveLength(1));
    expect(ha.services("media_player/media_play_pause")[0]?.body["entity_id"]).toBe(PROJ);

    // Back to the start page, switch to the TV again: commands go to the TV.
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.header()).toBe("TV Glance · Beamer · ● live"));
    fake.emit(DOWN); fake.emit(DOWN); fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body()).toContain("● Gerät: Beamer (2/2)"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toBe("TV Glance · TV · ● live"));
    expect(JSON.parse(fake.storage.get(SETTINGS)!)).toMatchObject({ activeDevice: 0 });
    fake.emit(UP); fake.emit(UP); fake.emit(UP);
    await pause(20);
    fake.emit(CLICK);
    await pause(100);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(ha.services("media_player/media_play_pause")).toHaveLength(2));
    expect(ha.services("media_player/media_play_pause")[1]?.body["entity_id"]).toBe(ENTITY);
  });

  it("the saved active device is used at the start", async () => {
    const fake = fakeGlasses(twoDevices({ activeDevice: 1 }));
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("TV Glance · Beamer · ● live"));
    expect(fake.body()).toContain("Fernbedienung · nicht verfügbar");
  });

  it("the phone lists the devices with name field, remote choice and remove button", async () => {
    const fake = fakeGlasses(twoDevices());
    const root = await boot(fake);
    await vi.waitFor(() => expect(root.innerHTML).toContain('data-dev-name="media_player.miprojm05"'));
    expect(root.innerHTML).toContain('data-dev-remove="media_player.living_room_tv"');
    expect(root.innerHTML).toContain('data-dev-remote="media_player.miprojm05"');
  });
});

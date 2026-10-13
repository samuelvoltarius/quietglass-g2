import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRoot, type FakeRoot } from "./fake-dom";

// Boots the real app against a fake glasses bridge and a fake Star Glass bridge server.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const CLICK = 0, UP = 1, DOWN = 2, DOUBLE = 3;
const SETTINGS = "quietglass.starglass.v1";

type Page = { textObject?: Array<{ containerID?: number; content?: string }>; imageObject?: unknown[] };

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

  it("first run: explains the setup in German (account in Austria) and fetches nothing", async () => {
    const fake = fakeGlasses();
    const root = await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Noch keine Bridge eingerichtet."));
    await vi.waitFor(() => expect(root.innerHTML).toContain("Erster Start"));
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
    await vi.waitFor(() => expect(fake.header()).toBe("ÜBERSICHT · läuft"));
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
    expect(fake.bridge.rebuildPageContainer.mock.invocationCallOrder[0]).toBeLessThan(fake.bridge.createStartUpPageContainer.mock.invocationCallOrder[0]!);
    const headers = ["GUIDING & FOKUS · läuft", "AUSRÜSTUNG · läuft", "LETZTES BILD · läuft", "ÜBERSICHT · läuft"];
    for (const expected of headers) {
      fake.emit(DOWN);
      await vi.waitFor(() => expect(fake.header()).toBe(expected));
    }
    fake.emit(UP);
    await vi.waitFor(() => expect(fake.header()).toBe("LETZTES BILD · läuft"));
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
    for (const page of fake.pages) expect((page.imageObject ?? []).length).toBeLessThanOrEqual(4);
  });

  it("the newest frame is fetched for the image page only, once per key", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("ÜBERSICHT · läuft"));
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
    await vi.waitFor(() => expect(fake.header()).toBe("ÜBERSICHT · läuft"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("> Sequenz anhalten"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("Nochmal tippen = ANHALTEN bestätigen"));
    expect(server.state.commands).toEqual([]);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(server.state.commands).toEqual(["stop"]));
    await vi.waitFor(() => expect(fake.header()).toBe("ÜBERSICHT · bereit"));
  });

  it("an unreachable bridge is named, not hidden", async () => {
    server.fetchMock.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Bridge: nicht erreichbar"));
    expect(fake.header()).toBe("STAR GLASS · keine Verbindung");
  });

  it("comes back on the same page after a restart (phone locked, app unloaded)", async () => {
    const first = fakeGlasses(configured());
    await boot(first);
    await vi.waitFor(() => expect(first.header()).toBe("ÜBERSICHT · läuft"));
    first.emit(DOWN);
    await vi.waitFor(() => expect(first.header()).toBe("GUIDING & FOKUS · läuft"));
    const second = fakeGlasses(Object.fromEntries(first.storage));
    await boot(second);
    await vi.waitFor(() => expect(second.header()).toBe("GUIDING & FOKUS · läuft"));
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

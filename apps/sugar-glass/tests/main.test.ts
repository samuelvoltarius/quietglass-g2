import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRoot, type FakeRoot } from "./fake-dom";

// Boots the real app against a fake glasses bridge and a fake Nightscout.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const CLICK = 0, DOWN = 2, DOUBLE = 3;
const SETTINGS = "quietglass.sugarglass.v1";

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
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
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

  it("first run: explains the setup in German (account in Austria), with the notice, and fetches nothing", async () => {
    const fake = fakeGlasses();
    const root = await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Noch kein Nightscout eingerichtet."));
    expect(fake.body()).toContain("keine Therapieentscheidungen");
    await vi.waitFor(() => expect(root.innerHTML).toContain("Erster Start"));
    expect(root.innerHTML).toContain("maßgeblich sind Pumpe und Sensor");
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it("the gesture handler is there before storage answers: a double tap still leaves", async () => {
    const fake = fakeGlasses({}, { hangStorage: true });
    await boot(fake, false);
    fake.emit(DOUBLE);
    expect(fake.exit.calls).toEqual([1]);
  });

  it("shows the value; one ignored rebuild, one create, then only rebuilds between pages", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("123 mg/dL · vor 1 min"));
    expect(fake.body()).toContain("IOB 0,80 E · Reservoir 80 E · Modus –");
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
    expect(fake.bridge.rebuildPageContainer.mock.invocationCallOrder[0]).toBeLessThan(fake.bridge.createStartUpPageContainer.mock.invocationCallOrder[0]!);
    await vi.waitFor(() => expect(fake.bridge.updateImageRawData.mock.calls.some((c) => c[0].containerName === "curve")).toBe(true));
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.header()).toBe("PUMPE · MiniMed 780G"));
    expect(fake.body()).toContain("Reservoir: 80 E · Pumpen-Akku: 50 %");
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.header()).toBe("123 mg/dL · vor 1 min"));
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
    for (const page of fake.pages) expect((page.imageObject ?? []).length).toBeLessThanOrEqual(4);
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
    await vi.waitFor(() => expect(fake.header()).toBe("123 mg/dL · vor 1 min"));
    server.state.sgv = 64;
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toMatch(/NIEDRIG 64 mg\/dL/));
  });

  it("an unreachable server is named, not hidden", async () => {
    server.fetchMock.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Server: nicht erreichbar"));
    expect(fake.header()).toBe("SUGAR GLASS · keine Verbindung");
  });
});

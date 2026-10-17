import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRoot, type FakeRoot } from "./fake-dom";
import { deriveRaw } from "../src/car/derive";
import { demoTelemetry, type DemoScene } from "../src/car/demo";

// Boots the real app against a fake glasses bridge and a fake byd-bridge.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const CLICK = 0, UP = 1, DOWN = 2, DOUBLE = 3, HOLD = 9;
const SETTINGS = "quietglass.bydglass.v1";

type Page = { textObject?: Array<{ containerID?: number; content?: string }>; imageObject?: unknown[] };

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
    menu: (itemID: number) => handler?.({ menuItemClickEvent: { itemID } }),
    menuLabels: () => {
      const page = [...pages].reverse().find((item) => (item as { menuObject?: unknown }).menuObject) as { menuObject?: { menuItems?: Array<{ itemName: string }> } } | undefined;
      return (page?.menuObject?.menuItems ?? []).map((item) => item.itemName);
    },
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
    ready: () => handler !== undefined,
  };
}

function fakeBridge(scene: DemoScene = "parked") {
  const state = {
    scene,
    rev: 1,
    calls: [] as Array<{ url: string; init: RequestInit }>,
    commands: [] as unknown[],
    command: null as Record<string, unknown> | null,
    down: false,
    carOn: false,
  };
  const body = () => ({
    ...deriveRaw(demoTelemetry(state.scene, 1_000), 1, {}),
    rev: state.rev,
    at: Date.now(),
    command: state.command,
    car_on: state.carOn,
    control: { enabled: true, lock: true, unlock: false, climate_temp: true },
  });
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}): Promise<Response> => {
    state.calls.push({ url: input, init });
    if (state.down) throw new TypeError("Failed to fetch");
    const url = new URL(input);
    if (url.pathname === "/state") {
      const since = url.searchParams.get("since");
      // A real long-poll would wait; the fake answers at once only when something changed.
      if (since !== null && Number(since) === state.rev) await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(JSON.stringify(body()));
    }
    if (url.pathname === "/command" && init.method === "POST") {
      const parsed = JSON.parse(String(init.body)) as Record<string, unknown>;
      state.commands.push(parsed);
      state.command = { id: "c1", action: parsed["action"], value: parsed["value"] ?? null, status: "sent", text: "", at: Date.now() };
      state.rev += 1;
      return new Response(JSON.stringify({ ok: true, command: state.command }), { status: 202 });
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

const configured = (): Record<string, string> => ({ [SETTINGS]: JSON.stringify({ url: "https://car.example:8471" }) });

describe("BYD Glass lifecycle", () => {
  let server: ReturnType<typeof fakeBridge>;
  beforeEach(() => {
    resetGestureDedupe();
    server = fakeBridge();
    vi.stubGlobal("fetch", server.fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("first run without a bridge: demo on the glasses (German, account in Austria), hint on the phone, no network", async () => {
    const fake = fakeGlasses();
    const root = await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toContain("DEMO"));
    await vi.waitFor(() => expect(root.innerHTML).toContain("Demo-Modus"));
    expect(root.innerHTML).toContain("Erster Start");
    // Phone page in tabs: Auto · Laden · Steuern · Brille · Verbindung · Mehr; the bridge address lives under "Verbindung".
    const tabs = [...root.innerHTML.matchAll(/data-tab-go="(\w+)"/g)].map((m) => m[1]);
    expect(tabs).toEqual(["car", "charge", "control", "glasses", "connection", "more"]);
    expect(root.innerHTML.split('data-tab="connection"')[1]).toContain('id="url"');
    expect(root.innerHTML.split('data-tab="glasses"')[1]).toContain('id="invert"');
    await vi.waitFor(() => expect(root.innerHTML).toContain("Reifen"));
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
    await vi.waitFor(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1));
    await new Promise((done) => setTimeout(done, 50));
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

  it("hardware order (step log 0.5.11): 4 = dialog up -> nothing drawn; 5 = dialog gone after No -> page up again, stream on, next 2x asks", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).not.toBe(""));
    await new Promise((done) => setTimeout(done, 50));
    const host = fake.bridge as unknown as Record<string, { mock?: { calls: unknown[] } } | undefined>;
    const pageCalls = (): number => ["createStartUpPageContainer", "rebuildPageContainer", "textContainerUpgrade", "updateImageRawData"].reduce((sum, name) => sum + (host[name]?.mock?.calls.length ?? 0), 0);
    fake.exit.answer = true;
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.exit.calls).toEqual([1]));
    fake.emit(4);                                            // the dialog is on screen
    const atShown = pageCalls();
    server.state.carOn = true;                               // new data that would redraw the page
    server.state.rev += 1;
    await new Promise((done) => setTimeout(done, 1500));
    expect(pageCalls()).toBe(atShown);                       // nothing drawn over the dialog
    const pagesBefore = fake.pages.length;
    const fetches = server.state.calls.length;
    fake.emit(5);                                            // "No": the dialog is gone
    await vi.waitFor(() => expect(fake.pages.length).toBeGreaterThan(pagesBefore)); // page up again, no gesture needed
    await new Promise((done) => setTimeout(done, 300));
    expect(server.state.calls.length).toBeGreaterThan(fetches); // the stream is still running
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.exit.calls).toEqual([1, 1])); // the very first 2x opens the dialog again
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

  it("parked car opens on the status page; one ignored rebuild, one create, then rebuilds", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("BYD · STATUS · Verriegelt · 64 %"));
    expect(fake.body()).toContain("Verriegelt · Türen zu · 12 V 12,6 V");
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
    expect(fake.bridge.rebuildPageContainer.mock.invocationCallOrder[0]).toBeLessThan(fake.bridge.createStartUpPageContainer.mock.invocationCallOrder[0]!);
    await vi.waitFor(() => expect(fake.bridge.updateImageRawData.mock.calls.some((c) => c[0].containerName === "tyres")).toBe(true));
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.header()).toBe("BYD · STEUERUNG · Klima aus"));
    fake.emit(UP);
    await vi.waitFor(() => expect(fake.header()).toBe("BYD · STATUS · Verriegelt · 64 %"));
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
    for (const page of fake.pages) expect((page.imageObject ?? []).length).toBeLessThanOrEqual(4);
  });

  it("long-polls with since/wait and sends no custom headers", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(server.state.calls.length).toBeGreaterThanOrEqual(2));
    const first = new URL(server.state.calls[0]!.url);
    const second = new URL(server.state.calls[1]!.url);
    expect(first.pathname).toBe("/state");
    expect(first.searchParams.has("since")).toBe(false);
    expect(second.searchParams.get("since")).toBe("1");
    expect(second.searchParams.get("wait")).toBe("25");
    for (const call of server.state.calls) expect(call.init.headers).toBeUndefined();
  });

  it("a mode change switches the page by itself", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toContain("STATUS"));
    server.state.scene = "drive";
    server.state.rev += 1;
    await vi.waitFor(() => expect(fake.header()).toMatch(/^BYD · FAHRT · D · 58 % · 172 km/));
    await vi.waitFor(() => expect(fake.bridge.updateImageRawData.mock.calls.some((c) => c[0].containerName === "speed")).toBe(true));
  });

  it("control: temperature, two confirmations with a pause, one text/plain POST; double tap cancels", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toContain("STATUS"));
    fake.emit(DOWN);
    // Lock and unlock come first; climate on is two swipes further down.
    await vi.waitFor(() => expect(fake.body()).toContain("> Zusperren"));
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body()).toContain("> Aufsperren"));
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body()).toContain("> Klima an 21°"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("Klima an – Temperatur wählen"));
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.body()).toContain("> Klima an 21°"));
    expect(fake.exit.calls).toEqual([]);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("Temperatur wählen"));
    fake.emit(UP);
    await vi.waitFor(() => expect(fake.body()).toContain("22 °C"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("Wirklich Klima an (22 °C)?"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("LETZTE BESTÄTIGUNG"));
    // Inside the pause a tap is ignored.
    fake.emit(CLICK);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.state.commands).toEqual([]);
    await vi.waitFor(() => expect(fake.body()).toContain("Tippen = senden"), { timeout: 3_000 });
    fake.emit(CLICK);
    await vi.waitFor(() => expect(server.state.commands).toEqual([{ action: "climate_on", value: 22 }]));
    const post = server.state.calls.find((c) => c.init.method === "POST")!;
    expect(post.init.headers).toBeUndefined();
    expect(typeof post.init.body).toBe("string");
    await vi.waitFor(() => expect(fake.body()).toContain("Klima an 22°: gesendet"));
  });

  it("car on: the control page says so and no tap ever sends", async () => {
    server.state.carOn = true;
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toContain("STATUS"));
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body()).toContain("Auto ist an – Steuerung nur bei ausgeschaltetem Auto"));
    for (let i = 0; i < 4; i += 1) {
      fake.emit(CLICK);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    expect(server.state.commands).toEqual([]);
    expect(server.state.calls.some((c) => c.init.method === "POST")).toBe(false);
    await vi.waitFor(() => expect(fake.body()).toContain("abgelehnt – Auto ist an"));
  });

  it("new warnings pop up over the page; tap dismisses", async () => {
    server.state.scene = "warn";
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toMatch(/ACHTUNG · 4/));
    expect(fake.body()).toContain("Reifen hinten rechts: Druckverlust");
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).not.toMatch(/ACHTUNG/));
    expect(fake.body()).toContain("Nicht versperrt");
  });

  it("QIS v1: a swipe or a hold backs out of a car question and nothing is ever sent", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toContain("STATUS"));
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body()).toContain("> Zusperren"));
    // Question 1, then a swipe: back to the list.
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("Wirklich zusperren?"));
    expect(fake.footer()).toBe("Nochmal tippen = weiter · Wischen/2× = abbrechen");
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body()).toContain("> Zusperren"));
    expect(fake.body()).not.toContain("Wirklich");
    // Question 1, final confirmation (after its pause), then a hold: back to the list, a later tap asks again.
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("Wirklich zusperren?"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("LETZTE BESTÄTIGUNG"));
    await vi.waitFor(() => expect(fake.body()).toContain("Tippen = senden"), { timeout: 3_000 });
    expect(fake.footer()).toBe("Nochmal tippen = SENDEN · Wischen/2× = abbrechen");
    fake.emit(HOLD);
    await vi.waitFor(() => expect(fake.body()).toContain("> Zusperren"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("Wirklich zusperren?"));
    expect(server.state.commands).toEqual([]);
    expect(fake.exit.calls).toEqual([]);
  });

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toContain("STATUS"));
    expect(fake.pages.length).toBeGreaterThan(0);
    for (const page of fake.pages) expect((page as { menuObject?: unknown }).menuObject).toBeUndefined();
    expect(fake.menuLabels()).toEqual([]);
    expect(fake.footer()).toContain("Halten = Hilfe");
  });

  it("a hold opens the help page, only 2x leaves it, and 2x there never exits the app", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toContain("STATUS"));
    fake.emit(HOLD);
    await vi.waitFor(() => expect(fake.header()).toBe("BYD · Hilfe"));
    expect(fake.footer()).toBe("2× = zurück");
    fake.emit(DOWN);
    fake.emit(CLICK);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.header()).toBe("BYD · Hilfe");
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.header()).toContain("STATUS"));
    expect(fake.exit.calls).toEqual([]);
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.exit.calls).toEqual([1]));
  });

  it("the menu click handler is kept: Hilfe closes an open car question, so nothing stays armed behind it", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toContain("STATUS"));
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body()).toContain("> Zusperren"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("Wirklich zusperren?"));
    fake.menu(1);
    await vi.waitFor(() => expect(fake.header()).toBe("BYD · Hilfe"));
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.body()).toContain("> Zusperren"));
    expect(fake.body()).not.toContain("Wirklich");
    expect(server.state.commands).toEqual([]);
  });

  it("QIS v1: 2x on a warning overlay closes it instead of leaving the app", async () => {
    server.state.scene = "warn";
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toMatch(/ACHTUNG · 4/));
    expect(fake.footer()).toBe("Tippen = ok · 2× = zurück");
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.header()).not.toMatch(/ACHTUNG/));
    expect(fake.exit.calls).toEqual([]);
  });

  it("an unreachable bridge is named, not hidden", async () => {
    server.state.down = true;
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("BYD · keine Verbindung"));
    expect(fake.body()).toContain("nicht erreichbar");
  });
});

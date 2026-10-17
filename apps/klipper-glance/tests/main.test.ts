import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRoot, type FakeRoot } from "./fake-dom";

// Boots the real app against a fake bridge and a fake Klipper Glance bridge server.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const nodeProcess = (globalThis as unknown as { process: { on(event: string, listener: (reason: unknown) => void): void; off(event: string, listener: (reason: unknown) => void): void } }).process;

const CLICK = 0, UP = 1, DOWN = 2, DOUBLE = 3, HOLD = 9;
const SETTINGS = "quietglass.klipperglance.v1";

function fakeGlasses(stored: Record<string, string> = {}) {
  let handler: ((event: unknown) => void) | undefined;
  const storage = new Map(Object.entries(stored));
  const screen = new Map<number, string>();
  const exit = { calls: [] as unknown[], answer: true as boolean | "reject" };
  const pages: Array<{ menuObject?: { menuItems?: Array<{ itemName: string }> } }> = [];
  const bridge = {
    getLocalStorage: vi.fn(async (key: string) => storage.get(key) ?? ""),
    setLocalStorage: vi.fn(async (key: string, value: string) => { storage.set(key, value); return true; }),
    updateImageRawData: vi.fn(async () => "success"),
    rebuildPageContainer: vi.fn(async (page: { menuObject?: { menuItems?: Array<{ itemName: string }> }; textObject?: Array<{ containerID?: number; content?: string }> }) => {
      pages.push(page);
      for (const text of page.textObject ?? []) screen.set(text.containerID ?? 0, text.content ?? "");
      return true;
    }),
    createStartUpPageContainer: vi.fn(async (page: { menuObject?: { menuItems?: Array<{ itemName: string }> }; textObject?: Array<{ containerID?: number; content?: string }> }) => {
      pages.push(page);
      for (const text of page.textObject ?? []) screen.set(text.containerID ?? 0, text.content ?? "");
      return 0;
    }),
    textContainerUpgrade: vi.fn(async (update: { containerID?: number; content?: string }) => {
      screen.set(update.containerID ?? 0, update.content ?? "");
      return true;
    }),
    shutDownPageContainer: (mode?: number): Promise<boolean> => {
      exit.calls.push(mode);
      return exit.answer === "reject" ? Promise.reject(new Error("ble gone")) : Promise.resolve(exit.answer);
    },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, exit, pages,
    header: () => screen.get(1) ?? "",
    body: () => screen.get(2) ?? "",
    footer: () => screen.get(3) ?? "",
    menu: (itemID: number) => handler?.({ menuItemClickEvent: { itemID } }),
    menuLabels: () => {
      const page = [...pages].reverse().find((item) => item.menuObject);
      return (page?.menuObject?.menuItems ?? []).map((item) => item.itemName);
    },
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
    ready: () => handler !== undefined,
  };
}

function fakeBridgeServer() {
  const state = {
    printer: { online: true, state: "printing", file: "halterung.gcode", progress: 42, layer: 75, layers: 180, minutesLeft: 80, nozzle: { now: 219, target: 220 }, bed: { now: 60, target: 60 }, speed: 100, message: "", controllable: true } as Record<string, unknown>,
    hang: false,
    commands: [] as string[],
    statusCalls: 0,
  };
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}): Promise<Response> => {
    const path = new URL(input).pathname;
    if (path === "/api/printer") {
      state.statusCalls++;
      if (state.hang) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return new Response(JSON.stringify(state.printer));
    }
    if (path === "/api/printer/cmd") {
      const command = (JSON.parse(String(init.body)) as { command: string }).command;
      state.commands.push(command);
      if (command === "pause") state.printer = { ...state.printer, state: "paused" };
      return new Response(JSON.stringify({ ok: true, command }));
    }
    return new Response("{}", { status: 404 });
  });
  return { state, fetchMock };
}

async function boot(fake: ReturnType<typeof fakeGlasses>, language = "de-DE"): Promise<FakeRoot> {
  const root = fakeRoot();
  vi.stubGlobal("document", { getElementById: () => root, activeElement: null });
  vi.stubGlobal("navigator", { language });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  harness.bridge = fake.bridge;
  vi.resetModules();
  await import("../src/main");
  await vi.waitFor(() => expect(fake.ready()).toBe(true));
  return root;
}

const configured = (): Record<string, string> => ({ [SETTINGS]: JSON.stringify({ bridgeUrl: "https://bridge.example" }) });

describe("Klipper Glance lifecycle", () => {
  let server: ReturnType<typeof fakeBridgeServer>;
  beforeEach(() => {
  resetGestureDedupe();
    server = fakeBridgeServer();
    vi.stubGlobal("fetch", server.fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("first run (QIS v1.2 #7): starts in the demo with the hint line and fetches nothing", async () => {
    const fake = fakeGlasses();
    const root = await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Demo · Verbindung am Handy einrichten"));
    expect(fake.header()).toContain("DEMO");
    await vi.waitFor(() => expect(root.innerHTML).toContain("Erster Start"));
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it("double tap on the HUD asks the system (mode 1); a cancelled dialog keeps the app running", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("KLIPPER · druckt"));
    fake.exit.answer = false;
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.exit.calls).toEqual([1]));
    await new Promise((done) => setTimeout(done, 20));
    fake.emit(CLICK);                                        // still alive: opens control
    await vi.waitFor(() => expect(fake.header()).toContain("KLIPPER · Steuern"));
  });

  it("no timer, poll or stream draws while the exit dialog may be on screen; a single 2x right after restores the page first and asks the dialog only then", async () => {
    // The store reviewer's case: the 5 s poll keeps running behind the dialog and must not touch the glasses.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.advanceTimersByTimeAsync(10);
    const pageCalls = (): number => ["createStartUpPageContainer", "rebuildPageContainer", "textContainerUpgrade", "updateImageRawData"].reduce((sum, name) => sum + ((fake.bridge as unknown as Record<string, { mock?: { calls: unknown[] } } | undefined>)[name]?.mock?.calls.length ?? 0), 0);
    fake.exit.answer = true; // resolves as soon as the dialog is shown
    fake.emit(DOUBLE);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.exit.calls).toEqual([1]);
    const callsAtAsk = pageCalls();
    const polls = server.state.statusCalls;
    // The printer moves on: every poll would change the HUD.
    server.state.printer = { ...server.state.printer, progress: 43, nozzle: { now: 221, target: 220 } };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.state.statusCalls).toBeGreaterThan(polls); // the poll ran ...
    expect(pageCalls()).toBe(callsAtAsk); // ... but drew nothing
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
    await vi.advanceTimersByTimeAsync(500);
    expect(order).toEqual(["create:start"]); // the dialog is not asked while the page is still being created
    releaseCreate();
    await vi.advanceTimersByTimeAsync(1500);
    expect(order).toEqual(["create:start", "create:done", "shutdown"]); // restore first, then the dialog, exactly once more
  });

  it("the dialog sends the app to the background (5): after No the very first 2x is not swallowed, it restores and asks again", async () => {
    // Hardware, Klipper 0.5.10: the first 2x after "No" only brought the app back; a swipe and a second 2x were needed.
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("KLIPPER · druckt"));
    fake.exit.answer = true;
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.exit.calls).toEqual([1]));
    await new Promise((done) => setTimeout(done, 20));
    fake.emit(5);                                            // the dialog: FOREGROUND_EXIT
    await new Promise((done) => setTimeout(done, 20));
    const creates = fake.pages.length;
    fake.emit(DOUBLE);                                       // "No", then one 2x as the first thing
    await vi.waitFor(() => expect(fake.exit.calls).toEqual([1, 1]), { timeout: 3000 });
    expect(fake.pages.length).toBeGreaterThan(creates);      // the page went up again before the dialog
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
    server.state.printer = { ...server.state.printer, progress: 44 };
    await vi.advanceTimersByTimeAsync(12_000);
    expect(pageCalls()).toBe(atShown);                       // nothing drawn over the dialog
    const pagesBefore = fake.pages.length;
    const polls = server.state.statusCalls;
    fake.emit(5);                                            // "No": the dialog is gone
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.pages.length).toBeGreaterThan(pagesBefore);  // page up again at once, no gesture needed
    await vi.advanceTimersByTimeAsync(12_000);
    expect(server.state.statusCalls).toBeGreaterThan(polls); // still polling the printer
    fake.emit(DOUBLE);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.exit.calls).toEqual([1, 1]);                 // the very first 2x opens the dialog again
  });

  it("polling goes on after the exit call resolved; the system ending the app (sysEvent 7) stops it; a rejected call leaves no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    nodeProcess.on("unhandledRejection", onUnhandled);
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const fake = fakeGlasses(configured());
      await boot(fake);
      await vi.advanceTimersByTimeAsync(10);
      fake.exit.answer = "reject";
      fake.emit(DOUBLE);
      await vi.advanceTimersByTimeAsync(10);
      fake.exit.answer = true;
      fake.emit(DOUBLE);
      await vi.advanceTimersByTimeAsync(1000); // restore first, then the dialog
      expect(fake.exit.calls).toEqual([1, 1]);
      // Resolving true only means the dialog is shown: still polling.
      const calls = server.state.statusCalls;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(server.state.statusCalls).toBeGreaterThan(calls);
      fake.emit(7); // the user confirmed: the system ends the app
      await vi.advanceTimersByTimeAsync(10);
      const callsAtExit = server.state.statusCalls;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(server.state.statusCalls).toBe(callsAtExit);
    } finally {
      nodeProcess.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("every command needs two taps; a swipe in between drops the first", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = steuern · Halten = Hilfe · 2× = Ende"));
    fake.emit(CLICK);                                        // control screen
    await vi.waitFor(() => expect(fake.body()).toContain("> Pause"));
    fake.emit(CLICK);                                        // arm pause
    await vi.waitFor(() => expect(fake.body()).toContain("Nochmal tippen = Pause bestätigen"));
    await vi.waitFor(() => expect(fake.footer()).toBe("Nochmal tippen = Pause · Wischen/2× = abbrechen"));
    fake.emit(DOWN);                                         // a swipe only cancels, the highlight stays
    await vi.waitFor(() => expect(fake.body()).not.toContain("Nochmal tippen"));
    expect(fake.body()).toContain("> Pause");
    await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = wählen · Wischen = bewegen · 2× = zurück"));
    fake.emit(DOWN);                                         // now it moves
    await vi.waitFor(() => expect(fake.body()).toContain("> Druck abbrechen"));
    fake.emit(CLICK);                                        // arm cancel …
    await vi.waitFor(() => expect(fake.body()).toContain("Druck ABBRECHEN"));
    await vi.waitFor(() => expect(fake.footer()).toBe("Nochmal tippen = Druck abbrechen · 2× = abbrechen"));
    fake.emit(UP);                                           // … drop it again (nothing was sent)
    await vi.waitFor(() => expect(fake.body()).not.toContain("Druck ABBRECHEN"));
    expect(server.state.commands).toEqual([]);
    fake.emit(UP);                                           // move up to Pause
    await vi.waitFor(() => expect(fake.body()).toContain("> Pause"));
    fake.emit(CLICK);                                        // arm pause
    fake.emit(CLICK);                                        // confirm pause
    await vi.waitFor(() => expect(server.state.commands).toEqual(["pause"]));
    await vi.waitFor(() => expect(fake.header()).toBe("KLIPPER · pausiert"));
    expect(fake.body()).toContain("Pause gesendet");
  });

  it("an armed command lapses after a few seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.advanceTimersByTimeAsync(10);
    fake.emit(CLICK);
    fake.emit(DOWN);
    fake.emit(CLICK);                                        // arm cancel
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.body()).toContain("Druck ABBRECHEN");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fake.body()).toContain("Druck ABBRECHEN");         // still waiting after 3 s
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fake.body()).not.toContain("Druck ABBRECHEN");     // lapsed after 4 s (QIS v1)
    fake.emit(CLICK);                                        // only arms again, sends nothing
    await vi.advanceTimersByTimeAsync(10);
    expect(server.state.commands).toEqual([]);
  });

  it("double tap on the control screen goes back to the HUD, never closes", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("KLIPPER · druckt"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toContain("KLIPPER · Steuern"));
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.header()).toBe("KLIPPER · druckt"));
    expect(fake.exit.calls).toEqual([]);
  });

  it("2× while a command is armed only cancels it, and stays on the control screen", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("KLIPPER · druckt"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("> Pause"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("Nochmal tippen = Pause bestätigen"));
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.body()).not.toContain("Nochmal tippen"));
    expect(fake.header()).toContain("KLIPPER · Steuern");
    expect(fake.exit.calls).toEqual([]);
    expect(server.state.commands).toEqual([]);
    fake.emit(DOUBLE);                                       // not armed: this one goes back
    await vi.waitFor(() => expect(fake.header()).toBe("KLIPPER · druckt"));
  });

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("KLIPPER · druckt"));
    expect(fake.menuLabels()).toEqual([]);
    expect(fake.pages.length).toBeGreaterThan(0);
    for (const page of fake.pages) expect(page.menuObject).toBeUndefined();
  });

  it("a hold opens the help from the HUD; tap, hold or 2× close it; 2× never exits there", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("KLIPPER · druckt"));
    fake.emit(HOLD);
    await vi.waitFor(() => expect(fake.header()).toBe("KLIPPER · Hilfe"));
    expect(fake.footer()).toBe("Tippen = zurück · 2× = zurück");
    fake.emit(DOWN);                                         // a swipe changes nothing in the help
    await new Promise((done) => setTimeout(done, 30));
    expect(fake.header()).toBe("KLIPPER · Hilfe");
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.header()).toBe("KLIPPER · druckt"));
    expect(fake.exit.calls).toEqual([]);
  });

  it("QIS v1.2: the menu's Hilfe drops an armed command, nothing is sent", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.footer()).toContain("Tippen = steuern"));
    fake.emit(CLICK);                                        // control screen
    await vi.waitFor(() => expect(fake.body()).toContain("> Pause"));
    fake.emit(CLICK);                                        // arm pause
    await vi.waitFor(() => expect(fake.body()).toContain("Nochmal tippen = Pause bestätigen"));
    fake.menu(1);
    await vi.waitFor(() => expect(fake.header()).toBe("KLIPPER · Hilfe"));
    fake.emit(DOUBLE);                                       // back to the HUD; the question is gone
    await vi.waitFor(() => expect(fake.header()).toBe("KLIPPER · druckt"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("> Pause"));
    expect(fake.body()).not.toContain("Nochmal tippen");
    expect(server.state.commands).toEqual([]);
  });

  it("without control permission, tap refreshes instead of opening controls", async () => {
    server.state.printer = { ...server.state.printer, controllable: false };
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = aktualisieren · Halten = Hilfe · 2× = Ende"));
    const before = server.state.statusCalls;
    fake.emit(CLICK);
    await vi.waitFor(() => expect(server.state.statusCalls).toBe(before + 1));
    await vi.waitFor(() => expect(fake.header()).toBe("KLIPPER · druckt"));
  });

  it("never stacks polls against a stalled bridge, and says so after the timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    server.state.hang = true;
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.advanceTimersByTimeAsync(5_500);                // interval fired while the first poll hangs
    expect(server.state.statusCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);                // first poll times out at 6 s
    expect(fake.body()).toContain("Bridge: keine Antwort");
  });

  it("the phone page escapes the printer's file name", async () => {
    server.state.printer = { ...server.state.printer, file: '"><img src=x onerror=alert(1)>.gcode' };
    const fake = fakeGlasses(configured());
    const root = await boot(fake, "en-US");
    await vi.waitFor(() => expect(root.innerHTML).toContain("printing · 42 %"));
    expect(root.innerHTML).not.toContain("<img");
    expect(root.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("stops asking the printer while in the background and starts again on return", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(server.state.statusCalls).toBeGreaterThan(0));
    fake.emit(5);
    const calls = server.state.statusCalls;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.state.statusCalls).toBe(calls);
    fake.emit(4);
    await vi.waitFor(() => expect(server.state.statusCalls).toBeGreaterThan(calls));
  });
});

describe("build address", () => {
  it("reads the build's address and drops a stored placeholder once in its favour", async () => {
    const persist = await import("../src/storage/persist");
    const build = persist.buildUrl("https://printer.test:8447/");
    expect(build).toBe("https://printer.test:8447");
    expect(persist.buildUrl("not a url")).toBe("");
    expect(persist.parseSettings(JSON.stringify({ bridgeUrl: "http://127.0.0.1:8898" }), build).bridgeUrl).toBe("");
    expect(persist.parseSettings(JSON.stringify({ bridgeUrl: "https://your-machine.home.example" }), build).bridgeUrl).toBe("");
    expect(persist.parseSettings(JSON.stringify({ bridgeUrl: "https://other.test" }), build).bridgeUrl).toBe("https://other.test");
    expect(persist.effectiveUrl(persist.parseSettings("", build), build)).toBe("https://printer.test:8447");
  });

  it("keeps whatever was typed in a public build", async () => {
    const persist = await import("../src/storage/persist");
    expect(persist.parseSettings(JSON.stringify({ bridgeUrl: "http://127.0.0.1:8898" }), "").bridgeUrl).toBe("http://127.0.0.1:8898");
    expect(persist.effectiveUrl(persist.parseSettings("", ""), "")).toBe("");
  });
});

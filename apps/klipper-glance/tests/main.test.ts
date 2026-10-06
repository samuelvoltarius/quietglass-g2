import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRoot, type FakeRoot } from "./fake-dom";

// Boots the real app against a fake bridge and a fake Klipper Glance bridge server.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const nodeProcess = (globalThis as unknown as { process: { on(event: string, listener: (reason: unknown) => void): void; off(event: string, listener: (reason: unknown) => void): void } }).process;

const CLICK = 0, UP = 1, DOWN = 2, DOUBLE = 3;
const SETTINGS = "quietglass.klipperglance.v1";

function fakeGlasses(stored: Record<string, string> = {}) {
  let handler: ((event: unknown) => void) | undefined;
  const storage = new Map(Object.entries(stored));
  const screen = new Map<number, string>();
  const exit = { calls: [] as unknown[], answer: true as boolean | "reject" };
  const bridge = {
    getLocalStorage: vi.fn(async (key: string) => storage.get(key) ?? ""),
    setLocalStorage: vi.fn(async (key: string, value: string) => { storage.set(key, value); return true; }),
    rebuildPageContainer: vi.fn(async () => true),
    createStartUpPageContainer: vi.fn(async (page: { textObject?: Array<{ containerID?: number; content?: string }> }) => {
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
    bridge, exit,
    header: () => screen.get(1) ?? "",
    body: () => screen.get(2) ?? "",
    footer: () => screen.get(3) ?? "",
    emit: (eventType: number) => handler?.({ sysEvent: { eventType, eventSource: 1 } }),
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
    server = fakeBridgeServer();
    vi.stubGlobal("fetch", server.fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("first run: explains the setup and fetches nothing", async () => {
    const fake = fakeGlasses();
    const root = await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Noch keine Bridge eingerichtet."));
    expect(root.innerHTML).toContain("Erster Start");
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
    await vi.waitFor(() => expect(fake.header()).toContain("STEUERN"));
  });

  it("a confirmed exit stops polling; a rejected one leaves no unhandled rejection", async () => {
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
      await vi.advanceTimersByTimeAsync(10);
      expect(fake.exit.calls).toEqual([1, 1]);
      const calls = server.state.statusCalls;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(server.state.statusCalls).toBe(calls);
    } finally {
      nodeProcess.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("every command needs two taps; a swipe in between drops the first", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.footer()).toBe("tippen = steuern · 2× = Ende"));
    fake.emit(CLICK);                                        // control screen
    await vi.waitFor(() => expect(fake.body()).toContain("> Pause"));
    fake.emit(CLICK);                                        // arm pause
    await vi.waitFor(() => expect(fake.body()).toContain("Nochmal tippen = Pause bestätigen"));
    fake.emit(DOWN);                                         // moving disarms
    await vi.waitFor(() => expect(fake.body()).toContain("> Druck abbrechen"));
    expect(fake.body()).not.toContain("Nochmal tippen");
    fake.emit(CLICK);                                        // arm cancel …
    await vi.waitFor(() => expect(fake.body()).toContain("Druck ABBRECHEN"));
    fake.emit(UP);                                           // … and drop it again
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
    await vi.advanceTimersByTimeAsync(7_000);
    expect(fake.body()).not.toContain("Druck ABBRECHEN");
    fake.emit(CLICK);                                        // only arms again, sends nothing
    await vi.advanceTimersByTimeAsync(10);
    expect(server.state.commands).toEqual([]);
  });

  it("double tap on the control screen goes back to the HUD, never closes", async () => {
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("KLIPPER · druckt"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toContain("STEUERN"));
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.header()).toBe("KLIPPER · druckt"));
    expect(fake.exit.calls).toEqual([]);
  });

  it("without control permission, tap refreshes instead of opening controls", async () => {
    server.state.printer = { ...server.state.printer, controllable: false };
    const fake = fakeGlasses(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.footer()).toBe("tippen = aktualisieren · 2× = Ende"));
    const before = server.state.statusCalls;
    fake.emit(CLICK);
    await vi.waitFor(() => expect(server.state.statusCalls).toBe(before + 1));
    expect(fake.header()).toBe("KLIPPER · druckt");
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
});

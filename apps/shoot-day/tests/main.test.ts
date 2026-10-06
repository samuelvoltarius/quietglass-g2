import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRoot, type FakeRoot } from "./fake-dom";

// Boots the real app against a fake bridge and a fake server, so the lifecycle
// can be checked without glasses or simulator.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

// tsconfig carries no node types; reach the process object structurally.
const nodeProcess = (globalThis as unknown as { process: { on(event: string, listener: (reason: unknown) => void): void; off(event: string, listener: (reason: unknown) => void): void } }).process;

const CLICK = 0, UP = 1, DOWN = 2, DOUBLE = 3, HOLD = 9, RELEASE = 10;
const SETTINGS = "quietglass.shootday.v1";
const OUTBOX = "quietglass.shootday.outbox.v1";

function fakeBridge(stored: Record<string, string> = {}) {
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
    // Plain function, not vi.fn: a spy would attach handlers and hide unhandled rejections.
    shutDownPageContainer: (mode?: number): Promise<boolean> => {
      exit.calls.push(mode);
      return exit.answer === "reject" ? Promise.reject(new Error("ble gone")) : Promise.resolve(exit.answer);
    },
    audioControl: vi.fn(async (_on: boolean, _source?: unknown): Promise<boolean> => true),
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, storage, exit,
    header: () => screen.get(1) ?? "",
    body: () => screen.get(2) ?? "",
    footer: () => screen.get(3) ?? "",
    emit: (eventType: number) => handler?.({ sysEvent: { eventType, eventSource: 1 } }),
    audio: (bytes: number) => handler?.({ audioEvent: { audioPcm: new Uint8Array(bytes) } }),
    ready: () => handler !== undefined,
  };
}

type Fake = ReturnType<typeof fakeBridge>;

/** A small in-memory Shoot Day server behind the fetch mock. */
function fakeServer() {
  const state = {
    down: false,
    hang: new Set<string>(),
    takes: [] as Array<Record<string, unknown>>,
    items: [
      { group: "", name: "Gimbal", need: true, packed: false },
      { group: "", name: "Klappe", need: true, packed: false },
      { group: "", name: "Drohne", need: false, packed: false },
    ],
    heard: "Gimbal eingepackt",
    calls: [] as string[],
  };
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    // The configured address may carry a path prefix (a reverse proxy); route by the /api/ part.
    const path = url.pathname.replace(/^.*?(\/api\/)/, "/api/");
    const key = (init.method ?? "GET") + " " + path;
    state.calls.push(key);
    if (state.down) throw new TypeError("Failed to fetch");
    if (state.hang.has(path)) {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    switch (key) {
      case "GET /api/shotlist": return json({ project: "Testdreh", shots: [{ scene: "1", shot: "A", desc: "Totale", size: "WS" }, { scene: "1", shot: "B", desc: "Nah", size: "CU" }] });
      case "GET /api/takes": return json({ takes: state.takes });
      case "POST /api/take": {
        const n = state.takes.filter((t) => t["scene"] === body["scene"] && t["shot"] === body["shot"]).length + 1;
        const take = { ...body, n, ts: Date.now() };
        state.takes.push(take);
        return json(take);
      }
      case "GET /api/equipment": return json({ project: "Testdreh", items: state.items });
      case "POST /api/equipment": {
        const toggle = body["toggle"] as { name: string; packed: boolean };
        state.items = state.items.map((i) => (i.name === toggle.name ? { ...i, packed: toggle.packed } : i));
        return json({ ok: true });
      }
      case "POST /api/stt": return json({ text: state.heard });
      case "GET /api/prompter": return json({ text: "Erste Zeile.\nZweite Zeile." });
      case "GET /api/dispo": return json({ date: "Mo", call: "07:30", schedule: [] });
      default: return json({ error: "not found" }, 404);
    }
  });
  return { state, fetchMock };
}

async function boot(fake: Fake, language = "de-AT"): Promise<FakeRoot> {
  const root = fakeRoot();
  vi.stubGlobal("document", { getElementById: () => root });
  vi.stubGlobal("navigator", { language });
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
  harness.bridge = fake.bridge;
  vi.resetModules();
  await import("../src/main");
  await vi.waitFor(() => expect(fake.ready()).toBe(true));
  await vi.waitFor(() => expect(root.renders).toBeGreaterThan(0));
  return root;
}

const configured = (): Record<string, string> => ({ [SETTINGS]: JSON.stringify({ serverUrl: "https://shoot.example" }) });

describe("Shoot Day lifecycle", () => {
  let server: ReturnType<typeof fakeServer>;
  beforeEach(() => {
    server = fakeServer();
    vi.stubGlobal("fetch", server.fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("first run without a server: the glasses and the phone say what to do, and nothing is fetched", async () => {
    const fake = fakeBridge();
    const root = await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Noch kein Server eingerichtet."));
    expect(root.innerHTML).toContain("Erster Start");
    expect(server.fetchMock).not.toHaveBeenCalled();
    // A tap on a module stays in the menu instead of opening an empty screen.
    fake.emit(CLICK);
    await new Promise((done) => setTimeout(done, 20));
    expect(fake.header()).toBe("SHOOT DAY");
  });

  it("double tap in the menu asks the system to close (mode 1) and stops only when confirmed", async () => {
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Projekt: Testdreh"));
    fake.exit.answer = true;
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.exit.calls).toEqual([1]));
    await new Promise((done) => setTimeout(done, 20));
    const writes = fake.bridge.textContainerUpgrade.mock.calls.length;
    fake.emit(DOWN);
    await new Promise((done) => setTimeout(done, 20));
    expect(fake.bridge.textContainerUpgrade.mock.calls.length).toBe(writes);
  });

  it("if the user cancels the exit dialog, the app keeps working", async () => {
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Projekt: Testdreh"));
    fake.exit.answer = false;
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.exit.calls).toEqual([1]));
    await new Promise((done) => setTimeout(done, 20));
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body().split("\n")[1]).toBe("> Teleprompter"));
    // And a second double tap asks again.
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.exit.calls).toEqual([1, 1]));
  });

  it("a failing exit call leaves no unhandled rejection and the app alive", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    nodeProcess.on("unhandledRejection", onUnhandled);
    try {
      const fake = fakeBridge(configured());
      await boot(fake);
      fake.exit.answer = "reject";
      fake.emit(DOUBLE);
      await new Promise((done) => setTimeout(done, 30));
      expect(fake.exit.calls).toEqual([1]);
      fake.emit(DOWN);
      await vi.waitFor(() => expect(fake.body().split("\n")[1]).toBe("> Teleprompter"));
    } finally {
      nodeProcess.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("double tap inside a module goes back to the menu and never closes the app", async () => {
    const fake = fakeBridge(configured());
    await boot(fake);
    fake.emit(CLICK);                                       // open Takes
    await vi.waitFor(() => expect(fake.header()).toBe("TAKES · Shot 1/2 · Szene 1"));
    fake.emit(CLICK);                                       // actions
    await vi.waitFor(() => expect(fake.body()).toContain("> Take OK"));
    fake.emit(DOUBLE);                                      // back to the card
    await vi.waitFor(() => expect(fake.header()).toBe("TAKES · Shot 1/2 · Szene 1"));
    fake.emit(DOUBLE);                                      // back to the menu
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY"));
    expect(fake.exit.calls).toEqual([]);
  });

  it("logs a take through the actions list", async () => {
    const fake = fakeBridge(configured());
    await boot(fake);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("Noch kein Take."));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("> Take OK"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("OK 1 · NG 0"));
    await vi.waitFor(() => expect(server.state.takes).toHaveLength(1));
    expect(server.state.takes[0]).toMatchObject({ scene: "1", shot: "A", status: "OK" });
    expect(fake.body()).toContain("gespeichert: 1A T1 OK");
    expect(JSON.parse(fake.storage.get(OUTBOX) ?? "[]")).toEqual([]);
  });

  it("a take logged offline is kept and sent once the server answers again", async () => {
    const fake = fakeBridge(configured());
    await boot(fake);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("Noch kein Take."));
    server.state.down = true;
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("> Take OK"));
    fake.emit(DOWN);                                        // Take NG
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("offline gemerkt"));
    expect(fake.body()).toContain("OK 0 · NG 1");
    expect(JSON.parse(fake.storage.get(OUTBOX) ?? "[]")).toHaveLength(1);
    server.state.down = false;
    fake.emit(DOUBLE);                                      // menu: reloads and flushes
    await vi.waitFor(() => expect(server.state.takes).toHaveLength(1));
    expect(server.state.takes[0]).toMatchObject({ status: "NG" });
    await vi.waitFor(() => expect(JSON.parse(fake.storage.get(OUTBOX) ?? "[]")).toEqual([]));
  });

  it("packing list: hold to speak, release to apply — and the microphone is off afterwards", async () => {
    const fake = fakeBridge(configured());
    await boot(fake);
    fake.emit(UP);                                          // wraps to Packliste
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toBe("PACKLISTE · 0/2 eingepackt"));
    fake.emit(HOLD);
    await vi.waitFor(() => expect(fake.header()).toBe("● MIC · sprich jetzt"));
    await vi.waitFor(() => expect(fake.bridge.audioControl).toHaveBeenLastCalledWith(true, "glasses"));
    for (let i = 0; i < 10; i++) fake.audio(3200);
    fake.emit(RELEASE);
    await vi.waitFor(() => expect(fake.header()).toBe("PACKLISTE · 1/2 eingepackt"));
    expect(fake.bridge.audioControl).toHaveBeenLastCalledWith(false);
    expect(server.state.calls).toContain("POST /api/stt");
    await vi.waitFor(() => expect(server.state.items.find((i) => i.name === "Gimbal")?.packed).toBe(true));
    expect(fake.body()).toContain("abgehakt: Gimbal");
  });

  it("leaving a module while speaking releases the microphone and drops the recording", async () => {
    const fake = fakeBridge(configured());
    await boot(fake);
    fake.emit(UP);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toContain("PACKLISTE"));
    fake.emit(HOLD);
    await vi.waitFor(() => expect(fake.header()).toBe("● MIC · sprich jetzt"));
    fake.audio(32000);
    fake.emit(DOUBLE);                                      // cancels the recording
    await vi.waitFor(() => expect(fake.bridge.audioControl).toHaveBeenLastCalledWith(false));
    await vi.waitFor(() => expect(fake.body()).toContain("abgebrochen"));
    expect(server.state.calls).not.toContain("POST /api/stt");
  });

  it("a tick that the server refuses is taken back on the glasses", async () => {
    const fake = fakeBridge(configured());
    await boot(fake);
    fake.emit(UP);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("> ○ Gimbal"));
    server.state.down = true;
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("nicht gespeichert: nicht erreichbar"));
    expect(fake.body()).toContain("> ○ Gimbal");
  });

  it("never runs two loads of the same list at once, and drops a reply that arrives after leaving", async () => {
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Projekt: Testdreh"));
    server.state.hang.add("/api/equipment");
    fake.emit(UP);
    fake.emit(CLICK);                                       // Packliste: request hangs
    await vi.waitFor(() => expect(fake.body()).toContain("Lade …"));
    fake.emit(DOUBLE);                                      // back to menu
    fake.emit(CLICK);                                       // and in again
    await new Promise((done) => setTimeout(done, 30));
    expect(server.state.calls.filter((c) => c === "GET /api/equipment")).toHaveLength(1);
    server.state.hang.clear();
  });

  it("a server that never answers turns into a clear error after the timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const fake = fakeBridge(configured());
    server.state.hang.add("/api/shotlist");
    await boot(fake);
    await vi.advanceTimersByTimeAsync(7000);
    expect(fake.body()).toContain("Server: keine Antwort");
  });

  it("the phone shows the connection and escapes what it inserts", async () => {
    const fake = fakeBridge({ [SETTINGS]: JSON.stringify({ serverUrl: "https://shoot.example/<img src=x onerror=alert(1)>" }) });
    const root = await boot(fake, "en-US");
    await vi.waitFor(() => expect(root.innerHTML).toContain("Connected – project: Testdreh"));
    expect(root.innerHTML).not.toContain("<img");
    expect(root.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

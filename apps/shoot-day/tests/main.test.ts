import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRoot, type FakeRoot } from "./fake-dom";
import { FakeSocket } from "./fake-socket";

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
  const menus: Array<Array<[number, string]>> = [];
  type MenuPage = { menuObject?: { menuItems?: Array<{ itemID: number; itemName: string }> } };
  const noteMenu = (page?: MenuPage): void => { menus.push((page?.menuObject?.menuItems ?? []).map((item): [number, string] => [item.itemID, item.itemName])); };
  const bridge = {
    getLocalStorage: vi.fn(async (key: string) => storage.get(key) ?? ""),
    setLocalStorage: vi.fn(async (key: string, value: string) => { storage.set(key, value); return true; }),
    rebuildPageContainer: vi.fn(async (page?: { textObject?: Array<{ containerID?: number; content?: string }> } & MenuPage) => {
      for (const text of page?.textObject ?? []) screen.set(text.containerID ?? 0, text.content ?? "");
      noteMenu(page);
      return true;
    }),
    createStartUpPageContainer: vi.fn(async (page: { textObject?: Array<{ containerID?: number; content?: string }> } & MenuPage) => {
      for (const text of page.textObject ?? []) screen.set(text.containerID ?? 0, text.content ?? "");
      noteMenu(page);
      return 0;
    }),
    updateImageRawData: vi.fn(async () => "success"),
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
    bridge, storage, exit, menus: () => menus,
    menu: (itemID: number) => handler?.({ menuItemClickEvent: { itemID } }),
    header: () => screen.get(1) ?? "",
    body: () => screen.get(2) ?? "",
    footer: () => screen.get(3) ?? "",
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
    audio: (bytes: number) => handler?.({ audioEvent: { audioPcm: new Uint8Array(bytes) } }),
    ready: () => handler !== undefined,
  };
}

type Fake = ReturnType<typeof fakeBridge>;

/** A small in-memory Shoot Day server behind the fetch mock. */
function fakeServer() {
  const state = {
    down: false,
    /** A server that does not know `POST /api/take/delete` yet. */
    noDelete: false,
    hang: new Set<string>(),
    takes: [] as Array<Record<string, unknown>>,
    items: [
      { group: "", name: "Gimbal", need: true, packed: false },
      { group: "", name: "Klappe", need: true, packed: false },
      { group: "", name: "Drohne", need: false, packed: false },
    ],
    heard: "Gimbal eingepackt",
    calls: [] as string[],
    // Server 0.5.0: customers and storyboards. Off = an older server (404), as in all tests above.
    customerApi: false,
    active: "p_000000000001",
    customers: [
      { id: "c_000000000001", name: "Anna Beispiel", company: "", projectCount: 0 },
      { id: "c_000000000002", name: "Bäckerei Sonnenschein", company: "Sonnenschein KG", projectCount: 2 },
    ] as Array<{ id: string; name: string; company: string; projectCount: number }>,
    projects: [
      { id: "p_000000000002", name: "Reel Frühstück", date: "", place: "" },
      { id: "p_000000000001", name: "Testdreh", date: "2026-10-14", place: "Backstube" },
    ],
    boards: [{
      id: "s_000000000001", title: "Reel", scenes: [
        { n: 1, from: 0, to: 5, title: "Ankunft", content: "Tür geht auf.", camera: "Totale", overlay: "Willkommen", goal: "", done: false },
        { n: 2, from: 5, to: 12, title: "Hände im Teig", content: "Nahaufnahme.", camera: "Nah", overlay: "", goal: "Handwerk zeigen", done: false },
      ],
    }],
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
    if (path.startsWith("/api/customers") || path.startsWith("/api/storyboard") || path === "/api/active") {
      if (!state.customerApi) return json({ error: "not found" }, 404);
      const brief = /^\/api\/customers\/(c_\d{12})\/brief$/.exec(path);
      if (brief) {
        const c = state.customers.find((x) => x.id === brief[1]);
        return json({ id: c?.id, name: c?.name, company: c?.company, phone: "", email: "", notes: "Kaffee schwarz.", updated: Date.UTC(2026, 9, 13), ideas: [{ text: "Drohnenflug am Morgen", tags: ["drohne"], project: "Testdreh" }] });
      }
      const one = /^\/api\/customers\/(c_\d{12})$/.exec(path);
      if (one) {
        const c = state.customers.find((x) => x.id === one[1]);
        return c ? json({ customer: c, projects: c.id === "c_000000000002" ? state.projects : [] }) : json({ error: "unknown customer" }, 404);
      }
      if (key === "GET /api/customers") return json({ customers: state.customers, active: state.active, activeCustomer: "c_000000000002" });
      if (key === "POST /api/customers") {
        const created = { id: "c_00000000000" + String(state.customers.length + 1), name: String(body["name"]), company: "", projectCount: 0 };
        state.customers = [...state.customers, created].sort((a, b) => a.name.localeCompare(b.name, "de"));
        return json(created);
      }
      if (key === "POST /api/active") { state.active = String(body["id"]); return json({ active: "Testdreh", activeId: state.active }); }
      if (key === "GET /api/storyboard") return json({ project: "Testdreh", storyboards: state.boards });
      if (key === "POST /api/storyboard/scene") {
        const scene = state.boards.find((b) => b.id === body["storyboard"])?.scenes[Number(body["index"])];
        if (!scene) return json({ error: "unknown scene" }, 404);
        scene.done = body["done"] === true;
        return json({ ok: true, done: scene.done });
      }
    }
    switch (key) {
      case "GET /api/shotlist": return json({ project: "Testdreh", shots: [{ scene: "1", shot: "A", desc: "Totale", size: "WS" }, { scene: "1", shot: "B", desc: "Nah", size: "CU" }] });
      case "GET /api/takes": return json({ takes: state.takes });
      case "POST /api/take": {
        const n = state.takes.filter((t) => t["scene"] === body["scene"] && t["shot"] === body["shot"]).length + 1;
        const take = { ...body, n, ts: Date.now() };
        state.takes.push(take);
        return json(take);
      }
      case "POST /api/take/delete": {
        if (state.noDelete) return json({ error: "not found" }, 404);
        const at = state.takes.findIndex((t) => t["scene"] === body["scene"] && t["shot"] === body["shot"] && t["n"] === body["n"]);
        if (at < 0) return json({ error: "unknown take" }, 404);
        state.takes.splice(at, 1);
        return json({ ok: true });
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
  resetGestureDedupe();
    server = fakeServer();
    vi.stubGlobal("fetch", server.fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); FakeSocket.last = null; FakeSocket.all = []; });

  it("QIS v1.2 no. 7: first run without a server shows demo data and says in one line how to connect; nothing is fetched", async () => {
    const fake = fakeBridge();
    const root = await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Demo · Verbindung am Handy einrichten"));
    expect(fake.header()).toBe("SHOOT DAY · KUNDEN · 3 · DEMO");
    expect(root.innerHTML).toContain("Demo: Beispieldaten");
    expect(root.innerHTML).toContain("Erster Start");
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it("QIS v1.2 no. 7: saving a server address on the phone ends the demo and talks to that server", async () => {
    const fake = fakeBridge();
    const root = await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Demo · Verbindung am Handy einrichten"));
    root.get("#url").value = "https://shoot.example";
    root.get("#save").fire("click");
    await vi.waitFor(() => expect(server.state.calls).toContain("GET /api/shotlist"));
    await vi.waitFor(() => expect(fake.body()).not.toContain("Demo ·"));
    expect(fake.header()).not.toContain("DEMO");
  });

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · Testdreh"));
    expect(fake.menus().length).toBeGreaterThan(0);
    // The first page and every rebuild come without a menu, so a hold reaches the app.
    for (const menu of fake.menus()) expect(menu).toHaveLength(0);
  });

  it("double tap in the menu asks the system to close (mode 1) and stops only when confirmed", async () => {
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · Testdreh"));
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
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · Testdreh"));
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
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · TAKES · 1 von 2"));
    fake.emit(CLICK);                                       // actions
    await vi.waitFor(() => expect(fake.body()).toContain("> Take OK"));
    fake.emit(DOUBLE);                                      // back to the card
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · TAKES · 1 von 2"));
    fake.emit(DOUBLE);                                      // back to the menu
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · Testdreh"));
    expect(fake.exit.calls).toEqual([]);
  });

  it("on a server without customers Hilfe is the last list row: a swipe gets there, a tap opens it, 2× goes back to the menu", async () => {
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · Testdreh"));
    fake.emit(UP);                                          // wraps to the last entry: Hilfe
    await vi.waitFor(() => expect(fake.body()).toContain("> Hilfe"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · Hilfe"));
    await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = schließen · 2× = zurück"));
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · Testdreh"));
    await vi.waitFor(() => expect(fake.body()).toContain("> Hilfe"));
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

  describe("Letzten Take löschen by gesture (side menu off): a row of the take actions, armed", () => {
    const toActions = async (fake: Fake): Promise<void> => {
      fake.emit(CLICK);                                     // open Takes
      await vi.waitFor(() => expect(fake.body()).toContain("Noch kein Take."));
      fake.emit(CLICK);                                     // actions
      await vi.waitFor(() => expect(fake.body()).toContain("> Take OK"));
    };

    it("the first tap asks, a swipe cancels, the second tap deletes it on the server", async () => {
      const fake = fakeBridge(configured());
      await boot(fake);
      await toActions(fake);
      fake.emit(CLICK);                                     // Take OK stays one tap
      await vi.waitFor(() => expect(fake.body()).toContain("OK 1 · NG 0"));
      await vi.waitFor(() => expect(server.state.takes).toHaveLength(1));
      fake.emit(CLICK);                                     // actions again
      await vi.waitFor(() => expect(fake.body()).toContain("> Take OK"));
      fake.emit(DOWN); fake.emit(DOWN); fake.emit(DOWN);    // NG, Notiz, Sprechen
      fake.emit(DOWN);
      await vi.waitFor(() => expect(fake.body()).toContain("> Letzten Take löschen"));
      fake.emit(CLICK);
      await vi.waitFor(() => expect(fake.footer()).toBe("Nochmal tippen = letzten Take löschen · 2× = abbrechen"));
      expect(server.state.takes).toHaveLength(1);
      fake.emit(DOWN);                                      // a swipe cancels - and moves nothing
      await vi.waitFor(() => expect(fake.footer()).not.toMatch(/^Nochmal/));
      expect(fake.body()).toContain("> Letzten Take löschen");
      expect(server.state.takes).toHaveLength(1);
      fake.emit(CLICK);
      await vi.waitFor(() => expect(fake.footer()).toMatch(/^Nochmal/));
      fake.emit(DOUBLE);                                    // 2× only cancels
      await vi.waitFor(() => expect(fake.footer()).not.toMatch(/^Nochmal/));
      expect(fake.exit.calls).toEqual([]);
      expect(server.state.takes).toHaveLength(1);
      fake.emit(CLICK);
      await vi.waitFor(() => expect(fake.footer()).toMatch(/^Nochmal/));
      fake.emit(CLICK);                                     // the confirming tap
      await vi.waitFor(() => expect(server.state.takes).toHaveLength(0));
      await vi.waitFor(() => expect(fake.body()).toContain("gelöscht: 1A T1 OK"));
      expect(fake.body()).toContain("OK 0 · NG 0");
      expect(server.state.calls).toContain("POST /api/take/delete");
    });

    it("without a take there is nothing to ask: it only says so", async () => {
      const fake = fakeBridge(configured());
      await boot(fake);
      await toActions(fake);
      fake.emit(UP); fake.emit(UP);                         // Take starten, then wraps to Zurück ... Letzten Take löschen
      await vi.waitFor(() => expect(fake.body()).toContain("> Zurück"));
      fake.emit(UP);
      await vi.waitFor(() => expect(fake.body()).toContain("> Letzten Take löschen"));
      fake.emit(CLICK);
      await vi.waitFor(() => expect(fake.body()).toContain("kein Take zum Löschen"));
      expect(fake.footer()).not.toMatch(/^Nochmal/);
      expect(server.state.calls).not.toContain("POST /api/take/delete");
    });
  });

  describe("Letzten Take löschen (armed; the side-menu click handler is kept for SIDE_MENU)", () => {
    const logOne = async (fake: Fake): Promise<void> => {
      fake.emit(CLICK);                                     // open Takes
      await vi.waitFor(() => expect(fake.body()).toContain("Noch kein Take."));
      fake.emit(CLICK);                                     // actions
      await vi.waitFor(() => expect(fake.body()).toContain("> Take OK"));
      fake.emit(CLICK);                                     // OK stays one tap
      await vi.waitFor(() => expect(fake.body()).toContain("OK 1 · NG 0"));
    };

    it("the first click asks, a swipe cancels, the second click of the same item deletes it on the server", async () => {
      const fake = fakeBridge(configured());
      await boot(fake);
      await logOne(fake);
      await vi.waitFor(() => expect(server.state.takes).toHaveLength(1));
      fake.menu(2);
      await vi.waitFor(() => expect(fake.footer()).toBe("Nochmal tippen = letzten Take löschen · 2× = abbrechen"));
      expect(server.state.takes).toHaveLength(1);
      fake.emit(DOWN);                                      // a swipe cancels - and moves nothing
      await vi.waitFor(() => expect(fake.footer()).not.toMatch(/^Nochmal/));
      expect(server.state.takes).toHaveLength(1);
      fake.menu(2);
      await vi.waitFor(() => expect(fake.footer()).toMatch(/^Nochmal/));
      fake.menu(2);
      await vi.waitFor(() => expect(server.state.takes).toHaveLength(0));
      await vi.waitFor(() => expect(fake.body()).toContain("gelöscht: 1A T1 OK"));
      expect(fake.body()).toContain("OK 0 · NG 0");
      expect(server.state.calls).toContain("POST /api/take/delete");
    });

    it("a single tap after the question deletes it, 2× and the 4 s timeout do not", async () => {
      const fake = fakeBridge(configured());
      await boot(fake);
      await logOne(fake);
      fake.menu(2);
      await vi.waitFor(() => expect(fake.footer()).toMatch(/^Nochmal/));
      fake.emit(DOUBLE);                                    // 2× only cancels
      await vi.waitFor(() => expect(fake.footer()).not.toMatch(/^Nochmal/));
      expect(fake.exit.calls).toEqual([]);
      expect(server.state.takes).toHaveLength(1);
      fake.menu(2);
      await vi.waitFor(() => expect(fake.footer()).toMatch(/^Nochmal/));
      fake.emit(CLICK);                                     // the confirming tap
      await vi.waitFor(() => expect(server.state.takes).toHaveLength(0));
    });

    it("a take that is still waiting offline is removed from the outbox, nothing goes to the server", async () => {
      const fake = fakeBridge(configured());
      await boot(fake);
      fake.emit(CLICK);
      await vi.waitFor(() => expect(fake.body()).toContain("Noch kein Take."));
      server.state.down = true;
      fake.emit(CLICK);
      await vi.waitFor(() => expect(fake.body()).toContain("> Take OK"));
      fake.emit(CLICK);
      await vi.waitFor(() => expect(fake.body()).toContain("offline gemerkt"));
      expect(JSON.parse(fake.storage.get(OUTBOX) ?? "[]")).toHaveLength(1);
      fake.menu(2);
      await vi.waitFor(() => expect(fake.footer()).toMatch(/^Nochmal/));
      fake.menu(2);
      await vi.waitFor(() => expect(fake.body()).toContain("gelöscht: 1A T1 OK"));
      expect(JSON.parse(fake.storage.get(OUTBOX) ?? "[]")).toEqual([]);
      expect(server.state.calls).not.toContain("POST /api/take/delete");
    });

    it("a server that cannot delete yet says so plainly (no HTTP code) and the take stays", async () => {
      server.state.noDelete = true;
      const fake = fakeBridge(configured());
      await boot(fake);
      await logOne(fake);
      fake.menu(2);
      await vi.waitFor(() => expect(fake.footer()).toMatch(/^Nochmal/));
      fake.menu(2);
      await vi.waitFor(() => expect(fake.body()).toContain("nicht gespeichert: Server meldet einen Fehler"));
      expect(fake.body()).not.toMatch(/HTTP|404/);
      expect(fake.body()).toContain("OK 1 · NG 0");
      expect(server.state.takes).toHaveLength(1);
    });

    it("outside the takes module, or without a take, the menu item only says so", async () => {
      const fake = fakeBridge(configured());
      await boot(fake);
      await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · Testdreh"));
      fake.menu(2);
      await vi.waitFor(() => expect(fake.body()).toContain("Take löschen: im Take-Modul"));
      expect(fake.footer()).not.toMatch(/^Nochmal/);
      fake.emit(CLICK);                                     // Takes, no take yet
      await vi.waitFor(() => expect(fake.body()).toContain("Noch kein Take."));
      fake.menu(2);
      await vi.waitFor(() => expect(fake.body()).toContain("kein Take zum Löschen"));
      expect(fake.footer()).not.toMatch(/^Nochmal/);
    });
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
    fake.emit(CLICK);                                       // arms (QIS v1)
    await vi.waitFor(() => expect(fake.footer()).toBe("Nochmal tippen = nicht ok · Wischen/2× = abbrechen"));
    fake.emit(CLICK);                                       // confirms
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
    fake.emit(DOWN); fake.emit(DOWN); fake.emit(DOWN);       // Packliste
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · PACKLISTE · 0/2 eingepackt"));
    fake.emit(HOLD);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · ● MIC · sprich jetzt"));
    await vi.waitFor(() => expect(fake.bridge.audioControl).toHaveBeenLastCalledWith(true, "glasses"));
    for (let i = 0; i < 10; i++) fake.audio(3200);
    fake.emit(RELEASE);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · PACKLISTE · 1/2 eingepackt"));
    expect(fake.bridge.audioControl).toHaveBeenLastCalledWith(false);
    expect(server.state.calls).toContain("POST /api/stt");
    await vi.waitFor(() => expect(server.state.items.find((i) => i.name === "Gimbal")?.packed).toBe(true));
    expect(fake.body()).toContain("abgehakt: Gimbal");
  });

  describe("live speech-to-text", () => {
    const openPack = async (): Promise<Fake> => {
      vi.stubEnv("VITE_LIVE_STT_URL", "wss://stt.example:8449");
      vi.stubGlobal("WebSocket", FakeSocket);
      const fake = fakeBridge(configured());
      await boot(fake);
      fake.emit(DOWN); fake.emit(DOWN); fake.emit(DOWN);     // Packliste
      fake.emit(CLICK);
      await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · PACKLISTE · 0/2 eingepackt"));
      return fake;
    };
    const hold = async (fake: Fake): Promise<FakeSocket> => {
      const before = FakeSocket.all.length;
      fake.emit(HOLD);
      await vi.waitFor(() => expect(FakeSocket.all.length).toBe(before + 1));
      await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · ● MIC · sprich jetzt"));
      return FakeSocket.last!;
    };

    it("shows the command while speaking and runs it on release from the live text, without /api/stt", async () => {
      server.state.heard = "Regenschutz eingepackt";       // what /api/stt would say: must not be used
      const fake = await openPack();
      const socket = await hold(fake);
      socket.open();
      for (let i = 0; i < 10; i++) fake.audio(3200);
      expect(socket.binary().length).toBe(10);
      socket.say("Gimbal");
      await vi.waitFor(() => expect(fake.body()).toContain("Gimbal"));
      socket.say("Gimbal eingepackt");
      await vi.waitFor(() => expect(fake.body()).toContain("Gimbal eingepackt"));
      fake.emit(RELEASE);
      await vi.waitFor(() => expect(socket.json().at(-1)).toEqual({ type: "stop" }));
      socket.say("Gimbal eingepackt.", true);
      await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · PACKLISTE · 1/2 eingepackt"));
      await vi.waitFor(() => expect(server.state.items.find((i) => i.name === "Gimbal")?.packed).toBe(true));
      expect(server.state.calls).not.toContain("POST /api/stt");
      expect(fake.bridge.audioControl).toHaveBeenLastCalledWith(false);
      expect(socket.closed).toBe(true);
    });

    it("a recogniser that never connects falls back to /api/stt", async () => {
      const fake = await openPack();
      const socket = await hold(fake);                      // never opened
      await vi.waitFor(() => expect(fake.bridge.audioControl).toHaveBeenLastCalledWith(true, "glasses"));
      for (let i = 0; i < 10; i++) fake.audio(3200);
      fake.emit(RELEASE);
      await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · PACKLISTE · 1/2 eingepackt"));
      expect(server.state.calls).toContain("POST /api/stt");
      expect(socket.closed).toBe(true);
    });

    it("a dropped connection while speaking falls back to /api/stt with the whole recording", async () => {
      const fake = await openPack();
      const socket = await hold(fake);
      socket.open();
      for (let i = 0; i < 5; i++) fake.audio(3200);
      socket.say("Gim");
      socket.drop();
      for (let i = 0; i < 5; i++) fake.audio(3200);
      fake.emit(RELEASE);
      await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · PACKLISTE · 1/2 eingepackt"));
      expect(server.state.calls).toContain("POST /api/stt");
    });

    it("double tap while speaking closes the recogniser and the microphone, drops the recording and runs nothing (side menu off)", async () => {
      const fake = await openPack();
      const socket = await hold(fake);
      socket.open();
      fake.audio(32000);
      socket.say("Gimbal eingepackt");
      fake.emit(DOUBLE);
      await vi.waitFor(() => expect(fake.body()).toContain("abgebrochen"));
      expect(socket.closed).toBe(true);
      expect(fake.bridge.audioControl).toHaveBeenLastCalledWith(false);
      expect(server.state.items.filter((i) => i.packed)).toHaveLength(0);
      expect(server.state.calls).not.toContain("POST /api/stt");
      expect(fake.body()).not.toContain("Aufnahme gemerkt");
    });
  });

  it("2× while speaking cancels the recording (side menu off: nothing could send or discard a kept one)", async () => {
    const fake = fakeBridge(configured());
    await boot(fake);
    fake.emit(DOWN); fake.emit(DOWN); fake.emit(DOWN);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toContain("PACKLISTE"));
    fake.emit(HOLD);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · ● MIC · sprich jetzt"));
    await vi.waitFor(() => expect(fake.bridge.audioControl).toHaveBeenLastCalledWith(true, "glasses"));
    fake.audio(32000);
    fake.emit(DOUBLE);                                      // back - the recording is dropped
    await vi.waitFor(() => expect(fake.bridge.audioControl).toHaveBeenLastCalledWith(false));
    await vi.waitFor(() => expect(fake.body()).toContain("abgebrochen"));
    expect(fake.header()).toMatch(/PACKLISTE/);
    expect(fake.body()).not.toContain("Aufnahme gemerkt");
    expect(server.state.calls).not.toContain("POST /api/stt");
    expect(fake.exit.calls).toEqual([]);
  });

  it("QIS v1.2 no. 2: a pending discard of the recording is confirmed by a single tap, also while speaking", async () => {
    const fake = fakeBridge(configured());
    await boot(fake);
    fake.emit(DOWN); fake.emit(DOWN); fake.emit(DOWN);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toContain("PACKLISTE"));
    fake.emit(HOLD);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · ● MIC · sprich jetzt"));
    await vi.waitFor(() => expect(fake.bridge.audioControl).toHaveBeenLastCalledWith(true, "glasses"));
    fake.audio(32000);
    fake.menu(4);                                           // arms while speaking
    await vi.waitFor(() => expect(fake.footer()).toBe("Nochmal tippen = Aufnahme verwerfen · 2× = abbrechen"));
    fake.emit(CLICK);                                       // the confirming tap
    await vi.waitFor(() => expect(fake.bridge.audioControl).toHaveBeenLastCalledWith(false));
    await vi.waitFor(() => expect(fake.header()).toMatch(/PACKLISTE/));
    expect(server.state.calls).not.toContain("POST /api/stt");
  });

  it("a tick that the server refuses is taken back on the glasses", async () => {
    const fake = fakeBridge(configured());
    await boot(fake);
    fake.emit(DOWN); fake.emit(DOWN); fake.emit(DOWN);
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
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · Testdreh"));
    server.state.hang.add("/api/equipment");
    fake.emit(DOWN); fake.emit(DOWN); fake.emit(DOWN);
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

  it("\"alles eingepackt\" by voice asks first; a tap ticks everything, a swipe does not", async () => {
    server.state.heard = "Alles eingepackt";
    const fake = fakeBridge(configured());
    await boot(fake);
    fake.emit(DOWN); fake.emit(DOWN); fake.emit(DOWN);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · PACKLISTE · 0/2 eingepackt"));
    const speak = async (): Promise<void> => {
      fake.emit(HOLD);
      await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · ● MIC · sprich jetzt"));
      await vi.waitFor(() => expect(fake.bridge.audioControl).toHaveBeenLastCalledWith(true, "glasses"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      for (let i = 0; i < 10; i++) fake.audio(3200);
      fake.emit(RELEASE);
      await vi.waitFor(() => expect(fake.footer()).toBe("Nochmal tippen = alles abhaken · Wischen/2× = abbrechen"));
    };
    await speak();
    expect(server.state.items.filter((i) => i.packed)).toHaveLength(0);
    fake.emit(DOUBLE);                                      // 2× only cancels the question: no leaving, nothing ticked
    await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = Haken · Halten = sprechen · 2× = zurück"));
    expect(fake.header()).toBe("SHOOT DAY · PACKLISTE · 0/2 eingepackt");
    expect(fake.exit.calls).toEqual([]);
    await speak();
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = Haken · Halten = sprechen · 2× = zurück"));
    expect(server.state.items.filter((i) => i.packed)).toHaveLength(0);
    await speak();
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · PACKLISTE · 2/2 eingepackt"));
  });

  it("comes back to the same module and shot after a restart (phone locked, app unloaded)", async () => {
    const first = fakeBridge(configured());
    await boot(first);
    first.emit(CLICK);                                      // Takes
    await vi.waitFor(() => expect(first.body()).toContain("Noch kein Take."));
    first.emit(DOWN);                                       // shot 1B
    await vi.waitFor(() => expect(first.header()).toContain("TAKES · 2 von 2"));
    first.emit(7);
    expect(first.storage.get("quietglass.shootday.ui.v1")).toContain('"mode":"takes"');

    const second = fakeBridge(Object.fromEntries(first.storage));
    await boot(second);
    await vi.waitFor(() => expect(second.header()).toContain("TAKES · 2 von 2"));
  });

  it("switches the microphone off when the app is left through the system", async () => {
    const fake = fakeBridge(configured());
    await boot(fake);
    fake.emit(DOWN); fake.emit(DOWN); fake.emit(DOWN);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · PACKLISTE · 0/2 eingepackt"));
    fake.emit(HOLD);
    await vi.waitFor(() => expect(fake.bridge.audioControl).toHaveBeenLastCalledWith(true, "glasses"));
    fake.emit(5);
    await vi.waitFor(() => expect(fake.bridge.audioControl).toHaveBeenLastCalledWith(false));
    fake.emit(4);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · PACKLISTE · 0/2 eingepackt"));
  });

  it("sends takes logged offline on its own once the server is back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fake = fakeBridge(configured());
    await boot(fake);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("Noch kein Take."));
    server.state.down = true;
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("> Take OK"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("offline gemerkt"));
    server.state.down = false;
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.waitFor(() => expect(server.state.takes).toHaveLength(1));
  });
});

describe("build address", () => {
  it("reads the build's address and drops a stored placeholder once in its favour", async () => {
    const persist = await import("../src/storage/persist");
    const build = persist.buildUrl("https://shoot.test:8445/");
    expect(build).toBe("https://shoot.test:8445");
    expect(persist.parseSettings(JSON.stringify({ serverUrl: "http://127.0.0.1:8896" }), build).serverUrl).toBe("");
    expect(persist.parseSettings(JSON.stringify({ serverUrl: "https://dein-rechner.home.example" }), build).serverUrl).toBe("");
    expect(persist.parseSettings(JSON.stringify({ serverUrl: "https://other.test" }), build).serverUrl).toBe("https://other.test");
    expect(persist.effectiveUrl(persist.parseSettings("", build), build)).toBe("https://shoot.test:8445");
    expect(persist.parseSettings(JSON.stringify({ serverUrl: "http://127.0.0.1:8896" }), "").serverUrl).toBe("http://127.0.0.1:8896");
  });
});

describe("Licht & Sonne on the glasses", () => {
  let server: ReturnType<typeof fakeServer>;
  beforeEach(() => {
    resetGestureDedupe();
    server = fakeServer();
    vi.stubGlobal("fetch", server.fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const tileIds = (fake: Fake): number[] =>
    fake.bridge.updateImageRawData.mock.calls.map((call) => (call as unknown as [{ containerID: number }])[0].containerID);

  it("opens without a reachable server as four picture tiles; a location request that never answers does not block leaving", async () => {
    server.state.down = true;
    const fake = fakeBridge(configured());
    const asked = vi.fn(() => new Promise(() => undefined));
    (fake.bridge as Record<string, unknown>)["getAppLocation"] = asked;
    await boot(fake);
    fake.emit(UP); fake.emit(UP);                           // wraps to Hilfe, then Licht & Sonne
    fake.emit(CLICK);
    await vi.waitFor(() => expect(new Set(tileIds(fake).filter((id) => id >= 21 && id <= 24)).size).toBe(4));
    expect(asked).toHaveBeenCalled();
    // The page has exactly one input container under the tiles.
    const page = fake.bridge.rebuildPageContainer.mock.calls.at(-1)?.[0] as { textObject?: Array<{ isEventCapture?: number }>; imageObject?: unknown[] };
    expect(page.imageObject).toHaveLength(4);
    expect(page.textObject?.filter((text) => text.isEventCapture === 1)).toHaveLength(1);
    // The light page carries no side menu either.
    expect((page as { menuObject?: unknown }).menuObject).toBeUndefined();
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · Menü"));
  });

  it("takes the phone location, remembers it rounded, loads the schedule and shows it on the phone", async () => {
    const fake = fakeBridge(configured());
    (fake.bridge as Record<string, unknown>)["getAppLocation"] = vi.fn(async () => ({ latitude: 47.81234, longitude: 13.04567 }));
    const root = await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · Testdreh"));
    fake.emit(UP); fake.emit(UP);                           // Hilfe, then Licht & Sonne
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.storage.get("quietglass.shootday.place.v1")).toBe(JSON.stringify({ latitude: 47.81, longitude: 13.05 })));
    await vi.waitFor(() => expect(server.state.calls).toContain("GET /api/dispo"));
    await vi.waitFor(() => expect(root.innerHTML).toContain("Standort: Handy (47.81, 13.05)"));
    expect(root.innerHTML).toContain("Heute");
    // A swipe looks 30 minutes ahead: the picture changes, so tiles go out again.
    await vi.waitFor(() => expect(tileIds(fake).length).toBeGreaterThanOrEqual(4));
    const before = tileIds(fake).length;
    fake.emit(DOWN);
    await vi.waitFor(() => expect(tileIds(fake).length).toBeGreaterThan(before));
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · Testdreh"));
  });
});

describe("customers on the glasses (server 0.5.0)", () => {
  let server: ReturnType<typeof fakeServer>;
  beforeEach(() => {
    resetGestureDedupe();
    server = fakeServer();
    server.state.customerApi = true;
    vi.stubGlobal("fetch", server.fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("starts on the customer list, opens customer, project and storyboard; a tap marks a scene done; 2× climbs back up", async () => {
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · KUNDEN · 2"));
    // The cursor waits on the customer of the project the glasses work on.
    expect(fake.body()).toContain("> Bäckerei Sonnenschein · Sonnenschein KG");
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · KUNDE · Bäckerei Sonnenschein"));
    await vi.waitFor(() => expect(fake.body()).toContain("> 14.10.2026 · Testdreh ●"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · Testdreh"));
    expect(server.state.calls).toContain("POST /api/active");
    expect(server.state.active).toBe("p_000000000001");
    expect(fake.body().split("\n")[0]).toBe("> Storyboard");
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · SZENE 1/2 · 0:00–0:05"));
    expect(fake.body()).toContain("○ Ankunft");
    expect(fake.body()).toContain("Kamera: Totale");
    expect(fake.body()).toContain("Text: \"Willkommen\"");
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · SZENE 2/2 · 0:05–0:12"));
    fake.emit(DOWN);                                        // stays on the last scene
    fake.emit(CLICK);
    await vi.waitFor(() => expect(server.state.boards[0]?.scenes[1]?.done).toBe(true));
    expect(fake.body()).toContain("● Hände im Teig");
    expect(fake.body()).toContain("erledigt: Szene 2");
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · Testdreh"));
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · KUNDE · Bäckerei Sonnenschein"));
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · KUNDEN · 2"));
    expect(fake.exit.calls).toEqual([]);
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.exit.calls).toEqual([1]));
  });

  it("a scene tick the server refuses is taken back", async () => {
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · KUNDEN · 2"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("> 14.10.2026 · Testdreh ●"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · Testdreh"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · SZENE 1/2 · 0:00–0:05"));
    server.state.down = true;
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("nicht gespeichert: nicht erreichbar"));
    expect(fake.body()).toContain("○ Ankunft");
  });

  it("creates a customer by voice only after a confirming tap", async () => {
    server.state.heard = "Neuer Kunde clara muster.";
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · KUNDEN · 2"));
    fake.emit(HOLD);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · ● MIC · sprich jetzt"));
    await vi.waitFor(() => expect(fake.bridge.audioControl).toHaveBeenLastCalledWith(true, "glasses"));
    expect(fake.body()).toContain("Sag den Namen des neuen Kunden,");
    for (let i = 0; i < 10; i++) fake.audio(3200);
    fake.emit(RELEASE);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · NEUER KUNDE"));
    expect(fake.body()).toContain("\"Clara Muster\"");
    expect(server.state.calls).not.toContain("POST /api/customers");
    fake.emit(CLICK);
    await vi.waitFor(() => expect(server.state.customers.map((c) => c.name)).toContain("Clara Muster"));
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · KUNDEN · 3"));
    await vi.waitFor(() => expect(fake.body()).toContain("> Clara Muster"));
    expect(fake.bridge.audioControl).toHaveBeenLastCalledWith(false);
  });

  it("a name that exists already selects that customer instead of a second entry", async () => {
    server.state.heard = "anna beispiel";
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · KUNDEN · 2"));
    fake.emit(HOLD);
    await vi.waitFor(() => expect(fake.bridge.audioControl).toHaveBeenLastCalledWith(true, "glasses"));
    for (let i = 0; i < 10; i++) fake.audio(3200);
    fake.emit(RELEASE);
    await vi.waitFor(() => expect(fake.body()).toContain("gibt es schon: Anna Beispiel"));
    expect(fake.body()).toContain("> Anna Beispiel");
    expect(server.state.calls).not.toContain("POST /api/customers");
  });

  it("shows the card before the appointment with notes and open ideas", async () => {
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · KUNDEN · 2"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("> 14.10.2026 · Testdreh ●"));
    fake.emit(UP); fake.emit(UP);                          // to "Kunde vor dem Termin"
    await vi.waitFor(() => expect(fake.body()).toContain("> Kunde vor dem Termin"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · TERMIN · Bäckerei Sonnenschein"));
    expect(fake.body()).toContain("Kaffee schwarz.");
    expect(fake.footer()).toBe("1/2 · Wischen = blättern · 2× = zurück");
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body()).toContain("· Drohnenflug am Morgen #drohne"));
    expect(fake.body()).not.toContain("BABEL");
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · KUNDE · Bäckerei Sonnenschein"));
  });

  it("a gesture before the server answered keeps the user where they are", async () => {
    server.state.hang.add("/api/customers");
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · Testdreh"));
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body().split("\n")[1]).toBe("> Teleprompter"));
    expect(fake.header()).toBe("SHOOT DAY · Testdreh");
  });
});

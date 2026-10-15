import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app (mock recogniser, no server) against a fake bridge to check the exit dialog and the microphone.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

// tsconfig carries no node types; reach the process object structurally.
const nodeProcess = (globalThis as unknown as { process: { on(event: string, listener: (reason: unknown) => void): void; off(event: string, listener: (reason: unknown) => void): void } }).process;

function fakeBridge(stored = "") {
  let handler: ((event: unknown) => void) | undefined;
  // Plain functions, not vi.fn: vitest's spies attach handlers to returned promises, which would hide unhandled rejections.
  const shutdown = { modes: [] as (number | undefined)[], answer: (): Promise<boolean> => Promise.resolve(true) };
  const mic = { open: false, calls: [] as boolean[] };
  const writes = { count: 0, body: "" };
  const bridge = {
    getLocalStorage: async () => stored,
    setLocalStorage: async () => true,
    rebuildPageContainer: async () => true,
    createStartUpPageContainer: async () => { writes.count += 1; return 0; },
    textContainerUpgrade: async (update: { content?: string }) => { writes.count += 1; writes.body = update.content ?? writes.body; return true; },
    audioControl: async (isOpen: boolean) => { mic.calls.push(isOpen); mic.open = isOpen; return true; },
    shutDownPageContainer: (mode?: number): Promise<boolean> => { shutdown.modes.push(mode); return shutdown.answer(); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return { bridge, shutdown, mic, writes, emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })), ready: () => handler !== undefined };
}

describe("babel-glass exit dialog", () => {
  beforeEach(() => {
  resetGestureDedupe();
    vi.useFakeTimers();
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function bootListening() {
    const fake = fakeBridge();
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    fake.emit(0); // tap: start captions
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.mic.open).toBe(true);
    return fake;
  }

  it("closes the microphone, asks for the system dialog (mode 1) and stays closed on confirm", async () => {
    const fake = await bootListening();
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.shutdown.modes).toEqual([1]);
    // QIS v1.2 #2: the microphone stayed open during the dialog and closes only on the confirmed exit.
    expect(fake.mic.calls).toEqual([true, false]);
    expect(fake.mic.open).toBe(false);
    const writesAtClose = fake.writes.count;
    fake.emit(0); // a tap after leaving must not reopen the microphone
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.mic.open).toBe(false);
    expect(fake.writes.count).toBe(writesAtClose);
  });

  it("QIS v1.2 #2: keeps captioning through the dialog (no stop first) when the user cancels", async () => {
    const fake = await bootListening();
    let micWhileAsked: boolean | null = null;
    fake.shutdown.answer = () => { micWhileAsked = fake.mic.open; return Promise.resolve(false); };
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.shutdown.modes).toEqual([1]);
    expect(micWhileAsked).toBe(true);
    expect(fake.mic.calls).toEqual([true]);
    expect(fake.mic.open).toBe(true);
    const writesAtCancel = fake.writes.count;
    await vi.advanceTimersByTimeAsync(10_000); // the mock recogniser keeps producing lines
    expect(fake.writes.count).toBeGreaterThan(writesAtCancel);
  });

  it("does not open the microphone on cancel if captions were off", async () => {
    const fake = await bootListening();
    fake.emit(0); // tap: arms the stop (QIS v1)
    await vi.advanceTimersByTimeAsync(50);
    fake.emit(0); // second tap: stop captions
    await vi.advanceTimersByTimeAsync(200);
    fake.shutdown.answer = () => Promise.resolve(false);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.mic.open).toBe(false);
    expect(fake.mic.calls).toEqual([true, false]);
  });

  it("restores the microphone when the exit call rejects, without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    nodeProcess.on("unhandledRejection", onUnhandled);
    const fake = await bootListening();
    fake.shutdown.answer = () => Promise.reject(new Error("ble gone"));
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(fake.shutdown.modes).toEqual([1]);
    expect(fake.mic.open).toBe(true);
  });
});

describe("babel-glass microphone with an unreachable recogniser", () => {
  beforeEach(() => {
    resetGestureDedupe();
    vi.useFakeTimers();
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("opens the microphone even though the WebSocket handshake never completes", async () => {
    // A socket that stays in CONNECTING forever: no open, no error, no close.
    class HangingSocket {
      readyState = 0;
      onopen: unknown; onmessage: unknown; onerror: unknown; onclose: unknown;
      send(): void { /* never connected */ }
      close(): void { /* nothing to close */ }
    }
    vi.stubGlobal("WebSocket", HangingSocket);
    const fake = fakeBridge(JSON.stringify({ sttUrl: "wss://speech.example:8449" }));
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    fake.emit(0); // tap: start captions
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.mic.open).toBe(true);
  });
});

/** A fuller fake: page counts, the text per container, storage, reconnect. */
function richBridge(options: { stored?: Record<string, string>; micAnswer?: boolean; createHangs?: boolean } = {}) {
  let handler: ((event: unknown) => void) | undefined;
  let deviceHandler: ((status: unknown) => void) | undefined;
  const storage = new Map<string, string>(Object.entries(options.stored ?? {}));
  const shutdown = { modes: [] as (number | undefined)[] };
  const mic = { open: false, calls: [] as boolean[] };
  const page = { creates: 0, rebuilds: 0, text: new Map<number, string>(), menus: [] as string[][] };
  type Built = { textObject?: { containerID?: number; content?: string }[]; menuObject?: { menuItems?: { itemName?: string; itemID?: number }[] } };
  const menuOf = (built: Built): void => { page.menus.push((built.menuObject?.menuItems ?? []).map((item) => item.itemID + ":" + item.itemName)); };
  const remember = (parts: { containerID?: number; content?: string }[] | undefined): void => {
    for (const part of parts ?? []) if (part.containerID !== undefined) page.text.set(part.containerID, part.content ?? "");
  };
  const bridge = {
    getLocalStorage: async (key: string) => storage.get(key) ?? "",
    setLocalStorage: async (key: string, value: string) => { storage.set(key, value); return true; },
    rebuildPageContainer: async (built: Built) => {
      page.rebuilds += 1;
      if (page.creates > 0) { remember(built.textObject); menuOf(built); }
      return true;
    },
    createStartUpPageContainer: (built: Built): Promise<number> => {
      page.creates += 1;
      menuOf(built);
      if (options.createHangs) return new Promise(() => undefined);
      remember(built.textObject);
      return Promise.resolve(0);
    },
    textContainerUpgrade: async (update: { containerID?: number; content?: string }) => { remember([update]); return true; },
    updateImageRawData: async () => "success",
    audioControl: async (isOpen: boolean) => {
      mic.calls.push(isOpen);
      if (isOpen && options.micAnswer === false) return false;
      mic.open = isOpen;
      return true;
    },
    shutDownPageContainer: (mode?: number): Promise<boolean> => { shutdown.modes.push(mode); return Promise.resolve(true); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: (callback: (status: unknown) => void) => { deviceHandler = callback; return () => undefined; },
  };
  return {
    bridge, shutdown, mic, page, storage,
    body: () => page.text.get(2) ?? "",
    footer: () => page.text.get(3) ?? "",
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
    /** 0.7.0: an item picked in the glasses' side menu. */
    menu: (itemID: number) => handler?.({ menuItemClickEvent: { itemID } }),
    /** 0.8.0: any raw event (audio blocks). */
    raw: (event: unknown) => handler?.(event),
    header: () => page.text.get(1) ?? "",
    reconnect: () => deviceHandler?.({ connectType: "connected" }),
    ready: () => handler !== undefined,
  };
}

const SETTINGS_KEY = "quietglass.babelglass.v1";
const CONVERSATION_KEY = "quietglass.babelglass.conversation.v1";

describe("babel-glass robustness", () => {
  beforeEach(() => {
    resetGestureDedupe();
    vi.useFakeTimers();
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null });
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function boot(fake: ReturnType<typeof richBridge>) {
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.advanceTimersByTimeAsync(50);
    return fake;
  }

  it("regression: gestures work while the first page is still being created", async () => {
    const fake = await boot(richBridge({ createHangs: true }));
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.shutdown.modes).toEqual([1]);
  });

  it("regression: a reconnect rebuilds the page even when the text did not change, never a second create", async () => {
    const fake = await boot(richBridge());
    expect(fake.page.creates).toBe(1);
    const rebuilds = fake.page.rebuilds;
    fake.reconnect();
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.page.rebuilds).toBe(rebuilds + 1);
    expect(fake.page.creates).toBe(1);
  });

  it("regression: a refused microphone is said on the glasses", async () => {
    const fake = await boot(richBridge({ micAnswer: false }));
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.body()).toContain("Microphone not allowed");
  });

  it("switches the microphone off when the speech server stays away, and says why", async () => {
    class HangingSocket {
      readyState = 0;
      onopen: unknown; onmessage: unknown; onerror: unknown; onclose: unknown;
      send(): void { /* never connected */ }
      close(): void { /* nothing to close */ }
    }
    vi.stubGlobal("WebSocket", HangingSocket);
    const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify({ sttUrl: "wss://speech.example:8449" }) } }));
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.mic.open).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.mic.open).toBe(true);
    await vi.advanceTimersByTimeAsync(32_000);
    expect(fake.mic.open).toBe(false);
    expect(fake.body()).toContain("Speech server unreachable");
  });

  it("0.6.1: no glasses gesture sequence clears the transcript; the hold opens the help (no side menu, step log 15.10.)", async () => {
    const kept = JSON.stringify({ log: [{ text: "Hallo", at: 1 }], summary: { short: ["Kurz gesagt"], long: ["Lang"] } });
    const fake = await boot(richBridge({ stored: {
      [SETTINGS_KEY]: JSON.stringify({ keepTranscript: true }),
      [CONVERSATION_KEY]: kept,
    } }));
    expect(fake.body()).toContain("Kurz gesagt");
    expect(fake.page.text.get(3)).toBe("Tap = go on · Hold = help · 2× = exit");
    expect(fake.body()).toContain("Kurz gesagt");
    fake.emit(9); // without the side menu a hold while stopped opens the help again
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.page.text.get(1)).toMatch(/^BABEL · help/);
    expect(fake.footer()).not.toContain("Tap again");
    fake.emit(10);
    await vi.advanceTimersByTimeAsync(50);
    // Every short sequence of non-start gestures (tap/swipes/hold/release), none of which may clear.
    const gestures = [1, 2, 9, 10, 3];
    for (const first of gestures) for (const second of gestures) for (const third of gestures) {
      if (first === 0 || second === 0 || third === 0) continue;
      for (const g of [first, second, third]) {
        fake.emit(g);
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(fake.storage.get(CONVERSATION_KEY)).toBe(kept);
    }
    // Menu help, then a tap: the tap only leaves the help (and may start listening afterwards), never clears.
    fake.menu(1);
    await vi.advanceTimersByTimeAsync(50);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.storage.get(CONVERSATION_KEY)).toBe(kept);
  });

  it("QIS v1: a tap on running captions only arms the stop; the second tap within 4 s stops, anything else cancels", async () => {
    // No demo popups in between: a tap would close one before it arms.
    const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify({ replySuggestions: false, insights: false }) } }));
    fake.emit(0); // start
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.mic.open).toBe(true);
    fake.emit(0); // arms
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.mic.open).toBe(true);
    expect(fake.page.text.get(1)).toMatch(/^BABEL · ● MIC · stop\?/);
    expect(fake.footer()).toBe("Tap again = stop · Swipe/2× = cancel");
    for (const cancel of [1, 2, 9, 3]) {
      fake.emit(cancel);
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.mic.open, `after ${cancel}`).toBe(true);
      expect(fake.footer(), `after ${cancel}`).not.toContain("Tap again");
      fake.emit(0);
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.footer()).toContain("Tap again");
    }
    // The timeout also disarms.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.footer()).not.toContain("Tap again");
    expect(fake.mic.open).toBe(true);
    expect(fake.shutdown.modes).toEqual([]);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.mic.open).toBe(false);
  });

  it("QIS v1: 2x closes help and popups first and only then leaves the app", async () => {
    const fake = await boot(richBridge());
    fake.menu(1); // help (side menu)
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.page.text.get(1)).toMatch(/^BABEL · help/);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.shutdown.modes).toEqual([]);
    expect(fake.page.text.get(1)).toMatch(/^BABEL · pick customer/);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.shutdown.modes).toEqual([1]);
  });

  it("a hold during captions is the Wortfinder, not 'clear'; the microphone stays open", async () => {
    const fake = await boot(richBridge());
    fake.emit(0); // demo captions
    await vi.advanceTimersByTimeAsync(3000);
    fake.emit(9);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.mic.open).toBe(true);
    expect(fake.body()).toContain("quote · estimate · offer");
    expect(fake.footer()).not.toContain("hold again");
    fake.emit(0); // a tap closes the word popup, captions go on
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.mic.open).toBe(true);
    expect(fake.body()).not.toContain("quote · estimate");
  });

  it("0.5.0: the demo proposes a reply to the other's question, labelled, and a tap closes it", async () => {
    const fake = await boot(richBridge());
    fake.emit(0); // mock captions
    await vi.advanceTimersByTimeAsync(5000); // first demo line is a question, then the debounce
    expect(fake.body()).toContain("Reply: Sure, let's start right away.");
    expect(fake.page.text.get(1) ?? "").toMatch(/^BABEL · ● MIC/);
    fake.emit(0); // tap closes the popup, captions go on
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.mic.open).toBe(true);
    expect(fake.body()).not.toContain("Reply:");
  });

  it("without the side menu a hold opens the help; swipes while stopped never open it", async () => {
    const fake = await boot(richBridge());
    expect(fake.header()).toMatch(/^BABEL · pick customer/);
    for (const swipe of [1, 2, 1, 2, 10]) {
      fake.emit(swipe);
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.header(), `after ${swipe}`).toMatch(/^BABEL · pick customer/);
    }
    fake.emit(9); // hold
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.header()).toMatch(/^BABEL · help/);
    // Page 1: the four gestures in footer order, then what the app needs; page 2: what runs when.
    const gestures = ["Tap =", "Swipe =", "Hold =", "2× ="].map((word) => fake.body().indexOf(word));
    expect(gestures.every((index) => index >= 0)).toBe(true);
    expect(gestures).toEqual([...gestures].sort((a, b) => a - b));
    expect(fake.body()).toContain("Needs a speech server");
    expect(fake.footer()).toMatch(/^Page 1\/\d · Swipe = scroll · 2× = back$/);
    const pages = Number(/1\/(\d)/.exec(fake.footer())![1]);
    const seen = [fake.body()];
    for (let page = 2; page <= pages; page += 1) {
      fake.emit(2);
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.footer()).toBe(page < pages ? "Page " + page + "/" + pages + " · Swipe = scroll · 2× = back" : "Page " + page + "/" + pages + " · Tap = close · 2× = back");
      seen.push(fake.body());
    }
    expect(seen[1]!.split("\n")[0]).toBe("OVERVIEW · what runs when");
    expect(seen[pages - 1]!.split("\n").at(-1)).toBe("— End · Tap = close —");
    expect(seen.join(" ")).toContain("Captions: tap · demo without server");
    // A swipe past the last page closes the help: back on the customer list, nothing hangs.
    fake.emit(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.header()).toMatch(/^BABEL · pick customer/);
    expect(fake.mic.open).toBe(false);
    // "Übersicht" opens the same sheet right on the overview page.
    fake.menu(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.body().split("\n")[0]).toBe("OVERVIEW · what runs when");
    fake.emit(0); // a tap closes it without starting the mic
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.mic.open).toBe(false);
    expect(fake.header()).toMatch(/^BABEL · pick customer/);
  });

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.); the click handler stays", async () => {
    const fake = await boot(richBridge());
    expect(fake.page.menus.length).toBeGreaterThan(0);
    expect(fake.page.menus.every((menu) => menu.length === 0)).toBe(true); // no menuObject on any page
    fake.menu(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(JSON.parse(fake.storage.get(SETTINGS_KEY) ?? "{}")["talkMode"]).toBe("client");
    expect(fake.page.menus.every((menu) => menu.length === 0)).toBe(true);
    expect(fake.page.creates).toBe(1); // no menu, so no rebuild for it either
    fake.menu(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(JSON.parse(fake.storage.get(SETTINGS_KEY) ?? "{}")["talkMode"]).toBe("translate");
    // Kundeninfo without a picked customer says so; 2× goes back to the list.
    fake.menu(5);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.header()).toMatch(/^BABEL · customer/);
    expect(fake.body()).toContain("No customer picked.");
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.header()).toMatch(/^BABEL · pick customer/);
    expect(fake.shutdown.modes).toEqual([]);
  });

  describe("0.7.0 customer list on the start screen", () => {
    const today = (time: string): string => {
      const d = new Date();
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") + " " + time;
    };
    const LIST = () => ({
      context: true, enabled: true, customers: [
        { id: "c_1", name: "Zeta Werkstatt", company: "", next: { date: today("14:30"), name: "Reel" } },
        { id: "c_2", name: "Alpha Studio", company: "", next: { date: "2099-01-02", name: "Später" } },
        { id: "c_3", name: "Beispiel Café", company: "Beispiel Café GmbH", next: { date: today("09:00"), name: "Imagefilm" } },
        { id: "c_4", name: "Muster Bäckerei", company: "", next: null },
      ],
    });
    const CUSTOMER = {
      context: true, enabled: true, full: true, name: "Beispiel Café", project: "Imagefilm", date: "2026-10-14", place: "Beispielgasse 1",
      ideas: Array.from({ length: 9 }, (_, i) => "Idee " + (i + 1)), storyboards: [{ title: "Morgenroutine", scenes: ["Ankunft"] }], slogans: [],
    };
    type Call = { url: string; headers: Record<string, string> };
    const stub = (list: "ok" | "fail" | "hang"): Call[] => {
      const calls: Call[] = [];
      vi.stubGlobal("fetch", (url: string, init?: { headers?: Record<string, string> }) => {
        calls.push({ url: String(url), headers: { ...(init?.headers ?? {}) } });
        if (String(url).endsWith("/context/customers")) {
          if (list === "hang") return new Promise(() => undefined);
          return Promise.resolve(list === "ok" ? { ok: true, status: 200, json: async () => LIST() } : { ok: false, status: 502, json: async () => ({}) });
        }
        if (String(url).includes("/context/customer?full=1")) return Promise.resolve({ ok: true, status: 200, json: async () => CUSTOMER });
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => "" });
      });
      return calls;
    };
    const SERVER = { llmUrl: "https://proxy.example/v1", llmModel: "m", insights: false, memory: false };

    it("orders today's customers first (by time), then by name; the last row is 'No customer'", async () => {
      const calls = stub("ok");
      const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify(SERVER) } }));
      expect(calls.some((call) => call.url === "https://proxy.example/context/customers")).toBe(true);
      expect(fake.header()).toBe("BABEL · pick customer · MOCK");
      expect(fake.body().split("\n")).toEqual([
        "> Beispiel Café · today 09:00",
        "  Zeta Werkstatt · today 14:30",
        "  Alpha Studio · 02.01.",
        "  Muster Bäckerei",
        "  No customer – translate",
        // Without the side menu its voice entries stand at the end of the list.
        "  Learn my voice",
        "  Delete my voice",
      ]);
      expect(fake.footer()).toBe("Tap = start · Hold = help · 2× = exit");
      fake.emit(2);
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.body().split("\n")[1]).toBe("> Zeta Werkstatt · today 14:30");
      fake.emit(1);
      fake.emit(1); // never above the first row
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.body().split("\n")[0]).toBe("> Beispiel Café · today 09:00");
    });

    it("honours invertScroll: the physical swipe direction moves the cursor", async () => {
      stub("ok");
      const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify({ ...SERVER, invertScroll: true }) } }));
      fake.emit(1); // SCROLL_TOP on inverted hardware = down
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.body().split("\n")[1]).toMatch(/^> Zeta/);
    });

    it("a tap on a customer starts client talk with that customer: X-Babel-Customer on every model request, Kundeninfo from the menu", async () => {
      const calls = stub("ok");
      const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify({ ...SERVER, talkMode: "translate", replySuggestions: true }) } }));
      fake.emit(0);
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.mic.open).toBe(true);
      expect(JSON.parse(fake.storage.get(SETTINGS_KEY) ?? "{}")["talkMode"]).toBe("client");
      const info = calls.find((call) => call.url.includes("/context/customer?full=1"));
      expect(info?.url).toBe("https://proxy.example/context/customer?full=1&customer=c_3");
      expect(info?.headers["X-Babel-Customer"]).toBe("c_3");
      // The demo recogniser asks a question; the reply suggestion goes to the model with the customer header.
      await vi.advanceTimersByTimeAsync(6000);
      const chats = calls.filter((call) => call.url.includes("/chat/completions"));
      expect(chats.length).toBeGreaterThan(0);
      for (const chat of chats) expect(chat.headers["X-Babel-Customer"]).toBe("c_3");
      fake.menu(5); // Kundeninfo
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.header()).toMatch(/^BABEL · customer/);
      expect(fake.body()).toContain("Customer: Beispiel Café");
      fake.emit(3); // back to the captions
      await vi.advanceTimersByTimeAsync(50);
      // While listening a swipe scrolls the captions, never help or Kunde.
      for (const swipe of [1, 2]) {
        fake.emit(swipe);
        await vi.advanceTimersByTimeAsync(50);
        expect(fake.header()).toMatch(/^BABEL · ● MIC/);
      }
      // "Kunde wechseln" stops the captions and shows the list again, the cursor on the customer in use.
      // QIS v1.2 #3: while captions run the first click only arms it.
      fake.menu(4);
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.mic.open).toBe(true);
      expect(fake.footer()).toMatch(/^Tap again = restart captions/);
      fake.menu(4);
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.mic.open).toBe(false);
      expect(fake.header()).toBe("BABEL · pick customer · MOCK");
      expect(fake.body().split("\n")[0]).toBe("> Beispiel Café · today 09:00");
    });

    it("the last row starts the translate mode without any customer context", async () => {
      const calls = stub("ok");
      const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify({ ...SERVER, talkMode: "client", replySuggestions: true }) } }));
      for (let i = 0; i < 4; i += 1) fake.emit(2);
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.body().split("\n").find((row) => row.startsWith("> "))).toBe("> No customer – translate");
      fake.emit(0);
      await vi.advanceTimersByTimeAsync(6000);
      expect(fake.mic.open).toBe(true);
      expect(JSON.parse(fake.storage.get(SETTINGS_KEY) ?? "{}")["talkMode"]).toBe("translate");
      expect(calls.some((call) => call.url.includes("/context/customer?full=1"))).toBe(false);
      const chats = calls.filter((call) => call.url.includes("/chat/completions"));
      for (const chat of chats) expect(chat.headers["X-Babel-Customer"]).toBe("-");
    });

    it("an unreachable list shows 'Customers unreachable' + 'No customer'; a tap on the first row retries", async () => {
      const calls = stub("fail");
      const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify(SERVER) } }));
      expect(fake.body().split("\n")).toEqual(["> Customers unreachable", "  No customer – translate", "  Learn my voice", "  Delete my voice", "  People: 2"]);
      const asked = (): number => calls.filter((call) => call.url.endsWith("/context/customers")).length;
      expect(asked()).toBe(1);
      fake.emit(0);
      await vi.advanceTimersByTimeAsync(50);
      expect(asked()).toBe(2);
      expect(fake.mic.open).toBe(false);
      fake.emit(2);
      await vi.advanceTimersByTimeAsync(50);
      fake.emit(0);
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.mic.open).toBe(true);
    });

    it("a list that never answers gives up after the timeout", async () => {
      stub("hang");
      const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify(SERVER) } }));
      expect(fake.body().split("\n")[0]).toBe("> Loading customers …");
      await vi.advanceTimersByTimeAsync(4500);
      expect(fake.body().split("\n")).toEqual(["> Customers unreachable", "  No customer – translate", "  Learn my voice", "  Delete my voice", "  People: 2"]);
    });
  });

  it("0.5.0: swiping to the newest at the live edge asks for 'my last sentence' (needs a translation target)", async () => {
    const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify({ replySuggestions: false, insights: false }) } }));
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(3500);
    fake.emit(2); // scroll towards the newest, already at the live edge
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.body()).toContain('set "Translate into" first');
    expect(fake.mic.open).toBe(true);
  });

  it("without the opt-in nothing of the conversation is stored", async () => {
    const fake = await boot(richBridge());
    fake.emit(0); // mock captions
    await vi.advanceTimersByTimeAsync(10_000);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(6000);
    expect(fake.storage.has(CONVERSATION_KEY)).toBe(false);
  });

  it("with the opt-in the conversation is stored when captions stop", async () => {
    const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify({ keepTranscript: true, autoSummary: false, replySuggestions: false }) } }));
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(10_000);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(100);
    const stored = JSON.parse(fake.storage.get(CONVERSATION_KEY) ?? "{}") as { log?: unknown[] };
    expect(stored.log?.length ?? 0).toBeGreaterThan(0);
  });

  it("leaving through the system closes the microphone; coming back rebuilds without reopening it", async () => {
    const fake = await boot(richBridge());
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.mic.open).toBe(true);
    fake.emit(5);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.mic.open).toBe(false);
    const rebuilds = fake.page.rebuilds;
    fake.emit(4);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.page.rebuilds).toBe(rebuilds + 1);
    expect(fake.mic.open).toBe(false);
    expect(fake.page.creates).toBe(1);
  });

  it("a system exit closes the microphone for good", async () => {
    const fake = await boot(richBridge());
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    fake.emit(7);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.mic.open).toBe(false);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.mic.open).toBe(false);
  });
});

/** 0.8.0: a speech server that knows voice profiles (ack, result) and records what the app sent. */
class VoiceSocket {
  static all: VoiceSocket[] = [];
  static enrollReply: Record<string, unknown> = { type: "voice", action: "enroll", ok: true, seconds: 14.2, quality: 0.83, segments: 5 };
  readyState = 0;
  sent: (string | Uint8Array)[] = [];
  closed = false;
  voice: string | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(public url: string) {
    VoiceSocket.all.push(this);
    setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 1);
  }
  frames(): Record<string, unknown>[] { return this.sent.filter((m): m is string => typeof m === "string").map((m) => JSON.parse(m) as Record<string, unknown>); }
  send(data: string | Uint8Array): void {
    this.sent.push(data);
    if (typeof data !== "string") return;
    const frame = JSON.parse(data) as Record<string, unknown>;
    if (frame["type"] === "start" && typeof frame["voice"] === "string") {
      this.voice = frame["voice"];
      if (this.voice === "enroll") this.answer({ type: "voice", action: "enroll", state: "listening" });
      if (this.voice === "delete") this.answer({ type: "voice", action: "delete", ok: true, existed: true });
    }
    if (frame["type"] === "stop" && this.voice === "enroll") this.answer(VoiceSocket.enrollReply);
  }
  answer(value: unknown): void { setTimeout(() => this.onmessage?.({ data: JSON.stringify(value) }), 1); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    setTimeout(() => this.onclose?.({ code: 1000 }), 0);
  }
}

describe("babel-glass 0.8.0 Meine Stimme + Personen", () => {
  beforeEach(() => {
    resetGestureDedupe();
    vi.useFakeTimers();
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null });
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    VoiceSocket.all = [];
    vi.stubGlobal("WebSocket", VoiceSocket);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const SERVER = { sttUrl: "wss://speech.example:8449", sttToken: "tok" };
  async function boot(stored: Record<string, unknown> = SERVER) {
    const fake = richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify(stored) } });
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.advanceTimersByTimeAsync(50);
    return fake;
  }
  const settings = (fake: ReturnType<typeof richBridge>): Record<string, unknown> => JSON.parse(fake.storage.get(SETTINGS_KEY) ?? "{}") as Record<string, unknown>;
  const pcm = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);

  it("Learn my voice: reads 16 s through the glasses mic into a voice socket, then marks the voice as enrolled", async () => {
    const fake = await boot();
    fake.menu(6);
    await vi.advanceTimersByTimeAsync(50);
    const socket = VoiceSocket.all.at(-1)!;
    expect(socket.url).toBe("wss://speech.example:8449");
    expect(socket.frames()[0]).toMatchObject({ type: "start", voice: "enroll", profile: "owner", token: "tok" });
    expect(fake.mic.open).toBe(true);
    expect(fake.header()).toMatch(/^BABEL · my voice · ● MIC/);
    expect(fake.body()).toContain("Read aloud · 16 s left");
    expect(fake.body()).toContain("Today is a quiet morning in the mountains.");
    expect(fake.footer()).toContain("cancel");
    // Audio goes to the enrollment socket only.
    fake.raw({ audioEvent: { audioPcm: pcm } });
    expect(socket.sent.filter((m) => typeof m !== "string")).toHaveLength(1);
    expect(VoiceSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.body()).toMatch(/Read aloud · 1[12] s left/);
    await vi.advanceTimersByTimeAsync(11_100);
    expect(fake.mic.open).toBe(false);
    expect(socket.frames().at(-1)).toEqual({ type: "stop" });
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.body()).toContain("Saved: your lines are now marked \"Me:\"");
    expect(fake.body()).toContain("14 s of voice · quality 83 %");
    expect(settings(fake)["voiceEnrolled"]).toBe(true);
    expect(socket.closed).toBe(true);
    fake.emit(0); // a tap closes the sheet, back to the list
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.header()).toMatch(/^BABEL · pick customer/);
    expect(fake.mic.open).toBe(false);
  });

  it("a tap while reading cancels: mic off, socket closed without stop, nothing stored", async () => {
    const fake = await boot();
    fake.menu(6);
    await vi.advanceTimersByTimeAsync(50);
    const socket = VoiceSocket.all.at(-1)!;
    expect(fake.mic.open).toBe(true);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fake.mic.open).toBe(false);
    expect(socket.closed).toBe(true);
    expect(socket.frames().some((f) => f["type"] === "stop")).toBe(false);
    expect(settings(fake)["voiceEnrolled"]).not.toBe(true);
    expect(fake.header()).toMatch(/^BABEL · pick customer/);
  });

  it("a server that rejects the reading says why and stores nothing", async () => {
    VoiceSocket.enrollReply = { type: "voice", action: "enroll", ok: false, error: "inconsistent", segments: 4, quality: 0.4 };
    try {
      const fake = await boot();
      fake.menu(6);
      await vi.advanceTimersByTimeAsync(16_200);
      expect(fake.body()).toContain("Several voices or noise – read alone.");
      expect(fake.body()).toContain("Nothing saved.");
      expect(settings(fake)["voiceEnrolled"]).not.toBe(true);
    } finally {
      VoiceSocket.enrollReply = { type: "voice", action: "enroll", ok: true, seconds: 14.2, quality: 0.83, segments: 5 };
    }
  });

  it("an older server without voice profiles: no ack, the mic never opens", async () => {
    class OldServer extends VoiceSocket {
      override send(data: string | Uint8Array): void { this.sent.push(data); }
    }
    vi.stubGlobal("WebSocket", OldServer);
    const fake = await boot();
    fake.menu(6);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(fake.mic.calls).toEqual([]);
    expect(fake.body()).toContain("Server cannot store voices yet.");
  });

  it("Delete my voice: asks the server to delete and clears the flag", async () => {
    const fake = await boot({ ...SERVER, voiceEnrolled: true });
    // QIS v1.2 #3: the first click only arms the delete.
    fake.menu(7);
    await vi.advanceTimersByTimeAsync(50);
    expect(VoiceSocket.all).toHaveLength(0);
    expect(fake.footer()).toBe("Tap again = delete · Swipe/2× = cancel");
    fake.menu(7);
    await vi.advanceTimersByTimeAsync(50);
    const socket = VoiceSocket.all.at(-1)!;
    expect(socket.frames()[0]).toMatchObject({ type: "start", voice: "delete", token: "tok" });
    expect(fake.body()).toContain("Voice print deleted on the server.");
    expect(settings(fake)["voiceEnrolled"]).toBe(false);
    expect(fake.mic.calls).toEqual([]);
  });

  it("without the side menu: Delete my voice is a row at the end of the list; one tap arms, a second tap on it deletes, anything else cancels", async () => {
    const fake = await boot({ ...SERVER, voiceEnrolled: true });
    expect(fake.page.menus.every((menu) => menu.length === 0)).toBe(true);
    fake.emit(2); fake.emit(2); // No customer -> Learn my voice -> Delete my voice
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.body().split("\n").find((row) => row.startsWith("> "))).toBe("> Delete my voice");
    fake.emit(0); // arms
    await vi.advanceTimersByTimeAsync(50);
    expect(VoiceSocket.all).toHaveLength(0);
    expect(fake.footer()).toBe("Tap again = delete · Swipe/2× = cancel");
    fake.emit(1); // a swipe cancels and does nothing else
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.footer()).not.toMatch(/^Tap again/);
    expect(settings(fake)["voiceEnrolled"]).toBe(true);
    fake.emit(0); // the cancelling swipe moved nothing: still on "Delete my voice"
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.footer()).toMatch(/^Tap again = delete/);
    fake.emit(0); // the confirming tap on the same row
    await vi.advanceTimersByTimeAsync(50);
    expect(VoiceSocket.all.at(-1)!.frames()[0]).toMatchObject({ type: "start", voice: "delete", token: "tok" });
    expect(settings(fake)["voiceEnrolled"]).toBe(false);
  });

  it("QIS v1.2 #3: an armed delete runs out after 4 s, and a swipe cancels it; nothing is deleted", async () => {
    const fake = await boot({ ...SERVER, voiceEnrolled: true });
    fake.menu(7);
    await vi.advanceTimersByTimeAsync(4_200);
    expect(fake.footer()).not.toMatch(/^Tap again/);
    fake.menu(7); // arms again, does not delete
    await vi.advanceTimersByTimeAsync(50);
    expect(VoiceSocket.all).toHaveLength(0);
    fake.emit(1); // a swipe cancels and does nothing else
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.footer()).not.toMatch(/^Tap again/);
    fake.menu(7);
    await vi.advanceTimersByTimeAsync(50);
    expect(VoiceSocket.all).toHaveLength(0);
    expect(settings(fake)["voiceEnrolled"]).toBe(true);
  });

  it("QIS v1.2 #3: stopped, Personen runs at once; running, a tap cancels the armed restart and captions go on", async () => {
    const fake = await boot({ ...SERVER, voiceEnrolled: true });
    fake.menu(8);
    await vi.advanceTimersByTimeAsync(50);
    expect(settings(fake)["persons"]).toBe(3);
    fake.emit(0); // start captions
    await vi.advanceTimersByTimeAsync(50);
    const sockets = VoiceSocket.all.length;
    fake.menu(8);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.footer()).toMatch(/^Tap again = restart captions/);
    fake.emit(0); // cancels the armed restart; it does not arm the stop either
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.footer()).not.toMatch(/^Again|^Tap again/);
    expect(settings(fake)["persons"]).toBe(3);
    expect(VoiceSocket.all.length).toBe(sockets);
    expect(fake.mic.open).toBe(true);
  });

  it("without a speech server it says so and never opens the mic", async () => {
    const fake = await boot({});
    fake.menu(6);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.body()).toContain("No speech recognition server set.");
    expect(fake.mic.calls).toEqual([]);
    expect(VoiceSocket.all).toHaveLength(0);
  });

  it("People 2 -> 3 -> 4 -> 5 -> 2 in the side menu, stored, and sent in the start frame (others = people - 1 once the voice is known)", async () => {
    const fake = await boot({ ...SERVER, voiceEnrolled: true });
    fake.menu(8);
    await vi.advanceTimersByTimeAsync(50);
    expect(settings(fake)["persons"]).toBe(3);
    expect(fake.page.creates).toBe(1);
    fake.emit(0); // start captions ("No customer")
    await vi.advanceTimersByTimeAsync(50);
    const captions = VoiceSocket.all.at(-1)!;
    expect(captions.frames()[0]).toMatchObject({ type: "start", stream: true, persons: 3, speakers: 2, token: "tok" });
    // Changed while listening: a fresh connection with the new numbers (QIS v1.2 #3: armed, second click within 4 s).
    const twice = async (): Promise<void> => {
      fake.menu(8);
      await vi.advanceTimersByTimeAsync(50);
      fake.menu(8);
      await vi.advanceTimersByTimeAsync(1_500);
    };
    await twice();
    expect(VoiceSocket.all.at(-1)!.frames()[0]).toMatchObject({ persons: 4, speakers: 3 });
    await twice();
    await twice();
    expect(settings(fake)["persons"]).toBe(2);
    expect(VoiceSocket.all.at(-1)!.frames()[0]).toMatchObject({ persons: 2, speakers: 1 });
  });

  it("captions: lines of the user's own voice read \"Me:\", the others keep their letter", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    const captions = VoiceSocket.all.at(-1)!;
    captions.onmessage?.({ data: JSON.stringify({ type: "final", text: "Was kostet das?", final: true, language: "en", speaker: "A" }) });
    captions.onmessage?.({ data: JSON.stringify({ type: "final", text: "Ich schaue nach.", final: true, language: "en", speaker: "ME" }) });
    await vi.advanceTimersByTimeAsync(300);
    expect(fake.body()).toContain("A: Was kostet das?");
    expect(fake.body()).toContain("Me: Ich schaue nach.");
  });
});

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
  const writes = { count: 0, creates: 0, rebuilds: 0, body: "" };
  const bridge = {
    getLocalStorage: async () => stored,
    setLocalStorage: async () => true,
    rebuildPageContainer: async () => { writes.rebuilds += 1; return true; },
    createStartUpPageContainer: async () => { writes.count += 1; writes.creates += 1; return 0; },
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

  it("1.0.0: 2× while captions run stops them and goes back to the start screen; it does not exit", async () => {
    const fake = await bootListening();
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.shutdown.modes).toEqual([]);
    expect(fake.mic.calls).toEqual([true, false]);
    expect(fake.mic.open).toBe(false);
    // Only on the start screen the second 2× asks the system.
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.shutdown.modes).toEqual([1]);
  });

  it("the call resolving true (dialog shown) does not close the app: the next tap still works", async () => {
    const fake = await bootListening();
    fake.emit(3); // stop, back to the start screen
    await vi.advanceTimersByTimeAsync(200);
    fake.emit(3); // the system dialog; the call resolves true when it is shown
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.shutdown.modes).toEqual([1]);
    expect(fake.mic.open).toBe(false);
    fake.emit(0); // "No", then a tap: captions start again
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.mic.open).toBe(true);
  });

  it("a system exit (sysEvent 7) after the dialog closes it for good: nothing writes or listens afterwards", async () => {
    const fake = await bootListening();
    fake.emit(3); // stop, back to the start screen
    await vi.advanceTimersByTimeAsync(200);
    fake.emit(3); // the system dialog
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.shutdown.modes).toEqual([1]);
    fake.emit(7); // the user said "yes": the system ends the app
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.mic.open).toBe(false);
    const writesAtClose = fake.writes.count;
    fake.emit(0); // a tap after leaving must not reopen the microphone
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.mic.open).toBe(false);
    expect(fake.writes.count).toBe(writesAtClose);
  });

  it("no timer, poll or stream draws while the exit dialog may be on screen; a single 2x right after restores the page first and asks the dialog only then", async () => {
    const fake = await bootListening();
    fake.emit(3); // stop, back to the start screen
    await vi.advanceTimersByTimeAsync(200);
    const creates = fake.writes.creates;
    // The call resolves true as soon as the dialog is SHOWN, whatever the user answers later.
    fake.shutdown.answer = () => Promise.resolve(true);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.shutdown.modes).toEqual([1]);
    const callsAtAsk = fake.writes.count;
    await vi.advanceTimersByTimeAsync(5000);
    // Timers, polls and streams keep collecting data but make no page call while the dialog may be on screen.
    expect(fake.writes.count).toBe(callsAtAsk);
    expect(fake.writes.creates).toBe(creates);
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
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(order).toEqual(["create:start"]); // the dialog is not asked while the page is still being created
    releaseCreate();
    await vi.advanceTimersByTimeAsync(1500);
    expect(order).toEqual(["create:start", "create:done", "shutdown"]); // restore first, then the dialog, exactly once more
  });

  it("hardware order (step log): 4 = dialog up -> nothing drawn; 5 = dialog gone after No -> page up again without a gesture, timers on, next 2x asks", async () => {
    const fake = await bootListening();
    fake.emit(3); // stop, back to the start screen
    await vi.advanceTimersByTimeAsync(200);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(70);
    expect(fake.shutdown.modes).toEqual([1]);
    const timers = vi.getTimerCount();
    fake.emit(4); // the dialog is on screen
    const atShown = fake.writes.count;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fake.writes.count).toBe(atShown); // nothing drawn over the dialog
    const creates = fake.writes.creates;
    fake.emit(5); // "No": the dialog is gone
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.writes.creates).toBeGreaterThan(creates); // page created again, no gesture needed
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(timers); // the ticker and every timer kept running (nothing was paused)
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.shutdown.modes).toEqual([1, 1]); // the very first 2x opens the dialog again
  });

  it("a root 2x while backgrounded (a 5 without a dialog) comes back and asks again after the restore draw", async () => {
    const fake = await bootListening();
    fake.emit(3); // stop, back to the start screen
    await vi.advanceTimersByTimeAsync(200);
    fake.emit(5); // genuinely backgrounded
    await vi.advanceTimersByTimeAsync(200);
    const drawn = fake.writes.count + fake.writes.rebuilds;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fake.writes.count + fake.writes.rebuilds).toBeGreaterThan(drawn); // the page was put up again
    expect(fake.shutdown.modes).toEqual([1]); // and the dialog was asked, not swallowed
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

  it("survives an exit call that rejects, without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    nodeProcess.on("unhandledRejection", onUnhandled);
    const fake = await bootListening();
    fake.emit(3); // stop, back to the start screen
    await vi.advanceTimersByTimeAsync(200);
    fake.shutdown.answer = () => Promise.reject(new Error("ble gone"));
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(fake.shutdown.modes).toEqual([1]);
    expect(fake.mic.open).toBe(false);
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

  it("0.6.1: no glasses gesture sequence clears the transcript (a hold does nothing on the start screen)", async () => {
    const kept = JSON.stringify({ log: [{ text: "Hallo", at: 1 }], summary: { short: ["Kurz gesagt"], long: ["Lang"] } });
    const fake = await boot(richBridge({ stored: {
      [SETTINGS_KEY]: JSON.stringify({ keepTranscript: true }),
      [CONVERSATION_KEY]: kept,
    } }));
    expect(fake.body()).toContain("Kurz gesagt");
    expect(fake.page.text.get(3)).toBe("Tap = go on · 2× = exit");
    fake.emit(9); // a hold is no gesture of the app: nothing opens, nothing is cleared
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.body()).toContain("Kurz gesagt");
    fake.emit(10);
    await vi.advanceTimersByTimeAsync(50);
    // Every short sequence of non-start gestures (swipes/hold/release/2×), none of which may clear.
    const gestures = [1, 2, 9, 10, 3];
    for (const first of gestures) for (const second of gestures) for (const third of gestures) {
      for (const g of [first, second, third]) {
        fake.emit(g);
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(fake.storage.get(CONVERSATION_KEY)).toBe(kept);
    }
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
    expect(fake.page.text.get(1)).toMatch(/^Translate · ● live · stop\?/);
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

  it("QIS v1: 2× closes the summary first and only then leaves the app", async () => {
    const kept = JSON.stringify({ log: [{ text: "Hallo", at: 1 }], summary: { short: ["Kurz gesagt"], long: ["Lang"] } });
    const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify({ keepTranscript: true }), [CONVERSATION_KEY]: kept } }));
    expect(fake.body()).toContain("Kurz gesagt");
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.shutdown.modes).toEqual([]);
    expect(fake.header()).toBe("BABEL · mic off · MOCK");
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.shutdown.modes).toEqual([1]);
  });

  it("1.0.0: 2× closes a popup first, then stops and returns to the start screen; the exit dialog only comes from there", async () => {
    const fake = await boot(richBridge());
    fake.emit(0); // demo captions
    await vi.advanceTimersByTimeAsync(3000);
    fake.emit(9); // manual word finder opens a popup
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.body()).toContain("quote · estimate · offer");
    fake.emit(3); // closes the popup only
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.body()).not.toContain("quote · estimate");
    expect(fake.mic.open).toBe(true);
    fake.emit(3); // now it stops and goes back to the start screen
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.mic.open).toBe(false);
    expect(fake.shutdown.modes).toEqual([]);
    expect(fake.header()).toMatch(/^BABEL · mic off/);
    expect(fake.body().split("\n").slice(0, 3)).toEqual(["> Translate", "  Speak English", "  Conversation"]);
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
    expect(fake.page.text.get(1) ?? "").toMatch(/^Translate · ● live/);
    fake.emit(0); // tap closes the popup, captions go on
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.mic.open).toBe(true);
    expect(fake.body()).not.toContain("Reply:");
  });

  it("1.0.0 start screen: exactly three modes, a voice hint; swipes move the cursor, a hold does nothing", async () => {
    const fake = await boot(richBridge());
    expect(fake.header()).toBe("BABEL · mic off · MOCK");
    expect(fake.body().split("\n")).toEqual(["> Translate", "  Speak English", "  Conversation", "Tip: learn your voice on the phone"]);
    expect(fake.footer()).toBe("Tap: start · Swipe: choose · 2×: exit");
    fake.emit(2);
    fake.emit(2);
    fake.emit(2); // never below the last row
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.body().split("\n")).toEqual(["  Translate", "  Speak English", "> Conversation", "Tip: learn your voice on the phone"]);
    for (const other of [9, 10]) {
      fake.emit(other);
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.header()).toBe("BABEL · mic off · MOCK");
      expect(fake.mic.open).toBe(false);
    }
    fake.emit(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.body().split("\n")[1]).toBe("> Speak English");
  });

  it("1.0.0: the hint row disappears once a voice is trained", async () => {
    const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify({ voiceEnrolled: true }) } }));
    expect(fake.body().split("\n")).toEqual(["> Translate", "  Speak English", "  Conversation"]);
  });

  it("1.0.0 running screen: mode and state on top, one hint line below; a tap arms, scrolling back says paused", async () => {
    const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify({ replySuggestions: false, insights: false }) } }));
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fake.header()).toBe("Translate · ● live · MOCK");
    expect(fake.footer()).toBe("Tap: stop · Swipe: back");
    fake.emit(1); // swipe up = back in the history
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.header()).toBe("Translate · ● live · history · MOCK");
    expect(fake.footer()).toBe("Tap: stop · Swipe down: live");
  });

  it("1.0.0 start screen: each row starts its mode, stores it, and the mode name heads the running screen", async () => {
    for (const [swipes, mode, header] of [[0, "translate", "Translate"], [1, "learn", "Speak English"], [2, "client", "Conversation"]] as const) {
      const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify({ replySuggestions: false, insights: false }) } }));
      for (let i = 0; i < swipes; i += 1) fake.emit(2);
      await vi.advanceTimersByTimeAsync(50);
      fake.emit(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(fake.mic.open).toBe(true);
      expect(JSON.parse(fake.storage.get(SETTINGS_KEY) ?? "{}")["talkMode"]).toBe(mode);
      expect(fake.header()).toMatch(new RegExp("^" + header + " · ● live"));
    }
  });

  it("1.0.0 Speak English: captions in English, no translation of the user's own line, swipe down at the live edge does not translate", async () => {
    const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify({ replySuggestions: false, insights: false, talkMode: "learn" }) } }));
    // The cursor sits on the mode used last.
    expect(fake.body().split("\n")[1]).toBe("> Speak English");
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(3500);
    fake.emit(2); // already at the live edge: in Übersetzen this asks for "my last sentence"
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.body()).not.toContain("Translate into");
    expect(fake.body()).not.toContain("set \"Translate");
    expect(fake.mic.open).toBe(true);
  });

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.); the click handler stays", async () => {
    const fake = await boot(richBridge());
    expect(fake.page.menus.length).toBeGreaterThan(0);
    expect(fake.page.menus.every((menu) => menu.length === 0)).toBe(true); // no menuObject on any page
    fake.menu(8); // people: 2 -> 3
    await vi.advanceTimersByTimeAsync(50);
    expect(JSON.parse(fake.storage.get(SETTINGS_KEY) ?? "{}")["persons"]).toBe(3);
    expect(fake.page.menus.every((menu) => menu.length === 0)).toBe(true);
    expect(fake.page.creates).toBe(1); // no menu, so no rebuild for it either
    // The help, overview, mode and customer entries are gone: their ids do nothing.
    for (const id of [1, 2, 3, 4, 5]) fake.menu(id);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.header()).toBe("BABEL · mic off · MOCK");
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

    it("lists the customers under 'Conversation': today's first (by time), then by name", async () => {
      const calls = stub("ok");
      const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify({ ...SERVER, voiceEnrolled: true }) } }));
      expect(calls.some((call) => call.url === "https://proxy.example/context/customers")).toBe(true);
      expect(fake.header()).toBe("BABEL · mic off · MOCK");
      expect(fake.body().split("\n")).toEqual([
        "> Translate",
        "  Speak English",
        "  Conversation",
        "    Beispiel Café · today 09:00",
        "    Zeta Werkstatt · today 14:30",
        "    Alpha Studio · 02.01.",
        "    Muster Bäckerei",
      ]);
      expect(fake.footer()).toBe("Tap: start · Swipe: choose · 2×: exit");
      for (let i = 0; i < 4; i += 1) fake.emit(2);
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.body().split("\n")[4]).toBe(">   Zeta Werkstatt · today 14:30");
      for (let i = 0; i < 6; i += 1) fake.emit(1); // never above the first row
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.body().split("\n")[0]).toBe("> Translate");
    });

    it("honours invertScroll: the physical swipe direction moves the cursor", async () => {
      stub("ok");
      const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify({ ...SERVER, invertScroll: true }) } }));
      fake.emit(1); // SCROLL_TOP on inverted hardware = down
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.body().split("\n")[1]).toMatch(/^> Speak English/);
    });

    it("a tap on a customer starts 'Conversation' with that customer: X-Babel-Customer on every model request", async () => {
      const calls = stub("ok");
      const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify({ ...SERVER, talkMode: "translate", replySuggestions: true, autoSummary: false }) } }));
      for (let i = 0; i < 3; i += 1) fake.emit(2); // Translate -> Speak English -> Conversation -> Beispiel Café
      await vi.advanceTimersByTimeAsync(50);
      fake.emit(0);
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.mic.open).toBe(true);
      expect(JSON.parse(fake.storage.get(SETTINGS_KEY) ?? "{}")["talkMode"]).toBe("client");
      expect(fake.header()).toMatch(/^Conversation · ● live/);
      const info = calls.find((call) => call.url.includes("/context/customer?full=1"));
      expect(info?.url).toBe("https://proxy.example/context/customer?full=1&customer=c_3");
      expect(info?.headers["X-Babel-Customer"]).toBe("c_3");
      // The demo recogniser asks a question; the reply suggestion goes to the model with the customer header.
      await vi.advanceTimersByTimeAsync(6000);
      const chats = calls.filter((call) => call.url.includes("/chat/completions"));
      expect(chats.length).toBeGreaterThan(0);
      for (const chat of chats) expect(chat.headers["X-Babel-Customer"]).toBe("c_3");
      // While listening a swipe scrolls the captions.
      for (const swipe of [1, 2]) {
        fake.emit(swipe);
        await vi.advanceTimersByTimeAsync(50);
        expect(fake.header()).toMatch(/^Conversation · /);
      }
      // 2× stops and returns to the start screen, the cursor on the customer in use.
      fake.emit(3);
      await vi.advanceTimersByTimeAsync(100);
      expect(fake.mic.open).toBe(false);
      expect(fake.header()).toBe("BABEL · mic off · MOCK");
      expect(fake.body().split("\n").find((row) => row.startsWith(">"))).toBe(">   Beispiel Café · today 09:00");
    });

    it("the 'Conversation' row itself starts without any customer context", async () => {
      const calls = stub("ok");
      const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify({ ...SERVER, talkMode: "translate", replySuggestions: true }) } }));
      fake.emit(2);
      fake.emit(2);
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.body().split("\n").find((row) => row.startsWith("> "))).toBe("> Conversation");
      fake.emit(0);
      await vi.advanceTimersByTimeAsync(6000);
      expect(fake.mic.open).toBe(true);
      expect(JSON.parse(fake.storage.get(SETTINGS_KEY) ?? "{}")["talkMode"]).toBe("client");
      expect(calls.some((call) => call.url.includes("/context/customer?full=1"))).toBe(false);
      const chats = calls.filter((call) => call.url.includes("/chat/completions"));
      for (const chat of chats) expect(chat.headers["X-Babel-Customer"]).toBe("-");
    });

    it("an unreachable list leaves just the three rows", async () => {
      const calls = stub("fail");
      const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify({ ...SERVER, voiceEnrolled: true }) } }));
      expect(fake.body().split("\n")).toEqual(["> Translate", "  Speak English", "  Conversation"]);
      expect(calls.filter((call) => call.url.endsWith("/context/customers"))).toHaveLength(1);
      fake.emit(0);
      await vi.advanceTimersByTimeAsync(50);
      expect(fake.mic.open).toBe(true);
    });

    it("a list that never answers gives up after the timeout", async () => {
      stub("hang");
      const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify(SERVER) } }));
      // While loading nothing is listed under 'Conversation'; and it stays like that.
      expect(fake.body().split("\n").slice(0, 3)).toEqual(["> Translate", "  Speak English", "  Conversation"]);
      await vi.advanceTimersByTimeAsync(4500);
      expect(fake.body().split("\n").slice(0, 3)).toEqual(["> Translate", "  Speak English", "  Conversation"]);
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
    fake.emit(0); // a tap closes the sheet, back to the start screen
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.header()).toMatch(/^BABEL · mic off/);
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
    expect(fake.header()).toMatch(/^BABEL · mic off/);
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

  it("1.0.0: no voice entries on the glasses' start screen any more (they live on the phone)", async () => {
    const fake = await boot({ ...SERVER, voiceEnrolled: true });
    expect(fake.page.menus.every((menu) => menu.length === 0)).toBe(true);
    for (let i = 0; i < 6; i += 1) fake.emit(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.body()).not.toMatch(/voice|People/i);
    expect(fake.body().split("\n")).toEqual(["  Translate", "  Speak English", "> Conversation"]);
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

describe("babel-glass 1.1.1 Sprecher erkennen (Brille)", () => {
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

  const SERVER = { sttUrl: "wss://speech.example:8449" };
  /** A voiced 20 ms frame (amplitude 3000). */
  const loud = (): Uint8Array => {
    const out = new Uint8Array(640);
    for (let i = 0; i < 320; i++) { out[2 * i] = 3000 & 0xff; out[2 * i + 1] = 3000 >> 8; }
    return out;
  };
  async function listen(stored: Record<string, unknown>) {
    const fake = richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify({ ...SERVER, ...stored }) } });
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.advanceTimersByTimeAsync(50);
    fake.emit(0); // start the mode under the cursor (the stored one)
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.mic.open).toBe(true);
    const socket = VoiceSocket.all.at(-1)!;
    const say = async (role: string, text: string, speaker?: string): Promise<void> => {
      for (let i = 0; i < 10; i++) fake.raw({ audioEvent: { audioPcm: loud(), speakerRole: role, direction: 5, source: "glasses" } });
      socket.onmessage?.({ data: JSON.stringify({ type: "final", text, final: true, language: "de", ...(speaker ? { speaker } : {}) }) });
      await vi.advanceTimersByTimeAsync(300);
    };
    return { fake, socket, say };
  }

  it("Gespräch: lines are marked Me / Them by the glasses' role; an unknown line stays; the audio still reaches the server", async () => {
    const { fake, socket, say } = await listen({ talkMode: "client" });
    await say("other", "Was kostet das?", "A");
    await say("self", "Ich schaue nach.", "B");
    await say("unknown", "Moment bitte.");
    expect(fake.body()).toContain("Them: Was kostet das?");
    expect(fake.body()).toContain("Me: Ich schaue nach.");
    expect(fake.body()).toContain("Moment bitte.");
    expect(fake.body()).not.toContain(": Moment bitte.");
    expect(socket.sent.filter((m) => typeof m !== "string")).toHaveLength(30);
  });

  it("switched off on the phone: the old speaker letters, no Me / Them", async () => {
    const { fake, say } = await listen({ talkMode: "client", speakerRole: false });
    await say("other", "Was kostet das?", "A");
    await say("self", "Ich schaue nach.", "B");
    expect(fake.body()).toContain("A: Was kostet das?");
    expect(fake.body()).toContain("B: Ich schaue nach.");
    expect(fake.body()).not.toContain("Me:");
  });

  it("Translate mode carries no Me / Them marks", async () => {
    const { fake, say } = await listen({ talkMode: "translate" });
    await say("self", "Ich schaue nach.", "B");
    expect(fake.body()).toContain("B: Ich schaue nach.");
  });

  it("a voice profile wins: ME is Me although the glasses said other, a letter is Them although they said self", async () => {
    const { fake, say } = await listen({ talkMode: "client", voiceEnrolled: true });
    await say("other", "Ich schaue nach.", "ME");
    await say("self", "Was kostet das?", "A");
    expect(fake.body()).toContain("Me: Ich schaue nach.");
    expect(fake.body()).toContain("Them: Was kostet das?");
  });
});

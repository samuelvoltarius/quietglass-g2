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
    expect(fake.mic.open).toBe(false);
    const writesAtClose = fake.writes.count;
    fake.emit(0); // a tap after leaving must not reopen the microphone
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.mic.open).toBe(false);
    expect(fake.writes.count).toBe(writesAtClose);
  });

  it("reopens the microphone and keeps captioning when the user cancels", async () => {
    const fake = await bootListening();
    fake.shutdown.answer = () => Promise.resolve(false);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.shutdown.modes).toEqual([1]);
    expect(fake.mic.calls).toEqual([true, false, true]);
    expect(fake.mic.open).toBe(true);
    const writesAtCancel = fake.writes.count;
    await vi.advanceTimersByTimeAsync(10_000); // the mock recogniser keeps producing lines
    expect(fake.writes.count).toBeGreaterThan(writesAtCancel);
  });

  it("does not open the microphone on cancel if captions were off", async () => {
    const fake = await bootListening();
    fake.emit(0); // tap: stop captions
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
  const page = { creates: 0, rebuilds: 0, text: new Map<number, string>() };
  const remember = (parts: { containerID?: number; content?: string }[] | undefined): void => {
    for (const part of parts ?? []) if (part.containerID !== undefined) page.text.set(part.containerID, part.content ?? "");
  };
  const bridge = {
    getLocalStorage: async (key: string) => storage.get(key) ?? "",
    setLocalStorage: async (key: string, value: string) => { storage.set(key, value); return true; },
    rebuildPageContainer: async (built: { textObject?: { containerID?: number; content?: string }[] }) => {
      page.rebuilds += 1;
      if (page.creates > 0) remember(built.textObject);
      return true;
    },
    createStartUpPageContainer: (built: { textObject?: { containerID?: number; content?: string }[] }): Promise<number> => {
      page.creates += 1;
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

  it("one hold does not clear the transcript; a second hold within the window does", async () => {
    const kept = JSON.stringify({ log: [{ text: "Hallo", at: 1 }], summary: { short: ["Kurz gesagt"], long: ["Lang"] } });
    const fake = await boot(richBridge({ stored: {
      [SETTINGS_KEY]: JSON.stringify({ keepTranscript: true }),
      [CONVERSATION_KEY]: kept,
    } }));
    expect(fake.body()).toContain("Kurz gesagt");
    fake.emit(9);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.footer()).toContain("hold again");
    expect(fake.storage.get(CONVERSATION_KEY)).toBe(kept);
    fake.emit(9);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.storage.get(CONVERSATION_KEY)).toBe("");
    expect(fake.body()).not.toContain("Kurz gesagt");
  });

  it("an armed hold runs out", async () => {
    const fake = await boot(richBridge());
    fake.emit(9);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.footer()).toContain("hold again");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.footer()).not.toContain("hold again");
  });

  it("without the opt-in nothing of the conversation is stored", async () => {
    const fake = await boot(richBridge());
    fake.emit(0); // mock captions
    await vi.advanceTimersByTimeAsync(10_000);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(6000);
    expect(fake.storage.has(CONVERSATION_KEY)).toBe(false);
  });

  it("with the opt-in the conversation is stored when captions stop", async () => {
    const fake = await boot(richBridge({ stored: { [SETTINGS_KEY]: JSON.stringify({ keepTranscript: true, autoSummary: false }) } }));
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(10_000);
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

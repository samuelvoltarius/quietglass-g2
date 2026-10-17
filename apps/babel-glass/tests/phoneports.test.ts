import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGestureDedupe } from "../src/input/gestures";
import type { ConversationState, PhoneUiPorts } from "../src/ui/phone";

// 1.0.0: what the phone drives in the running app (voice, mode, people, customer) and how the word finder is switched
// per mode. The real main.ts runs against a fake bridge; the phone page is replaced by a capture of its ports.
const harness = vi.hoisted(() => ({ bridge: null as unknown, ports: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
vi.mock("../src/ui/phone", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/phone")>()),
  mountPhoneUi: (ports: unknown) => { harness.ports = ports; },
}));

const SETTINGS_KEY = "quietglass.babelglass.v1";

function fakeBridge(stored: Record<string, unknown>) {
  let handler: ((event: unknown) => void) | undefined;
  const storage = new Map<string, string>([[SETTINGS_KEY, JSON.stringify(stored)]]);
  const mic = { open: false, calls: [] as boolean[] };
  const text = new Map<number, string>();
  const remember = (parts: { containerID?: number; content?: string }[] | undefined): void => {
    for (const part of parts ?? []) if (part.containerID !== undefined) text.set(part.containerID, part.content ?? "");
  };
  type Built = { textObject?: { containerID?: number; content?: string }[] };
  const bridge = {
    getLocalStorage: async (key: string) => storage.get(key) ?? "",
    setLocalStorage: async (key: string, value: string) => { storage.set(key, value); return true; },
    rebuildPageContainer: async (built: Built) => { remember(built.textObject); return true; },
    createStartUpPageContainer: async (built: Built) => { remember(built.textObject); return 0; },
    textContainerUpgrade: async (update: { containerID?: number; content?: string }) => { remember([update]); return true; },
    updateImageRawData: async () => "success",
    audioControl: async (isOpen: boolean) => { mic.calls.push(isOpen); mic.open = isOpen; return true; },
    shutDownPageContainer: async () => true,
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, mic, storage,
    header: () => text.get(1) ?? "",
    body: () => text.get(2) ?? "",
    stored: () => JSON.parse(storage.get(SETTINGS_KEY) ?? "{}") as Record<string, unknown>,
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
    ready: () => handler !== undefined,
  };
}

/** A speech server that opens at once; it knows voice profiles and answers like the real one. */
const sockets: Socket[] = [];
class Socket {
  readyState = 0;
  sent: string[] = [];
  voice: string | null = null;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: unknown = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) { sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 1); }
  frames(): Record<string, unknown>[] { return this.sent.map((m) => JSON.parse(m) as Record<string, unknown>); }
  send(data: unknown): void {
    if (typeof data !== "string") return;
    this.sent.push(data);
    const frame = JSON.parse(data) as Record<string, unknown>;
    if (frame["type"] === "start" && typeof frame["voice"] === "string") {
      this.voice = frame["voice"];
      if (this.voice === "enroll") this.answer({ type: "voice", action: "enroll", state: "listening" });
      if (this.voice === "delete") this.answer({ type: "voice", action: "delete", ok: true, existed: true });
    }
    if (frame["type"] === "stop" && this.voice === "enroll") this.answer({ type: "voice", action: "enroll", ok: true, seconds: 14.2, quality: 0.83 });
  }
  answer(value: unknown): void { setTimeout(() => this.onmessage?.({ data: JSON.stringify(value) }), 1); }
  say(text: string, over: Record<string, unknown> = {}): void {
    this.onmessage?.({ data: JSON.stringify({ type: "final", text, final: true, language: "en", ...over }) });
  }
  close(): void { if (!this.closed) { this.closed = true; this.readyState = 3; setTimeout(() => this.onclose?.({ code: 1000 }), 0); } }
}

describe("babel-glass 1.0.0 phone ports", () => {
  let chats = 0;
  beforeEach(() => {
    resetGestureDedupe();
    sockets.length = 0;
    chats = 0;
    harness.ports = null;
    vi.useFakeTimers();
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null });
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/chat/completions")) chats += 1;
      return { ok: false, status: 500, json: async () => ({}), text: async () => "" };
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const SPEECH = { sttUrl: "wss://speech.example:8449", sttToken: "tok" };
  const LLM = { llmUrl: "https://llm.example/v1", llmModel: "m", insights: false, memory: false, replySuggestions: false, autoSummary: false };

  async function boot(stored: Record<string, unknown>) {
    const fake = fakeBridge(stored);
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.advanceTimersByTimeAsync(50);
    const ports = harness.ports as PhoneUiPorts;
    return { fake, ports, conversation: (): ConversationState => ports.getConversation!() };
  }

  it("Stimme lernen without a server says so on the phone and on the glasses, and never opens the mic", async () => {
    const { fake, ports, conversation } = await boot({});
    ports.onLearnVoice!();
    await vi.advanceTimersByTimeAsync(50);
    expect(conversation().voice).toEqual({ trained: false, phase: "error", message: "Enter the server first." });
    expect(fake.body()).toContain("No speech recognition server set.");
    expect(fake.mic.calls).toEqual([]);
    fake.emit(0); // a tap closes the sheet
    await vi.advanceTimersByTimeAsync(50);
    expect(conversation().voice).toEqual({ trained: false, phase: "idle" });
    expect(fake.header()).toMatch(/^BABEL · mic off/);
  });

  it("Stimme lernen: the glasses read, the phone follows step by step, and the voice is trained afterwards", async () => {
    const { fake, ports, conversation } = await boot(SPEECH);
    expect(conversation().voice).toEqual({ trained: false, phase: "idle" });
    ports.onLearnVoice!();
    await vi.advanceTimersByTimeAsync(50);
    expect(sockets.at(-1)!.frames()[0]).toMatchObject({ type: "start", voice: "enroll", token: "tok" });
    expect(conversation().voice?.phase).toBe("reading");
    expect(fake.mic.open).toBe(true);
    expect(fake.body()).toContain("Read aloud");
    await vi.advanceTimersByTimeAsync(16_200);
    expect(fake.mic.open).toBe(false);
    expect(conversation().voice).toMatchObject({ trained: true, phase: "done" });
    expect(conversation().voice?.message).toContain("Saved");
    expect(fake.stored()["voiceEnrolled"]).toBe(true);
  });

  it("Stimme löschen deletes on the server without any prompt on the glasses (the phone asked)", async () => {
    const { fake, ports, conversation } = await boot({ ...SPEECH, voiceEnrolled: true });
    expect(conversation().voice?.trained).toBe(true);
    ports.onDeleteVoice!();
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets.at(-1)!.frames()[0]).toMatchObject({ type: "start", voice: "delete", token: "tok" });
    expect(fake.stored()["voiceEnrolled"]).toBe(false);
    expect(conversation().voice).toMatchObject({ trained: false, phase: "done" });
    expect(fake.mic.calls).toEqual([]);
  });

  it("a mode picked on the phone while captions run restarts the recogniser in the new language; so do the people", async () => {
    const { fake, ports } = await boot({ ...SPEECH, talkMode: "translate", voiceEnrolled: true });
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(sockets.at(-1)!.frames()[0]).toMatchObject({ type: "start", language: "auto", persons: 2 });
    void ports.setData({ ...ports.getData(), talkMode: "learn" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sockets.at(-1)!.frames()[0]).toMatchObject({ type: "start", language: "en" });
    expect(fake.header()).toMatch(/^Speak English · ● live/);
    const before = sockets.length;
    void ports.setData({ ...ports.getData(), persons: 4 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sockets.length).toBeGreaterThan(before);
    expect(sockets.at(-1)!.frames()[0]).toMatchObject({ persons: 4, speakers: 3 });
    expect(fake.mic.open).toBe(true);
  });

  it("the customer picked on the phone is reported in the conversation state", async () => {
    vi.stubGlobal("fetch", async (url: string) => String(url).endsWith("/context/customers")
      ? { ok: true, status: 200, json: async () => ({ customers: [{ id: "c_1", name: "Beispiel Café", company: "", next: null }] }) }
      : { ok: false, status: 500, json: async () => ({}), text: async () => "" });
    const { ports, conversation } = await boot({ ...SPEECH, ...LLM, talkMode: "client" });
    expect(conversation().customers).toEqual([{ id: "c_1", name: "Beispiel Café" }]);
    expect(conversation().customerId).toBeNull();
    ports.onPickCustomer!("c_1");
    expect(conversation().customerId).toBe("c_1");
    ports.onPickCustomer!(null);
    expect(conversation().customerId).toBeNull();
  });

  describe("automatic word finder per mode", () => {
    const partial = (socket: Socket, text: string): void => {
      socket.onmessage?.({ data: JSON.stringify({ type: "partial", text, final: false, language: "en" }) });
    };

    it("Englisch sprechen: always on, even with the phone switch off", async () => {
      const { fake } = await boot({ ...SPEECH, ...LLM, talkMode: "learn", wordAuto: false });
      fake.emit(0);
      await vi.advanceTimersByTimeAsync(100);
      partial(sockets.at(-1)!, "I would like to order a");
      await vi.advanceTimersByTimeAsync(3_200);
      expect(chats).toBeGreaterThan(0);
    });

    it.each([
      ["translate", false, false],
      ["translate", true, true],
      ["client", false, false],
    ] as const)("%s with the phone switch %s: asks for the word = %s", async (mode, wordAuto, asked) => {
      const { fake } = await boot({ ...SPEECH, ...LLM, talkMode: mode, wordAuto });
      fake.emit(0);
      await vi.advanceTimersByTimeAsync(100);
      partial(sockets.at(-1)!, "I would like to order a");
      await vi.advanceTimersByTimeAsync(3_200);
      expect(chats > 0).toBe(asked);
    });

    it("with a trained voice only the user's own FINAL line counts, a pending line of unknown speaker does not", async () => {
      const { fake } = await boot({ ...SPEECH, ...LLM, talkMode: "learn", voiceEnrolled: true });
      fake.emit(0);
      await vi.advanceTimersByTimeAsync(100);
      const socket = sockets.at(-1)!;
      partial(socket, "I would like to order a");
      await vi.advanceTimersByTimeAsync(3_200);
      expect(chats).toBe(0);
      socket.say("Fine, thank you.", { speaker: "A" });
      partial(socket, "and then the");
      await vi.advanceTimersByTimeAsync(3_200);
      expect(chats).toBe(0);
      socket.say("I would like to order a", { speaker: "ME" });
      await vi.advanceTimersByTimeAsync(3_200);
      expect(chats).toBeGreaterThan(0);
    });
  });
});

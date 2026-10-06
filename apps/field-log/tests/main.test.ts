import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRoot, type FakeRoot } from "./fake-dom";

// Boots the real app against a fake bridge, so the lifecycle can be checked without hardware.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const KEY = "quietglass.fieldlog.v1";

function fakeBridge(stored: Record<string, unknown> | null = null) {
  let handler: ((event: unknown) => void) | undefined;
  let statusHandler: ((status: unknown) => void) | undefined;
  const storage = new Map<string, string>();
  if (stored) storage.set(KEY, JSON.stringify(stored));
  const bridge = {
    getLocalStorage: vi.fn(async (key: string) => storage.get(key) ?? ""),
    setLocalStorage: vi.fn(async (key: string, value: string) => { storage.set(key, value); return true; }),
    rebuildPageContainer: vi.fn(async () => true),
    createStartUpPageContainer: vi.fn(async (): Promise<number> => 0),
    textContainerUpgrade: vi.fn(async () => true),
    shutDownPageContainer: vi.fn(async () => true),
    audioControl: vi.fn(async (_on: boolean, _source?: unknown): Promise<boolean> => true),
    captureImageFromCamera: vi.fn(async () => null),
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: (callback: (status: unknown) => void) => { statusHandler = callback; return () => undefined; },
  };
  return {
    bridge,
    reconnect: () => statusHandler?.({ connectType: "connected" }),
    audio: () => handler?.({ audioEvent: { audioPcm: new Uint8Array(32) } }),
    emit: (eventType: number) => handler?.({ sysEvent: { eventType, eventSource: 1 } }),
    ready: () => handler !== undefined,
  };
}

type Fake = ReturnType<typeof fakeBridge>;

function lastBody(fake: Fake): string {
  const calls = fake.bridge.textContainerUpgrade.mock.calls
    .map((call) => (call as unknown as [{ containerID?: number; content?: string }])[0])
    .filter((upgrade) => upgrade.containerID === 2);
  return calls[calls.length - 1]?.content ?? "";
}

async function boot(fake: Fake): Promise<FakeRoot> {
  const root = fakeRoot();
  vi.stubGlobal("document", { getElementById: () => root });
  vi.stubGlobal("location", { search: "" });
  // The app follows the device language; these tests read the English copy.
  vi.stubGlobal("navigator", { language: "en-US" });
  harness.bridge = fake.bridge;
  vi.resetModules();
  await import("../src/main");
  await vi.waitFor(() => expect(fake.ready()).toBe(true));
  await vi.waitFor(() => expect(root.renders).toBeGreaterThan(0));
  return root;
}

/** A WebSocket the test drives by hand: it opens on `open()` and replies on `reply()`. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static autoOpen = true;
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
    if (FakeSocket.autoOpen) setTimeout(() => this.open(), 0);
  }
  open(): void { this.readyState = 1; this.onopen?.(); }
  send(data: unknown): void { this.sent.push(data); }
  close(): void { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
  reply(text: string, final = true): void { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify({ text, final }) }); }
}

function data(sttUrl = "wss://asr.test/ws") {
  return {
    inspections: [{ id: "i1", title: "Flat 3", startedAt: Date.now(), finishedAt: null, entries: [], section: "Kitchen" }],
    activeId: "i1",
    sttUrl,
    language: "en",
    severity: "note",
    invertScroll: false,
  };
}

describe("fieldlog lifecycle", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    FakeSocket.instances = [];
    FakeSocket.autoOpen = true;
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("regression: a transcript that arrives after tapping stop is still offered for review", async () => {
    // Stop closed the speech socket at once, so the final transcript the server
    // sends after the end of speech was lost and the glasses sat on
    // "Transcribing…" until the app was left.
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Listening"));
    fake.audio();
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Transcribing"));
    FakeSocket.instances[0]!.reply("Window seal damaged");
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Window seal damaged"));
    // The microphone went off at the tap, not only once the text arrived.
    expect(fake.bridge.audioControl.mock.calls.map((call) => call[0])).toEqual([true, false]);
  });

  it("regression: gives up waiting for a transcript instead of hanging on Transcribing", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    vi.useFakeTimers();
    try {
      fake.emit(0);
      await vi.advanceTimersByTimeAsync(50);
      fake.emit(0);
      await vi.advanceTimersByTimeAsync(50);
      expect(lastBody(fake)).toContain("Transcribing");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(lastBody(fake)).not.toContain("Transcribing");
      expect(FakeSocket.instances[0]!.readyState).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("regression: a second tap while the speech server is still connecting opens no second socket", async () => {
    FakeSocket.autoOpen = false;
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0);
    fake.emit(0);
    await sleep(20);
    expect(FakeSocket.instances).toHaveLength(1);
    FakeSocket.instances[0]!.open();
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Listening"));
    expect(fake.bridge.audioControl.mock.calls.filter((call) => call[0] === true)).toHaveLength(1);
  });

  it("regression: a speech server that cannot be reached is not an unhandled rejection", async () => {
    vi.stubGlobal("WebSocket", class { constructor() { throw new Error("blocked"); } });
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0);
    await sleep(20);
    expect(fake.bridge.audioControl).not.toHaveBeenCalled();
    // Still usable: the next tap tries again.
    vi.stubGlobal("WebSocket", FakeSocket);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Listening"));
  });

  it("regression: a late transcript does not replace the one under review", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Listening"));
    const socket = FakeSocket.instances[0]!;
    socket.reply("First finding");
    await vi.waitFor(() => expect(lastBody(fake)).toContain("First finding"));
    socket.reply("Something else");
    await sleep(20);
    expect(lastBody(fake)).toContain("First finding");
  });

  it("regression: a failed exit call is not an unhandled rejection, asks once, and the app stays", async () => {
    const fake = fakeBridge(data());
    fake.bridge.shutDownPageContainer.mockRejectedValue(new Error("already closed"));
    await boot(fake);
    fake.emit(3);
    fake.emit(3);
    await sleep(20);
    expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(1);
    expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1);
    const drawn = fake.bridge.textContainerUpgrade.mock.calls.length;
    fake.emit(2); // a swipe still changes the severity
    await vi.waitFor(() => expect(fake.bridge.textContainerUpgrade.mock.calls.length).toBeGreaterThan(drawn));
  });

  it("leaving while recording pauses the microphone for the system dialog and draws nothing more after confirm", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Listening"));
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1));
    await sleep(10);
    const drawn = fake.bridge.textContainerUpgrade.mock.calls.length;
    FakeSocket.instances[0]?.reply("too late");
    fake.emit(0);
    await sleep(30);
    expect(fake.bridge.audioControl.mock.calls.map((call) => call[0])).toEqual([true, false, false]);
    expect(fake.bridge.textContainerUpgrade.mock.calls.length).toBe(drawn);
  });

  it("cancelling the exit dialog while recording turns the microphone back on and the dictation continues", async () => {
    const fake = fakeBridge(data());
    fake.bridge.shutDownPageContainer.mockResolvedValue(false);
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Listening"));
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1));
    await vi.waitFor(() => expect(fake.bridge.audioControl.mock.calls.map((call) => call[0])).toEqual([true, false, true]));
    fake.audio();
    expect(FakeSocket.instances[0]?.sent.length).toBeGreaterThan(0);
    FakeSocket.instances[0]?.reply("Finding after staying");
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Finding after staying"));
  });

  it("regression: rebuilds the page after a reconnect even when nothing changed", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.reconnect();
    await vi.waitFor(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(2));
  });

  it("regression: a failed save of the severity is not an unhandled rejection", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.bridge.setLocalStorage.mockRejectedValue(new Error("storage full"));
    fake.emit(2);
    await sleep(20);
    expect(fake.bridge.setLocalStorage).toHaveBeenCalled();
  });
});

describe("fieldlog without a speech server", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const storedEntries = (fake: Fake): Array<{ text: string; attachment?: unknown }> => {
    const calls = fake.bridge.setLocalStorage.mock.calls;
    const last = calls[calls.length - 1]?.[1] ?? "{}";
    const saved = JSON.parse(last) as { inspections?: Array<{ entries: Array<{ text: string; attachment?: unknown }> }> };
    return saved.inspections?.[0]?.entries ?? [];
  };

  it("first run: a tap starts an inspection, the next picks and files a quick note", async () => {
    const fake = fakeBridge(null);
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("No entries yet."));
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("> OK"));
    fake.emit(2);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("> Damaged"));
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("next entry"));
    expect(lastBody(fake)).toContain("Damaged");
    expect(lastBody(fake)).not.toContain(">");
    await vi.waitFor(() => expect(storedEntries(fake).map((e) => e.text)).toEqual(["Damaged"]));
    // No server: the microphone is never touched.
    expect(fake.bridge.audioControl).not.toHaveBeenCalled();
  });

  it("cancel leaves the list without filing anything", async () => {
    const fake = fakeBridge(data(""));
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("> OK"));
    fake.emit(1);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("> Cancel"));
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("No entries yet."));
  });

  it("a photo with no entry yet becomes an entry of its own", async () => {
    const fake = fakeBridge(data(""));
    fake.bridge.captureImageFromCamera.mockResolvedValue({ base64: "AAAA", mimeType: "image/jpeg", size: 3 } as never);
    await boot(fake);
    fake.emit(9);
    await vi.waitFor(() => expect(storedEntries(fake)).toHaveLength(1));
    expect(storedEntries(fake)[0]!.text).toBe("Photo");
    expect(storedEntries(fake)[0]!.attachment).toBeDefined();
  });

  it("switches the glasses to German from the phone page", async () => {
    const fake = fakeBridge(data(""));
    const root = await boot(fake);
    await vi.waitFor(() => expect(lastBody(fake) || "No entries yet.").toContain("No entries yet."));
    root.get("#language").value = "de";
    root.get("#language").fire("change");
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Noch keine Einträge."));
    expect(root.innerHTML).toContain("Rundgang läuft");
  });

  it("an unreachable speech server says what to do", async () => {
    vi.stubGlobal("WebSocket", class { constructor() { throw new Error("blocked"); } });
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Speech server not reachable."));
    expect(lastBody(fake)).toContain("(Advanced)");
  });
});

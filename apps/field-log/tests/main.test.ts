import { resetGestureDedupe } from "../src/input/gestures";
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
    audio: (bytes = 32) => handler?.({ audioEvent: { audioPcm: new Uint8Array(bytes) } }),
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
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

function lastFooter(fake: Fake): string {
  const calls = fake.bridge.textContainerUpgrade.mock.calls
    .map((call) => (call as unknown as [{ containerID?: number; content?: string }])[0])
    .filter((upgrade) => upgrade.containerID === 3);
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

/** A Whisper server behind the fetch mock: answers each upload with `text`, or hangs/fails on request. */
function fakeWhisper() {
  const state = { text: "Window seal damaged", fail: false, hold: null as null | ((value: Response) => void), uploads: [] as Array<{ url: string; init: RequestInit }> };
  const fetchMock = vi.fn((url: string, init: RequestInit = {}): Promise<Response> => {
    state.uploads.push({ url, init });
    if (state.fail) return Promise.reject(new TypeError("Failed to fetch"));
    const answer = new Response(JSON.stringify({ text: state.text }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (state.hold === null) return Promise.resolve(answer);
    return new Promise<Response>((resolve) => { state.hold = resolve; });
  });
  return { state, fetchMock };
}

function data(sttUrl = "https://whisper.test:8457") {
  return {
    inspections: [{ id: "i1", title: "Flat 3", startedAt: Date.now(), finishedAt: null, entries: [], section: "Kitchen" }],
    activeId: "i1",
    sttUrl,
    language: "en",
    severity: "note",
    invertScroll: false,
  };
}

/** About one second of audio, enough to count as speech. */
const SECOND_OF_AUDIO = 32_000;

describe("fieldlog dictation over HTTP", () => {
  let whisper: ReturnType<typeof fakeWhisper>;
  beforeEach(() => {
    resetGestureDedupe();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    whisper = fakeWhisper();
    vi.stubGlobal("fetch", whisper.fetchMock);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("tap records, tap stops: one WAV form post without own headers, the text comes back for review", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Listening"));
    fake.audio(SECOND_OF_AUDIO);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Window seal damaged"));
    expect(whisper.state.uploads).toHaveLength(1);
    const upload = whisper.state.uploads[0]!;
    expect(upload.url).toBe("https://whisper.test:8457/v1/audio/transcriptions");
    // No header of our own: a simple request, no CORS preflight.
    expect(upload.init.headers).toBeUndefined();
    const form = upload.init.body as FormData;
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(form.get("language")).toBe("en");
    // The microphone went off at the tap.
    expect(fake.bridge.audioControl.mock.calls.map((call) => call[0])).toEqual([true, false]);
  });

  it("a mis-tap with almost no audio sends nothing and says so", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Listening"));
    fake.audio(100);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Nothing understood"));
    expect(whisper.state.uploads).toHaveLength(0);
  });

  it("regression: a refused microphone is said on the glasses", async () => {
    const fake = fakeBridge(data());
    fake.bridge.audioControl.mockResolvedValue(false);
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Microphone not allowed."));
  });

  it("an unreachable speech server says what to do, and the next tap tries again", async () => {
    whisper.state.fail = true;
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Listening"));
    fake.audio(SECOND_OF_AUDIO);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Speech server not reachable."));
    expect(lastBody(fake)).toContain("(Advanced)");
    whisper.state.fail = false;
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Listening"));
  });

  it("the recording stops by itself after 30 s and is sent", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    vi.useFakeTimers();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    fake.audio(SECOND_OF_AUDIO);
    await vi.advanceTimersByTimeAsync(31_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Window seal damaged"));
    expect(fake.bridge.audioControl.mock.calls.map((call) => call[0])).toEqual([true, false]);
  });

  it("one swipe does not discard the text under review; a second swipe does", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Listening"));
    fake.audio(SECOND_OF_AUDIO);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Window seal damaged"));
    fake.emit(2);
    await vi.waitFor(() => expect(lastFooter(fake)).toContain("swipe again"));
    expect(lastBody(fake)).toContain("Window seal damaged");
    fake.emit(1);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("No entries yet."));
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
    await sleep(200);
    const drawn = fake.bridge.textContainerUpgrade.mock.calls.length;
    fake.emit(0);
    await sleep(30);
    // Off once, for the dialog; a tap after leaving opens nothing.
    expect(fake.bridge.audioControl.mock.calls.map((call) => call[0])).toEqual([true, false]);
    expect(fake.bridge.textContainerUpgrade.mock.calls.length).toBe(drawn);
    expect(whisper.state.uploads).toHaveLength(0);
  });

  it("cancelling the exit dialog while recording turns the microphone back on and the dictation continues", async () => {
    const fake = fakeBridge(data());
    fake.bridge.shutDownPageContainer.mockResolvedValue(false);
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Listening"));
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.audioControl.mock.calls.map((call) => call[0])).toEqual([true, false, true]));
    fake.audio(SECOND_OF_AUDIO);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Window seal damaged"));
  });

  it("regression: gestures work while the first page is still being created", async () => {
    const fake = fakeBridge(data());
    fake.bridge.createStartUpPageContainer.mockImplementation(() => new Promise(() => undefined));
    const root = fakeRoot();
    vi.stubGlobal("document", { getElementById: () => root });
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("navigator", { language: "en-US" });
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1));
  });

  it("regression: rebuilds the page after a reconnect even when nothing changed", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.reconnect();
    // One creation per run (after one first rebuild call); the page comes back by rebuild.
    await vi.waitFor(() => expect(fake.bridge.rebuildPageContainer).toHaveBeenCalledTimes(2));
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
  });

  it("leaving through the system drops a dictation and closes the microphone; coming back rebuilds", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Listening"));
    fake.audio(SECOND_OF_AUDIO);
    fake.emit(5);
    await sleep(20);
    expect(fake.bridge.audioControl.mock.calls.map((call) => call[0])).toEqual([true, false]);
    fake.emit(4);
    await vi.waitFor(() => expect(fake.bridge.rebuildPageContainer).toHaveBeenCalledTimes(2));
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
    const rebuilt = (fake.bridge.rebuildPageContainer.mock.calls.at(-1) as unknown as [{ textObject?: Array<{ containerID?: number; content?: string }> }])[0];
    expect(rebuilt.textObject?.find((text) => text.containerID === 2)?.content).toContain("No entries yet.");
    expect(whisper.state.uploads).toHaveLength(0);
  });

  it("a system exit closes the microphone for good", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Listening"));
    fake.emit(7);
    await sleep(20);
    expect(fake.bridge.audioControl.mock.calls.map((call) => call[0])).toEqual([true, false]);
    fake.emit(0);
    await sleep(20);
    expect(fake.bridge.audioControl.mock.calls.map((call) => call[0])).toEqual([true, false]);
  });

  it("regression: a failed save of the severity is not an unhandled rejection", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.bridge.setLocalStorage.mockRejectedValue(new Error("storage full"));
    fake.emit(2);
    await sleep(20);
    expect(fake.bridge.setLocalStorage).toHaveBeenCalled();
  });

  it("a stored ws:// address from 0.4 is dropped: no dictation without a server", async () => {
    const fake = fakeBridge(data("wss://asr.test/ws"));
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("> OK"));
    expect(fake.bridge.audioControl).not.toHaveBeenCalled();
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

  it("a cancelled or refused camera is said on the glasses", async () => {
    const fake = fakeBridge(data(""));
    await boot(fake);
    fake.emit(9);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("No photo"));
  });
});

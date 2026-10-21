import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRoot, type FakeRoot } from "./fake-dom";
import { FakeSocket } from "./fake-socket";

// Boots the real app against a fake bridge, so the lifecycle can be checked without hardware.
const harness = vi.hoisted(() => ({
  bridge: null as unknown,
  /** Every cockpit model the app drew, in order. */
  models: [] as Array<{ headline: string[]; cells: Array<{ label: string; value: string }>; hint: string; caption: string }>,
}));
vi.mock("../src/cockpit/compose", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/cockpit/compose")>();
  return {
    ...real,
    composeCockpit: (model: (typeof harness.models)[number], backend: never) => {
      harness.models.push(model);
      return (real.composeCockpit as (m: unknown, b: unknown) => unknown)(model, backend);
    },
  };
});
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
  /** What the glasses show as text, kept like the real containers keep it. */
  const screen = { kind: "none" as "none" | "text" | "cockpit", header: "", body: "", footer: "" };
  const remember = (page: unknown): void => {
    const shape = page as { textObject?: Array<{ containerID?: number; content?: string }>; imageObject?: unknown[] };
    if ((shape.imageObject?.length ?? 0) > 0) { screen.kind = "cockpit"; return; }
    screen.kind = "text";
    for (const text of shape.textObject ?? []) {
      if (text.containerID === 1) screen.header = text.content ?? "";
      if (text.containerID === 2) screen.body = text.content ?? "";
      if (text.containerID === 3) screen.footer = text.content ?? "";
    }
  };
  const bridge = {
    getLocalStorage: vi.fn(async (key: string) => storage.get(key) ?? ""),
    setLocalStorage: vi.fn(async (key: string, value: string) => { storage.set(key, value); return true; }),
    rebuildPageContainer: vi.fn(async (page?: unknown) => { remember(page); return true; }),
    createStartUpPageContainer: vi.fn(async (page?: unknown): Promise<number> => { remember(page); return 0; }),
    textContainerUpgrade: vi.fn(async (upgrade?: { containerID?: number; content?: string }) => {
      if (upgrade?.containerID === 1) screen.header = upgrade.content ?? "";
      if (upgrade?.containerID === 2) screen.body = upgrade.content ?? "";
      if (upgrade?.containerID === 3) screen.footer = upgrade.content ?? "";
      return true;
    }),
    updateImageRawData: vi.fn(async () => "success"),
    shutDownPageContainer: vi.fn(async () => true),
    audioControl: vi.fn(async (_on: boolean, _source?: unknown): Promise<boolean> => true),
    captureImageFromCamera: vi.fn(async () => null),
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: (callback: (status: unknown) => void) => { statusHandler = callback; return () => undefined; },
  };
  return {
    bridge,
    screen,
    reconnect: () => statusHandler?.({ connectType: "connected" }),
    audio: (bytes = 32) => handler?.({ audioEvent: { audioPcm: new Uint8Array(bytes) } }),
    menu: (itemID: number) => handler?.({ menuItemClickEvent: { itemID } }),
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
    ready: () => handler !== undefined,
  };
}

type Fake = ReturnType<typeof fakeBridge>;

function lastBody(fake: Fake): string { return fake.screen.body; }
function lastFooter(fake: Fake): string { return fake.screen.footer; }
function lastHeader(fake: Fake): string { return fake.screen.header; }
/** The cockpit's headline and one cell, as last drawn. */
function headline(fake: Fake): string { void fake; return harness.models.at(-1)?.headline[0] ?? ""; }
function cell(label: string): string { return harness.models.at(-1)?.cells.find((c) => c.label === label)?.value ?? ""; }
/** The entries last saved to the phone's storage. */
function storedEntries(fake: Fake): Array<{ text: string; attachment?: unknown }> {
  const calls = fake.bridge.setLocalStorage.mock.calls.filter((call) => call[0] === KEY);
  const last = calls[calls.length - 1]?.[1] ?? "{}";
  const saved = JSON.parse(last) as { inspections?: Array<{ entries: Array<{ text: string; attachment?: unknown }> }> };
  return saved.inspections?.[0]?.entries ?? [];
}

/** Every app booted in the current test; ended afterwards so its clock cannot write into the next test. */
const booted: Fake[] = [];
function endBooted(): void {
  for (const fake of booted.splice(0)) fake.emit(7);
}

async function boot(fake: Fake): Promise<FakeRoot> {
  booted.push(fake);
  const root = fakeRoot();
  vi.stubGlobal("document", { getElementById: () => root });
  vi.stubGlobal("location", { search: "" });
  // The app follows the device language; these tests read the English copy.
  vi.stubGlobal("navigator", { language: "en-US" });
  harness.bridge = fake.bridge;
  harness.models.length = 0;
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
  afterEach(() => { endBooted(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("tap records, tap stops: one WAV form post without own headers, the text comes back for review", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(headline(fake)).toMatch(/^RECORDING/));
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
    await vi.waitFor(() => expect(headline(fake)).toMatch(/^RECORDING/));
    fake.audio(100);
    fake.emit(0);
    await vi.waitFor(() => expect(headline(fake)).toBe("NOTHING HEARD"));
    expect(whisper.state.uploads).toHaveLength(0);
  });

  it("regression: a refused microphone is said on the glasses", async () => {
    const fake = fakeBridge(data());
    fake.bridge.audioControl.mockResolvedValue(false);
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(headline(fake)).toBe("MIC BLOCKED"));
  });

  it("an unreachable speech server says what to do, and the next tap tries again", async () => {
    whisper.state.fail = true;
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(headline(fake)).toMatch(/^RECORDING/));
    fake.audio(SECOND_OF_AUDIO);
    fake.emit(0);
    await vi.waitFor(() => expect(headline(fake)).toBe("SERVER ERROR"));
    expect(cell("SYNC")).toBe("Error");
    whisper.state.fail = false;
    fake.emit(0);
    await vi.waitFor(() => expect(headline(fake)).toMatch(/^RECORDING/));
  });

  it("the recording stops by itself after the 10 min safety cap and is sent", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    vi.useFakeTimers();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    fake.audio(SECOND_OF_AUDIO);
    await vi.advanceTimersByTimeAsync(601_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Window seal damaged"));
    expect(fake.bridge.audioControl.mock.calls.map((call) => call[0])).toEqual([true, false]);
  });

  async function toReview(fake: Fake): Promise<void> {
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(headline(fake)).toMatch(/^RECORDING/));
    fake.audio(SECOND_OF_AUDIO);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Window seal damaged"));
  }

  it("QIS v1: a swipe under review only moves between Keep, Keep + photo and Discard, however often", async () => {
    const fake = fakeBridge(data());
    await toReview(fake);
    for (const swipe of [2, 1, 2, 1, 2, 1]) { fake.emit(swipe); await sleep(30); }
    expect(lastBody(fake)).toContain("Window seal damaged");
    expect(lastBody(fake)).toContain("● Keep\n");
    fake.emit(2);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("● Keep + photo"));
    fake.emit(2);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("● Discard"));
    expect(lastBody(fake)).toContain("Window seal damaged");
    expect(fake.bridge.captureImageFromCamera).not.toHaveBeenCalled();
  });

  it("QIS v1.2: Keep + photo files the text first, then opens the camera (the shutter confirms)", async () => {
    const fake = fakeBridge(data());
    fake.bridge.captureImageFromCamera.mockResolvedValue({ base64: "AAAA", mimeType: "image/jpeg", size: 3 } as never);
    await toReview(fake);
    fake.emit(2);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("● Keep + photo"));
    expect(fake.bridge.captureImageFromCamera).not.toHaveBeenCalled();
    fake.emit(0);
    await vi.waitFor(() => expect(fake.bridge.captureImageFromCamera).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(storedEntries(fake)[0]?.attachment).toBeDefined());
    expect(storedEntries(fake).map((entry) => entry.text)).toEqual(["Window seal damaged"]);
    // Back on the recorder, ready for the next note.
    await vi.waitFor(() => expect(headline(fake)).toBe("READY"));
  });

  it("Keep + photo with a cancelled camera is said on the recorder: NO PHOTO", async () => {
    const fake = fakeBridge(data());
    await toReview(fake);
    fake.emit(2);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("● Keep + photo"));
    fake.emit(0);
    await vi.waitFor(() => expect(headline(fake)).toBe("NO PHOTO"));
    expect(storedEntries(fake).map((entry) => entry.text)).toEqual(["Window seal damaged"]);
  });

  it("the hold never does anything: not under review, not on the lists (it never reaches the app on the glasses)", async () => {
    const fake = fakeBridge(data());
    await toReview(fake);
    fake.emit(9);
    await sleep(40);
    expect(lastBody(fake)).toContain("● Keep\n");
    expect(fake.bridge.captureImageFromCamera).not.toHaveBeenCalled();
  });

  it("QIS v1: Discard is armed by one tap and carried out by a second single tap", async () => {
    const fake = fakeBridge(data());
    await toReview(fake);
    fake.emit(1); // choice: Discard (the list wraps)
    await vi.waitFor(() => expect(lastBody(fake)).toContain("● Discard"));
    fake.emit(0);
    await vi.waitFor(() => expect(lastFooter(fake)).toBe("Tap again = discard text · Swipe/2× = cancel"));
    expect(lastBody(fake)).toContain("Window seal damaged");
    fake.emit(0);
    await vi.waitFor(() => expect(headline(fake)).toBe("READY"));
    expect(storedEntries(fake)).toEqual([]);
  });

  it("QIS v1: a swipe, 2× or the timeout cancel an armed discard", async () => {
    const fake = fakeBridge(data());
    await toReview(fake);
    fake.emit(1);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("● Discard"));
    fake.emit(0);
    await vi.waitFor(() => expect(lastFooter(fake)).toContain("Tap again"));
    fake.emit(1); // swipe back to Keep + photo: cancels
    await vi.waitFor(() => expect(lastFooter(fake)).toBe("Tap = keep + photo · Swipe = choice"));
    fake.emit(2);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("● Discard"));
    fake.emit(0);
    await vi.waitFor(() => expect(lastFooter(fake)).toContain("Tap again"));
    fake.emit(3); // 2x: cancels, does not leave and does not discard
    await vi.waitFor(() => expect(lastFooter(fake)).toBe("Tap = discard · Swipe = choice"));
    expect(fake.bridge.shutDownPageContainer).not.toHaveBeenCalled();
    expect(lastBody(fake)).toContain("Window seal damaged");
    // A second tap right after the cancel arms again instead of discarding.
    fake.emit(0);
    await vi.waitFor(() => expect(lastFooter(fake)).toContain("Tap again"));
    expect(lastBody(fake)).toContain("Window seal damaged");
  });

  it("QIS v1: tapping Keep files the text; 2× under review neither leaves nor discards", async () => {
    const fake = fakeBridge(data());
    await toReview(fake);
    fake.emit(3);
    await sleep(40);
    expect(fake.bridge.shutDownPageContainer).not.toHaveBeenCalled();
    expect(lastBody(fake)).toContain("Window seal damaged");
    fake.emit(0);
    await vi.waitFor(() => expect(storedEntries(fake).map((entry) => entry.text)).toEqual(["Window seal damaged"]));
    await vi.waitFor(() => expect(headline(fake)).toBe("READY"));
  });

  it("QUS v1: the start page is a list of at most three entries, a dot on the selection, no help page", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    await vi.waitFor(() => expect(lastBody(fake)).toBe("● Record\n  Type · note"));
    expect(lastHeader(fake)).toBe("FIELDLOG · ● live");
    expect(lastFooter(fake)).toBe("Tap = record · Swipe = choose · 2× = exit");
    fake.emit(2);
    await vi.waitFor(() => expect(lastBody(fake)).toBe("  Record\n● Type · note"));
    expect(lastFooter(fake)).toBe("Tap = change type · Swipe = choose · 2× = exit");
    expect(lastBody(fake).split("\n").length).toBeLessThanOrEqual(3);
    expect(lastBody(fake) + lastFooter(fake)).not.toMatch(/help/i);
  });

  it("the type row sets the type of the next entry with a tap and saves it (a swipe only moves)", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(2);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("● Type · note"));
    const saved = fake.bridge.setLocalStorage.mock.calls.length;
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("● Type · minor"));
    await vi.waitFor(() => expect(fake.bridge.setLocalStorage.mock.calls.length).toBeGreaterThan(saved));
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("● Type · MAJOR"));
  });

  it("notes: the list (newest first, a dot), a tap opens the reading view, 2× goes back step by step, 2× at the start asks to exit", async () => {
    const fake = fakeBridge({
      ...data(),
      inspections: [{ id: "i1", title: "Flat 3", startedAt: 1, finishedAt: null, section: "", entries: [
        { id: "e1", text: "Old crack", severity: "note", at: new Date(2026, 9, 17, 9, 5).getTime() },
        { id: "e2", text: "Lamp flickers above the desk", severity: "major", at: new Date(2026, 9, 17, 9, 40).getTime() },
      ] }],
    });
    await boot(fake);
    await vi.waitFor(() => expect(lastBody(fake)).toBe("● Record\n  Notes · 2\n  Type · note"));
    fake.emit(2);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("● Notes · 2"));
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toBe("● 09:40 ! Lamp flickers above the desk\n  09:05 Old crack"));
    expect(lastHeader(fake)).toBe("Notes · ● live");
    fake.emit(2);
    await vi.waitFor(() => expect(lastBody(fake)).toBe("  09:40 ! Lamp flickers above the desk\n● 09:05 Old crack"));
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toBe("Old crack"));
    expect(lastHeader(fake)).toBe("Note 2/2 · 09:05 · note");
    fake.emit(0); // next note, wrapping round
    await vi.waitFor(() => expect(lastBody(fake)).toBe("Lamp flickers above the desk"));
    expect(lastHeader(fake)).toBe("Note 1/2 · 09:40 · MAJOR");
    fake.emit(3);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("09:05 Old crack"));
    fake.emit(3);
    await vi.waitFor(() => expect(lastBody(fake)).toBe("  Record\n● Notes · 2\n  Type · note"));
    expect(fake.bridge.shutDownPageContainer).not.toHaveBeenCalled();
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1));
  });

  it("recording is the cockpit image: four tiles go out, the headline counts, the notes stay text", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(headline(fake)).toMatch(/^RECORDING/));
    await vi.waitFor(() => expect(fake.bridge.updateImageRawData.mock.calls.length).toBeGreaterThanOrEqual(4));
    const ids = fake.bridge.updateImageRawData.mock.calls.map((call) => (call as unknown as [{ containerID: number }])[0].containerID);
    expect([...new Set(ids)].sort()).toEqual([21, 22, 23, 24]);
    expect(fake.screen.kind).toBe("cockpit");
    expect(cell("SYNC")).toBe("Server");
    expect(harness.models.at(-1)?.hint).toBe("Tap = done");
    fake.audio(SECOND_OF_AUDIO);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Window seal damaged"));
    expect(fake.screen.kind).toBe("text");
  });

  it("after a note the recorder waits as READY: a tap records again, 2× goes back to the start list", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(headline(fake)).toMatch(/^RECORDING/));
    fake.audio(100);
    fake.emit(0);
    await vi.waitFor(() => expect(headline(fake)).toBe("NOTHING HEARD"));
    fake.emit(0);
    await vi.waitFor(() => expect(headline(fake)).toMatch(/^RECORDING/));
    fake.audio(100);
    fake.emit(0);
    await vi.waitFor(() => expect(headline(fake)).toBe("NOTHING HEARD"));
    fake.emit(3);
    await vi.waitFor(() => expect(lastBody(fake)).toBe("● Record\n  Type · note"));
    expect(lastHeader(fake)).toBe("FIELDLOG · ● live");
    expect(fake.bridge.shutDownPageContainer).not.toHaveBeenCalled();
  });

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(2); await sleep(40); // a swipe rebuilds nothing, but every page built so far must be menu-free
    const pages = [
      ...(fake.bridge.createStartUpPageContainer.mock.calls as unknown as unknown[][]),
      ...(fake.bridge.rebuildPageContainer.mock.calls as unknown as unknown[][]),
    ].map((call) => call[0] as { menuObject?: unknown });
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) expect(page.menuObject).toBeUndefined();
  });

  it("QIS v1: 2× during a recording does nothing; the recording is stopped by a tap", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(headline(fake)).toMatch(/^RECORDING/));
    fake.emit(3);
    await sleep(60);
    expect(fake.bridge.shutDownPageContainer).not.toHaveBeenCalled();
    expect(fake.bridge.audioControl.mock.calls.map((call) => call[0])).toEqual([true]);
    expect(headline(fake)).toMatch(/^RECORDING/);
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

  it("no timer, poll or stream draws while the exit dialog may be on screen; a single 2x right after restores the page first and asks the dialog only then", async () => {
    const fake = fakeBridge(data());
    // The call resolves true as soon as the dialog is SHOWN, whatever the user answers later.
    fake.bridge.shutDownPageContainer.mockResolvedValue(true);
    await boot(fake);
    await vi.waitFor(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1));
    await sleep(50); // the first page is up
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(1));
    const pageCalls = (): number => ["createStartUpPageContainer", "rebuildPageContainer", "textContainerUpgrade", "updateImageRawData"].reduce((sum, name) => sum + ((fake.bridge as unknown as Record<string, { mock?: { calls: unknown[] } } | undefined>)[name]?.mock?.calls.length ?? 0), 0);
    const callsAtAsk = pageCalls();
    await new Promise((done) => setTimeout(done, 1500));
    // Timers, polls and streams keep collecting data but make no page call while the dialog may be on screen.
    expect(pageCalls()).toBe(callsAtAsk);
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
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
    await new Promise((done) => setTimeout(done, 500));
    expect(order).toEqual(["create:start"]); // the dialog is not asked while the page is still being created
    releaseCreate();
    await new Promise((done) => setTimeout(done, 1500));
    expect(order).toEqual(["create:start", "create:done", "shutdown"]); // restore first, then the dialog, exactly once more
  });

  it("hardware order (step log): 4 = dialog up -> nothing drawn; 5 = dialog gone after No -> page up again without a gesture, nothing paused, next 2x asks", async () => {
    const fake = fakeBridge(data());
    fake.bridge.shutDownPageContainer.mockResolvedValue(true);
    await boot(fake);
    await vi.waitFor(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1));
    await sleep(50);
    const pageCalls = (): number => ["createStartUpPageContainer", "rebuildPageContainer", "textContainerUpgrade", "updateImageRawData"].reduce((sum, name) => sum + ((fake.bridge as unknown as Record<string, { mock?: { calls: unknown[] } } | undefined>)[name]?.mock?.calls.length ?? 0), 0);
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(1));
    fake.emit(4); // the dialog is on screen
    const atShown = pageCalls();
    await sleep(1500);
    expect(pageCalls()).toBe(atShown); // nothing drawn over the dialog
    fake.emit(5); // "No": the dialog is gone
    await vi.waitFor(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(2)); // page created again, no gesture needed
    await sleep(100);
    // Nothing was paused: a swipe is handled and drawn at once.
    const afterRestore = pageCalls();
    fake.emit(2);
    await vi.waitFor(() => expect(pageCalls()).toBeGreaterThan(afterRestore));
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(2)); // the very first 2x opens the dialog again
  });

  it("a 2x on the resting screen while the app thinks it is in the background (real 5, no dialog) comes back and asks the dialog, never swallowed", async () => {
    const fake = fakeBridge(data());
    fake.bridge.shutDownPageContainer.mockResolvedValue(true);
    await boot(fake);
    await vi.waitFor(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1));
    await sleep(50);
    fake.emit(5); // genuinely backgrounded: paused
    await sleep(50);
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.rebuildPageContainer).toHaveBeenCalled()); // restore draw first
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1));
    expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(1);
  });

  it("leaving at the resting screen asks the system dialog; resolving true does not close the app, a tap still works", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1));
    await sleep(100);
    fake.emit(0);
    await vi.waitFor(() => expect(fake.bridge.audioControl).toHaveBeenCalled());
  });

  it("leaving at the resting screen asks the system dialog and draws nothing more after the system ends the app (sysEvent 7)", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1));
    await sleep(200);
    fake.emit(7);
    await sleep(30);
    const drawn = fake.bridge.textContainerUpgrade.mock.calls.length;
    fake.emit(0);
    await sleep(30);
    // A tap after leaving opens nothing.
    expect(fake.bridge.audioControl).not.toHaveBeenCalled();
    expect(fake.bridge.textContainerUpgrade.mock.calls.length).toBe(drawn);
    expect(whisper.state.uploads).toHaveLength(0);
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
    await vi.waitFor(() => expect(headline(fake)).toMatch(/^RECORDING/));
    fake.audio(SECOND_OF_AUDIO);
    fake.emit(5);
    await sleep(20);
    expect(fake.bridge.audioControl.mock.calls.map((call) => call[0])).toEqual([true, false]);
    fake.emit(4);
    // Rebuilds so far: the one before the first page, the switch to the recorder's cockpit, and this one.
    await vi.waitFor(() => expect(fake.bridge.rebuildPageContainer).toHaveBeenCalledTimes(3));
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
    const rebuilt = (fake.bridge.rebuildPageContainer.mock.calls.at(-1) as unknown as [{ textObject?: Array<{ containerID?: number; content?: string }> }])[0];
    // The recorder was on screen: the rebuilt page is the cockpit (four image tiles), not a text page.
    expect((rebuilt as unknown as { imageObject?: unknown[] }).imageObject).toHaveLength(4);
    expect(rebuilt.textObject?.map((text) => text.containerID)).toEqual([20]);
    expect(whisper.state.uploads).toHaveLength(0);
  });

  it("a system exit closes the microphone for good", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(headline(fake)).toMatch(/^RECORDING/));
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
    fake.emit(2); // to the type row
    await sleep(20);
    fake.emit(0); // sets the next type: saved, and the save fails
    await sleep(20);
    expect(fake.bridge.setLocalStorage).toHaveBeenCalled();
  });

  it("a stored ws:// address from 0.4 is dropped: no dictation without a server", async () => {
    const fake = fakeBridge(data("wss://asr.test/ws"));
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("● OK"));
    expect(fake.bridge.audioControl).not.toHaveBeenCalled();
  });
});

describe("fieldlog live dictation", () => {
  let whisper: ReturnType<typeof fakeWhisper>;
  beforeEach(() => {
    resetGestureDedupe();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    whisper = fakeWhisper();
    vi.stubGlobal("fetch", whisper.fetchMock);
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubEnv("VITE_LIVE_STT_URL", "wss://live.test:8449");
    FakeSocket.last = null;
  });
  afterEach(() => { endBooted(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const startRecording = async (fake: Fake): Promise<FakeSocket> => {
    fake.emit(0);
    await vi.waitFor(() => expect(headline(fake)).toMatch(/^RECORDING/));
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());
    return FakeSocket.last!;
  };

  it("the cockpit says Live while words arrive; the live transcript is the entry, no upload", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    const socket = await startRecording(fake);
    expect(socket.url).toBe("wss://live.test:8449");
    fake.audio(SECOND_OF_AUDIO);
    socket.open();
    // Audio from before the open is not lost: it goes right after the start frame.
    expect(JSON.parse(socket.sent[0] as string)).toMatchObject({ type: "start", language: "en", stream: true });
    expect((socket.sent[1] as Uint8Array).length).toBe(SECOND_OF_AUDIO);
    socket.reply({ type: "final", text: "Window seal cracked.", final: true });
    socket.reply({ type: "partial", text: "Lamp flickers", final: false });
    await vi.waitFor(() => expect(cell("SYNC")).toBe("Live"));
    fake.emit(0);
    await vi.waitFor(() => expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({ type: "stop" }));
    socket.reply({ type: "final", text: "Lamp flickers above desk.", final: true });
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Window seal cracked. Lamp flickers above desk."));
    expect(whisper.state.uploads).toHaveLength(0);
  });

  it("a live server that never answers: the whole recording goes as a file", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    await startRecording(fake);
    fake.audio(SECOND_OF_AUDIO);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Window seal damaged"));
    expect(whisper.state.uploads).toHaveLength(1);
    const file = (whisper.state.uploads[0]!.init.body as FormData).get("file") as Blob;
    expect(file.size).toBe(44 + SECOND_OF_AUDIO);
  });

  it("a drop keeps the committed words and sends only the rest as a file", async () => {
    whisper.state.text = "and the rest";
    const fake = fakeBridge(data());
    await boot(fake);
    const socket = await startRecording(fake);
    socket.open();
    for (let i = 0; i < 3; i += 1) fake.audio(SECOND_OF_AUDIO);
    socket.reply({ type: "final", text: "First part.", final: true });
    socket.reply({ type: "partial", text: "half", final: false });
    for (let i = 0; i < 2; i += 1) fake.audio(SECOND_OF_AUDIO);
    socket.drop();
    await vi.waitFor(() => expect(cell("SYNC")).toBe("File"));
    fake.audio(SECOND_OF_AUDIO);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("First part. and the rest"));
    const file = (whisper.state.uploads[0]!.init.body as FormData).get("file") as Blob;
    // From one second before the final (3 s) to the end (6 s): 4 s of audio.
    expect(file.size).toBe(44 + 4 * SECOND_OF_AUDIO);
  });

  it("a long recording without live text sends its last 30 s and says so", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    await startRecording(fake);
    for (let i = 0; i < 40; i += 1) fake.audio(SECOND_OF_AUDIO);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Window seal damaged"));
    expect(lastHeader(fake)).toContain("last 30 s only");
    const file = (whisper.state.uploads[0]!.init.body as FormData).get("file") as Blob;
    expect(file.size).toBe(44 + 16_000 * 2 * 31);
  });

  it("leaving through the system closes the live socket too", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    const socket = await startRecording(fake);
    socket.open();
    fake.emit(5);
    await sleep(20);
    expect(socket.closed).toBe(true);
    expect(whisper.state.uploads).toHaveLength(0);
  });
});

describe("fieldlog without a speech server", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("first run: a tap on Quick note starts an inspection and opens the list, the next tap files a quick note", async () => {
    const fake = fakeBridge(null);
    await boot(fake);
    await vi.waitFor(() => expect(lastBody(fake)).toBe("● Quick note\n  Type · note"));
    expect(lastHeader(fake)).toBe("FIELDLOG · local");
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("● OK"));
    expect(lastHeader(fake)).toBe("Quick note · note");
    fake.emit(2);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("● Damaged"));
    expect(lastBody(fake).split("\n").length).toBeLessThanOrEqual(5);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toBe("● Quick note\n  Notes · 1\n  Type · note"));
    await vi.waitFor(() => expect(storedEntries(fake).map((e) => e.text)).toEqual(["Damaged"]));
    // No server: the microphone is never touched.
    expect(fake.bridge.audioControl).not.toHaveBeenCalled();
  });

  it("cancel leaves the list without filing anything", async () => {
    const fake = fakeBridge(data(""));
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("● OK"));
    fake.emit(1);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("● Cancel"));
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toBe("● Quick note\n  Type · note"));
    expect(storedEntries(fake)).toEqual([]);
  });

  it("2× leaves the quick-note list for the start page, not the app", async () => {
    const fake = fakeBridge(data(""));
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("● OK"));
    fake.emit(3);
    await vi.waitFor(() => expect(lastBody(fake)).toBe("● Quick note\n  Type · note"));
    expect(fake.bridge.shutDownPageContainer).not.toHaveBeenCalled();
  });

  it("a photo from the phone page with no entry yet becomes an entry of its own", async () => {
    const fake = fakeBridge(data(""));
    fake.bridge.captureImageFromCamera.mockResolvedValue({ base64: "AAAA", mimeType: "image/jpeg", size: 3 } as never);
    const root = await boot(fake);
    root.get("#photo").fire("click");
    await vi.waitFor(() => expect(storedEntries(fake)).toHaveLength(1));
    expect(storedEntries(fake)[0]!.text).toBe("Photo");
    expect(storedEntries(fake)[0]!.attachment).toBeDefined();
  });

  it("switches the glasses to German from the phone page", async () => {
    const fake = fakeBridge(data(""));
    const root = await boot(fake);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Quick note"));
    root.get("#language").value = "de";
    root.get("#language").fire("change");
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Schnellnotiz"));
    expect(root.innerHTML).toContain("Rundgang läuft");
  });


});

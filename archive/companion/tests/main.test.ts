import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app against a fake bridge so the push-to-talk lifecycle can be checked without hardware.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; }
function deferred<T>(): Deferred<T> { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

// tsconfig carries no node types; reach the process object structurally.
const nodeProcess = (globalThis as unknown as { process: { on(event: string, listener: (reason: unknown) => void): void; off(event: string, listener: (reason: unknown) => void): void } }).process;

function fakeBridge() {
  let handler: ((event: unknown) => void) | undefined;
  const bridge = {
    audioControl: vi.fn(async (_on: boolean, _source?: unknown): Promise<boolean> => true),
    rebuildPageContainer: vi.fn(async () => true),
    createStartUpPageContainer: vi.fn(async () => 0),
    textContainerUpgrade: vi.fn(async () => true),
    shutDownPageContainer: vi.fn(async () => true),
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return { bridge, emit: (eventType: number) => handler?.({ sysEvent: { eventType, eventSource: 1 } }), audio: (bytes: number) => handler?.({ audioEvent: { audioPcm: new Uint8Array(bytes) } }), ready: () => handler !== undefined };
}

// The body container (id 2) carries the answer; textContainerUpgrade is called header, body, footer in order.
function lastBody(fake: ReturnType<typeof fakeBridge>): string { const bodies = fake.bridge.textContainerUpgrade.mock.calls.map((call) => (call as unknown as [{ containerID?: number; content?: string }])[0]).filter((upgrade) => upgrade.containerID === 2); return bodies[bodies.length - 1]?.content ?? ""; }
function lastHeader(fake: ReturnType<typeof fakeBridge>): string { const headers = fake.bridge.textContainerUpgrade.mock.calls.map((call) => (call as unknown as [{ containerID?: number; content?: string }])[0]).filter((upgrade) => upgrade.containerID === 1); return headers[headers.length - 1]?.content ?? ""; }

async function boot(fake: ReturnType<typeof fakeBridge>): Promise<void> {
  harness.bridge = fake.bridge;
  vi.resetModules();
  await import("../src/main");
  await vi.waitFor(() => expect(fake.ready()).toBe(true));
}

describe("companion push-to-talk", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("document", { querySelector: () => null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ answer: "ok" }), { status: 200 })));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("closes the microphone when the press is released before the mic finished opening", async () => {
    // Regression: release arrived while audioControl(true) was pending, stop() saw listening=false and
    // returned, then the mic opened and stayed on with nobody holding the button.
    const fake = fakeBridge();
    const opening = deferred<boolean>();
    fake.bridge.audioControl.mockImplementationOnce(() => opening.promise);
    await boot(fake);
    fake.emit(9); // long press
    fake.emit(10); // release, before the mic is open
    opening.resolve(true);
    await vi.waitFor(() => expect(fake.bridge.audioControl.mock.calls.map((call) => call[0])).toEqual([true, false]));
    // Nothing was recorded, so nothing may be sent — the user gets the "too short" hint instead.
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Too short"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not open the microphone twice on a repeated long press", async () => {
    const fake = fakeBridge();
    const opening = deferred<boolean>();
    fake.bridge.audioControl.mockImplementationOnce(() => opening.promise);
    await boot(fake);
    fake.emit(9);
    fake.emit(9);
    opening.resolve(true);
    await vi.waitFor(() => expect(fake.bridge.textContainerUpgrade).toHaveBeenCalled());
    expect(fake.bridge.audioControl.mock.calls.filter((call) => call[0] === true)).toHaveLength(1);
  });

  it("still shuts down on double tap when closing the mic fails", async () => {
    // Regression: a rejected audioControl(false) became an unhandled rejection (vitest fails the run on those).
    // A plain function, not a vi.fn result: vitest's spies attach handlers to returned promises, hiding the rejection.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    nodeProcess.on("unhandledRejection", onUnhandled);
    const fake = fakeBridge();
    await boot(fake);
    let failNext = true;
    const closeMic = fake.bridge.audioControl;
    (fake.bridge as { audioControl: unknown }).audioControl = (on: boolean): Promise<boolean> => { if (failNext) { failNext = false; return Promise.reject(new Error("ble gone")); } return closeMic(on); };
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it("does not send a very short press to the bridge and says why", async () => {
    // Regression: a tap-length press still posted an empty or near-empty recording to the bridge.
    const fake = fakeBridge();
    await boot(fake);
    fake.emit(9);
    await vi.waitFor(() => expect(fake.bridge.audioControl).toHaveBeenCalledWith(true, expect.anything()));
    await vi.waitFor(() => expect(lastHeader(fake)).toBe("COMPANION  MIC ON"));
    fake.audio(3200); // 0.1 s
    fake.emit(10);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Too short. Keep holding while you speak."));
    expect(fetch).not.toHaveBeenCalled();
    expect(lastHeader(fake)).toBe("COMPANION  PRIVATE");
  });

  it("sends a recording that is long enough", async () => {
    const fake = fakeBridge();
    await boot(fake);
    fake.emit(9);
    await vi.waitFor(() => expect(lastHeader(fake)).toBe("COMPANION  MIC ON"));
    fake.audio(16000); fake.audio(16000); // 1 s
    fake.emit(10);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    expect((init.body as ArrayBuffer).byteLength).toBe(32000);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("ok"));
  });

  it("stops recording by itself when the release never arrives", async () => {
    // A lost release event used to leave the mic open and the buffer growing without bound.
    const fake = fakeBridge();
    await boot(fake);
    fake.emit(9);
    await vi.waitFor(() => expect(lastHeader(fake)).toBe("COMPANION  MIC ON"));
    for (let second = 0; second < 60; second += 1) fake.audio(32000);
    await vi.waitFor(() => expect(fake.bridge.audioControl.mock.calls.map((call) => call[0])).toEqual([true, false]));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });

  it("localizes the glasses header", async () => {
    localStorage.setItem("quietglass.locale", "de");
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalled());
    const page = (fake.bridge.createStartUpPageContainer.mock.calls[0] as unknown as [{ textObject: Array<{ content?: string }> }])[0];
    expect(page.textObject[0]?.content).toBe("COMPANION  PRIVAT");
  });
});

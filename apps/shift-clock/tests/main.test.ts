import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRoot, type FakeRoot } from "./fake-dom";

// Boots the real app against a fake bridge, so the lifecycle can be checked without hardware.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const KEY = "quietglass.shiftclock.v1";

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
    updateImageRawData: vi.fn(async () => "success"),
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: (callback: (status: unknown) => void) => { statusHandler = callback; return () => undefined; },
  };
  return {
    bridge,
    reconnect: () => statusHandler?.({ connectType: "connected" }),
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

/** Enough of a canvas for the pixel icon to encode. */
function fakeCanvas() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({ imageSmoothingEnabled: false, fillStyle: "", fillRect: () => undefined }),
    toBlob: (done: (blob: Blob | null) => void) => done(new Blob([new Uint8Array(4)])),
  };
}

async function boot(fake: Fake): Promise<FakeRoot> {
  const root = fakeRoot();
  vi.stubGlobal("document", { getElementById: () => root, createElement: () => fakeCanvas() });
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

function stored(fake: Fake): { open: { project: string | null }; entries: unknown[] } {
  const calls = fake.bridge.setLocalStorage.mock.calls;
  return JSON.parse(String(calls[calls.length - 1]?.[1] ?? "{}"));
}

function data(open: { project: string | null; startedAt: number | null } = { project: null, startedAt: null }) {
  return { projects: ["Client A", "Client B"], entries: [], open, invertScroll: false };
}

describe("shiftclock lifecycle", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("regression: a failed shutdown on double tap is not an unhandled rejection", async () => {
    const fake = fakeBridge(data());
    fake.bridge.shutDownPageContainer.mockRejectedValue(new Error("already closed"));
    await boot(fake);
    fake.emit(3);
    fake.emit(3);
    await sleep(20);
    expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(1);
  });

  it("regression: the running entry is saved before the page is shut down", async () => {
    const fake = fakeBridge(data());
    const saving = deferred<boolean>();
    await boot(fake);
    fake.emit(0); // open the picker
    fake.emit(0); // start Client A
    await vi.waitFor(() => expect(stored(fake).open.project).toBe("Client A"));
    fake.bridge.setLocalStorage.mockImplementationOnce(() => saving.promise);
    fake.emit(3);
    await sleep(20);
    expect(fake.bridge.shutDownPageContainer).not.toHaveBeenCalled();
    saving.resolve(true);
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(1));
  });

  it("regression: a failed save is not an unhandled rejection", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.bridge.setLocalStorage.mockRejectedValue(new Error("storage full"));
    fake.emit(0);
    fake.emit(0);
    await sleep(20);
    expect(lastBody(fake)).toBe("0:00");
  });

  it("regression: stops redrawing the running clock once the app was closed", async () => {
    const fake = fakeBridge(data({ project: "Client A", startedAt: Date.now() - 60_000 }));
    await boot(fake);
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalled());
    const drawn = fake.bridge.textContainerUpgrade.mock.calls.length + fake.bridge.createStartUpPageContainer.mock.calls.length;
    await sleep(1300);
    expect(fake.bridge.textContainerUpgrade.mock.calls.length + fake.bridge.createStartUpPageContainer.mock.calls.length).toBe(drawn);
  });

  it("regression: the icon is sent with the page, not again on every clock tick", async () => {
    const fake = fakeBridge(data({ project: "Client A", startedAt: Date.now() - 60_000 }));
    await boot(fake);
    await sleep(2200);
    expect(fake.bridge.textContainerUpgrade.mock.calls.length).toBeGreaterThan(0);
    expect(fake.bridge.updateImageRawData).toHaveBeenCalledTimes(1);
  });

  it("regression: rebuilds the page after a reconnect even when nothing changed", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.reconnect();
    await vi.waitFor(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(2));
  });

  it("regression: does not create the page twice while a creation is in flight", async () => {
    const fake = fakeBridge(data({ project: "Client A", startedAt: Date.now() - 60_000 }));
    await boot(fake);
    const creating = deferred<number>();
    fake.bridge.createStartUpPageContainer.mockImplementationOnce(() => creating.promise);
    fake.reconnect();
    await vi.waitFor(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(2));
    await sleep(1200); // a clock tick lands while the page is still being built
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(2);
    creating.resolve(0);
  });
});

describe("shiftclock first run", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("with nothing stored, the first tap starts the default project", async () => {
    const fake = fakeBridge(null);
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(stored(fake).open.project).toBe("Work"));
  });

  it("with no project at all, a tap creates one and the next starts it", async () => {
    const fake = fakeBridge({ projects: [], entries: [], open: { project: null, startedAt: null }, invertScroll: false });
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect((stored(fake) as unknown as { projects: string[] }).projects).toEqual(["Work"]));
    fake.emit(0);
    await vi.waitFor(() => expect(stored(fake).open.project).toBe("Work"));
  });

  it("the picker can be left with Cancel without starting anything", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0); // open the picker on Client A
    fake.emit(1); // up wraps to Cancel
    await vi.waitFor(() => expect(lastBody(fake)).toContain("> Cancel"));
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toBe("stopped"));
    expect(stored(fake).open.project).toBeNull();
  });
});

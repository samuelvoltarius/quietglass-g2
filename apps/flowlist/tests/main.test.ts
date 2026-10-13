import { resetGestureDedupe } from "../src/input/gestures";
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

const KEY = "quietglass.flowlist.v1";

function fakeBridge(stored: Record<string, unknown> | null = null, storage = new Map<string, string>()) {
  let handler: ((event: unknown) => void) | undefined;
  let statusHandler: ((status: unknown) => void) | undefined;
  if (stored) storage.set(KEY, JSON.stringify(stored));
  const bridge = {
    getLocalStorage: vi.fn(async (key: string) => storage.get(key) ?? ""),
    setLocalStorage: vi.fn(async (key: string, value: string) => { storage.set(key, value); return true; }),
    rebuildPageContainer: vi.fn(async () => true),
    createStartUpPageContainer: vi.fn(async (): Promise<number> => 0),
    textContainerUpgrade: vi.fn(async () => true),
    shutDownPageContainer: vi.fn(async () => true),
    updateImageRawData: vi.fn(async (): Promise<unknown> => "success"),
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: (callback: (status: unknown) => void) => { statusHandler = callback; return () => undefined; },
  };
  return {
    bridge,
    reconnect: () => statusHandler?.({ connectType: "connected" }),
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
    ready: () => handler !== undefined,
    storage,
  };
}

type Fake = ReturnType<typeof fakeBridge>;

/** Every body the glasses were sent, newest last — from page creation and from upgrades. */
function bodies(fake: Fake): string[] {
  const out: string[] = [];
  for (const call of fake.bridge.createStartUpPageContainer.mock.calls) {
    const page = (call as unknown as [{ textObject?: Array<{ containerID?: number; content?: string }> }])[0];
    const body = page.textObject?.find((t) => t.containerID === 2)?.content;
    if (body !== undefined) out.push(body);
  }
  for (const call of fake.bridge.textContainerUpgrade.mock.calls) {
    const upgrade = (call as unknown as [{ containerID?: number; content?: string }])[0];
    if (upgrade.containerID === 2) out.push(upgrade.content ?? "");
  }
  return out;
}

function lastBody(fake: Fake): string {
  const calls = fake.bridge.textContainerUpgrade.mock.calls
    .map((call) => (call as unknown as [{ containerID?: number; content?: string }])[0])
    .filter((upgrade) => upgrade.containerID === 2);
  return calls[calls.length - 1]?.content ?? "";
}

/** Enough of a canvas for the progress bar to encode. */
function fakeCanvas() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      imageSmoothingEnabled: false, fillStyle: "", font: "", textBaseline: "", fillRect: () => undefined, fillText: () => undefined,
      measureText: (text: string) => ({ width: text.length * 20 }),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    }),
    toBlob: (done: (blob: Blob | null) => void) => done(new Blob([new Uint8Array(4)])),
  };
}

async function boot(fake: Fake): Promise<FakeRoot> {
  const root = fakeRoot();
  vi.stubGlobal("document", { getElementById: () => root, createElement: () => fakeCanvas() });
  harness.bridge = fake.bridge;
  vi.resetModules();
  await import("../src/main");
  await vi.waitFor(() => expect(fake.ready()).toBe(true));
  await vi.waitFor(() => expect(root.renders).toBeGreaterThan(0));
  return root;
}

const STEPS = Array.from({ length: 12 }, (_, i) => ({ id: "s" + (i + 1), text: "Step number " + (i + 1), kind: "normal" }));

function data(settings: Record<string, unknown> = {}, steps: unknown[] = STEPS) {
  return {
    lists: [{ id: "l1", title: "Run", steps }],
    activeId: "l1",
    settings: { showNext: true, lineWidth: 56, invertScroll: false, ...settings },
  };
}

describe("flowlist lifecycle", () => {
  beforeEach(() => {
  resetGestureDedupe(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const drawCount = (fake: ReturnType<typeof fakeBridge>): number =>
    fake.bridge.createStartUpPageContainer.mock.calls.length + fake.bridge.textContainerUpgrade.mock.calls.length;

  it("regression: a failed exit call on double tap is not an unhandled rejection, and the run continues", async () => {
    const fake = fakeBridge(data());
    fake.bridge.shutDownPageContainer.mockRejectedValue(new Error("already closed"));
    await boot(fake);
    fake.emit(3);
    fake.emit(3);
    await sleep(20);
    expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(1);
    expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1);
    const drawn = drawCount(fake);
    fake.emit(0); // tap: complete the step
    await vi.waitFor(() => expect(drawCount(fake)).toBeGreaterThan(drawn));
  });

  it("regression: stops redrawing once the exit dialog was confirmed", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(3);
    await sleep(20);
    expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1);
    const drawn = drawCount(fake);
    fake.emit(0);
    await sleep(1300);
    expect(drawCount(fake)).toBe(drawn);
  });

  it("keeps the run going when the exit dialog is cancelled", async () => {
    const fake = fakeBridge(data());
    fake.bridge.shutDownPageContainer.mockResolvedValue(false);
    await boot(fake);
    fake.emit(3);
    await sleep(20);
    expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1);
    const drawn = drawCount(fake);
    fake.emit(0); // tap: complete the step
    await vi.waitFor(() => expect(drawCount(fake)).toBeGreaterThan(drawn));
  });

  it("regression: rebuilds the page after a reconnect even when nothing changed", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.reconnect();
    // One creation per run (after one first rebuild call); the page comes back by rebuild.
    await vi.waitFor(() => expect(fake.bridge.rebuildPageContainer).toHaveBeenCalledTimes(2));
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
  });

  it("regression: does not create the page twice while a creation is in flight", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    const creating = deferred<boolean>();
    fake.bridge.rebuildPageContainer.mockImplementationOnce(() => creating.promise);
    fake.reconnect();
    await vi.waitFor(() => expect(fake.bridge.rebuildPageContainer).toHaveBeenCalledTimes(2));
    fake.emit(0);
    fake.emit(0);
    await sleep(20);
    expect(fake.bridge.rebuildPageContainer).toHaveBeenCalledTimes(2);
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
    creating.resolve(true);
    // The step itself is a picture now; the body shows the step after it.
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Step number 4"));
  });

  it("regression: changing a display setting on the phone keeps the run going", async () => {
    // Every phone save restarted the run, so toggling "show next" mid-task
    // threw away the completed steps.
    const fake = fakeBridge(data());
    const root = await boot(fake);
    fake.emit(0);
    fake.emit(0);
    fake.emit(0);
    await sleep(50);
    expect(lastBody(fake)).toContain("Step number 5");

    root.get("#invert").checked = true;
    root.get("#invert").fire("change");
    await sleep(50);
    expect(lastBody(fake)).toContain("Step number 5");
  });

  it("sends the progress bar with the page, and again only when a step is done", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    const barWrites = (): number => fake.bridge.updateImageRawData.mock.calls.filter((call) => (call as unknown as [{ containerName?: string }])[0].containerName === "progress").length;
    await vi.waitFor(() => expect(barWrites()).toBe(1));
    const page = (fake.bridge.createStartUpPageContainer.mock.calls[0] as unknown as [{ imageObject?: Array<{ width?: number; height?: number; containerName?: string }> }])[0];
    expect(page.imageObject?.[0]).toMatchObject({ containerName: "progress", width: 280, height: 24 });
    expect(page.imageObject?.slice(1)).toMatchObject([{ containerName: "step-left", width: 288, height: 96 }, { containerName: "step-right", width: 288, height: 96 }]);
    await sleep(1300); // clock ticks change the footer, not the bar
    expect(barWrites()).toBe(1);
    fake.emit(0);
    await vi.waitFor(() => expect(barWrites()).toBe(2));
  });

  it("the progress bar never holds up the text, even when its transfer hangs", async () => {
    const fake = fakeBridge(data());
    fake.bridge.updateImageRawData.mockImplementation(() => new Promise(() => undefined));
    await boot(fake);
    // The bar and the step picture each hang on their own lane (one call each).
    await vi.waitFor(() => expect(fake.bridge.updateImageRawData).toHaveBeenCalledTimes(2));
    fake.emit(0);
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Step number 4"));
    expect(fake.bridge.updateImageRawData).toHaveBeenCalledTimes(2);
  });

  it("regression: never sends more body rows than the display holds", async () => {
    const long = "word ".repeat(80).trim();
    const fake = fakeBridge(data({}, [{ id: "a", text: long, kind: "normal", detail: long }, { id: "b", text: long, kind: "normal" }]));
    await boot(fake);
    const rows = (bodies(fake)[0] ?? "").split("\n");
    expect(rows.length).toBeLessThanOrEqual(4);
  });

  it("continues the run at the same step after a restart (phone locked, app unloaded)", async () => {
    const first = fakeBridge(data());
    await boot(first);
    first.emit(0);
    first.emit(0);
    first.emit(0);
    await vi.waitFor(() => expect(lastBody(first)).toContain("Step number 5"));
    await vi.waitFor(() => expect(first.storage.get("quietglass.flowlist.run.v1")).toContain('"currentId":"s4"'));

    const second = fakeBridge(null, new Map(first.storage));
    await boot(second);
    // Step 4 is the picture; the body shows the step after it.
    expect(bodies(second)[0]).toContain("Step number 5");
  });

  it("a different list on the phone starts its own run instead of restoring", async () => {
    const first = fakeBridge(data());
    await boot(first);
    first.emit(0);
    await vi.waitFor(() => expect(first.storage.get("quietglass.flowlist.run.v1")).toContain('"currentId":"s2"'));
    const other = { ...data(), lists: [{ id: "l2", title: "Other", steps: STEPS }], activeId: "l2" };
    const storage = new Map(first.storage);
    storage.set(KEY, JSON.stringify(other));
    const second = fakeBridge(null, storage);
    await boot(second);
    expect(bodies(second)[0]).toContain("Step number 2");
  });

  it("pauses the clock in the background and rebuilds the page when it comes back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fake = fakeBridge(data());
      await boot(fake);
      fake.emit(0);
      await vi.waitFor(() => expect(fake.storage.get("quietglass.flowlist.run.v1")).toContain('"currentId":"s2"'));
      fake.bridge.setLocalStorage.mockClear();
      fake.emit(5);
      await vi.waitFor(() => expect(fake.bridge.setLocalStorage).toHaveBeenCalled());
      const calls = drawCount(fake);
      await vi.advanceTimersByTimeAsync(5000);
      expect(drawCount(fake)).toBe(calls);

      const rebuilds = fake.bridge.rebuildPageContainer.mock.calls.length;
      fake.emit(4);
      await vi.waitFor(() => expect(fake.bridge.rebuildPageContainer.mock.calls.length).toBe(rebuilds + 1));
      expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops drawing after a system exit and keeps the run saved", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0);
    fake.emit(7);
    await sleep(30);
    const calls = drawCount(fake);
    fake.emit(0);
    await sleep(1200);
    expect(drawCount(fake)).toBe(calls);
    expect(fake.storage.get("quietglass.flowlist.run.v1")).toContain('"currentId":"s2"');
  });
});

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

const KEY = "quietglass.promptflow.v1";
const LONG_SCRIPT = Array.from({ length: 40 }, (_, i) => "Paragraph number " + (i + 1) + " has a handful of words in it.").join("\n\n");

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

async function boot(fake: Fake): Promise<FakeRoot> {
  const root = fakeRoot();
  vi.stubGlobal("document", { getElementById: () => root });
  harness.bridge = fake.bridge;
  vi.resetModules();
  await import("../src/main");
  await vi.waitFor(() => expect(fake.ready()).toBe(true));
  await vi.waitFor(() => expect(root.renders).toBeGreaterThan(0));
  return root;
}

function data(settings: Record<string, unknown> = {}, source = LONG_SCRIPT) {
  return {
    scripts: [{ id: "s1", title: "Talk", source, updatedAt: 0 }],
    activeId: "s1",
    settings: { mode: "speech", wpm: 130, visibleLines: 5, showCursor: false, invertScroll: false, lineWidth: 46, ...settings },
  };
}

describe("promptflow lifecycle", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("regression: a failed shutdown on double tap is not an unhandled rejection", async () => {
    // vitest fails the run on an unhandled rejection, so this test failing means it leaked.
    const fake = fakeBridge(data());
    fake.bridge.shutDownPageContainer.mockRejectedValue(new Error("already closed"));
    await boot(fake);
    fake.emit(3);
    fake.emit(3);
    await sleep(20);
    expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(1);
  });

  it("regression: stops redrawing once the app was closed", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0); // start reading
    await vi.waitFor(() => expect(lastBody(fake)).not.toBe(""));
    fake.emit(3);
    await sleep(20);
    const after = fake.bridge.textContainerUpgrade.mock.calls.length;
    await sleep(700);
    expect(fake.bridge.textContainerUpgrade.mock.calls.length).toBe(after);
  });

  it("regression: does not create the page twice while a creation is in flight", async () => {
    // After a reconnect the page is rebuilt; gestures arriving meanwhile each
    // started another full page creation on top of the pending one.
    const fake = fakeBridge(data());
    await boot(fake);
    const creating = deferred<number>();
    fake.bridge.createStartUpPageContainer.mockImplementationOnce(() => creating.promise);
    fake.reconnect();
    await vi.waitFor(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(2));
    fake.emit(2);
    fake.emit(2);
    fake.emit(1);
    await sleep(20);
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(2);
    creating.resolve(0);
    // The gestures are not lost: they are drawn once the page exists.
    await vi.waitFor(() => expect(fake.bridge.textContainerUpgrade).toHaveBeenCalled());
  });

  it("regression: overlapping redraws are serialised rather than interleaved", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    let inFlight = 0;
    let maxInFlight = 0;
    fake.bridge.textContainerUpgrade.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5);
      inFlight--;
      return true;
    });
    fake.emit(2);
    fake.emit(2);
    fake.emit(1);
    await sleep(100);
    expect(maxInFlight).toBe(1);
    // Every gesture is still applied: down 2, down 2, up 2 lines.
    expect(lastBody(fake)).toContain("Paragraph number 2 ");
  });

  it("regression: the line marker does not push lines past the configured width", async () => {
    // Lines were wrapped to the full width and the two-character marker added
    // on top, so every full line overflowed and the firmware wrapped it again.
    const fake = fakeBridge(data({ showCursor: true, lineWidth: 46 }, Array(60).fill("a").join(" ")));
    await boot(fake);
    const rows = (bodies(fake)[0] ?? "").split("\n");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(46);
  });

  it("regression: never sends more body rows than the display holds", async () => {
    const fake = fakeBridge(data({ visibleLines: 8 }));
    await boot(fake);
    expect((bodies(fake)[0] ?? "").split("\n").length).toBeLessThanOrEqual(7);
  });

  it("regression: changing a display setting on the phone keeps the reading position", async () => {
    const fake = fakeBridge(data());
    const root = await boot(fake);
    for (let i = 0; i < 10; i++) fake.emit(2); // paused: swipe down moves through the script
    await sleep(50);
    const before = lastBody(fake);
    expect(before).not.toContain("Paragraph number 1 ");

    root.get("#invert").checked = true;
    root.get("#invert").fire("change");
    await sleep(20);
    expect(lastBody(fake)).toBe(before);
  });
});

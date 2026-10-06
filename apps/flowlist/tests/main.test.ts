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

const STEPS = Array.from({ length: 12 }, (_, i) => ({ id: "s" + (i + 1), text: "Step number " + (i + 1), kind: "normal" }));

function data(settings: Record<string, unknown> = {}, steps: unknown[] = STEPS) {
  return {
    lists: [{ id: "l1", title: "Run", steps }],
    activeId: "l1",
    settings: { showNext: true, lineWidth: 46, invertScroll: false, ...settings },
  };
}

describe("flowlist lifecycle", () => {
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

  it("regression: stops redrawing the clock once the app was closed", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(3);
    await sleep(20);
    const created = fake.bridge.createStartUpPageContainer.mock.calls.length;
    const upgraded = fake.bridge.textContainerUpgrade.mock.calls.length;
    await sleep(1300);
    expect(fake.bridge.createStartUpPageContainer.mock.calls.length).toBe(created);
    expect(fake.bridge.textContainerUpgrade.mock.calls.length).toBe(upgraded);
  });

  it("regression: rebuilds the page after a reconnect even when nothing changed", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.reconnect();
    await vi.waitFor(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(2));
  });

  it("regression: does not create the page twice while a creation is in flight", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    const creating = deferred<number>();
    fake.bridge.createStartUpPageContainer.mockImplementationOnce(() => creating.promise);
    fake.reconnect();
    await vi.waitFor(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(2));
    fake.emit(0);
    fake.emit(0);
    await sleep(20);
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(2);
    creating.resolve(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("Step number 3"));
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
    expect(lastBody(fake)).toContain("Step number 4");

    root.get("#invert").checked = true;
    root.get("#invert").fire("change");
    await sleep(50);
    expect(lastBody(fake)).toContain("Step number 4");
  });

  it("regression: never sends more body rows than the display holds", async () => {
    const long = "word ".repeat(80).trim();
    const fake = fakeBridge(data({}, [{ id: "a", text: long, kind: "normal", detail: long }, { id: "b", text: long, kind: "normal" }]));
    await boot(fake);
    const rows = (bodies(fake)[0] ?? "").split("\n");
    expect(rows.length).toBeLessThanOrEqual(7);
  });
});

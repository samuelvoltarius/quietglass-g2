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
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
    menu: (itemID: number) => (resetGestureDedupe(), handler?.({ menuItemClickEvent: { itemID } })),
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
  await sleep(20); // let the first page finish, so a gesture right after boot is an update, not part of the first page
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
  beforeEach(() => {
  resetGestureDedupe(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("regression: a failed exit call on double tap is not an unhandled rejection, and the app stays", async () => {
    const fake = fakeBridge(data({ project: "Client A", startedAt: Date.now() - 60_000 }));
    fake.bridge.shutDownPageContainer.mockRejectedValue(new Error("already closed"));
    await boot(fake);
    fake.emit(3);
    fake.emit(3);
    await sleep(20);
    expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(1);
    expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1);
    const drawn = fake.bridge.textContainerUpgrade.mock.calls.length;
    fake.emit(1);
    await sleep(1300);
    expect(fake.bridge.textContainerUpgrade.mock.calls.length).toBeGreaterThan(drawn);
  });

  it("keeps the running clock on screen when the exit dialog is cancelled", async () => {
    const fake = fakeBridge(data({ project: "Client A", startedAt: Date.now() - 60_000 }));
    fake.bridge.shutDownPageContainer.mockResolvedValue(false);
    await boot(fake);
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1));
    const drawn = fake.bridge.textContainerUpgrade.mock.calls.length;
    fake.emit(1);
    await sleep(1300);
    expect(fake.bridge.textContainerUpgrade.mock.calls.length).toBeGreaterThan(drawn);
    expect(stored(fake).open.project).toBe("Client A");
  });

  it("no timer, poll or stream draws while the exit dialog may be on screen; a single 2x right after restores the page first and asks the dialog only then", async () => {
    const fake = fakeBridge(data({ project: "Client A", startedAt: Date.now() - 60_000 }));
    // The call resolves true as soon as the dialog is SHOWN, whatever the user answers later.
    fake.bridge.shutDownPageContainer.mockResolvedValue(true);
    await boot(fake);
    await vi.waitFor(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1));
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

  it("hardware order (step log): 4 = dialog up -> nothing drawn; 5 = dialog gone after No -> page up again without a gesture, clock ticking, next 2x asks", async () => {
    const fake = fakeBridge(data({ project: "Client A", startedAt: Date.now() - 60_000 }));
    fake.bridge.shutDownPageContainer.mockResolvedValue(true);
    await boot(fake);
    await vi.waitFor(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1));
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(1));
    fake.emit(4);                                            // the dialog is on screen
    const pageCalls = (): number => fake.bridge.createStartUpPageContainer.mock.calls.length + fake.bridge.rebuildPageContainer.mock.calls.length + fake.bridge.textContainerUpgrade.mock.calls.length + fake.bridge.updateImageRawData.mock.calls.length;
    const atShown = pageCalls();
    await sleep(1500);
    expect(pageCalls()).toBe(atShown);                       // nothing drawn over the dialog
    fake.emit(5);                                            // "No": the dialog is gone
    await vi.waitFor(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(2)); // page up again, no gesture needed
    await sleep(50);
    const afterRestore = fake.bridge.textContainerUpgrade.mock.calls.length;
    await sleep(1300);
    expect(fake.bridge.textContainerUpgrade.mock.calls.length).toBeGreaterThan(afterRestore); // the clock tick was never stopped
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(2)); // the very first 2x opens the dialog again
  });

  it("a 2x while the app thinks it is in the background (5 without a dialog) comes back and asks again", async () => {
    const fake = fakeBridge(data({ project: "Client A", startedAt: Date.now() - 60_000 }));
    await boot(fake);
    await vi.waitFor(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1));
    fake.emit(5);                                            // genuine background: the tick stops
    await sleep(100);
    const rebuilds = fake.bridge.rebuildPageContainer.mock.calls.length;
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(1)); // asked, not swallowed
    expect(fake.bridge.rebuildPageContainer.mock.calls.length).toBeGreaterThan(rebuilds);       // after the page came back
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
    expect(lastBody(fake).split("\n")[0]).toBe("0:00");
  });

  it("the exit call resolving true (dialog shown) does not close the app: the clock keeps drawing", async () => {
    const fake = fakeBridge(data({ project: "Client A", startedAt: Date.now() - 60_000 }));
    fake.bridge.shutDownPageContainer.mockResolvedValue(true);
    await boot(fake);
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1));
    await sleep(10);
    const drawn = fake.bridge.textContainerUpgrade.mock.calls.length;
    await sleep(1300);
    // While the dialog may be on screen no timer draws (a page call could cover it).
    expect(fake.bridge.textContainerUpgrade.mock.calls.length).toBe(drawn);
    fake.emit(1); // the next input restores the page; the clock kept running
    await sleep(1300);
    expect(fake.bridge.textContainerUpgrade.mock.calls.length).toBeGreaterThan(drawn);
  });

  it("regression: stops redrawing the running clock once the system ended the app (sysEvent 7)", async () => {
    const fake = fakeBridge(data({ project: "Client A", startedAt: Date.now() - 60_000 }));
    await boot(fake);
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1));
    fake.emit(7);
    await sleep(10);
    const drawn = fake.bridge.textContainerUpgrade.mock.calls.length + fake.bridge.createStartUpPageContainer.mock.calls.length;
    await sleep(1300);
    expect(fake.bridge.textContainerUpgrade.mock.calls.length + fake.bridge.createStartUpPageContainer.mock.calls.length).toBe(drawn);
  });

  it("regression: the day bar is sent with the page, not again on every clock tick", async () => {
    const fake = fakeBridge(data({ project: "Client A", startedAt: Date.now() - 60_000 }));
    await boot(fake);
    await sleep(2200);
    expect(fake.bridge.textContainerUpgrade.mock.calls.length).toBeGreaterThan(0);
    expect(fake.bridge.updateImageRawData).toHaveBeenCalledTimes(1);
  });

  it("the day bar never holds up the text, even when its transfer hangs", async () => {
    const fake = fakeBridge(data({ project: "Client A", startedAt: Date.now() - 60_000 }));
    fake.bridge.updateImageRawData.mockImplementation(() => new Promise(() => undefined));
    await boot(fake);
    await vi.waitFor(() => expect(fake.bridge.updateImageRawData).toHaveBeenCalledTimes(1));
    const before = fake.bridge.textContainerUpgrade.mock.calls.length;
    await sleep(2200);
    expect(fake.bridge.textContainerUpgrade.mock.calls.length).toBeGreaterThan(before);
    expect(fake.bridge.updateImageRawData).toHaveBeenCalledTimes(1);
  });

  it("resends the day bar when the clock stops, and sends the day-bar container", async () => {
    const fake = fakeBridge(data({ project: "Client A", startedAt: Date.now() - 600_000 }));
    await boot(fake);
    await vi.waitFor(() => expect(fake.bridge.updateImageRawData).toHaveBeenCalledTimes(1));
    fake.emit(0); // arm
    fake.emit(0); // confirm: stop
    await vi.waitFor(() => expect(fake.bridge.updateImageRawData).toHaveBeenCalledTimes(2));
    const update = (fake.bridge.updateImageRawData.mock.calls[1] as unknown as [{ containerID?: number; containerName?: string }])[0];
    expect(update).toMatchObject({ containerID: 4, containerName: "day-bar" });
    const page = (fake.bridge.createStartUpPageContainer.mock.calls[0] as unknown as [{ imageObject?: Array<{ width?: number; height?: number }> }])[0];
    expect(page.imageObject?.[0]).toMatchObject({ width: 96, height: 144 });
  });

  it("regression: a reconnect rebuilds the page and never creates it a second time", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    await vi.waitFor(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1));
    const rebuilds = fake.bridge.rebuildPageContainer.mock.calls.length;
    fake.reconnect();
    await vi.waitFor(() => expect(fake.bridge.rebuildPageContainer.mock.calls.length).toBe(rebuilds + 1));
    fake.reconnect();
    await vi.waitFor(() => expect(fake.bridge.rebuildPageContainer.mock.calls.length).toBe(rebuilds + 2));
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
  });

  it("regression: after a failed draw the page is rebuilt, not created again", async () => {
    const fake = fakeBridge(data({ project: "Client A", startedAt: Date.now() - 60_000 }));
    await boot(fake);
    await vi.waitFor(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1));
    fake.bridge.textContainerUpgrade.mockRejectedValueOnce(new Error("link lost"));
    const rebuilds = fake.bridge.rebuildPageContainer.mock.calls.length;
    await vi.waitFor(() => expect(fake.bridge.rebuildPageContainer.mock.calls.length).toBeGreaterThan(rebuilds), { timeout: 3000 });
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
  });

  it("regression: does not rebuild the page twice while a rebuild is in flight", async () => {
    const fake = fakeBridge(data({ project: "Client A", startedAt: Date.now() - 60_000 }));
    await boot(fake);
    await vi.waitFor(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1));
    const rebuilding = deferred<boolean>();
    const rebuilds = fake.bridge.rebuildPageContainer.mock.calls.length;
    fake.bridge.rebuildPageContainer.mockImplementationOnce(() => rebuilding.promise);
    fake.reconnect();
    await vi.waitFor(() => expect(fake.bridge.rebuildPageContainer.mock.calls.length).toBe(rebuilds + 1));
    await sleep(1200); // a clock tick lands while the page is still being built
    expect(fake.bridge.rebuildPageContainer.mock.calls.length).toBe(rebuilds + 1);
    rebuilding.resolve(true);
  });

  it("regression: gestures work while the first page is still being created", async () => {
    const fake = fakeBridge(data({ project: "Client A", startedAt: Date.now() - 60_000 }));
    fake.bridge.createStartUpPageContainer.mockImplementation(() => new Promise(() => undefined));
    const root = fakeRoot();
    vi.stubGlobal("document", { getElementById: () => root, createElement: () => fakeCanvas() });
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("navigator", { language: "en-US" });
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1));
  });

  it("leaving through the system pauses the clock display and saves; coming back rebuilds", async () => {
    const fake = fakeBridge(data({ project: "Client A", startedAt: Date.now() - 60_000 }));
    await boot(fake);
    await vi.waitFor(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1));
    const saves = fake.bridge.setLocalStorage.mock.calls.length;
    fake.emit(5);
    await vi.waitFor(() => expect(fake.bridge.setLocalStorage.mock.calls.length).toBeGreaterThan(saves));
    expect(stored(fake).open.project).toBe("Client A");
    await sleep(20);
    const drawn = fake.bridge.textContainerUpgrade.mock.calls.length;
    await sleep(1300);
    expect(fake.bridge.textContainerUpgrade.mock.calls.length).toBe(drawn);
    const rebuilds = fake.bridge.rebuildPageContainer.mock.calls.length;
    fake.emit(4);
    await vi.waitFor(() => expect(fake.bridge.rebuildPageContainer.mock.calls.length).toBe(rebuilds + 1));
    await sleep(1300);
    expect(fake.bridge.textContainerUpgrade.mock.calls.length).toBeGreaterThan(drawn);
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
  });

  it("a system exit saves the running entry and stops drawing", async () => {
    const fake = fakeBridge(data({ project: "Client A", startedAt: Date.now() - 60_000 }));
    await boot(fake);
    fake.emit(7);
    await vi.waitFor(() => expect(stored(fake).open.project).toBe("Client A"));
    await sleep(20);
    const drawn = fake.bridge.textContainerUpgrade.mock.calls.length + fake.bridge.rebuildPageContainer.mock.calls.length;
    await sleep(1300);
    expect(fake.bridge.textContainerUpgrade.mock.calls.length + fake.bridge.rebuildPageContainer.mock.calls.length).toBe(drawn);
    fake.emit(0);
    await sleep(20);
    expect(stored(fake).open.project).toBe("Client A");
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
    fake.emit(1); // up wraps to the last row (Help), one more up: Cancel
    fake.emit(1);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("> Cancel"));
    fake.emit(0);
    await vi.waitFor(() => expect(lastBody(fake)).toContain("stopped"));
    expect(stored(fake).open.project).toBeNull();
  });
});

describe("shiftclock QIS v1: stopping is armed, then confirmed", () => {
  beforeEach(() => { resetGestureDedupe(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const running = () => fakeBridge(data({ project: "Client A", startedAt: Date.now() - 60_000 }));
  const footerOf = (fake: Fake): string => {
    const calls = fake.bridge.textContainerUpgrade.mock.calls
      .map((call) => (call as unknown as [{ containerID?: number; content?: string }])[0])
      .filter((upgrade) => upgrade.containerID === 3);
    return calls[calls.length - 1]?.content ?? "";
  };

  it("one tap only arms: the clock keeps running and the footer asks for a second tap", async () => {
    const fake = running();
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(footerOf(fake)).toBe("Tap again = stop · Swipe/2× = cancel"));
    await sleep(30);
    expect(fake.bridge.setLocalStorage.mock.calls.length).toBe(0); // nothing stopped, nothing saved
  });

  it("a second tap within the window stops and saves", async () => {
    const fake = running();
    await boot(fake);
    fake.emit(0);
    fake.emit(0);
    await vi.waitFor(() => expect(stored(fake).open.project).toBeNull());
    expect(stored(fake).entries).toHaveLength(1);
  });

  it("a swipe cancels the pending stop and the next tap only arms again", async () => {
    const fake = running();
    await boot(fake);
    fake.emit(0);
    fake.emit(1);
    await vi.waitFor(() => expect(footerOf(fake)).toBe("Tap = stop · Hold = help · 2× = exit"));
    fake.emit(0);
    await vi.waitFor(() => expect(footerOf(fake)).toContain("Tap again"));
    expect(fake.bridge.setLocalStorage.mock.calls.length).toBe(0);
  });

  it("a hold never stops, and a double tap while armed cancels instead of leaving", async () => {
    const fake = running();
    await boot(fake);
    fake.emit(9); // hold: the help page, certainly not a stop
    await vi.waitFor(() => expect(footerOf(fake)).toBe("2× = back"));
    expect(fake.bridge.setLocalStorage.mock.calls.length).toBe(0);
    fake.emit(3);
    await vi.waitFor(() => expect(footerOf(fake)).toContain("2× = exit"));
    fake.emit(0); // arm
    fake.emit(3); // cancel
    await vi.waitFor(() => expect(footerOf(fake)).toBe("Tap = stop · Hold = help · 2× = exit"));
    await sleep(30);
    expect(fake.bridge.shutDownPageContainer).not.toHaveBeenCalled();
    expect(fake.bridge.setLocalStorage.mock.calls.length).toBe(0);
  });

  it("without a second tap the arming lapses after 4 s", async () => {
    const fake = running();
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(footerOf(fake)).toContain("Tap again"));
    await vi.waitFor(() => expect(footerOf(fake)).toBe("Tap = stop · Hold = help · 2× = exit"), { timeout: 5500 });
    fake.emit(0);
    await vi.waitFor(() => expect(footerOf(fake)).toContain("Tap again"));
    expect(fake.bridge.setLocalStorage.mock.calls.length).toBe(0);
  }, 12_000);

  it("the double tap is back inside the picker, exit only at the root", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0); // picker
    fake.emit(3); // back to the root, not out
    await vi.waitFor(() => expect(footerOf(fake)).toContain("2× = exit"));
    await sleep(30);
    expect(fake.bridge.shutDownPageContainer).not.toHaveBeenCalled();
    fake.emit(3);
    await vi.waitFor(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1));
  });

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0); // picker
    fake.emit(1); // wraps to the last row: Help
    await vi.waitFor(() => expect(lastBody(fake)).toContain("> Help"));
    fake.emit(9); // hold in the picker does nothing (it has its own row)
    await sleep(30);
    expect(lastBody(fake)).toContain("> Help");
    fake.emit(3); fake.emit(9); // back to the root, then hold
    await vi.waitFor(() => expect(footerOf(fake)).toBe("2× = back"));
    for (const call of fake.bridge.createStartUpPageContainer.mock.calls as unknown as unknown[][]) {
      expect((call[0] as { menuObject?: unknown }).menuObject).toBeUndefined();
    }
    for (const call of fake.bridge.rebuildPageContainer.mock.calls as unknown as unknown[][]) {
      expect((call[0] as { menuObject?: unknown }).menuObject).toBeUndefined();
    }
  });

  it("the help by gesture: the picker's Help row opens it, 2× goes back to the root, a tap there does not leave", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0); // picker
    fake.emit(1); // Help row
    fake.emit(0);
    await vi.waitFor(() => expect(footerOf(fake)).toBe("2× = back"));
    expect(lastBody(fake)).toContain("Hold = this help");
    fake.emit(0); fake.emit(2); // tap and swipe do nothing there
    await sleep(30);
    expect(footerOf(fake)).toBe("2× = back");
    fake.emit(3);
    await vi.waitFor(() => expect(footerOf(fake)).toContain("2× = exit"));
    expect(fake.bridge.shutDownPageContainer).not.toHaveBeenCalled();
    expect(stored(fake).open.project).toBeNull();
  });

  it("an armed stop is cancelled by a hold (it never opens the help or stops), then the hold opens the help", async () => {
    const fake = running();
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(footerOf(fake)).toContain("Tap again"));
    fake.emit(9);
    await vi.waitFor(() => expect(footerOf(fake)).toBe("Tap = stop · Hold = help · 2× = exit"));
    expect(fake.bridge.setLocalStorage.mock.calls.length).toBe(0);
    fake.emit(9);
    await vi.waitFor(() => expect(footerOf(fake)).toBe("2× = back"));
  });
});

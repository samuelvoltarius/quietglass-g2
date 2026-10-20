import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRoot, type FakeRoot } from "./fake-dom";
import type { CockpitModel } from "../src/cockpit/model";

// Boots the real app against a fake bridge, so the lifecycle can be checked without hardware.
const harness = vi.hoisted(() => ({ bridge: null as unknown, models: [] as unknown[] }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
// The cockpit is drawn for real; the test only records which model was drawn.
vi.mock("../src/cockpit/compose", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/cockpit/compose")>();
  return {
    ...real,
    composeCockpit: (model: CockpitModel, backend: Parameters<typeof real.composeCockpit>[1]) => {
      harness.models.push(model);
      return real.composeCockpit(model, backend);
    },
  };
});

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Polls with real timers. vi.waitFor would advance the faked wall clock on every poll (the clock stands still on purpose),
 * and a stop that is armed lapses by that clock.
 */
async function until(check: () => void, options: { timeout?: number } = {}): Promise<void> {
  const started = performance.now();
  for (;;) {
    try { check(); return; } catch (error) {
      if (performance.now() - started > (options.timeout ?? 1500)) throw error;
      await sleep(10);
    }
  }
}

const KEY = "quietglass.shiftclock.v1";
/** The wall clock stands still (Wednesday 14 October 2026, 12:00:30): a minute rolling over can never change a frame mid-test. */
const FROZEN = new Date(2026, 9, 14, 12, 0, 30);

interface PageLike { textObject?: { containerID?: number; content?: string }[]; imageObject?: unknown[]; menuObject?: unknown }

function fakeBridge(stored: Record<string, unknown> | null = null) {
  let handler: ((event: unknown) => void) | undefined;
  let statusHandler: ((status: unknown) => void) | undefined;
  const storage = new Map<string, string>();
  if (stored) storage.set(KEY, JSON.stringify(stored));
  /** What the glasses show: the page kind and the text of the three text containers. */
  const shown = { kind: "text" as "text" | "cockpit", texts: new Map<number, string>() };
  const takePage = (page: PageLike): void => {
    shown.kind = (page.imageObject?.length ?? 0) > 0 ? "cockpit" : "text";
    shown.texts.clear();
    for (const item of page.textObject ?? []) shown.texts.set(item.containerID ?? 0, item.content ?? "");
  };
  const bridge = {
    getLocalStorage: vi.fn(async (key: string) => storage.get(key) ?? ""),
    setLocalStorage: vi.fn(async (key: string, value: string) => { storage.set(key, value); return true; }),
    rebuildPageContainer: vi.fn(async (page: PageLike) => { takePage(page); return true; }),
    createStartUpPageContainer: vi.fn(async (page: PageLike): Promise<number> => { takePage(page); return 0; }),
    textContainerUpgrade: vi.fn(async (upgrade: { containerID?: number; content?: string }) => { shown.texts.set(upgrade.containerID ?? 0, upgrade.content ?? ""); return true; }),
    shutDownPageContainer: vi.fn(async () => true),
    updateImageRawData: vi.fn(async () => "success"),
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: (callback: (status: unknown) => void) => { statusHandler = callback; return () => undefined; },
  };
  return {
    bridge,
    shown,
    reconnect: () => statusHandler?.({ connectType: "connected" }),
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
    menu: (itemID: number) => (resetGestureDedupe(), handler?.({ menuItemClickEvent: { itemID } })),
    ready: () => handler !== undefined,
  };
}

type Fake = ReturnType<typeof fakeBridge>;

const CLICK = 0;
const UP = 1;
const DOWN = 2;
const DOUBLE = 3;
const HOLD = 9;

const body = (fake: Fake): string => fake.shown.texts.get(2) ?? "";
const header = (fake: Fake): string => fake.shown.texts.get(1) ?? "";
const footer = (fake: Fake): string => fake.shown.texts.get(3) ?? "";
const lastModel = (): CockpitModel => harness.models[harness.models.length - 1] as CockpitModel;
const tilesSent = (fake: Fake): number => fake.bridge.updateImageRawData.mock.calls.length;
const pageCalls = (fake: Fake): number =>
  fake.bridge.createStartUpPageContainer.mock.calls.length + fake.bridge.rebuildPageContainer.mock.calls.length
  + fake.bridge.textContainerUpgrade.mock.calls.length + fake.bridge.updateImageRawData.mock.calls.length;

/** Every app booted by a test; they are ended afterwards, or their clock ticks keep recording models into the next test. */
const booted: Fake[] = [];

async function boot(fake: Fake, settle = true): Promise<FakeRoot> {
  booted.push(fake);
  const root = fakeRoot();
  vi.stubGlobal("document", { getElementById: () => root, createElement: () => ({ getContext: () => null }) });
  vi.stubGlobal("location", { search: "" });
  // The app follows the device language; these tests read the English copy.
  vi.stubGlobal("navigator", { language: "en-US" });
  harness.bridge = fake.bridge;
  harness.models.length = 0;
  vi.resetModules();
  await import("../src/main");
  await until(() => expect(fake.ready()).toBe(true));
  await until(() => expect(root.renders).toBeGreaterThan(0));
  // Let the first page finish, so a gesture right after boot is an update.
  if (settle) await until(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1));
  await sleep(40);
  return root;
}

/** The cockpit is up with its four tiles on the glasses. */
async function bootCockpit(fake: Fake): Promise<void> {
  await boot(fake);
  await until(() => expect(tilesSent(fake)).toBe(4));
}

function stored(fake: Fake): { open: { project: string | null }; entries: unknown[]; projects: string[] } {
  const calls = fake.bridge.setLocalStorage.mock.calls;
  return JSON.parse(String(calls[calls.length - 1]?.[1] ?? "{}"));
}

function data(open: { project: string | null; startedAt: number | null } = { project: null, startedAt: null }) {
  return { projects: ["Client A", "Client B"], entries: [], open, invertScroll: false };
}

const runningFor = (ms: number) => data({ project: "Client A", startedAt: Date.now() - ms });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FROZEN);
  resetGestureDedupe();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const fake of booted.splice(0)) fake.emit(7); // the system ends the app: timers stop
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("shiftclock lifecycle", () => {
  it("regression: a failed exit call on double tap is not an unhandled rejection, and the app stays", async () => {
    const fake = fakeBridge(runningFor(60_000));
    fake.bridge.shutDownPageContainer.mockRejectedValue(new Error("already closed"));
    await bootCockpit(fake);
    fake.emit(DOUBLE);
    fake.emit(DOUBLE);
    await sleep(20);
    expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(1);
    expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1);
    const sent = tilesSent(fake);
    fake.emit(UP);
    // The next input puts the page up again, all four tiles included.
    await until(() => expect(tilesSent(fake)).toBeGreaterThan(sent));
  });

  it("keeps the running shift on screen when the exit dialog is cancelled", async () => {
    const fake = fakeBridge(runningFor(60_000));
    fake.bridge.shutDownPageContainer.mockResolvedValue(false);
    await bootCockpit(fake);
    fake.emit(DOUBLE);
    await until(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1));
    const sent = tilesSent(fake);
    fake.emit(UP);
    await until(() => expect(tilesSent(fake)).toBe(sent + 4));
    expect(stored(fake).open.project).toBe("Client A");
    expect(lastModel().state).toBe("running");
  });

  it("no timer, poll or stream draws while the exit dialog may be on screen; a single 2x right after restores the page first and asks the dialog only then", async () => {
    const fake = fakeBridge(runningFor(60_000));
    // The call resolves true as soon as the dialog is SHOWN, whatever the user answers later.
    fake.bridge.shutDownPageContainer.mockResolvedValue(true);
    await bootCockpit(fake);
    fake.emit(DOUBLE);
    await until(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(1));
    const callsAtAsk = pageCalls(fake);
    await sleep(5600); // a full clock tick passes
    // The tick keeps collecting but makes no page call while the dialog may be on screen.
    expect(pageCalls(fake)).toBe(callsAtAsk);
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
    fake.emit(DOUBLE);
    await sleep(500);
    expect(order).toEqual(["create:start"]); // the dialog is not asked while the page is still being created
    releaseCreate();
    await sleep(1500);
    expect(order).toEqual(["create:start", "create:done", "shutdown"]); // restore first, then the dialog, exactly once more
  }, 15_000);

  it("hardware order (step log): 4 = dialog up -> nothing drawn; 5 = dialog gone after No -> page up again without a gesture, next 2x asks", async () => {
    const fake = fakeBridge(runningFor(60_000));
    fake.bridge.shutDownPageContainer.mockResolvedValue(true);
    await bootCockpit(fake);
    fake.emit(DOUBLE);
    await until(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(1));
    fake.emit(4); // the dialog is on screen
    const atShown = pageCalls(fake);
    await sleep(300);
    expect(pageCalls(fake)).toBe(atShown); // nothing drawn over the dialog
    fake.emit(5); // "No": the dialog is gone
    await until(() => expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(2)); // page up again, no gesture needed
    await until(() => expect(tilesSent(fake)).toBe(8)); // and the four tiles with it
    fake.emit(DOUBLE);
    await until(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(2)); // the very first 2x opens the dialog again
  });

  it("a 2x while the app thinks it is in the background (5 without a dialog) comes back and asks again", async () => {
    const fake = fakeBridge(runningFor(60_000));
    await bootCockpit(fake);
    fake.emit(5); // genuine background: the tick stops
    await sleep(100);
    const rebuilds = fake.bridge.rebuildPageContainer.mock.calls.length;
    fake.emit(DOUBLE);
    await until(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(1)); // asked, not swallowed
    expect(fake.bridge.rebuildPageContainer.mock.calls.length).toBeGreaterThan(rebuilds); // after the page came back
  });

  it("regression: the running entry is saved before the page is shut down", async () => {
    const fake = fakeBridge(data());
    const saving = deferred<boolean>();
    await boot(fake);
    fake.emit(CLICK); // start Client A from the start page
    await until(() => expect(stored(fake).open.project).toBe("Client A"));
    fake.bridge.setLocalStorage.mockImplementationOnce(() => saving.promise);
    fake.emit(DOUBLE);
    await sleep(20);
    expect(fake.bridge.shutDownPageContainer).not.toHaveBeenCalled();
    saving.resolve(true);
    await until(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(1));
  });

  it("regression: a failed save is not an unhandled rejection, and the shift still shows", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.bridge.setLocalStorage.mockRejectedValue(new Error("storage full"));
    fake.emit(CLICK);
    await until(() => expect(lastModel().state).toBe("running"));
    await sleep(20);
  });

  it("the exit call resolving true (dialog shown) does not close the app: the next input restores the shift", async () => {
    const fake = fakeBridge(runningFor(60_000));
    fake.bridge.shutDownPageContainer.mockResolvedValue(true);
    await bootCockpit(fake);
    fake.emit(DOUBLE);
    await until(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1));
    await sleep(10);
    const sent = tilesSent(fake);
    fake.emit(UP); // the next input restores the page; the clock kept running
    await until(() => expect(tilesSent(fake)).toBeGreaterThan(sent));
    expect(lastModel().state).toBe("running");
  });

  it("regression: stops redrawing once the system ended the app (sysEvent 7)", async () => {
    const fake = fakeBridge(runningFor(60_000));
    await bootCockpit(fake);
    fake.emit(DOUBLE);
    await until(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1));
    fake.emit(7);
    await sleep(10);
    const calls = pageCalls(fake);
    fake.emit(UP);
    await sleep(300);
    expect(pageCalls(fake)).toBe(calls);
  });

  it("the cockpit tiles go out with the page, and an unchanged frame sends nothing on a clock tick", async () => {
    const fake = fakeBridge(runningFor(90_000));
    await bootCockpit(fake);
    const page = fake.bridge.createStartUpPageContainer.mock.calls[0]![0] as unknown as { imageObject?: { width?: number; height?: number }[]; textObject?: unknown[] };
    expect(page.imageObject).toHaveLength(4);
    for (const tile of page.imageObject ?? []) expect(tile).toMatchObject({ width: 288, height: 144 });
    expect(page.textObject).toHaveLength(1); // only the input container
    await sleep(5600); // one 5 s tick: same minute, same frame
    expect(tilesSent(fake)).toBe(4);
    expect(fake.bridge.textContainerUpgrade).not.toHaveBeenCalled();
  }, 15_000);

  it("the tile lane never holds up gestures, even when a transfer hangs", async () => {
    const fake = fakeBridge(runningFor(60_000));
    fake.bridge.updateImageRawData.mockImplementation(() => new Promise(() => undefined));
    await boot(fake);
    await until(() => expect(tilesSent(fake)).toBe(1));
    fake.emit(CLICK); // arm: the page still answers
    await until(() => expect(lastModel().state).toBe("armed"));
    fake.emit(DOUBLE);
    await until(() => expect(lastModel().state).toBe("running"));
  });

  it("resends the changed tiles when the shift stops", async () => {
    const fake = fakeBridge(runningFor(600_000));
    await bootCockpit(fake);
    fake.emit(CLICK); // arm
    fake.emit(CLICK); // confirm: stop
    await until(() => expect(lastModel().state).toBe("pause"));
    await until(() => expect(tilesSent(fake)).toBeGreaterThan(4));
    const update = (fake.bridge.updateImageRawData.mock.calls[4] as unknown as [{ containerName?: string }])[0];
    expect(update.containerName).toMatch(/^shift-/);
    expect(stored(fake).open.project).toBeNull();
    expect(stored(fake).entries).toHaveLength(1);
  });

  it("regression: a reconnect rebuilds the page and never creates it a second time", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    const rebuilds = fake.bridge.rebuildPageContainer.mock.calls.length;
    fake.reconnect();
    await until(() => expect(fake.bridge.rebuildPageContainer.mock.calls.length).toBe(rebuilds + 1));
    fake.reconnect();
    await until(() => expect(fake.bridge.rebuildPageContainer.mock.calls.length).toBe(rebuilds + 2));
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
  });

  it("regression: a reconnect while the cockpit runs rebuilds the page and sends all four tiles again", async () => {
    const fake = fakeBridge(runningFor(60_000));
    await bootCockpit(fake);
    fake.reconnect();
    await until(() => expect(tilesSent(fake)).toBe(8));
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
  });

  it("regression: after a failed draw the page is rebuilt, not created again", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.bridge.textContainerUpgrade.mockRejectedValueOnce(new Error("link lost"));
    const rebuilds = fake.bridge.rebuildPageContainer.mock.calls.length;
    fake.emit(DOWN); // the cursor moves: a text update, which fails
    await until(() => expect(fake.bridge.rebuildPageContainer.mock.calls.length).toBeGreaterThan(rebuilds), { timeout: 7000 });
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
  }, 12_000);

  it("regression: does not rebuild the page twice while a rebuild is in flight", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    const rebuilding = deferred<boolean>();
    const rebuilds = fake.bridge.rebuildPageContainer.mock.calls.length;
    fake.bridge.rebuildPageContainer.mockImplementationOnce(() => rebuilding.promise);
    fake.reconnect();
    await until(() => expect(fake.bridge.rebuildPageContainer.mock.calls.length).toBe(rebuilds + 1));
    fake.emit(DOWN); // a gesture lands while the page is still being built
    await sleep(100);
    expect(fake.bridge.rebuildPageContainer.mock.calls.length).toBe(rebuilds + 1);
    rebuilding.resolve(true);
  });

  it("regression: gestures work while the first page is still being created", async () => {
    const fake = fakeBridge(runningFor(60_000));
    fake.bridge.createStartUpPageContainer.mockImplementation(() => new Promise(() => undefined));
    await boot(fake, false);
    fake.emit(DOUBLE);
    await until(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1));
  });

  it("leaving through the system pauses the tick and saves; coming back rebuilds and resends the tiles", async () => {
    const fake = fakeBridge(runningFor(60_000));
    await bootCockpit(fake);
    const saves = fake.bridge.setLocalStorage.mock.calls.length;
    fake.emit(5);
    await until(() => expect(fake.bridge.setLocalStorage.mock.calls.length).toBeGreaterThan(saves));
    expect(stored(fake).open.project).toBe("Client A");
    await sleep(20);
    const calls = pageCalls(fake);
    await sleep(300);
    expect(pageCalls(fake)).toBe(calls);
    const rebuilds = fake.bridge.rebuildPageContainer.mock.calls.length;
    fake.emit(4);
    await until(() => expect(fake.bridge.rebuildPageContainer.mock.calls.length).toBe(rebuilds + 1));
    await until(() => expect(tilesSent(fake)).toBe(8));
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
  });

  it("a system exit saves the running entry and stops drawing", async () => {
    const fake = fakeBridge(runningFor(60_000));
    await bootCockpit(fake);
    fake.emit(7);
    await until(() => expect(stored(fake).open.project).toBe("Client A"));
    await sleep(20);
    const calls = pageCalls(fake);
    fake.emit(CLICK);
    await sleep(300);
    expect(pageCalls(fake)).toBe(calls);
    expect(stored(fake).open.project).toBe("Client A");
  });
});

describe("shiftclock first run", () => {
  it("with nothing stored, the first tap starts the default project", async () => {
    const fake = fakeBridge(null);
    await boot(fake);
    expect(fake.shown.kind).toBe("text");
    expect(body(fake)).toBe("● Work");
    fake.emit(CLICK);
    await until(() => expect(stored(fake).open.project).toBe("Work"));
    await until(() => expect(fake.shown.kind).toBe("cockpit"));
  });

  it("with no project at all, a tap creates one and the next starts it", async () => {
    const fake = fakeBridge({ projects: [], entries: [], open: { project: null, startedAt: null }, invertScroll: false });
    await boot(fake);
    expect(body(fake)).toBe("● Create “Work”");
    fake.emit(CLICK);
    await until(() => expect(stored(fake).projects).toEqual(["Work"]));
    fake.emit(CLICK);
    await until(() => expect(stored(fake).open.project).toBe("Work"));
  });
});

describe("shiftclock QUS v1 start page and cockpit", () => {
  it("starts with the header Shift · ● live, up to three big entries and one footer line", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    expect(header(fake)).toBe("Shift · ● live");
    expect(body(fake)).toBe("● Client A\n  Client B");
    expect(footer(fake)).toBe("Tap = start · Swipe = choose · 2× = exit");
    expect(fake.bridge.createStartUpPageContainer.mock.calls[0]![0]).not.toHaveProperty("menuObject");
  });

  it("a swipe moves the dot and a tap starts that project; the shift is then the cockpit image", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(DOWN);
    await until(() => expect(body(fake)).toBe("  Client A\n● Client B"));
    fake.emit(CLICK);
    await until(() => expect(stored(fake).open.project).toBe("Client B"));
    await until(() => expect(fake.shown.kind).toBe("cockpit"));
    await until(() => expect(tilesSent(fake)).toBe(4));
    expect(lastModel()).toMatchObject({ state: "running", caption: "Client B", title: "SHIFT" });
    expect(lastModel().hint).toBe("Tap = stop · 2× = exit");
  });

  it("a stopped shift with time today shows the pause page: tap resumes the last project, a swipe offers the others, 2× goes back", async () => {
    const now = Date.now();
    const fake = fakeBridge({ ...data(), entries: [{ id: "e1", project: "Client B", startedAt: now - 3_600_000, endedAt: now - 1_800_000 }] });
    await boot(fake);
    expect(fake.shown.kind).toBe("cockpit");
    await until(() => expect(lastModel().state).toBe("pause"));
    expect(lastModel().headline).toEqual(["BREAK 0:30"]);
    expect(lastModel().hint).toBe("Tap = resume · Swipe = project · 2× = exit");
    fake.emit(DOWN); // the other projects
    await until(() => expect(fake.shown.kind).toBe("text"));
    expect(footer(fake)).toBe("Tap = start · Swipe = choose · 2× = back");
    expect(body(fake).split("\n")[0]).toBe("● Client B"); // the most recently used first
    fake.emit(DOUBLE); // back, not out
    await until(() => expect(fake.shown.kind).toBe("cockpit"));
    expect(fake.bridge.shutDownPageContainer).not.toHaveBeenCalled();
    fake.emit(CLICK); // resume
    await until(() => expect(stored(fake).open.project).toBe("Client B"));
    // Both page kinds are swapped with a rebuild, the one creation stays the only one.
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
  });

  it("2x on the start page leaves; 2x on the running cockpit opens the exit dialog without stopping", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(DOUBLE);
    await until(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledWith(1));
    const run = fakeBridge(runningFor(60_000));
    await boot(run);
    run.emit(DOUBLE);
    await until(() => expect(run.bridge.shutDownPageContainer).toHaveBeenCalledWith(1));
    expect(stored(run).open.project).toBe("Client A"); // saved, not stopped
  });

  it("hold does nothing anywhere: no help page, no stop, no leave", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(HOLD);
    await sleep(40);
    expect(body(fake)).toBe("● Client A\n  Client B");
    const run = fakeBridge(runningFor(60_000));
    await bootCockpit(run);
    run.emit(HOLD);
    await sleep(40);
    expect(lastModel().state).toBe("running");
    expect(run.bridge.setLocalStorage).not.toHaveBeenCalled();
    expect(run.bridge.shutDownPageContainer).not.toHaveBeenCalled();
  });

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(CLICK); // the cockpit page
    await until(() => expect(fake.shown.kind).toBe("cockpit"));
    fake.menu(1); // a menu click, should one ever arrive, does nothing
    await sleep(40);
    expect(lastModel().state).toBe("running");
    for (const call of [...fake.bridge.createStartUpPageContainer.mock.calls, ...fake.bridge.rebuildPageContainer.mock.calls] as unknown as unknown[][]) {
      expect((call[0] as { menuObject?: unknown }).menuObject).toBeUndefined();
    }
  });
});

describe("shiftclock QIS v1: stopping is armed, then confirmed", () => {
  it("one tap only arms: the clock keeps running and the hint asks for a second tap", async () => {
    const fake = fakeBridge(runningFor(60_000));
    await bootCockpit(fake);
    fake.emit(CLICK);
    await until(() => expect(lastModel()).toMatchObject({ state: "armed", headline: ["STOP?"], hint: "Tap again = stop · Swipe/2× = cancel" }));
    await sleep(30);
    expect(fake.bridge.setLocalStorage.mock.calls.length).toBe(0); // nothing stopped, nothing saved
  });

  it("a second tap within the window stops and saves", async () => {
    const fake = fakeBridge(runningFor(60_000));
    await bootCockpit(fake);
    fake.emit(CLICK);
    fake.emit(CLICK);
    await until(() => expect(stored(fake).open.project).toBeNull());
    expect(stored(fake).entries).toHaveLength(1);
    await until(() => expect(lastModel().state).toBe("pause"));
  });

  it("a swipe cancels the pending stop and the next tap only arms again", async () => {
    const fake = fakeBridge(runningFor(60_000));
    await bootCockpit(fake);
    fake.emit(CLICK);
    await until(() => expect(lastModel().state).toBe("armed"));
    fake.emit(UP);
    await until(() => expect(lastModel().state).toBe("running"));
    fake.emit(CLICK);
    await until(() => expect(lastModel().state).toBe("armed"));
    expect(fake.bridge.setLocalStorage.mock.calls.length).toBe(0);
  });

  it("a hold never stops, and a double tap while armed cancels instead of leaving", async () => {
    const fake = fakeBridge(runningFor(60_000));
    await bootCockpit(fake);
    fake.emit(CLICK); // arm
    await until(() => expect(lastModel().state).toBe("armed"));
    fake.emit(HOLD); // cancels, certainly not a stop
    await until(() => expect(lastModel().state).toBe("running"));
    fake.emit(CLICK); // arm
    await until(() => expect(lastModel().state).toBe("armed"));
    fake.emit(DOUBLE); // cancel
    await until(() => expect(lastModel().state).toBe("running"));
    await sleep(30);
    expect(fake.bridge.shutDownPageContainer).not.toHaveBeenCalled();
    expect(fake.bridge.setLocalStorage.mock.calls.length).toBe(0);
  });

  it("without a second tap the arming lapses after 4 s", async () => {
    const fake = fakeBridge(runningFor(60_000));
    await bootCockpit(fake);
    fake.emit(CLICK);
    await until(() => expect(lastModel().state).toBe("armed"));
    await until(() => expect(lastModel().state).toBe("running"), { timeout: 5500 });
    fake.emit(CLICK);
    await until(() => expect(lastModel().state).toBe("armed"));
    expect(fake.bridge.setLocalStorage.mock.calls.length).toBe(0);
  }, 12_000);

  it("while the exit dialog may be up, not even a reconnect writes a tile", async () => {
    const fake = fakeBridge(runningFor(60_000));
    fake.bridge.shutDownPageContainer.mockResolvedValue(true);
    await bootCockpit(fake);
    fake.emit(DOUBLE);
    await until(() => expect(fake.bridge.shutDownPageContainer).toHaveBeenCalledTimes(1));
    const sent = tilesSent(fake);
    fake.reconnect();
    await sleep(100);
    expect(tilesSent(fake)).toBe(sent);
  });
});

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
    menu: (itemID: number) => handler?.({ menuItemClickEvent: { itemID } }),
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
      // Every call into the glasses is bounded (a few more ticks): let a draw already running finish first.
      await vi.advanceTimersByTimeAsync(100);
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

/** Newest text sent to one container (page creation or upgrade). */
function lastText(fake: Fake, containerID: number): string {
  const sent: string[] = [];
  for (const call of fake.bridge.createStartUpPageContainer.mock.calls) {
    const page = (call as unknown as [{ textObject?: Array<{ containerID?: number; content?: string }> }])[0];
    const text = page.textObject?.find((t) => t.containerID === containerID)?.content;
    if (text !== undefined) sent.push(text);
  }
  for (const call of fake.bridge.textContainerUpgrade.mock.calls) {
    const upgrade = (call as unknown as [{ containerID?: number; content?: string }])[0];
    if (upgrade.containerID === containerID) sent.push(upgrade.content ?? "");
  }
  return sent[sent.length - 1] ?? "";
}

describe("flowlist QIS v1", () => {
  beforeEach(() => { resetGestureDedupe(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const optionalData = (): ReturnType<typeof data> => data({}, [
    { id: "s1", text: "Sunscreen", kind: "optional" },
    { id: "s2", text: "Second step", kind: "normal" },
  ]);
  const runStep = (fake: Fake): string => fake.storage.get("quietglass.flowlist.run.v1") ?? "";

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · 2/12"));
    const pages = [
      ...(fake.bridge.createStartUpPageContainer.mock.calls as unknown as unknown[][]),
      ...(fake.bridge.rebuildPageContainer.mock.calls as unknown as unknown[][]),
    ].map((call) => call[0] as { menuObject?: unknown });
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) expect(page.menuObject).toBeUndefined();
  });

  it("a swipe down on an optional step asks to skip; the second tap skips it, a swipe cancels (no side menu)", async () => {
    const fake = fakeBridge(optionalData());
    await boot(fake);
    fake.emit(2);
    await vi.waitFor(() => expect(lastText(fake, 3)).toBe("Nochmal tippen = auslassen · Wischen/2× = abbrechen"));
    expect(lastText(fake, 1)).toBe("FLOWLIST · Auslassen?");
    expect(runStep(fake)).not.toContain("skipped");
    fake.emit(1); // swipe: cancels
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · 1/2"));
    fake.emit(2);
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · Auslassen?"));
    fake.emit(0); // the confirming tap
    await vi.waitFor(() => expect(runStep(fake)).toContain('"s1":"skipped"'));
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · 2/2"));
  });

  it("a swipe up asks to go a step back; the second tap does it, a swipe cancels (no side menu)", async () => {
    const fake = fakeBridge(optionalData());
    await boot(fake);
    fake.emit(1); // first step: nothing to undo
    await sleep(60);
    expect(lastText(fake, 1)).toBe("FLOWLIST · 1/2");
    fake.emit(0);
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · 2/2"));
    fake.emit(1);
    await vi.waitFor(() => expect(lastText(fake, 3)).toBe("Nochmal tippen = Schritt zurück · Wischen/2× = abbrechen"));
    expect(runStep(fake)).toContain('"s1":"done"');
    fake.emit(2); // swipe: cancels, changes nothing
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · 2/2"));
    expect(runStep(fake)).toContain('"s1":"done"');
    fake.emit(1);
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · Zurück?"));
    fake.emit(0); // the confirming tap
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · 1/2"));
    expect(runStep(fake)).not.toContain('"s1":"done"');
  });

  it("QIS v1.2: menu Step back is armed; a tap carries it out, a swipe cancels it", async () => {
    const fake = fakeBridge(optionalData());
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · 2/2"));
    fake.menu(3);
    await vi.waitFor(() => expect(lastText(fake, 3)).toBe("Nochmal tippen = Schritt zurück · Wischen/2× = abbrechen"));
    expect(lastText(fake, 1)).toBe("FLOWLIST · Zurück?");
    expect(runStep(fake)).toContain('"s1":"done"');
    fake.emit(1); // swipe: cancels
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · 2/2"));
    expect(runStep(fake)).toContain('"s1":"done"');
    fake.menu(3);
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · Zurück?"));
    fake.emit(0); // the confirming tap
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · 1/2"));
    expect(runStep(fake)).not.toContain('"s1":"done"');
  });

  it("QIS v1.2: a second click of the menu item also carries it out", async () => {
    const fake = fakeBridge(optionalData());
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · 2/2"));
    fake.menu(3);
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · Zurück?"));
    fake.menu(3);
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · 1/2"));
  });

  it("QIS v1.2: menu Step back at the first step does nothing", async () => {
    const fake = fakeBridge(optionalData());
    await boot(fake);
    fake.menu(3);
    await sleep(60);
    expect(lastText(fake, 1)).toBe("FLOWLIST · 1/2");
    expect(lastText(fake, 3)).not.toContain("Nochmal");
  });

  it("menu Skip step on an optional step only asks; the second tap skips it", async () => {
    const fake = fakeBridge(optionalData());
    await boot(fake);
    fake.menu(4);
    await vi.waitFor(() => expect(lastText(fake, 3)).toBe("Nochmal tippen = auslassen · Wischen/2× = abbrechen"));
    expect(lastText(fake, 1)).toBe("FLOWLIST · Auslassen?");
    expect(runStep(fake)).not.toContain('"currentId":"s2"');
    fake.emit(0); // the confirming tap
    await vi.waitFor(() => expect(runStep(fake)).toContain('"currentId":"s2"'));
    expect(runStep(fake)).toContain('"s1":"skipped"');
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · 2/2"));
  });

  it("a swipe or 2× cancels the question; 2× does not leave the app", async () => {
    const fake = fakeBridge(optionalData());
    await boot(fake);
    fake.menu(4);
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · Auslassen?"));
    fake.emit(3); // 2×
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · 1/2"));
    expect(fake.bridge.shutDownPageContainer).not.toHaveBeenCalled();
    fake.menu(4);
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · Auslassen?"));
    fake.emit(1); // swipe up
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · 1/2"));
    expect(runStep(fake)).not.toContain('"s1":"skipped"');
  });

  it("the question lapses after 4 seconds without input", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fake = fakeBridge(optionalData());
    await boot(fake);
    fake.menu(4);
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · Auslassen?"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(lastText(fake, 1)).toBe("FLOWLIST · Auslassen?");
    await vi.advanceTimersByTimeAsync(2500);
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · 1/2"));
    fake.emit(0); // a late tap now completes the step normally instead of skipping it
    await vi.waitFor(() => expect(runStep(fake)).toContain('"s1":"done"'));
  });

  it("a hold on a step without detail opens the help; tap, 2× or hold close it, 2× never exits there", async () => {
    const fake = fakeBridge(data());
    await boot(fake);
    expect(lastText(fake, 1)).toBe("FLOWLIST · 1/12");
    fake.emit(9);
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · Hilfe"));
    await vi.waitFor(() => expect(lastText(fake, 3)).toBe("Tippen = zurück · 2× = zurück"));
    fake.emit(2); // swipes change nothing in the help
    await sleep(30);
    expect(lastText(fake, 1)).toBe("FLOWLIST · Hilfe");
    fake.emit(3);
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · 1/12"));
    expect(fake.bridge.shutDownPageContainer).not.toHaveBeenCalled();
    expect(runStep(fake)).not.toContain('"currentId":"s2"');
  });

  it("finishing and tapping again asks before it starts over", async () => {
    const fake = fakeBridge(data({}, [{ id: "s1", text: "Only step", kind: "normal" }]));
    await boot(fake);
    fake.emit(0);
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · fertig"));
    fake.emit(0);
    await vi.waitFor(() => expect(lastText(fake, 3)).toBe("Nochmal tippen = neu starten · Wischen/2× = abbrechen"));
    fake.emit(3);
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · fertig"));
    fake.emit(0);
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · Neustart?"));
    fake.emit(0);
    await vi.waitFor(() => expect(lastText(fake, 1)).toBe("FLOWLIST · 1/1"));
  });
});

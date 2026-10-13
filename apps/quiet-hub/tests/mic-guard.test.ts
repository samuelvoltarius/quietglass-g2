import { describe, expect, it } from "vitest";
import { MicGuard } from "../src/audio/mic-guard";
import mainSource from "../src/main.ts?raw";

/** A fake audioControl whose "on" answer arrives when the test says so. */
function fakeMic() {
  const calls: boolean[] = [];
  let open = false;
  let answer: ((ok: boolean) => void) | null = null;
  const control = (on: boolean): Promise<boolean> => {
    calls.push(on);
    if (!on) { open = false; return Promise.resolve(true); }
    return new Promise<boolean>((resolve) => { answer = (ok) => { if (ok) open = true; resolve(ok); }; });
  };
  return { calls, control, isOpen: () => open, answer: (ok: boolean) => answer?.(ok) };
}

/** Manual timers. */
function clock() {
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  return {
    setTimer: (fn: () => void, ms: number) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (t: unknown) => { (t as { live: boolean }).live = false; },
    fire: () => { for (const t of timers.filter((x) => x.live)) { t.live = false; t.fn(); } },
    live: () => timers.filter((t) => t.live).length,
  };
}

describe("the microphone never stays open (0.6.5)", () => {
  it("hold released before the mic answered: the late 'on' is switched off again at once", async () => {
    const mic = fakeMic();
    const c = clock();
    const guard = new MicGuard({ control: mic.control, maxMs: 18_000, setTimer: c.setTimer, clearTimer: c.clearTimer });
    const started = guard.start();
    await guard.stop(); // release arrives first
    mic.answer(true); // ...then the glasses say "mic on"
    expect(await started).toBe("cancelled");
    await Promise.resolve();
    expect(mic.isOpen()).toBe(false);
    expect(mic.calls).toEqual([true, false, false]);
    expect(guard.active).toBe(false);
    expect(c.live()).toBe(0);
  });

  it("a normal recording: on, then off on release, no timer left", async () => {
    const mic = fakeMic();
    const c = clock();
    const guard = new MicGuard({ control: mic.control, maxMs: 18_000, setTimer: c.setTimer, clearTimer: c.clearTimer });
    const started = guard.start();
    mic.answer(true);
    expect(await started).toBe("on");
    expect(guard.active).toBe(true);
    await guard.stop();
    expect(mic.isOpen()).toBe(false);
    expect(c.live()).toBe(0);
  });

  it("no release at all: the limit ends it even when the page no longer records", async () => {
    const mic = fakeMic();
    const c = clock();
    let limits = 0;
    const guard = new MicGuard({ control: mic.control, maxMs: 18_000, setTimer: c.setTimer, clearTimer: c.clearTimer, onLimit: () => { limits += 1; } });
    const started = guard.start();
    mic.answer(true);
    await started;
    c.fire();
    await Promise.resolve();
    expect(limits).toBe(1);
    expect(mic.isOpen()).toBe(false);
    expect(guard.active).toBe(false);
  });

  it("a refused mic says so", async () => {
    const mic = fakeMic();
    const guard = new MicGuard({ control: mic.control, maxMs: 1000 });
    const started = guard.start();
    mic.answer(false);
    expect(await started).toBe("refused");
    expect(guard.active).toBe(false);
  });
});

describe("gestures work before the network answers (0.6.5)", () => {
  it("main registers onEvenHubEvent before any report is awaited", () => {
    const source: string = mainSource;
    const handler = source.indexOf("bridge.onEvenHubEvent(");
    expect(handler).toBeGreaterThan(0);
    // Top-level boot code up to the handler (function bodies defined there only run later).
    const boot = source.slice(source.indexOf("let model: HubModel = createModel("), source.indexOf("const savedUi"));
    expect(boot).toMatch(/if \(DEMO\) \{\s*model = createModel\(await api\.report\(\)\);/);
    expect(boot.split("await api.report()").length - 1).toBe(1);
    expect(boot).toContain('emptyReport("loading")');
    // The first poll (network) starts only at the end, after the handler.
    expect(source.lastIndexOf("void poll();")).toBeGreaterThan(handler);
  });
});

describe("first page: one rebuild, then one create (skill rule)", () => {
  it("createPage rebuilds first (result ignored), then creates exactly once", async () => {
    const { createPage } = await import("../src/glasses/render");
    const calls: string[] = [];
    const bridge = {
      rebuildPageContainer: async () => { calls.push("rebuild"); return true; },
      createStartUpPageContainer: async () => { calls.push("create"); return 0; },
      updateImageRawData: async () => { calls.push("image"); return 0; },
      textContainerUpgrade: async () => true,
    };
    await createPage(bridge as never, { header: "h", body: ["b"], footer: "f" }, []);
    expect(calls.slice(0, 2)).toEqual(["rebuild", "create"]);
    expect(calls.filter((c) => c === "create")).toHaveLength(1);
  });
});

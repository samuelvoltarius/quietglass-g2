import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLICK, DOUBLE_TAP, fakeBridge } from "./fake-bridge";

// Boots the real app against a fake bridge and a fake phone DOM to check refresh wiring without hardware.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

class FakeElement {
  value = ""; checked = false; textContent = ""; innerHTML = "";
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, (event: unknown) => void>();
  addEventListener(type: string, listener: (event: unknown) => void): void { this.listeners.set(type, listener); }
  fire(type: string): void { this.listeners.get(type)?.({ target: this }); }
}
class FakeRoot {
  readonly elements = new Map<string, FakeElement>();
  querySelector(selector: string): FakeElement { let el = this.elements.get(selector); if (!el) { el = new FakeElement(); this.elements.set(selector, el); } return el; }
  querySelectorAll(): FakeElement[] { return []; }
  /** Rebuilding the page throws every element away, as a real innerHTML assignment does. */
  set innerHTML(html: string) { this.html = html; this.elements.clear(); }
  get innerHTML(): string { return this.html; }
  private html = "";
}

type Pending = { url: string; resolve: (body: unknown) => void; reject: (error: Error) => void };

describe("market glance refresh loop", () => {
  let pending: Pending[];
  let root: FakeRoot;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12));
    pending = [];
    root = new FakeRoot();
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("document", { activeElement: null, documentElement: {}, querySelector: (selector: string) => (selector === "#app" ? root : null) });
    vi.stubGlobal("fetch", vi.fn((url: string) => new Promise<Response>((resolve, reject) => {
      pending.push({ url, resolve: (body) => resolve(new Response(JSON.stringify(body), { status: 200 })), reject });
    })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function boot() {
    const fake = fakeBridge();
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    return fake;
  }
  const live = () => ({ positions: [{ provider: "kalshi", title: "T", outcome: "YES", price: 0.5, pnl: 1 }], source: "live", updatedAt: new Date().toISOString(), errors: [] });
  const calls = (fake: Awaited<ReturnType<typeof boot>>) => fake.state.draws + fake.state.creates + fake.state.rebuilds + fake.state.images;

  it("regression: saving a new endpoint during a refresh fetches it right after, not 15 s later", async () => {
    await boot();
    expect(pending.map((call) => call.url)).toEqual(["http://127.0.0.1:8793/positions"]);
    root.querySelector("#endpoint").value = "http://127.0.0.1:8793/other";
    root.querySelector("#save").fire("click");
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(1); // still one request in flight
    pending[0]?.resolve(live());
    await vi.advanceTimersByTimeAsync(10);
    expect(pending.map((call) => call.url)).toEqual(["http://127.0.0.1:8793/positions", "http://127.0.0.1:8793/other"]);
  });

  it("starts on the start page; live data turns stale on the glasses and the error shows on the phone when the bridge goes down", async () => {
    const fake = await boot();
    expect(fake.state.kind).toBe("text");
    pending[0]?.resolve(live());
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.state.header).toBe("Market Glance · ● live");
    await vi.advanceTimersByTimeAsync(15000);
    pending[1]?.reject(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.state.header).toBe("Market Glance · stale 15s");
    expect(root.querySelector("#positions-live").innerHTML).toContain("Last error: Failed to fetch");
  });

  it("tap opens the portfolio as a cockpit image; a second tap refreshes; 2x goes back to the start page", async () => {
    const fake = await boot();
    pending[0]?.resolve(live());
    await vi.advanceTimersByTimeAsync(10);
    fake.gesture(CLICK);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.state.kind).toBe("cockpit");
    expect(fake.state.images).toBe(4);
    expect(pending).toHaveLength(1);
    fake.gesture(CLICK);
    await vi.advanceTimersByTimeAsync(10);
    expect(pending).toHaveLength(2);
    fake.gesture(DOUBLE_TAP);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.state.kind).toBe("text");
    expect(fake.state.shutdowns).toBe(0);
  });

  it("asks for the system exit dialog on the start page; the call resolving true (dialog shown) does not stop refreshing", async () => {
    const fake = await boot();
    pending[0]?.resolve(live());
    await vi.advanceTimersByTimeAsync(10);
    fake.gesture(DOUBLE_TAP);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.state.modes).toEqual([1]);
    await vi.advanceTimersByTimeAsync(30000);
    expect(pending.length).toBeGreaterThan(1);
  });

  it("stops refreshing once the system ends the app (sysEvent 7) after the dialog", async () => {
    const fake = await boot();
    pending[0]?.resolve(live());
    await vi.advanceTimersByTimeAsync(10);
    fake.gesture(DOUBLE_TAP);
    await vi.advanceTimersByTimeAsync(10);
    fake.gesture(7);
    await vi.advanceTimersByTimeAsync(30000);
    expect(pending).toHaveLength(1);
  });

  it("no timer, poll or tile draws while the exit dialog may be on screen; a single 2x right after restores the page first and asks the dialog only then", async () => {
    const fake = await boot();
    pending[0]?.resolve(live());
    await vi.advanceTimersByTimeAsync(10);
    const creates = fake.state.creates;
    fake.state.confirm = true;
    fake.gesture(DOUBLE_TAP);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.state.modes).toEqual([1]);
    const atAsk = calls(fake);
    await vi.advanceTimersByTimeAsync(30000);
    // Timers, polls and the clock keep running but make no page or image call while the dialog may be on screen.
    expect(calls(fake)).toBe(atAsk);
    expect(fake.state.creates).toBe(creates);
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
    fake.gesture(DOUBLE_TAP);
    await vi.advanceTimersByTimeAsync(500);
    expect(order).toEqual(["create:start"]); // the dialog is not asked while the page is still being created
    releaseCreate();
    await vi.advanceTimersByTimeAsync(1500);
    expect(order).toEqual(["create:start", "create:done", "shutdown"]); // restore first, then the dialog, exactly once more
  });

  it("hardware order (step log): 4 = dialog up -> nothing drawn; 5 = dialog gone after No -> page up again, polling on, next 2x asks", async () => {
    const fake = await boot();
    pending[0]?.resolve(live());
    await vi.advanceTimersByTimeAsync(10);
    fake.gesture(DOUBLE_TAP);
    await vi.advanceTimersByTimeAsync(70);
    expect(fake.state.modes).toEqual([1]);
    fake.gesture(4);                                         // the dialog is on screen
    const atShown = calls(fake);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(calls(fake)).toBe(atShown);                       // nothing drawn over the dialog
    const creates = fake.state.creates;
    const polls = pending.length;
    fake.gesture(5);                                         // "No": the dialog is gone
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.state.creates).toBeGreaterThan(creates);     // page created again, no gesture needed
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pending.length).toBeGreaterThan(polls);           // the poll was never stopped
    fake.gesture(DOUBLE_TAP);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.state.modes).toEqual([1, 1]);                // the very first 2x opens the dialog again
  });

  it("while the dialog may be up the cockpit sends no tile either", async () => {
    const fake = await boot();
    pending[0]?.resolve(live());
    await vi.advanceTimersByTimeAsync(10);
    fake.gesture(CLICK);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.state.kind).toBe("cockpit");
    fake.gesture(DOUBLE_TAP); // back to start
    await vi.advanceTimersByTimeAsync(50);
    fake.gesture(DOUBLE_TAP); // ask the dialog
    await vi.advanceTimersByTimeAsync(50);
    const images = fake.state.images;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.state.images).toBe(images);
  });

  it("keeps refreshing and reacting when the user cancels the exit dialog", async () => {
    const fake = await boot();
    pending[0]?.resolve(live());
    await vi.advanceTimersByTimeAsync(10);
    fake.state.confirm = false;
    fake.gesture(DOUBLE_TAP);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.state.modes).toEqual([1]);
    await vi.advanceTimersByTimeAsync(15000);
    expect(pending).toHaveLength(2);
    pending[1]?.resolve(live());
    await vi.advanceTimersByTimeAsync(10);
    fake.gesture(CLICK);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.state.kind).toBe("cockpit");
  });
});

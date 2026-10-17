import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app against a fake bridge and a fake phone DOM to check refresh wiring without hardware.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

function fakeBridge() {
  let handler: ((event: unknown) => void) | undefined;
  const headers: string[] = [];
  const creates = { count: 0 };
  const shutdown = { confirm: true, modes: [] as (number | undefined)[] };
  const bridge = {
    rebuildPageContainer: async () => true,
    createStartUpPageContainer: async (page: { textObject?: { content?: string }[] }) => { creates.count += 1; headers.push(page.textObject?.[0]?.content ?? ""); return 0; },
    textContainerUpgrade: async (update: { containerName?: string; content?: string }) => { if (update.containerName === "header") headers.push(update.content ?? ""); return true; },
    shutDownPageContainer: async (mode?: number) => { shutdown.modes.push(mode); return shutdown.confirm; },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return { bridge, headers, creates, shutdown, emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })), ready: () => handler !== undefined };
}

function fakeDocument() {
  const app = { innerHTML: "" };
  const input = { value: "" };
  const listeners: Record<string, () => void> = {};
  const element = (id: string) => ({ addEventListener: (_type: string, fn: () => void) => { listeners[id] = fn; } });
  return { app, input, listeners, document: { activeElement: null, querySelectorAll: () => ({ forEach: () => undefined }), querySelector: (selector: string) => selector === "#app" ? app : selector === "#endpoint" ? input : selector === "#save" || selector === "#language" || selector === "#invert" ? element(selector) : null } };
}

type Pending = { url: string; resolve: (body: unknown) => void; reject: (error: Error) => void };

describe("market glance refresh loop", () => {
  let pending: Pending[];
  let dom: ReturnType<typeof fakeDocument>;
  beforeEach(() => {
  resetGestureDedupe();
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12));
    pending = [];
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
    vi.stubGlobal("navigator", { language: "en-US" });
    dom = fakeDocument();
    vi.stubGlobal("document", dom.document);
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
    return fake;
  }
  const live = () => ({ positions: [{ provider: "kalshi", title: "T", outcome: "YES", price: 0.5, pnl: 1 }], source: "live", updatedAt: new Date().toISOString(), errors: [] });

  it("regression: saving a new endpoint during a refresh fetches it right after, not 15 s later", async () => {
    await boot();
    expect(pending.map((call) => call.url)).toEqual(["http://127.0.0.1:8793/positions"]);
    dom.input.value = "http://127.0.0.1:8793/other";
    dom.listeners["#save"]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(1); // still one request in flight
    pending[0]?.resolve(live());
    await vi.advanceTimersByTimeAsync(10);
    expect(pending.map((call) => call.url)).toEqual(["http://127.0.0.1:8793/positions", "http://127.0.0.1:8793/other"]);
  });

  it("regression: live data turns STALE on the glasses and the error shows on the phone when the bridge goes down", async () => {
    const fake = await boot();
    pending[0]?.resolve(live());
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.headers.at(-1)).toBe("MARKET GLANCE · LIVE");
    await vi.advanceTimersByTimeAsync(15000);
    pending[1]?.reject(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.headers.at(-1)).toBe("MARKET GLANCE · STALE 15s");
    expect(dom.app.innerHTML).toContain("Last error: Failed to fetch");
  });

  it("tap refreshes the positions", async () => {
    const fake = await boot();
    pending[0]?.resolve(live());
    await vi.advanceTimersByTimeAsync(10);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(pending).toHaveLength(2);
  });

  it("asks for the system exit dialog; the call resolving true (dialog shown) does not stop refreshing", async () => {
    const fake = await boot();
    pending[0]?.resolve(live());
    await vi.advanceTimersByTimeAsync(10);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    await vi.advanceTimersByTimeAsync(30000);
    expect(pending.length).toBeGreaterThan(1);
  });

  it("stops refreshing once the system ends the app (sysEvent 7) after the dialog", async () => {
    const fake = await boot();
    pending[0]?.resolve(live());
    await vi.advanceTimersByTimeAsync(10);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    fake.emit(7);
    await vi.advanceTimersByTimeAsync(30000);
    expect(pending).toHaveLength(1);
  });

  it("no timer, poll or stream draws while the exit dialog may be on screen; a single 2x right after restores the page first and asks the dialog only then", async () => {
    const fake = await boot();
    pending[0]?.resolve(live());
    await vi.advanceTimersByTimeAsync(10);
    const creates = fake.creates.count;
    // The call resolves true as soon as the dialog is SHOWN, whatever the user answers later.
    fake.shutdown.confirm = true;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    const callsAtAsk = fake.headers.length + fake.creates.count;
    await vi.advanceTimersByTimeAsync(30000);
    // Timers, polls and streams keep collecting data but make no page call while the dialog may be on screen.
    expect(fake.headers.length + fake.creates.count).toBe(callsAtAsk);
    expect(fake.creates.count).toBe(creates);
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
    await vi.advanceTimersByTimeAsync(500);
    expect(order).toEqual(["create:start"]); // the dialog is not asked while the page is still being created
    releaseCreate();
    await vi.advanceTimersByTimeAsync(1500);
    expect(order).toEqual(["create:start", "create:done", "shutdown"]); // restore first, then the dialog, exactly once more
  });

  it("hardware order (step log): 4 = dialog up -> nothing drawn; 5 = dialog gone after No -> page up again without a gesture, polling on, next 2x asks", async () => {
    const fake = await boot();
    pending[0]?.resolve(live());
    await vi.advanceTimersByTimeAsync(10);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(70);
    expect(fake.shutdown.modes).toEqual([1]);
    fake.emit(4);                                            // the dialog is on screen
    const atShown = fake.headers.length + fake.creates.count;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fake.headers.length + fake.creates.count).toBe(atShown); // nothing drawn over the dialog
    const creates = fake.creates.count;
    const polls = pending.length;
    fake.emit(5);                                            // "No": the dialog is gone
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.creates.count).toBeGreaterThan(creates);     // page created again, no gesture needed
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pending.length).toBeGreaterThan(polls);           // the poll was never stopped
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.shutdown.modes).toEqual([1, 1]);             // the very first 2x opens the dialog again
  });

  it("keeps refreshing and reacting when the user cancels the exit dialog", async () => {
    const fake = await boot();
    pending[0]?.resolve(live());
    await vi.advanceTimersByTimeAsync(10);
    fake.shutdown.confirm = false;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    await vi.advanceTimersByTimeAsync(15000);
    expect(pending).toHaveLength(2);
    pending[1]?.resolve(live());
    await vi.advanceTimersByTimeAsync(10);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(pending).toHaveLength(3);
  });
});

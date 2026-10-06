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
  const shutdown = { confirm: true, modes: [] as (number | undefined)[] };
  const bridge = {
    rebuildPageContainer: async () => true,
    createStartUpPageContainer: async (page: { textObject?: { content?: string }[] }) => { headers.push(page.textObject?.[0]?.content ?? ""); return 0; },
    textContainerUpgrade: async (update: { containerName?: string; content?: string }) => { if (update.containerName === "header") headers.push(update.content ?? ""); return true; },
    shutDownPageContainer: async (mode?: number) => { shutdown.modes.push(mode); return shutdown.confirm; },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return { bridge, headers, shutdown, emit: (eventType: number) => handler?.({ sysEvent: { eventType, eventSource: 1 } }), ready: () => handler !== undefined };
}

function fakeDocument() {
  const app = { innerHTML: "" };
  const input = { value: "" };
  const listeners: Record<string, () => void> = {};
  const element = (id: string) => ({ addEventListener: (_type: string, fn: () => void) => { listeners[id] = fn; } });
  return { app, input, listeners, document: { activeElement: null, querySelector: (selector: string) => selector === "#app" ? app : selector === "#endpoint" ? input : selector === "#save" || selector === "#language" ? element(selector) : null } };
}

type Pending = { url: string; resolve: (body: unknown) => void; reject: (error: Error) => void };

describe("market glance refresh loop", () => {
  let pending: Pending[];
  let dom: ReturnType<typeof fakeDocument>;
  beforeEach(() => {
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
    expect(fake.headers.at(-1)).toBe("MARKET GLANCE  LIVE");
    await vi.advanceTimersByTimeAsync(15000);
    pending[1]?.reject(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.headers.at(-1)).toBe("MARKET GLANCE  STALE 15s");
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

  it("asks for the system exit dialog and stops refreshing once the user confirms", async () => {
    const fake = await boot();
    pending[0]?.resolve(live());
    await vi.advanceTimersByTimeAsync(10);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    await vi.advanceTimersByTimeAsync(30000);
    expect(pending).toHaveLength(1);
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGestureDedupe } from "../src/input/gestures";

// The real app against a fake Even Terminal: an approval on the glasses must
// never be answered by a swipe, and needs a second single tap (QIS v1).
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => {
  const scope = globalThis as { window?: unknown };
  const saved = scope.window;
  scope.window = undefined;
  try {
    return { ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()), waitForEvenAppBridge: async () => harness.bridge };
  } finally {
    scope.window = saved;
  }
});

class FakeEventSource {
  static last: FakeEventSource | null = null;
  readyState = 1;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeEventSource.last = this; }
  close(): void { this.readyState = 2; }
}

const NOW = new Date("2026-10-14T12:00:00Z");
const UP = 1, DOWN = 2, CLICK = 0, DOUBLE = 3;

describe("approvals on the glasses (integration)", () => {
  const posts: { path: string; body: unknown }[] = [];
  const page: Record<number, string> = {};
  let handler: ((event: unknown) => void) | undefined;
  const exits: (number | undefined)[] = [];
  const menus: string[][] = [];

  const boot = async (stored: Record<string, unknown> = {}): Promise<void> => {
    harness.bridge = {
      getLocalStorage: async (key: string) => key === "quietglass.agentglass.v1"
        ? JSON.stringify({ provider: "even-terminal", baseUrl: "http://terminal.example:3456", token: "tok-test-123456", sessionId: "s1", ...stored })
        : "en",
      setLocalStorage: async () => true,
      rebuildPageContainer: async (built: { menuObject?: { menuItems?: { itemName: string }[] }; textObject?: { containerID: number; content: string }[] }) => {
        for (const item of built.textObject ?? []) page[item.containerID] = item.content;
        if (built.menuObject) menus.push((built.menuObject.menuItems ?? []).map((item) => item.itemName));
        return true;
      },
      createStartUpPageContainer: async (built: { menuObject?: { menuItems?: { itemName: string }[] }; textObject?: { containerID: number; content: string }[] }) => {
        for (const item of built.textObject ?? []) page[item.containerID] = item.content;
        if (built.menuObject) menus.push((built.menuObject.menuItems ?? []).map((item) => item.itemName));
        return 0;
      },
      textContainerUpgrade: async (update: { containerID: number; content: string }) => { page[update.containerID] = update.content; return true; },
      updateImageRawData: async () => "success",
      shutDownPageContainer: async (mode?: number) => { exits.push(mode); return false; },
      onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
      onDeviceStatusChanged: () => () => undefined,
    };
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(handler).toBeDefined());
    await vi.advanceTimersByTimeAsync(300);
    // The agent asks to run a command.
    FakeEventSource.last?.onmessage?.({ data: JSON.stringify({ type: "permission_request", tool: "Bash", input: { command: "ls -la" } }) });
    await vi.advanceTimersByTimeAsync(1000);
  };

  const gesture = async (eventType: number, wait = 50): Promise<void> => {
    resetGestureDedupe();
    handler?.({ sysEvent: { eventType, eventSource: 1 } });
    await vi.advanceTimersByTimeAsync(wait);
  };
  const decisions = (): unknown[] => posts.filter((post) => post.path === "/permission-response").map((post) => post.body);

  beforeEach(() => {
    posts.length = 0;
    exits.length = 0;
    menus.length = 0;
    handler = undefined;
    for (const key of Object.keys(page)) delete page[Number(key)];
    resetGestureDedupe();
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal("location", { search: "", pathname: "/", hash: "" });
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null, addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace(/^\/api/, "");
      if (init?.method === "POST") posts.push({ path, body: JSON.parse(String(init.body)) });
      const reply = path === "/sessions"
        ? { sessions: [{ id: "s1", title: "Work", cwd: "/w", provider: "claude", status: "running", timestamp: NOW.toISOString() }] }
        : path.endsWith("/history") ? { messages: [] } : {};
      return new Response(JSON.stringify(reply), { status: 200 });
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("shows a list and no swipe ever sends an answer", async () => {
    await boot();
    expect(page[2]).toContain("● Allow");
    expect(page[2]).toContain("○ Deny");
    await vi.advanceTimersByTimeAsync(1000);
    for (const swipe of [UP, DOWN, DOWN, UP, UP]) await gesture(swipe);
    expect(decisions()).toEqual([]);
  });

  it("tap arms, a second tap within 4 s sends exactly the chosen answer", async () => {
    await boot();
    await vi.advanceTimersByTimeAsync(1000);
    await gesture(DOWN); // cursor on Deny
    expect(page[2]).toContain("● Deny");
    await gesture(CLICK);
    expect(decisions()).toEqual([]);
    expect(page[3]).toBe("Tap again = Deny · Swipe/2× = cancel");
    await gesture(CLICK);
    expect(decisions()).toEqual([{ sessionId: "s1", decision: "deny" }]);
  });

  it("the timeout, a swipe and a double tap cancel an armed answer; a double tap does not exit then", async () => {
    await boot();
    await vi.advanceTimersByTimeAsync(1000);
    await gesture(CLICK);
    expect(page[3]).toContain("Tap again = Allow");
    await vi.advanceTimersByTimeAsync(4100);
    expect(page[3]).toBe("Tap = choose · Swipe · 2× = exit");
    await gesture(CLICK, 600);
    await gesture(DOWN, 600);
    expect(page[3]).toBe("Tap = choose · Swipe · 2× = exit");
    await gesture(CLICK, 600);
    expect(page[3]).toContain("Tap again");
    await gesture(DOUBLE, 600);
    expect(page[3]).toBe("Tap = choose · Swipe · 2× = exit");
    expect(exits).toEqual([]);
    // The tap after a cancel arms again; it does not send.
    await gesture(CLICK, 600);
    expect(decisions()).toEqual([]);
  });

  it("a new request starts on Allow, unarmed", async () => {
    await boot();
    await vi.advanceTimersByTimeAsync(1000);
    await gesture(DOWN);
    await gesture(CLICK);
    expect(page[3]).toContain("Tap again = Deny");
    FakeEventSource.last?.onmessage?.({ data: JSON.stringify({ type: "permission_request", tool: "Edit", input: { file_path: "/etc/hosts" } }) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(page[2]).toContain("● Allow");
    expect(page[3]).toBe("Tap = choose · Swipe · 2× = exit");
  });

  it("invertScroll swaps the swipe directions of the list", async () => {
    await boot({ invertScroll: true });
    await vi.advanceTimersByTimeAsync(1000);
    await gesture(DOWN, 600); // inverted: DOWN event = swipe up = towards Allow (already there)
    expect(page[2]).toContain("● Allow");
    await gesture(UP, 600); // inverted: UP event = swipe down = Deny
    expect(page[2]).toContain("● Deny");
    expect(decisions()).toEqual([]);
  });

  it("without the setting a SCROLL_BOTTOM event moves down", async () => {
    await boot();
    await vi.advanceTimersByTimeAsync(1000);
    await gesture(DOWN, 600);
    expect(page[2]).toContain("● Deny");
  });

  it("Hilfe is the last row of the session list again and opens a page with the gestures", async () => {
    await boot();
    FakeEventSource.last?.onmessage?.({ data: JSON.stringify({ type: "permission_result", decision: "deny" }) });
    FakeEventSource.last?.onmessage?.({ data: JSON.stringify({ type: "result" }) });
    await vi.advanceTimersByTimeAsync(1000);
    await gesture(9, 300); // hold: session list
    expect(page[1]).toBe("AGENT · sessions (1)");
    await gesture(DOWN, 600); // Work -> Help
    expect(page[2]).toContain("> Help");
    await gesture(CLICK, 300);
    expect(page[1]).toBe("AGENT · help");
    expect(page[2]).toContain("Tap = choose, tap again = send");
    expect(page[3]).toBe("Tap = close · 2× = back");
    await gesture(DOUBLE, 300);
    expect(page[1]).toBe("AGENT · sessions (1)");
  });

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    await boot();
    expect(menus).toEqual([]);
    FakeEventSource.last?.onmessage?.({ data: JSON.stringify({ type: "permission_result", decision: "deny" }) });
    await vi.advanceTimersByTimeAsync(500);
    await gesture(9, 300); // hold: session list, rebuilds nothing with a menu
    expect(menus).toEqual([]);
  });

  it("hold on a working agent only arms the interrupt; a tap sends it, anything else cancels", async () => {
    await boot();
    FakeEventSource.last?.onmessage?.({ data: JSON.stringify({ type: "permission_result", decision: "deny" }) });
    await vi.advanceTimersByTimeAsync(1000);
    await gesture(9, 700);
    expect(page[3]).toBe("Tap again = interrupt · Swipe/2× = cancel");
    expect(posts.filter((post) => post.path === "/interrupt")).toEqual([]);
    await gesture(DOUBLE, 700);
    expect(page[3]).not.toContain("Tap again");
    expect(exits).toEqual([]);
    await gesture(9, 700);
    await gesture(CLICK, 700);
    expect(posts.filter((post) => post.path === "/interrupt")).toEqual([{ path: "/interrupt", body: { sessionId: "s1" } }]);
  });
});

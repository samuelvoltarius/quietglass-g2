import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLICK, DOUBLE_TAP, FakeRoot, HOLD, SCROLL_DOWN, SCROLL_UP, fakeBridge } from "./fake-bridge";

// QIS v1 on the real app against a fake bridge: the actions arm before they run, 2x goes back, hold does nothing.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const REPORT = {
  name: "nas",
  metrics: [{ id: "cpu", label: "CPU", value: 10, unit: "%", warn: 85, critical: 95 }],
  actions: [{ id: "door", label: "Lock door", confirm: true }],
};
const FAKE_TIMERS: { toFake: ("setTimeout" | "clearTimeout" | "setInterval" | "clearInterval")[] } = { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] };

describe("QIS v1: actions are armed, 2× goes back", () => {
  let replies: ((body: unknown) => void)[];
  let actionPosts: number;

  beforeEach(() => {
    replies = [];
    actionPosts = 0;
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("document", { getElementById: (id: string) => (id === "app" ? new FakeRoot() : null) });
    vi.stubGlobal("fetch", vi.fn((url: string) => new Promise<Response>((resolve) => {
      if (String(url).endsWith("/action")) {
        actionPosts += 1;
        resolve(new Response("{}", { status: 200 }));
        return;
      }
      replies.push((body) => resolve(new Response(JSON.stringify(body), { status: 200 })));
    })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Boots, lets the source answer, and opens the actions page from the start page. */
  async function openActions(): Promise<ReturnType<typeof fakeBridge>> {
    const fake = fakeBridge();
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    replies[0]?.(REPORT);
    await vi.waitFor(() => expect(fake.state.body).toContain("Actions"));
    expect(fake.state.body.split("\n")).toEqual(["● nas", "  Actions"]);
    fake.gesture(SCROLL_DOWN);
    await vi.waitFor(() => expect(fake.state.body).toContain("● Actions"));
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.body).toContain("nas Lock door"));
    return fake;
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

  it("the start page offers at most three entries: overview, problems, actions", async () => {
    const fake = await openActions();
    expect(fake.state.header).toBe("Actions · ● live");
    fake.gesture(DOUBLE_TAP);
    await vi.waitFor(() => expect(fake.state.header).toBe("Status · ● live"));
    expect(fake.state.body.split("\n").length).toBeLessThanOrEqual(3);
  });

  it("2× on the actions page goes back to the start page and never leaves the app", async () => {
    const fake = await openActions();
    fake.gesture(DOUBLE_TAP);
    await vi.waitFor(() => expect(fake.state.footer).toContain("exit"));
    expect(fake.state.shutdowns).toBe(0);
    expect(actionPosts).toBe(0);
  });

  it("hold does nothing, on the actions page and on the start page", async () => {
    const fake = await openActions();
    fake.gesture(HOLD);
    await settle();
    expect(fake.state.body).toContain("nas Lock door");
    expect(actionPosts).toBe(0);
    fake.gesture(DOUBLE_TAP);
    // The footer is written last: once it says "exit" the start page is complete.
    await vi.waitFor(() => expect(fake.state.footer).toContain("exit"));
    const body = fake.state.body;
    fake.gesture(HOLD);
    await settle();
    expect(fake.state.body).toBe(body);
    expect(fake.state.shutdowns).toBe(0);
  });

  it("the first tap only arms, a swipe cancels, the second single tap runs", async () => {
    const fake = await openActions();
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.footer).toBe("Tap again = run · Swipe/2× = cancel"));
    expect(actionPosts).toBe(0);

    fake.gesture(SCROLL_DOWN);
    await vi.waitFor(() => expect(fake.state.footer).toBe("Tap = choose · Swipe = list · 2× = back"));
    fake.gesture(SCROLL_UP);
    expect(actionPosts).toBe(0);

    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.footer).toBe("Tap again = run · Swipe/2× = cancel"));
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(actionPosts).toBe(1));
  });

  it("an armed action lapses after 4 s, and 2× cancels it without leaving", async () => {
    vi.useFakeTimers({ ...FAKE_TIMERS });
    const fake = await openActions();
    fake.gesture(CLICK);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.state.footer).toBe("Tap again = run · Swipe/2× = cancel");
    await vi.advanceTimersByTimeAsync(4100);
    expect(fake.state.footer).toBe("Tap = choose · Swipe = list · 2× = back");

    fake.gesture(CLICK); // armed from scratch: not a confirmation
    await vi.advanceTimersByTimeAsync(10);
    expect(actionPosts).toBe(0);
    fake.gesture(DOUBLE_TAP);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.state.shutdowns).toBe(0);
    expect(actionPosts).toBe(0);
  });

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    const fake = await openActions();
    expect(fake.state.pages.length).toBeGreaterThan(0);
    for (const page of fake.state.pages) expect(page.menuObject).toBeUndefined();
  });
});

describe("QIS v1.2: marking a problem as seen is armed", () => {
  let replies: ((body: unknown) => void)[];

  beforeEach(() => {
    replies = [];
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("document", { getElementById: (id: string) => (id === "app" ? new FakeRoot() : null) });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      replies.push((body) => resolve(new Response(JSON.stringify(body), { status: 200 })));
    })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const PROBLEM = { name: "nas", metrics: [{ id: "disk", label: "Disk", value: 97, unit: "%", warn: 85, critical: 95 }] };
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

  async function problemList(): Promise<ReturnType<typeof fakeBridge>> {
    const fake = fakeBridge();
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    replies[0]?.(PROBLEM);
    await vi.waitFor(() => expect(fake.state.body).toContain("Problems · 1"));
    fake.gesture(SCROLL_DOWN);
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.body).toContain("nas Disk 97%"));
    return fake;
  }

  it("the first tap only asks; the second tap within 4 s acknowledges", async () => {
    const fake = await problemList();
    expect(fake.state.footer).toBe("Tap = seen · Swipe = list · 2× = back");
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.footer).toBe("Tap again = seen · Swipe/2× = cancel"));
    expect(fake.state.body).not.toContain("(ack)");
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.body).toContain("(ack)"));
  });

  it("2× and a swipe cancel the question, and 2× does not leave the app", async () => {
    const fake = await problemList();
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.footer).toContain("Tap again"));
    fake.gesture(DOUBLE_TAP);
    await vi.waitFor(() => expect(fake.state.footer).toContain("exit"));
    expect(fake.state.shutdowns).toBe(0);
    fake.gesture(SCROLL_DOWN); // to Problems again
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.header).toBe("Problems · ● live"));
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.footer).toContain("Tap again"));
    fake.gesture(SCROLL_DOWN);
    await vi.waitFor(() => expect(fake.state.footer).toBe("Tap = seen · Swipe = list · 2× = back"));
    await settle();
    expect(fake.state.body).not.toContain("(ack)");
  });

  it("the question lapses after 4 s", async () => {
    vi.useFakeTimers({ ...FAKE_TIMERS });
    const fake = await problemList();
    fake.gesture(CLICK);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.state.footer).toBe("Tap again = seen · Swipe/2× = cancel");
    await vi.advanceTimersByTimeAsync(4100);
    expect(fake.state.footer).toBe("Tap = seen · Swipe = list · 2× = back");
    fake.gesture(CLICK); // a new question, not a confirmation
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.state.body).not.toContain("(ack)");
  });
});

describe("QIS v1.2: first start is a demo", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("document", { getElementById: (id: string) => (id === "app" ? new FakeRoot() : null) });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("shows sample data and the hint without any source, and never polls", async () => {
    const fake = fakeBridge([]);
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.waitFor(() => expect(fake.state.body).toContain("Demo · set up the connection on the phone"));
    expect(fake.state.header).toBe("Status · Demo");
    // Four sample servers, one problem, one action offered: the servers hang under the overview, the rest scrolls.
    expect(fake.state.body.split("\n")).toEqual([
      "● All servers · 3/4 ok", "    Spark · ok", "    Pi5 · ok", "    ns1 · warning", "Demo · set up the connection on the phone",
    ]);
    expect(fake.state.body).not.toContain("No sources configured.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the sample opens as a cockpit too, and the demo never writes sources", async () => {
    const fake = fakeBridge([]);
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.waitFor(() => expect(fake.state.body).toContain("All servers"));
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.kind).toBe("cockpit"));
    await vi.waitFor(() => expect(fake.state.images).toBe(4));
    expect(fake.kv.has("quietglass.statusglass.v1")).toBe(false);
  });
});

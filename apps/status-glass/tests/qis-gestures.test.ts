import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// QIS v1 on the real app against a fake bridge: the menu arms before it runs, 2x goes back.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

class FakeRoot {
  innerHTML = "";
  querySelector(): { value: string; checked: boolean; addEventListener(): void } {
    return { value: "", checked: false, addEventListener: () => undefined };
  }
  querySelectorAll(): never[] { return []; }
}

function fakeBridge(sources: { id: string; name: string; url: string }[] = [{ id: "s1", name: "nas", url: "https://nas.test/status" }]) {
  let onEvent: ((event: unknown) => void) | undefined;
  const state = { shutdowns: 0, body: "", footer: "" };
  const record = (id: number | undefined, content: string | undefined): void => {
    if (id === 2) state.body = content ?? "";
    if (id === 3) state.footer = content ?? "";
  };
  const pages: { menuObject?: { menuItems?: { itemName?: string; itemID?: number }[] } }[] = [];
  const page = async (p: { textObject?: { containerID?: number; content?: string }[] }): Promise<boolean> => {
    for (const text of p.textObject ?? []) record(text.containerID, text.content);
    return true;
  };
  const bridge = {
    getLocalStorage: async (key: string) => key === "quietglass.statusglass.ui.v1" ? "" : JSON.stringify({ sources, pollSeconds: 30, invertScroll: false }),
    setLocalStorage: async () => true,
    rebuildPageContainer: page,
    createStartUpPageContainer: async (p: { textObject?: { containerID?: number; content?: string }[]; menuObject?: { menuItems?: { itemName?: string; itemID?: number }[] } }) => { pages.push(p); await page(p); return 0; },
    updateImageRawData: async () => "success",
    textContainerUpgrade: async (upgrade: { containerID?: number; content?: string }) => { record(upgrade.containerID, upgrade.content); return true; },
    shutDownPageContainer: (): Promise<boolean> => { state.shutdowns += 1; return Promise.resolve(true); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { onEvent = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, state, pages,
    menu: (itemID: number) => { resetGestureDedupe(); onEvent?.({ menuItemClickEvent: { itemID } }); },
    ready: () => onEvent !== undefined,
    gesture: (eventType: number) => { resetGestureDedupe(); onEvent?.({ sysEvent: { eventType, eventSource: 1 } }); },
  };
}

const CLICK = 0;
const SCROLL_UP = 1;
const SCROLL_DOWN = 2;
const DOUBLE_TAP = 3;
const HOLD = 9;
const REPORT = {
  name: "nas",
  metrics: [{ id: "cpu", label: "CPU", value: 10, unit: "%", warn: 85, critical: 95 }],
  actions: [{ id: "door", label: "Lock door", confirm: true }],
};

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

  async function openMenu(): Promise<ReturnType<typeof fakeBridge>> {
    const fake = fakeBridge();
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    replies[0]?.(REPORT);
    await vi.waitFor(() => expect(fake.state.body).toContain("nas"));
    fake.gesture(HOLD);
    await vi.waitFor(() => expect(fake.state.body).toContain("nas Lock door"));
    return fake;
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

  it("2× in the menu goes back to the overview and never leaves the app", async () => {
    const fake = await openMenu();
    fake.gesture(DOUBLE_TAP);
    await vi.waitFor(() => expect(fake.state.footer).toContain("exit"));
    expect(fake.state.shutdowns).toBe(0);
    expect(actionPosts).toBe(0);
  });

  it("hold in the menu does nothing", async () => {
    const fake = await openMenu();
    fake.gesture(HOLD);
    await settle();
    expect(fake.state.body).toContain("nas Lock door");
    expect(actionPosts).toBe(0);
  });

  it("the first tap only arms, a swipe cancels, the second single tap runs", async () => {
    const fake = await openMenu();
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.footer).toBe("Tap again = run · Swipe/2× = cancel"));
    expect(actionPosts).toBe(0);

    fake.gesture(SCROLL_DOWN);
    await vi.waitFor(() => expect(fake.state.footer).toBe("Tap = open · Swipe = list · 2× = back"));
    fake.gesture(SCROLL_UP);
    await vi.waitFor(() => expect(fake.state.footer).toBe("Tap = choose · Swipe = list · 2× = back"));
    expect(actionPosts).toBe(0);

    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.footer).toBe("Tap again = run · Swipe/2× = cancel"));
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(actionPosts).toBe(1));
  });

  it("an armed action lapses after 4 s, and 2× cancels it without leaving", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const fake = await openMenu();
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

  it("the actions list ends with refresh and a help row; a tap on it opens the help, 2× goes back to the actions", async () => {
    const fake = await openMenu();
    fake.gesture(SCROLL_DOWN); // refresh
    fake.gesture(SCROLL_DOWN); // help
    await vi.waitFor(() => expect(fake.state.body).toContain("> " + "  Help"));
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.footer).toBe("2× = back"));
    expect(fake.state.body).toContain("Hold: menu (actions, help) · details: seen");
    fake.gesture(CLICK);
    await settle();
    expect(fake.state.footer).toBe("2× = back");
    fake.gesture(DOUBLE_TAP);
    await vi.waitFor(() => expect(fake.state.body).toContain("nas Lock door"));
    expect(fake.state.shutdowns).toBe(0);
    expect(actionPosts).toBe(0);
  });

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    const fake = await openMenu();
    expect(fake.pages.length).toBeGreaterThan(0);
    for (const page of fake.pages) expect(page.menuObject).toBeUndefined();
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

  async function overview(): Promise<ReturnType<typeof fakeBridge>> {
    const fake = fakeBridge();
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    replies[0]?.(PROBLEM);
    await vi.waitFor(() => expect(fake.state.body).toContain("nas Disk 97%"));
    return fake;
  }

  it("the first tap only asks; the second tap within 4 s acknowledges", async () => {
    const fake = await overview();
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.footer).toBe("Tap again = seen · Swipe/2× = cancel"));
    expect(fake.state.body).not.toContain("(ack)");
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.body).toContain("(ack)"));
  });

  it("2× and a swipe cancel the question, and 2× does not leave the app", async () => {
    const fake = await overview();
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.footer).toContain("Tap again"));
    fake.gesture(DOUBLE_TAP);
    await vi.waitFor(() => expect(fake.state.footer).toContain("exit"));
    expect(fake.state.shutdowns).toBe(0);
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.footer).toContain("Tap again"));
    fake.gesture(SCROLL_DOWN);
    await vi.waitFor(() => expect(fake.state.footer).toContain("exit"));
    await settle();
    expect(fake.state.body).not.toContain("(ack)");
  });

  it("the question lapses after 4 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const fake = await overview();
    fake.gesture(CLICK);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.state.footer).toBe("Tap again = seen · Swipe/2× = cancel");
    await vi.advanceTimersByTimeAsync(4100);
    expect(fake.state.footer).toContain("exit");
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
    expect(fake.state.body).toContain("Front door unlocked");
    expect(fake.state.body).not.toContain("No sources configured.");
    expect(fetch).not.toHaveBeenCalled();
  });
});

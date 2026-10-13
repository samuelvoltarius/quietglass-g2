import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app against a fake bridge, so polling, removal and the close
// path can be checked without glasses or a homelab.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

// tsconfig carries no node types; reach the process object structurally.
const nodeProcess = (globalThis as unknown as {
  process: {
    on(event: string, listener: (reason: unknown) => void): void;
    off(event: string, listener: (reason: unknown) => void): void;
  };
}).process;

/** Just enough DOM for the phone page's "Remove" buttons. */
class FakeElement {
  value = "";
  checked = false;
  readonly dataset: Record<string, string> = {};
  readonly #listeners = new Map<string, ((event: unknown) => void)[]>();
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  fire(type: string): void { for (const listener of this.#listeners.get(type) ?? []) listener({ target: this }); }
}

class FakeRoot {
  #html = "";
  readonly elements = new Map<string, FakeElement>();
  removeButtons: FakeElement[] | null = null;
  set innerHTML(html: string) { this.#html = html; this.removeButtons = null; }
  get innerHTML(): string { return this.#html; }
  querySelector(selector: string): FakeElement {
    let element = this.elements.get(selector);
    if (!element) { element = new FakeElement(); this.elements.set(selector, element); }
    return element;
  }
  querySelectorAll(selector: string): FakeElement[] {
    if (selector !== ".remove") return [];
    // Built from the markup, and the same elements until the next rebuild.
    if (this.removeButtons) return this.removeButtons;
    this.removeButtons = [...this.innerHTML.matchAll(/class="remove" data-id="([^"]+)"/g)].map((match) => {
      const button = new FakeElement();
      button.dataset["id"] = match[1] ?? "";
      return button;
    });
    return this.removeButtons;
  }
}

// Plain functions rather than vi.fn: spies attach handlers to returned
// promises, which would hide exactly the rejections these tests look for.
function fakeBridge(sources: { id: string; name: string; url: string }[] = [{ id: "s1", name: "nas", url: "https://nas.test/status" }], options: { createHangs?: boolean } = {}) {
  let onEvent: ((event: unknown) => void) | undefined;
  const state = { shutdowns: 0, shutdownFails: false, confirm: true, modes: [] as (number | undefined)[], body: "", footer: "", draws: 0 };
  const record = (id: number | undefined, content: string | undefined): void => {
    if (id === 2) { state.body = content ?? ""; state.draws += 1; }
    if (id === 3) state.footer = content ?? "";
  };
  const bridge = {
    getLocalStorage: async () => JSON.stringify({ sources, pollSeconds: 30, invertScroll: false }),
    setLocalStorage: async () => true,
    rebuildPageContainer: async (page: { textObject?: { containerID?: number; content?: string }[] }) => {
      for (const text of page.textObject ?? []) record(text.containerID, text.content);
      return true;
    },
    createStartUpPageContainer: async (page: { textObject?: { containerID?: number; content?: string }[] }) => {
      if (options.createHangs) return new Promise<number>(() => undefined);
      for (const text of page.textObject ?? []) record(text.containerID, text.content);
      return 0;
    },
    updateImageRawData: async () => "success",
    textContainerUpgrade: async (upgrade: { containerID?: number; content?: string }) => {
      record(upgrade.containerID, upgrade.content);
      return true;
    },
    shutDownPageContainer: (mode?: number): Promise<boolean> => {
      state.shutdowns += 1;
      state.modes.push(mode);
      return state.shutdownFails ? Promise.reject(new Error("page already gone")) : Promise.resolve(state.confirm);
    },
    onEvenHubEvent: (callback: (event: unknown) => void) => { onEvent = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, state,
    ready: () => onEvent !== undefined,
    gesture: (eventType: number) => onEvent?.({ sysEvent: { eventType, eventSource: 1 } }),
  };
}

const DOUBLE_TAP = 3;
const HOLD = 9;
const REPORT = { name: "nas", metrics: [{ id: "disk", label: "Disk", value: 97, unit: "%", warn: 85, critical: 95 }] };

describe("status-glass lifecycle", () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  let replies: ((body: unknown) => void)[];
  let root: FakeRoot;
  let savedLocale: string | null;

  beforeEach(() => {
  resetGestureDedupe();
    unhandled = [];
    replies = [];
    root = new FakeRoot();
    // The text checks below are English: pin the language rather than
    // inheriting whatever the machine running the tests reports.
    savedLocale = null;
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("localStorage", {
      getItem: () => savedLocale,
      setItem: (_key: string, value: string) => { savedLocale = value; },
    });
    nodeProcess.on("unhandledRejection", onUnhandled);
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("document", { getElementById: (id: string) => (id === "app" ? root : null) });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      replies.push((body) => resolve(new Response(JSON.stringify(body), { status: 200 })));
    })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(unhandled).toEqual([]);
  });

  async function boot(fake: ReturnType<typeof fakeBridge>): Promise<void> {
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  it("does not bring a removed source back when its last answer arrives", async () => {
    // Regression: the answer to a poll started before the removal was stored
    // under the removed id, so the source reappeared on the glasses.
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(replies).toHaveLength(1));

    root.querySelectorAll(".remove")[0]?.fire("click");
    await vi.waitFor(() => expect(fake.state.body).toContain("No sources configured."));
    replies[0]?.(REPORT);
    await settle();
    expect(fake.state.body).toContain("No sources configured.");
    expect(fake.state.body).not.toContain("Disk");
  });

  it("keeps a single polling loop when polling restarts mid-request", async () => {
    // Regression: a hold (refresh) while a poll was in flight left the old
    // poll to schedule its own next round, so every refresh added a loop.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    fake.gesture(HOLD);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    replies[1]?.(REPORT);
    replies[0]?.(REPORT);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(30000);
    expect(replies).toHaveLength(3);
  });

  it("closes cleanly once the exit dialog is confirmed: no polling afterwards", async () => {
    // Regression: a poll in flight at the time re-armed its timer after the app had closed.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(replies).toHaveLength(1));

    fake.gesture(DOUBLE_TAP);
    expect(fake.state.modes).toEqual([1]);
    await vi.advanceTimersByTimeAsync(0);
    replies[0]?.(REPORT);
    await vi.advanceTimersByTimeAsync(120000);
    expect(replies).toHaveLength(1);
  });

  it("keeps polling when the exit dialog is cancelled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const fake = fakeBridge();
    fake.state.confirm = false;
    await boot(fake);
    await vi.waitFor(() => expect(replies).toHaveLength(1));

    fake.gesture(DOUBLE_TAP);
    expect(fake.state.modes).toEqual([1]);
    await vi.advanceTimersByTimeAsync(0);
    replies[0]?.(REPORT);
    await vi.advanceTimersByTimeAsync(30000);
    expect(replies).toHaveLength(2);
  });

  it("keeps polling when the exit call rejects, with no unhandled rejection", async () => {
    // Regression: shutDownPageContainer's rejection was unhandled. A rejected call shows no dialog, so the app stays.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const fake = fakeBridge();
    fake.state.shutdownFails = true;
    await boot(fake);
    await vi.waitFor(() => expect(replies).toHaveLength(1));

    fake.gesture(DOUBLE_TAP);
    expect(fake.state.shutdowns).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    replies[0]?.(REPORT);
    await vi.advanceTimersByTimeAsync(30000);
    expect(replies).toHaveLength(2);
  });

  it("redraws the glasses in German as soon as the phone switches language", async () => {
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    replies[0]?.({ name: "nas", metrics: [{ id: "load", label: "Load", value: 97.5, warn: 85, critical: 95 }] });
    await vi.waitFor(() => expect(fake.state.body).toContain("nas Load 97.5"));
    expect(fake.state.footer).toBe("tap = acknowledge");

    const picker = root.querySelector("#language");
    picker.value = "de";
    picker.fire("change");

    // No poll answers in between: the redraw comes from the switch itself.
    await vi.waitFor(() => expect(fake.state.footer).toBe("Tippen = gesehen"));
    expect(fake.state.body).toContain("nas Load 97,5");
    expect(replies).toHaveLength(1);
    expect(savedLocale).toBe("de");
    expect(root.innerHTML).toContain('<option value="de" selected>');
    expect(root.innerHTML).toContain("Quelle hinzufügen");
  });

  it("listens before the first page is up: a hung page set-up still lets a double tap leave", async () => {
    const fake = fakeBridge(undefined, { createHangs: true });
    await boot(fake);
    fake.gesture(DOUBLE_TAP);
    await vi.waitFor(() => expect(fake.state.shutdowns).toBe(1));
  });

  it("opens a machine in detail on tap, turns pages, acknowledges on hold and goes back on double tap", async () => {
    const fake = fakeBridge([
      { id: "a", name: "Spark", url: "https://a.test/status" },
      { id: "b", name: "Pi5", url: "https://b.test/status" },
    ]);
    await boot(fake);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    const host = (name: string) => ({ name, metrics: [
      { id: "cpu", label: "CPU", value: 12, unit: "%", warn: 85, critical: 95 },
      { id: "memory", label: "RAM", value: 45, unit: "%", warn: 85, critical: 95, detail: "54/119 GB" },
      { id: "disk:/", label: "/", value: 58, unit: "%", warn: 90, critical: 95, detail: "539/916 GB" },
      { id: "failed", label: "Failed units", value: 2, unit: "", warn: 1, detail: "a.mount, b.service" },
      { id: "uptime", label: "Up", value: 50, unit: "h" },
    ] });
    replies[0]?.(host("Spark"));
    replies[1]?.(host("Pi5"));
    await vi.waitFor(() => expect(fake.state.footer).toBe("tap = details · swipe = machine · hold = refresh"));

    fake.gesture(0);
    await vi.waitFor(() => expect(fake.state.footer).toBe("double tap = back · hold = ack · swipe = more"));
    await vi.waitFor(() => expect(fake.state.body).toContain("· 2 failed units"));
    expect(fake.state.body).toContain("a.mount, b.service");
    expect(fake.state.body).toContain("RAM 45% 54/119 GB");

    resetGestureDedupe();
    fake.gesture(HOLD);
    await vi.waitFor(() => expect(fake.state.body).toContain("2 failed units (ack)"));

    resetGestureDedupe();
    fake.gesture(DOUBLE_TAP);
    await vi.waitFor(() => expect(fake.state.footer).toBe("tap = details · swipe = machine · hold = refresh"));
    expect(fake.state.shutdowns).toBe(0);
  });
});

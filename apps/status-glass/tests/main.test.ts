import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLICK, DOUBLE_TAP, FakeRoot, SCROLL_DOWN, fakeBridge } from "./fake-bridge";

// Boots the real app against a fake bridge, so polling, removal, the cockpit's tiles and the close
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

const REPORT = { name: "nas", metrics: [{ id: "disk", label: "Disk", value: 97, unit: "%", warn: 85, critical: 95 }] };
const FAKE_TIMERS: { toFake: ("setTimeout" | "clearTimeout" | "setInterval" | "clearInterval")[] } = { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] };

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

    // Removing asks twice (QUS: the one dangerous button on the phone).
    root.querySelectorAll(".remove")[0]?.fire("click");
    expect(fake.state.body).toContain("nas");
    root.querySelectorAll(".remove")[0]?.fire("click");
    await vi.waitFor(() => expect(fake.state.body).toContain("No sources configured."));
    replies[0]?.(REPORT);
    await settle();
    expect(fake.state.body).toContain("No sources configured.");
    expect(fake.state.body).not.toContain("Disk");
  });

  it("starts on the start page: header Status · ● live, the overview, one footer line", async () => {
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    replies[0]?.({ name: "nas", metrics: [{ id: "cpu", label: "CPU", value: 10, unit: "%", warn: 85, critical: 95 }] });
    await vi.waitFor(() => expect(fake.state.header).toBe("Status · ● live"));
    expect(fake.state.kind).toBe("text");
    expect(fake.state.body).toBe("● nas");
    expect(fake.state.footer).toBe("Tap = open · Swipe = choose · 2× = exit");
  });

  it("keeps a single polling loop when polling restarts mid-request", async () => {
    // Regression: a refresh while a poll was in flight left the old
    // poll to schedule its own next round, so every refresh added a loop.
    vi.useFakeTimers({ ...FAKE_TIMERS });
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    fake.gesture(CLICK); // open the cockpit
    await vi.advanceTimersByTimeAsync(10);
    fake.gesture(CLICK); // a tap on the cockpit asks every source again
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    replies[1]?.(REPORT);
    replies[0]?.(REPORT);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(30000);
    expect(replies).toHaveLength(3);
  });

  it("closes cleanly once the system ends the app (sysEvent 7) after the exit dialog: no polling afterwards", async () => {
    // Regression: a poll in flight at the time re-armed its timer after the app had closed.
    vi.useFakeTimers({ ...FAKE_TIMERS });
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(replies).toHaveLength(1));

    fake.gesture(DOUBLE_TAP);
    expect(fake.state.modes).toEqual([1]);
    await vi.advanceTimersByTimeAsync(0);
    fake.gesture(7); // the user confirmed: the system ends the app
    replies[0]?.(REPORT);
    await vi.advanceTimersByTimeAsync(120000);
    expect(replies).toHaveLength(1);
  });

  it("keeps polling when the exit call resolves true (dialog shown, not confirmed)", async () => {
    vi.useFakeTimers({ ...FAKE_TIMERS });
    const fake = fakeBridge();
    fake.state.confirm = true;
    await boot(fake);
    await vi.waitFor(() => expect(replies).toHaveLength(1));

    fake.gesture(DOUBLE_TAP);
    expect(fake.state.modes).toEqual([1]);
    await vi.advanceTimersByTimeAsync(0);
    replies[0]?.(REPORT);
    await vi.advanceTimersByTimeAsync(30000);
    expect(replies).toHaveLength(2);
  });

  it("no timer, poll or stream draws while the exit dialog may be on screen; a single 2x right after restores the page first and asks the dialog only then", async () => {
    const fake = fakeBridge();
    // The call resolves true as soon as the dialog is SHOWN, whatever the user answers later.
    fake.state.confirm = true;
    await boot(fake);
    await vi.waitFor(() => expect(fake.state.body).not.toBe(""));
    await new Promise((done) => setTimeout(done, 20));
    const creates = fake.state.creates;
    fake.gesture(DOUBLE_TAP);
    await vi.waitFor(() => expect(fake.state.modes).toEqual([1]));
    const callsAtAsk = fake.state.draws + fake.state.creates + fake.state.images;
    await new Promise((done) => setTimeout(done, 1500));
    // Timers, polls and streams keep collecting data but make no page call while the dialog may be on screen.
    expect(fake.state.draws + fake.state.creates + fake.state.images).toBe(callsAtAsk);
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
    await new Promise((done) => setTimeout(done, 500));
    expect(order).toEqual(["create:start"]); // the dialog is not asked while the page is still being created
    releaseCreate();
    await new Promise((done) => setTimeout(done, 1500));
    expect(order).toEqual(["create:start", "create:done", "shutdown"]); // restore first, then the dialog, exactly once more
  });

  it("hardware order (step log): 4 = dialog up -> nothing drawn; 5 = dialog gone after No -> page up again without a gesture, polling on, next 2x asks", async () => {
    vi.useFakeTimers({ ...FAKE_TIMERS });
    const fake = fakeBridge();
    fake.state.confirm = true;
    await boot(fake);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    replies[0]?.(REPORT);
    await vi.advanceTimersByTimeAsync(0);
    fake.gesture(DOUBLE_TAP);
    await vi.advanceTimersByTimeAsync(70);
    expect(fake.state.modes).toEqual([1]);
    fake.gesture(4);                                         // the dialog is on screen
    const atShown = fake.state.draws + fake.state.creates + fake.state.images;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fake.state.draws + fake.state.creates + fake.state.images).toBe(atShown); // nothing drawn over the dialog
    const creates = fake.state.creates;
    fake.gesture(5);                                         // "No": the dialog is gone
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.state.creates).toBeGreaterThan(creates);     // page created again, no gesture needed
    await vi.advanceTimersByTimeAsync(30_000);
    expect(replies).toHaveLength(2);                         // polling was never paused
    fake.gesture(DOUBLE_TAP);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.state.modes).toEqual([1, 1]);                // the very first 2x opens the dialog again
  });

  it("a 2x on the start page while the app thinks it is in the background (5 without a dialog) comes back and asks again", async () => {
    vi.useFakeTimers({ ...FAKE_TIMERS });
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    replies[0]?.(REPORT);
    await vi.advanceTimersByTimeAsync(0);
    fake.gesture(5);                                         // genuine background: polling and drawing stop
    await vi.advanceTimersByTimeAsync(1_000);
    const pages = fake.state.creates + fake.state.rebuilds;
    fake.gesture(DOUBLE_TAP);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.state.creates + fake.state.rebuilds).toBeGreaterThan(pages); // the page is back first
    expect(fake.state.modes).toEqual([1]);                   // and the dialog is asked, not swallowed
  });

  it("keeps polling when the exit call rejects, with no unhandled rejection", async () => {
    // Regression: shutDownPageContainer's rejection was unhandled. A rejected call shows no dialog, so the app stays.
    vi.useFakeTimers({ ...FAKE_TIMERS });
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
    await vi.waitFor(() => expect(fake.state.body).toContain("Problems · 1"));
    expect(fake.state.footer).toBe("Tap = open · Swipe = choose · 2× = exit");

    const picker = root.querySelector("#language");
    picker.value = "de";
    picker.fire("change");

    // No poll answers in between: the redraw comes from the switch itself.
    await vi.waitFor(() => expect(fake.state.footer).toBe("Tippen = öffnen · Wischen = wählen · 2× = Ende"));
    expect(fake.state.body).toContain("Probleme · 1");
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

  const host = (name: string, cpu = 12) => ({ name, metrics: [
    { id: "cpu", label: "CPU", value: cpu, unit: "%", warn: 85, critical: 95 },
    { id: "memory", label: "RAM", value: 45, unit: "%", warn: 85, critical: 95, detail: "54/119 GB" },
    { id: "disk:/", label: "/", value: 58, unit: "%", warn: 90, critical: 95, detail: "539/916 GB" },
    { id: "failed", label: "Failed units", value: name === "Spark" ? 2 : 0, unit: "", warn: 1, detail: "a.mount, b.service" },
    { id: "uptime", label: "Up", value: 50, unit: "h" },
  ] });
  const TWO = [
    { id: "a", name: "Spark", url: "https://a.test/status" },
    { id: "b", name: "Pi5", url: "https://b.test/status" },
  ];

  it("walks start -> overview cockpit (four image tiles) -> one server -> back, and marks a problem as seen from the list", async () => {
    const fake = fakeBridge(TWO);
    await boot(fake);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    replies[0]?.(host("Spark"));
    replies[1]?.(host("Pi5"));
    await vi.waitFor(() => expect(fake.state.body).toContain("Problems · 1"));
    expect(fake.state.body.split("\n")).toEqual(["● All servers · 1/2 ok", "    Spark · warning", "    Pi5 · ok", "  Problems · 1"]);

    // Tap on the overview: the whole display becomes the cockpit, four tiles.
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.kind).toBe("cockpit"));
    await vi.waitFor(() => expect(fake.state.images).toBe(4));
    expect([...fake.state.byTile.keys()].sort()).toEqual([21, 22, 23, 24]);

    // Swipe: the first server; only changed tiles go out.
    const before = fake.state.images;
    fake.gesture(SCROLL_DOWN);
    await vi.waitFor(() => expect(fake.state.images).toBeGreaterThan(before));
    expect(fake.state.kind).toBe("cockpit");

    // 2× is back one level, never the exit dialog.
    fake.gesture(DOUBLE_TAP);
    await vi.waitFor(() => expect(fake.state.kind).toBe("text"));
    expect(fake.state.header).toBe("Status · ● live");
    expect(fake.state.shutdowns).toBe(0);

    // The problem list: first tap asks, the second one acknowledges.
    fake.gesture(SCROLL_DOWN); fake.gesture(SCROLL_DOWN); fake.gesture(SCROLL_DOWN);
    await vi.waitFor(() => expect(fake.state.body).toContain("● Problems · 1"));
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.footer).toBe("Tap = seen · Swipe = list · 2× = back"));
    expect(fake.state.header).toBe("Problems · ● live");
    expect(fake.state.body).toContain("● · Spark 2 failed units");
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.footer).toBe("Tap again = seen · Swipe/2× = cancel"));
    expect(fake.state.body).not.toContain("(ack)");
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.body).toContain("2 failed units (ack)"));
    fake.gesture(DOUBLE_TAP);
    await vi.waitFor(() => expect(fake.state.header).toBe("Status · ● live"));
    expect(fake.state.shutdowns).toBe(0);
  });

  it("sends only the tiles that changed: same state sends nothing, one changed figure sends one tile", async () => {
    // Only the date is frozen (at the start of a minute): a minute turning over mid-test would redraw the clock tile.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T14:05:00"));
    const fake = fakeBridge(TWO);
    await boot(fake);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    replies[0]?.(host("Spark"));
    replies[1]?.(host("Pi5"));
    await vi.waitFor(() => expect(fake.state.body).toContain("Problems · 1"));
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.images).toBe(4));
    await settle();

    // Tap on the cockpit asks again; the servers answer with exactly the same readings: nothing goes to the glasses.
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(replies).toHaveLength(4));
    replies[2]?.(host("Spark"));
    replies[3]?.(host("Pi5"));
    await settle(); await settle();
    expect(fake.state.images).toBe(4);

    // The highest CPU changes: that is one figure in the lower right half, so one tile.
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(replies).toHaveLength(6));
    replies[4]?.(host("Spark"));
    replies[5]?.(host("Pi5", 40));
    await vi.waitFor(() => expect(fake.state.images).toBe(5));
    await settle();
    expect(fake.state.images).toBe(5);
    expect(fake.state.byTile.get(24)).toBe(2);
  });

  it("writes no tile once the exit dialog may be up: a transfer held back stays the last one", async () => {
    let hold = false;
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const fake = fakeBridge(TWO, { onImage: () => (hold ? gate : undefined) });
    await boot(fake);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    replies[0]?.(host("Spark"));
    replies[1]?.(host("Pi5"));
    await vi.waitFor(() => expect(fake.state.body).toContain("Problems · 1"));
    hold = true;
    fake.gesture(CLICK); // the cockpit: its first tile is held back on the way to the glasses
    await vi.waitFor(() => expect(fake.state.kind).toBe("cockpit"));
    await settle();
    fake.gesture(DOUBLE_TAP);                        // back to the start page ...
    await vi.waitFor(() => expect(fake.state.kind).toBe("text"));
    fake.gesture(DOUBLE_TAP);                        // ... and the exit dialog
    await vi.waitFor(() => expect(fake.state.modes).toEqual([1]));
    const writes = fake.state.images;
    release();
    await settle(); await settle();
    // Only the transfer that was already on its way finished; nothing new started while the dialog is up.
    expect(fake.state.images).toBeLessThanOrEqual(writes + 1);
    const atDialog = fake.state.images;
    replies.length = 0;
    await new Promise((done) => setTimeout(done, 300));
    expect(fake.state.images).toBe(atDialog);
  });

  it("stops polling while in the background and starts again on return", async () => {
    vi.useFakeTimers({ ...FAKE_TIMERS });
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    replies[0]?.(REPORT);
    await vi.advanceTimersByTimeAsync(0);
    fake.gesture(5);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(replies).toHaveLength(1);
    const creates = fake.state.creates;
    fake.gesture(4);
    await vi.advanceTimersByTimeAsync(10);
    expect(replies).toHaveLength(2);
    expect(fake.state.creates + fake.state.rebuilds).toBeGreaterThan(creates);
  });

  it("comes back to the open cockpit after a restart (phone locked, app unloaded)", async () => {
    const kv = new Map<string, string>();
    const first = fakeBridge(TWO, { kv });
    await boot(first);
    first.gesture(CLICK); // the overview cockpit
    await vi.waitFor(() => expect(first.state.kind).toBe("cockpit"));
    first.gesture(SCROLL_DOWN); // second page: the first server
    first.gesture(SCROLL_DOWN); // third page: the second server
    await settle();
    first.gesture(7);
    expect(kv.get("quietglass.statusglass.ui.v2")).toContain('"screen":"cockpit"');
    expect(kv.get("quietglass.statusglass.ui.v2")).toContain('"page":2');

    const second = fakeBridge(TWO, { kv });
    await boot(second);
    await vi.waitFor(() => expect(second.state.kind).toBe("cockpit"));
    await vi.waitFor(() => expect(second.state.images).toBe(4));
  });
});

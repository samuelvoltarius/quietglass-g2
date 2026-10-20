import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app against a fake bridge, so request ordering and the close
// path can be checked without glasses or a network.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
// The cockpit is a picture: what it says is read from the models handed to the composer.
interface SeenModel { title: string; headline: string; direction: string; caption: string; hint: string; cells: { label: string; value: string }[] }
const cockpit = vi.hoisted(() => ({ models: [] as SeenModel[] }));
vi.mock("../src/cockpit/compose", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/cockpit/compose")>();
  return { ...real, composeTiles: (model: SeenModel, backend: never) => { cockpit.models.push(model); return real.composeTiles(model as never, backend); } };
});
/** Everything the last cockpit picture says, lower case. */
const pictured = (): string => {
  const m = cockpit.models.at(-1);
  return m ? [m.headline, m.direction, m.caption, m.hint, ...m.cells.map((c) => c.value)].join("\n").toLowerCase() : "";
};
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

// Plain functions rather than vi.fn: spies attach handlers to returned
// promises, which would hide exactly the rejections these tests look for.
function fakeBridge() {
  let onEvent: ((event: unknown) => void) | undefined;
  const state = { creates: 0, shutdowns: 0, shutdownFails: false, confirm: true, modes: [] as (number | undefined)[], draws: 0, header: "", body: "", footer: "" };
  const record = (id: number | undefined, content: string | undefined): void => {
    state.draws += 1;
    if (id === 1) state.header = content ?? "";
    if (id === 2) state.body = content ?? "";
    if (id === 3) state.footer = content ?? "";
  };
  const bridge = {
    getLocalStorage: async () => JSON.stringify({
      backend: "motis", motisUrl: "https://motis.test", oebbUrl: "http://127.0.0.1:8079/oebb", refreshSeconds: 30,
    }),
    setLocalStorage: async () => true,
    // Like the real glasses: a rebuild is accepted and replaces the page.
    rebuildPageContainer: async (page: { textObject?: { containerID?: number; content?: string }[] }) => {
      for (const text of page.textObject ?? []) record(text.containerID, text.content);
      return true;
    },
    createStartUpPageContainer: async (page: { textObject?: { containerID?: number; content?: string }[] }) => {
      state.creates += 1;
      for (const text of page.textObject ?? []) record(text.containerID, text.content);
      return 0;
    },
    textContainerUpgrade: async (upgrade: { containerID?: number; content?: string }) => {
      record(upgrade.containerID, upgrade.content);
      return true;
    },
    updateImageRawData: async () => "success",
    startAppLocationUpdates: async () => true,
    stopAppLocationUpdates: async () => true,
    getAppLocation: async () => ({ latitude: 47.8057, longitude: 13.0429 }),
    shutDownPageContainer: (mode?: number): Promise<boolean> => {
      state.shutdowns += 1;
      state.modes.push(mode);
      return state.shutdownFails ? Promise.reject(new Error("page already gone")) : Promise.resolve(state.confirm);
    },
    onAppLocationChanged: () => () => undefined,
    onEvenHubEvent: (callback: (event: unknown) => void) => { onEvent = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, state,
    ready: () => onEvent !== undefined,
    gesture: (eventType: number) => onEvent?.({ sysEvent: { eventType, eventSource: 1 } }),
    menu: (itemID: number) => onEvent?.({ menuItemClickEvent: { itemID } }),
  };
}

const STOPS = [
  { stopId: "A", name: "Alpha Platz", lat: 47.8058, lon: 13.0430 },
  { stopId: "B", name: "Bravo Gasse", lat: 47.8070, lon: 13.0440 },
];

/**
 * Two departures to the same place. The first one is drawn big (pictures);
 * the second one is a text row, which is what the fake glasses can read.
 */
function stopTimes(headsign: string): unknown {
  const at = (minutes: number): string => new Date(Date.now() + minutes * 60000).toISOString();
  return {
    stopTimes: [5, 9].map((minutes) => ({
      tripId: `trip-${headsign}-${minutes}`, routeShortName: "6", headsign, realTime: false,
      place: { scheduledDeparture: at(minutes), departure: at(minutes) },
    })),
  };
}

describe("nextstop lifecycle", () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  /** Departure replies, keyed by stop, released by the test in any order. */
  let pending: { stopId: string; reply: (body: unknown) => void }[];

  beforeEach(() => {
  resetGestureDedupe();
    unhandled = [];
    pending = [];
    cockpit.models.length = 0;
    nodeProcess.on("unhandledRejection", onUnhandled);
    vi.stubGlobal("document", { getElementById: () => null });
    vi.stubGlobal("location", { search: "" });
    // The assertions below read the reviewed German text, so the device says German.
    vi.stubGlobal("navigator", { language: "de-AT" });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("fetch", vi.fn((input: string) => {
      const url = new URL(input);
      if (url.pathname === "/api/v1/map/stops") {
        return Promise.resolve(new Response(JSON.stringify(STOPS), { status: 200 }));
      }
      return new Promise<Response>((resolve) => {
        pending.push({
          stopId: url.searchParams.get("stopId") ?? "",
          reply: (body) => resolve(new Response(JSON.stringify(body), { status: 200 })),
        });
      });
    }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    vi.useRealTimers();
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

  it("never shows one stop's departures under another stop's name", async () => {
    // Regression: holding to switch stops while the first board was still
    // loading let the slower, older reply overwrite the newer one.
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(pending.map((p) => p.stopId)).toEqual(["A"]));
    fake.gesture(0); // start page: tap opens the departures

    fake.menu(10); // menu "Andere Haltestelle" (hold now starts the voice destination)
    await vi.waitFor(() => expect(pending.map((p) => p.stopId)).toEqual(["A", "B"]));

    pending[1]?.reply(stopTimes("Bravo-Ziel"));
    await vi.waitFor(() => expect(pictured()).toContain("bravo-ziel"));
    pending[0]?.reply(stopTimes("Alpha-Ziel"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(pictured()).toContain("bravo gasse");
    expect(pictured()).toContain("bravo-ziel");
    expect(pictured()).not.toContain("alpha-ziel");
  });

  it("works straight after install: no saved settings means Transitous, no proxy", async () => {
    const fake = fakeBridge();
    (fake.bridge as { getLocalStorage: () => Promise<string> }).getLocalStorage = async () => "";
    await boot(fake);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const hosts = (vi.mocked(fetch).mock.calls as unknown as [string][]).map(([url]) => new URL(url).origin);
    expect(new Set(hosts)).toEqual(new Set(["https://api.transitous.org"]));
  });

  it("asks for the location on the glasses when there is none", async () => {
    const fake = fakeBridge();
    (fake.bridge as { getAppLocation: () => Promise<unknown> }).getAppLocation = async () => null;
    await boot(fake);
    await vi.waitFor(() => expect(fake.state.body).toContain("Abfahrten"));
    fake.gesture(0); // the departures: "Warte auf deinen Standort" is the bold picture line; the hint is text.
    await vi.waitFor(() => expect(fake.state.body).toContain("Erlaube den Standort in der Even-App"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("follows a bus after a tap on the board and stays responsive", async () => {
    // Alfred on the glasses: tapped a bus, then the app hung.
    const fake = fakeBridge();
    // Like the real glasses: a rebuild is accepted and replaces the page.
    (fake.bridge as unknown as { rebuildPageContainer: (page: { textObject?: { containerID?: number; content?: string }[] }) => Promise<boolean> })
      .rebuildPageContainer = async (page) => {
        for (const text of page.textObject ?? []) {
          fake.state.draws += 1;
          if (text.containerID === 1) fake.state.header = text.content ?? "";
          if (text.containerID === 2) fake.state.body = text.content ?? "";
        }
        return true;
      };
    await boot(fake);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]?.reply(stopTimes("Alpha-Ziel"));
    fake.gesture(0); // start page: tap opens the departures
    await vi.waitFor(() => expect(pictured()).toContain("alpha-ziel"));

    resetGestureDedupe();
    fake.gesture(0); // tap: follow the selected bus
    // The glasses answer the tap at once, before the network has (0.3.7 showed the unchanged board).
    await vi.waitFor(() => expect(cockpit.models.at(-1)?.caption).toBe("Fahrt wird geladen …"));
    await vi.waitFor(() => expect(cockpit.models.at(-1)?.hint).toBe("Tippen = abbrechen · 2× = Ende"));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    const at = (minutes: number): string => new Date(Date.now() + minutes * 60000).toISOString();
    pending[1]?.reply({
      legs: [{
        routeShortName: "6", headsign: "Alpha-Ziel", realTime: false,
        from: { name: "Alpha Platz", lat: 47.8058, lon: 13.0430, scheduledDeparture: at(5) },
        intermediateStops: [
          { name: "Mitte", lat: 47.81, lon: 13.05, scheduledArrival: at(8) },
          { name: "Nord", lat: 47.82, lon: 13.06, scheduledArrival: at(11) },
        ],
        to: { name: "Endstation", lat: 47.83, lon: 13.07, scheduledArrival: at(14) },
      }],
    });
    // Waiting at Alpha Platz: when it leaves from here, not the stops after it.
    await vi.waitFor(() => {
      const model = cockpit.models.at(-1)!;
      expect(model.title).toBe("FOLGEN · ● live");
      expect(model.cells[0]!.value).toMatch(/^\d\d:\d\d$/);
      expect(model.cells.find((cell) => cell.label === "VERSPÄTUNG")?.value).toBe("FAHRPLAN");
      expect(model.cells.find((cell) => cell.label === "BUS BEI")?.value).toBe("HIER");
    }, { timeout: 3000 });

    resetGestureDedupe(); // a person's second tap comes seconds later
    fake.gesture(0); // QIS v1: the first tap on a running ride only arms
    await vi.waitFor(() => expect(cockpit.models.at(-1)?.hint).toBe("Nochmal tippen = Fahrt abbrechen · 2× = abbrechen"));
    resetGestureDedupe();
    fake.gesture(0); // the second tap: back to the board, at once, with the departures already held
    await vi.waitFor(() => expect(cockpit.models.at(-1)?.title).toBe("NEXTSTOP"));
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    pending[2]?.reply(stopTimes("Alpha-Ziel"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pictured()).toContain("alpha-ziel");
    resetGestureDedupe();
    fake.gesture(3); // double tap: the board is one level below the start page ...
    await vi.waitFor(() => expect(fake.state.body).toContain("Abfahrten"));
    expect(fake.state.modes).toEqual([]);
    resetGestureDedupe();
    fake.gesture(3); // ... and there it is the exit dialog
    await vi.waitFor(() => expect(fake.state.modes).toEqual([1]));
  });

  it("listens to the glasses while the location is still pending", async () => {
    // Regression: the handlers were installed only after the first location
    // answer. A permission prompt on the phone or a slow GPS fix left the
    // glasses deaf — no hold for the voice goal, not even the double tap.
    const fake = fakeBridge();
    const never = (): Promise<never> => new Promise<never>(() => undefined);
    (fake.bridge as { startAppLocationUpdates: () => Promise<unknown> }).startAppLocationUpdates = never;
    (fake.bridge as { getAppLocation: () => Promise<unknown> }).getAppLocation = never;
    await boot(fake);
    await vi.waitFor(() => expect(fake.state.body).toContain("Abfahrten"));
    fake.gesture(3); // double tap
    await vi.waitFor(() => expect(fake.state.modes).toEqual([1]));
  });

  it("a tap while the ride is still loading goes back to the board, and the late answer is dropped", async () => {
    // A slow network must never leave the glasses ignoring taps.
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]?.reply(stopTimes("Alpha-Ziel"));
    fake.gesture(0); // start page: open the departures
    await vi.waitFor(() => expect(pictured()).toContain("alpha-ziel"));

    resetGestureDedupe();
    fake.gesture(0);
    await vi.waitFor(() => expect(cockpit.models.at(-1)?.caption).toBe("Fahrt wird geladen …"));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    resetGestureDedupe();
    fake.gesture(0); // the ride has not answered: back anyway
    await vi.waitFor(() => expect(cockpit.models.at(-1)?.hint).toContain("Tippen = folgen"));

    pending[1]?.reply({ legs: [] }); // the ride's answer, too late
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cockpit.models.at(-1)?.hint).toContain("Tippen = folgen");
    resetGestureDedupe();
    fake.gesture(3);
    await vi.waitFor(() => expect(fake.state.body).toContain("Abfahrten"));
    resetGestureDedupe();
    fake.gesture(3);
    await vi.waitFor(() => expect(fake.state.modes).toEqual([1]));
  });

  it("never rebuilds the page between the board and a followed bus", async () => {
    // A rebuild costs seconds on the glasses and swallows taps meanwhile.
    const fake = fakeBridge();
    let rebuilds = 0;
    (fake.bridge as unknown as { rebuildPageContainer: () => Promise<boolean> }).rebuildPageContainer = async () => { rebuilds += 1; return true; };
    await boot(fake);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]?.reply(stopTimes("Alpha-Ziel"));
    fake.gesture(0); // start page: open the departures
    await vi.waitFor(() => expect(pictured()).toContain("alpha-ziel"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = rebuilds;
    resetGestureDedupe();
    fake.gesture(0);
    await vi.waitFor(() => expect(cockpit.models.at(-1)?.caption).toBe("Fahrt wird geladen …"));
    resetGestureDedupe();
    fake.gesture(0);
    await vi.waitFor(() => expect(cockpit.models.at(-1)?.title).toBe("NEXTSTOP"));
    expect(rebuilds).toBe(before);
    resetGestureDedupe();
    fake.gesture(3);
    await vi.waitFor(() => expect(fake.state.body).toContain("Abfahrten"));
    resetGestureDedupe();
    fake.gesture(3);
    await vi.waitFor(() => expect(fake.state.modes).toEqual([1]));
  });

  it("the exit call resolving true (dialog shown) does not close the app: the board keeps updating", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]?.reply(stopTimes("Alpha-Ziel"));
    await vi.waitFor(() => expect(fake.state.body).toContain("Abfahrten"));

    fake.gesture(3); // double tap
    await vi.waitFor(() => expect(fake.state.modes).toEqual([1]));
    await new Promise((resolve) => setTimeout(resolve, 10));

    vi.setSystemTime(Date.now() + 3 * 60000);
    await vi.advanceTimersByTimeAsync(60000);
    expect(pending.length).toBeGreaterThan(1);
  });

  it("closes cleanly once the system ends the app (sysEvent 7) after the exit dialog: no redraw afterwards", async () => {
    // Regression: the 2 s redraw kept drawing onto a closed page.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]?.reply(stopTimes("Alpha-Ziel"));
    await vi.waitFor(() => expect(fake.state.body).toContain("Abfahrten"));

    fake.gesture(3); // double tap
    await vi.waitFor(() => expect(fake.state.modes).toEqual([1]));
    resetGestureDedupe();
    fake.gesture(7); // the user confirmed: the system ends the app
    await new Promise((resolve) => setTimeout(resolve, 10));
    const drawsAtClose = fake.state.draws;

    // Long enough for both the countdown beat and a board refresh; the board
    // text would change as the minute count moves.
    vi.setSystemTime(Date.now() + 3 * 60000);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fake.state.draws).toBe(drawsAtClose);
    expect(pending).toHaveLength(1);
  });

  it("no timer, poll or stream draws while the exit dialog may be on screen; a single 2x right after restores the page first and asks the dialog only then", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const fake = fakeBridge();
    // The call resolves true as soon as the dialog is SHOWN, whatever the user answers later.
    fake.state.confirm = true;
    await boot(fake);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]?.reply(stopTimes("Alpha-Ziel"));
    await vi.waitFor(() => expect(fake.state.body).toContain("Abfahrten"));
    const creates = fake.state.creates;

    fake.gesture(3);
    await vi.waitFor(() => expect(fake.state.modes).toEqual([1]));
    const callsAtAsk = fake.state.draws + fake.state.creates;
    vi.setSystemTime(Date.now() + 3 * 60000);
    await vi.advanceTimersByTimeAsync(60000);
    // Timers, polls and streams keep collecting data but make no page call while the dialog may be on screen.
    expect(fake.state.draws + fake.state.creates).toBe(callsAtAsk);
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
    resetGestureDedupe();
        fake.gesture(3);
    await new Promise((done) => setTimeout(done, 500));
    expect(order).toEqual(["create:start"]); // the dialog is not asked while the page is still being created
    releaseCreate();
    await new Promise((done) => setTimeout(done, 1500));
    expect(order).toEqual(["create:start", "create:done", "shutdown"]); // restore first, then the dialog, exactly once more
  });

  it("hardware order (step log): 4 = dialog up -> nothing drawn; 5 = dialog gone after No -> page up again without a gesture, polling on, next 2x asks", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]?.reply(stopTimes("Alpha-Ziel"));
    await vi.waitFor(() => expect(fake.state.body).toContain("Abfahrten"));

    fake.gesture(3);
    await vi.waitFor(() => expect(fake.state.modes).toEqual([1]));
    fake.gesture(4);                                         // the dialog is on screen
    const atShown = fake.state.draws + fake.state.creates;
    vi.setSystemTime(Date.now() + 3 * 60000);
    await vi.advanceTimersByTimeAsync(60000);
    for (const call of pending.slice(1)) call.reply(stopTimes("Alpha-Ziel")); // data keeps arriving, silently
    await new Promise((done) => setTimeout(done, 20));
    expect(fake.state.draws + fake.state.creates).toBe(atShown); // nothing drawn over the dialog
    const creates = fake.state.creates;
    const polls = pending.length;
    fake.gesture(5);                                         // "No": the dialog is gone
    await vi.waitFor(() => expect(fake.state.creates).toBeGreaterThan(creates)); // page created again, no gesture needed
    vi.setSystemTime(Date.now() + 3 * 60000);
    await vi.advanceTimersByTimeAsync(60000);
    expect(pending.length).toBeGreaterThan(polls);           // timers were never stopped
    resetGestureDedupe();
    fake.gesture(3);
    await vi.waitFor(() => expect(fake.state.modes).toEqual([1, 1])); // the very first 2x opens the dialog again
  });

  it("a double tap on the board while the app is backgrounded (5 without a dialog) comes back and asks the dialog, it is not swallowed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]?.reply(stopTimes("Alpha-Ziel"));
    await vi.waitFor(() => expect(fake.state.body).toContain("Abfahrten"));
    fake.gesture(5);                                         // genuinely left, no exit call before
    await new Promise((done) => setTimeout(done, 20));
    resetGestureDedupe();
    fake.gesture(3);
    await vi.waitFor(() => expect(fake.state.modes).toEqual([1])); // came back and asked the dialog, not swallowed
  });

  for (const outcome of ["cancelled", "rejected"] as const) {
    it(`keeps the board updating when the exit dialog is ${outcome}`, async () => {
      // Regression: a failing shutDownPageContainer escaped as an unhandled rejection.
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      const fake = fakeBridge();
      if (outcome === "cancelled") fake.state.confirm = false;
      else fake.state.shutdownFails = true;
      await boot(fake);
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      pending[0]?.reply(stopTimes("Alpha-Ziel"));
      await vi.waitFor(() => expect(fake.state.body).toContain("Abfahrten"));

      fake.gesture(3);
      await vi.waitFor(() => expect(fake.state.modes).toEqual([1]));
      await new Promise((resolve) => setTimeout(resolve, 10));
      const drawsAtCancel = fake.state.draws;

      vi.setSystemTime(Date.now() + 3 * 60000);
      await vi.advanceTimersByTimeAsync(60000);
      // Timers keep collecting data, but nothing is drawn while the dialog may be on screen.
      expect(fake.state.draws).toBe(drawsAtCancel);
      resetGestureDedupe();
      fake.gesture(1); // the next input restores the page
      await vi.advanceTimersByTimeAsync(60000);
      expect(fake.state.draws).toBeGreaterThan(drawsAtCancel);
      expect(pending.length).toBeGreaterThan(1);
    });
  }
});

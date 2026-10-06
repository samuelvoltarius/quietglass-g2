import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boots the real app against a fake bridge, so request ordering and the close
// path can be checked without glasses or a network.
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

// Plain functions rather than vi.fn: spies attach handlers to returned
// promises, which would hide exactly the rejections these tests look for.
function fakeBridge() {
  let onEvent: ((event: unknown) => void) | undefined;
  const state = { shutdowns: 0, shutdownFails: false, confirm: true, modes: [] as (number | undefined)[], draws: 0, header: "", body: "" };
  const record = (id: number | undefined, content: string | undefined): void => {
    state.draws += 1;
    if (id === 1) state.header = content ?? "";
    if (id === 2) state.body = content ?? "";
  };
  const bridge = {
    getLocalStorage: async () => JSON.stringify({
      backend: "motis", motisUrl: "https://motis.test", oebbUrl: "http://127.0.0.1:8079/oebb", refreshSeconds: 30,
    }),
    setLocalStorage: async () => true,
    rebuildPageContainer: async () => false,
    createStartUpPageContainer: async (page: { textObject?: { containerID?: number; content?: string }[] }) => {
      for (const text of page.textObject ?? []) record(text.containerID, text.content);
      return 0;
    },
    textContainerUpgrade: async (upgrade: { containerID?: number; content?: string }) => {
      record(upgrade.containerID, upgrade.content);
      return true;
    },
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
  };
}

const STOPS = [
  { stopId: "A", name: "Alpha Platz", lat: 47.8058, lon: 13.0430 },
  { stopId: "B", name: "Bravo Gasse", lat: 47.8070, lon: 13.0440 },
];

function stopTimes(headsign: string): unknown {
  const soon = new Date(Date.now() + 5 * 60000).toISOString();
  return {
    stopTimes: [{
      tripId: "trip-" + headsign, routeShortName: "6", headsign, realTime: false,
      place: { scheduledDeparture: soon, departure: soon },
    }],
  };
}

describe("nextstop lifecycle", () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  /** Departure replies, keyed by stop, released by the test in any order. */
  let pending: { stopId: string; reply: (body: unknown) => void }[];

  beforeEach(() => {
    unhandled = [];
    pending = [];
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

    fake.gesture(9); // hold: next stop
    await vi.waitFor(() => expect(pending.map((p) => p.stopId)).toEqual(["A", "B"]));

    pending[1]?.reply(stopTimes("Bravo-Ziel"));
    await vi.waitFor(() => expect(fake.state.body).toContain("Bravo-Ziel"));
    pending[0]?.reply(stopTimes("Alpha-Ziel"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fake.state.header).toContain("Bravo Gasse");
    expect(fake.state.body).toContain("Bravo-Ziel");
    expect(fake.state.body).not.toContain("Alpha-Ziel");
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
    await vi.waitFor(() => expect(fake.state.body).toContain("Warte auf deinen Standort"));
    expect(fake.state.body).toContain("Erlaube den Standort in der Even-App");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("closes cleanly once the exit dialog is confirmed: no redraw afterwards", async () => {
    // Regression: the 2 s redraw kept drawing onto a closed page.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const fake = fakeBridge();
    await boot(fake);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]?.reply(stopTimes("Alpha-Ziel"));
    await vi.waitFor(() => expect(fake.state.body).toContain("Alpha-Ziel"));

    fake.gesture(3); // double tap
    await vi.waitFor(() => expect(fake.state.modes).toEqual([1]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const drawsAtClose = fake.state.draws;

    // Long enough for both the countdown beat and a board refresh; the board
    // text would change as the minute count moves.
    vi.setSystemTime(Date.now() + 3 * 60000);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fake.state.draws).toBe(drawsAtClose);
    expect(pending).toHaveLength(1);
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
      await vi.waitFor(() => expect(fake.state.body).toContain("Alpha-Ziel"));

      fake.gesture(3);
      await vi.waitFor(() => expect(fake.state.modes).toEqual([1]));
      await new Promise((resolve) => setTimeout(resolve, 10));
      const drawsAtCancel = fake.state.draws;

      vi.setSystemTime(Date.now() + 3 * 60000);
      await vi.advanceTimersByTimeAsync(60000);
      expect(fake.state.draws).toBeGreaterThan(drawsAtCancel);
      expect(pending.length).toBeGreaterThan(1);
    });
  }
});

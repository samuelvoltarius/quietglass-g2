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
  const state = { shutdowns: 0, shutdownFails: false, draws: 0, header: "", body: "" };
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
    shutDownPageContainer: (): Promise<boolean> => {
      state.shutdowns += 1;
      return state.shutdownFails ? Promise.reject(new Error("page already gone")) : Promise.resolve(true);
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

  it("closes cleanly on double tap: no unhandled rejection and no redraw afterwards", async () => {
    // Regression: a failing shutDownPageContainer escaped as an unhandled
    // rejection, and the 2 s redraw kept drawing onto a closed page.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fake = fakeBridge();
    fake.state.shutdownFails = true;
    await boot(fake);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]?.reply(stopTimes("Alpha-Ziel"));
    await vi.waitFor(() => expect(fake.state.body).toContain("Alpha-Ziel"));

    fake.gesture(3); // double tap
    await vi.waitFor(() => expect(fake.state.shutdowns).toBe(1));
    const drawsAtClose = fake.state.draws;

    // Long enough for both the countdown beat and a board refresh; the board
    // text would change as the minute count moves.
    vi.setSystemTime(Date.now() + 3 * 60000);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fake.state.draws).toBe(drawsAtClose);
    expect(pending).toHaveLength(1);
  });
});

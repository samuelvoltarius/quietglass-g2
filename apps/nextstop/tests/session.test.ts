import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGestureDedupe } from "../src/input/gestures";
import { SESSION_KEY, decodeSession, encodeSession, type SavedSession } from "../src/storage/session";
import type { Journey } from "../src/route/journey";

// The session NextStop keeps across a restart (phone locked, app unloaded).
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const NOW = Date.UTC(2026, 9, 13, 10, 0);

function walkJourney(now: number): Journey {
  const destination = { name: "Heim", lat: 47.81, lon: 13.05 };
  const start = new Date(now - 60_000);
  const end = new Date(now + 10 * 60_000);
  return {
    legs: [{
      kind: "walk", toName: "Heim", toLat: 47.81, toLon: 13.05, toDestination: true,
      fromLat: 47.80, fromLon: 13.04, metres: 800, start, end,
    }],
    start, end, transfers: 0, destination,
  } as unknown as Journey;
}

function session(now: number, extra: Partial<SavedSession> = {}): SavedSession {
  const journey = walkJourney(now);
  return {
    savedAt: now,
    screen: "guide",
    stopId: "stop-1",
    follow: null,
    guide: { journey, target: journey.destination, override: { index: 0, autoAtSet: 0 } },
    ...extra,
  };
}

describe("the saved session", () => {
  it("brings the guide back with real dates", () => {
    const back = decodeSession(encodeSession(session(NOW)), NOW + 60_000);
    expect(back?.screen).toBe("guide");
    expect(back?.stopId).toBe("stop-1");
    expect(back?.guide?.journey.end).toBeInstanceOf(Date);
    expect(back?.guide?.journey.end.getTime()).toBe(NOW + 10 * 60_000);
    expect(back?.guide?.override).toEqual({ index: 0, autoAtSet: 0 });
  });

  it("never keeps where the passenger stood", () => {
    const raw = encodeSession(session(NOW));
    expect(raw).not.toContain("47.8,");
    expect(raw).not.toContain("13.04");
    expect(decodeSession(raw, NOW)?.guide?.journey.legs[0]).toMatchObject({ fromLat: 47.81, fromLon: 13.05 });
  });

  it("keeps a followed bus with its times", () => {
    const departure = {
      line: "3", headsign: "Itzling", inMinutes: 4, scheduled: new Date(NOW + 240_000), expected: new Date(NOW + 300_000),
      source: "realtime", cancelled: false, tripId: "trip-9",
    };
    const stop = { id: "s1", name: "Mirabellplatz", lat: 47.80, lon: 13.04 };
    const back = decodeSession(encodeSession(session(NOW, { screen: "board", guide: null, follow: { departure, stop } as SavedSession["follow"] })), NOW);
    expect(back?.follow?.departure.expected.getTime()).toBe(NOW + 300_000);
    expect(back?.follow?.stop.name).toBe("Mirabellplatz");
  });

  it("forgets a guide long after its arrival, and anything older than two hours", () => {
    expect(decodeSession(encodeSession(session(NOW)), NOW + 45 * 60_000)?.guide).toBeNull();
    expect(decodeSession(encodeSession(session(NOW)), NOW + 45 * 60_000)?.screen).toBe("board");
    expect(decodeSession(encodeSession(session(NOW)), NOW + 3 * 60 * 60_000)).toBeNull();
  });

  it("survives broken storage", () => {
    expect(decodeSession("", NOW)).toBeNull();
    expect(decodeSession("{nope", NOW)).toBeNull();
    expect(decodeSession(JSON.stringify({ savedAt: NOW, guide: { journey: { legs: "x" } } }), NOW)?.guide).toBeNull();
  });
});

describe("NextStop after a restart and in the background", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { getElementById: () => null });
    vi.stubGlobal("navigator", { language: "de-AT" });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline in this test"))));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function fakeBridge(stored: Record<string, string>) {
    let onEvent: ((event: unknown) => void) | undefined;
    const state = { footer: "", locationStarts: 0, locationStops: 0, saved: new Map<string, string>() };
    type Page = { textObject?: { containerID?: number; content?: string }[] };
    const adopt = (page: Page): void => { for (const text of page.textObject ?? []) if (text.containerID === 3) state.footer = text.content ?? ""; };
    const bridge = {
      getLocalStorage: async (key: string) => stored[key] ?? "",
      setLocalStorage: async (key: string, value: string) => { state.saved.set(key, value); return true; },
      rebuildPageContainer: async (page: Page) => { adopt(page); return true; },
      createStartUpPageContainer: async (page: Page) => { adopt(page); return 0; },
      updateImageRawData: async () => "success",
      textContainerUpgrade: async (upgrade: { containerID?: number; content?: string }) => { if (upgrade.containerID === 3) state.footer = upgrade.content ?? ""; return true; },
      startAppLocationUpdates: async () => { state.locationStarts += 1; return true; },
      stopAppLocationUpdates: async () => { state.locationStops += 1; return true; },
      getAppLocation: async () => null,
      audioControl: async () => true,
      shutDownPageContainer: async () => true,
      onAppLocationChanged: () => () => undefined,
      onEvenHubEvent: (callback: (event: unknown) => void) => { onEvent = callback; return () => undefined; },
      onDeviceStatusChanged: () => () => undefined,
    };
    return {
      bridge, state,
      ready: () => onEvent !== undefined,
      event: (eventType: number) => { resetGestureDedupe(); onEvent?.({ sysEvent: { eventType, eventSource: 1 } }); },
    };
  }

  async function boot(fake: ReturnType<typeof fakeBridge>): Promise<void> {
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
  }

  it("carries on with the guide that was running", async () => {
    const fake = fakeBridge({ [SESSION_KEY]: encodeSession(session(Date.now())) });
    await boot(fake);
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^Schritt 1\/2 · /));
  });

  it("switches GPS off when left through the system and on again on return", async () => {
    const fake = fakeBridge({});
    await boot(fake);
    await vi.waitFor(() => expect(fake.state.locationStarts).toBe(1));
    fake.event(5);
    await vi.waitFor(() => expect(fake.state.locationStops).toBe(1));
    fake.event(4);
    await vi.waitFor(() => expect(fake.state.locationStarts).toBe(2));
  });
});

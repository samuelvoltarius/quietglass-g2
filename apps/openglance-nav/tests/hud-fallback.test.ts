import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 15.10.: on the real glasses the HUD page never arrived and the display stood
// on "Route wird berechnet…" while the route had long been there. Whatever the
// glasses dislike about a page, the trip must still show: after two refused HUD
// page changes the classic turn page takes over for the session.

const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const START = { lat: 47.8, lon: 13.04 };
const STEP = 0.0009;

function encode(points: readonly { lat: number; lon: number }[]): string {
  let out = "";
  let lastLat = 0, lastLon = 0;
  const push = (delta: number): void => {
    let value = delta < 0 ? ~(delta << 1) : delta << 1;
    while (value >= 0x20) { out += String.fromCharCode((0x20 | (value & 0x1f)) + 63); value >>= 5; }
    out += String.fromCharCode(value + 63);
  };
  for (const point of points) {
    const lat = Math.round(point.lat * 1e6), lon = Math.round(point.lon * 1e6);
    push(lat - lastLat); push(lon - lastLon);
    lastLat = lat; lastLon = lon;
  }
  return out;
}

function valhalla(): unknown {
  const shape = Array.from({ length: 21 }, (_, i) => ({ lat: START.lat + i * STEP, lon: START.lon }));
  return {
    trip: {
      legs: [{
        shape: encode(shape),
        maneuvers: [
          { type: 1, instruction: "Fahre nach Norden.", length: 1, time: 60, begin_shape_index: 0, end_shape_index: 10, street_names: ["A"] },
          { type: 10, instruction: "Rechts abbiegen.", length: 1, time: 60, begin_shape_index: 10, end_shape_index: 20, street_names: ["B"] },
          { type: 4, instruction: "Ziel erreicht.", length: 0, time: 0, begin_shape_index: 20, end_shape_index: 20 },
        ],
      }],
      summary: { length: 2, time: 120 },
    },
  };
}

describe("HUD page refused by the glasses", () => {
  beforeEach(() => {
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("navigator", { language: "de-AT", onLine: true });
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("document", { getElementById: () => null });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("trace_attributes")) return new Response(JSON.stringify({ edges: [] }), { status: 200 });
      if (u.includes("overpass")) return new Response(JSON.stringify({ elements: [] }), { status: 200 });
      return new Response(JSON.stringify(valhalla()), { status: 200 });
    }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("falls back to the classic turn page instead of standing on \"Route wird berechnet…\"", async () => {
    let onEvent: ((event: unknown) => void) | undefined;
    const shown: string[] = [];
    const isHud = (page: { imageObject?: { containerName?: string }[] }) => (page.imageObject ?? []).some((i) => i.containerName === "hud-arr-top");
    const take = (page: { imageObject?: { containerName?: string }[]; textObject?: { containerName?: string }[] }): boolean => {
      if (isHud(page)) return false; // the glasses refuse the HUD page
      shown.push((page.imageObject ?? []).map((i) => i.containerName).join(",") || (page.textObject ?? []).map((t) => t.containerName).join(","));
      return true;
    };
    harness.bridge = {
      getLocalStorage: async () => JSON.stringify({
        mode: "driving", glassView: "turns",
        places: [{ id: "p1", label: "Ziel", at: { lat: START.lat + 20 * STEP, lon: START.lon } }], destinationId: "p1",
      }),
      setLocalStorage: async () => true,
      rebuildPageContainer: async (page: never) => take(page),
      createStartUpPageContainer: async (page: never) => (take(page) ? 0 : 1),
      textContainerUpgrade: async () => true,
      updateImageRawData: async () => "success",
      startAppLocationUpdates: async () => true,
      stopAppLocationUpdates: async () => true,
      getAppLocation: async () => ({ latitude: START.lat, longitude: START.lon }),
      shutDownPageContainer: async () => true,
      onAppLocationChanged: () => () => undefined,
      onEvenHubEvent: (callback: (event: unknown) => void) => { onEvent = callback; return () => undefined; },
      onDeviceStatusChanged: () => () => undefined,
    };
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(onEvent).toBeDefined());
    resetGestureDedupe();
    onEvent!({ sysEvent: { eventType: 0, eventSource: 1 } });
    // Two refused HUD attempts (5 s apart), then the classic page with the turn arrow.
    await vi.waitFor(() => expect(shown.join(" || ")).toMatch(/pixel-icon/), { timeout: 12_000 });
    resetGestureDedupe();
    onEvent!({ sysEvent: { eventType: 3, eventSource: 1 } });
  }, 20_000);
});

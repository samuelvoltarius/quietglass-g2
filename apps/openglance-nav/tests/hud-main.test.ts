import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateEvenHubPageContainer } from "@evenrealities/even_hub_sdk";

// Boots the real app in the car with the HUD layout against a fake bridge and
// counts what crosses Bluetooth: images only when the manoeuvre type or the
// limit changes, never for a GPS fix or the 1-s countdown.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const START = { lat: 47.8, lon: 13.04 };
/** Shape points are 0.0009° (≈ 100 m) apart. */
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

/** 2 km due north, a right turn after 1 km. */
function valhalla(): unknown {
  const shape = Array.from({ length: 21 }, (_, i) => ({ lat: START.lat + i * STEP, lon: START.lon }));
  return {
    trip: {
      legs: [{
        shape: encode(shape),
        maneuvers: [
          { type: 1, instruction: "Head north", street_names: ["Start Road"], length: 1, time: 60, begin_shape_index: 0 },
          { type: 10, instruction: "Turn right", street_names: ["Card Street"], length: 1, time: 60, begin_shape_index: 10 },
          { type: 4, instruction: "Arrive", length: 0, time: 0, begin_shape_index: 20 },
        ],
      }],
      summary: { length: 2, time: 120 },
    },
  };
}

/** The town sign after 500 m: 100 → 50. */
const TRACE = {
  edges: [
    { begin_shape_index: 0, end_shape_index: 5, speed_limit: 100, names: ["Start Road"], road_class: "primary" },
    { begin_shape_index: 5, end_shape_index: 20, speed_limit: 50, names: ["Start Road"], road_class: "primary" },
  ],
};

const ALERT = 3, TURN = 9;

function fakeBridge() {
  let onEvent: ((event: unknown) => void) | undefined;
  let onLocation: ((location: unknown) => void) | undefined;
  const state = { pages: [] as unknown[], images: [] as string[], texts: new Map<number, string>(), upgrades: 0, saved: "" };
  const takePage = (page: { textObject?: { containerID?: number; content?: string }[] }): void => {
    state.pages.push(page);
    for (const text of page.textObject ?? []) if (text.containerID !== undefined) state.texts.set(text.containerID, text.content ?? "");
  };
  const bridge = {
    getLocalStorage: async () => JSON.stringify({
      valhallaUrl: "https://valhalla.test", mode: "driving", glassView: "turns",
      places: [{ id: "p1", label: "Office", at: { lat: START.lat + 20 * STEP, lon: START.lon } }], destinationId: "p1",
    }),
    setLocalStorage: async (_key: string, value: string) => { state.saved = value; return true; },
    rebuildPageContainer: async (page: never) => { takePage(page); return true; },
    createStartUpPageContainer: async (page: never) => { takePage(page); return 0; },
    textContainerUpgrade: async (upgrade: { containerID?: number; content?: string }) => {
      state.upgrades += 1;
      if (upgrade.containerID !== undefined) state.texts.set(upgrade.containerID, upgrade.content ?? "");
      return true;
    },
    updateImageRawData: async (update: { containerName?: string }) => { state.images.push(update.containerName ?? ""); return "success"; },
    startAppLocationUpdates: async () => true,
    stopAppLocationUpdates: async () => true,
    getAppLocation: async () => ({ latitude: START.lat, longitude: START.lon }),
    shutDownPageContainer: async () => true,
    onAppLocationChanged: (callback: (location: unknown) => void) => { onLocation = callback; return () => { onLocation = undefined; }; },
    onEvenHubEvent: (callback: (event: unknown) => void) => { onEvent = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, state,
    ready: () => onEvent !== undefined,
    gesture: (eventType: number) => (resetGestureDedupe(), onEvent?.({ sysEvent: { eventType, eventSource: 1 } })),
    menu: (itemID: number) => onEvent?.({ menuItemClickEvent: { itemID } }),
    /** A fix `metres` along the route at `speed` m/s. */
    at: (metres: number, speed: number) => onLocation?.({ latitude: START.lat + (metres / 100) * STEP, longitude: START.lon, speed }),
    count: (name: string) => state.images.filter((image) => image === name).length,
    /** Pictures other than the large speed (that one follows the km/h). */
    others: () => state.images.filter((image) => image !== "hud-speed").length,
    text: (id: number) => state.texts.get(id) ?? "",
  };
}

/** The distance: first line of the turn box (distance and street share one box, 8 containers per page). */
const distance = (fake: { text: (id: number) => string }): string => (fake.text(TURN).split("\n")[0] ?? "").trim();

const TAP = 0;
const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("HUD layout in the car (0.14.0)", () => {
  let traceCalls: number;

  beforeEach(() => {
    traceCalls = 0;
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("navigator", { language: "en-US", onLine: true });
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("document", { getElementById: () => null });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("trace_attributes")) { traceCalls += 1; return new Response(JSON.stringify(TRACE), { status: 200 }); }
      if (String(url).includes("overpass")) return new Response(JSON.stringify({ elements: [] }), { status: 200 });
      return new Response(JSON.stringify(valhalla()), { status: 200 });
    }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function start(): Promise<ReturnType<typeof fakeBridge>> {
    const fake = fakeBridge();
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    fake.gesture(TAP);
    await vi.waitFor(() => expect(fake.count("hud-arr-top")).toBe(1));
    // The limits arrive once per route, a moment after it.
    await vi.waitFor(() => expect(fake.count("hud-limit")).toBe(2), { timeout: 4000 });
    return fake;
  }

  async function stop(fake: ReturnType<typeof fakeBridge>): Promise<void> {
    fake.gesture(7); // system exit: closes the app (2× while navigating only asks to stop now)
    await settle(50);
  }

  it("puts up a valid HUD page and sends no image for distance-only updates", async () => {
    const fake = await start();
    const hudPage = (fake.state.pages as { imageObject?: { containerName?: string }[] }[]).find((page) => page.imageObject?.some((image) => image.containerName === "hud-arr-top"));
    expect(hudPage).toBeDefined();
    expect(validateEvenHubPageContainer(hudPage as never).valid).toBe(true);
    expect(fake.count("hud-arr-bot")).toBe(1);
    const imagesBefore = fake.others();
    // Eight fixes along the same stretch, same limit (100 zone), same turn: text only.
    for (let m = 10; m <= 80; m += 10) { fake.at(m, 10); await settle(10); }
    await settle(100);
    expect(fake.others()).toBe(imagesBefore);
    expect(distance(fake)).toMatch(/^9\d0 m$/);
    expect(traceCalls).toBe(1);
    await stop(fake);
  });

  it("counts the distance down between fixes (dead reckoning) - text only", async () => {
    const fake = await start();
    for (let i = 0; i < 3; i++) { fake.at(200, 20); await settle(20); }
    await vi.waitFor(() => expect(distance(fake)).toBe("800 m"));
    const imagesBefore = fake.state.images.length;
    // No new fix: after ~2 s at 20 m/s the turn is about 40 m closer - and the speed stays, so no picture at all.
    await vi.waitFor(() => expect(Number(distance(fake).replace(" m", ""))).toBeLessThanOrEqual(780), { timeout: 3500 });
    expect(fake.state.images.length).toBe(imagesBefore);
    await stop(fake);
  });

  it("warns `vom Gas` before the town sign, then the limit sign changes once", async () => {
    const fake = await start();
    // 100 m in, 400 m before the 50 zone at 100 km/h: inside the rolling distance (445 m).
    for (let i = 0; i < 3; i++) { fake.at(100, 27.8); await settle(20); }
    await vi.waitFor(() => expect(fake.text(ALERT).trim()).toMatch(/^▼ 50 in \d+ m – ease off$/));
    const limits = fake.count("hud-limit");
    // Into the 50 zone, slow enough: the hint is gone, the sign goes out once for 50.
    for (let i = 0; i < 3; i++) { fake.at(600, 13); await settle(20); }
    await vi.waitFor(() => expect(fake.count("hud-limit")).toBe(limits + 1));
    await vi.waitFor(() => expect(fake.text(ALERT).trim()).toBe(""));
    for (let i = 0; i < 3; i++) { fake.at(620, 13); await settle(20); }
    await settle(100);
    expect(fake.count("hud-limit")).toBe(limits + 1);
    await stop(fake);
  });

  it("shows `TOO FAST` on the alert line (free then) only after 2 s over the limit", async () => {
    const fake = await start();
    const fix = () => fake.at(700, 20); // 72 km/h in the 50 zone (tolerance +3)
    fix(); await settle(20); fix();
    await settle(600);
    expect(fake.text(ALERT).trim()).toBe("");
    for (let i = 0; i < 5; i++) { fix(); await settle(400); }
    await vi.waitFor(() => expect(fake.text(ALERT).trim()).toBe("TOO FAST  72 / 50"), { timeout: 2000 });
    await stop(fake);
  });

  it("sends the large speed as a picture when the km/h changes - at most once a second, not for a fix at the same speed", async () => {
    const fake = await start();
    for (let i = 0; i < 3; i++) { fake.at(100, 10); await settle(20); }
    await settle(1100);
    const steady = fake.count("hud-speed");
    expect(steady).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 4; i++) { fake.at(110 + i, 10); await settle(20); }
    await settle(300);
    expect(fake.count("hud-speed")).toBe(steady); // same speed: nothing
    // A burst of different speeds within well under a second: at most one more picture right away ...
    for (let i = 0; i < 5; i++) { fake.at(200 + i * 5, 12 + i); await settle(30); }
    expect(fake.count("hud-speed") - steady).toBeLessThanOrEqual(1);
    // ... and the last value follows within the next tick.
    await vi.waitFor(() => expect(fake.count("hud-speed")).toBeGreaterThan(steady), { timeout: 2500 });
    await stop(fake);
  });

  it("the HUD page carries no side menu (its clicks never arrived on the real glasses, 15.10.); GPS fixes and the 1-s tick never rebuild the page", async () => {
    const fake = await start();
    const menuOf = (page: unknown): string[] => ((page as { menuObject?: { menuItems?: { itemName?: string }[] } }).menuObject?.menuItems ?? []).map((item) => item.itemName ?? "");
    const hud = (fake.state.pages as { imageObject?: { containerName?: string }[] }[]).find((page) => page.imageObject?.some((image) => image.containerName === "hud-arr-top"));
    expect(menuOf(hud)).toEqual([]);
    expect(validateEvenHubPageContainer(hud as never).valid).toBe(true);
    const pagesBefore = fake.state.pages.length;
    for (let m = 10; m <= 120; m += 10) { fake.at(m, 10); await settle(10); }
    await settle(1200); // the 1-s tick runs too
    expect(fake.state.pages.length).toBe(pagesBefore);
    await stop(fake);
  });

  it("QIS v1.2: the HUD layout and the speed hints are toggled from the menu (one rebuild for the layout, none for the hints)", async () => {
    const fake = await start();
    const pagesBefore = fake.state.pages.length;
    fake.menu(5); // speed hints off
    await settle(80);
    expect(JSON.parse(fake.state.saved).cameras).toBe(false);
    expect(fake.state.pages.length).toBe(pagesBefore);
    fake.menu(5);
    await settle(80);
    expect(JSON.parse(fake.state.saved).cameras).toBe(true);
    fake.menu(4); // classic layout
    await vi.waitFor(() => expect(JSON.parse(fake.state.saved).hudLayout).toBe("classic"));
    await vi.waitFor(() => expect(fake.state.pages.length).toBe(pagesBefore + 1));
    fake.menu(4);
    await vi.waitFor(() => expect(JSON.parse(fake.state.saved).hudLayout).toBe("new"));
    await stop(fake);
  });
  it("by car a swipe walks HUD, classic and map in turn (the layout is chosen on the glasses)", async () => {
    const fake = await start();
    const seen: string[] = [];
    const now = (): string => {
      const saved = JSON.parse(fake.state.saved) as { glassView?: string; hudLayout?: string };
      return saved.glassView === "overview" ? "map" : saved.hudLayout === "classic" ? "classic" : "hud";
    };
    for (let i = 0; i < 3; i++) {
      const before = fake.state.saved;
      fake.gesture(2);
      await vi.waitFor(() => expect(fake.state.saved).not.toBe(before));
      seen.push(now());
    }
    expect(new Set(seen)).toEqual(new Set(["hud", "classic", "map"]));
    expect(seen[2]).toBe("hud");
    // Back on the HUD: its page is on the glasses again.
    const arrows = fake.count("hud-arr-top");
    await vi.waitFor(() => expect(fake.count("hud-arr-top")).toBeGreaterThanOrEqual(arrows));
    await stop(fake);
  });
});

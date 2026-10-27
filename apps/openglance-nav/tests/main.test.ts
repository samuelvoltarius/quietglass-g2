import { PEAKS_VIEW } from "../src/glasses/picker";
import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

// Boots the real app against a fake bridge, so route ordering, stopping and
// the close path can be checked without glasses, GPS or a Valhalla server.
const harness = vi.hoisted(() => ({ bridge: null as unknown, road: "" }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
// Canvas is unavailable in node; the arrow bitmap is not what these tests are about.
vi.mock("../src/glasses/pixel", () => ({ renderPixelIcon: async () => new Uint8Array([1]) }));
// The road name is an image on the turn page: remember what it was asked to draw.
vi.mock("../src/glasses/street", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/glasses/street")>()),
  renderStreetPngs: async (text: string) => { harness.road = text; return [new Uint8Array([3]), new Uint8Array([4])]; },
}));
vi.mock("../src/overview/draw", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/overview/draw")>()),
  renderMapTiles: async () => [1, 2, 3, 4].map((n) => new Uint8Array([n])),
}));

// tsconfig carries no node types; reach the process object structurally.
const nodeProcess = (globalThis as unknown as {
  process: {
    on(event: string, listener: (reason: unknown) => void): void;
    off(event: string, listener: (reason: unknown) => void): void;
  };
}).process;

const START = { lat: 47.8, lon: 13.04 };

/** Encodes points the way Valhalla does, at precision 6. */
function encode(points: readonly { lat: number; lon: number }[]): string {
  let out = "";
  let lastLat = 0;
  let lastLon = 0;
  const push = (delta: number): void => {
    let value = delta < 0 ? ~(delta << 1) : delta << 1;
    while (value >= 0x20) { out += String.fromCharCode((0x20 | (value & 0x1f)) + 63); value >>= 5; }
    out += String.fromCharCode(value + 63);
  };
  for (const point of points) {
    const lat = Math.round(point.lat * 1e6);
    const lon = Math.round(point.lon * 1e6);
    push(lat - lastLat); push(lon - lastLon);
    lastLat = lat; lastLon = lon;
  }
  return out;
}

/** A Valhalla answer whose second manoeuvre joins `street`. */
function valhalla(street: string): unknown {
  const shape = [0, 1, 2].map((i) => ({ lat: START.lat + i * 0.002, lon: START.lon }));
  return {
    trip: {
      legs: [{
        shape: encode(shape),
        maneuvers: [
          { type: 1, instruction: "Head north", street_names: ["Start Road"], length: 0.22, time: 60, begin_shape_index: 0 },
          { type: 10, instruction: "Turn right", street_names: [street], length: 0.22, time: 60, begin_shape_index: 1 },
          { type: 4, instruction: "Arrive", length: 0, time: 0, begin_shape_index: 2 },
        ],
      }],
      summary: { length: 0.44, time: 120 },
    },
  };
}

// Plain functions rather than vi.fn: spies attach handlers to returned
// promises, which would hide exactly the rejections these tests look for.
function fakeBridge(stored: Record<string, unknown> = {}) {
  let onEvent: ((event: unknown) => void) | undefined;
  const state = {
    calls: [] as string[],
    locationStarts: 0, shutdowns: 0, shutdownFails: false, draws: 0, body: "", header: "", footer: "",
    noFix: false, mic: [] as boolean[], pages: [] as string[], images: [] as string[], saved: "", menus: [] as string[][],
  };
  const record = (id: number | undefined, content: string | undefined): void => {
    state.draws += 1;
    if (id === 2) state.body = content ?? "";
    if (id === 1) state.header = content ?? "";
    if (id === 3) state.footer = content ?? "";
  };
  const bridge = {
    getLocalStorage: async () => JSON.stringify({
      valhallaUrl: "https://valhalla.test", mode: "walking", invertScroll: false,
      places: [{ id: "p1", label: "Office", at: { lat: START.lat + 0.004, lon: START.lon } }],
      destinationId: "p1",
      ...stored,
    }),
    setLocalStorage: async (_key: string, value: string) => { state.saved = value; return true; },
    rebuildPageContainer: async (page: { textObject?: { containerID?: number; content?: string }[]; imageObject?: { containerName?: string }[]; menuObject?: { menuItems?: { itemName?: string }[] } }) => {
      state.calls.push("rebuild");
      state.menus.push((page.menuObject?.menuItems ?? []).map((item) => item.itemName ?? ""));
      state.pages.push(page.imageObject?.[0]?.containerName ?? "text-only");
      for (const text of page.textObject ?? []) record(text.containerID, text.content);
      return true;
    },
    createStartUpPageContainer: async (page: { textObject?: { containerID?: number; content?: string }[]; imageObject?: { containerName?: string }[]; menuObject?: { menuItems?: { itemName?: string }[] } }) => {
      state.calls.push("create");
      state.menus.push((page.menuObject?.menuItems ?? []).map((item) => item.itemName ?? ""));
      state.pages.push(page.imageObject?.[0]?.containerName ?? "text-only");
      for (const text of page.textObject ?? []) record(text.containerID, text.content);
      return 0;
    },
    textContainerUpgrade: async (upgrade: { containerID?: number; content?: string }) => {
      record(upgrade.containerID, upgrade.content);
      return true;
    },
    updateImageRawData: async (update: { containerName?: string }) => { state.images.push(update.containerName ?? ""); return "success"; },
    audioControl: async (on: boolean) => { state.mic.push(on); return true; },
    startAppLocationUpdates: async () => { state.locationStarts += 1; return true; },
    stopAppLocationUpdates: async () => true,
    getAppLocation: async () => (state.noFix ? null : { latitude: START.lat, longitude: START.lon }),
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
    send: (event: unknown) => onEvent?.(event),
    menu: (itemID: number) => onEvent?.({ menuItemClickEvent: { itemID } }),
    gesture: (eventType: number) => (resetGestureDedupe(), onEvent?.({ sysEvent: { eventType, eventSource: 1 } })),
  };
}

const TAP = 0;
const SWIPE = 1;
const DOUBLE_TAP = 3;
const SWIPE_DOWN = 2;
const HOLD = 9;
const RELEASE = 10;
/** Ids of the glasses' side menu (see MENU in main.ts). */
const MENU_HELP = 1, MENU_VIEW_TURNS = 2, MENU_VIEW_MAP = 3, MENU_STOP = 6;

describe("openglance lifecycle", () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  let replies: ((body: unknown) => void)[];

  beforeEach(() => {
  resetGestureDedupe();
    harness.road = "";
    unhandled = [];
    replies = [];
    nodeProcess.on("unhandledRejection", onUnhandled);
    vi.stubGlobal("location", { search: "" });
    // The glasses text follows the device language; pin it so assertions
    // do not depend on the machine running the tests.
    vi.stubGlobal("navigator", { language: "en-US", onLine: true });
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("document", { getElementById: () => null });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      replies.push((body) => resolve(new Response(JSON.stringify(body), { status: 200 })));
    })));
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

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
  /** Stopping needs the menu entry (it only asks) and a second click on it (QIS v1.2). */
  const stopNav = async (fake: ReturnType<typeof fakeBridge>): Promise<void> => {
    fake.menu(MENU_STOP);
    await new Promise((resolve) => setTimeout(resolve, 30));
    fake.menu(MENU_STOP);
  };

  it("never lets an older route answer overwrite a newer one", async () => {
    // Regression: each tap started a request without retiring the last, so a
    // slow first answer landed after the second and replaced it.
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    // Hold goes back to the list, tap starts again while the first answer is still out.
    await stopNav(fake);
    await settle();
    fake.gesture(TAP);
    // The second request waits out the one-per-second limit of the public router.
    await vi.waitFor(() => expect(replies).toHaveLength(2), { timeout: 3000 });

    replies[1]?.(valhalla("New Street"));
    await vi.waitFor(() => expect(harness.road).toContain("New Street"));
    replies[0]?.(valhalla("Old Street"));
    await settle();
    expect(harness.road).toContain("New Street");
    expect(harness.road).not.toContain("Old Street");
  });

  it("stays stopped when a route arrives after a hold", async () => {
    // Regression: holding while the route was loading cleared navigation, and
    // then the answer arrived and switched it straight back on.
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    await stopNav(fake);
    await settle();
    replies[0]?.(valhalla("Late Street"));
    await settle();
    // Back on the destination list, the destination still chosen and ready to restart.
    expect(fake.state.body).toContain("→ ● Office");
    expect(harness.road).not.toContain("Late Street");
  });

  it("turns location updates back on when navigation starts again after a hold", async () => {
    // Regression: the hold stopped location updates and nothing restarted
    // them, so the second trip's arrow never moved past the first fix.
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    replies[0]?.(valhalla("First Street"));
    await vi.waitFor(() => expect(harness.road).toContain("First Street"));

    await stopNav(fake);
    await settle();
    const before = fake.state.locationStarts;
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(2), { timeout: 3000 });
    expect(fake.state.locationStarts).toBeGreaterThan(before);
  });

  it("listens to the glasses while the phone still holds back the location", async () => {
    // Regression: startAppLocationUpdates was awaited before the gesture
    // handlers were installed; with a permission prompt open, a tap did nothing.
    const fake = fakeBridge();
    (fake.bridge as { startAppLocationUpdates: () => Promise<unknown> }).startAppLocationUpdates =
      () => new Promise<never>(() => undefined);
    await boot(fake);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
  });

  it("closes cleanly on double tap: no unhandled rejection and no redraw afterwards", async () => {
    // Regression: a failing shutDownPageContainer escaped as an unhandled
    // rejection, and the 2 s redraw kept running after the page was closed.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fake = fakeBridge();
    fake.state.shutdownFails = true;
    await boot(fake);
    // 2× on the list is the exit (while navigating it only asks to stop, see below).
    fake.gesture(DOUBLE_TAP);
    await vi.waitFor(() => expect(fake.state.shutdowns).toBe(1));
    await settle();
    const drawsAtClose = fake.state.draws;
    fake.gesture(TAP);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fake.state.draws).toBe(drawsAtClose);
    expect(replies).toHaveLength(0);
  });
  it("builds the first page with one rebuild before the single create, then only rebuilds", async () => {
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    replies[0]?.(valhalla("Map Street"));
    await vi.waitFor(() => expect(harness.road).toContain("Map Street"));
    fake.menu(MENU_VIEW_MAP);
    await vi.waitFor(() => expect(fake.state.pages.at(-1)).toBe("map-nw"));
    expect(fake.state.calls.slice(0, 2)).toEqual(["rebuild", "create"]);
    expect(fake.state.calls.filter((call) => call === "create")).toHaveLength(1);
    expect(fake.state.calls.filter((call) => call === "rebuild").length).toBeGreaterThanOrEqual(2);
  });
  it("switches to the overview map through the side menu, and back", async () => {
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    replies[0]?.(valhalla("Map Street"));
    await vi.waitFor(() => expect(harness.road).toContain("Map Street"));

    fake.menu(MENU_VIEW_MAP);
    // The map is four images covering the display, and one short line of text on it.
    await vi.waitFor(() => expect(fake.state.pages.at(-1)).toBe("map-nw"));
    await vi.waitFor(() => expect(fake.state.images).toEqual(expect.arrayContaining(["map-nw", "map-ne", "map-sw", "map-se"])));
    expect(fake.state.body).toMatch(/→\s+\d+ m/);
    // The choice is remembered for next time.
    expect(JSON.parse(fake.state.saved).glassView).toBe("overview");

    fake.menu(MENU_VIEW_TURNS);
    await vi.waitFor(() => expect(fake.state.pages.at(-1)).toBe("pixel-icon"));
    // Switching views is local: it never asks the router again.
    expect(replies).toHaveLength(1);
  });

  it("says in plain German that there is no GPS, without asking the router", async () => {
    vi.stubGlobal("navigator", { language: "de-DE", onLine: true });
    const fake = fakeBridge();
    fake.state.noFix = true;
    await boot(fake);
    expect(fake.state.body).toContain("→ ● Office");
    fake.gesture(TAP);
    await vi.waitFor(() => expect(fake.state.body).toContain("Kein GPS-Standort."));
    expect(fake.state.body).toContain("Standort für Even am Handy erlauben.");
    expect(replies).toHaveLength(0);
  });

  it("says there is no connection when the phone is offline", async () => {
    vi.stubGlobal("navigator", { language: "en-US", onLine: false });
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(fake.state.body).toContain("No connection"));
    expect(replies).toHaveLength(0);
  });

  const fetchUrl = (index: number): string => String((globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[index]?.[0] ?? "");

  it("starts on the destination list: swipe picks another place, tap navigates there and keeps it", async () => {
    const fake = fakeBridge({
      places: [
        { id: "p1", label: "Office", at: { lat: START.lat + 0.004, lon: START.lon } },
        { id: "p2", label: "Tamsweg", at: { lat: 47.1278, lon: 13.8095 } },
      ],
    });
    await boot(fake);
    expect(fake.state.body).toContain("→ ● Office");
    expect(fake.state.body).toContain("○ Tamsweg");
    fake.gesture(SWIPE_DOWN);
    await vi.waitFor(() => expect(fake.state.body).toContain("→ ○ Tamsweg"));
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(decodeURIComponent(fetchUrl(0))).toContain("47.1278");
    expect(JSON.parse(fake.state.saved).destinationId).toBe("p2");
    replies[0]?.(valhalla("Murtal Street"));
    await vi.waitFor(() => expect(harness.road).toContain("Murtal Street"));
  });

  it("changes the way of travel from the last row of the list", async () => {
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(SWIPE_DOWN);
    await vi.waitFor(() => expect(fake.state.body).toContain("→ Travel: On foot"));
    fake.gesture(TAP);
    await vi.waitFor(() => expect(fake.state.body).toContain("Travel: Car"));
    expect(JSON.parse(fake.state.saved).mode).toBe("driving");
    expect(replies).toHaveLength(0);
  });

  it("says plainly that the routing server cannot be reached", async () => {
    const fake = fakeBridge();
    await boot(fake);
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    fake.gesture(TAP);
    await vi.waitFor(() => expect(fake.state.body).toContain("Routing server not reachable."));
    expect(fake.state.body).toContain("Tailscale");
  });

  it("shows on the glasses that a start is under way while the GPS is still searching", async () => {
    const fake = fakeBridge();
    let answer: ((value: unknown) => void) | undefined;
    (fake.bridge as { getAppLocation: () => Promise<unknown> }).getAppLocation = () => new Promise((resolve) => { answer = resolve; });
    await boot(fake);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(fake.state.body).toContain("Finding your position…"));
    answer?.({ latitude: START.lat, longitude: START.lon });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    // A hold cancels the start and goes back to the list.
    await stopNav(fake);
    await vi.waitFor(() => expect(fake.state.body).toContain("→ ● Office"));
  });

  it("says that speaking needs a speech server when the build has none", async () => {
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(HOLD);
    await vi.waitFor(() => expect(fake.state.body).toContain("No speech server in this version."));
    expect(fake.state.mic).toEqual([]);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(fake.state.body).toContain("→ ● Office"));
  });

  it("hold speaks a destination: microphone on and off, up to three places, hold saves, tap navigates", async () => {
    vi.stubEnv("VITE_STT_URL", "https://stt.test");
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(HOLD);
    await vi.waitFor(() => expect(fake.state.mic).toEqual([true]));
    await vi.waitFor(() => expect(fake.state.body).toContain("Say your destination now"));
    for (let i = 0; i < 5; i++) fake.send({ audioEvent: { audioPcm: new Uint8Array(3200) } });
    fake.gesture(RELEASE);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(fake.state.mic).toEqual([true, false]);
    expect(fetchUrl(0)).toBe("https://stt.test/v1/audio/transcriptions");
    replies[0]?.({ text: " Tamsweg. " });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(fetchUrl(1)).toContain("q=Tamsweg");
    const feature = (name: string, lat: number) => ({ geometry: { coordinates: [13.81, lat] }, properties: { name, postcode: "5580", country: "Austria" } });
    replies[1]?.({ features: [feature("Tamsweg", 47.128), feature("Tamsweg Bahnhof", 47.125)] });
    await vi.waitFor(() => expect(fake.state.header).toContain("heard: „Tamsweg“"));
    expect(fake.state.body).toContain("→ Tamsweg");
    fake.gesture(SWIPE_DOWN);
    await vi.waitFor(() => expect(fake.state.body).toContain("→ Tamsweg Bahnhof"));
    fake.gesture(HOLD);
    await vi.waitFor(() => expect(JSON.parse(fake.state.saved).places).toHaveLength(2));
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    expect(decodeURIComponent(fetchUrl(2))).toContain("47.125");
    const saved = JSON.parse(fake.state.saved);
    expect(saved.places[1].label).toBe("Tamsweg Bahnhof");
    expect(saved.destinationId).toBe(saved.places[1].id);
    vi.unstubAllEnvs();
  });

  it("keeps a spoken destination that was not saved as a recent one", async () => {
    vi.stubEnv("VITE_STT_URL", "https://stt.test");
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(HOLD);
    await vi.waitFor(() => expect(fake.state.mic).toEqual([true]));
    for (let i = 0; i < 5; i++) fake.send({ audioEvent: { audioPcm: new Uint8Array(3200) } });
    fake.gesture(RELEASE);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    replies[0]?.({ text: "Tamsweg" });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    replies[1]?.({ features: [{ geometry: { coordinates: [13.81, 47.128] }, properties: { name: "Tamsweg" } }] });
    await vi.waitFor(() => expect(fake.state.body).toContain("→ Tamsweg"));
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    const saved = JSON.parse(fake.state.saved);
    expect(saved.recent[0].label).toBe("Tamsweg");
    expect(saved.destinationId).toBe(saved.recent[0].id);
    await stopNav(fake);
    await vi.waitFor(() => expect(fake.state.body).toContain("→ ● Tamsweg · recent"));
    vi.unstubAllEnvs();
  });

  it("switches the microphone off when a recording is abandoned with a double tap", async () => {
    vi.stubEnv("VITE_STT_URL", "https://stt.test");
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(HOLD);
    await vi.waitFor(() => expect(fake.state.mic).toEqual([true]));
    fake.gesture(DOUBLE_TAP);
    await vi.waitFor(() => expect(fake.state.mic).toEqual([true, false]));
    await vi.waitFor(() => expect(fake.state.body).toContain("→ ● Office"));
    expect(fake.state.shutdowns).toBe(0);
    vi.unstubAllEnvs();
  });

  it("starts a saved route from the list: every stop is a location, the stop is named on the glasses", async () => {
    const fake = fakeBridge({
      places: [],
      destinationId: null,
      // The classic turn page draws the road as an image (the HUD layout has its own test in hud-main.test.ts).
      hudLayout: "classic",
      routes: [{
        id: "s1", name: "Morning", mode: "driving", start: null,
        stops: [{ label: "Charger", at: { lat: START.lat + 0.002, lon: START.lon } }],
        to: { label: "Office", at: { lat: START.lat + 0.004, lon: START.lon } }, distance: 440, duration: 120,
      }],
    });
    await boot(fake);
    await vi.waitFor(() => expect(fake.state.body).toContain("Morning · route, 1 stop"));
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    const body = JSON.parse(decodeURIComponent(fetchUrl(0).split("?json=")[1]!)) as { locations: unknown[]; costing: string };
    expect(body.locations).toHaveLength(3);
    expect(body.costing).toBe("auto");
    const shape = [0, 1, 2].map((i) => ({ lat: START.lat + i * 0.002, lon: START.lon }));
    replies[0]?.({
      trip: {
        legs: [
          { shape: encode(shape.slice(0, 2)), maneuvers: [
            { type: 1, instruction: "Go", street_names: ["Start Road"], length: 0.22, time: 60, begin_shape_index: 0 },
            { type: 4, instruction: "Arrive", length: 0, time: 0, begin_shape_index: 1 },
          ] },
          { shape: encode(shape.slice(1)), maneuvers: [
            { type: 1, instruction: "Go", street_names: ["Office Road"], length: 0.22, time: 60, begin_shape_index: 0 },
            { type: 4, instruction: "Arrive", length: 0, time: 0, begin_shape_index: 1 },
          ] },
        ],
        summary: { length: 0.44, time: 120 },
      },
    });
    await vi.waitFor(() => expect(harness.road).toBe("Stop 1: Charger"));
    expect(JSON.parse(fake.state.saved).destinationId).toBe("s1");
  });

  it("picks a running navigation up again after the phone ended the app", async () => {
    const fake = fakeBridge({ activeSince: Date.now() - 60_000 });
    await boot(fake);
    // No tap: the route is asked for by itself.
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    replies[0]?.(valhalla("Resume Street"));
    await vi.waitFor(() => expect(harness.road).toContain("Resume Street"));
    // A system exit keeps it remembered; a hold forgets it.
    fake.send({ sysEvent: { eventType: 6 } });
    await settle();
    expect(JSON.parse(fake.state.saved).activeSince).toBeGreaterThan(0);
  });

  it("forgets the navigation when it is stopped with a hold", async () => {
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    await vi.waitFor(() => expect(JSON.parse(fake.state.saved).activeSince).toBeGreaterThan(0));
    await stopNav(fake);
    await vi.waitFor(() => expect(JSON.parse(fake.state.saved).activeSince).toBeNull());
  });

  it("does not resume a navigation that is hours old", async () => {
    const fake = fakeBridge({ activeSince: Date.now() - 24 * 3600_000 });
    await boot(fake);
    await settle();
    expect(replies).toHaveLength(0);
    expect(fake.state.body).toContain("→ ● Office");
  });

  it("lists fast charging stations nearby and navigates to the chosen one", async () => {
    const fake = fakeBridge({ chargers: true });
    await boot(fake);
    fake.gesture(SWIPE_DOWN);
    await vi.waitFor(() => expect(fake.state.body).toContain("→ Charging nearby …"));
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(fetchUrl(0)).toBe("https://overpass-api.de/api/interpreter");
    replies[0]?.({ elements: [
      { type: "node", id: 1, lat: START.lat + 0.01, lon: START.lon, tags: { amenity: "charging_station", name: "Wallbox", "socket:type2": "1", "socket:type2:output": "11 kW" } },
      { type: "node", id: 2, lat: START.lat + 0.02, lon: START.lon, tags: { amenity: "charging_station", name: "Fast One", "socket:type2_combo": "2", "socket:type2_combo:output": "150 kW" } },
    ] });
    await vi.waitFor(() => expect(fake.state.body).toContain("→ 2,2 km · 150 kW · Fast One".replace("2,2", "2.2")));
    expect(fake.state.body).not.toContain("Wallbox");
    fake.gesture(TAP);
    // Timers of an earlier test's app may still call fetch: look at the URLs, not the order.
    const urls = (): string[] => (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    await vi.waitFor(() => expect(urls().some((url) => url.includes("valhalla.test/route"))).toBe(true));
    expect(JSON.parse(fake.state.saved).recent[0].label).toBe("Fast One");
  });

  // The peaks view is switched off (PEAKS_VIEW, 15.10.); this test comes back with it.
  it.skipIf(!PEAKS_VIEW)("shows peaks nearby on a compass band, lists them by distance and navigates to one; the area is asked for once", async () => {
    const fake = fakeBridge({ peaks: true, peakRadiusKm: 10 });
    await boot(fake);
    fake.gesture(SWIPE_DOWN);
    await vi.waitFor(() => expect(fake.state.body).toContain("→ Peaks nearby …"));
    // Timers of an earlier test's app may still call fetch: look at the URLs, not the order.
    const calls = (): string[] => (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    const overpass = (): number => calls().filter((url) => url === "https://overpass-api.de/api/interpreter").length;
    fake.gesture(TAP);
    await vi.waitFor(() => expect(overpass()).toBe(1));
    replies[calls().indexOf("https://overpass-api.de/api/interpreter")]?.({ elements: [
      { type: "node", id: 1, lat: START.lat + 0.03, lon: START.lon, tags: { natural: "peak", name: "Far Peak", ele: "1800" } },
      { type: "node", id: 2, lat: START.lat + 0.01, lon: START.lon, tags: { natural: "peak", name: "Near Hill", ele: "640" } },
      { type: "node", id: 3, lat: START.lat + 0.02, lon: START.lon, tags: { natural: "peak", name: "No Height" } },
    ] });
    await vi.waitFor(() => expect(fake.state.body).toContain("2 peaks within 10 km · nearest"));
    expect(fake.state.body).toContain("Facing 0° N · north up");
    expect(fake.state.pages).toContain("band-left");
    expect(fake.state.images).toEqual(expect.arrayContaining(["band-left", "band-right"]));

    // Tap: the list, nearest first; tap again navigates there.
    fake.gesture(TAP);
    await vi.waitFor(() => expect(fake.state.header).toBe("OPENGLANCE · peaks 10 km · 1/2"));
    expect(fake.state.body).toContain("→ 1.1 km · N · Near Hill 640 m");
    fake.gesture(TAP);
    await vi.waitFor(() => expect(calls().some((url) => url.includes("valhalla.test/route"))).toBe(true));
    await vi.waitFor(() => expect(JSON.parse(fake.state.saved).recent?.[0]?.label).toBe("Near Hill"));

    // Back on the peaks page in the same area: from the cache, no third request to Overpass.
    await stopNav(fake);
    await vi.waitFor(() => expect(fake.state.body).toContain("Peaks nearby …"));
    for (let i = 0; i < 8 && !fake.state.body.includes("→ Peaks nearby …"); i++) { fake.gesture(SWIPE_DOWN); await settle(); }
    fake.gesture(TAP);
    await vi.waitFor(() => expect(fake.state.body).toContain("2 peaks within 10 km"));
    expect(overpass()).toBe(1);
  });

  it("switches the microphone off when its yes comes after the timeout", async () => {
    vi.stubEnv("VITE_STT_URL", "https://stt.test");
    const fake = fakeBridge();
    (fake.bridge as { audioControl: (on: boolean) => Promise<boolean> }).audioControl = (on) => {
      fake.state.mic.push(on);
      return on ? new Promise((resolve) => setTimeout(() => resolve(true), 5300)) : Promise.resolve(true);
    };
    await boot(fake);
    fake.gesture(HOLD);
    await vi.waitFor(() => expect(fake.state.body).toContain("The microphone did not switch on."), { timeout: 6000 });
    await vi.waitFor(() => expect(fake.state.mic).toEqual([true, false]), { timeout: 2000 });
    vi.unstubAllEnvs();
  }, 10_000);
  describe("QIS v1.2: stopping needs the menu entry and one more click or tap", () => {
    const navigate = async (fake: ReturnType<typeof fakeBridge>): Promise<void> => {
      fake.gesture(TAP);
      await vi.waitFor(() => expect(replies).toHaveLength(1));
      replies[0]?.(valhalla("Main Street"));
      await vi.waitFor(() => expect(harness.road).toContain("Main Street"));
    };
    // Every test ends by closing its app, so no timer of it reaches into the next test.
    let current: ReturnType<typeof fakeBridge> | null = null;
    afterEach(() => { current?.send({ sysEvent: { eventType: 7 } }); current = null; });
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
      const fake = fakeBridge();
      current = fake;
      await boot(fake);
      await navigate(fake);
      expect(fake.state.menus.every((menu) => menu.length === 0)).toBe(true);
    });

    it("a swipe switches between the turn view and the map (no side menu for it)", async () => {
      const fake = fakeBridge();
      current = fake;
      await boot(fake);
      await navigate(fake);
      const before = JSON.parse(fake.state.saved).glassView ?? "turns";
      fake.gesture(SWIPE);
      await vi.waitFor(() => expect(JSON.parse(fake.state.saved).glassView).not.toBe(before));
      fake.gesture(SWIPE_DOWN);
      await vi.waitFor(() => expect(JSON.parse(fake.state.saved).glassView ?? "turns").toBe(before));
    });

    it("a hold asks to stop (the footer says what the next tap does), a tap after it stops", async () => {
      const fake = fakeBridge();
      current = fake;
      await boot(fake);
      await navigate(fake);
      fake.gesture(HOLD);
      await vi.waitFor(() => expect(fake.state.footer).toBe("Tap again = stop · Swipe/2× = cancel"));
      expect(JSON.parse(fake.state.saved).activeSince).toBeGreaterThan(0);
      expect(fake.state.shutdowns).toBe(0);
      await sleep(600);
      fake.gesture(TAP);
      await vi.waitFor(() => expect(JSON.parse(fake.state.saved).activeSince).toBeNull());
    });

    it("a tap with nothing else to do asks to stop too (holds never reached the app on hardware), a second tap stops", async () => {
      const fake = fakeBridge();
      current = fake;
      await boot(fake);
      await navigate(fake);
      fake.gesture(TAP);
      await vi.waitFor(() => expect(fake.state.footer).toBe("Tap again = stop · Swipe/2× = cancel"));
      expect(JSON.parse(fake.state.saved).activeSince).toBeGreaterThan(0);
      await sleep(600);
      fake.gesture(TAP);
      await vi.waitFor(() => expect(JSON.parse(fake.state.saved).activeSince).toBeNull());
      expect(fake.state.shutdowns).toBe(0);
    });

    it("a second click on the entry within 4 s stops", async () => {
      const fake = fakeBridge();
      current = fake;
      await boot(fake);
      await navigate(fake);
      fake.menu(MENU_STOP);
      await vi.waitFor(() => expect(fake.state.footer).toContain("Tap again"));
      fake.menu(MENU_STOP);
      await vi.waitFor(() => expect(JSON.parse(fake.state.saved).activeSince).toBeNull());
      await vi.waitFor(() => expect(fake.state.body).toContain("→ ● Office"));
    });

    it("a tap on the heels of the menu click is not a confirmation; a later tap is", async () => {
      const fake = fakeBridge();
      current = fake;
      await boot(fake);
      await navigate(fake);
      fake.menu(MENU_STOP);
      await sleep(50);
      fake.gesture(TAP);
      await sleep(100);
      expect(JSON.parse(fake.state.saved).activeSince).toBeGreaterThan(0);
      await sleep(450);
      fake.gesture(TAP);
      await vi.waitFor(() => expect(JSON.parse(fake.state.saved).activeSince).toBeNull());
    });

    it("a swipe, a hold, a double tap or another menu entry cancels; a double tap does not leave the app", async () => {
      const fake = fakeBridge();
      current = fake;
      await boot(fake);
      await navigate(fake);
      for (const cancel of [() => fake.gesture(SWIPE), () => fake.gesture(HOLD), () => fake.gesture(DOUBLE_TAP), () => fake.menu(MENU_VIEW_TURNS)]) {
        fake.menu(MENU_STOP);
        await vi.waitFor(() => expect(fake.state.footer).toContain("Tap again"));
        await sleep(450);
        cancel();
        await vi.waitFor(() => expect(fake.state.footer).not.toContain("Tap again"));
        await sleep(50);
        // After a cancel a plain tap does not stop (it is only a tap), and the next menu click asks again.
        expect(JSON.parse(fake.state.saved).activeSince).toBeGreaterThan(0);
      }
      expect(fake.state.shutdowns).toBe(0);
    });

    it("without a second click the question lapses after 4 s", async () => {
      const fake = fakeBridge();
      current = fake;
      await boot(fake);
      await navigate(fake);
      fake.menu(MENU_STOP);
      await vi.waitFor(() => expect(fake.state.footer).toContain("Tap again"));
      await vi.waitFor(() => expect(fake.state.footer).not.toContain("Tap again"), { timeout: 5500 });
      fake.menu(MENU_STOP); // the lapsed question is gone: this asks again, it does not stop
      await sleep(100);
      expect(JSON.parse(fake.state.saved).activeSince).toBeGreaterThan(0);
    }, 12_000);

    it("the menu entry during the start only asks as well", async () => {
      const fake = fakeBridge();
      current = fake;
      await boot(fake);
      fake.gesture(TAP);
      await vi.waitFor(() => expect(replies).toHaveLength(1));
      fake.menu(MENU_STOP);
      await vi.waitFor(() => expect(fake.state.footer).toContain("Tap again"));
      await sleep(450);
      fake.gesture(TAP);
      await vi.waitFor(() => expect(fake.state.body).toContain("→ ● Office"));
    });
  });

  it("QIS v1.2: Help is no list row any more; the side menu opens it, tap or 2× closes it, nothing else leaves", async () => {
    const fake = fakeBridge();
    await boot(fake);
    onTestFinished(() => fake.send({ sysEvent: { eventType: 7 } }));
    fake.gesture(SWIPE_DOWN); // travel mode: the last row
    fake.gesture(SWIPE_DOWN); // stays there
    await settle();
    expect(fake.state.body).not.toContain("Help");
    fake.menu(MENU_HELP);
    await vi.waitFor(() => expect(fake.state.header).toBe("OPENGLANCE · help"));
    expect(fake.state.footer).toBe("2× = back");
    expect(fake.state.body).toContain("Stop: tap (or hold), then tap again");
    fake.gesture(SWIPE_DOWN);
    await settle();
    expect(fake.state.header).toBe("OPENGLANCE · help");
    fake.gesture(DOUBLE_TAP);
    await vi.waitFor(() => expect(fake.state.body).toContain("→ ● Office"));
    expect(fake.state.header).toBe("OPENGLANCE · where to?");
    fake.menu(MENU_HELP);
    await vi.waitFor(() => expect(fake.state.header).toBe("OPENGLANCE · help"));
    fake.gesture(TAP);
    await vi.waitFor(() => expect(fake.state.header).toBe("OPENGLANCE · where to?"));
    expect(fake.state.shutdowns).toBe(0);
  });

  it("QIS v1.2: help opened during a navigation returns to it - the navigation is not dropped", async () => {
    const fake = fakeBridge();
    await boot(fake);
    onTestFinished(() => fake.send({ sysEvent: { eventType: 7 } }));
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    replies[0]?.(valhalla("Main Street"));
    await vi.waitFor(() => expect(harness.road).toContain("Main Street"));
    fake.menu(MENU_HELP);
    await vi.waitFor(() => expect(fake.state.header).toBe("OPENGLANCE · help"));
    fake.gesture(DOUBLE_TAP);
    await vi.waitFor(() => expect(fake.state.pages.at(-1)).toBe("pixel-icon"));
    expect(harness.road).toContain("Main Street");
    expect(JSON.parse(fake.state.saved).activeSince).toBeGreaterThan(0);
    expect(replies).toHaveLength(1);
    expect(fake.state.shutdowns).toBe(0);
  });

  it("QIS v1.2: a swipe never changes the view; the side menu sets it, explicitly, and a hold does nothing", async () => {
    const fake = fakeBridge();
    await boot(fake);
    onTestFinished(() => fake.send({ sysEvent: { eventType: 7 } }));
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    replies[0]?.(valhalla("Map Street"));
    await vi.waitFor(() => expect(harness.road).toContain("Map Street"));
    fake.gesture(SWIPE);
    fake.gesture(SWIPE_DOWN);
    fake.gesture(HOLD);
    await settle();
    expect(fake.state.pages.at(-1)).toBe("pixel-icon");
    expect(JSON.parse(fake.state.saved).glassView ?? "turns").toBe("turns");
    fake.menu(MENU_VIEW_MAP);
    await vi.waitFor(() => expect(fake.state.pages.at(-1)).toBe("map-nw"));
    expect(JSON.parse(fake.state.saved).glassView).toBe("overview");
    fake.menu(MENU_VIEW_MAP); // setting what is set changes nothing
    await settle();
    expect(fake.state.pages.at(-1)).toBe("map-nw");
    fake.menu(MENU_VIEW_TURNS);
    await vi.waitFor(() => expect(fake.state.pages.at(-1)).toBe("pixel-icon"));
  });

  it("2x on a running navigation asks to stop and never opens the system's exit dialog (cancelling it left the app dead on the glasses, 15.10.)", async () => {
    const fake = fakeBridge();
    await boot(fake);
    onTestFinished(() => fake.send({ sysEvent: { eventType: 7 } }));
    fake.gesture(TAP);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    replies[0]?.(valhalla("Main Street"));
    await vi.waitFor(() => expect(harness.road).toContain("Main Street"));
    fake.gesture(DOUBLE_TAP);
    await vi.waitFor(() => expect(fake.state.footer).toContain("Tap again"));
    expect(fake.state.shutdowns).toBe(0);
    expect(JSON.parse(fake.state.saved).activeSince).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 600));
    fake.gesture(TAP);
    await vi.waitFor(() => expect(JSON.parse(fake.state.saved).activeSince).toBeNull());
    expect(fake.state.shutdowns).toBe(0);
  });

});

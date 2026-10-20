import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGestureDedupe } from "../src/input/gestures";
import { PLACES_KEY, serializePlaces } from "../src/route/places";

// Boots the real app against a fake bridge and walks through the route pages:
// menu, goals, connections, guide, and back out again.
const harness = vi.hoisted(() => ({
  bridge: null as unknown,
  /** Told every scene after it went to the glasses (per bridge): a cockpit page has no footer container, its hint is in the picture. */
  onScene: null as null | ((bridge: unknown, scene: { kind: string; view: { footer: string } }) => void),
}));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
vi.mock("../src/glasses/render", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/glasses/render")>();
  return {
    ...real,
    createPage: async (bridge: never, scene: never, menu: never) => { const result = await real.createPage(bridge, scene, menu); harness.onScene?.(bridge, scene); return result; },
    rebuildPage: async (bridge: never, scene: never, menu: never) => { const result = await real.rebuildPage(bridge, scene, menu); harness.onScene?.(bridge, scene); return result; },
    updatePage: async (bridge: never, scene: never) => { const result = await real.updatePage(bridge, scene); harness.onScene?.(bridge, scene); return result; },
  };
});

const nodeProcess = (globalThis as unknown as {
  process: {
    on(event: string, listener: (reason: unknown) => void): void;
    off(event: string, listener: (reason: unknown) => void): void;
  };
}).process;

interface MenuItem { itemName?: string; itemID?: number }

function fakeBridge(options: { stored?: Record<string, string>; fix?: { latitude: number; longitude: number } | null; confirmExit?: boolean } = {}) {
  let onEvent: ((event: unknown) => void) | undefined;
  const state = {
    shutdowns: 0, header: "", body: "", footer: "",
    menus: [] as string[][], rebuilds: 0, creates: 0, saved: new Map<string, string>(),
    /** The page kind on the glasses, told by its picture containers: "text", "cockpit" (tiles: the board, a followed bus, the walk), "wait" (bus), "ride" (digits). */
    kind: "text",
    /** Every picture sent: `containerName:bytes`. */
    images: [] as string[],
  };
  type Page = { menuObject?: { menuItems?: MenuItem[] }; textObject?: { containerID?: number; content?: string }[]; imageObject?: { containerName?: string }[] };
  const adopt = (page: Page): void => {
    state.header = "";
    const names = (page.imageObject ?? []).map((image) => image.containerName);
    state.kind = names.includes("cockpit-nw") ? "cockpit" : names.includes("bus") ? "wait" : names.includes("count") ? "ride" : names.includes("big") ? "board" : "text";
    // A page without a header container shows none.
    for (const text of page.textObject ?? []) record(text.containerID, text.content);
  };
  const record = (id: number | undefined, content: string | undefined): void => {
    if (id === 1) state.header = content ?? "";
    if (id === 2) state.body = content ?? "";
    if (id === 3) state.footer = content ?? "";
  };
  const note = (page: { menuObject?: { menuItems?: MenuItem[] } }): void => {
    state.menus.push((page.menuObject?.menuItems ?? []).map((item) => item.itemName ?? ""));
  };
  harness.onScene = (from, scene) => { if (from === bridge && scene.kind === "cockpit") state.footer = scene.view.footer; };
  const bridge = {
    getLocalStorage: async (key: string) => options.stored?.[key] ?? "",
    setLocalStorage: async (key: string, value: string) => { state.saved.set(key, value); return true; },
    rebuildPageContainer: async (page: Page) => {
      state.rebuilds += 1;
      note(page);
      adopt(page);
      return true;
    },
    createStartUpPageContainer: async (page: Page) => {
      state.creates += 1;
      note(page);
      adopt(page);
      return 0;
    },
    updateImageRawData: async (update: { containerName?: string; imageData?: Uint8Array }) => {
      state.images.push(`${update.containerName}:${update.imageData?.length ?? 0}`);
      return "success";
    },
    textContainerUpgrade: async (upgrade: { containerID?: number; content?: string }) => {
      record(upgrade.containerID, upgrade.content);
      return true;
    },
    startAppLocationUpdates: async () => true,
    stopAppLocationUpdates: async () => true,
    getAppLocation: async () => (options.fix === undefined ? null : options.fix),
    shutDownPageContainer: async () => { state.shutdowns += 1; return options.confirmExit ?? true; },
    onAppLocationChanged: () => () => undefined,
    onEvenHubEvent: (callback: (event: unknown) => void) => { onEvent = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, state,
    ready: () => onEvent !== undefined,
    gesture: (eventType: number) => { resetGestureDedupe(); onEvent?.({ sysEvent: { eventType, eventSource: 1 } }); },
    menu: (itemID: number) => onEvent?.({ menuItemClickEvent: { itemID } }),
  };
}

const CLICK = 0;
const UP = 1;
const DOWN = 2;
const HOLD = 9;
const DOUBLE = 3;

describe("the route pages", () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };

  beforeEach(() => {
    unhandled = [];
    nodeProcess.on("unhandledRejection", onUnhandled);
    vi.stubGlobal("document", { getElementById: () => null });
    vi.stubGlobal("navigator", { language: "de-AT" });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(unhandled).toEqual([]);
  });

  async function boot(fake: ReturnType<typeof fakeBridge>, search: string): Promise<void> {
    vi.stubGlobal("location", { search });
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("the demo must not touch the network"))));
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
  }

  it("walks from the departures to a guide and back, by menu and gestures", async () => {
    const fake = fakeBridge();
    await boot(fake, "?demo=1&lang=de&scene=board");
    // The board is the cockpit picture (QUS v1): four tiles, one empty input container.
    await vi.waitFor(() => expect(fake.state.kind).toBe("cockpit"));
    await vi.waitFor(() => expect(fake.state.images.filter((entry) => entry.startsWith("cockpit-")).length).toBeGreaterThanOrEqual(4));
    expect(fake.state.body.trim()).toBe("");
    // No page carries the native menu while its clicks do not arrive on the real glasses (step log 15.10.).
    expect(fake.state.menus[0]).toEqual([]);

    fake.menu(1); // Route planen (a menu click is still understood; the way by gesture is the hold: say the destination)
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^NEXTSTOP · Wohin\? · \d\d:\d\d$/));
    expect(fake.state.body.split("\n")).toEqual(["> Jetzt: Getreidegasse 10", "  Heim", "  Arbeit", "  Hauptbahnhof"]);
    expect(fake.state.menus.at(-1)).toEqual([]);
    // One rebuild before the single creation (it registers input on the glasses), one for the new menu.
    expect(fake.state.creates).toBe(1);
    expect(fake.state.rebuilds).toBe(4);

    fake.gesture(DOWN);
    await vi.waitFor(() => expect(fake.state.body).toContain("> Heim"));

    fake.gesture(CLICK);
    // The connections: the first one big, where to board and two more as rows.
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^1\/4 · Tippen = los/));
    expect(fake.state.kind).toBe("board");
    expect(fake.state.body.split("\n")[0]).toMatch(/^Ab .+ · \d+ min zu Fuß$/);
    expect(fake.state.body.split("\n")[1]).toMatch(/^in \d+ min · O-Bus 10 · an \d\d:\d\d$/);
    expect(fake.state.body.split("\n")).toHaveLength(3);
    expect(fake.state.menus.at(-1)).toEqual([]);

    fake.gesture(DOWN); // select the second connection
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^2\/4 · /));

    fake.gesture(CLICK);
    // The walk to the stop: as soon as its route is in, the cockpit with the map (QUS v1) and the hint beneath.
    await vi.waitFor(() => expect(fake.state.kind).toBe("cockpit"), { timeout: 5000 });
    expect(fake.state.footer).toMatch(/^1\/\d+ · (GPS|Uhr) · Tippen = weiter · 2× = Ende$/);
    expect(fake.state.body.trim()).toBe("");
    expect(fake.state.menus.at(-1)).toEqual([]);
    // The four tiles (map left, words right), sent once each for the first fix.
    const tiles = (): string[] => fake.state.images.map((entry) => entry.split(":")[0] ?? "").filter((name) => name.startsWith("cockpit-"));
    await vi.waitFor(() => expect(tiles().slice(-4)).toEqual(["cockpit-nw", "cockpit-ne", "cockpit-sw", "cockpit-se"]));

    // A tap steps by hand, scrolling goes back, the menu does the same.
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.kind).toBe("wait"));
    expect(fake.state.body.split("\n")[0]).toMatch(/^O-Bus 10 Richtung /);
    await vi.waitFor(() => expect(fake.state.images.slice(-2).map((entry) => entry.split(":")[0])).toEqual(["countdown", "bus"]));
    fake.gesture(UP);
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^1\/\d+ · /));
    expect(fake.state.kind).toBe("cockpit");
    fake.menu(6);
    await vi.waitFor(() => expect(fake.state.kind).toBe("wait"));

    // QIS v1: ending the guide is armed by a hold (no side menu), then needs a second single tap.
    fake.gesture(HOLD);
    await vi.waitFor(() => expect(fake.state.footer).toBe("Nochmal tippen = Fahrt abbrechen · 2× = abbrechen"));
    expect(fake.state.kind).toBe("wait");
    fake.gesture(UP); // a swipe only cancels: the guide runs on
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^\d\/\d+ · /));
    expect(fake.state.kind).toBe("wait");
    fake.gesture(HOLD);
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^Nochmal tippen = Fahrt abbrechen/));
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^\d\/4 · Tippen = los/));
    expect(fake.state.kind).toBe("board");

    fake.gesture(DOUBLE); // connections -> goals
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^NEXTSTOP · Wohin\? · /));
    fake.gesture(DOUBLE); // goals -> start page
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^NEXTSTOP · /));
    await vi.waitFor(() => expect(fake.state.body).toContain("Abfahrten"));
    expect(fake.state.shutdowns).toBe(0);

    fake.gesture(DOUBLE); // on the start page: the system exit dialog
    await vi.waitFor(() => expect(fake.state.shutdowns).toBe(1));
  });

  it("a hold in the guide only asks; a swipe, 2× or a second hold cancel, the next single tap ends it (no side menu)", async () => {
    for (const cancel of [UP, DOWN, DOUBLE, HOLD]) {
      const fake = fakeBridge({ confirmExit: false });
      await boot(fake, "?demo=1&lang=de&scene=guide");
      await vi.waitFor(() => expect(fake.state.footer).toMatch(/^1\/\d+ · (GPS|Uhr)/));
      fake.gesture(HOLD);
      await vi.waitFor(() => expect(fake.state.footer).toBe("Nochmal tippen = Fahrt abbrechen · 2× = abbrechen"));
      fake.gesture(cancel);
      await vi.waitFor(() => expect(fake.state.footer).toMatch(/^\d\/\d+ · /), { timeout: 2000 });
      expect(fake.state.shutdowns, "event " + cancel).toBe(0);
    }
    const fake = fakeBridge();
    await boot(fake, "?demo=1&lang=de&scene=guide");
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^1\/\d+ · (GPS|Uhr)/));
    fake.gesture(HOLD);
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^Nochmal tippen = Fahrt abbrechen/));
    fake.gesture(CLICK); // the second single tap ends the guide
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^1\/4 · Tippen = los/));
    expect(fake.state.menus.every((items) => items.length === 0)).toBe(true);
  });

  it("leaves the guide at once from the menu", async () => {
    const fake = fakeBridge();
    await boot(fake, "?demo=1&lang=de&scene=guide");
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^1\/\d+ · (GPS|Uhr)/));
    fake.menu(8); // arms only
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^Nochmal tippen = Fahrt abbrechen/));
    fake.gesture(CLICK); // the second single tap ends the guide
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^1\/4 · Tippen = los/));
  });

  it("sends no map tile while the exit dialog may be up, and none once the guide is left", async () => {
    const fake = fakeBridge({ confirmExit: false });
    // A fast demo clock: the walker keeps moving, so the map would be redrawn every few seconds.
    await boot(fake, "?demo=1&lang=de&scene=guide&speed=30");
    const mapTiles = (): number => fake.state.images.filter((entry) => entry.startsWith("cockpit-nw") || entry.startsWith("cockpit-sw")).length;
    await vi.waitFor(() => expect(fake.state.kind).toBe("cockpit"), { timeout: 5000 });
    await vi.waitFor(() => expect(mapTiles()).toBeGreaterThanOrEqual(4), { timeout: 12_000 });
    // 2x: the system exit dialog is asked (and declined, as far as the app knows); from now on nothing may draw.
    fake.gesture(DOUBLE);
    await vi.waitFor(() => expect(fake.state.shutdowns).toBe(1));
    const sent = fake.state.images.length;
    await new Promise((resolve) => setTimeout(resolve, 5000));
    expect(fake.state.images.length).toBe(sent);
    // The first signal after the dialog restores the page; leaving the guide then ends the map for good.
    fake.gesture(HOLD);
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^Nochmal tippen = Fahrt abbrechen/), { timeout: 5000 });
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.kind).toBe("board"), { timeout: 5000 });
    const after = mapTiles();
    await new Promise((resolve) => setTimeout(resolve, 5000));
    expect(mapTiles()).toBe(after);
  }, 40_000);

  it("a 2x never ends the running guide: it asks the system to exit, and the guide stays when the passenger stays", async () => {
    const fake = fakeBridge({ confirmExit: false });
    await boot(fake, "?demo=1&lang=de&scene=guide");
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^1\/\d+ · (GPS|Uhr)/));
    fake.menu(8); // armed ...
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^Nochmal tippen = Fahrt abbrechen/));
    fake.gesture(DOUBLE); // ... 2x only cancels
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^1\/\d+ · (GPS|Uhr)/));
    expect(fake.state.shutdowns).toBe(0);
    fake.gesture(DOUBLE); // not armed: the system exit dialog, which the passenger can decline
    await vi.waitFor(() => expect(fake.state.shutdowns).toBe(1));
    expect(fake.state.footer).toMatch(/^1\/\d+ · /);
    fake.gesture(CLICK); // still a guide: a tap steps, it does not end
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^2\/\d+ · /));
  });

  it("a stale arm is gone after 4 s: the next tap only steps", async () => {
    const fake = fakeBridge();
    await boot(fake, "?demo=1&lang=de&scene=guide");
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^1\/\d+ · (GPS|Uhr)/));
    fake.menu(8);
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^Nochmal tippen = Fahrt abbrechen/));
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^1\/\d+ · /), { timeout: 6000 });
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^2\/\d+ · /));
  }, 12_000);

  it("says what is missing when there is no location, instead of searching", async () => {
    const stored = { [PLACES_KEY]: serializePlaces({ favorites: [{ id: "h", name: "Heim", lat: 47.796, lon: 13.016 }], now: null }) };
    const fake = fakeBridge({ stored, fix: null });
    await boot(fake, "");
    await vi.waitFor(() => expect(fake.state.body).toContain("Abfahrten"));
    fake.gesture(CLICK); // the departures: without a location they say what is missing
    await vi.waitFor(() => expect(fake.state.body).toContain("Erlaube den Standort in der Even-App"));

    fake.menu(1);
    await vi.waitFor(() => expect(fake.state.body).toBe("> Heim"));
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.body).toContain("Erlaube den Standort in der Even-App"));
    expect(fake.state.footer).toBe("Tippen = nochmal · 2× = zurück");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks the real service when it is not the demo, and shows its failure", async () => {
    const stored = { [PLACES_KEY]: serializePlaces({ favorites: [{ id: "h", name: "Heim", lat: 47.796, lon: 13.016 }], now: null }) };
    const fake = fakeBridge({ stored, fix: { latitude: 47.8095, longitude: 13.055 } });
    harness.bridge = fake.bridge;
    vi.stubGlobal("location", { search: "" });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: string) => {
      urls.push(input);
      return Promise.resolve(new Response("busy", { status: 502 }));
    }));
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    fake.gesture(CLICK); // start page: open the departures
    // The failed first request shows on the next beat of the 2 s redraw.
    await vi.waitFor(() => expect(fake.state.body).toContain("Bitte gleich nochmal versuchen."), { timeout: 5000 });

    fake.menu(1);
    await vi.waitFor(() => expect(fake.state.body).toBe("> Heim"));
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(urls.some((url) => url.includes("/api/v1/plan"))).toBe(true));
    const plan = new URL(urls.find((url) => url.includes("/api/v1/plan"))!);
    expect(plan.origin).toBe("https://api.transitous.org");
    expect(plan.searchParams.get("fromPlace")).toBe("47.8095,13.055");
    expect(plan.searchParams.get("toPlace")).toBe("47.796,13.016");
    await vi.waitFor(() => expect(fake.state.body).toBe("Bitte gleich nochmal versuchen."));
    expect(fake.state.footer).toBe("Tippen = nochmal · 2× = zurück");
    expect(new Set(urls.map((url) => new URL(url).origin))).toEqual(new Set(["https://api.transitous.org"]));
  });
});

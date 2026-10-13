import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGestureDedupe } from "../src/input/gestures";
import { PLACES_KEY, serializePlaces } from "../src/route/places";

// Boots the real app against a fake bridge and walks through the route pages:
// menu, goals, connections, guide, and back out again.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const nodeProcess = (globalThis as unknown as {
  process: {
    on(event: string, listener: (reason: unknown) => void): void;
    off(event: string, listener: (reason: unknown) => void): void;
  };
}).process;

interface MenuItem { itemName?: string; itemID?: number }

function fakeBridge(options: { stored?: Record<string, string>; fix?: { latitude: number; longitude: number } | null } = {}) {
  let onEvent: ((event: unknown) => void) | undefined;
  const state = {
    shutdowns: 0, header: "", body: "", footer: "",
    menus: [] as string[][], rebuilds: 0, creates: 0, saved: new Map<string, string>(),
  };
  const record = (id: number | undefined, content: string | undefined): void => {
    if (id === 1) state.header = content ?? "";
    if (id === 2) state.body = content ?? "";
    if (id === 3) state.footer = content ?? "";
  };
  const note = (page: { menuObject?: { menuItems?: MenuItem[] } }): void => {
    state.menus.push((page.menuObject?.menuItems ?? []).map((item) => item.itemName ?? ""));
  };
  const bridge = {
    getLocalStorage: async (key: string) => options.stored?.[key] ?? "",
    setLocalStorage: async (key: string, value: string) => { state.saved.set(key, value); return true; },
    rebuildPageContainer: async (page: { menuObject?: { menuItems?: MenuItem[] }; textObject?: { containerID?: number; content?: string }[] }) => {
      state.rebuilds += 1;
      note(page);
      for (const text of page.textObject ?? []) record(text.containerID, text.content);
      return true;
    },
    createStartUpPageContainer: async (page: { menuObject?: { menuItems?: MenuItem[] }; textObject?: { containerID?: number; content?: string }[] }) => {
      state.creates += 1;
      note(page);
      for (const text of page.textObject ?? []) record(text.containerID, text.content);
      return 0;
    },
    textContainerUpgrade: async (upgrade: { containerID?: number; content?: string }) => {
      record(upgrade.containerID, upgrade.content);
      return true;
    },
    startAppLocationUpdates: async () => true,
    stopAppLocationUpdates: async () => true,
    getAppLocation: async () => (options.fix === undefined ? null : options.fix),
    shutDownPageContainer: async () => { state.shutdowns += 1; return true; },
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
    await boot(fake, "?demo=1&lang=de");
    await vi.waitFor(() => expect(fake.state.body).toContain("O-Bus 3"));
    // The first page carries the native menu with the way to the route pages.
    expect(fake.state.menus[0]).toEqual(["Route planen", "Neu laden"]);

    fake.menu(1); // Route planen
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^Wohin\? · \d\d:\d\d$/));
    expect(fake.state.body.split("\n")).toEqual(["> Jetzt: Getreidegasse 10", "  Heim", "  Arbeit", "  Hauptbahnhof"]);
    expect(fake.state.menus.at(-1)).toEqual(["Abfahrten"]);
    // One rebuild comes with creating the page (it registers event routing), one with the new menu.
    expect(fake.state.rebuilds).toBe(2);

    fake.gesture(DOWN);
    await vi.waitFor(() => expect(fake.state.body).toContain("> Heim"));

    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^→ Heim · /));
    await vi.waitFor(() => expect(fake.state.body).toContain("in 4 min"));
    expect(fake.state.body.split("\n")[0]).toMatch(/^> in 4 min · O-Bus 2 → O-Bus 10 · an \d\d:\d\d · 1×$/);
    expect(fake.state.menus.at(-1)).toEqual(["Ziele", "Neu suchen", "Abfahrten"]);

    fake.gesture(DOWN); // select the second connection
    await vi.waitFor(() => expect(fake.state.body.split("\n")[1]).toMatch(/^> /));

    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^Zu Fuß · /));
    expect(fake.state.body).toContain("Geh zu Haltestelle");
    expect(fake.state.menus.at(-1)).toEqual(["Nächster Schritt", "Vorheriger Schritt", "Begleitung beenden"]);

    // A tap steps by hand, scrolling goes back, the menu does the same.
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^Einsteigen · /));
    fake.gesture(UP);
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^Zu Fuß · /));
    fake.menu(6);
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^Einsteigen · /));

    // One double tap only asks; the second one leaves.
    fake.gesture(DOUBLE);
    await vi.waitFor(() => expect(fake.state.footer).toBe("Nochmal doppeltippen = Begleitung beenden"));
    expect(fake.state.header).toMatch(/^Einsteigen · /);
    fake.gesture(DOUBLE);
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^→ Heim · /));

    fake.gesture(DOUBLE); // connections -> goals
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^Wohin\? · /));
    fake.gesture(DOUBLE); // goals -> departures
    await vi.waitFor(() => expect(fake.state.body).toContain("O-Bus 3"));
    expect(fake.state.shutdowns).toBe(0);

    fake.gesture(DOUBLE); // on the first page: the system exit dialog, as before
    await vi.waitFor(() => expect(fake.state.shutdowns).toBe(1));
  });

  it("leaves the guide at once from the menu", async () => {
    const fake = fakeBridge();
    await boot(fake, "?demo=1&lang=de&scene=guide");
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^Zu Fuß · /));
    fake.menu(8);
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^→ Getreidegasse 10 · /));
  });

  it("says what is missing when there is no location, instead of searching", async () => {
    const stored = { [PLACES_KEY]: serializePlaces({ favorites: [{ id: "h", name: "Heim", lat: 47.796, lon: 13.016 }], now: null }) };
    const fake = fakeBridge({ stored, fix: null });
    await boot(fake, "");
    await vi.waitFor(() => expect(fake.state.body).toContain("Warte auf deinen Standort"));

    fake.menu(1);
    await vi.waitFor(() => expect(fake.state.body).toBe("> Heim"));
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.body).toContain("Ohne Standort keine Route"));
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
    // The failed first request shows on the next beat of the 2 s redraw.
    await vi.waitFor(() => expect(fake.state.body).toContain("gestört"), { timeout: 5000 });

    fake.menu(1);
    await vi.waitFor(() => expect(fake.state.body).toBe("> Heim"));
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(urls.some((url) => url.includes("/api/v1/plan"))).toBe(true));
    const plan = new URL(urls.find((url) => url.includes("/api/v1/plan"))!);
    expect(plan.origin).toBe("https://api.transitous.org");
    expect(plan.searchParams.get("fromPlace")).toBe("47.8095,13.055");
    expect(plan.searchParams.get("toPlace")).toBe("47.796,13.016");
    await vi.waitFor(() => expect(fake.state.body).toContain("Fahrplandienst gestört (502)"));
    expect(new Set(urls.map((url) => new URL(url).origin))).toEqual(new Set(["https://api.transitous.org"]));
  });
});

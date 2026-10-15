/**
 * Quietglass Interaction Standard (QIS v1, docs/BEDIENSTANDARD.md) for NextStop:
 * arm-and-confirm for everything that ends a running job, 2× only goes back,
 * footers in the fixed order and glossary, a help page, invertScroll, phone tabs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import recorded from "../src/demo/plan-salzburg.json";
import { demoJourneys } from "../src/demo/demo";
import { buildSteps, guideState } from "../src/route/guide";
import { arrivalOf, departureOf, type Journey, type TransitLeg } from "../src/route/journey";
import { guideScene } from "../src/route/scene";
import { guideView, helpView, placesView, plansView, voiceView, ROUTE_ROWS, ROUTE_WIDTH, type VoiceState } from "../src/route/view";
import { planScene } from "../src/route/plan-scene";
import { boardScene, followLoadingScene, followScene, messageScene } from "../src/glasses/board";
import { departureBoard, errorView, loadingView, type StopView } from "../src/glasses/view";
import { followRide } from "../src/ride/follow";
import { armedFooter, footer, ft, ROW_WIDTH } from "../src/footer";
import { EMPTY_PLACES, addFavorite, targetsOf } from "../src/route/places";
import { menuFor, MENU } from "../src/route/menu";
import { messages } from "../src/messages";
import { locales, type Locale } from "../src/i18n";
import { DEFAULT_SETTINGS } from "../src/storage/persist";
import { mountPhoneUi } from "../src/ui/phone";
import { resetGestureDedupe } from "../src/input/gestures";
import type { Departure, Ride, Stop } from "../src/transit/types";
import type { Position } from "../src/ride/tracker";

const HOME = { name: "Heim", lat: 47.796, lon: 13.016 };
const T0 = new Date("2026-10-13T12:00:00Z");
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60000);
const journeyOf = (locale: Locale): Journey => demoJourneys(recorded, T0, HOME, locale)[0]!;

// ---- footers, headers, glossary on every view --------------------------------------------

const ORDER: Record<Locale, string[]> = { de: ["Tippen", "Wischen", "Halten", "2×"], en: ["Tap", "Swipe", "Hold", "2×"] };
const RETIRED: Record<Locale, RegExp> = {
  de: /\bTap\b|\bWisch\b|\b2x\b|Doppeltipp|doppeltipp/,
  en: /\b2x\b|Doppeltipp|double-tap/i,
};

interface Named { readonly name: string; readonly footer: string; readonly header?: string; readonly end: "back" | "exit" | "armed" }

const MIRABELL: Stop = { id: "m", name: "Salzburg Mirabellplatz", lat: 47.8057, lon: 13.0431 };
const dep = (n: number, over: Partial<Departure> = {}): Departure => ({
  line: "Bus 150", headsign: "Bad Ischl via Hof", inMinutes: n, scheduled: at(n), expected: at(n),
  source: "realtime", track: "G", cancelled: false, tripId: `t${n}`, ...over,
});
const departures = [dep(2), dep(5), dep(9)];
const rideStops = (first: number) => ["Salzburg Hbf", "Salzburg Kiesel", "Salzburg Mirabellplatz", "Salzburg Hofwirt", "Salzburg Gnigl"].map((name, i) => ({
  stop: { id: String(i), name, lat: 47.8128 - i * 0.002, lon: 13.0456 + i * 0.002 },
  scheduled: at(first + i * 2), expected: at(first + i * 2), source: "realtime" as const, cancelled: false,
}));
const ride = (first: number): Ride => ({ line: "Bus 150", headsign: "Bad Ischl", stops: rideStops(first) });
const AT_STOP = { lat: 47.8057, lon: 13.0431, accuracy: 10 };

function views(locale: Locale): Named[] {
  const out: Named[] = [];
  const text = (name: string, view: StopView, end: Named["end"]): void => { out.push({ name, footer: view.footer, header: view.header, end }); };
  const big = (name: string, scene: { view: StopView }, end: Named["end"]): void => { out.push({ name, footer: scene.view.footer, end }); };

  // Departure board (root): list, empty, messages. Help lives in the side menu (QIS v1.2).
  big("board", boardScene(MIRABELL, departures, 99, locale, 0, T0), "exit");
  big("board last departure", boardScene(MIRABELL, departures, 99, locale, 2, T0), "exit");
  // Without a side menu (the real glasses, step log 15.10.) the list ends with the Hilfe entry.
  big("board Hilfe entry", boardScene(MIRABELL, departures, 99, locale, 3, T0, true), "exit");
  big("board last departure, Hilfe row follows", boardScene(MIRABELL, departures, 99, locale, 2, T0, true), "exit");
  big("board single departure", boardScene(MIRABELL, [dep(2)], null, locale, 0, T0), "exit");
  big("board empty", boardScene(MIRABELL, [], 99, locale, 0, T0), "exit");
  big("message: searching", messageScene("…", "", ft(locale, "exit"), "..."), "exit");
  big("message: error", messageScene("!", "", ft(locale, "exit", { tap: "again" }), "!"), "exit");
  // Following a bus.
  big("follow loading", followLoadingScene(dep(2), T0, locale), "exit");
  const coming = followRide(ride(1), 2, at(5), T0, AT_STOP)!;
  big("follow coming", followScene(dep(5), coming, T0, locale, 0), "exit");
  big("follow coming, armed", followScene(dep(5), coming, T0, locale, 0, true), "armed");
  const riding = followRide(ride(-6), 2, at(-2), T0, { lat: 47.8068, lon: 13.047 })!;
  big("follow riding", followScene(dep(5), riding, T0, locale, 0), "exit");
  big("follow riding, armed", followScene(dep(5), riding, T0, locale, 0, true), "armed");
  const done = followRide(ride(-20), 2, at(-12), T0, null)!;
  big("follow finished", followScene(dep(5), done, T0, locale, 0), "exit");
  // Goals, voice, connections.
  const places = addFavorite(EMPTY_PLACES, { name: "Heim", lat: 1, lon: 1 }, "h");
  text("goals", placesView(targetsOf(places), 0, T0, locale), "back");
  text("goals empty", placesView([], 0, T0, locale), "back");
  const voices: VoiceState[] = [
    { phase: "recording" }, { phase: "recording", live: "Hauptbahnhof" }, { phase: "working" },
    { phase: "error", error: "Zu kurz", hint: "Halte den Touchpad." },
    { phase: "results", heard: "Hbf", selected: 0, saved: false, results: [{ name: "Salzburg Hbf", detail: "AT", kind: "stop", lat: 1, lon: 1 }] },
    { phase: "results", heard: "Hbf", selected: 0, saved: true, results: [{ name: "Salzburg Hbf", detail: "AT", kind: "stop", lat: 1, lon: 1 }] },
  ];
  for (const state of voices) text(`voice ${state.phase}${"saved" in state && state.saved ? " saved" : ""}`, voiceView(state, T0, locale), "back");
  const journeys = demoJourneys(recorded, T0, HOME, locale);
  big("connections", planScene(journeys, 0, T0, locale), "back");
  big("connections, last", planScene(journeys, journeys.length - 1, T0, locale), "back");
  text("connections (text)", plansView("Heim", journeys, 0, T0, locale), "back");
  big("connections loading", messageScene("…", "Heim", ft(locale, "back"), "..."), "back");
  big("connections error", messageScene("!", "", ft(locale, "back", { tap: "again" }), "!"), "back");
  // The guide at every stage.
  const journey = journeyOf(locale);
  const steps = buildSteps(journey);
  const bus1 = journey.legs[1] as TransitLeg;
  const bus2 = journey.legs[3] as TransitLeg;
  const here = (stop: { lat: number; lon: number }): Position => ({ lat: stop.lat, lon: stop.lon, accuracy: 10 });
  const moments: Array<[string, Date, Position | null]> = [
    ["walk to stop", T0, null],
    ["boarding", at(3), here(bus1.stops[0]!.stop)],
    ["missed", new Date(departureOf(bus1).getTime() + 150000), here(bus1.stops[0]!.stop)],
    ["riding", at(5), null],
    ["riding, last stops", new Date(bus1.stops[3]!.expected.getTime() + 20000), here(bus1.stops[4]!.stop)],
    ["change", new Date(arrivalOf(bus1).getTime() + 2 * 60000), null],
    ["arrived", new Date(arrivalOf(bus2).getTime() + 3 * 60000), null],
  ];
  for (const [name, now, position] of moments) {
    const state = guideState(steps, now, position);
    for (const armed of [undefined, "stop", "search"] as const) {
      const display = armed ? { armed } : {};
      // The arrived page has nothing to end: it is armed never, the others may be.
      if (armed && state.step.kind === "arrived") continue;
      text(`guide ${name}${armed ? ` (armed ${armed})` : ""}`, guideView(state, now, position, locale, display), armed ? "armed" : state.phase === "arrived" ? "back" : "exit");
      big(`guide scene ${name}${armed ? ` (armed ${armed})` : ""}`, guideScene(state, now, position, locale, display), armed ? "armed" : state.phase === "arrived" ? "back" : "exit");
    }
  }
  const rerouted = guideState(steps, T0, null);
  text("guide rerouted", guideView(rerouted, T0, null, locale, { rerouted: true }), "exit");
  // The help page and the older text views.
  text("help", helpView(locale), "back");
  text("legacy board", departureBoard(MIRABELL, departures, 12, locale, 0, T0), "exit");
  text("legacy empty", departureBoard(MIRABELL, [], null, locale), "exit");
  text("legacy error", errorView("x", "y", locale), "exit");
  text("legacy loading", loadingView("x", "", locale), "exit");
  return out;
}

describe("QIS footers, headers and glossary", () => {
  for (const locale of ["de", "en"] as const) {
    it(`${locale}: every footer is one row wide, in the order Tippen, Wischen, Halten, 2× and ends in 2× = back/exit`, () => {
      const all = views(locale);
      expect(all.length).toBeGreaterThan(40);
      for (const view of all) {
        const label = `${view.name}: ${view.footer}`;
        expect(view.footer.length, label).toBeLessThanOrEqual(ROW_WIDTH);
        const parts = view.footer.split(" · ");
        const last = parts.at(-1) ?? "";
        if (view.end === "armed") {
          expect(view.footer, label).toMatch(locale === "de" ? /^Nochmal tippen = .+ · (Wischen\/)?2× = abbrechen$/ : /^Tap again = .+ · (Swipe\/)?2× = cancel$/);
          continue;
        }
        const word = locale === "de" ? (view.end === "exit" ? "Ende" : "zurück") : (view.end === "exit" ? "exit" : "back");
        expect(last, label).toBe(`2× = ${word}`);
        const words = ORDER[locale];
        const index = parts.map((part) => words.findIndex((w) => part.startsWith(`${w} =`)));
        const used = index.filter((i) => i >= 0);
        expect(used, label).toEqual([...used].sort((a, b) => a - b));
        expect(index.at(-1), label).toBe(3);
        expect(view.footer, label).not.toMatch(RETIRED[locale]);
      }
    });

    it(`${locale}: pages with a header name the app first and fit one row`, () => {
      for (const view of views(locale)) {
        if (view.header === undefined || view.header === "" || view.header === "NextStop") continue;
        expect(view.header.length, `${view.name}: ${view.header}`).toBeLessThanOrEqual(ROUTE_WIDTH);
        if (view.name.startsWith("legacy")) continue;
        expect(view.header.startsWith("NEXTSTOP · "), `${view.name}: ${view.header}`).toBe(true);
      }
    });
  }

  it("the shared builder drops the swipe, then the lead, then the hold - never the 2×", () => {
    expect(footer("de", { tap: "folgen", swipe: "wählen", hold: "Ziel" }, "exit", "1/4")).toBe("1/4 · Tippen = folgen · Halten = Ziel · 2× = Ende");
    expect(footer("en", { tap: "go", swipe: "select" }, "back", "2/4")).toBe("2/4 · Tap = go · Swipe = select · 2× = back");
    expect(footer("de", { tap: "x".repeat(8), hold: "y".repeat(6) }, "exit", "1/4")).toBe(`Tippen = ${"x".repeat(8)} · Halten = ${"y".repeat(6)} · 2× = Ende`);
    expect(footer("de", { tap: "x".repeat(60) }, "back").endsWith("2× = zurück")).toBe(true);
    expect(footer("de", { tap: "x".repeat(60) }, "back").length).toBeLessThanOrEqual(ROW_WIDTH);
  });

  it("the armed row says what the next tap does and keeps the cancel hint", () => {
    expect(armedFooter("de", "Fahrt abbrechen")).toBe("Nochmal tippen = Fahrt abbrechen · 2× = abbrechen");
    expect(armedFooter("en", "end")).toBe("Tap again = end · Swipe/2× = cancel");
    expect(armedFooter("de", "neu suchen").endsWith("2× = abbrechen")).toBe(true);
    expect(armedFooter("de", "x".repeat(80)).length).toBeLessThanOrEqual(ROW_WIDTH);
  });

  it("no German glasses string uses the retired words", () => {
    for (const [key, value] of Object.entries(messages["de"] ?? {})) {
      if (key.startsWith("p.")) continue; // the phone page is not the glasses
      expect(value, key).not.toMatch(/\bTap\b|\bWisch\b|\b2x\b|Doppeltipp|doppeltipp/);
    }
    for (const [key, value] of Object.entries(messages["en"] ?? {})) {
      if (key.startsWith("p.")) continue;
      expect(value, key).not.toMatch(/\b2x\b|double-tap/i);
    }
  });
});

describe("QIS help page", () => {
  it("lists the four gestures in footer order, then what the app needs, in both languages", () => {
    for (const locale of ["de", "en"] as const) {
      const view = helpView(locale);
      expect(view.header).toBe(`NEXTSTOP · ${locale === "de" ? "Hilfe" : "Help"}`);
      expect(view.body.length).toBeLessThanOrEqual(ROUTE_ROWS);
      for (const row of view.body) expect(row.length, row).toBeLessThanOrEqual(ROUTE_WIDTH);
      const words = ORDER[locale];
      const idx = words.map((w) => view.body.findIndex((row) => row.startsWith(w)));
      expect(idx.every((i) => i > 0)).toBe(true);
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
      expect(view.body.at(-1)).toMatch(locale === "de" ? /^Braucht/ : /^Needs/);
    }
  });

  it("is also in the menu of the departure board", () => {
    expect(menuFor("board", "de").items.at(-1)).toEqual({ id: MENU.help, label: "Hilfe" });
    expect(menuFor("board", "en").items.length).toBeLessThanOrEqual(4);
  });
});

// ---- the glasses against the real app, demo data ---------------------------------------------

const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const SETTINGS_KEY = "quietglass.nextstop.v1";
const CLICK = 0, UP = 1, DOWN = 2, DOUBLE = 3, HOLD = 9;

function fakeBridge(options: { stored?: Record<string, string>; confirmExit?: boolean } = {}) {
  let onEvent: ((event: unknown) => void) | undefined;
  const state = { shutdowns: 0, header: "", body: "", footer: "", kind: "text", mics: 0 };
  type Page = { textObject?: { containerID?: number; content?: string }[]; imageObject?: { containerName?: string }[] };
  const record = (id: number | undefined, content: string | undefined): void => {
    if (id === 1) state.header = content ?? "";
    if (id === 2) state.body = content ?? "";
    if (id === 3) state.footer = content ?? "";
  };
  const adopt = (page: Page): void => {
    state.header = "";
    const names = (page.imageObject ?? []).map((image) => image.containerName);
    state.kind = names.includes("big") ? "board" : "text";
    for (const text of page.textObject ?? []) record(text.containerID, text.content);
  };
  const bridge = {
    getLocalStorage: async (key: string) => options.stored?.[key] ?? "",
    setLocalStorage: async () => true,
    rebuildPageContainer: async (page: Page) => { adopt(page); return true; },
    createStartUpPageContainer: async (page: Page) => { adopt(page); return 0; },
    updateImageRawData: async () => "success",
    textContainerUpgrade: async (upgrade: { containerID?: number; content?: string }) => { record(upgrade.containerID, upgrade.content); return true; },
    startAppLocationUpdates: async () => true,
    stopAppLocationUpdates: async () => true,
    getAppLocation: async () => null,
    audioControl: async () => { state.mics += 1; return false; },
    shutDownPageContainer: async () => { state.shutdowns += 1; return options.confirmExit ?? false; },
    onAppLocationChanged: () => () => undefined,
    onEvenHubEvent: (callback: (event: unknown) => void) => { onEvent = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, state, ready: () => onEvent !== undefined,
    gesture: (eventType: number) => { resetGestureDedupe(); onEvent?.({ sysEvent: { eventType, eventSource: 1 } }); },
    menu: (itemID: number) => onEvent?.({ menuItemClickEvent: { itemID } }),
  };
}

describe("QIS on the glasses", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { getElementById: () => null });
    vi.stubGlobal("navigator", { language: "de-AT" });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("location", { search: "?demo=1&lang=de" });
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("the demo must not touch the network"))));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function boot(fake: ReturnType<typeof fakeBridge>): Promise<void> {
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^1\/4 · Tippen = folgen/));
  }

  it("every page menu carries Hilfe, and the help closes back to where it was opened from", async () => {
    for (const screen of ["board", "places", "plans", "voice", "guide"] as const) {
      expect(menuFor(screen, "de").items.some((item) => item.id === MENU.help), screen).toBe(true);
      expect(menuFor(screen, "de").items.length).toBeLessThanOrEqual(4);
    }
    const fake = fakeBridge();
    await boot(fake);
    fake.menu(MENU.route);
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^NEXTSTOP · Wohin\?/));
    fake.menu(MENU.help);
    await vi.waitFor(() => expect(fake.state.header).toBe("NEXTSTOP · Hilfe"));
    fake.gesture(DOUBLE);
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^NEXTSTOP · Wohin\?/));
  });

  it("the menu entry 'Neu suchen' is armed: the first click only changes the footer, a swipe cancels", async () => {
    const fake = fakeBridge();
    await boot(fake);
    fake.menu(MENU.route);
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^NEXTSTOP · Wohin\?/));
    fake.gesture(CLICK); // the first target plans a trip
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^1\/4 · Tippen = los/));
    fake.menu(MENU.again);
    await vi.waitFor(() => expect(fake.state.footer).toBe("Nochmal tippen = neu suchen · 2× = abbrechen"));
    fake.gesture(DOWN);
    await vi.waitFor(() => expect(fake.state.footer).not.toMatch(/^Nochmal/));
  });

  it("Hilfe is the last entry of the departure list (no side menu): swipe to it, tap opens, 2× goes back to the board", async () => {
    const fake = fakeBridge();
    await boot(fake);
    for (let i = 0; i < 6; i += 1) fake.gesture(DOWN);
    await vi.waitFor(() => expect(fake.state.footer).toBe("Tippen = öffnen · Wischen = wählen · 2× = Ende"));
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.header).toBe("NEXTSTOP · Hilfe"));
    expect(fake.state.kind).toBe("text");
    expect(fake.state.footer).toBe("Tippen = schließen · 2× = zurück");
    fake.gesture(DOWN); // a swipe on the help changes nothing
    fake.gesture(DOUBLE); // 2× is back, it does not exit
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^\d\/4 · Tippen = folgen|^Tippen = öffnen/));
    expect(fake.state.shutdowns).toBe(0);
    fake.menu(MENU.help); // and a menu click (if a menu is ever switched on again) reaches it from anywhere on the board
    await vi.waitFor(() => expect(fake.state.header).toBe("NEXTSTOP · Hilfe"));
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.kind).toBe("board"));
  });

  it("following a running ride: a tap arms, swipe / 2× / the timeout cancel, the second tap ends it", async () => {
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(CLICK); // follow the first departure (the demo ride is instant)
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/Tippen = Fahrt abbrechen · 2× = Ende$/));

    fake.gesture(CLICK); // arms - the ride runs on
    await vi.waitFor(() => expect(fake.state.footer).toBe("Nochmal tippen = Fahrt abbrechen · 2× = abbrechen"));
    fake.gesture(DOWN); // a swipe cancels
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/Tippen = Fahrt abbrechen · 2× = Ende$/));

    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^Nochmal tippen/));
    fake.gesture(DOUBLE); // 2× only cancels; it is not the exit dialog either
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/Tippen = Fahrt abbrechen · 2× = Ende$/));
    expect(fake.state.shutdowns).toBe(0);

    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^Nochmal tippen/));
    fake.gesture(HOLD); // a hold cancels as well
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/Tippen = Fahrt abbrechen · 2× = Ende$/));
    expect(fake.state.mics).toBe(0); // and did not start a recording

    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^Nochmal tippen/));
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/Tippen = Fahrt abbrechen · 2× = Ende$/), { timeout: 6000 }); // 4 s without input
    fake.gesture(CLICK); // the stale arm is gone: this only arms again
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^Nochmal tippen/));

    fake.gesture(CLICK); // the confirming tap
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^1\/4 · Tippen = folgen/));
  });

  it("a menu reload never drops a followed ride", async () => {
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/Tippen = Fahrt abbrechen/));
    fake.menu(MENU.refresh);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fake.state.footer).toMatch(/Tippen = Fahrt abbrechen/);
  });

  it("2× on the board is the system exit dialog, also while a ride is followed (declining keeps it)", async () => {
    const fake = fakeBridge({ confirmExit: false });
    await boot(fake);
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/Tippen = Fahrt abbrechen/));
    fake.gesture(DOUBLE);
    await vi.waitFor(() => expect(fake.state.shutdowns).toBe(1));
    expect(fake.state.footer).toMatch(/Tippen = Fahrt abbrechen/);
  });

  it("invertScroll from the phone setting swaps the swipe direction on the departure list", async () => {
    const fake = fakeBridge({ stored: { [SETTINGS_KEY]: JSON.stringify({ ...DEFAULT_SETTINGS, invertScroll: true }) } });
    await boot(fake);
    fake.gesture(DOWN); // SCROLL_BOTTOM is "up" when inverted: nothing above the first departure
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fake.state.footer).toMatch(/^1\/4 · /);
    fake.gesture(UP); // SCROLL_TOP is "down" when inverted
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^2\/4 · /));
  });

  it("without the setting the directions are as before", async () => {
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(DOWN);
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^2\/4 · /));
  });
});

// ---- the phone page --------------------------------------------------------------------

describe("QIS phone tabs and the swipe-direction switch", () => {
  class FakeElement {
    value = ""; textContent = ""; hidden = false; checked = false;
    readonly listeners = new Map<string, Array<() => void>>();
    addEventListener(type: string, fn: () => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
    fire(type: string): void { for (const fn of this.listeners.get(type) ?? []) fn(); }
    setCustomValidity(): void { /* not needed */ }
    reportValidity(): boolean { return true; }
  }
  let html = "";
  const elements = new Map<string, FakeElement>();
  const root = {
    set innerHTML(value: string) { html = value; elements.clear(); },
    get innerHTML() { return html; },
    querySelector(selector: string) {
      if (!elements.has(selector)) elements.set(selector, new FakeElement());
      return elements.get(selector);
    },
    querySelectorAll: () => [],
  };

  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("document", { getElementById: () => root }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("tabs run stops, goals, glasses, connection, more (content first, Brille, Verbindung, Mehr last)", () => {
    mountPhoneUi({
      getSettings: () => DEFAULT_SETTINGS, setSettings: async () => undefined, getPosition: () => null, isSeeded: () => false,
      getStops: () => [], refresh: () => undefined, getLocale: () => "de", getPlaces: () => EMPTY_PLACES, setPlaces: async () => undefined,
    });
    const order = [...html.matchAll(/data-tab-go="(\w+)"/g)].map((match) => match[1]);
    expect(order).toEqual(["stops", "goals", "glasses", "connection", "more"]);
    const labels = [...html.matchAll(/<\/span>([^<]+)<\/button>/g)].map((match) => match[1]);
    expect(labels).toEqual(["Haltestellen", "Ziele", "Brille", "Verbindung", "Mehr"]);
    // The swipe switch lives under Brille, the addresses under Verbindung.
    const glasses = html.slice(html.indexOf('data-tab="glasses"'), html.indexOf('data-tab="connection"'));
    expect(glasses).toContain('id="invert"');
    const connection = html.slice(html.indexOf('data-tab="connection"'), html.indexOf('data-tab="more"'));
    expect(connection).toContain('id="backend"');
    expect(connection).toContain('id="oebb-url"');
  });

  it("the switch saves invertScroll without touching the other settings", () => {
    let saved = DEFAULT_SETTINGS;
    mountPhoneUi({
      getSettings: () => saved, setSettings: async (next) => { saved = next; }, getPosition: () => null, isSeeded: () => false,
      getStops: () => [], refresh: () => undefined, getLocale: () => "en",
    });
    const invert = root.querySelector("#invert") as FakeElement;
    expect(invert.checked).toBe(false);
    invert.checked = true;
    invert.fire("change");
    expect(saved).toEqual({ ...DEFAULT_SETTINGS, invertScroll: true });
    expect(html).toContain("Invert swipe direction");
  });
});

describe("locales", () => {
  it("the new strings exist in every language of the app", () => {
    for (const locale of locales) for (const key of ["q.follow", "h.tap", "h.needs", "g.helpTitle", "r.menuHelp", "p.invert", "p.tabConnection"]) {
      expect(messages[locale]?.[key], `${locale}:${key}`).toBeTruthy();
    }
  });
});

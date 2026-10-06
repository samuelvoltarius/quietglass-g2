import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, languageSelect, locales, setLocale, tr, type Locale } from "../src/i18n";
import { messages } from "../src/messages";
import {
  BODY_ROWS, LINE_WIDTH, departureBoard, errorView, loadingView, ridingView, waitLabel, type StopView,
} from "../src/glasses/view";
import { etaLabel, trackRide } from "../src/ride/tracker";
import { explainFailure, glassesText, nextStep, noStopsHint } from "../src/text";
import { DEFAULT_SETTINGS, validateUrl } from "../src/storage/persist";
import { mountPhoneUi } from "../src/ui/phone";
import type { Departure, Ride, Stop } from "../src/transit/types";

// Boots the real app against a fake bridge for the language-switch test.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const vars = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();

const NOW = new Date("2026-09-25T19:00:00Z");
const STOP: Stop = { id: "1", name: "Salzburg Mirabellplatz", lat: 47.8057, lon: 13.0429 };
const LONG_STOP: Stop = { id: "2", name: "Salzburg Hauptbahnhof (Südtiroler Platz) Bussteig F", lat: 47.8, lon: 13.04 };

function departure(over: Partial<Departure> = {}): Departure {
  return {
    line: "O-Bus 6", headsign: "Itzling West", inMinutes: 4,
    scheduled: new Date(NOW.getTime() + 4 * 60000), expected: new Date(NOW.getTime() + 4 * 60000),
    source: "scheduled", cancelled: false, tripId: "t1", ...over,
  };
}

const minutes = (n: number): Date => new Date(NOW.getTime() + n * 60000);

/** A long board: delays, a cancellation, long lines and destinations, platforms, hours. */
const BUSY_BOARD: Departure[] = [
  departure({ inMinutes: 0, source: "realtime", line: "175", headsign: "Salzburg Hbf", track: "B", expected: NOW, scheduled: NOW }),
  departure({ inMinutes: 11, source: "realtime", expected: minutes(11) }),
  departure({ cancelled: true, source: "realtime" }),
  departure({ inMinutes: 95, line: "REX 1", headsign: "Wien Westbahnhof über Linz, St. Pölten und Tullnerfeld", track: "3" }),
  departure({
    inMinutes: 12, source: "realtime", line: "Railjet Xpress 563", headsign: "Wien Hauptbahnhof Bahnsteig 1-2",
    track: "10A", expected: minutes(15), scheduled: minutes(12),
  }),
  ...Array.from({ length: 10 }, (_, i) => departure({ inMinutes: 20 + i, expected: minutes(20 + i), line: `Bus ${100 + i}` })),
];

function ride(count: number, options: { cancelFirst?: boolean; longNames?: boolean; lateEnd?: boolean } = {}): Ride {
  return {
    line: "Railjet Xpress 563",
    headsign: "Wien Hauptbahnhof über Linz, St. Pölten und Tullnerfeld",
    stops: Array.from({ length: count }, (_, i) => ({
      stop: {
        id: `s${i}`,
        name: options.longNames ? `Salzburg Makartplatz Haltestelle Nummer ${i} (Aicherpassage)` : `Halt ${i}`,
        lat: 47.8 + i * 0.0045, lon: 13.04,
      },
      scheduled: minutes(i),
      expected: minutes(options.lateEnd && i === count - 1 ? 200 : i),
      source: "realtime" as const,
      cancelled: options.cancelFirst === true && i === 0,
    })),
  };
}

/** Every screen worth checking, in one language. */
function screens(locale: Locale): StopView[] {
  const views: StopView[] = [];
  const text = glassesText(locale);
  // No location yet, searching, loading a ride.
  views.push(loadingView(text.waitingForLocation, text.waitingHint, locale));
  views.push(loadingView(text.searching, "", locale));
  views.push(loadingView(text.loadingRide, "", locale));
  // Boards: busy, scrolled to the bottom, long stop name far away, timetable only, empty.
  views.push(departureBoard(STOP, BUSY_BOARD, 35, locale, 0, NOW));
  views.push(departureBoard(LONG_STOP, BUSY_BOARD, 12345, locale, BUSY_BOARD.length - 1, NOW));
  views.push(departureBoard(LONG_STOP, [departure(), departure()], 999, locale, 1, NOW));
  views.push(departureBoard(LONG_STOP, [], 999, locale, 0, NOW));
  // Riding: on the clock, on GPS far from the stop, cancelled next stop, one stop left, last stop, finished.
  const long = ride(12, { longNames: true, lateEnd: true });
  views.push(ridingView(trackRide(long, minutes(2.5), null)!, minutes(2.5), long.line, long.headsign, locale));
  views.push(ridingView(
    trackRide(long, minutes(2.5), { lat: 47.8 + 2.7 * 0.0045, lon: 13.06 })!, minutes(2.5), long.line, long.headsign, locale,
  ));
  const cancelled = ride(4, { cancelFirst: true, longNames: true });
  views.push(ridingView(trackRide(cancelled, NOW, null)!, NOW, cancelled.line, cancelled.headsign, locale));
  const short = ride(3, { longNames: true });
  views.push(ridingView(trackRide(short, minutes(1.2), null)!, minutes(1.2), short.line, short.headsign, locale));
  views.push(ridingView(trackRide(short, minutes(1.9), null)!, minutes(1.9), short.line, short.headsign, locale));
  views.push(ridingView(trackRide(short, minutes(99), null)!, minutes(99), short.line, short.headsign, locale));
  // Errors.
  for (const backend of ["oebb", "motis"] as const) {
    for (const message of ["Failed to fetch", "timed out", "HTTP 403", "HTTP 502", "Unexpected token"]) {
      const { error, hint } = explainFailure(message, backend, locale);
      views.push(errorView(error, hint, locale));
    }
    views.push(errorView(text.noStops, noStopsHint(backend, locale), locale));
  }
  views.push(errorView(text.noRide, text.noRideHint, locale));
  return views;
}

describe("translations", () => {
  it("has every key in German and English", () => {
    expect(Object.keys(messages.de).sort()).toEqual(Object.keys(messages.en).sort());
  });

  it("uses the same placeholders in both languages", () => {
    for (const key of Object.keys(messages.en)) {
      expect(vars(messages.de[key] ?? ""), key).toEqual(vars(messages.en[key] ?? ""));
    }
  });

  it("leaves no placeholder behind once filled", () => {
    for (const locale of locales) {
      for (const [key, text] of Object.entries(messages[locale])) {
        const filled = tr(messages, locale, key, Object.fromEntries(vars(text).map((name) => [name, 1])));
        expect(filled, key).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it("uses real umlauts and no glyph the G2 cannot draw", () => {
    const german = Object.values(messages.de).join(" ");
    expect(german).toMatch(/[äöüß]/);
    expect(german).not.toMatch(/\b(fuer|ueber|zurueck|naechste|Naehe|faellt|Oesterreich)\b/i);
    for (const locale of locales) {
      for (const [key, text] of Object.entries(messages[locale])) {
        if (key.startsWith("g.")) expect(text, key).not.toMatch(/[▸►▶◆]/);
      }
    }
    // English glasses text: ASCII plus the glyphs the display is known to draw.
    for (const [key, text] of Object.entries(messages.en)) {
      if (key.startsWith("g.")) expect(text, key).toMatch(/^[\x20-\x7eäöüÄÖÜß●→…·○]*$/);
    }
  });

  it("keeps technical words off the English glasses, as the German does", () => {
    const jargon = /proxy|cors|backend|hafas|motis|endpoint|bridge|client|feed|http:/i;
    for (const [key, text] of Object.entries(messages.en)) {
      if (key.startsWith("g.") || key.startsWith("p.next")) expect(text, key).not.toMatch(jargon);
    }
  });

  it("formats times in the chosen language", () => {
    expect(waitLabel(departure({ inMinutes: 0 }), "en")).toBe("now");
    expect(waitLabel(departure({ inMinutes: 3 }), "en")).toBe("3 min");
    expect(waitLabel(departure({ inMinutes: 95 }), "en")).toBe("1h35");
    expect(waitLabel(departure({ cancelled: true }), "en")).toBe("cancelled");
    const stop = { stop: STOP, scheduled: NOW, expected: minutes(135), source: "scheduled" as const, cancelled: false };
    expect(etaLabel(stop, NOW, "en")).toBe("2h 15m");
    expect(etaLabel(stop, minutes(140), "en")).toBe("now");
  });
});

describe("language choice", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("follows the device language and falls back to English", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("navigator", { language: "de-AT" });
    expect(getLocale()).toBe("de");
    vi.stubGlobal("navigator", { language: "en-US" });
    expect(getLocale()).toBe("en");
    vi.stubGlobal("navigator", { language: "it-IT" });
    expect(getLocale()).toBe("en");
  });

  it("prefers the language picked on the phone, and survives blocked storage", () => {
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("localStorage", { getItem: () => "de", setItem: () => undefined });
    expect(getLocale()).toBe("de");
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(getLocale()).toBe("en");
    expect(() => setLocale("de")).not.toThrow();
    vi.stubGlobal("navigator", { language: "de-DE" });
    expect(getLocale()).toBe("de");
  });

  it("offers German and English on the phone", () => {
    const html = languageSelect("de");
    expect(html).toContain("Sprache");
    expect(html).toContain('<option value="de" selected>');
    expect(html.match(/<option/g)).toHaveLength(2);
  });
});

describe("glasses text budget", () => {
  for (const locale of locales) {
    it(`fits every ${locale} screen into ${BODY_ROWS} rows of ${LINE_WIDTH} characters`, () => {
      for (const view of screens(locale)) {
        expect(view.header.length, view.header).toBeLessThanOrEqual(LINE_WIDTH);
        expect(view.footer.length, view.footer).toBeLessThanOrEqual(LINE_WIDTH);
        expect(view.body.length, view.body.join("|")).toBeLessThanOrEqual(BODY_ROWS);
        for (const line of view.body) expect(line.length, line).toBeLessThanOrEqual(LINE_WIDTH);
      }
    });
  }

  it("does not cut any English sentence short on the error and waiting screens", () => {
    // errorView keeps at most BODY_ROWS rows; a sentence that needed more would be lost.
    for (const view of screens("en").filter((v) => v.header === "NextStop")) {
      expect(view.body.length).toBeLessThan(BODY_ROWS);
    }
  });
});

describe("German output stays exactly as reviewed", () => {
  it("pins the departure board", () => {
    const board = departureBoard(STOP, BUSY_BOARD.slice(0, 5), 35, "de", 0, NOW);
    expect(board).toEqual({
      header: "Salzburg Mirabellplatz · 35 m",
      body: [
        "> jetzt ●  175  Salzburg Hbf · B",
        "  11 min +7  O-Bus 6  Itzling West",
        "  fällt aus  O-Bus 6  Itzling West",
        "  4 min ~  REX 1  Wien Westbahnhof über L… · 3",
        "  15 min +3  Railjet Xpress 563  Wien H… · 10A",
      ],
      footer: "tippen = verfolgen · ● live  ~ Fahrplan",
    });
    expect(departureBoard(STOP, [], null, "de")).toEqual({
      header: "Salzburg Mirabellplatz",
      body: ["", "Keine Abfahrten in der nächsten Stunde.", "", "Betriebsschluss, oder diese Haltestelle", "wird gerade nicht bedient."],
      footer: "halten = andere Haltestelle",
    });
    expect(departureBoard(STOP, [departure()], null, "de").footer).toBe("tippen = verfolgen · nur Fahrplan");
  });

  it("pins the ride", () => {
    const simple: Ride = { ...ride(10), line: "O-Bus 6", headsign: "Itzling West" };
    const at = minutes(2.5);
    expect(ridingView(trackRide(simple, at, null)!, at, simple.line, simple.headsign, "de")).toEqual({
      header: "O-Bus 6 → Itzling West",
      body: ["> Halt 3 · gleich", "  Halt 4 · 2 min", "  Halt 5 · 3 min", "  Halt 6 · 4 min", "  Halt 7 · 5 min", "", "noch 6 Halte · Ziel 7 min"],
      footer: "nach Fahrplan geschätzt · tippen = zurück",
    });
    const gps = ridingView(trackRide(simple, at, { lat: 47.8 + 2.7 * 0.0045, lon: 13.04 })!, at, "O-Bus 6", "Itzling", "de");
    expect(gps.footer).toBe("GPS · 150 m · tippen = zurück");
    const two = ride(3);
    expect(ridingView(trackRide(two, minutes(0.2), null)!, minutes(0.2), "1", "X", "de").body.at(-1)).toBe("noch 1 Halt · Ziel 2 min");
    expect(ridingView(trackRide(two, minutes(1.9), null)!, minutes(1.9), "1", "X", "de").body.at(-1)).toBe("letzter Halt");
    expect(ridingView(trackRide(two, minutes(99), null)!, minutes(99), "1", "X", "de")).toEqual({
      header: "1 → X",
      body: ["", "Endstation Halt 2.", "", "Die Fahrt ist zu Ende."],
      footer: "tippen = zurück zur Haltestelle",
    });
    const cancelled = ride(3, { cancelFirst: true });
    expect(ridingView(trackRide(cancelled, minutes(-3), null)!, minutes(-3), "1", "X", "de").body[0]).toBe("> Halt 0 · fällt aus");
  });

  it("pins errors and waiting screens", () => {
    const text = glassesText("de");
    expect(loadingView(text.waitingForLocation, text.waitingHint, "de")).toEqual({
      header: "NextStop",
      body: ["", "Warte auf deinen Standort …", "", "Erlaube den Standort in der Even-App. Draußen", "klappt es am schnellsten."],
      footer: "doppeltippen = beenden",
    });
    expect(explainFailure("Failed to fetch", "oebb", "de")).toEqual({
      error: "ÖBB nicht erreichbar", hint: "ÖBB-Echtzeit braucht ein Zusatzprogramm. Ohne: am Handy „Überall“ wählen.",
    });
    expect(explainFailure("HTTP 502", "motis", "de").error).toBe("Fahrplandienst gestört (502)");
    expect(errorView(text.noStops, noStopsHint("motis", "de"), "de")).toEqual({
      header: "NextStop",
      body: ["", "Keine Haltestelle in der Nähe", "", "Hier sind keine Fahrplandaten hinterlegt. In", "Österreich: am Handy ÖBB wählen."],
      footer: "tippen = nochmal versuchen",
    });
    expect(validateUrl("ftp://x", "de").error).toBe("Adresse muss mit http:// oder https:// beginnen.");
  });

  it("pins the phone page", () => {
    let html = "";
    const elements = new Map<string, { textContent: string; value: string; hidden: boolean; addEventListener(): void }>();
    const root = {
      set innerHTML(value: string) { html = value; elements.clear(); },
      get innerHTML() { return html; },
      querySelector: (selector: string) => {
        if (!elements.has(selector)) elements.set(selector, { textContent: "", value: "", hidden: false, addEventListener: () => undefined });
        return elements.get(selector);
      },
    };
    vi.useFakeTimers();
    vi.stubGlobal("document", { getElementById: () => root });
    mountPhoneUi({
      getSettings: () => ({ ...DEFAULT_SETTINGS, backend: "oebb" }), setSettings: async () => undefined,
      getPosition: () => ({ lat: 47.8, lon: 13.04, accuracy: 12.4 }), isSeeded: () => false,
      getStops: () => [STOP, STOP], refresh: () => undefined, getLocale: () => "de",
    });
    expect(elements.get("#status")?.textContent).toBe("Standort gefunden (± 12 m). Nächste Haltestelle: Salzburg Mirabellplatz (2 in der Nähe).");
    expect(elements.get("#next")?.textContent).toBe(nextStep(true, 2, "de"));
    expect(nextStep(true, 2, "de")).toBe("Fertig. Auf der Brille: wischen = Abfahrt wählen, tippen = mitfahren.");
    expect(elements.get("#backend-hint")?.textContent).toBe(
      "Zeigt Verspätungen in ganz Österreich, bis zum Stadtbus. Braucht ein kleines Zusatzprogramm auf einem Computer im selben WLAN – siehe „Erweitert“ unten.",
    );
    expect(html).toContain('<option value="motis">Überall – Fahrplan (funktioniert sofort)</option>');
    expect(html).toContain("<strong>Tippen</strong> — mitfahren und den nächsten Halt sehen, nochmal tippen = zurück<br />");
    expect(html).toContain('<label for="refresh">Abfahrten neu laden alle <span id="refresh-value"></span> s</label>');
    expect(html).toContain('Fahrplandaten: <a href="https://transitous.org/sources/" target="_blank" rel="noopener">Transitous und seine Quellen</a> (u. a. OpenStreetMap) · Echtzeit Österreich: ÖBB');
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// The language switch on the phone, driven through the real main.ts wiring.

class FakeElement {
  value = "";
  textContent = "";
  hidden = false;
  open = false;
  readonly #listeners = new Map<string, (() => void)[]>();
  addEventListener(type: string, listener: () => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  fire(type: string): void { for (const listener of this.#listeners.get(type) ?? []) listener(); }
  setCustomValidity(): void { /* not needed */ }
  reportValidity(): boolean { return true; }
}

class FakeRoot {
  #html = "";
  #elements = new Map<string, FakeElement>();
  set innerHTML(html: string) { this.#html = html; this.#elements = new Map(); }
  get innerHTML(): string { return this.#html; }
  querySelector(selector: string): FakeElement {
    let element = this.#elements.get(selector);
    if (!element) { element = new FakeElement(); this.#elements.set(selector, element); }
    return element;
  }
}

describe("switching the language on the phone", () => {
  let saved: string | null;

  beforeEach(() => {
    saved = null;
    vi.stubGlobal("navigator", { language: "de-AT" });
    vi.stubGlobal("localStorage", {
      getItem: () => saved,
      setItem: (key: string, value: string) => { if (key === "quietglass.locale") saved = value; },
    });
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("redraws the glasses in the new language at once, and remembers it", async () => {
    const root = new FakeRoot();
    vi.stubGlobal("document", { getElementById: (id: string) => (id === "app" ? root : null) });
    const glasses = { header: "", body: "", footer: "" };
    const record = (id: number | undefined, content: string | undefined): void => {
      if (id === 1) glasses.header = content ?? "";
      if (id === 2) glasses.body = content ?? "";
      if (id === 3) glasses.footer = content ?? "";
    };
    harness.bridge = {
      getLocalStorage: async () => "",
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
      getAppLocation: async () => null,
      shutDownPageContainer: async () => false,
      onAppLocationChanged: () => () => undefined,
      onEvenHubEvent: () => () => undefined,
      onDeviceStatusChanged: () => () => undefined,
    };
    vi.resetModules();
    await import("../src/main");

    // Device language German: glasses and phone start in German.
    await vi.waitFor(() => expect(root.innerHTML).toContain("Woher kommen die Abfahrten?"));
    await vi.waitFor(() => expect(glasses.body).toContain("Warte auf deinen Standort"));
    expect(glasses.footer).toBe("doppeltippen = beenden");

    const language = root.querySelector("#language");
    language.value = "en";
    language.fire("change");

    await vi.waitFor(() => expect(glasses.body).toContain("Waiting for your location"));
    expect(glasses.body).toContain("Allow location in the Even app.");
    expect(glasses.footer).toBe("double-tap = exit");
    expect(root.innerHTML).toContain("Where do the departures come from?");
    expect(root.innerHTML).toContain('<option value="en" selected>');
    expect(root.innerHTML).not.toContain("Woher");
    expect(root.querySelector("#next").textContent).toContain("Allow location in the Even app");
    expect(saved).toBe("en");

    // And back again.
    const again = root.querySelector("#language");
    again.value = "de";
    again.fire("change");
    await vi.waitFor(() => expect(glasses.body).toContain("Warte auf deinen Standort"));
    expect(saved).toBe("de");
  });
});

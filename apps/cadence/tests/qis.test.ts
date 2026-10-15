import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGestureDedupe } from "../src/input/gestures";
import { buildView } from "../src/glasses/view";
import { armedFooter, footer, ROW_WIDTH } from "../src/glasses/footer";
import { messages } from "../src/messages";
import { createState, DEFAULT_SETTINGS, start } from "../src/metronome/engine";
import { mountPhoneUi } from "../src/ui/phone";
import { EMPTY_DATA } from "../src/storage/persist";
import type { Locale } from "../src/i18n";

// QIS v1: footer order and wording, and the arm-then-confirm pause on the real app.

const LOCALES: readonly Locale[] = ["de", "en"];
const WORDS = {
  de: ["Tippen", "Wischen", "Halten", "2×"],
  en: ["Tap", "Swipe", "Hold", "2×"],
} as const;
const BANNED = { de: /\b(Tap|Wisch|Doppeltipp)\b|2x/, en: /2x/ } as const;

function everyView(locale: Locale) {
  const running = start(createState(), 0);
  const options = { locale, item: "Bach Partita No. 2 in D minor, Chaconne, bars 1 to 132", sessionSeconds: 35_999 };
  return [
    ["fresh", buildView(createState(), DEFAULT_SETTINGS, { locale }, 0)],
    ["stopped after run", buildView({ ...running, running: false, startedAt: null, beatsBefore: 12 }, DEFAULT_SETTINGS, options, 0)],
    ["running", buildView(running, DEFAULT_SETTINGS, options, 1000)],
    ["armed", buildView(running, DEFAULT_SETTINGS, { ...options, armed: true }, 1000)],
    ["help", buildView(createState(), DEFAULT_SETTINGS, { locale, help: true }, 0)],
  ] as const;
}

describe("footers follow QIS v1", () => {
  for (const locale of LOCALES) {
    it(`orders the gestures, keeps the glossary and fits the row (${locale})`, () => {
      const [tap, swipe, hold, double] = WORDS[locale];
      for (const [name, view] of everyView(locale)) {
        const row = view.footer;
        expect(row.length, `${name}: ${row}`).toBeLessThanOrEqual(ROW_WIDTH);
        expect(view.header, name).toMatch(/^CADENCE · \S/);
        expect(row, name).not.toMatch(BANNED[locale]);
        if (name === "armed") {
          expect(row).toBe(locale === "de" ? "Nochmal tippen = pausieren · Wischen/2× = abbrechen" : "Tap again = pause · Swipe/2× = cancel");
          continue;
        }
        const at = [tap, swipe, hold, double].map((word) => row.indexOf(word + " =")).filter((index) => index >= 0);
        expect(at, `${name}: ${row}`).toEqual([...at].sort((a, b) => a - b));
        // The 2x part is never dropped and always last.
        expect(row, name).toMatch(locale === "de" ? /2× = (zurück|Ende)$/ : /2× = (back|exit)$/);
      }
    });
  }

  it("states the right way out: Ende on the main screen, zurück on the help page", () => {
    expect(buildView(createState(), DEFAULT_SETTINGS, { locale: "de" }, 0).footer).toMatch(/2× = Ende$/);
    expect(buildView(createState(), DEFAULT_SETTINGS, { locale: "de", help: true }, 0).footer).toBe("2× = zurück");
    expect(buildView(createState(), DEFAULT_SETTINGS, { locale: "en", help: true }, 0).footer).toBe("2× = back");
  });

  it("drops the swipe part first when a row would be too wide, never the 2× part", () => {
    const wide = footer("de", { tap: "Pause", swipe: "Tempo", hold: "Takt eins zurück" }, "exit");
    expect(wide.length).toBeLessThanOrEqual(ROW_WIDTH);
    expect(wide).not.toContain("Wischen");
    expect(wide).toMatch(/2× = Ende$/);
    expect(armedFooter("en", "pause").length).toBeLessThanOrEqual(ROW_WIDTH);
  });

  it("uses the glossary in every glasses string", () => {
    for (const locale of LOCALES) {
      for (const [key, text] of Object.entries(messages[locale])) {
        if (key.startsWith("g.")) expect(text, key).not.toMatch(BANNED[locale]);
      }
    }
  });
});

// The real app against a fake bridge.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

describe("pause is armed first (integration)", () => {
  const CLICK = 0, UP = 1, DOWN = 2, DOUBLE = 3, HOLD = 9;
  const page: Record<number, string> = {};
  let handler: ((event: unknown) => void) | undefined;
  let exits = 0;
  const menus: string[][] = [];

  const boot = async (stored: Record<string, string> = {}): Promise<void> => {
    const storage = new Map<string, string>(Object.entries(stored));
    harness.bridge = {
      getLocalStorage: async (key: string) => storage.get(key) ?? "",
      setLocalStorage: async (key: string, value: string) => { storage.set(key, value); return true; },
      rebuildPageContainer: async () => true,
      createStartUpPageContainer: async (built: { textObject?: { containerID: number; content: string }[]; menuObject?: { menuItems?: { itemName?: string }[] } }) => {
        menus.push((built.menuObject?.menuItems ?? []).map((item) => item.itemName ?? ""));
        for (const item of built.textObject ?? []) page[item.containerID] = item.content;
        return 0;
      },
      textContainerUpgrade: async (update: { containerID: number; content: string }) => { page[update.containerID] = update.content; return true; },
      updateImageRawData: async () => "success",
      shutDownPageContainer: async () => { exits += 1; return false; },
      onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
      onDeviceStatusChanged: () => () => undefined,
    };
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(handler).toBeDefined());
    await vi.advanceTimersByTimeAsync(100);
  };
  const menuClick = async (itemID: number, wait = 50): Promise<void> => {
    handler?.({ menuItemClickEvent: { itemID } });
    await vi.advanceTimersByTimeAsync(wait);
  };
  const gesture = async (eventType: number, wait = 50): Promise<void> => {
    resetGestureDedupe();
    handler?.({ sysEvent: { eventType, eventSource: 1 } });
    await vi.advanceTimersByTimeAsync(wait);
  };

  beforeEach(() => {
    handler = undefined;
    exits = 0;
    for (const key of Object.keys(page)) delete page[Number(key)];
    resetGestureDedupe();
    vi.useFakeTimers();
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null });
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => undefined });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("a single tap on a running beat only arms; the second tap within 4 s pauses", async () => {
    await boot();
    await gesture(CLICK); // start
    expect(page[1]).toBe("CADENCE · running");
    await vi.advanceTimersByTimeAsync(3000);
    await gesture(CLICK);
    expect(page[1]).toBe("CADENCE · pause?");
    expect(page[3]).toBe("Tap again = pause · Swipe/2× = cancel");
    await gesture(CLICK, 300);
    expect(page[1]).toBe("CADENCE · paused");
  });

  it("the timeout, a swipe, a hold and a double tap cancel the pause; none of them changes anything", async () => {
    await boot();
    await gesture(CLICK);
    await gesture(CLICK);
    expect(page[1]).toBe("CADENCE · pause?");
    await vi.advanceTimersByTimeAsync(4100);
    expect(page[1]).toBe("CADENCE · running");
    for (const cancel of [UP, DOWN, HOLD, DOUBLE]) {
      await gesture(CLICK);
      expect(page[1]).toBe("CADENCE · pause?");
      await gesture(cancel, 700);
      expect(page[1], `after ${cancel}`).toBe("CADENCE · running");
      expect(page[2]).toContain("100 bpm");
    }
    expect(exits).toBe(0);
  });

  it("a double tap while running leaves through the system dialog but never pauses first", async () => {
    await boot();
    await gesture(CLICK);
    await gesture(DOUBLE, 600);
    expect(exits).toBe(1);
    expect(page[1]).toBe("CADENCE · running");
  });

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.); a hold on the stopped metronome opens the help, only the double tap leaves it", async () => {
    await boot();
    expect(menus[0]).toEqual([]);
    expect(page[3]).toBe("Tap = start · Swipe = tempo · Hold = help · 2× = exit");
    await gesture(HOLD, 700);
    expect(page[1]).toBe("CADENCE · help");
    expect(page[2]).toContain("Tap:");
    await gesture(CLICK, 300);
    await gesture(UP, 300);
    expect(page[1]).toBe("CADENCE · help");
    await gesture(DOUBLE, 600);
    expect(page[1]).toBe("CADENCE · ready");
    expect(exits).toBe(0);
  });

  it("the side menu opens the help while the beat runs: the beat goes on, a pending pause is cancelled, 2× returns", async () => {
    await boot();
    await gesture(CLICK);
    await gesture(CLICK);
    expect(page[1]).toBe("CADENCE · pause?");
    await menuClick(1);
    expect(page[1]).toBe("CADENCE · help");
    await gesture(DOUBLE, 600);
    expect(page[1]).toBe("CADENCE · running");
    expect(exits).toBe(0);
  });

  it("honours the invert-scroll setting (phone: Glasses tab)", async () => {
    const stored = { "quietglass.cadence.v1": JSON.stringify({ ...EMPTY_DATA, invertScroll: true }) };
    await boot(stored);
    await gesture(UP); // the raw "top" event reads as a swipe down when inverted
    expect(page[2]).toContain("96 bpm");
  });
});

describe("phone page", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("has the tabs in the fixed order, with the invert switch under Brille", () => {
    let html = "";
    const root = { set innerHTML(value: string) { html = value; }, get innerHTML() { return html; }, querySelector: () => null, querySelectorAll: () => [] };
    vi.stubGlobal("document", { getElementById: () => root });
    mountPhoneUi({ getData: () => EMPTY_DATA, setData: async () => undefined, getLocale: () => "de" });
    const tabs = [...html.matchAll(/data-tab-go="(\w+)"/g)].map((m) => m[1]);
    expect(tabs).toEqual(["main", "practice", "glasses", "more"]);
    expect(html.indexOf('data-tab="glasses"')).toBeLessThan(html.indexOf('id="invert"'));
    expect(html.indexOf('id="invert"')).toBeLessThan(html.indexOf('data-tab="more"'));
  });
});

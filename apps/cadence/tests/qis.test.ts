import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGestureDedupe } from "../src/input/gestures";
import { cockpitHint, cockpitModel, type RunWord } from "../src/cockpit/model";
import { armedFooter, footer, ROW_WIDTH } from "../src/glasses/footer";
import { messages } from "../src/messages";
import { DEFAULT_SETTINGS, createState, start } from "../src/metronome/engine";
import { EMPTY_DATA } from "../src/storage/persist";
import type { Locale } from "../src/i18n";

// QIS v1: footer order and wording, and the arm-then-confirm pause on the real app.

const LOCALES: readonly Locale[] = ["de", "en"];
const WORDS = {
  de: ["Tippen", "Wischen", "2×"],
  en: ["Tap", "Swipe", "2×"],
} as const;
// A hold never reaches the app from the temple pad (step log 21.10.2026): no glasses text may offer one.
const BANNED = { de: /\b(Tap|Wisch|Doppeltipp|Halten|halten)\b|2x/, en: /\b(Hold|hold)\b|2x/ } as const;
const WORDS_OF_STATE: readonly RunWord[] = ["ready", "paused", "running", "armed"];

describe("hint lines follow QIS v1", () => {
  for (const locale of LOCALES) {
    it(`orders the gestures, keeps the glossary and fits the row (${locale})`, () => {
      const [tap, swipe, double] = WORDS[locale];
      for (const word of WORDS_OF_STATE) {
        const row = cockpitHint(locale, word);
        expect(row.length, `${word}: ${row}`).toBeLessThanOrEqual(ROW_WIDTH);
        expect(row, word).not.toMatch(BANNED[locale]);
        if (word === "armed") {
          expect(row).toBe(locale === "de" ? "Nochmal tippen = pausieren · Wischen/2× = abbrechen" : "Tap again = pause · Swipe/2× = cancel");
          continue;
        }
        const at = [tap, swipe, double].map((w) => row.indexOf(w + " =")).filter((index) => index >= 0);
        expect(at, `${word}: ${row}`).toEqual([...at].sort((a, b) => a - b));
        expect(row, word).toMatch(locale === "de" ? /2× = Ende$/ : /2× = exit$/);
      }
    });
  }

  it("drops the swipe part first when a row would be too wide, never the 2× part", () => {
    const wide = footer("de", { tap: "Pause und von vorne ab Takt eins", swipe: "Tempo" }, "exit");
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

  it("no hint offers a hold (the temple pad never delivers one); running shows tap, swipe and 2×", () => {
    expect(cockpitHint("de", "ready")).toBe("Tippen = Start · Wischen = Tempo · 2× = Ende");
    expect(cockpitHint("de", "running")).toBe("Tippen = Pause · Wischen = Tempo · 2× = Ende");
    expect(cockpitHint("en", "running")).toBe("Tap = pause · Swipe = tempo · 2× = exit");
  });

  it("the headline carries the state word", () => {
    const running = start(createState(), 0);
    expect(cockpitModel({ state: running, settings: DEFAULT_SETTINGS, now: 1000, locale: "de", armed: true }).headline).toEqual(["100 BPM", "PAUSE?"]);
  });
});

// The real app against a fake bridge.
const harness = vi.hoisted(() => ({ bridge: null as unknown, models: [] as import("../src/cockpit/model").CockpitModel[] }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
vi.mock("../src/cockpit/compose", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/cockpit/compose")>();
  return { ...real, composeCockpit: (model: import("../src/cockpit/model").CockpitModel, backend: import("../src/screen/text").TextBackend) => { harness.models.push(model); return real.composeCockpit(model, backend); } };
});
const last = (): import("../src/cockpit/model").CockpitModel => harness.models[harness.models.length - 1]!;

describe("pause is armed first (integration)", () => {
  const CLICK = 0, UP = 1, DOWN = 2, DOUBLE = 3, HOLD = 9;
  let handler: ((event: unknown) => void) | undefined;
  let exits = 0;
  let menus = 0;

  const boot = async (stored: Record<string, string> = {}): Promise<void> => {
    const storage = new Map<string, string>(Object.entries(stored));
    harness.bridge = {
      getLocalStorage: async (key: string) => storage.get(key) ?? "",
      setLocalStorage: async (key: string, value: string) => { storage.set(key, value); return true; },
      rebuildPageContainer: async () => true,
      createStartUpPageContainer: async (built: { menuObject?: unknown }) => { if (built.menuObject) menus += 1; return 0; },
      textContainerUpgrade: async () => true,
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
  const gesture = async (eventType: number, wait = 50): Promise<void> => {
    resetGestureDedupe();
    handler?.({ sysEvent: { eventType, eventSource: 1 } });
    await vi.advanceTimersByTimeAsync(wait);
  };

  beforeEach(() => {
    handler = undefined;
    exits = 0;
    menus = 0;
    harness.models.length = 0;
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
    expect(last().headline[1]).toBe("RUNNING");
    await vi.advanceTimersByTimeAsync(3000);
    await gesture(CLICK);
    expect(last().headline[1]).toBe("PAUSE?");
    expect(last().hint).toBe("Tap again = pause · Swipe/2× = cancel");
    await gesture(CLICK, 300);
    expect(last().headline[1]).toBe("PAUSED");
  });

  it("the timeout, a swipe, a hold and a double tap cancel the pause; none of them changes anything", async () => {
    await boot();
    await gesture(CLICK);
    await gesture(CLICK);
    expect(last().headline[1]).toBe("PAUSE?");
    await vi.advanceTimersByTimeAsync(4100);
    expect(last().headline[1]).toBe("RUNNING");
    for (const cancel of [UP, DOWN, HOLD, DOUBLE]) {
      await gesture(CLICK);
      expect(last().headline[1]).toBe("PAUSE?");
      await gesture(cancel, 700);
      expect(last().headline[1], `after ${cancel}`).toBe("RUNNING");
      expect(last().headline[0]).toBe("100 BPM");
    }
    expect(exits).toBe(0);
  });

  it("a double tap while running leaves through the system dialog but never pauses first", async () => {
    await boot();
    await gesture(CLICK);
    await gesture(DOUBLE, 600);
    expect(exits).toBe(1);
    expect(last().headline[1]).toBe("RUNNING");
  });

  it("the page carries no side menu; a hold on the stopped metronome does nothing", async () => {
    await boot();
    expect(menus).toBe(0);
    expect(last().hint).toBe("Tap = start · Swipe = tempo · 2× = exit");
    const shown = harness.models.length;
    await gesture(HOLD, 700);
    expect(last().headline[1]).toBe("READY");
    expect(last().hint).toBe("Tap = start · Swipe = tempo · 2× = exit");
    expect(harness.models.length).toBeGreaterThanOrEqual(shown);
    expect(exits).toBe(0);
  });

  it("honours the invert-scroll setting (phone: Glasses tab)", async () => {
    const stored = { "quietglass.cadence.v1": JSON.stringify({ ...EMPTY_DATA, invertScroll: true }) };
    await boot(stored);
    await gesture(UP); // the raw "top" event reads as a swipe down when inverted
    expect(last().headline[0]).toBe("96 BPM");
  });
});

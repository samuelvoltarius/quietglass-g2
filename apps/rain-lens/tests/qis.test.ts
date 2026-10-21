import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageRawDataUpdateResult } from "@evenrealities/even_hub_sdk";
import { resetGestureDedupe } from "../src/input/gestures";
import { locales, tr, type Locale } from "../src/i18n";
import { messages } from "../src/messages";
import { createRadarSession } from "../src/radar/session";
import { syntheticRadar } from "../src/radar/load";
import { RADAR_ZOOM } from "../src/radar/tiles";
import { footer } from "../src/glasses/footer";

/**
 * QIS v1 (docs/BEDIENSTANDARD.md): header `RAINLENS · state`, footer in the order
 * Tippen/Wischen/2x (never Halten: a temple hold never reaches the app) ending in back/exit, every
 * row within the full width in every language, the help page as an R1-ring extra, the persisted scroll-direction switch, plus the glossary.
 * RainLens has no destructive gesture: tap reloads, swipe only changes the view.
 */

const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
vi.mock("../src/glasses/pixel", () => ({ encodePng: async () => new Uint8Array([1]) }));

const CLICK = 0, DOWN = 2, DOUBLE = 3, HOLD = 9, UP = 1;
const WIDTH = 56;

const forecast = {
  current: { time: "2026-10-07T10:15", temperature_2m: 14.5, apparent_temperature: 13.2, relative_humidity_2m: 72, precipitation: 0.2, weather_code: 61, cloud_cover: 80, wind_speed_10m: 18, wind_direction_10m: 225, wind_gusts_10m: 31, is_day: 1 },
  hourly: {
    time: Array.from({ length: 12 }, (_, i) => `2026-10-07T${String(10 + i).padStart(2, "0")}:00`),
    temperature_2m: [13, 14, 15, 16, 16, 15, 14, 13, 12, 12, 11, 11], precipitation_probability: [10, 20, 40, 70, 75, 50, 30, 20, 10, 5, 5, 5],
    precipitation: Array.from({ length: 12 }, () => 0), weather_code: [3, 3, 61, 61, 63, 61, 3, 3, 2, 1, 1, 0], wind_speed_10m: Array.from({ length: 12 }, () => 12),
  },
  daily: { time: ["2026-10-07"], temperature_2m_min: [8], temperature_2m_max: [18], precipitation_probability_max: [75], weather_code: [61], sunrise: ["2026-10-07T07:08"], sunset: ["2026-10-07T18:42"] },
};

const kv = new Map<string, string>();

function fakeBridge(options: { location?: boolean } = {}) {
  let handler: ((event: unknown) => void) | undefined;
  const images: string[] = [];
  const texts: { name: string; content: string }[] = [];
  const menus: string[][] = [];
  type Built = { textObject?: { containerName?: string; content?: string }[]; menuObject?: { menuItems?: { itemName?: string; itemID?: number }[] } };
  const menuOf = (page: Built): void => { menus.push((page.menuObject?.menuItems ?? []).map((item) => item.itemID + ":" + item.itemName)); };
  const bridge = {
    getAppLocation: async () => (options.location === false ? null : { latitude: 47.68, longitude: 13.1 }),
    getLocalStorage: async (key: string) => kv.get(key) ?? "",
    setLocalStorage: async (key: string, value: string) => { kv.set(key, value); return true; },
    rebuildPageContainer: async (page: Built) => { menuOf(page); return true; },
    createStartUpPageContainer: async (page: Built) => { menuOf(page); texts.push(...(page.textObject ?? []).map((part) => ({ name: part.containerName ?? "", content: part.content ?? "" }))); return 0; },
    textContainerUpgrade: async (update: { containerName?: string; content?: string }) => { texts.push({ name: update.containerName ?? "", content: update.content ?? "" }); return true; },
    updateImageRawData: async (update: { containerName?: string }) => { images.push(update.containerName ?? ""); return ImageRawDataUpdateResult.success; },
    shutDownPageContainer: (): Promise<boolean> => Promise.resolve(false),
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, images, texts, menus,
    menu: (itemID: number) => handler?.({ menuItemClickEvent: { itemID } }),
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
    ready: () => handler !== undefined,
    last: (name: string) => texts.filter((part) => part.name === name).at(-1)?.content ?? "",
  };
}

const order = (locale: Locale): string[] => (locale === "de" ? ["Tippen", "Wischen", "2×"] : locale === "en" ? ["Tap", "Swipe", "2×"] : []);
/** The hold in every language: no glasses text may offer it (hardware 21.10.2026: a temple hold opens the system menu). */
const HOLD_WORDS = /\b(Halten|Hold|Maintenir|Mantener|Tieni)\b/i;
const width = (text: string): number => Array.from(text).length;

describe("QIS v1 on the glasses", () => {
  beforeEach(() => {
    resetGestureDedupe();
    kv.clear();
    vi.useFakeTimers();
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
    vi.stubGlobal("navigator", { language: "en" });
    vi.stubGlobal("document", { querySelector: () => null, querySelectorAll: () => [] });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(forecast)));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  async function boot(locale: Locale, options: { location?: boolean } = {}) {
    kv.set("quietglass.locale", locale);
    const fake = fakeBridge(options);
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.advanceTimersByTimeAsync(5000);
    return fake;
  }

  for (const locale of locales) {
    it(`${locale}: every view has header, footer and rows in the budget, the app name first, 2× last`, async () => {
      const fake = await boot(locale);
      const seen: { name: string; header: string; footer: string }[] = [];
      const snap = (name: string): void => {
        const header = fake.last("header"), foot = fake.last("footer");
        seen.push({ name, header, footer: foot });
        expect(width(header), name + ": " + header).toBeLessThanOrEqual(WIDTH);
        expect(width(foot), name + ": " + foot).toBeLessThanOrEqual(WIDTH);
        expect(header.startsWith("RAINLENS · "), name + ": " + header).toBe(true);
        for (const row of fake.last("body").split("\n")) expect(width(row), name + ": " + row).toBeLessThanOrEqual(46);
      };
      snap("now");
      for (const name of ["hourly", "days"]) { fake.emit(DOWN); await vi.advanceTimersByTimeAsync(2000); snap(name); }
      fake.emit(HOLD); await vi.advanceTimersByTimeAsync(2000); snap("help");
      expect(fake.last("body"), "help body").not.toMatch(HOLD_WORDS);
      for (const { name, footer: foot } of seen) {
        const exit = tr(messages, locale, "helpTitle") && name === "help"
          ? { de: "2× = zurück", en: "2× = back", fr: "2× = retour", es: "2× = atrás", it: "2× = indietro" }[locale]
          : { de: "2× = Ende", en: "2× = exit", fr: "2× = fermer", es: "2× = cerrar", it: "2× = chiudi" }[locale];
        expect(foot.endsWith(exit), name + ": " + foot).toBe(true);
        expect(foot, name).not.toMatch(HOLD_WORDS);
        const positions = order(locale).map((word) => foot.indexOf(word)).filter((i) => i >= 0);
        expect(positions, name + ": " + foot).toEqual([...positions].sort((a, b) => a - b));
      }
    });
  }

  it("de: the notice views (no location, offline) say what is wrong in the header and keep the footer short", async () => {
    const fake = await boot("de", { location: false });
    expect(fake.last("header")).toBe("RAINLENS · kein Standort");
    expect(fake.last("footer")).toBe("Tippen = nochmal · Wischen = Ansicht · 2× = Ende");
    vi.stubGlobal("fetch", async () => { throw new TypeError("Failed to fetch"); });
    const offline = await boot("de");
    expect(offline.last("header")).toBe("RAINLENS · offline");
  });

  it("QUS v1: the header reads `RAINLENS · Ansicht · ● live` and the phone has exactly three tabs in a three-column row", async () => {
    const fake = await boot("de");
    expect(fake.last("header")).toBe("RAINLENS · JETZT · ● live");
    const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as unknown as { readFileSync(path: string, encoding: string): string };
    const css = fs.readFileSync("src/ui/phone.css", "utf8");
    expect(css).toMatch(/\.tabbar \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
    expect(css).not.toMatch(/repeat\(4,[^)]*\)[^;]*tabbar/);
  });

  it("the footer drops the swipe first, never the 2×, and never offers a hold", () => {
    expect(footer("de", { tap: "neu", swipe: "Ansicht" })).toBe("Tippen = neu · Wischen = Ansicht · 2× = Ende");
    expect(footer("en", { tap: "refresh", swipe: "view" })).toBe("Tap = refresh · Swipe = view · 2× = exit");
    expect(footer("en", { tap: "refresh", swipe: "view" }, "exit", "Radar: RainViewer")).toBe("Radar: RainViewer · Tap = refresh · 2× = exit");
    expect(footer("de", {}, "back")).toBe("2× = zurück");
  });

  it("R1-ring extra: a hold opens the help page: read-only, chart cleared, 2× goes back; the view underneath stays", async () => {
    const fake = await boot("de");
    fake.emit(DOWN); await vi.advanceTimersByTimeAsync(2000);
    expect(fake.last("header")).toContain("STUNDEN");
    fake.emit(HOLD); fake.emit(10); await vi.advanceTimersByTimeAsync(2000);
    expect(fake.last("header")).toBe("RAINLENS · Hilfe");
    expect(fake.last("body")).toBe("Tippen = Wetter neu laden\nWischen = nächste Ansicht\n2× = Ende (in der Hilfe: zurück)\nBraucht: Internet und Standort am Handy");
    expect(fake.last("footer")).toBe("2× = zurück");
    expect(fake.images.filter((name) => name === "rain-chart").length).toBeGreaterThanOrEqual(2);
    // Swipe and tap do nothing there, and the exit dialog is not asked.
    fake.emit(DOWN); fake.emit(CLICK); await vi.advanceTimersByTimeAsync(2000);
    expect(fake.last("header")).toBe("RAINLENS · Hilfe");
    fake.emit(DOUBLE); await vi.advanceTimersByTimeAsync(2000);
    expect(fake.last("header")).toContain("STUNDEN");
  });

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    const fake = await boot("de");
    expect(fake.menus.length).toBeGreaterThan(0);
    for (const items of fake.menus) expect(items).toEqual([]);
    // every view of the app, and the help page, are built without a menuObject
    fake.emit(DOWN); await vi.advanceTimersByTimeAsync(2000);
    fake.emit(HOLD); fake.emit(10); await vi.advanceTimersByTimeAsync(2000);
    expect(fake.last("header")).toBe("RAINLENS · Hilfe");
    fake.emit(DOUBLE); await vi.advanceTimersByTimeAsync(2000);
    for (const items of fake.menus) expect(items).toEqual([]);
  });

  it("the swipe direction is a phone setting; a tap reloads (the menu's Aktualisieren) and a swipe changes the view", async () => {
    const fake = await boot("de");
    let requests = 0;
    vi.stubGlobal("fetch", async () => { requests += 1; return new Response(JSON.stringify(forecast)); });
    fake.emit(CLICK); await vi.advanceTimersByTimeAsync(3000);
    expect(requests).toBeGreaterThan(0);
    fake.emit(DOWN); await vi.advanceTimersByTimeAsync(2000);
    expect(fake.last("header")).toContain("STUNDEN");
    expect(kv.get("rainlens.invertScroll")).toBeUndefined();
    // the menu handler is kept for the day the side menu works: a click still toggles the setting
    fake.menu(3); await vi.advanceTimersByTimeAsync(2000);
    expect(kv.get("rainlens.invertScroll")).toBe("1");
  });

  it("QIS v1.2: menu labels fit 32 bytes in every language", () => {
    for (const locale of locales) for (const key of ["mHelp", "mRefresh", "mSwipeNormal", "mSwipeInverted"]) {
      expect(new TextEncoder().encode(tr(messages, locale, key)).length, locale + "." + key).toBeLessThanOrEqual(32);
    }
  });

  it("QIS v1.2: a server error shows no status code on the glasses; the phone text keeps it", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 503 }));
    const fake = await boot("de");
    expect(fake.last("body")).toContain("Wetterdienst");
    expect(fake.last("body")).not.toMatch(/503|Code/);
    for (const locale of locales) {
      expect(tr(messages, locale, "errorServerGlasses")).not.toMatch(/\d|\{status\}/);
      expect(tr(messages, locale, "errorServer", { status: "503" })).toContain("503");
    }
  });

  it("the scroll direction follows the persisted switch", async () => {
    const fake = await boot("de");
    expect(fake.last("header")).toContain("JETZT");
    fake.emit(UP); await vi.advanceTimersByTimeAsync(2000);
    // Normal: a swipe up (event 1) goes back one view, to the last one (the cockpit has no text).
    fake.emit(DOWN); await vi.advanceTimersByTimeAsync(2000);
    expect(fake.last("header")).toContain("JETZT");
    kv.set("rainlens.invertScroll", "1");
    const inverted = await boot("de");
    expect(inverted.last("header")).toContain("JETZT");
    inverted.emit(UP); await vi.advanceTimersByTimeAsync(2000);
    expect(inverted.last("header")).toContain("STUNDEN");
  });

  it("offers the switch in the settings tab; exactly three tabs", async () => {
    const app = { innerHTML: "", querySelectorAll: () => [] };
    vi.stubGlobal("document", { querySelector: (selector: string) => (selector === "#app" ? app : null), querySelectorAll: () => [] });
    await boot("de");
    const tabs = [...app.innerHTML.matchAll(/data-tab-go="(\w+)"/g)].map((m) => m[1]);
    expect(tabs).toEqual(["now", "forecast", "settings"]);
    expect(app.innerHTML).toContain('id="invert"');
    expect(app.innerHTML).toContain("Wischrichtung umkehren");
  });

  it("radar footers keep the credit and the 2×, in every language", () => {
    for (const locale of locales) {
      const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
      const data = syntheticRadar({ latitude: 47.8, longitude: 13.05 }, Date.now(), RADAR_ZOOM, locale);
      for (const load of [async () => data, async () => { throw new Error("down"); }]) {
        const session = createRadarSession({ position: () => ({ latitude: 47.8, longitude: 13.05 }), t, locale: () => locale, redraw: () => undefined, load, now: () => Date.now() });
        session.start();
        for (const text of [session.text()]) {
          expect(text.footer).toContain("Radar: RainViewer");
          expect(width(text.footer), locale + ": " + text.footer).toBeLessThanOrEqual(WIDTH);
          expect(text.footer).toMatch(/2× = \S+$/);
          expect(width(text.header), text.header).toBeLessThanOrEqual(WIDTH);
          expect(text.header.startsWith("RAINLENS · RADAR")).toBe(true);
        }
        session.stop();
      }
    }
  });

  it("uses the glossary: German has no Tap, Wisch, 2x or Doppeltipp; English has no 2x or Double tap", () => {
    const text = (locale: Locale): string => Object.entries(messages[locale])
      .filter(([key]) => /^(help\d?|help2x|f[A-Z]|radar|glass|st[A-Z])/.test(key)).map(([, value]) => value).join("\n");
    expect(text("de")).not.toMatch(/\bTap\b|\bWisch\b|\b2x\b|Doppeltipp/);
    expect(text("en")).not.toMatch(/\b2x\b|Double tap|Doppeltipp/);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, languageSelect, locales, tr } from "../src/i18n";
import { messages } from "../src/messages";
import { buildView, composeView } from "../src/glasses/view";
import { BODY_COLS, BODY_ROWS, LINE_COLS } from "../src/glasses/fit";
import { COMMON_SIGNATURES, createState, DEFAULT_SETTINGS, MAX_BPM, start, type MetronomeSettings } from "../src/metronome/engine";
import { formatDuration } from "../src/practice/log";
import { mountPhoneUi } from "../src/ui/phone";
import { EMPTY_DATA } from "../src/storage/persist";

const vars = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();

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
    expect(german).not.toMatch(/\b(fuer|ueber|uebst|koennen|zurueck)\b/i);
    for (const locale of locales) {
      for (const [key, text] of Object.entries(messages[locale])) {
        if (key.startsWith("g.")) expect(text, key).not.toMatch(/[▸◆]/);
      }
    }
  });

  it("formats durations in the chosen language", () => {
    expect(formatDuration(4512, "de")).toBe("1 h 15 min");
    expect(formatDuration(270, "de")).toBe("4 min 30 s");
    expect(formatDuration(270)).toBe("4m 30s");
  });
});

describe("language choice", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("follows the device language and falls back to English", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("navigator", { language: "de-AT" });
    expect(getLocale()).toBe("de");
    vi.stubGlobal("navigator", { language: "it-IT" });
    expect(getLocale()).toBe("en");
  });

  it("prefers the language picked on the phone, and survives blocked storage", () => {
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("localStorage", { getItem: () => "de", setItem: () => undefined });
    expect(getLocale()).toBe("de");
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => undefined });
    expect(getLocale()).toBe("en");
  });

  it("offers German and English on the phone", () => {
    const html = languageSelect("de");
    expect(html).toContain("Sprache");
    expect(html).toContain('<option value="de" selected>');
    expect(html.match(/<option/g)).toHaveLength(2);
  });
});

describe("glasses text budget", () => {
  for (const locale of ["de", "en"] as const) {
    it(`fits every ${locale} screen into 7 rows before any safety cut`, () => {
      const views = [];
      for (const signature of COMMON_SIGNATURES) {
        const settings: MetronomeSettings = { ...DEFAULT_SETTINGS, bpm: MAX_BPM, signature };
        views.push(composeView(createState(), settings, { locale }, 0));
        views.push(composeView(start(createState(), 0), settings, { locale, sessionSeconds: 35_999 }, 3_600_000 * 9));
        views.push(composeView(start(createState(), 0), settings, { locale }, 0));
      }
      for (const view of views) {
        expect(view.header.length).toBeLessThanOrEqual(LINE_COLS);
        expect(view.footer.length, view.footer).toBeLessThanOrEqual(LINE_COLS);
        expect(view.body.length).toBeLessThanOrEqual(BODY_ROWS);
        for (const line of view.body) expect(line.length, line).toBeLessThanOrEqual(BODY_COLS);
      }
    });
  }
});

describe("first run", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("tells the user on the glasses exactly what to do", () => {
    const view = buildView(createState(), DEFAULT_SETTINGS, { locale: "de" }, 0);
    expect(view.header).toBe("Cadence");
    expect(view.body).toContain("Tippe einmal, um den Takt zu starten.");
    expect(view.body[1]).toBe("100 Schläge/Min  4/4  Takt 1");
    expect(view.footer).toBe("Pause · Tippen = Start · Wischen = Tempo");
  });

  it("drops the first-run sentence once the beat runs", () => {
    const view = buildView(start(createState(), 0), DEFAULT_SETTINGS, { locale: "de" }, 0);
    expect(view.body).toHaveLength(2);
    expect(view.footer).toContain("Tippen = Pause");
  });

  it("leads the phone page with the next step, in German", () => {
    let html = "";
    const root = { set innerHTML(value: string) { html = value; }, get innerHTML() { return html; }, querySelector: () => null, querySelectorAll: () => [] };
    vi.stubGlobal("document", { getElementById: () => root });
    mountPhoneUi({ getData: () => EMPTY_DATA, setData: async () => undefined, getLocale: () => "de" });
    expect(html).toContain("Tippe auf der Brille einmal auf den Bügel");
    expect(html).toContain('<option value="de" selected>');
    expect(html.indexOf("card next")).toBeLessThan(html.indexOf("Taktart"));
  });
});

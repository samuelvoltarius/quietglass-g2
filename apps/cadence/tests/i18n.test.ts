import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, languageSelect, locales, tr } from "../src/i18n";
import { messages } from "../src/messages";
import { cockpitModel } from "../src/cockpit/model";
import { ROW_WIDTH } from "../src/glasses/footer";
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

describe("glasses cockpit text", () => {
  for (const locale of ["de", "en"] as const) {
    it(`keeps every ${locale} cockpit line short (headline, cells, hint) before any cut`, () => {
      for (const signature of COMMON_SIGNATURES) {
        const settings: MetronomeSettings = { ...DEFAULT_SETTINGS, bpm: MAX_BPM, signature };
        for (const state of [createState(), start(createState(), 0)]) {
          const model = cockpitModel({
            state, settings, now: 3_600_000 * 9, locale, item: "Bach Partita No. 2 in D minor, Chaconne", sessionSeconds: 35_999,
            todaySeconds: 35_999, todayCount: 12, best: 240, armed: state.running,
          });
          expect(model.hint.length, model.hint).toBeLessThanOrEqual(ROW_WIDTH);
          expect(model.headline).toHaveLength(2);
          for (const line of model.headline) expect(line.length, line).toBeLessThanOrEqual(12);
          expect(model.cells).toHaveLength(6);
          for (const cell of model.cells) {
            expect(cell.label.length, cell.label).toBeLessThanOrEqual(10);
            expect(cell.value.length, cell.value).toBeLessThanOrEqual(10);
          }
          expect(model.caption.length).toBeLessThanOrEqual(24);
        }
      }
    });
  }
});

describe("first run", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the glasses say READY and the one thing to do, in German", () => {
    const model = cockpitModel({ state: createState(), settings: DEFAULT_SETTINGS, now: 0, locale: "de" });
    expect(model.headline).toEqual(["100 BPM", "BEREIT"]);
    expect(model.hint).toBe("Tippen = Start · Wischen = Tempo · 2× = Ende");
    expect(model.caption).toBe("Keine Übung");
  });

  it("opens the phone on Einstellungen with the three-step checklist, in German", () => {
    let html = "";
    const root = { set innerHTML(value: string) { html = value; }, get innerHTML() { return html; }, querySelector: () => null, querySelectorAll: () => [] };
    vi.stubGlobal("document", { getElementById: () => root });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    mountPhoneUi({ getData: () => EMPTY_DATA, setData: async () => undefined, getLocale: () => "de" });
    expect(html).toContain("Erste Schritte");
    expect(html.match(/class="num"/g)).toHaveLength(3);
    expect(html).toContain('<option value="de" selected>');
    expect(html.indexOf("Erste Schritte")).toBeLessThan(html.indexOf('id="bpm"'));
  });
});

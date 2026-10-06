import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, languageSelect, locales, tr } from "../src/i18n";
import { messages } from "../src/messages";
import { buildView, composeView } from "../src/glasses/view";
import { BODY_COLS, BODY_ROWS, LINE_COLS } from "../src/glasses/fit";
import { createDose, DEFAULT_DOSE, formatDuration } from "../src/noise/dose";
import { effectiveOffset, EMPTY_DATA, ESTIMATED_OFFSET } from "../src/storage/persist";
import { mountPhoneUi } from "../src/ui/phone";

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
    expect(german).not.toMatch(/\b(fuer|ueber|Gehoer|laeuft|zurueck)\b/i);
    for (const locale of locales) {
      for (const [key, text] of Object.entries(messages[locale])) {
        if (key.startsWith("g.")) expect(text, key).not.toMatch(/[▸◆]/);
      }
    }
  });

  it("formats durations in the chosen language", () => {
    expect(formatDuration(7800, "de")).toBe("2 h 10 min");
    expect(formatDuration(45, "de")).toBe("45 s");
    expect(formatDuration(7800)).toBe("2h 10m");
  });
});

describe("language choice", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("follows the device language and falls back to English", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("navigator", { language: "de-AT" });
    expect(getLocale()).toBe("de");
    vi.stubGlobal("navigator", { language: "es-ES" });
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
  const dose = (fraction: number) => ({ ...createDose(), fraction });

  for (const locale of ["de", "en"] as const) {
    it(`fits every ${locale} screen into 7 rows before any safety cut`, () => {
      const views = [];
      for (const calibrated of [true, false]) {
        views.push(composeView(dose(0), DEFAULT_DOSE, { listening: false, level: null, calibrated, locale }));
        views.push(composeView(dose(0.4), DEFAULT_DOSE, { listening: false, level: null, calibrated, locale }));
        views.push(composeView(dose(9.99), DEFAULT_DOSE, { listening: false, level: null, calibrated, locale }));
        views.push(composeView(dose(0), DEFAULT_DOSE, { listening: false, level: null, calibrated, locale, micError: true }));
        views.push(composeView(dose(0), DEFAULT_DOSE, { listening: true, level: null, calibrated, locale }));
        views.push(composeView(dose(0.01), DEFAULT_DOSE, { listening: true, level: 71, calibrated, locale }));
        views.push(composeView(dose(0.6), DEFAULT_DOSE, { listening: true, level: 85, calibrated, locale }));
        views.push(composeView(dose(50), DEFAULT_DOSE, { listening: true, level: 130, calibrated, locale }));
      }
      for (const view of views) {
        expect(view.header.length).toBeLessThanOrEqual(LINE_COLS);
        expect(view.footer.length, view.footer).toBeLessThanOrEqual(LINE_COLS);
        expect(view.body.length).toBeLessThanOrEqual(BODY_ROWS);
        for (const line of view.body) expect(line.length, line).toBeLessThanOrEqual(BODY_COLS);
      }
    });
  }

  it("keeps the microphone indicator in German too", () => {
    const view = composeView(createDose(), DEFAULT_DOSE, { listening: true, level: 60, calibrated: false, locale: "de" });
    expect(view.footer.startsWith("● MIKRO AN")).toBe(true);
  });
});

describe("first run", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("tells the user on the glasses exactly what to do", () => {
    const view = buildView(createDose(), DEFAULT_DOSE, { listening: false, level: null, calibrated: false, locale: "de" });
    expect(view.body).toEqual(["Misst gerade nicht.", "Tippe einmal, um zu messen.", "Werte sind Schätzwerte, siehe Handy."]);
    expect(view.footer).toBe("Tippen = Start");
  });

  it("measures something useful without any calibration", () => {
    expect(effectiveOffset(EMPTY_DATA)).toBe(ESTIMATED_OFFSET);
    expect(effectiveOffset({ ...EMPTY_DATA, calibrationOffset: 104 })).toBe(104);
    const view = buildView(createDose(), DEFAULT_DOSE, { listening: true, level: 72.4, calibrated: false, locale: "de" });
    expect(view.body[0]).toBe("etwa 72 dB");
  });

  it("says what to do when the microphone is refused", () => {
    const view = buildView(createDose(), DEFAULT_DOSE, { listening: false, level: null, calibrated: false, locale: "de", micError: true });
    expect(view.body.join(" ")).toContain("Mikrofon nicht verfügbar");
    expect(view.footer).toBe("Tippen = nochmal versuchen");
    expect(view.footer).not.toContain("MIKRO AN");
  });

  it("leads the phone page with the next step, in German", () => {
    let html = "";
    const root = { set innerHTML(value: string) { html = value; }, get innerHTML() { return html; }, querySelector: () => null, querySelectorAll: () => [] };
    vi.stubGlobal("document", { getElementById: () => root });
    vi.stubGlobal("setInterval", () => 0);
    mountPhoneUi({ getData: () => EMPTY_DATA, setData: async () => undefined, getLevel: () => ({ dbfs: null, listening: false }), getLocale: () => "de" });
    expect(html).toContain("Tippe einmal auf den Bügel der Brille");
    expect(html).toContain('<option value="de" selected>');
    expect(html.indexOf("card next")).toBeLessThan(html.indexOf("Worum es geht"));
  });
});

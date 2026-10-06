import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, languageSelect, locales, tr } from "../src/i18n";
import { messages } from "../src/messages";
import { buildView, composeView } from "../src/glasses/view";
import { BODY_COLS, BODY_ROWS, LINE_COLS } from "../src/glasses/fit";
import { addSample, calibrate, createMonitor, DEFAULT_SETTINGS, type PostureSettings } from "../src/posture/monitor";
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
    expect(german).not.toMatch(/\b(fuer|ueber|koennen|moechte|zurueck)\b/i);
    for (const locale of locales) {
      for (const [key, text] of Object.entries(messages[locale])) {
        if (key.startsWith("g.")) expect(text, key).not.toMatch(/[▸◆]/);
      }
    }
  });
});

describe("language choice", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("follows the device language and falls back to English", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("navigator", { language: "de-AT" });
    expect(getLocale()).toBe("de");
    vi.stubGlobal("navigator", { language: "fr-FR" });
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
  const UPRIGHT = { x: 0, y: 0, z: 1 };
  const TILTED = { x: 0, y: 1, z: 1 };
  const fast: PostureSettings = { ...DEFAULT_SETTINGS, smoothing: 1, sustainSeconds: 3599, snoozeSeconds: 60 };

  function everyView(locale: "de" | "en") {
    const calibrated = calibrate(createMonitor(), UPRIGHT, 0);
    const leaning = addSample(calibrated, TILTED, fast, 1000);
    const warned = addSample(addSample(calibrated, TILTED, { ...fast, sustainSeconds: 10 }, 1000), TILTED, { ...fast, sustainSeconds: 10 }, 3_600_000);
    const tracked = addSample(calibrated, UPRIGHT, fast, 10_000);
    return [
      composeView(createMonitor(), fast, { locale }),
      composeView(createMonitor(), fast, { locale, sensorOff: true }),
      composeView(calibrated, fast, { locale, justCalibrated: true }, 0),
      composeView(tracked, fast, { locale, showAngleWhenGood: true }, 10_000),
      composeView(calibrated, fast, { locale }, 0),
      composeView(leaning, fast, { locale }, 1000),
      composeView(warned, { ...fast, sustainSeconds: 10 }, { locale }, 3_600_000 + 3_599_000),
    ];
  }

  for (const locale of ["de", "en"] as const) {
    it(`fits every ${locale} screen into 7 rows before any safety cut`, () => {
      for (const view of everyView(locale)) {
        expect(view.header.length).toBeLessThanOrEqual(LINE_COLS);
        expect(view.footer.length).toBeLessThanOrEqual(LINE_COLS);
        expect(view.body.length).toBeLessThanOrEqual(BODY_ROWS);
        for (const line of view.body) expect(line.length, line).toBeLessThanOrEqual(BODY_COLS);
      }
    });
  }
});

describe("first run", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("tells the user on the glasses exactly what to do", () => {
    const view = buildView(createMonitor(), DEFAULT_SETTINGS, { locale: "de" });
    expect(view.body.join(" ")).toBe("Setz dich gerade hin und tippe einmal zum Speichern.");
    expect(view.footer).toBe("Tippen = Haltung speichern");
  });

  it("confirms a calibration so the quiet display is not mistaken for a fault", () => {
    const view = buildView(calibrate(createMonitor(), { x: 0, y: 0, z: 1 }, 0), DEFAULT_SETTINGS, { locale: "de", justCalibrated: true }, 0);
    expect(view.body[0]).toContain("Gespeichert");
  });

  it("says what to do when the motion sensor is unavailable", () => {
    const view = buildView(createMonitor(), DEFAULT_SETTINGS, { locale: "de", sensorOff: true });
    expect(view.body.join(" ")).toContain("öffne die App neu");
    expect(view.footer).toContain("Doppeltippen");
  });

  it("leads the phone page with the next step, in German", () => {
    let html = "";
    const root = { set innerHTML(value: string) { html = value; }, get innerHTML() { return html; }, querySelector: () => null, querySelectorAll: () => [] };
    vi.stubGlobal("document", { getElementById: () => root });
    mountPhoneUi({ getData: () => EMPTY_DATA, setData: async () => undefined, getLocale: () => "de" });
    expect(html).toContain("tippe einmal auf den Bügel");
    expect(html).toContain('<option value="de" selected>');
    expect(html.indexOf("card next")).toBeLessThan(html.indexOf("Wann erinnern"));
  });
});

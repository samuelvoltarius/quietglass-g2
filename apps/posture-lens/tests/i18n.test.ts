import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, languageSelect, locales, tr } from "../src/i18n";
import { messages } from "../src/messages";
import { cockpitModel, type CockpitInput } from "../src/cockpit/model";
import { LINE_COLS } from "../src/glasses/fit";
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

describe("glasses cockpit text", () => {
  const UPRIGHT = { x: 0, y: 0, z: 1 };
  const TILTED = { x: 0, y: 1, z: 1 };
  const fast: PostureSettings = { ...DEFAULT_SETTINGS, smoothing: 1, sustainSeconds: 3599, snoozeSeconds: 60 };

  function everyModel(locale: "de" | "en") {
    const calibrated = calibrate(createMonitor(), UPRIGHT, 0);
    const leaning = addSample(calibrated, TILTED, fast, 1000);
    const warned = addSample(addSample(calibrated, TILTED, { ...fast, sustainSeconds: 10 }, 1000), TILTED, { ...fast, sustainSeconds: 10 }, 3_600_000);
    const tracked = addSample(calibrated, UPRIGHT, fast, 10_000);
    const base = { settings: fast, locale, now: 0 } as const;
    const inputs: CockpitInput[] = [
      { ...base, monitor: createMonitor() },
      { ...base, monitor: createMonitor(), sensorOff: true },
      { ...base, monitor: calibrated, justCalibrated: true },
      { ...base, monitor: tracked, showAngleWhenGood: true, now: 10_000 },
      { ...base, monitor: calibrated },
      { ...base, monitor: calibrated, confirm: "calibrate" },
      { ...base, monitor: leaning, now: 1000 },
      { ...base, monitor: warned, settings: { ...fast, sustainSeconds: 10 }, now: 3_600_000 + 3_599_000 },
    ];
    return inputs.map((input) => cockpitModel(input));
  }

  for (const locale of ["de", "en"] as const) {
    it(`keeps every ${locale} cockpit line short (headline, cells, hint, caption) before any cut`, () => {
      for (const model of everyModel(locale)) {
        expect(model.hint.length, model.hint).toBeLessThanOrEqual(LINE_COLS);
        expect(model.headline.length).toBeLessThanOrEqual(2);
        for (const line of model.headline) expect(line.length, line).toBeLessThanOrEqual(14);
        expect(model.cells).toHaveLength(6);
        for (const cell of model.cells) {
          expect(cell.label.length, cell.label).toBeLessThanOrEqual(11);
          expect(cell.value.length, cell.value).toBeLessThanOrEqual(10);
        }
        expect(model.caption.length).toBeLessThanOrEqual(24);
      }
    });
  }
});

describe("first run", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("tells the user on the glasses exactly what to do", () => {
    const model = cockpitModel({ monitor: createMonitor(), settings: DEFAULT_SETTINGS, locale: "de", now: 0 });
    expect(model.headline).toEqual(["HALTUNG", "SPEICHERN"]);
    expect(model.hint).toBe("Tippen = Haltung speichern · Halten = Menü · 2× = Ende");
    expect(model.caption).toBe("Nicht gespeichert");
  });

  it("confirms a calibration so the quiet display is not mistaken for a fault", () => {
    const model = cockpitModel({ monitor: calibrate(createMonitor(), { x: 0, y: 0, z: 1 }, 0), settings: DEFAULT_SETTINGS, locale: "de", now: 0, justCalibrated: true });
    expect(model.headline).toEqual(["GESPEICHERT"]);
  });

  it("says what to do when the motion sensor is unavailable", () => {
    const model = cockpitModel({ monitor: createMonitor(), settings: DEFAULT_SETTINGS, locale: "de", now: 0, sensorOff: true });
    expect(model.headline).toEqual(["KEIN", "SENSOR"]);
    expect(model.hint).toBe("2× = Ende");
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
    expect(html.indexOf("Erste Schritte")).toBeLessThan(html.indexOf("Wann erinnern"));
  });
});

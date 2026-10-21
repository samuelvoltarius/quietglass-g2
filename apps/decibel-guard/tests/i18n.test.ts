import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, languageSelect, locales, tr } from "../src/i18n";
import { messages } from "../src/messages";
import { cockpitModel, type CockpitInput } from "../src/cockpit/model";
import { FOOTER_WIDTH } from "../src/glasses/footer";
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

const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const input = (patch: Partial<CockpitInput> = {}): CockpitInput => ({
  dose: createDose(), settings: DEFAULT_DOSE, listening: false, level: null, calibrated: true, locale: "de", now: NOW, ...patch,
});

describe("glasses cockpit text", () => {
  const dose = (fraction: number) => ({ ...createDose(), fraction, measuredSeconds: 35_999, overSeconds: 20_000, peakDb: 130, levelSeconds: 35_999 * 90 });

  for (const locale of ["de", "en"] as const) {
    it(`keeps every ${locale} cockpit line short (headline, cells, hint) before any cut`, () => {
      const models = [];
      for (const calibrated of [true, false]) {
        for (const listening of [false, true]) {
          for (const fraction of [0, 0.4, 0.6, 9.99]) {
            for (const armed of [null, "reset", "stop"] as const) {
              models.push(cockpitModel(input({ dose: dose(fraction), listening, level: 130, barLevel: 129, peak: 132, calibrated, locale, armed })));
            }
          }
        }
        models.push(cockpitModel(input({ calibrated, locale, micError: true })));
      }
      for (const model of models) {
        expect(model.hint.length, model.hint).toBeLessThanOrEqual(FOOTER_WIDTH);
        expect(model.headline.length).toBeLessThanOrEqual(2);
        for (const line of model.headline) expect(line.length, line).toBeLessThanOrEqual(14);
        expect(model.cells).toHaveLength(6);
        for (const cell of model.cells) {
          expect(cell.label.length, cell.label).toBeLessThanOrEqual(10);
          expect(cell.value.length, cell.value).toBeLessThanOrEqual(10);
        }
      }
    });
  }

  it("keeps the microphone indicator in German too", () => {
    const model = cockpitModel(input({ listening: true, level: 60, calibrated: false }));
    expect(model.hint.startsWith("● MIKRO AN")).toBe(true);
    expect(model.caption).toBe("● MIKRO AN");
  });
});

describe("first run", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the glasses say what is going on and what to tap, in German", () => {
    const model = cockpitModel(input({ calibrated: false }));
    expect(model.headline).toEqual(["BEREIT", "NICHT AKTIV"]);
    expect(model.hint).toBe("Tippen = messen · Wischen = Dosis löschen · 2× = Ende");
    expect(model.caption).toBe("Schätzwert");
  });

  it("measures something useful without any calibration", () => {
    expect(effectiveOffset(EMPTY_DATA)).toBe(ESTIMATED_OFFSET);
    expect(effectiveOffset({ ...EMPTY_DATA, calibrationOffset: 104 })).toBe(104);
    const model = cockpitModel(input({ listening: true, level: 72.4, calibrated: false }));
    expect(model.headline[0]).toBe("~72 DB");
    expect(model.bars[0]!.text).toBe("~72 dB");
  });

  it("says what to do when the microphone is refused", () => {
    const model = cockpitModel(input({ calibrated: false, micError: true }));
    expect(model.headline).toEqual(["MIKROFON", "NICHT BEREIT"]);
    expect(model.hint).toBe("Tippen = nochmal versuchen · 2× = Ende");
    expect(model.hint).not.toContain("MIKRO AN");
  });

  it("opens the phone on Einstellungen with the three-step checklist, in German", () => {
    let html = "";
    const root = { set innerHTML(value: string) { html = value; }, get innerHTML() { return html; }, querySelector: () => null, querySelectorAll: () => [] };
    vi.stubGlobal("document", { getElementById: () => root });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("setInterval", () => 0);
    mountPhoneUi({ getData: () => EMPTY_DATA, setData: async () => undefined, getLocale: () => "de" });
    expect(html).toContain("Erste Schritte");
    expect(html.match(/class="num"/g)).toHaveLength(3);
    expect(html).toContain('<option value="de" selected>');
  });
});

describe("QIS v1 layout", () => {
  for (const locale of ["de", "en"] as const) {
    it(`${locale}: the hint keeps the gesture order and ends in back/exit/cancel, within the row`, () => {
      const order = locale === "de" ? ["Tippen", "Wischen", "2×"] : ["Tap", "Swipe", "2×"];
      for (const listening of [false, true]) {
        for (const armed of [null, "reset", "stop"] as const) {
          const model = cockpitModel(input({ listening, level: 80, locale, armed }));
          expect(model.title).toBe("DECIBELGUARD");
          expect(model.hint.length, model.hint).toBeLessThanOrEqual(FOOTER_WIDTH);
          const back = locale === "de" ? /2× = (zurück|Ende|abbrechen)$/ : /2× = (back|exit|cancel)$/;
          expect(model.hint, model.hint).toMatch(back);
          // A hold never reaches the app from the temple pad (step log 21.10.2026): no line may offer one.
          expect(model.hint, model.hint).not.toMatch(/Halten|halten|\bHold\b|\bhold\b/);
          // The reset must stay reachable: the swipe is never dropped for width.
          if (armed === null) expect(model.hint, model.hint).toContain(locale === "de" ? "Wischen = " : "Swipe = ");
          const positions = order.map((word) => model.hint.indexOf(word)).filter((i) => i >= 0);
          expect(positions, model.hint).toEqual([...positions].sort((a, b) => a - b));
        }
      }
    });
  }

  it("uses the glossary: German has no Tap, Wisch or 2x on the glasses", () => {
    const german = Object.entries(messages.de).filter(([key]) => key.startsWith("g.")).map(([, text]) => text).join(" ");
    expect(german).not.toMatch(/\bTap\b|\bWisch\b|2x|Doppeltipp/);
  });

  it("keeps the microphone indicator on the confirm questions while measuring", () => {
    for (const locale of ["de", "en"] as const) {
      for (const armed of ["reset", "stop"] as const) {
        expect(cockpitModel(input({ listening: true, level: 80, locale, armed })).hint).toMatch(/^● MI/);
      }
    }
  });
});

describe("QIS v1.2", () => {
  it("builds every hint with the helper: the stop question names the action and keeps the indicator", () => {
    const model = cockpitModel(input({ listening: true, level: 80, armed: "stop" }));
    expect(model.headline).toEqual(["MESSUNG", "STOPPEN?"]);
    expect(model.hint).toBe("● MIKRO AN · Nochmal tippen = stoppen · 2× = abbrechen");
    const en = cockpitModel(input({ listening: true, level: 80, locale: "en" }));
    expect(en.hint).toBe("● MIC · Tap = stop · Swipe = reset · 2× = exit");
    const de = cockpitModel(input({ listening: true, level: 80 }));
    expect(de.hint).toBe("● MIKRO AN · Tippen = aus · Wischen = Reset · 2× = Ende");
  });

  it("never points at a side menu (its clicks do not arrive on the glasses)", () => {
    expect(Object.values(messages.de).join(" ")).not.toMatch(/Seitenmenü|Menü der Brille/);
    expect(Object.values(messages.en).join(" ")).not.toMatch(/side menu|glasses menu/i);
  });

  it("uses 2× and not Doppeltippen / Double tap on the phone", () => {
    expect(messages.de["p.double"]).toBe("2×");
    expect(messages.en["p.double"]).toBe("2×");
    expect(Object.values(messages.de).join(" ")).not.toMatch(/Doppeltipp/);
  });
});

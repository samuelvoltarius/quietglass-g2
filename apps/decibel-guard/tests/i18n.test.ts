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
        for (const listening of [false, true]) {
          views.push(buildView(dose(9.99), DEFAULT_DOSE, { listening, level: 80, calibrated, locale, armed: "reset" }));
          views.push(buildView(dose(9.99), DEFAULT_DOSE, { listening, level: 80, calibrated, locale, armed: "stop" }));
          for (const helpPage of [0, 1]) views.push(buildView(dose(0), DEFAULT_DOSE, { listening, level: 80, calibrated, locale, helpPage }));
        }
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
    expect(view.body).toEqual(["Misst gerade nicht.", "Wischen = Hilfe", "Werte sind Schätzwerte, siehe Handy."]);
    expect(view.footer).toBe("Tippen = messen · Halten = Dosis löschen · 2× = Ende");
  });

  it("measures something useful without any calibration", () => {
    expect(effectiveOffset(EMPTY_DATA)).toBe(ESTIMATED_OFFSET);
    expect(effectiveOffset({ ...EMPTY_DATA, calibrationOffset: 104 })).toBe(104);
    const view = buildView(createDose(), DEFAULT_DOSE, { listening: true, level: 72.4, calibrated: false, locale: "de" });
    expect(view.body).toEqual([]);
  });

  it("says what to do when the microphone is refused", () => {
    const view = buildView(createDose(), DEFAULT_DOSE, { listening: false, level: null, calibrated: false, locale: "de", micError: true });
    expect(view.body.join(" ")).toContain("Mikrofon nicht verfügbar");
    expect(view.footer).toBe("Tippen = nochmal versuchen · 2× = Ende");
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

describe("QIS v1 layout", () => {
  const dose = (fraction: number) => ({ ...createDose(), fraction });

  for (const locale of ["de", "en"] as const) {
    it(`${locale}: header is DECIBELGUARD · state, footer keeps the gesture order and ends in back/exit, within the row`, () => {
      const order = locale === "de" ? ["Tippen", "Wischen", "Halten", "2×"] : ["Tap", "Swipe", "Hold", "2×"];
      const views = [];
      for (const listening of [false, true]) {
        for (const fraction of [0, 0.6, 1.2, 9.99]) {
          const base = { listening, level: 80, calibrated: true, locale } as const;
          views.push(buildView(dose(fraction), DEFAULT_DOSE, base));
          views.push(buildView(dose(fraction), DEFAULT_DOSE, { ...base, armed: "reset" }));
          views.push(buildView(dose(fraction), DEFAULT_DOSE, { ...base, armed: "stop" }));
          views.push(buildView(dose(fraction), DEFAULT_DOSE, { ...base, helpPage: 0 }));
          views.push(buildView(dose(fraction), DEFAULT_DOSE, { ...base, helpPage: 1 }));
        }
      }
      views.push(buildView(dose(0), DEFAULT_DOSE, { listening: false, level: null, calibrated: true, locale, micError: true }));
      for (const view of views) {
        expect(view.header.startsWith("DECIBELGUARD · "), view.header).toBe(true);
        expect(view.header.length, view.header).toBeLessThanOrEqual(LINE_COLS);
        expect(view.footer.length, view.footer).toBeLessThanOrEqual(LINE_COLS);
        const back = locale === "de" ? /2× = (zurück|Ende|abbrechen)$/ : /2× = (back|exit|cancel)$/;
        expect(view.footer, view.footer).toMatch(back);
        const positions = order.map((word) => view.footer.indexOf(word)).filter((i) => i >= 0);
        expect(positions, view.footer).toEqual([...positions].sort((a, b) => a - b));
      }
    });
  }

  it("uses the glossary: German has no Tap, Wisch or 2x on the glasses", () => {
    const german = Object.entries(messages.de).filter(([key]) => key.startsWith("g.")).map(([, text]) => text).join(" ");
    expect(german).not.toMatch(/Tap|Wisch|2x|Doppeltipp/);
  });

  it("keeps the microphone indicator on the confirm questions and on the help while measuring", () => {
    for (const locale of ["de", "en"] as const) {
      const base = { listening: true, level: 80, calibrated: true, locale } as const;
      expect(buildView(createDose(), DEFAULT_DOSE, { ...base, armed: "reset" }).footer).toMatch(/^● MI/);
      expect(buildView(createDose(), DEFAULT_DOSE, { ...base, armed: "stop" }).footer).toMatch(/^● MI/);
      expect(buildView(createDose(), DEFAULT_DOSE, { ...base, helpPage: 0 }).footer).toMatch(/^● MI/);
    }
  });
});

describe("QIS v1.2", () => {
  it("builds every footer with the helper: the stop question names the action and keeps the indicator", () => {
    const view = buildView(createDose(), DEFAULT_DOSE, { listening: true, level: 80, calibrated: true, locale: "de", armed: "stop" });
    expect(view.header).toBe("DECIBELGUARD · Messung stoppen?");
    expect(view.footer).toBe("● MIKRO AN · Nochmal tippen = stoppen · 2× = abbrechen");
    const en = buildView(createDose(), DEFAULT_DOSE, { listening: true, level: 80, calibrated: true, locale: "en" });
    expect(en.footer).toBe("● MIC · Tap = stop · Hold = reset · 2× = exit");
  });

  it("points at the swipe for the help, not at the side menu (its clicks do not arrive on the glasses)", () => {
    for (const locale of ["de", "en"] as const) {
      const view = buildView(createDose(), DEFAULT_DOSE, { listening: false, level: null, calibrated: true, locale });
      expect(view.body.join(" ")).toMatch(/Wischen = Hilfe|Swipe = help/);
      expect(view.body.join(" ")).not.toMatch(/Menü|menu/i);
    }
    expect(Object.values(messages.de).join(" ")).not.toMatch(/Seitenmenü|Menü der Brille/);
    expect(Object.values(messages.en).join(" ")).not.toMatch(/side menu|glasses menu/i);
  });

  it("uses 2× and not Doppeltippen / Double tap on the phone", () => {
    expect(messages.de["p.double"]).toBe("2×");
    expect(messages.en["p.double"]).toBe("2×");
    expect(Object.values(messages.de).join(" ")).not.toMatch(/Doppeltipp/);
  });
});

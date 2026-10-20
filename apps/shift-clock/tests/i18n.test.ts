import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, languageSelect, locales, setLocale, tr, type Messages } from "../src/i18n";
import { defaultProject, messages, t } from "../src/messages";
import { FOOTER_WIDTH, HEADER_WIDTH, LINE_WIDTH, startRows, startView, VISIBLE_ROWS } from "../src/glasses/view";
import { cockpitModel } from "../src/cockpit/model";
import { STOPPED, toCsv, type TimeEntry } from "../src/tracking/clock";
import { firstRunData, parseData } from "../src/storage/persist";

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();
/** Worst-case values for every placeholder that reaches the glasses. */
const WORST: Record<string, string | number> = { total: "99:59:59", name: "Arbeit", project: "", target: "12,75", left: "16:00:00" };
const widthOf = (key: string): number => (key.startsWith("g.f.") ? FOOTER_WIDTH : LINE_WIDTH);

describe("message catalogue", () => {
  it("has every key in German and English, none empty", () => {
    expect(Object.keys(messages.de).sort()).toEqual(Object.keys(messages.en).sort());
    for (const locale of locales) {
      for (const [key, value] of Object.entries(messages[locale])) expect(value.trim(), `${locale}:${key}`).not.toBe("");
    }
  });

  it("uses the same placeholders in both languages", () => {
    for (const key of Object.keys(messages.en)) {
      expect(placeholders(messages.de[key] ?? ""), key).toEqual(placeholders(messages.en[key] ?? ""));
    }
  });

  it("keeps every glasses string within its row: 56 characters", () => {
    expect(HEADER_WIDTH).toBe(56);
    for (const locale of locales) {
      for (const key of Object.keys(messages[locale]).filter((k) => k.startsWith("g."))) {
        expect(t(locale, key, WORST).length, `${locale}:${key}`).toBeLessThanOrEqual(widthOf(key));
      }
    }
  });

  it("uses glyphs the G2 can draw and real umlauts in German", () => {
    const all = locales.flatMap((l) => Object.values(messages[l])).join("\n");
    expect(all).not.toContain("▸");
    const german = Object.values(messages.de).join(" ");
    expect(german).toMatch(/[äöüß]/);
    expect(german).not.toMatch(/\b(fuer|ueber|waehlen|loeschen|Eintraegen)\b/i);
  });
});

describe("i18n helpers", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const sample: Messages = { de: { hi: "Hallo {name}, {name}!" }, en: { hi: "Hi {name}", only: "English only" } };

  it("substitutes every occurrence and falls back to English, then the key", () => {
    expect(tr(sample, "de", "hi", { name: "Ada" })).toBe("Hallo Ada, Ada!");
    expect(tr(sample, "de", "only")).toBe("English only");
    expect(tr(sample, "de", "missing")).toBe("missing");
  });

  it("follows the device language, prefers the picked one, and survives broken storage", () => {
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("navigator", { language: "de-AT" });
    expect(getLocale()).toBe("de");
    vi.stubGlobal("navigator", { language: "es-ES" });
    expect(getLocale()).toBe("en");
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    setLocale("de");
    expect(getLocale()).toBe("de");
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(() => setLocale("en")).not.toThrow();
  });

  it("marks the active language in the selector", () => {
    expect(languageSelect("de")).toContain('<option value="de" selected>');
  });
});

const day = 4 * 86_400_000;
const EMPTY_CLOCK = { project: null, startedAt: null } as const;

describe("glasses copy fits the display", () => {
  const long = "Kundenprojekt Müller & Söhne, Auftrag 2026-0815, Dachsanierung";
  for (const locale of locales) {
    it(`${locale}: the start page shows at most three rows, header and footer one line each`, () => {
      const projectSets = [[], [defaultProject(locale)], [long], Array.from({ length: 10 }, (_, i) => long + i)];
      for (const projects of projectSets) {
        const rows = startRows(projects, [], locale);
        for (const cursor of [0, 1, 5, 9, 99]) {
          for (const demo of [false, true]) {
            for (const canGoBack of [false, true]) {
              const view = startView(rows, cursor, { locale, demo, canGoBack });
              expect(view.body.length).toBeLessThanOrEqual(VISIBLE_ROWS);
              for (const row of view.body) expect(row.length, row).toBeLessThanOrEqual(LINE_WIDTH);
              expect(view.header.length, view.header).toBeLessThanOrEqual(HEADER_WIDTH);
              expect(view.footer.length, view.footer).toBeLessThanOrEqual(FOOTER_WIDTH);
              expect(view.footer).not.toBe("");
            }
          }
        }
      }
    });

    it(`${locale}: every cockpit hint fits one footer row`, () => {
      const running = { project: "Arbeit", startedAt: day };
      for (const clock of [EMPTY_CLOCK, running]) {
        for (const armed of [false, true]) {
          for (const projectCount of [1, 3]) {
            const model = cockpitModel({ clock, entries: [{ id: "e1", project: "Arbeit", startedAt: day, endedAt: day + 600_000 }], now: day + 7_200_000, locale, targetHours: 8, armed, demo: false, projectCount });
            expect(model.hint.length, model.hint).toBeLessThanOrEqual(FOOTER_WIDTH);
          }
        }
      }
    });
  }

  it("speaks German on the glasses", () => {
    const view = startView(startRows([], [], "de"), 0, { locale: "de", demo: false, canGoBack: false });
    expect(view.body).toEqual(["● Projekt „Arbeit“ anlegen"]);
    expect(view.header).toBe("Schicht · ● live");
    expect(view.footer).toBe("Tippen = anlegen · 2× = Ende");
    const many = startView(startRows(["A", "B"], [], "de"), 0, { locale: "de", demo: false, canGoBack: true });
    expect(many.footer).toBe("Tippen = starten · Wischen = wählen · 2× = zurück");
  });
});

describe("first run", () => {
  it("has one project ready in the device language", () => {
    expect(firstRunData("de").projects).toEqual(["Arbeit"]);
    expect(firstRunData("en").projects).toEqual(["Work"]);
    expect(firstRunData("de").open).toEqual(STOPPED);
  });

  it("does not add the default project back once the user has removed it", () => {
    expect(parseData(JSON.stringify({ projects: [], entries: [] })).projects).toEqual([]);
  });
});

describe("CSV", () => {
  const entry: TimeEntry = { id: "e1", project: "Küche", startedAt: new Date(2026, 2, 10, 8).getTime(), endedAt: new Date(2026, 2, 10, 9, 30).getTime() };

  it("translates only the header; values keep the decimal point and ISO times", () => {
    const [header, row] = toCsv([entry], "de").trim().split("\n");
    expect(header).toBe("Datum,Projekt,Beginn,Ende,Sekunden,Stunden");
    expect(row).toMatch(/^2026-03-10,Küche,\d{4}-\d{2}-\d{2}T[\d:.]+Z,\d{4}-\d{2}-\d{2}T[\d:.]+Z,5400,1\.50$/);
    expect(toCsv([entry]).split("\n")[0]).toBe("date,project,start,end,seconds,hours");
  });
});

describe("QIS v1 wording", () => {
  it("uses the glossary: German has no Tap or Wisch, never 2x", () => {
    const german = Object.entries(messages.de).filter(([k]) => k.startsWith("g.")).map(([, v]) => v).join(" ");
    expect(german).not.toMatch(/Tap|Wisch|2x|Doppeltipp/);
  });

  it("the phone says 2× and never Doppeltippen / Double tap", () => {
    expect(messages.de["p.key.double"]).toBe("2×");
    expect(messages.en["p.key.double"]).toBe("2×");
    expect(Object.values(messages.de).join(" ")).not.toMatch(/Doppeltipp/);
    expect(Object.values(messages.en).join(" ")).not.toMatch(/Double tap/);
  });
});

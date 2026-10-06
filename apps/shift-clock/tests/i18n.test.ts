import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, languageSelect, locales, setLocale, tr, type Messages } from "../src/i18n";
import { defaultProject, messages, t } from "../src/messages";
import { BODY_WIDTH, buildView, CANCEL, FOOTER_WIDTH, HEADER_WIDTH, MAX_BODY_ROWS } from "../src/glasses/view";
import { startProject, STOPPED, toCsv, type TimeEntry } from "../src/tracking/clock";
import { firstRunData, parseData } from "../src/storage/persist";

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();
/** Worst-case values for every placeholder that reaches the glasses. */
const WORST: Record<string, string | number> = { total: "99:59:59", name: "Arbeit", project: "" };
const widthOf = (key: string): number => (key.startsWith("g.h.") || key.startsWith("g.f.") ? FOOTER_WIDTH : BODY_WIDTH);

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

  it("keeps every glasses string within its row: 46 in header/footer, 38 beside the icon", () => {
    expect(HEADER_WIDTH).toBe(46);
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

const ids = (): (() => string) => { let n = 0; return () => "e" + ++n; };

describe("glasses copy fits the display", () => {
  const long = "Kundenprojekt Müller & Söhne, Auftrag 2026-0815, Dachsanierung";
  for (const locale of locales) {
    it(`${locale}: every screen stays within 7 rows, the body within 38 characters`, () => {
      const projectSets = [[], [defaultProject(locale)], [long], Array.from({ length: 10 }, (_, i) => long + i)];
      const day = 4 * 86_400_000;
      for (const projects of projectSets) {
        const states = [STOPPED, startProject(STOPPED, projects[0] ?? long, day, ids()).state];
        const pickers = [null, projects[0] ?? null, CANCEL, projects[7] ?? null];
        for (const state of states) {
          for (const selecting of pickers) {
            const view = buildView(state, [], { projects, selecting, locale }, day + 359_999_000);
            expect(view.body.length).toBeLessThanOrEqual(MAX_BODY_ROWS);
            for (const row of view.body) expect(row.length, row).toBeLessThanOrEqual(BODY_WIDTH);
            expect(view.header.length, view.header).toBeLessThanOrEqual(HEADER_WIDTH);
            expect(view.footer.length, view.footer).toBeLessThanOrEqual(FOOTER_WIDTH);
            expect(view.footer).not.toBe("");
          }
        }
      }
    });
  }

  it("speaks German on the glasses", () => {
    const none = buildView(STOPPED, [], { projects: [], locale: "de" }, 0);
    expect(none.body).toEqual(["Noch kein Projekt.", "Tippen legt „Arbeit“ an –", "oder leg am Handy eines an."]);
    expect(none.footer).toBe("tippen = anlegen · doppeltippen = beenden");
    const one = buildView(STOPPED, [], { projects: ["Arbeit"], locale: "de" }, 0);
    expect(one.body).toEqual(["Keine Zeit läuft.", "Projekt: Arbeit"]);
    expect(one.footer).toBe("heute 0:00 · tippen = starten");
    const many = buildView(STOPPED, [], { projects: ["A", "B"], locale: "de" }, 0);
    expect(many.footer).toBe("heute 0:00 · tippen = Projekt wählen");
    const picker = buildView(STOPPED, [], { projects: ["A", "B"], selecting: CANCEL, locale: "de" }, 0);
    expect(picker.header).toBe("Welches Projekt starten?");
    expect(picker.body).toEqual(["  A", "  B", "> Abbrechen"]);
    const running = buildView(startProject(STOPPED, "Arbeit", 0, ids()).state, [], { projects: ["Arbeit"], locale: "de" }, 65_000);
    expect(running.footer).toContain("tippen = stopp");
  });

  it("a running clock is shown even after its project was removed", () => {
    const running = buildView(startProject(STOPPED, "Gone", 0, ids()).state, [], { projects: [] }, 65_000);
    expect(running.header).toBe("Gone");
    expect(running.footer).toContain("tap = stop");
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

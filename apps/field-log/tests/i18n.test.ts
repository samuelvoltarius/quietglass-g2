import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, languageSelect, locales, setLocale, tr, type Messages } from "../src/i18n";
import { autoTitle, messages, quickNotes, t } from "../src/messages";
import { buildView, FOOTER_WIDTH, HEADER_WIDTH, MAX_BODY_ROWS, type Phase, type ViewOptions } from "../src/glasses/view";
import { addEntry, attachToLatest, setSection, startInspection, toCsv, toMarkdown, type Inspection } from "../src/log/entries";
import { maskSecret, parseData, validateWsUrl } from "../src/storage/persist";
import { safeName } from "../src/ui/phone";

const GLASSES_WIDTH = 46;
const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();
/** Worst-case values for every placeholder that reaches the glasses. */
const WORST: Record<string, string | number> = { major: 999, minor: 999, note: 999, time: "99h 59m", severity: "WICHTIG" };

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

  it("keeps every glasses string within one display row, in both languages", () => {
    for (const locale of locales) {
      for (const key of Object.keys(messages[locale]).filter((k) => k.startsWith("g."))) {
        expect(t(locale, key, WORST).length, `${locale}:${key}`).toBeLessThanOrEqual(GLASSES_WIDTH);
      }
    }
  });

  it("uses glyphs the G2 can draw and real umlauts in German", () => {
    const all = locales.flatMap((l) => Object.values(messages[l])).join("\n");
    expect(all).not.toContain("▸");
    const german = Object.values(messages.de).join(" ");
    expect(german).toMatch(/[äöüß]/);
    expect(german).not.toMatch(/\b(fuer|ueber|zurueck|moechtest|loeschen|Eintraege)\b/i);
  });

  it("mentions the speech server only as optional and advanced", () => {
    expect(messages.de["p.advanced"]).toMatch(/^Erweitert:.*\(optional\)$/);
    expect(messages.en["p.advanced"]).toMatch(/^Advanced:.*\(optional\)$/);
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
    vi.stubGlobal("navigator", { language: "it-IT" });
    expect(getLocale()).toBe("en");
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    setLocale("de");
    expect(getLocale()).toBe("de");
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(() => setLocale("en")).not.toThrow();
  });

  it("marks the active language in the selector", () => {
    expect(languageSelect("en")).toContain('<option value="en" selected>');
  });
});

const inspectionWith = (entries: number): Inspection => {
  let inspection = setSection(startInspection("i1", "Wohnungsübergabe Top 3, Stiege 2, Hinterhaus links", 0), "Badezimmer im Obergeschoss mit Dachschräge und Fenster");
  for (let i = 0; i < entries; i++) inspection = addEntry(inspection, "Fliese neben dem Fenster gesprungen und lose, bitte tauschen", i % 2 ? "major" : "minor", i);
  return entries > 0 ? attachToLatest(inspection, { dataUri: "data:image/jpeg;base64,AA", mimeType: "image/jpeg", size: 2048 }) : inspection;
};

describe("glasses copy fits the display", () => {
  const phases: Phase[] = ["idle", "pick", "recording", "transcribing", "review"];
  for (const locale of locales) {
    it(`${locale}: every phase stays within 7 rows × 46 characters, with long content`, () => {
      const long = "Riss im Putz über der Tür, ungefähr dreißig Zentimeter lang und bis zur Decke ".repeat(3);
      for (const entries of [0, 5]) {
        for (const phase of phases) {
          for (const voice of [false, true]) {
            for (const status of ["idle", "error", "connecting"] as const) {
              for (const pickIndex of [0, 3, 7]) {
                const options: ViewOptions = {
                  phase, severity: "major", pending: long, status, mock: true, locale, voice,
                  quickNotes: quickNotes(locale, []), pickIndex,
                };
                const view = buildView(inspectionWith(entries), options, 360_000_000);
                expect(view.body.length, phase).toBeLessThanOrEqual(MAX_BODY_ROWS);
                for (const row of view.body) expect(row.length, row).toBeLessThanOrEqual(GLASSES_WIDTH);
                expect(view.header.length).toBeLessThanOrEqual(HEADER_WIDTH);
                expect(view.footer.length, view.footer).toBeLessThanOrEqual(FOOTER_WIDTH);
                expect(view.footer, `${phase} footer`).not.toBe("");
              }
            }
          }
        }
      }
    });

    it(`${locale}: with nothing open, the glasses say a tap starts an inspection`, () => {
      const view = buildView(null, { phase: "idle", severity: "note", pending: null, status: "idle", mock: false, locale });
      expect(view.body).toEqual([t(locale, "g.none.1"), t(locale, "g.none.2")]);
      expect(view.footer).toBe(t(locale, "g.none.footer"));
    });

    it(`${locale}: every default quick note fits a row with its marker`, () => {
      for (const note of quickNotes(locale, [])) expect(("> " + note).length).toBeLessThanOrEqual(GLASSES_WIDTH);
    });
  }

  it("shows German labels in plain words", () => {
    const base = { severity: "major" as const, pending: "Fliese gesprungen", status: "idle" as const, mock: false, locale: "de" as const };
    const empty = buildView(startInspection("i", "Rundgang", 0), { ...base, phase: "idle" }, 60_000);
    expect(empty.body).toContain("Noch keine Einträge.");
    expect(empty.body).toContain("Nächster Eintrag: WICHTIG · wischen = ändern");
    expect(empty.footer).toBe("1m · tippen = Notiz · halten = Foto");
    const review = buildView(startInspection("i", "R", 0), { ...base, phase: "review" });
    expect(review.header).toBe("Behalten?");
    expect(review.footer).toBe("tippen = ja · wischen = nein · halten = Foto");
    const pick = buildView(startInspection("i", "R", 0), { ...base, phase: "pick", quickNotes: ["Passt", "Fehlt"], pickIndex: 2 });
    expect(pick.header).toBe("Schnellnotiz");
    expect(pick.body).toEqual(["  Passt", "  Fehlt", "> Abbrechen", "Speichern als: WICHTIG"]);
  });
});

describe("quick notes", () => {
  it("offer the defaults in the app language until the user writes their own", () => {
    expect(quickNotes("de", [])[0]).toBe("Passt");
    expect(quickNotes("en", [])[0]).toBe("OK");
    expect(quickNotes("de", ["  Riss ", "", "Fleck"])).toEqual(["Riss", "Fleck"]);
  });

  it("are kept in storage and cleaned on load", () => {
    expect(parseData(JSON.stringify({ quickNotes: ["Riss", 3, " ", "Fleck"] })).quickNotes).toEqual(["Riss", "Fleck"]);
    expect(parseData(JSON.stringify({})).quickNotes).toEqual([]);
  });

  it("an inspection started without a name gets the date and time", () => {
    const now = new Date(2026, 9, 6, 14, 5).getTime();
    expect(autoTitle("de", now)).toMatch(/^Rundgang 6\.10\..*14:05$/);
    expect(autoTitle("en", now)).toMatch(/^Inspection 06\/10.*14:05$/);
  });
});

describe("German exports", () => {
  const report = (): Inspection => {
    let inspection = setSection(startInspection("i1", "Übergabe Top 3", 1_000_000), "Küche");
    inspection = addEntry(inspection, "Wasserhahn tropft", "minor", 1_000_100);
    inspection = attachToLatest(inspection, { dataUri: "data:image/jpeg;base64,AA", mimeType: "image/jpeg", size: 2048 });
    return addEntry(inspection, "Schimmel hinter der Spüle", "major", 1_000_200);
  };

  it("writes the Markdown report in German", () => {
    const md = toMarkdown(report(), false, "de");
    expect(md).toContain("# Übergabe Top 3");
    expect(md).toContain("Begonnen: ");
    expect(md).toContain("Wichtig: 1 · Mängel: 1 · Notizen: 0");
    expect(md).toContain("## Küche");
    expect(md).toContain("*Mangel* — Wasserhahn tropft");
    expect(md).toContain("**WICHTIG** — Schimmel");
    expect(md).toContain("(Foto angehängt, 2 kB)");
    expect(toMarkdown(report(), true, "de")).toContain("![Foto](data:image/jpeg");
  });

  it("keeps the CSV machine-readable: comma, ISO time, German header and values", () => {
    const lines = toCsv(report(), "de").trim().split("\n");
    expect(lines[0]).toBe("Zeit,Abschnitt,Art,Text,Foto");
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z,Küche,Mangel,Wasserhahn tropft,ja$/);
    expect(lines[2]).toContain(",Wichtig,");
    expect(lines[2]?.endsWith(",nein")).toBe(true);
  });

  it("keeps the English export unchanged", () => {
    expect(toCsv(report()).split("\n")[0]).toBe("time,section,severity,text,photo");
    expect(toMarkdown(report())).toContain("**MAJOR**");
  });

  it("explains a bad server address in German", () => {
    expect(validateWsUrl("http://x", "de").errors[0]).toContain("ws://");
    expect(validateWsUrl("::::", "de").errors[0]).toBe("Die Server-Adresse ist ungültig.");
    expect(maskSecret("abc", "de")).toBe("gesetzt (3 Zeichen)");
    expect(maskSecret(undefined, "de")).toBe("keins");
  });

  it("keeps German titles readable in file names", () => {
    expect(safeName("Übergabe Top 3")).toBe("uebergabe-top-3");
    expect(safeName("***")).toBe("inspection");
  });
});

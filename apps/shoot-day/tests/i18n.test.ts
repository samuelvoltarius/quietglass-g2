import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, languageSelect, locales, setLocale, tr, type Messages } from "../src/i18n";
import { messages, t, takeNotes } from "../src/messages";
import { ROW_WIDTH } from "../src/glasses/screen";

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();

/** Worst-case values for every placeholder that reaches the glasses, before fitting. */
const WORST: Record<string, string | number> = {
  n: 999, total: 999, scene: "12A", shot: "B2", ok: 99, ng: 99, status: "NG", time: "23:59", note: "", count: 999,
  state: "läuft", speed: "3.0", date: "Mo 15.09.", call: "07:30", done: 999, min: 999, reason: "keine Antwort",
  project: "", what: "", place: "", contact: "", name: "", text: "",
};

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

  it("keeps every fixed glasses string within one display row, in both languages", () => {
    // Free-text placeholders (project, note, name …) are cut by the view; the
    // fixed wording around them must leave room and fit on its own.
    for (const locale of locales) {
      for (const key of Object.keys(messages[locale]).filter((k) => k.startsWith("g."))) {
        expect(t(locale, key, WORST).length, `${locale}:${key}`).toBeLessThanOrEqual(ROW_WIDTH);
      }
    }
  });

  it("every glasses error reason exists in both languages", () => {
    for (const code of ["timeout", "unreachable", "auth", "http", "bad-reply"]) {
      for (const locale of locales) expect(messages[locale]["g.err." + code], `${locale}:${code}`).toBeTruthy();
    }
  });

  it("uses glyphs the G2 can draw and real umlauts in German", () => {
    const glasses = locales.flatMap((l) => Object.entries(messages[l]).filter(([k]) => k.startsWith("g.")).map(([, v]) => v)).join("\n");
    expect(glasses).not.toContain("▸");
    expect(glasses).not.toMatch(/[„“”]/);
    const german = Object.values(messages.de).join(" ");
    expect(german).toMatch(/[äöüß]/);
    expect(german).not.toMatch(/\b(fuer|ueber|zurueck|naechst\w*|waehlen|Menue|moechtest|loeschen|gross)\b/i);
  });

  it("offers the same number of take notes in both languages, ending in 'none'", () => {
    expect(takeNotes("de")).toHaveLength(takeNotes("en").length);
    expect(takeNotes("de").at(-1)).toBe("(keine)");
    expect(takeNotes("en").at(-1)).toBe("(none)");
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
    expect(languageSelect("de")).toContain('<option value="de" selected>');
  });
});

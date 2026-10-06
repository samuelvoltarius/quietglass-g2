import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, languageSelect, locales, setLocale, tr, type Messages } from "../src/i18n";
import { messages, t } from "../src/messages";
import { ROW_WIDTH } from "../src/glasses/screen";

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();

/** Worst-case values for placeholders that reach the glasses; free text is cut by the view. */
const WORST: Record<string, string | number> = {
  state: "abgebrochen", age: "99 min", layer: 99999, layers: 99999, left: "99 h 59 min", nozzle: "300/300", bed: "120/120",
  speed: 999, message: "", seconds: 999, reason: "Token falsch oder fehlt", status: 503, progress: 100, file: "",
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

  it("keeps every glasses string within one display row, in both languages", () => {
    for (const locale of locales) {
      for (const key of Object.keys(messages[locale]).filter((k) => k.startsWith("g."))) {
        expect(t(locale, key, WORST).length, `${locale}:${key}`).toBeLessThanOrEqual(ROW_WIDTH);
      }
    }
  });

  it("has a word for every printer state, offline reason and error", () => {
    for (const locale of locales) {
      for (const state of ["printing", "paused", "complete", "standby", "cancelled", "error", "unknown"]) expect(messages[locale]["g.state." + state]).toBeTruthy();
      for (const reason of ["searching", "no-printer", "printer-silent", "unknown"]) expect(messages[locale]["g.offline." + reason]).toBeTruthy();
      for (const code of ["timeout", "unreachable", "auth", "http", "bad-reply", "refused"]) expect(messages[locale]["g.err." + code]).toBeTruthy();
      for (const command of ["pause", "resume", "cancel"]) {
        expect(messages[locale]["g.control." + command]).toBeTruthy();
        expect(messages[locale]["g.control.confirm." + command]).toBeTruthy();
        expect(messages[locale]["g.sent." + command]).toBeTruthy();
      }
    }
  });

  it("uses glyphs the G2 can draw and real umlauts in German", () => {
    const glasses = locales.flatMap((l) => Object.entries(messages[l]).filter(([k]) => k.startsWith("g.")).map(([, v]) => v)).join("\n");
    expect(glasses).not.toContain("▸");
    expect(glasses).not.toContain("█");
    const german = Object.values(messages.de).join(" ");
    expect(german).toMatch(/[äöüß]/);
    expect(german).not.toMatch(/\b(Duese|naechste|zurueck|waehlen|bestaetigen|fuer)\b/i);
  });
});

describe("i18n helpers", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("substitutes and falls back to English, then the key", () => {
    const sample: Messages = { de: { hi: "Hallo {name}" }, en: { hi: "Hi {name}", only: "English only" } };
    expect(tr(sample, "de", "hi", { name: "Ada" })).toBe("Hallo Ada");
    expect(tr(sample, "de", "only")).toBe("English only");
    expect(tr(sample, "de", "missing")).toBe("missing");
  });

  it("follows the device language and survives broken storage", () => {
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("navigator", { language: "de-CH" });
    expect(getLocale()).toBe("de");
    vi.stubGlobal("navigator", { language: "fr-FR" });
    expect(getLocale()).toBe("en");
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(() => setLocale("de")).not.toThrow();
    expect(languageSelect("en")).toContain('<option value="en" selected>');
  });
});

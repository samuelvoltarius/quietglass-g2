import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, languageSelect, locales, setLocale } from "../src/i18n";
import { messages, t } from "../src/messages";
import { ROW_WIDTH } from "../src/glasses/screen";

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();

/** Worst-case values for every placeholder that reaches the glasses. */
const WORST: Record<string, string | number> = { n: 5, total: 5, status: 503, reason: "Spracherkennung zu langsam", state: "gesetzt (64 Zeichen)" };

afterEach(() => { vi.unstubAllGlobals(); });

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

  it("keeps every fixed glasses string within one display row", () => {
    for (const locale of locales) {
      for (const key of Object.keys(messages[locale]).filter((k) => k.startsWith("g."))) {
        expect(t(locale, key, WORST).length, `${locale}:${key}`).toBeLessThanOrEqual(ROW_WIDTH);
      }
    }
  });

  it("covers every error code the client can produce, in both languages", () => {
    for (const code of ["timeout", "unreachable", "auth", "http", "bad-reply", "aborted", "s400", "s403", "s404", "s409", "s410", "s413", "s503", "s504"]) {
      for (const locale of locales) expect(messages[locale]["g.err." + code], `${locale}:${code}`).toBeTruthy();
    }
  });

  it("uses glyphs the G2 can draw and real umlauts in German", () => {
    const glasses = locales.flatMap((l) => Object.entries(messages[l]).filter(([k]) => k.startsWith("g.")).map(([, v]) => v)).join("\n");
    expect(glasses).not.toContain("▸");
    expect(glasses).not.toMatch(/[„“”]/);
    expect(Object.values(messages.de).join(" ")).toMatch(/[äöüß]/);
    expect(Object.values(messages.de).join(" ")).not.toMatch(/\b(ae|oe|ue)\w*\b.*Xaventra/);
  });

  it("names the phone fields exactly as the README does", () => {
    expect(messages.de["p.url"]).toBe("Adresse des Xaventra-Endpunkts");
    expect(messages.en["p.url"]).toBe("Xaventra endpoint address");
    expect(messages.de["p.token"]).toBe("Token (NOVA_EVEN_G2_TOKEN)");
    expect(messages.en["p.save"]).toBe("Save and connect");
  });

  it("never mentions the forbidden command", () => {
    for (const locale of locales) {
      for (const text of Object.values(messages[locale])) {
        expect(text.replace(/niemals tailscale serve reset|never tailscale serve reset/g, "")).not.toContain("serve reset");
      }
    }
  });
});

describe("language choice", () => {
  it("follows the device language, falls back to English, and remembers a choice", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    vi.stubGlobal("navigator", { language: "de-AT" });
    expect(getLocale()).toBe("de");
    vi.stubGlobal("navigator", { language: "fr-FR" });
    expect(getLocale()).toBe("en");
    setLocale("de");
    expect(getLocale()).toBe("de");
    expect(languageSelect("de")).toContain("Sprache");
  });

  it("survives missing storage", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    vi.stubGlobal("navigator", { language: "en-US" });
    expect(getLocale()).toBe("en");
    expect(() => setLocale("de")).not.toThrow();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, languageSelect, locales, setLocale } from "../src/i18n";

function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
  return store;
}

describe("locale", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("prefers a saved locale", () => { stubStorage({ "quietglass.locale": "fr" }); vi.stubGlobal("navigator", { language: "de-DE" }); expect(getLocale()).toBe("fr"); });
  it("detects the browser language", () => { stubStorage(); vi.stubGlobal("navigator", { language: "it-CH" }); expect(getLocale()).toBe("it"); });
  it("falls back to English", () => { stubStorage({ "quietglass.locale": "klingon" }); vi.stubGlobal("navigator", { language: "pt-BR" }); expect(getLocale()).toBe("en"); });
  it("persists the choice", () => { const store = stubStorage(); setLocale("es"); expect(store.get("quietglass.locale")).toBe("es"); });
  it("offers every locale and marks the active one", () => {
    const html = languageSelect("it");
    expect(locales.every((locale) => html.includes(`value="${locale}"`))).toBe(true);
    expect(html).toContain('value="it" selected');
    expect(html.match(/selected/g)).toHaveLength(1);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { escapeHtml, getLocale, languageSelect, locales, setLocale, tr, type Messages } from "../src/i18n";

const messages: Messages = { de: { hi: "Hallo {name}" }, en: { hi: "Hello {name}", only: "English only" }, fr: {}, es: {}, it: {} };

function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
  return store;
}

describe("translation", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("substitutes every occurrence of a variable", () => { expect(tr({ ...messages, en: { x: "{n}/{n}" } }, "en", "x", { n: 3 })).toBe("3/3"); });
  it("uses the requested locale", () => { expect(tr(messages, "de", "hi", { name: "Ana" })).toBe("Hallo Ana"); });
  it("falls back to English, then to the key", () => {
    expect(tr(messages, "fr", "only")).toBe("English only");
    expect(tr(messages, "fr", "missing.key")).toBe("missing.key");
  });
  it("prefers a saved locale", () => { stubStorage({ "quietglass.locale": "it" }); vi.stubGlobal("navigator", { language: "de-AT" }); expect(getLocale()).toBe("it"); });
  it("detects the browser language when nothing is saved", () => { stubStorage(); vi.stubGlobal("navigator", { language: "es-MX" }); expect(getLocale()).toBe("es"); });
  it("falls back to English for unsupported languages and garbage", () => {
    stubStorage({ "quietglass.locale": "xx" }); vi.stubGlobal("navigator", { language: "ja-JP" }); expect(getLocale()).toBe("en");
  });
  it("persists the chosen locale", () => { const store = stubStorage(); setLocale("fr"); expect(store.get("quietglass.locale")).toBe("fr"); });
  it("lists every locale in the selector with the active one selected", () => {
    const html = languageSelect("de");
    for (const locale of locales) expect(html).toContain(`value="${locale}"`);
    expect(html).toContain('value="de" selected');
    expect(html).toContain("Sprache");
  });
});

describe("html escaping", () => {
  it("escapes markup and quotes", () => { expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe("&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;"); });
  it("leaves plain text alone", () => { expect(escapeHtml("Grüße · 12 °C")).toBe("Grüße · 12 °C"); });
});

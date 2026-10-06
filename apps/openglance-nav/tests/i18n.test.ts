import { afterEach, describe, expect, it, vi } from "vitest";
import { escapeHtml, getLocale, languageSelect, locales, setLocale, tr, type Messages } from "../src/i18n";
import { messages } from "../src/messages";

const sample: Messages = { de: { hi: "Hallo {name}" }, en: { hi: "Hello {name}", only: "English only" } };

function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
  return store;
}

describe("translation", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("substitutes every occurrence of a variable", () => { expect(tr({ ...sample, en: { x: "{n}/{n}" } }, "en", "x", { n: 3 })).toBe("3/3"); });
  it("uses the requested locale", () => { expect(tr(sample, "de", "hi", { name: "Ana" })).toBe("Hallo Ana"); });
  it("falls back to English, then to the key", () => {
    expect(tr(sample, "de", "only")).toBe("English only");
    expect(tr(sample, "de", "missing.key")).toBe("missing.key");
  });
  it("prefers a saved locale", () => { stubStorage({ "quietglass.locale": "en" }); vi.stubGlobal("navigator", { language: "de-AT" }); expect(getLocale()).toBe("en"); });
  it("follows the device language when nothing is saved", () => { stubStorage(); vi.stubGlobal("navigator", { language: "de-AT" }); expect(getLocale()).toBe("de"); });
  it("falls back to English for other languages and garbage", () => {
    stubStorage({ "quietglass.locale": "xx" }); vi.stubGlobal("navigator", { language: "ja-JP" }); expect(getLocale()).toBe("en");
  });
  it("still starts when storage throws or navigator is missing", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    vi.stubGlobal("navigator", undefined);
    expect(getLocale()).toBe("en");
    expect(() => setLocale("de")).not.toThrow();
  });
  it("persists the chosen locale", () => { const store = stubStorage(); setLocale("de"); expect(store.get("quietglass.locale")).toBe("de"); });
  it("lists both languages with the active one selected", () => {
    const html = languageSelect("de");
    for (const locale of locales) expect(html).toContain(`value="${locale}"`);
    expect(html).toContain('value="de" selected');
    expect(html).toContain("Sprache");
  });
});

describe("the message catalogue", () => {
  it("has a German text for every English key", () => {
    expect(Object.keys(messages.de).sort()).toEqual(Object.keys(messages.en).sort());
  });

  it("keeps every glasses and error text within one 46-character line", () => {
    for (const locale of locales) {
      for (const [key, text] of Object.entries(messages[locale])) {
        if (key.startsWith("g.") || key.startsWith("err.")) expect(text.length, key).toBeLessThanOrEqual(46);
      }
    }
  });

  it("writes German with real umlauts, not ae/oe/ue", () => {
    const german = Object.values(messages.de).join(" ");
    expect(german).toMatch(/[äöüß]/);
    expect(german).not.toMatch(/Uebersicht|Strasse|Fuss|fuer|moeglich/);
  });

  it("keeps router jargon out of the everyday texts", () => {
    for (const locale of locales) {
      for (const [key, text] of Object.entries(messages[locale])) {
        // The advanced server fields may name the software; nothing else does.
        if (key === "p.routerUrl" || key === "p.routerHint" || key === "p.geocoderUrl" || key === "p.geocoderHint") continue;
        expect(text, key).not.toMatch(/valhalla|costing|precision|polyline|geocod/i);
      }
    }
  });
});

describe("html escaping", () => {
  it("escapes markup and quotes", () => { expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe("&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;"); });
  it("leaves plain text alone", () => { expect(escapeHtml("Grüße · Straße")).toBe("Grüße · Straße"); });
});

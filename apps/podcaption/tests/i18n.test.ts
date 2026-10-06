import { describe, expect, it } from "vitest";
import { languageSelect, tr, type Messages } from "../src/i18n";

const messages: Messages = { de: { hi: "Hallo {name}, {name}!" }, en: { hi: "Hi {name}", only: "English only" }, fr: {}, es: {}, it: {} };

describe("i18n", () => {
  it("substitutes every occurrence of a variable", () => { expect(tr(messages, "de", "hi", { name: "Ada" })).toBe("Hallo Ada, Ada!"); });
  it("falls back to English, then to the key", () => {
    expect(tr(messages, "fr", "only")).toBe("English only");
    expect(tr(messages, "fr", "missing")).toBe("missing");
  });
  it("marks the active language in the selector", () => {
    const html = languageSelect("it");
    expect(html).toContain("Lingua");
    expect(html).toContain('<option value="it" selected>');
    expect(html.match(/<option/g)).toHaveLength(5);
  });
});

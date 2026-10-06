import { describe, it, expect, vi } from "vitest";
import {
  LANGUAGES, normalizeLanguageCode, readLanguageChoice, resolveSourceLanguage, selectValueFor,
} from "../src/text/languages";
import { EMPTY_DATA, parseData, translationEnabled, type BabelData } from "../src/storage/persist";
import { applyForm, languageOptions, mountPhoneUiInto, type FormValues, type UiRoot } from "../src/ui/phone";

describe("language list", () => {
  it("offers the languages the owner needs", () => {
    const codes = LANGUAGES.map((l) => l.code);
    for (const code of ["ru", "be", "de", "uk", "en"]) expect(codes).toContain(code);
  });

  it("offers auto only for the source", () => {
    expect(languageOptions("auto", true)).toContain('value="auto" selected');
    expect(languageOptions("de", false)).not.toContain('value="auto"');
    expect(languageOptions("de", false)).toContain('value="de" selected');
    expect(languageOptions("be", true, "en")).toContain("Belarusian — Беларуская");
  });

  it("selects the custom option for codes not in the list", () => {
    expect(selectValueFor("ka", true)).toBe("custom");
    expect(selectValueFor("de-at", true)).toBe("custom");
    expect(selectValueFor("auto", false)).toBe("custom");
    expect(languageOptions("ka", true)).toContain('value="custom" selected');
  });
});

describe("normalising codes", () => {
  it("accepts and tidies language tags", () => {
    expect(normalizeLanguageCode(" RU ")).toBe("ru");
    expect(normalizeLanguageCode("pt_BR")).toBe("pt-br");
    expect(normalizeLanguageCode("AUTO")).toBe("auto");
  });

  it("rejects things that are not codes", () => {
    expect(normalizeLanguageCode("Russian")).toBeNull();
    expect(normalizeLanguageCode("")).toBeNull();
    expect(normalizeLanguageCode("de de")).toBeNull();
    expect(normalizeLanguageCode(42)).toBeNull();
  });

  it("reads a select + custom field back", () => {
    expect(readLanguageChoice("be", "", "auto", true)).toBe("be");
    expect(readLanguageChoice("custom", " KA ", "auto", true)).toBe("ka");
    expect(readLanguageChoice("custom", "nonsense words", "auto", true)).toBe("auto");
    expect(readLanguageChoice("auto", "", "en", false)).toBe("en");
    expect(readLanguageChoice("custom", "auto", "en", false)).toBe("en");
  });

  it("resolves the translation source from setting and detection", () => {
    expect(resolveSourceLanguage("auto", "be", true)).toBe("be");
    expect(resolveSourceLanguage("auto", "BE-by", true)).toBe("be");
    expect(resolveSourceLanguage("auto", "be", false)).toBe("auto");
    expect(resolveSourceLanguage("ru", "be", true)).toBe("ru");
  });
});

describe("persistence migration from 0.1.0 free-text settings", () => {
  const legacy = (fields: Record<string, unknown>) => parseData(JSON.stringify({
    mode: "conversation", sttUrl: "ws://h:9000", translateUrl: "http://h:5000/translate",
    invertScroll: false, ...fields,
  }));

  it("loads 0.1.0 data unchanged as LibreTranslate", () => {
    const data = legacy({ sourceLanguage: "ru", targetLanguage: "de", translateKey: "k" });
    expect(data).toMatchObject({
      sourceLanguage: "ru", targetLanguage: "de", translateProvider: "libretranslate",
      translateUrl: "http://h:5000/translate", translateKey: "k",
      llmUrl: "", llmModel: "", transliterateOriginal: false,
    });
    expect(translationEnabled(data)).toBe(true);
  });

  it("normalises hand-typed codes", () => {
    expect(legacy({ sourceLanguage: " BE ", targetLanguage: "DE" })).toMatchObject({ sourceLanguage: "be", targetLanguage: "de" });
    expect(legacy({ sourceLanguage: "de_AT" }).sourceLanguage).toBe("de-at");
  });

  it("falls back for values that were never codes", () => {
    expect(legacy({ sourceLanguage: "Russian", targetLanguage: "German" }))
      .toMatchObject({ sourceLanguage: "auto", targetLanguage: "en" });
    expect(legacy({ targetLanguage: "auto" }).targetLanguage).toBe("en");
  });

  it("round-trips the new fields", () => {
    const data: BabelData = {
      ...EMPTY_DATA, translateProvider: "openai", llmUrl: "http://h:11434/v1", llmModel: "qwen2.5:7b",
      llmKey: "t", sourceLanguage: "be", targetLanguage: "de", transliterateOriginal: true,
    };
    expect(parseData(JSON.stringify(data))).toEqual(data);
  });

  it("rejects an unknown provider and an unusable LLM URL", () => {
    expect(parseData(JSON.stringify({ translateProvider: "deepl" })).translateProvider).toBe("libretranslate");
    expect(parseData(JSON.stringify({ llmUrl: "ftp://x" })).llmUrl).toBe("");
    expect(parseData("null")).toEqual(EMPTY_DATA);
  });

  it("needs URL and model before the LLM provider counts as on", () => {
    const base = { ...EMPTY_DATA, translateProvider: "openai" as const };
    expect(translationEnabled({ ...base, llmUrl: "http://h/v1" })).toBe(false);
    expect(translationEnabled({ ...base, llmUrl: "http://h/v1", llmModel: "m" })).toBe(true);
    // The LibreTranslate URL does not switch the LLM provider on.
    expect(translationEnabled({ ...base, translateUrl: "http://h/translate" })).toBe(false);
  });
});

const form = (over: Partial<FormValues> = {}): FormValues => ({
  sttUrl: "", sttToken: "", source: "auto", sourceCustom: "", provider: "libretranslate",
  translateUrl: "", translateKey: "", llmUrl: "", llmModel: "", llmKey: "",
  target: "en", targetCustom: "", transliterate: false, ...over,
});

describe("phone form", () => {
  it("saves the Belarusian → German LLM setup", () => {
    const result = applyForm(EMPTY_DATA, form({
      sttUrl: "ws://spark:9000", source: "be", provider: "openai",
      llmUrl: " http://spark:11434/v1 ", llmModel: " qwen2.5:7b-instruct ", target: "de", transliterate: true,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      sourceLanguage: "be", targetLanguage: "de", translateProvider: "openai",
      llmUrl: "http://spark:11434/v1", llmModel: "qwen2.5:7b-instruct", transliterateOriginal: true,
    });
  });

  it("keeps stored secrets when their fields are left empty", () => {
    const current = { ...EMPTY_DATA, llmKey: "old", translateKey: "lt" };
    const result = applyForm(current, form({ llmKey: "" }));
    expect(result.ok && result.data.llmKey).toBe("old");
    expect(result.ok && result.data.translateKey).toBe("lt");
  });

  it("rejects bad URLs and a missing model", () => {
    const bad = applyForm(EMPTY_DATA, form({ provider: "openai", llmUrl: "ws://nope" }));
    expect(bad.ok).toBe(false);
    const noModel = applyForm(EMPTY_DATA, form({ provider: "openai", llmUrl: "http://h/v1" }), "en");
    expect(noModel.ok === false && noModel.errors.join(" ")).toContain("model");
  });

  it("takes a custom code from the text field", () => {
    const result = applyForm(EMPTY_DATA, form({ source: "custom", sourceCustom: "KA", target: "custom", targetCustom: "de-AT" }));
    expect(result.ok && [result.data.sourceLanguage, result.data.targetLanguage]).toEqual(["ka", "de-at"]);
  });
});

/** Just enough DOM for the wiring: elements by id with listeners. */
function fakeRoot() {
  const elements = new Map<string, { value: string; checked: boolean; hidden: boolean; textContent: string;
    listeners: Record<string, Array<(e: { target: unknown }) => void>>;
    addEventListener(type: string, fn: (e: { target: unknown }) => void): void; }>();
  const el = (id: string) => {
    let e = elements.get(id);
    if (!e) {
      const created = {
        value: "", checked: false, hidden: false, textContent: "", listeners: {} as Record<string, Array<(e: { target: unknown }) => void>>,
        addEventListener(type: string, fn: (e: { target: unknown }) => void) { (this.listeners[type] ??= []).push(fn); },
      };
      elements.set(id, created);
      e = created;
    }
    return e;
  };
  const root: UiRoot & { fire(id: string, type: string): void; el: typeof el } = {
    innerHTML: "",
    querySelector: ((selector: string) => el(selector.replace(/^#/, ""))) as UiRoot["querySelector"],
    fire(id, type) { const e = el(id); for (const fn of e.listeners[type] ?? []) fn({ target: e }); },
    el,
  };
  return root;
}

describe("phone UI wiring", () => {
  it("does not undo one immediate change with the next (stale settings bug)", async () => {
    let stored: BabelData = { ...EMPTY_DATA };
    const setData = vi.fn(async (next: BabelData) => { stored = next; });
    const root = fakeRoot();
    mountPhoneUiInto(root, { getData: () => stored, setData });

    root.el("mode").value = "lecture";
    root.fire("mode", "change");
    root.el("invert").checked = true;
    root.fire("invert", "change");
    await new Promise((r) => setTimeout(r, 0));

    // Before the fix the second change was merged into the settings captured
    // at render time, silently reverting the mode to "conversation".
    expect(stored.mode).toBe("lecture");
    expect(stored.invertScroll).toBe(true);
  });

  it("shows the custom code field only for the custom option", () => {
    const root = fakeRoot();
    mountPhoneUiInto(root, { getData: () => EMPTY_DATA, setData: async () => undefined });
    root.el("source").value = "custom";
    root.fire("source", "change");
    expect(root.el("source-custom").hidden).toBe(false);
    root.el("source").value = "be";
    root.fire("source", "change");
    expect(root.el("source-custom").hidden).toBe(true);
  });

  it("switches the visible provider fields", () => {
    const root = fakeRoot();
    mountPhoneUiInto(root, { getData: () => EMPTY_DATA, setData: async () => undefined });
    root.el("provider").value = "openai";
    root.fire("provider", "change");
    expect(root.el("llm-fields").hidden).toBe(false);
    expect(root.el("libre-fields").hidden).toBe(true);
  });

  it("saves the form and persists provider, languages and transliteration", async () => {
    let stored: BabelData = { ...EMPTY_DATA };
    const root = fakeRoot();
    mountPhoneUiInto(root, { getData: () => stored, setData: async (next) => { stored = next; }, getLocale: () => "en" });
    Object.assign(root.el("provider"), { value: "openai" });
    Object.assign(root.el("llm-url"), { value: "http://spark:8000/v1" });
    Object.assign(root.el("llm-model"), { value: "Qwen/Qwen2.5-7B-Instruct" });
    Object.assign(root.el("source"), { value: "ru" });
    Object.assign(root.el("target"), { value: "de" });
    Object.assign(root.el("translit"), { checked: true });
    root.fire("save", "click");
    await new Promise((r) => setTimeout(r, 0));
    expect(stored).toMatchObject({
      translateProvider: "openai", llmModel: "Qwen/Qwen2.5-7B-Instruct",
      sourceLanguage: "ru", targetLanguage: "de", transliterateOriginal: true,
    });
    expect(root.innerHTML).toContain("Saved.");
  });

  it("renders the stored selection", () => {
    const root = fakeRoot();
    const data: BabelData = { ...EMPTY_DATA, sourceLanguage: "be", targetLanguage: "de", translateProvider: "openai", transliterateOriginal: true };
    mountPhoneUiInto(root, { getData: () => data, setData: async () => undefined });
    expect(root.innerHTML).toMatch(/id="source">[^]*value="be" selected/);
    expect(root.innerHTML).toMatch(/value="openai" selected/);
    expect(root.innerHTML).toMatch(/id="translit" type="checkbox" checked/);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, languageSelect, locales, setLocale, tr, type Locale } from "../src/i18n";
import { messages, t } from "../src/messages";
import {
  buildView, GLASS_COLS, GLASS_ROWS, statusLabel, translateErrorLabel, type CaptionView, type ViewOptions,
} from "../src/glasses/view";
import { applyTranscript, applyTranslation, createBuffer, type CaptionBuffer } from "../src/captions/buffer";
import type { SttStatus } from "../src/stt/provider";
import { LANGUAGES } from "../src/text/languages";
import { EMPTY_DATA, maskSecret } from "../src/storage/persist";
import { applyForm, languageOptions, mountPhoneUiInto, type FormValues, type UiRoot } from "../src/ui/phone";

const vars = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();
const chars = (text: string): number => [...text].length;

describe("translations", () => {
  it("has every key in German and English", () => {
    expect(Object.keys(messages.de).sort()).toEqual(Object.keys(messages.en).sort());
  });

  it("uses the same placeholders in both languages", () => {
    for (const key of Object.keys(messages.en)) {
      expect(vars(messages.de[key] ?? ""), key).toEqual(vars(messages.en[key] ?? ""));
    }
  });

  it("leaves no placeholder behind once filled", () => {
    for (const locale of locales) {
      for (const [key, text] of Object.entries(messages[locale])) {
        const filled = tr(messages, locale, key, Object.fromEntries(vars(text).map((name) => [name, 1])));
        expect(filled, key).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it("uses real umlauts and no glyph the G2 cannot draw", () => {
    const german = Object.values(messages.de).join(" ");
    expect(german).toMatch(/[äöüß]/);
    expect(german).not.toMatch(/\b(fuer|ueber|uebersetzung|zurueck|moechte|schliesst|gross|groesse|saetze)\b/i);
    for (const locale of locales) {
      for (const [key, text] of Object.entries(messages[locale])) {
        if (key.startsWith("g.")) expect(text, key).not.toMatch(/[▸◆►]/);
      }
    }
  });

  it("keeps every single glasses string within one row", () => {
    for (const locale of locales) {
      for (const [key, text] of Object.entries(messages[locale])) {
        // The demo lines are captions: they are wrapped to the mode width like real speech.
        if (key.startsWith("g.") && !/^g\.mock\d$/.test(key)) {
          expect(chars(text), `${locale} ${key}`).toBeLessThanOrEqual(GLASS_COLS);
        }
      }
    }
  });

  it("names every language in the pickers in both UI languages", () => {
    for (const language of LANGUAGES) {
      for (const locale of locales) expect(messages[locale]["l." + language.code], `${locale} ${language.code}`).toBeTruthy();
    }
    // The prompt sent to an LLM keeps the English names, whatever the UI says.
    expect(LANGUAGES.find((l) => l.code === "be")?.name).toBe("Belarusian");
  });

  it("lists caption languages in the UI language, codes unchanged", () => {
    const de = languageOptions("be", true, "de");
    expect(de).toContain('value="be" selected>Belarussisch — Беларуская');
    expect(de).toContain(">Automatisch erkennen<");
    expect(de).toContain(">Deutsch<");
    expect(de).toContain('value="custom">Andere (Code eingeben)…');
    const en = languageOptions("be", true, "en");
    expect(en).toContain('value="be" selected>Belarusian — Беларуская');
    expect(en).toContain(">English<");
  });

  it("translates the secret mask and form errors", () => {
    expect(maskSecret("abc", "de")).toBe("gesetzt (3 Zeichen)");
    expect(maskSecret(undefined, "de")).toBe("keins");
    const form: FormValues = {
      sttUrl: "https://wrong", sttToken: "", source: "auto", sourceCustom: "", provider: "openai",
      translateUrl: "", translateKey: "", llmUrl: "http://h/v1", llmModel: "", llmKey: "",
      target: "de", targetCustom: "", transliterate: false,
    };
    const de = applyForm(EMPTY_DATA, form, "de");
    expect(de.ok === false && de.errors).toEqual([
      "Die Adresse des Sprachservers muss mit ws:// oder wss:// beginnen.",
      "Gib den Namen des Modells ein, das der LLM-Server nutzen soll.",
    ]);
    const en = applyForm(EMPTY_DATA, form, "en");
    expect(en.ok === false && en.errors).toEqual([
      "Speech server URL must start with ws:// or wss://.",
      "Enter the model name the LLM server should use.",
    ]);
  });
});

describe("language choice", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("follows the device language and falls back to English", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("navigator", { language: "de-AT" });
    expect(getLocale()).toBe("de");
    vi.stubGlobal("navigator", { language: "it-IT" });
    expect(getLocale()).toBe("en");
  });

  it("prefers the language picked on the phone, and survives blocked storage", () => {
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("localStorage", { getItem: () => "de", setItem: () => undefined });
    expect(getLocale()).toBe("de");
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    expect(getLocale()).toBe("en");
    expect(() => setLocale("de")).not.toThrow();
  });

  it("starts in English with neither storage nor navigator", () => {
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("navigator", undefined);
    expect(getLocale()).toBe("en");
  });

  it("offers German and English on the phone", () => {
    const html = languageSelect("de");
    expect(html).toContain("Sprache");
    expect(html).toContain('<option value="de" selected>');
    expect(html.match(/<option/g)).toHaveLength(2);
  });
});

describe("glasses text budget", () => {
  const base = { mode: "conversation" as const, listening: true, status: "ready" as SttStatus, translating: false, offset: 0, mock: false };
  const withLine = (text: string): CaptionBuffer => applyTranscript(createBuffer(), { text, final: true }, 1);
  const longHistory = (): CaptionBuffer => {
    let buffer = createBuffer();
    for (let i = 0; i < 30; i++) buffer = applyTranscript(buffer, { text: "line " + i, final: true }, i);
    return buffer;
  };

  /** Every screen the app writes text of its own on: idle, each status, errors, history, and all at once. */
  function screens(locale: Locale): Array<[string, CaptionView]> {
    const view = (buffer: CaptionBuffer, over: Partial<ViewOptions>): CaptionView =>
      buildView(buffer, { ...base, locale, ...over });
    const out: Array<[string, CaptionView]> = [
      ["idle", view(createBuffer(), { listening: false })],
      ["idle mock", view(createBuffer(), { listening: false, mock: true })],
      ["listening mock", view(withLine("hi"), { mock: true })],
    ];
    for (const status of ["idle", "connecting", "ready", "reconnecting", "error"] as SttStatus[]) {
      out.push(["empty " + status, view(createBuffer(), { status })]);
    }
    for (const error of ["timed out", "unreachable", "unreadable response", "empty response", "HTTP 503",
      "a very long raw error message from somewhere deep in the network stack"]) {
      out.push(["error " + error, view(withLine("x"), { translating: true, translateError: error })]);
      out.push(["worst " + error, view(longHistory(), {
        translating: true, translateError: error, status: "reconnecting", mock: true, offset: 10,
      })]);
    }
    out.push(["history", view(longHistory(), { offset: 10 })]);
    out.push(["error + history", view(longHistory(), { translating: true, translateError: "unreachable", status: "error", offset: 10 })]);
    return out;
  }

  for (const locale of ["de", "en"] as const) {
    it(`fits every ${locale} screen: header and footer one row, status screens at most ${GLASS_ROWS} rows`, () => {
      for (const [name, view] of screens(locale)) {
        expect(chars(view.header), `${name}: ${view.header}`).toBeLessThanOrEqual(GLASS_COLS);
        expect(chars(view.footer), `${name}: ${view.footer}`).toBeLessThanOrEqual(GLASS_COLS);
        expect(view.footer, name).not.toMatch(/[▸◆]/);
        expect(view.header + view.footer, name).not.toContain("\n");
        if (name.startsWith("idle") || name.startsWith("empty")) {
          expect(view.body.length, name).toBeLessThanOrEqual(GLASS_ROWS);
          for (const row of view.body) expect(chars(row), `${name}: ${row}`).toBeLessThanOrEqual(GLASS_COLS);
        }
      }
    });

    it(`never drops the microphone indicator, mock marker or connection state (${locale})`, () => {
      for (const [name, view] of screens(locale)) {
        if (name.startsWith("idle")) {
          expect(view.footer, name).not.toContain(t(locale, "g.mic"));
          continue;
        }
        expect(view.footer.startsWith(t(locale, "g.mic")), name).toBe(true);
        if (name.startsWith("worst")) {
          expect(view.footer, name).toContain(t(locale, "g.mock"));
          expect(view.footer, name).toContain(statusLabel("reconnecting", locale));
        }
      }
    });
  }

  it("speaks German on the glasses", () => {
    const idle = buildView(createBuffer(), { ...base, listening: false, locale: "de" });
    expect(idle).toEqual({
      header: "Babel Glass",
      body: ["Mikrofon ist aus.", "Tippe, um Untertitel zu starten."],
      footer: "Tippen = Start",
    });
    const listening = buildView(createBuffer(), { ...base, locale: "de" });
    expect(listening.body).toEqual(["hört zu…"]);
    expect(listening.footer).toBe("● MIKRO · Tippen = Stopp");
    const failed = buildView(withLine("Привет"), { ...base, translating: true, translateError: "unreachable", locale: "de" });
    expect(failed.footer).toBe("● MIKRO · Übersetzung: nicht erreichbar");
  });

  it("translates the translator's error words and keeps unknown ones verbatim", () => {
    expect(translateErrorLabel("timed out", "de")).toBe("keine Antwort");
    expect(translateErrorLabel("HTTP 502", "de")).toBe("HTTP 502");
    expect(translateErrorLabel("timed out", "en")).toBe("timed out");
  });

  it("never translates captions, only the frame around them", () => {
    const buffer = applyTranslation(withLine("good morning"), "good morning", "guten Morgen");
    for (const locale of locales) {
      const body = buildView(buffer, { ...base, translating: true, locale }).body;
      expect(body).toEqual(["guten Morgen", "good morning"]);
    }
  });

  it("shortens a long raw error instead of overflowing the row", () => {
    const view = buildView(withLine("x"), {
      ...base, translating: true, locale: "de", translateError: "a very long raw error message from somewhere deep",
    });
    expect(view.footer.startsWith("● MIKRO · Übersetzung: a very")).toBe(true);
    expect(view.footer.endsWith("…")).toBe(true);
    expect(chars(view.footer)).toBe(GLASS_COLS);
  });
});

/** Just enough DOM for the phone page: elements by id with listeners. */
function fakeRoot() {
  type El = { value: string; checked: boolean; hidden: boolean; textContent: string;
    listeners: Record<string, Array<(e: { target: unknown }) => void>>;
    addEventListener(type: string, fn: (e: { target: unknown }) => void): void; };
  const elements = new Map<string, El>();
  const el = (id: string): El => {
    let e = elements.get(id);
    if (!e) {
      const created: El = {
        value: "", checked: false, hidden: false, textContent: "", listeners: {},
        addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
      };
      elements.set(id, created);
      e = created;
    }
    return e;
  };
  let html = "";
  const root: UiRoot & { fire(id: string, type: string): void; el: typeof el } = {
    // Like a real page, new markup means new elements: listeners of the old ones are gone.
    get innerHTML() { return html; },
    set innerHTML(value: string) { html = value; for (const e of elements.values()) e.listeners = {}; },
    querySelector: ((selector: string) => el(selector.replace(/^#/, ""))) as UiRoot["querySelector"],
    fire(id, type) { const e = el(id); for (const fn of [...(e.listeners[type] ?? [])]) fn({ target: e }); },
    el,
  };
  return root;
}

describe("phone page", () => {
  it("renders in German with the language picker on top", () => {
    const root = fakeRoot();
    mountPhoneUiInto(root, { getData: () => EMPTY_DATA, setData: async () => undefined, getLocale: () => "de" });
    const html = root.innerHTML;
    expect(html.indexOf('id="language"')).toBeLessThan(html.indexOf('id="source"'));
    for (const text of ["Gesprochene Sprache", "Übersetzen in", "Demo-Modus", "<strong>DEMO</strong>", "Erweitert: Server",
      "Bedienung an der Brille", "<strong>● MIKRO</strong>", "Speichern", "Gespräch — wenige Zeilen, beide Sprachen"]) {
      expect(html).toContain(text);
    }
    expect(html).not.toMatch(/Spoken language|Save<|Controls on the glasses/);
  });

  it("keeps server jargon inside the Advanced sections", () => {
    const root = fakeRoot();
    mountPhoneUiInto(root, { getData: () => EMPTY_DATA, setData: async () => undefined, getLocale: () => "de" });
    const outside = root.innerHTML.replace(/<details[^]*?<\/details>/g, "");
    expect(outside).not.toMatch(/WebSocket|Endpoint|LLM|Bearer|API/);
  });

  it("switches language on the phone and reports it to the host", () => {
    let locale: Locale = "en";
    const picked: Locale[] = [];
    const root = fakeRoot();
    mountPhoneUiInto(root, {
      getData: () => EMPTY_DATA, setData: async () => undefined,
      getLocale: () => locale, setLocale: (next) => { picked.push(next); locale = next; },
    });
    expect(root.innerHTML).toContain("Spoken language");
    root.el("language").value = "de";
    root.fire("language", "change");
    expect(picked).toEqual(["de"]);
    expect(root.innerHTML).toContain("Gesprochene Sprache");
  });

  it("reports a saved form in German", async () => {
    const root = fakeRoot();
    mountPhoneUiInto(root, { getData: () => EMPTY_DATA, setData: async () => undefined, getLocale: () => "de" });
    root.fire("save", "click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.innerHTML).toContain("Gespeichert.");
  });
});

// Boots the real app against a fake bridge and a fake phone page.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

describe("switching language on the phone redraws the glasses", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function boot() {
    const screen: Record<string, string> & { header: string; body: string; footer: string } = { header: "", body: "", footer: "" };
    let handler: ((event: unknown) => void) | undefined;
    harness.bridge = {
      getLocalStorage: async () => "",
      setLocalStorage: async () => true,
      rebuildPageContainer: async () => true,
      createStartUpPageContainer: async (page: { textObject?: Array<{ containerName?: string; content?: string }> }) => {
        for (const item of page.textObject ?? []) screen[item.containerName ?? ""] = item.content ?? "";
        return 0;
      },
      textContainerUpgrade: async (update: { containerName?: string; content?: string }) => {
        screen[update.containerName ?? ""] = update.content ?? "";
        return true;
      },
      audioControl: async () => true,
      shutDownPageContainer: async () => false,
      onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
      onDeviceStatusChanged: () => () => undefined,
    };
    const saved: string[] = [];
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: (_key: string, value: string) => { saved.push(value); } });
    const page = fakeRoot();
    const documentElement = { lang: "" };
    vi.stubGlobal("document", { getElementById: (id: string) => (id === "app" ? page : null), documentElement });
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(handler).toBeDefined());
    await vi.advanceTimersByTimeAsync(10);
    return { screen, page, saved, documentElement, tap: () => handler?.({ sysEvent: { eventType: 0, eventSource: 1 } }) };
  }

  it("redraws the idle screen at once and remembers the choice", async () => {
    const app = await boot();
    expect(app.screen.body).toBe("Not listening.\nTap to start captions.");
    expect(app.page.innerHTML).toContain("Spoken language");

    app.page.el("language").value = "de";
    app.page.fire("language", "change");
    await vi.advanceTimersByTimeAsync(10);

    expect(app.screen.body).toBe("Mikrofon ist aus.\nTippe, um Untertitel zu starten.");
    expect(app.screen.footer).toBe("Demo ohne Server");
    expect(app.page.innerHTML).toContain("Gesprochene Sprache");
    expect(app.documentElement.lang).toBe("de");
    expect(app.saved).toEqual(["de"]);
  });

  it("switches the footer and the demo lines while captions run", async () => {
    const app = await boot();
    app.tap();
    await vi.advanceTimersByTimeAsync(3100);
    expect(app.screen.footer.startsWith("● MIC · MOCK")).toBe(true);
    expect(app.screen.body).toContain("This is the mock recogniser.");

    app.page.el("language").value = "de";
    app.page.fire("language", "change");
    await vi.advanceTimersByTimeAsync(10);
    expect(app.screen.footer.startsWith("● MIKRO · DEMO")).toBe(true);

    await vi.advanceTimersByTimeAsync(3000);
    expect(app.screen.body).toContain("Sie zeigt feste Sätze, ganz ohne Server.");
  });
});

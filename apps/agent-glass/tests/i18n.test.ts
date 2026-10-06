import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, languageSelect, locales, tr, type Locale } from "../src/i18n";
import { localizeError, messages } from "../src/messages";
import { BODY_ROWS, LINE_WIDTH, buildView, sessionList, type AgentView } from "../src/glasses/view";
import { EMPTY_STATE, type AgentState, type Session } from "../src/terminal/types";
import { STREAM_CLOSED, STREAM_INTERRUPTED } from "../src/terminal/client";
import { DEFAULT_SETTINGS, maskToken, normalizeAddress, parseSettings } from "../src/storage/persist";
import {
  AgentNarrator, resolveSpeechLanguage, sanitizeForSpeech, type SpeechEngine,
} from "../src/speech/narrator";
import { parseEvent } from "../src/terminal/types";
import { mountPhoneUi, type PhoneUiPorts } from "../src/ui/phone";

const vars = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();
const NOW = new Date("2026-10-07T12:00:00Z");

describe("translations", () => {
  it("has every key in German and English", () => {
    expect(Object.keys(messages.de).sort()).toEqual(Object.keys(messages.en).sort());
    for (const locale of locales) {
      for (const [key, text] of Object.entries(messages[locale])) expect(text.trim(), `${locale} ${key}`).not.toBe("");
    }
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
    expect(german).not.toMatch(/\b(fuer|ueber|zurueck|noetig|waehlen|oeffnen|laeuft|Schluessel)\b/i);
    for (const locale of locales) {
      for (const [key, text] of Object.entries(messages[locale])) {
        if (key.startsWith("g.") || key.startsWith("e.")) {
          expect(text, key).not.toMatch(/[▸◆]/);
          // Only ASCII plus what the G2 font is known to draw.
          expect(text, key).toMatch(/^[\x20-\x7EäöüÄÖÜß●→…·○—]*$/);
        }
      }
    }
  });

  it("translates the app's own errors but leaves a server's message alone", () => {
    expect(localizeError("Token rejected", "de")).toBe("Token abgelehnt");
    expect(localizeError(STREAM_INTERRUPTED, "de")).toBe("Verbindung unterbrochen");
    expect(localizeError(STREAM_CLOSED, "en")).toBe(STREAM_CLOSED);
    expect(localizeError("ECONNRESET at 10.0.0.2", "de")).toBe("ECONNRESET at 10.0.0.2");
  });

  it("translates phone-side address errors and the token mask", () => {
    const bad = normalizeAddress("ftp://example", "even-terminal", "de");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("muss mit");
    expect(maskToken("", "de")).toBe("keins");
    expect(maskToken("0366d1d7440bab2495d39633bd9c5a45", "de")).toBe("gesetzt (32 Zeichen, endet auf 5a45)");
    expect(maskToken("0366d1d7440bab2495d39633bd9c5a45", "en")).toBe("set (32 characters, ends in 5a45)");
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
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => undefined });
    expect(getLocale()).toBe("en");
  });

  it("offers German and English on the phone", () => {
    const html = languageSelect("de");
    expect(html).toContain("Sprache");
    expect(html).toContain('<option value="de" selected>');
    expect(html.match(/<option/g)).toHaveLength(2);
  });
});

describe("narrator language", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("keeps an explicit choice and only resolves 'auto'", () => {
    expect(resolveSpeechLanguage("en-GB", "de", "de-AT")).toBe("en-GB");
    expect(resolveSpeechLanguage("it-IT", "de", "de-AT")).toBe("it-IT");
    // Auto: the phone language, regional variant kept, as before.
    expect(resolveSpeechLanguage("auto", "de", "de-AT")).toBe("de-AT");
    expect(resolveSpeechLanguage("auto", "en", "it-IT")).toBe("it-IT");
    expect(resolveSpeechLanguage("auto", undefined, "fr-FR")).toBe("fr-FR");
    // Auto, and the app language was switched away from a German/English phone.
    expect(resolveSpeechLanguage("auto", "en", "de-AT")).toBe("en-US");
    expect(resolveSpeechLanguage("auto", "de", "en-GB")).toBe("de-DE");
    expect(resolveSpeechLanguage("auto", "en", "")).toBe("en-US");
  });

  it("does not rewrite a stored narrator language", () => {
    expect(DEFAULT_SETTINGS.speechLanguage).toBe("auto");
    expect(parseSettings(JSON.stringify({ speechLanguage: "en-GB" })).speechLanguage).toBe("en-GB");
    expect(parseSettings(JSON.stringify({ speechLanguage: "auto" })).speechLanguage).toBe("auto");
  });

  it("speaks its own phrases in the narrator's language, and agent text untouched", () => {
    vi.stubGlobal("navigator", { language: "de-AT" });
    const spoken: { text: string; language: string }[] = [];
    const engine: SpeechEngine = {
      available: true,
      voices: () => [],
      speak: (request) => { spoken.push({ text: request.text, language: request.language }); request.onEnd(); },
      cancel: () => undefined, pause: () => undefined, resume: () => undefined,
    };
    let speechLanguage = "auto";
    let ui: Locale = "de";
    const narrator = new AgentNarrator(engine, () => ({
      spokenOutput: true, speechLanguage, speechVoice: "", speechRate: 1,
    }), () => ui);
    narrator.activate();
    narrator.accept(parseEvent({ type: "permission_request", tool: "Bash", input: { command: "ls" } }));
    narrator.accept(parseEvent({ type: "text", text: "The build passed. See https://example.com now." }));
    narrator.accept(parseEvent({ type: "result" }));
    expect(spoken.map((item) => item.text)).toEqual([
      "Vorlesen ist bereit.",
      "Freigabe nötig für Bash. Schau auf die Brille.",
      "The build passed.",
      "See Link ausgelassen now.",
    ]);
    expect(spoken[0]?.language).toBe("de-AT");

    // An explicit English voice stays English even with a German app.
    speechLanguage = "en-US";
    narrator.accept(parseEvent({ type: "user_question", text: "?" }));
    expect(spoken.at(-1)).toEqual({ text: "The agent has a question. Check the glasses.", language: "en-US" });

    // Auto follows a switch of the app language to English.
    speechLanguage = "auto";
    ui = "en";
    narrator.accept(parseEvent({ type: "error", message: "x" }));
    expect(spoken.at(-1)).toEqual({ text: "The agent reported an error. Check the glasses.", language: "en-US" });
  });

  it("labels omitted code in German for a German voice", () => {
    expect(sanitizeForSpeech("Run `npm test` please.", "de")).toBe("Run Code ausgelassen please.");
    expect(sanitizeForSpeech("Run `npm test` please.", "en")).toBe("Run code omitted please.");
  });
});

/** Every glasses screen this app can draw, in representative and worst-case states. */
function allViews(locale: Locale): AgentView[] {
  const longTitle = "Refactor the authentication middleware and update every integration test in the repo";
  const session: Session = {
    id: "s", title: longTitle, cwd: "/w", provider: "codex", status: "running", timestamp: NOW,
  };
  const base: AgentState = { ...EMPTY_STATE, session, text: "Working on it. ".repeat(40) };
  const states: AgentState[] = [
    EMPTY_STATE,
    { ...EMPTY_STATE, error: "No token — enter one in the phone app." },
    base,
    { ...base, controllable: true },
    { ...base, controllable: true, busy: true, startedAt: new Date(NOW.getTime() - 9_999_000) },
    { ...base, controllable: false, busy: true, startedAt: new Date(NOW.getTime() - 5_000) },
    { ...base, controllable: true, busy: true, tool: "mcp__some_server__a_very_long_tool_name_that_never_ends", startedAt: NOW },
    { ...base, text: "" },
    { ...base, pending: { kind: "permission", title: "Bash", detail: "rm -rf build && ".repeat(30) }, controllable: true },
    { ...base, pending: { kind: "permission", title: "Tool", detail: "" }, controllable: false },
    { ...base, pending: { kind: "question", title: "Question", detail: "Which branch? ".repeat(30) }, controllable: true },
  ];
  for (const error of Object.values(messages.en).filter((_, i) => Object.keys(messages.en)[i]?.startsWith("e."))) {
    states.push({ ...base, error });
  }
  states.push({ ...base, error: "x".repeat(500) });
  states.push({ ...base, error: "Even Terminal " + "unreachable because of a long story ".repeat(20) });

  const many = Array.from({ length: 23 }, (_, i) => ({ title: `${longTitle} ${i}`, cwd: "/w", status: i % 2 ? "running" : "idle" }));
  return [
    ...states.map((state) => buildView(state, NOW, locale)),
    sessionList([], 0, locale),
    sessionList(many, 0, locale),
    sessionList(many, 22, locale),
  ];
}

describe("glasses text budget", () => {
  for (const locale of ["de", "en"] as const) {
    it(`fits every ${locale} screen into ${BODY_ROWS} rows of ${LINE_WIDTH} characters`, () => {
      for (const view of allViews(locale)) {
        expect(view.header.length, view.header).toBeLessThanOrEqual(LINE_WIDTH);
        expect(view.footer.length, view.footer).toBeLessThanOrEqual(LINE_WIDTH);
        expect(view.body.length, view.body.join("|")).toBeLessThanOrEqual(BODY_ROWS);
        for (const line of view.body) expect(line.length, line).toBeLessThanOrEqual(LINE_WIDTH);
        expect([view.header, ...view.body, view.footer].join(" ")).not.toMatch(/[▸◆]/);
      }
    });
  }

  it("really shows German on the glasses", () => {
    const session: Session = { id: "s", title: "T", cwd: "/w", provider: "codex", status: "running", timestamp: NOW };
    const asked: AgentState = { ...EMPTY_STATE, session, controllable: true, pending: { kind: "permission", title: "Bash", detail: "ls" } };
    expect(buildView(asked, NOW, "de").header).toBe("Freigabe nötig");
    expect(buildView(asked, NOW, "de").footer).toBe("Hoch = erlauben · Runter = ablehnen");
    expect(buildView({ ...EMPTY_STATE, error: "Even Terminal unreachable" }, NOW, "de").body)
      .toEqual(["", "Even Terminal nicht erreichbar", "", "Läuft Even Terminal mit", "--allow-cors?"]);
    expect(buildView({ ...EMPTY_STATE }, NOW, "de").footer).toBe("Halten = Sitzung wählen");
    expect(sessionList([], 0, "de").header).toBe("Sitzungen");
  });
});

describe("phone page", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("renders in German with the language picker on top", () => {
    let html = "";
    const root = { set innerHTML(value: string) { html = value; }, get innerHTML() { return html; }, querySelector: () => null, querySelectorAll: () => [] };
    vi.stubGlobal("document", { getElementById: () => root, documentElement: { lang: "" } });
    const ports: PhoneUiPorts = {
      getLocale: () => "de",
      getSettings: () => DEFAULT_SETTINGS,
      setSettings: async () => undefined,
      getState: () => EMPTY_STATE,
      getSessions: () => [],
      refresh: () => undefined,
      sendPrompt: async () => undefined,
      createSession: async () => undefined,
      getCapabilities: () => ({ decisions: true, sessions: true, createSession: false }),
      getSpeechStatus: () => "off",
      getSpeechVoices: () => [],
      activateSpeech: async () => true,
      disableSpeech: async () => undefined,
      toggleSpeechPause: () => undefined,
      replaySpeech: () => undefined,
    };
    mountPhoneUi(ports);
    expect(html).toContain('<option value="de" selected>');
    expect(html.indexOf('id="language"')).toBeLessThan(html.indexOf('id="provider"'));
    expect(html).toContain("Speichern und verbinden");
    expect(html).toContain("Vorlese-Sprache");
    expect(html).toContain("Nach oben wischen");
    expect(html).not.toContain("Save and connect");
  });
});

// Boots the real app (demo mode) with a fake bridge and a fake phone page, then
// switches the language on the phone and checks the glasses follow at once.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => {
  const scope = globalThis as { window?: unknown };
  const saved = scope.window;
  scope.window = undefined;
  try {
    return { ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()), waitForEvenAppBridge: async () => harness.bridge };
  } finally {
    scope.window = saved;
  }
});

describe("switching language on the phone", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal("location", { search: "?demo=1", pathname: "/", hash: "" });
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("redraws the glasses in the new language right away and remembers it", async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
    });

    let html = "";
    const listeners = new Map<string, (event: unknown) => void>();
    const root = {
      set innerHTML(value: string) { html = value; listeners.clear(); },
      get innerHTML() { return html; },
      querySelector: (selector: string) => ({
        addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.set(`${selector}:${type}`, listener); },
      }),
      querySelectorAll: () => [],
    };
    vi.stubGlobal("document", {
      getElementById: (id: string) => (id === "app" ? root : null),
      documentElement: { lang: "" },
      querySelector: () => null, addEventListener: () => undefined, removeEventListener: () => undefined,
    });

    const drawn: string[] = [];
    let ready = false;
    harness.bridge = {
      getLocalStorage: async () => "",
      setLocalStorage: async () => true,
      rebuildPageContainer: async () => true,
      createStartUpPageContainer: async (page: { textObject?: { content?: string }[] }) => {
        drawn.push((page.textObject ?? []).map((item) => item.content ?? "").join("\n")); return 0;
      },
      textContainerUpgrade: async (update: { content?: string }) => { drawn.push(update.content ?? ""); return true; },
      shutDownPageContainer: async () => false,
      onEvenHubEvent: () => { ready = true; return () => undefined; },
      onDeviceStatusChanged: () => () => undefined,
    };

    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(ready && html.length > 0).toBe(true));
    expect(drawn.join("\n")).toContain("hold = interrupt");
    expect(html).toContain("Save and connect");

    const before = drawn.length;
    listeners.get("#language:change")?.({ target: { value: "de" } });
    // Far less than the 1 s ticker: the redraw must come from the switch itself.
    await vi.advanceTimersByTimeAsync(5);

    const after = drawn.slice(before).join("\n");
    expect(after).toContain("Halten = unterbrechen");
    expect(after).toContain("arbeitet");
    expect(html).toContain("Speichern und verbinden");
    expect(stored.get("quietglass.locale")).toBe("de");
  });
});

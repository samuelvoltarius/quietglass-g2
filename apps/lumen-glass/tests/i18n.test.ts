import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, languageSelect, locales, tr, type Locale } from "../src/i18n";
import { messages } from "../src/messages";
import { BODY_COLS, LINE_COLS, MAX_BODY_ROWS, buildView, windowLabel, type LumenView, type ViewOptions } from "../src/glasses/view";
import { parseStatus, type LumenStatus } from "../src/lumen/client";
import { mountPhoneUi } from "../src/ui/phone";
import { EMPTY_DATA } from "../src/storage/persist";

// Boots the real app against a fake bridge for the language-switch test.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
vi.mock("../src/glasses/pixel", () => ({ renderPixelIcon: async () => new Uint8Array([1]) }));

const vars = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();

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
    expect(german).not.toMatch(/\b(fuer|ueber|pruef|oeffnet|naechsten|noetig|gueltige|gedrueckt)\w*/i);
    for (const locale of locales) {
      for (const [key, text] of Object.entries(messages[locale])) {
        if (key.startsWith("g.")) expect(text, key).not.toMatch(/[▸◆]/);
      }
    }
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
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(getLocale()).toBe("en");
  });

  it("offers German and English on the phone", () => {
    const html = languageSelect("de");
    expect(html).toContain("Sprache");
    expect(html).toContain('<option value="de" selected>');
    expect(html.match(/<option/g)).toHaveLength(2);
  });
});

/** A LUMEN status with everything at its longest. */
function status(over: { licht?: number; zustand?: string; geste?: string; streak?: number; quest?: Record<string, unknown> | null; window?: Record<string, unknown> | null } = {}): LumenStatus {
  return parseStatus({
    kreatur: { licht: over.licht ?? 95, zustand: over.zustand ?? "leuchtet", geste: over.geste ?? "kreist unermüdlich und strahlend im allerletzten Abendlicht über dem See", streak: over.streak ?? 365 },
    quest: over.quest === null ? null : {
      id: 7, titel: "Bird's Eye Pattern",
      aufgabe: "Finde ein wiederkehrendes Muster von oben, zum Beispiel einen Acker, einen Parkplatz oder ein Dach, und fotografiere es so, dass es das Bild füllt.",
      medium: "video", dauer_min: 120, ...over.quest,
    },
    ...(over.window === null ? {} : { naechstes_lichtfenster: { art: "golden_frueh", in_minuten: 1439, ...over.window } }),
  });
}

function screens(locale: Locale): LumenView[] {
  const base: Omit<ViewOptions, "phase"> = { result: null, error: null, locale };
  const idle: ViewOptions = { ...base, phase: "idle" };
  const views: LumenView[] = [];
  // Not configured, unreachable, any client error and a raw technical one.
  for (const key of Object.keys(messages.en).filter((name) => name.startsWith("g.err."))) {
    views.push(buildView(null, { ...idle, error: messages.en[key] ?? "" }));
  }
  views.push(buildView(null, { ...idle, error: "HTTP 500" }));
  views.push(buildView(status(), { ...idle, error: "NetworkError when attempting to fetch resource xyz" }));
  // Loading.
  views.push(buildView(null, idle));
  // Every moth state, with and without a quest, short and long footers.
  for (const [licht, zustand] of [[95, "leuchtet"], [60, "wach"], [40, "matt"], [20, "schläfrig"], [0, "eingerollt"]] as const) {
    views.push(buildView(status({ licht, zustand }), idle));
    views.push(buildView(status({ licht, zustand, quest: null }), idle));
    views.push(buildView(status({ licht, zustand, quest: { medium: "foto", dauer_min: 5 }, streak: 1, window: { art: "blau", in_minuten: 0 } }), idle));
    views.push(buildView(status({ licht, zustand, streak: 0, window: null }), idle));
  }
  // Camera, upload and both outcomes.
  views.push(buildView(status(), { ...base, phase: "shooting" }));
  views.push(buildView(status(), { ...base, phase: "submitting" }));
  views.push(buildView(status(), { ...base, phase: "result", result: { ok: true, text: "" } }));
  views.push(buildView(status(), { ...base, phase: "result", result: { ok: false, text: "LUMEN timed out" } }));
  views.push(buildView(status(), { ...base, phase: "result", result: { ok: false, text: "Foto passt nicht zur Aufgabe ".repeat(8) } }));
  return views;
}

describe("glasses text budget", () => {
  for (const locale of ["de", "en"] as const) {
    it(`fits every ${locale} screen: ${MAX_BODY_ROWS} rows of ${BODY_COLS} beside the pixel moth, ${LINE_COLS} for header and footer`, () => {
      for (const view of screens(locale)) {
        expect(view.header.length, view.header).toBeLessThanOrEqual(LINE_COLS);
        expect(view.footer.length, view.footer).toBeLessThanOrEqual(LINE_COLS);
        expect(view.body.length, view.body.join("|")).toBeLessThanOrEqual(MAX_BODY_ROWS);
        for (const line of view.body) expect(line.length, line).toBeLessThanOrEqual(BODY_COLS);
        expect([view.header, view.footer, ...view.body].join(" ")).not.toMatch(/[▸◆]/);
      }
    });
  }

  it("keeps the light window and the gesture hint in a normal German footer", () => {
    const view = buildView(status({ streak: 3, window: { art: "golden", in_minuten: 51 }, quest: { medium: "foto", dauer_min: 30 } }), { phase: "idle", result: null, error: null, locale: "de" });
    expect(view.footer).toContain("Gold in 51 min");
    expect(view.footer).toContain("Tippen = Foto");
  });

  it("speaks German on the glasses, with the app name untouched", () => {
    const de = { phase: "idle" as const, result: null, error: null, locale: "de" as const };
    const failed = buildView(null, { ...de, error: "LUMEN unreachable" });
    expect(failed.header).toBe("Lumen Glass");
    expect(failed.body[0]).toBe("LUMEN nicht erreichbar");
    expect(failed.body).toContain("Prüf die Adresse in der Handy-App.");
    expect(failed.footer).toBe("Tippen = nochmal");
    expect(buildView(null, de).header).toBe("Lumen Glass");
    expect(buildView(null, { ...de, error: "HTTP 500" }).body[0]).toBe("HTTP 500");
    expect(windowLabel("golden", 135, "de")).toBe("Gold in 2 h 15 min");
    expect(windowLabel("blau", 0, "de")).toBe("Blau jetzt");
    const ok = buildView(status(), { ...de, phase: "result", result: { ok: true, text: "" } });
    expect(ok.header).toBe("Angenommen");
    expect(ok.body.join(" ")).toContain("Gesendet.");
  });
});

describe("phone page", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("puts the language choice on top and speaks German", () => {
    let html = "";
    const root = { set innerHTML(value: string) { html = value; }, get innerHTML() { return html; }, querySelector: () => null };
    vi.stubGlobal("document", { getElementById: () => root });
    vi.stubGlobal("setInterval", () => 0);
    mountPhoneUi({ getData: () => ({ ...EMPTY_DATA, token: "abcdef" }), setData: async () => undefined, shoot: () => undefined, getStatus: () => null, getLocale: () => "de" });
    expect(html).toContain('<option value="de" selected>');
    expect(html.indexOf('id="language"')).toBeLessThan(html.indexOf("Nicht verbunden"));
    expect(html).toContain("Speichern");
    expect(html).toContain("gesetzt (6 Zeichen)");
    expect(html).not.toContain("abcdef");
    // The cookie sits under "Erweitert", not on the main page.
    expect(html.indexOf("<summary>Erweitert</summary>")).toBeLessThan(html.indexOf("Sitzungs-Cookie"));
  });
});

describe("switching language on the phone", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("rewrites the glasses right away, and remembers the choice", async () => {
    vi.useFakeTimers();
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } });
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("location", { search: "" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // LUMEN is down: the glasses show the unreachable screen.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));

    let html = "";
    let onLanguage: ((event: unknown) => void) | undefined;
    const select = { value: "en", addEventListener: (type: string, listener: (event: unknown) => void) => { if (type === "change") onLanguage = listener; } };
    const root = {
      set innerHTML(value: string) { html = value; }, get innerHTML() { return html; },
      querySelector: (selector: string) => (selector === "#language" ? select : null),
    };
    vi.stubGlobal("document", { getElementById: () => root, documentElement: { lang: "" } });

    let handler: ((event: unknown) => void) | undefined;
    const glasses = { header: "", body: "", footer: "" };
    const show = (id: number | undefined, content: string | undefined): void => {
      if (id === 1) glasses.header = content ?? "";
      if (id === 2) glasses.body = content ?? "";
      if (id === 3) glasses.footer = content ?? "";
    };
    harness.bridge = {
      getLocalStorage: async () => "",
      setLocalStorage: async () => true,
      rebuildPageContainer: async () => true,
      createStartUpPageContainer: async (page: { textObject?: { containerID?: number; content?: string }[] }) => {
        for (const part of page.textObject ?? []) show(part.containerID, part.content);
        return 0;
      },
      textContainerUpgrade: async (update: { containerID?: number; content?: string }) => { show(update.containerID, update.content); return true; },
      updateImageRawData: async () => 0,
      shutDownPageContainer: async () => false,
      onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
      onDeviceStatusChanged: () => () => undefined,
    };

    vi.resetModules();
    await import("../src/main");
    for (let i = 0; i < 100 && !handler; i++) await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    expect(glasses.body).toContain("LUMEN unreachable");
    expect(html).toContain("Not connected");
    expect(onLanguage).toBeDefined();

    select.value = "de";
    onLanguage?.({ target: select });
    await vi.advanceTimersByTimeAsync(10);

    expect(glasses.header).toBe("Lumen Glass");
    expect(glasses.body).toContain("LUMEN nicht erreichbar");
    expect(glasses.body).toContain("Prüf die Adresse in der Handy-App.");
    expect(glasses.footer).toBe("Tippen = nochmal");
    expect(html).toContain("Nicht verbunden");
    expect(stored.get("quietglass.locale")).toBe("de");
  });
});

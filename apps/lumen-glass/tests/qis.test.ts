import { afterEach, describe, expect, it, vi } from "vitest";
import { footer, GESTURE_WORDS } from "../src/glasses/footer";
import { BODY_COLS, HEADER_COLS, LINE_COLS, MAX_BODY_ROWS, buildView, type LumenView, type ViewOptions } from "../src/glasses/view";
import { locales, type Locale } from "../src/i18n";
import { messages } from "../src/messages";
import { parseStatus, type LumenStatus } from "../src/lumen/client";
import { mountPhoneUi } from "../src/ui/phone";
import { EMPTY_DATA } from "../src/storage/persist";

/**
 * QIS v1 (docs/BEDIENSTANDARD.md): header `LUMEN · state`, footer in the order
 * Tippen/Wischen/Halten/2× ending in back/exit, every row within the display
 * budget in German and English, plus the wording glossary.
 */

function status(over: { quest?: Record<string, unknown> | null; zustand?: string; window?: Record<string, unknown> | null } = {}): LumenStatus {
  return parseStatus({
    kreatur: { licht: 95, zustand: over.zustand ?? "leuchtet", geste: "kreist unermüdlich und strahlend im allerletzten Abendlicht über dem See", streak: 365 },
    quest: over.quest === null ? null : {
      id: 7, titel: "Bird's Eye Pattern", aufgabe: "Finde ein wiederkehrendes Muster von oben, zum Beispiel einen Acker, einen Parkplatz oder ein Dach.",
      medium: "video", dauer_min: 120, ...over.quest,
    },
    ...(over.window === null ? {} : { naechstes_lichtfenster: { art: "golden_frueh", in_minuten: 1439, ...over.window } }),
  });
}

function views(locale: Locale): { name: string; view: LumenView }[] {
  const base: Omit<ViewOptions, "phase"> = { result: null, error: null, locale };
  const idle: ViewOptions = { ...base, phase: "idle" };
  const out: { name: string; view: LumenView }[] = [];
  const add = (name: string, view: LumenView): void => { out.push({ name, view }); };
  add("idle", buildView(status(), idle));
  add("idle-no-quest", buildView(status({ quest: null }), idle));
  // The side menu variants (SIDE_MENU in main.ts) stay inside the same budget.
  add("idle-menu", buildView(status(), { ...idle, sideMenu: true }));
  add("idle-no-quest-menu", buildView(status({ quest: null }), { ...idle, sideMenu: true }));
  add("demo", buildView(status(), { ...idle, demo: true }));
  add("demo-no-quest", buildView(status({ quest: null }), { ...idle, demo: true }));
  add("idle-sleepy", buildView(status({ zustand: "eingerollt", window: null }), idle));
  add("armed", buildView(status(), { ...idle, confirmQuest: true }));
  add("shooting", buildView(status(), { ...base, phase: "shooting" }));
  add("submitting", buildView(status(), { ...base, phase: "submitting" }));
  add("accepted", buildView(status(), { ...base, phase: "result", result: { ok: true, text: "done" } }));
  add("rejected", buildView(status(), { ...base, phase: "result", result: { ok: false, text: "Foto passt nicht zur Aufgabe ".repeat(8) } }));
  add("connecting", buildView(null, idle));
  for (const key of Object.keys(messages.en).filter((name) => name.startsWith("g.err."))) add(key, buildView(null, { ...idle, error: messages.en[key] ?? "" }));
  add("error-raw", buildView(status(), { ...idle, error: "HTTP 500" }));
  add("help", buildView(status(), { ...idle, help: true }));
  add("help-error", buildView(null, { ...idle, error: "HTTP 500", help: true }));
  return out;
}

const order = (locale: Locale): string[] => [GESTURE_WORDS[locale].tap, GESTURE_WORDS[locale].swipe, GESTURE_WORDS[locale].hold, "2×"];

describe("QIS v1 on the glasses", () => {
  for (const locale of locales) {
    it(`${locale}: header names the app; header, footer and body fit`, () => {
      for (const { name, view } of views(locale)) {
        expect(view.header.startsWith("LUMEN · "), `${name}: ${view.header}`).toBe(true);
        expect(view.header.length, name).toBeLessThanOrEqual(HEADER_COLS);
        expect(view.footer.length, name).toBeLessThanOrEqual(LINE_COLS);
        expect(view.body.length, name).toBeLessThanOrEqual(MAX_BODY_ROWS);
        for (const row of view.body) expect(row.length, `${name}: ${row}`).toBeLessThanOrEqual(BODY_COLS);
      }
    });

    it(`${locale}: footers keep the gesture order and end in back, exit or cancel`, () => {
      const end = locale === "de" ? /2× = (zurück|Ende|abbrechen)$/ : /2× = (back|exit|cancel)$/;
      const armed = locale === "de" ? /^Nochmal tippen = / : /^Tap again = /;
      for (const { name, view } of views(locale)) {
        // While the photo is on its way no gesture is offered at all.
        if (name === "submitting") { expect(view.footer).toBe(""); continue; }
        expect(view.footer, name).toMatch(end);
        if (armed.test(view.footer)) continue;
        const positions = order(locale).map((word) => view.footer.indexOf(word)).filter((i) => i >= 0);
        expect(positions, `${name}: ${view.footer}`).toEqual([...positions].sort((a, b) => a - b));
        expect(view.footer.indexOf("2×"), name).toBeGreaterThanOrEqual(0);
      }
    });
  }

  it("the armed new quest says what the next tap does and how to cancel it", () => {
    const idle = { phase: "idle" as const, result: null, error: null, confirmQuest: true };
    const de = buildView(status(), { ...idle, locale: "de" });
    expect(de.header).toBe("LUMEN · Neue Quest?");
    expect(de.footer).toBe("Nochmal tippen = neue Quest · Wischen/2× = abbrechen");
    const en = buildView(status(), { ...idle, locale: "en" });
    expect(en.header).toBe("LUMEN · New quest?");
    expect(en.footer).toBe("Tap again = new quest · Swipe/2× = cancel");
  });

  it("the root footer ends in Ende / exit, subpages in zurück / back", () => {
    const de = Object.fromEntries(views("de").map(({ name, view }) => [name, view]));
    expect(de["idle"]?.footer).toBe("Tippen = Foto · Halten = Quest · 2× = Ende");
    expect(de["idle-no-quest"]?.footer).toBe("Wischen = Hilfe · Halten = Quest · 2× = Ende");
    expect(de["idle-menu"]?.footer).toBe("Tippen = Foto · Halten = Menü · 2× = Ende");
    expect(de["idle-no-quest-menu"]?.footer).toBe("Halten = Menü · 2× = Ende");
    expect(de["help"]?.footer).toBe("Tippen = zurück · 2× = zurück");
    expect(de["accepted"]?.footer).toBe("Tippen = weiter · 2× = zurück");
    const en = Object.fromEntries(views("en").map(({ name, view }) => [name, view]));
    expect(en["idle"]?.footer).toBe("Tap = photo · Swipe = help · Hold = quest · 2× = exit");
    expect(en["idle-menu"]?.footer).toBe("Tap = photo · Hold = menu · 2× = exit");
    expect(en["accepted"]?.footer).toBe("Tap = carry on · 2× = back");
  });

  it("the help page lists the gestures in footer order and what the app needs", () => {
    const help = buildView(status(), { phase: "idle", result: null, error: null, locale: "de", help: true });
    expect(help.header).toBe("LUMEN · Hilfe");
    expect(help.body.slice(0, 4).map((row) => row.split(" = ")[0])).toEqual(["Tippen", "Wischen", "Halten", "2×"]);
    // Without a side menu the help says what swipe and hold do.
    expect(help.body[1]).toContain("Hilfe");
    expect(help.body[2]).toContain("Quest");
    expect(help.body.at(-1)).toContain("Braucht:");
  });

  it("QIS v1.2 no. 7: the demo says in one line how to connect and still fits", () => {
    const de = buildView(status(), { phase: "idle", result: null, error: null, locale: "de", demo: true });
    expect(de.body).toContain("Demo · Verbindung am Handy einrichten");
    expect(de.body.length).toBeLessThanOrEqual(MAX_BODY_ROWS);
    const en = buildView(status(), { phase: "idle", result: null, error: null, locale: "en", demo: true });
    expect(en.body).toContain("Demo · set up the connection on your phone");
    expect(buildView(status(), { phase: "idle", result: null, error: null, locale: "de" }).body.join("\n")).not.toContain("Demo");
  });

  it("keeps the light window and the streak on the display, in the body", () => {
    const view = buildView(status(), { phase: "idle", result: null, error: null, locale: "de" });
    expect(view.body.at(-1)).toMatch(/Gold in/);
    expect(view.footer).not.toMatch(/Gold|Tage/);
  });

  it("drops the swipe part first when the row would be too wide, never the 2×", () => {
    expect(footer("de", { tap: "Foto", swipe: "Hilfe", hold: "neue Quest holen" }, "exit")).toBe("Tippen = Foto · Halten = neue Quest holen · 2× = Ende");
    expect(footer("de", { tap: "Foto", swipe: "Hilfe", hold: "Quest" }, "exit")).toBe("Tippen = Foto · Halten = Quest · 2× = Ende");
  });

  it("uses the glossary: German has no Tap, Wisch, 2x or Doppeltipp; English no 2x, Double tap", () => {
    const glasses = (locale: Locale): string => [
      ...Object.entries(messages[locale]).filter(([key]) => /^(g\.|p\.(tap|hold|swipe|doubleTap))/.test(key)).map(([, text]) => text),
      ...views(locale).flatMap(({ view }) => [view.header, view.footer, ...view.body]),
    ].join("\n");
    expect(glasses("de")).not.toMatch(/\bTap\b|\bWisch\b|\b2x\b|Doppeltipp/);
    expect(glasses("en")).not.toMatch(/\b2x\b|Double tap|Doppeltipp/);
  });
});

describe("QIS v1 on the phone", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("QIS v1.2: the demo says so on the phone, and the last technical message sits on More", () => {
    let html = "";
    const root = { set innerHTML(value: string) { html = value; }, get innerHTML() { return html; }, querySelector: () => null, querySelectorAll: () => [] };
    vi.stubGlobal("document", { getElementById: () => root });
    vi.stubGlobal("setInterval", () => 0);
    mountPhoneUi({ getData: () => EMPTY_DATA, setData: async () => undefined, shoot: () => undefined, getStatus: () => null, getLocale: () => "de", isDemo: () => true, getLastError: () => "HTTP 500" });
    expect(html).toContain("Demo mit Beispieldaten");
    expect(html).toContain("HTTP 500");
    expect(html.slice(html.indexOf('data-tab="more"'))).toContain("HTTP 500");
  });

  it("has the tabs Moth, Glasses, Connection, More in that order, with the invert switch on Glasses", () => {
    let html = "";
    const root = { set innerHTML(value: string) { html = value; }, get innerHTML() { return html; }, querySelector: () => null, querySelectorAll: () => [] };
    vi.stubGlobal("document", { getElementById: () => root });
    vi.stubGlobal("setInterval", () => 0);
    mountPhoneUi({ getData: () => EMPTY_DATA, setData: async () => undefined, shoot: () => undefined, getStatus: () => null, getLocale: () => "de" });
    expect([...html.matchAll(/data-tab-go="(\w+)"/g)].map((m) => m[1])).toEqual(["moth", "glasses", "lumen", "more"]);
    expect([...html.matchAll(/<\/span>([^<]+)<\/button>/g)].map((m) => m[1])).toEqual(["Motte", "Brille", "Verbindung", "Mehr"]);
    const glasses = html.slice(html.indexOf('data-tab="glasses"'), html.indexOf('data-tab="lumen"'));
    expect(glasses).toContain('id="invert"');
    expect(html.slice(html.indexOf('data-tab="lumen"'))).not.toContain('id="invert"');
  });
});

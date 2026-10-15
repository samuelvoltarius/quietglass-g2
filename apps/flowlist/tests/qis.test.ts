import { describe, expect, it } from "vitest";
import { buildView, FOOTER_WIDTH, HEADER_TEXT_WIDTH, MAX_BODY_ROWS, type FlowView } from "../src/glasses/view";
import { footer, GESTURE_WORDS, ROW_WIDTH } from "../src/glasses/footer";
import { complete, moveChoice, startRun } from "../src/checklist/run";
import type { Checklist, Step } from "../src/checklist/model";
import { locales, type Locale } from "../src/i18n";
import { messages } from "../src/messages";

/**
 * QIS v1 (docs/BEDIENSTANDARD.md): header `FLOWLIST · state`, footer in the order
 * Tippen/Wischen/Halten/2× ending in back/exit, every row within the display
 * budget in German and English, plus the wording glossary.
 */

const step = (id: string, over: Partial<Step> = {}): Step => ({ id, text: "step " + id, kind: "normal", ...over });
const list = (...steps: Step[]): Checklist => ({ id: "l1", title: "L", steps });

const WORST_TEXT = "Ein sehr langer Schritt mit vielen Worten und einer Zusatzinformation die kaum ein Ende nimmt";

function views(locale: Locale): { name: string; view: FlowView }[] {
  const out: { name: string; view: FlowView }[] = [];
  const add = (name: string, view: FlowView): void => { out.push({ name, view }); };
  const plain = list(step("a", { text: WORST_TEXT }), step("b"));
  const detailed = list(step("a", { detail: "engine must be cold" }), step("b"));
  const optional = list(step("a", { kind: "optional" }), step("b"));
  const critical = list(step("a", { kind: "critical" }), step("b"));
  const choice = list(step("q", { kind: "choice", choices: [{ label: "Yes" }, { label: "No" }] }), step("after"));
  const empty = list();
  const one = list(step("a"));
  const o = { locale, showNext: true } as const;
  add("plain", buildView(plain, startRun(plain, 0), o, 999_000));
  add("plain-late", buildView(plain, startRun(plain, 0), o, 5_999_000));
  add("detail", buildView(detailed, startRun(detailed, 0), o, 0));
  add("detail-open", buildView(detailed, startRun(detailed, 0), { ...o, showDetail: true }, 0));
  add("optional", buildView(optional, startRun(optional, 0), o, 0));
  add("optional-armed", buildView(optional, startRun(optional, 0), { ...o, armed: "skip" }, 0));
  add("back-armed", buildView(plain, complete(plain, startRun(plain, 0)), { ...o, armed: "back" }, 0));
  add("finished-back-armed", buildView(list(step("a")), complete(list(step("a")), startRun(list(step("a")), 0), "done", 65_000), { ...o, armed: "back" }, 65_000));
  add("critical-confirm", buildView(critical, complete(critical, startRun(critical, 0)), o, 0));
  add("choice", buildView(choice, startRun(choice, 0), o, 0));
  add("choice-2", buildView(choice, moveChoice(choice, startRun(choice, 0), 1), o, 0));
  add("empty", buildView(empty, startRun(empty, 0), o, 0));
  const done = complete(one, startRun(one, 0), "done", 65_000);
  add("finished", buildView(one, done, o, 65_000));
  add("finished-armed", buildView(one, done, { ...o, armed: "restart" }, 65_000));
  add("help", buildView(plain, startRun(plain, 0), { ...o, help: true }, 0));
  add("help-empty", buildView(empty, startRun(empty, 0), { ...o, help: true }, 0));
  // The side menu variants (SIDE_MENU in main.ts) stay inside the same budget.
  const m = { ...o, sideMenu: true } as const;
  add("plain-menu", buildView(plain, startRun(plain, 0), m, 999_000));
  add("optional-menu", buildView(optional, startRun(optional, 0), m, 0));
  add("choice-menu", buildView(choice, startRun(choice, 0), m, 0));
  add("empty-menu", buildView(empty, startRun(empty, 0), m, 0));
  add("finished-menu", buildView(one, done, m, 65_000));
  return out;
}

const order = (locale: Locale): string[] => [GESTURE_WORDS[locale].tap, GESTURE_WORDS[locale].swipe, GESTURE_WORDS[locale].hold, "2×"];

describe("QIS v1 on the glasses", () => {
  for (const locale of locales) {
    it(`${locale}: header names the app, header and footer fit, the body keeps its rows`, () => {
      for (const { name, view } of views(locale)) {
        expect(view.header.startsWith("FLOWLIST · "), name).toBe(true);
        expect(view.header.length, name + " header").toBeLessThanOrEqual(HEADER_TEXT_WIDTH);
        expect(view.footer.length, name + " footer").toBeLessThanOrEqual(FOOTER_WIDTH);
        expect(view.footer.length, name + " footer").toBeLessThanOrEqual(ROW_WIDTH);
        expect(view.body.length, name).toBeLessThanOrEqual(MAX_BODY_ROWS);
        for (const row of view.body) expect(row.length, name + ": " + row).toBeLessThanOrEqual(ROW_WIDTH);
      }
    });

    it(`${locale}: footers keep the gesture order and end in back, exit or cancel`, () => {
      const end = locale === "de" ? /2× = (zurück|Ende|abbrechen)$/ : /2× = (back|exit|cancel)$/;
      for (const { name, view } of views(locale)) {
        expect(view.footer, name).toMatch(end);
        const body = view.footer.replace(/^\d+:\d\d · /, "");
        if (/^(Nochmal tippen|Tap again)/.test(body)) continue;
        const positions = order(locale).map((word) => body.indexOf(word)).filter((i) => i >= 0);
        expect(positions, name + ": " + view.footer).toEqual([...positions].sort((a, b) => a - b));
        expect(body.indexOf("2×"), name).toBeGreaterThanOrEqual(0);
      }
    });
  }

  it("arms before it skips or starts over, and says so in the footer", () => {
    const byName = Object.fromEntries(views("de").map(({ name, view }) => [name, view]));
    expect(byName["optional-armed"]?.footer).toBe("Nochmal tippen = auslassen · Wischen/2× = abbrechen");
    expect(byName["optional-armed"]?.header).toBe("FLOWLIST · Auslassen?");
    expect(byName["finished-armed"]?.footer).toBe("Nochmal tippen = neu starten · Wischen/2× = abbrechen");
    expect(byName["critical-confirm"]?.footer).toBe("Nochmal tippen = bestätigen · Wischen/2× = abbrechen");
    const en = Object.fromEntries(views("en").map(({ name, view }) => [name, view]));
    expect(en["optional-armed"]?.footer).toBe("Tap again = skip · Swipe/2× = cancel");
  });

  it("the root footer ends in Ende / exit, the help footer in zurück / back", () => {
    const de = Object.fromEntries(views("de").map(({ name, view }) => [name, view]));
    expect(de["plain"]?.footer.endsWith("2× = Ende")).toBe(true);
    expect(de["help"]?.footer).toBe("Tippen = zurück · 2× = zurück");
    expect(de["empty"]?.footer).toBe("Halten = Hilfe · 2× = Ende");
    expect(de["plain"]?.footer).toContain("Halten = Hilfe");
    expect(de["empty-menu"]?.footer).toBe("Halten = Menü · 2× = Ende");
    expect(de["plain-menu"]?.footer).toContain("Halten = Menü");
    const en = Object.fromEntries(views("en").map(({ name, view }) => [name, view]));
    expect(en["help"]?.footer).toBe("Tap = back · 2× = back");
  });

  it("the help page lists the gestures in footer order and what the app needs", () => {
    const help = views("de").find(({ name }) => name === "help")!.view;
    expect(help.header).toBe("FLOWLIST · Hilfe");
    expect(help.body.map((row) => row.split(" = ")[0])).toEqual(["Tippen", "Wischen", "Halten", "2×"]);
    // Without a side menu the help names what swipe and hold do.
    expect(help.body[1]).toMatch(/zurück/);
    expect(help.body[1]).toMatch(/auslassen/);
    expect(help.body[2]).toContain("Info");
    expect(help.headline).toBe("Braucht nur das Handy");
  });

  it("drops the elapsed time first, then the swipe part, never the 2×", () => {
    const wide = footer("de", { tap: "erledigt", swipe: "zurück/auslassen", hold: "Menü" }, "exit", "12:34");
    expect(wide.length).toBeLessThanOrEqual(ROW_WIDTH);
    expect(wide.endsWith("2× = Ende")).toBe(true);
    expect(wide).not.toContain("Wischen");
    expect(footer("de", { tap: "erledigt", hold: "Menü" }, "exit", "12:34")).toBe("12:34 · Tippen = erledigt · Halten = Menü · 2× = Ende");
  });

  it("uses the glossary on the glasses: German has no Tap, Wisch, 2x or Doppeltipp; English no 2x, Double tap", () => {
    const glasses = (locale: Locale): string => [
      ...Object.entries(messages[locale]).filter(([key]) => key.startsWith("g.")).map(([, text]) => text),
      ...views(locale).flatMap(({ view }) => [view.header, view.footer, view.headline, ...view.body]),
    ].join("\n");
    expect(glasses("de")).not.toMatch(/\bTap\b|\bWisch\b|\b2x\b|Doppeltipp/);
    expect(glasses("en")).not.toMatch(/\b2x\b|Double tap|Doppeltipp/);
    const phone = (locale: Locale): string => Object.entries(messages[locale]).filter(([key]) => key.startsWith("p.key")).map(([, text]) => text).join("\n");
    expect(phone("de")).not.toMatch(/Doppeltipp|\b2x\b/);
    expect(phone("en")).not.toMatch(/Double tap|\b2x\b/);
  });
});

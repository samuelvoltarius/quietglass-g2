import { describe, expect, it } from "vitest";
import { locales, type Locale } from "../src/i18n";
import { footer, FOOTER_WIDTH } from "../src/glasses/footer";
import { buildActionsView, availableActions } from "../src/glasses/actions-view";
import { LINE_WIDTH, problemsView, startView } from "../src/glasses/view";
import { cockpitHint } from "../src/cockpit/model";
import { applyReport, createSource, problems } from "../src/monitor/dashboard";

// QIS v1: footer order Tippen -> Wischen -> Halten -> 2x, ending 2x = zurueck / Ende, one row wide.
// QUS v1: header "Titel · ● live" on every text page.
const NOW = 1_000_000;
const host = (id: string) => applyReport(createSource(id, id), {
  name: id,
  metrics: [{ id: "cpu", label: "CPU", value: 96, unit: "%", warn: 85, critical: 95 }],
  actions: [{ id: "x", label: "Do it", confirm: true }],
}, NOW);

function screens(locale: Locale): { name: string; view: { header: string; footer: string }; end: "back" | "exit" }[] {
  const one = [host("a")];
  const two = [host("a"), host("b")];
  const actions = availableActions(one);
  const base = { cursor: 0, pendingId: null, result: null, busy: false, locale };
  const startOptions = { locale, demo: false, problemCount: problems(two, NOW).length, actionCount: actions.length };
  return [
    { name: "start", view: startView(two, 1, NOW, startOptions), end: "exit" },
    { name: "start demo", view: startView(two, 0, NOW, { ...startOptions, demo: true }), end: "exit" },
    { name: "start empty", view: startView([], 0, NOW, { ...startOptions, problemCount: 0, actionCount: 0 }), end: "exit" },
    { name: "problems", view: problemsView(two, problems(two, NOW), 0, NOW, { locale, demo: false, armed: false }), end: "back" },
    { name: "problems armed", view: problemsView(two, problems(two, NOW), 0, NOW, { locale, demo: false, armed: true }), end: "back" },
    { name: "problems none", view: problemsView([], [], 0, NOW, { locale, demo: false, armed: false }), end: "back" },
    { name: "actions", view: buildActionsView(actions, base), end: "back" },
    { name: "actions none", view: buildActionsView([], base), end: "back" },
    { name: "cockpit hint", view: { header: "Status · ● live", footer: cockpitHint(locale, 3) }, end: "back" },
    { name: "cockpit hint single", view: { header: "Status · ● live", footer: cockpitHint(locale, 1) }, end: "back" },
  ];
}

describe("footers follow QIS v1", () => {
  for (const locale of locales) {
    it(`keeps header and footer inside one row in ${locale}`, () => {
      for (const { name, view } of screens(locale)) {
        expect(view.footer.length, name + ": " + view.footer).toBeLessThanOrEqual(LINE_WIDTH);
        expect(view.header.length, name + ": " + view.header).toBeLessThanOrEqual(LINE_WIDTH);
      }
    });

    it(`ends every ${locale} footer in 2× = back/exit (armed ones say cancel) and keeps the gesture order`, () => {
      const words = locale === "de" ? ["Tippen", "Wischen", "Halten"] : ["Tap", "Swipe", "Hold"];
      const end = locale === "de" ? { back: "2× = zurück", exit: "2× = Ende" } : { back: "2× = back", exit: "2× = exit" };
      for (const { name, view, end: kind } of screens(locale)) {
        if (name === "problems armed") { expect(view.footer).toMatch(/abbrechen|cancel/); continue; }
        expect(view.footer.endsWith(end[kind]), name + ": " + view.footer).toBe(true);
        const positions = words.map((word) => view.footer.indexOf(word + " = ")).filter((p) => p >= 0);
        expect(positions, name).toEqual([...positions].sort((a, b) => a - b));
      }
    });
  }

  it("every text page header is `Titel · ● live` (or the state as a word)", () => {
    for (const { name, view } of screens("de")) {
      if (name.startsWith("cockpit")) continue;
      expect(view.header, name).toMatch(/^(Status|Probleme|Aktionen) · (● live|offline|Demo)$/);
    }
  });

  it("uses the German glossary: no Tap, Wisch or 2x in German footers", () => {
    for (const { name, view } of screens("de")) {
      expect(view.footer, name).not.toMatch(/\bTap\b|\bWisch\b|2x/);
    }
  });

  it("drops the swipe hint, never the way out, when a footer would be too long", () => {
    const long = footer("de", { tap: "Details öffnen", swipe: "Rechner", hold: "Menü" }, "exit");
    expect(long.length).toBeLessThanOrEqual(FOOTER_WIDTH);
    expect(long.endsWith("2× = Ende")).toBe(true);
    expect(long).not.toContain("Wischen");
  });

  it("the cockpit hint names the swipe only when there is more than one page", () => {
    expect(cockpitHint("de", 3)).toBe("Tippen = neu laden · Wischen = Server · 2× = zurück");
    expect(cockpitHint("de", 1)).toBe("Tippen = neu laden · 2× = zurück");
    expect(cockpitHint("en", 3)).toBe("Tap = reload · Swipe = server · 2× = back");
  });
});

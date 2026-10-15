import { describe, expect, it } from "vitest";
import { locales, type Locale } from "../src/i18n";
import { footer, FOOTER_WIDTH } from "../src/glasses/footer";
import { buildHelpView } from "../src/glasses/help-view";
import { buildActionsView, availableActions } from "../src/glasses/actions-view";
import { detailPage } from "../src/glasses/detail";
import { fleetRows, fleetView } from "../src/glasses/fleet";
import { buildView, LINE_WIDTH } from "../src/glasses/view";
import { MetricHistory } from "../src/monitor/history";
import { applyReport, createSource } from "../src/monitor/dashboard";

// QIS v1: footer order Tippen -> Wischen -> Halten -> 2x, ending 2x = zurueck / Ende, one row wide.
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
  return [
    { name: "root list", view: buildView(one, { locale }, NOW), end: "exit" },
    { name: "root empty", view: buildView([], { locale }, NOW), end: "exit" },
    { name: "root ok", view: buildView([applyReport(createSource("o", "o"), { name: "o", metrics: [] }, NOW)], { locale }, NOW), end: "exit" },
    { name: "fleet", view: fleetView(two, fleetRows(two, new MetricHistory(), 0, locale, NOW), locale, NOW), end: "exit" },
    { name: "detail", view: detailPage(host("a"), 0, locale, NOW).view, end: "back" },
    { name: "menu", view: buildActionsView(actions, base), end: "back" },
    { name: "menu help row", view: buildActionsView(actions, { ...base, cursor: 2 }), end: "back" },
    { name: "help", view: buildHelpView(locale), end: "back" },
  ];
}

describe("footers follow QIS v1", () => {
  for (const locale of locales) {
    it(`keeps header and footer inside one row in ${locale}`, () => {
      for (const { name, view } of screens(locale)) {
        expect(view.footer.length, name + ": " + view.footer).toBeLessThanOrEqual(LINE_WIDTH);
        expect(view.header.length, name + ": " + view.header).toBeLessThanOrEqual(LINE_WIDTH);
        expect(view.header.startsWith("STATUS"), name + ": " + view.header).toBe(true);
      }
    });

    it(`ends every ${locale} footer in 2× = back/exit and keeps the gesture order`, () => {
      const words = locale === "de" ? ["Tippen", "Wischen", "Halten"] : ["Tap", "Swipe", "Hold"];
      const end = locale === "de" ? { back: "2× = zurück", exit: "2× = Ende" } : { back: "2× = back", exit: "2× = exit" };
      for (const { name, view, end: kind } of screens(locale)) {
        expect(view.footer.endsWith(end[kind]), name + ": " + view.footer).toBe(true);
        const positions = words.map((word) => view.footer.indexOf(word + " = ")).filter((p) => p >= 0);
        expect(positions, name).toEqual([...positions].sort((a, b) => a - b));
      }
    });
  }

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
});

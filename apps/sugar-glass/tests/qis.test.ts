import { describe, expect, it } from "vitest";
import { buildView, HEADER_WIDTH, PAGES, ROW_WIDTH, type Connection, type PageView, type ViewState } from "../src/glasses/views";
import { demoPump, demoReadings, demoTreatments, DEMO_SCENES } from "../src/ns/demo";
import { DEFAULT_LIMITS } from "../src/ns/alerts";
import { locales, type Locale } from "../src/i18n";
import { messages } from "../src/messages";

/**
 * QIS v1 (docs/BEDIENSTANDARD.md): header `SUGARGLASS · state`, footer in the order
 * Tippen/Wischen/Halten/2x ending in back/exit, everything within the row width in
 * German and English, plus the wording glossary. Sugar Glass has no destructive
 * gesture: tap only refreshes, swipe only turns the page.
 */

const NOW = Date.parse("2026-10-13T12:02:30Z");

function state(over: Partial<ViewState>): ViewState {
  return {
    locale: "de", demo: false, connection: { kind: "ok" },
    data: { readings: demoReadings("normal", NOW), pump: demoPump("normal", NOW), treatments: demoTreatments(NOW) },
    page: "glucose", help: false, unit: "mgdl", limits: DEFAULT_LIMITS, now: NOW, ...over,
  };
}

function allViews(locale: Locale): { name: string; view: PageView }[] {
  const out: { name: string; view: PageView }[] = [];
  for (const scene of DEMO_SCENES) for (const page of PAGES) for (const demo of [false, true]) {
    const data = { readings: demoReadings(scene, NOW), pump: demoPump(scene, NOW), treatments: demoTreatments(NOW) };
    for (const tick of [0, 600]) out.push({ name: `${scene}-${page}-${demo}-${tick}`, view: buildView(state({ locale, page, demo, data, now: NOW + tick })) });
  }
  out.push({ name: "no-pump", view: buildView(state({ locale, page: "pump", data: { readings: demoReadings("normal", NOW), pump: null, treatments: demoTreatments(NOW) } })) });
  for (const connection of [{ kind: "setup" }, { kind: "loading" }, { kind: "error", code: "http", status: 503 }] as Connection[]) {
    out.push({ name: "plain-" + connection.kind, view: buildView(state({ locale, connection, data: null })) });
  }
  out.push({ name: "help", view: buildView(state({ locale, help: true })) });
  return out;
}

const order = (locale: Locale): string[] => (locale === "de" ? ["Tippen", "Wischen", "Halten", "2×"] : ["Tap", "Swipe", "Hold", "2×"]);

describe("QIS v1 on the glasses", () => {
  for (const locale of locales) {
    it(`${locale}: header names the app, footer keeps the order and fits, 2× is never dropped`, () => {
      const end = locale === "de" ? /2× = (zurück|Ende)$/ : /2× = (back|exit)$/;
      for (const { name, view } of allViews(locale)) {
        expect(view.header.length, name).toBeLessThanOrEqual(HEADER_WIDTH);
        // The app name leads; only a long alert line may give it up, and nothing is cut with an
        // ellipsis (the loading state itself says "verbinde …").
        if (name !== "plain-loading") expect(view.header.endsWith("…"), name).toBe(false);
        else expect(view.header.startsWith("SUGARGLASS · ")).toBe(true);
        expect(view.footer.length, name).toBeLessThanOrEqual(ROW_WIDTH);
        expect(view.footer, name).toMatch(end);
        const positions = order(locale).map((word) => view.footer.indexOf(word)).filter((i) => i >= 0);
        expect(positions, name + ": " + view.footer).toEqual([...positions].sort((a, b) => a - b));
      }
    });

    it(`${locale}: the help page is back-only, the other pages say Hold = help`, () => {
      const rows = allViews(locale);
      const help = rows.find((r) => r.name === "help")!.view;
      expect(help.footer).toBe(locale === "de" ? "2× = zurück" : "2× = back");
      expect(help.body.filter(Boolean).length).toBeGreaterThanOrEqual(5);
      for (const { name, view } of rows) {
        if (name === "help" || name === "plain-setup") continue;
        expect(view.footer, name).toContain(locale === "de" ? "Halten = Hilfe" : "Hold = help");
      }
    });
  }

  it("the root footer drops the swipe (too wide) but keeps Hold and 2× = Ende", () => {
    expect(buildView(state({})).footer).toBe("1/2 · Tippen = neu laden · Halten = Hilfe · 2× = Ende");
    expect(buildView(state({ locale: "en", page: "pump" })).footer).toBe("2/2 · Tap = refresh · Hold = help · 2× = exit");
  });

  it("QIS v1.2: the first-start demo shows the hint line on the value and the pump page, within the row width, information only", () => {
    for (const locale of locales) {
      const hint = locale === "de" ? "Demo · Verbindung am Handy einrichten" : "Demo · set up connection on phone";
      for (const page of PAGES) {
        const view = buildView(state({ locale, page, demoHint: true }));
        expect(view.body, `${locale} ${page}`).toContain(hint);
        for (const row of view.body) expect(row.length, row).toBeLessThanOrEqual(ROW_WIDTH);
        expect(view.header, view.header).toContain("DEMO");
      }
      // The information-only notice stays on the pump page.
      expect(buildView(state({ locale, page: "pump", demoHint: true })).body.at(-1)).toBe(messages[locale]!["g.pump.notice"]);
      expect(buildView(state({ locale })).body.join(" ")).not.toContain("Demo ·");
    }
  });

  it("QIS v1.2: the glasses never show a status code for a failed server", () => {
    for (const locale of locales) {
      const connection: Connection = { kind: "error", code: "http", status: 503 };
      for (const data of [null, state({}).data]) {
        const view = buildView(state({ locale, connection, data }));
        expect(view.body.join(" ") + view.header + view.footer, `${locale} ${data === null ? "no data" : "data"}`).not.toMatch(/HTTP|503/);
      }
    }
  });

  it("QIS v1.2: side menu labels fit 32 bytes in both languages", () => {
    for (const locale of locales) for (const key of ["m.help", "m.refresh", "m.swipeNormal", "m.swipeInverted"]) {
      expect(new TextEncoder().encode(messages[locale]![key] ?? "").length, `${locale} ${key}`).toBeLessThanOrEqual(32);
    }
  });

  it("uses the glossary: German has no Tap, Wisch, 2x or Doppeltipp; English has no 2x or Double tap", () => {
    const glasses = (locale: Locale): string =>
      Object.entries(messages[locale]).filter(([key]) => /^(g|p\.c)\./.test(key)).map(([, text]) => text).join("\n");
    expect(glasses("de")).not.toMatch(/\bTap\b|\bWisch\b|\b2x\b|Doppeltipp/);
    expect(glasses("en")).not.toMatch(/\b2x\b|Double tap|Doppeltipp/);
  });
});

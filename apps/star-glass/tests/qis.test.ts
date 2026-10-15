import { describe, expect, it } from "vitest";
import { locales, type Locale } from "../src/i18n";
import { messages } from "../src/messages";
import { createDemoNina, type DemoScene } from "../src/nina/demo";
import type { StarStatus } from "../src/nina/status";
import { HEADER_WIDTH, PAGES, ROW_WIDTH, buildView, type Connection, type PageView, type ViewState } from "../src/glasses/views";

/**
 * QIS v1 (docs/BEDIENSTANDARD.md): header `STARGLASS · state`, footer in the order
 * Tippen/Wischen/Halten/2x ending in back/exit, every row within the width in German
 * and English, the arm-and-confirm footer for stopping/resuming, plus the glossary.
 */

const state = (status: StarStatus | null, over: Partial<ViewState> = {}): ViewState => ({
  locale: "de", demo: false, connection: { kind: "ok" }, status, ageSeconds: 0, page: "overview", screen: "pages",
  cursor: 0, armed: null, sending: false, message: "", hasPreview: false, now: 1_000_000, ...over,
});
const demo = async (scene: DemoScene = "run"): Promise<StarStatus> => createDemoNina(() => 0, scene).status();

async function allViews(locale: Locale): Promise<{ name: string; view: PageView }[]> {
  const out: { name: string; view: PageView }[] = [];
  const statuses: [string, StarStatus | null][] = [["none", null], ["run", await demo()], ["lost", await demo("lost")], ["done", await demo("done")]];
  const connections: Connection[] = [{ kind: "setup" }, { kind: "loading" }, { kind: "ok" }, { kind: "error", code: "http", status: 503 }];
  for (const connection of connections) for (const [label, status] of statuses) for (const page of PAGES) {
    for (const demoMode of [false, true]) {
      out.push({ name: `${connection.kind}-${label}-${page}-${demoMode}`, view: buildView(state(status, { locale, connection, page, demo: demoMode, ageSeconds: 99 })) });
    }
  }
  const run = await demo();
  for (const armed of [null, "stop", "start"] as const) for (const sending of [false, true]) {
    out.push({ name: `control-${armed}-${sending}`, view: buildView(state(run, { locale, screen: "control", armed, sending })) });
  }
  out.push({ name: "help", view: buildView(state(run, { locale, screen: "help" })) });
  return out;
}

const order = (locale: Locale): string[] => (locale === "de" ? ["Tippen", "Wischen", "Halten", "2×"] : ["Tap", "Swipe", "Hold", "2×"]);

describe("QIS v1 on the glasses", () => {
  for (const locale of locales) {
    it(`${locale}: header, footer and rows fit; footers keep the gesture order and end in back, exit or cancel`, async () => {
      const end = locale === "de" ? /2× = (zurück|Ende|abbrechen)$/ : /2× = (back|exit|cancel)$/;
      for (const { name, view } of await allViews(locale)) {
        expect(view.header.length, name + ": " + view.header).toBeLessThanOrEqual(HEADER_WIDTH);
        expect(view.footer.length, name + ": " + view.footer).toBeLessThanOrEqual(ROW_WIDTH);
        expect(view.footer, name).toMatch(end);
        const positions = order(locale).map((word) => view.footer.indexOf(word)).filter((i) => i >= 0);
        expect(positions, name + ": " + view.footer).toEqual([...positions].sort((a, b) => a - b));
        // The app name leads, unless a warning needs the whole header.
        if (!view.header.startsWith("STARGLASS · ")) expect(/^[!A-Za-zÄÖÜ]/.test(view.header), name).toBe(true);
      }
    });
  }

  it("normal page headers name the app first", async () => {
    for (const locale of locales) {
      const view = buildView(state(await demo(), { locale }));
      expect(view.header.startsWith("STARGLASS · ")).toBe(true);
    }
  });

  it("stopping and resuming are armed: tap arms, the footer says so, 2× and swipe cancel", async () => {
    const run = await demo();
    const idle = buildView(state(run, { screen: "control" }));
    expect(idle.footer).toBe("Tippen = anwählen · Wischen = Zeile · 2× = zurück");
    const armed = buildView(state(run, { screen: "control", armed: "stop" }));
    expect(armed.footer).toBe("Nochmal tippen = anhalten · Wischen/2× = abbrechen");
    expect(buildView(state(run, { screen: "control", armed: "stop", locale: "en" })).footer).toBe("Tap again = stop · Swipe/2× = cancel");
    expect(buildView(state(run, { screen: "control", armed: "start" })).footer).toBe("Nochmal tippen = fortsetzen · Wischen/2× = abbrechen");
  });

  it("help is a page of its own: back only, five lines of gestures", async () => {
    for (const locale of locales) {
      const help = buildView(state(await demo(), { locale, screen: "help" }));
      expect(help.footer).toBe(locale === "de" ? "2× = zurück" : "2× = back");
      expect(help.header).toBe(locale === "de" ? "STARGLASS · Hilfe" : "STARGLASS · help");
      expect(help.body.filter(Boolean).length).toBeGreaterThanOrEqual(5);
      const page = buildView(state(await demo(), { locale }));
      expect(page.footer).toContain(locale === "de" ? "Halten = Hilfe" : "Hold = help");
    }
  });

  it("QIS v1.2: the first-start demo shows the hint line on every night page, within the row width, in both languages", async () => {
    for (const locale of locales) {
      const full = locale === "de" ? "Demo · Verbindung am Handy einrichten" : "Demo · set up connection on phone";
      const short = locale === "de" ? "Demo · am Handy einrichten" : "Demo · set up on phone";
      for (const page of ["overview", "guiding", "equipment", "image"] as const) {
        const view = buildView(state(await demo(), { locale, page, demoHint: true }));
        const wanted = page === "guiding" || page === "image" ? short : full;
        expect(view.body, `${locale} ${page}`).toContain(wanted);
        for (const row of view.body) expect(row.length, row).toBeLessThanOrEqual(page === "equipment" ? ROW_WIDTH : page === "overview" ? 40 : 26);
        expect(view.header, view.header).toContain(locale === "de" ? "DEMO" : "DEMO");
      }
      // Without the flag there is no hint (a configured bridge, or ?demo=1 screenshots).
      expect(buildView(state(await demo(), { locale })).body.join(" ")).not.toContain("Demo ·");
    }
  });

  it("QIS v1.2: the glasses never show a status code (no HTTP, no number) for a failed bridge or forecast", async () => {
    for (const locale of locales) {
      const failed = buildView(state(null, { locale, connection: { kind: "error", code: "http", status: 503 } }));
      expect((failed.body.join(" ") + failed.header + failed.footer)).not.toMatch(/HTTP|503/);
    }
  });

  it("QIS v1.2: side menu labels fit 32 bytes in both languages", () => {
    for (const locale of locales) for (const key of ["m.help", "m.refresh", "m.swipeNormal", "m.swipeInverted"]) {
      expect(new TextEncoder().encode(messages[locale][key] ?? "").length, `${locale} ${key}`).toBeLessThanOrEqual(32);
    }
  });

  it("uses the glossary: German has no Tap, Wisch, 2x or Doppeltipp; English has no 2x or Double tap", () => {
    const glasses = (locale: Locale): string =>
      Object.entries(messages[locale]).filter(([key]) => /^(g|p\.c)\./.test(key)).map(([, text]) => text).join("\n");
    expect(glasses("de")).not.toMatch(/\bTap\b|\bWisch\b|\b2x\b|Doppeltipp/);
    expect(glasses("en")).not.toMatch(/\b2x\b|Double tap|Doppeltipp/);
  });
});

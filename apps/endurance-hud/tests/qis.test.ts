import { describe, expect, it } from "vitest";
import { footer, GESTURE_WORDS, ROW_WIDTH } from "../src/glasses/footer";
import { helpView, liveView, qis, sportListView } from "../src/glasses/views";
import { locales, type Locale } from "../src/i18n";
import { demoTelemetry, type Telemetry } from "../src/telemetry/model";
import { words } from "../src/words";

/**
 * QIS v1 (docs/BEDIENSTANDARD.md): header `ENDURANCE HUD · state`, footer in the
 * order Tippen/Wischen/Halten/2× ending in back/exit, every row within the row
 * width in all languages, plus the wording glossary.
 */
const live: Telemetry = { ...demoTelemetry(), source: "garmin", distanceKm: 1234.5, powerWatts: 1999, heartRate: 199, cadence: 199 };
const order = (locale: Locale): string[] => [GESTURE_WORDS[locale].tap, GESTURE_WORDS[locale].swipe, GESTURE_WORDS[locale].hold, "2×"];

function views(locale: Locale) {
  const mode = words[locale].stale + " 12m";
  return [
    { name: "live-bike", view: liveView(locale, words[locale].live, "bike", live) },
    { name: "live-run", view: liveView(locale, words[locale].demo, "run", demoTelemetry()) },
    { name: "stale", view: liveView(locale, mode, "bike", live) },
    { name: "help", view: helpView(locale) },
    { name: "sport-list", view: sportListView(locale, 1, null) },
    { name: "sport-list-run", view: sportListView(locale, 2, "run") },
  ];
}

describe("QIS v1 on the glasses", () => {
  for (const locale of locales) {
    it(`${locale}: header, footer and rows fit; footers keep the gesture order and end in 2×`, () => {
      for (const { name, view } of views(locale)) {
        expect(view.header.startsWith("ENDURANCE HUD · "), name).toBe(true);
        expect(view.header.length, name + " header").toBeLessThanOrEqual(ROW_WIDTH);
        expect(view.footer.length, name + " footer").toBeLessThanOrEqual(ROW_WIDTH);
        for (const row of view.body) expect(row.length, name + ": " + row).toBeLessThanOrEqual(ROW_WIDTH);
        const positions = order(locale).map((word) => view.footer.indexOf(word));
        const present = positions.filter((i) => i >= 0);
        expect(present, name + ": " + view.footer).toEqual([...present].sort((a, b) => a - b));
        expect(positions[3], name + ": 2× is never dropped").toBeGreaterThan(-1);
        const g = GESTURE_WORDS[locale];
        expect(view.footer.endsWith(`2× = ${g.back}`) || view.footer.endsWith(`2× = ${g.exit}`), name).toBe(true);
      }
    });
  }

  it("the root footer ends in Ende / exit, the help footer in zurück / back", () => {
    expect(liveView("de", "DEMO", "bike", demoTelemetry()).footer.endsWith("2× = Ende")).toBe(true);
    expect(liveView("en", "DEMO", "bike", demoTelemetry()).footer.endsWith("2× = exit")).toBe(true);
    expect(helpView("de").footer).toBe("Tippen = zurück · 2× = zurück");
    expect(helpView("en").footer).toBe("Tap = back · 2× = back");
  });

  it("drops the swipe part first when the row would be too wide, never the 2×", () => {
    const wide = footer("de", { tap: "aktualisieren", swipe: "Sport wechseln", hold: "Hilfe" }, "exit");
    expect(wide.length).toBeLessThanOrEqual(ROW_WIDTH);
    expect(wide).not.toContain("Wischen");
    expect(wide).toContain("Halten = Hilfe");
    expect(wide.endsWith("2× = Ende")).toBe(true);
    expect(footer("de", { tap: "neu", swipe: "Sport" }, "exit")).toBe("Tippen = neu · Wischen = Sport · 2× = Ende");
  });

  it("uses the glossary: German has no Tap, Wisch, 2x or Doppeltipp; English no 2x, Double tap", () => {
    const all = (locale: Locale): string => [...views(locale).flatMap(({ view }) => [view.header, view.footer, ...view.body]), ...Object.values(qis[locale]), ...Object.values(words[locale])].join("\n");
    expect(all("de")).not.toMatch(/\bTap\b|\bWisch\b|\b2x\b|Doppeltipp/);
    expect(all("en")).not.toMatch(/\b2x\b|Double tap|Doppeltipp/);
  });

  it("the help page lists the gestures in footer order", () => {
    const body = helpView("de").body;
    expect(body.slice(0, 4).map((row) => row.split(" = ")[0])).toEqual(["Tippen", "Wischen", "Halten", "2×"]);
    expect(helpView("en").body[3]).toBe("2× = exit (Help: back)");
  });

  it("without the side menu the live footer has swipe and hold again; the side menu labels still fit 32 bytes in every language", () => {
    for (const locale of locales) {
      const live = liveView(locale, "DEMO", "bike", demoTelemetry()).footer;
      if (locale === "en") expect(live, locale).toContain(GESTURE_WORDS[locale].swipe); // elsewhere the swipe part may be dropped when the row is too wide
      expect(live, locale).toContain(GESTURE_WORDS[locale].hold);
      expect(JSON.stringify(helpView(locale)), locale).not.toMatch(/Seitenmen|side menu|menu latéral|menú lateral|menu laterale/i);
      for (const label of [qis[locale].menuSport, qis[locale].menuHelp]) expect(new TextEncoder().encode(label).length, label).toBeLessThanOrEqual(32);
    }
  });

  it("QIS v1.2: the sport list moves with the cursor and marks the saved choice", () => {
    expect(sportListView("de", 1, "run").body).toEqual(["  Automatisch (Bridge)", "> Rad", "  Laufen ●"]);
    expect(sportListView("de", 0, null).footer).toBe("Tippen = setzen · Wischen = bewegen · 2× = zurück");
  });
});

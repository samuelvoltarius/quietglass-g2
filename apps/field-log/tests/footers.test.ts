import { describe, expect, it } from "vitest";
import { locales, type Locale } from "../src/i18n";
import { quickNotes } from "../src/messages";
import { addEntry, startInspection } from "../src/log/entries";
import { buildView, FOOTER_WIDTH, HEADER_WIDTH, type Phase, type ViewOptions } from "../src/glasses/view";
import { footer } from "../src/glasses/footer";

// QIS v1: header `FIELDLOG · state`, footer Tippen -> Wischen -> Halten -> 2x, ending 2x = zurueck / Ende, one row wide.
const inspection = addEntry(startInspection("i", "Rundgang", 0), "Fenster beschädigt", "major", 1000);

interface Screen { name: string; view: { header: string; footer: string }; end: "back" | "exit" | null }

function screens(locale: Locale): Screen[] {
  const base = (phase: Phase, extra: Partial<ViewOptions> = {}): ViewOptions => ({
    phase, severity: "major", pending: "Riss im Putz", status: "idle", mock: false, locale, quickNotes: quickNotes(locale, []), ...extra,
  });
  return [
    { name: "none", view: buildView(null, base("idle"), 0), end: "exit" },
    { name: "none help", view: buildView(null, base("idle", { help: true }), 0), end: "back" },
    { name: "idle quick", view: buildView(inspection, base("idle"), 60_000), end: "exit" },
    { name: "idle voice", view: buildView(inspection, base("idle", { voice: true }), 60_000), end: "exit" },
    { name: "help", view: buildView(inspection, base("idle", { help: true }), 60_000), end: "back" },
    { name: "pick", view: buildView(inspection, base("pick"), 60_000), end: "back" },
    // 2x does nothing while a job runs or a decision is pending, so these footers do not end in 2x.
    { name: "recording", view: buildView(inspection, base("recording", { elapsedMs: 75_000, live: "live" }), 60_000), end: null },
    { name: "transcribing", view: buildView(inspection, base("transcribing"), 60_000), end: null },
    { name: "review keep", view: buildView(inspection, base("review"), 60_000), end: null },
    { name: "review keep photo", view: buildView(inspection, base("review", { reviewChoice: 1 }), 60_000), end: null },
    { name: "review discard", view: buildView(inspection, base("review", { reviewChoice: 2 }), 60_000), end: null },
  ];
}

describe("footers follow QIS v1", () => {
  for (const locale of locales) {
    it(`keeps every ${locale} header and footer inside one row, headers starting with the app name`, () => {
      for (const { name, view } of screens(locale)) {
        expect(view.footer.length, name + ": " + view.footer).toBeLessThanOrEqual(FOOTER_WIDTH);
        expect(view.header.length, name + ": " + view.header).toBeLessThanOrEqual(HEADER_WIDTH);
        expect(view.header.startsWith("FIELDLOG · "), name + ": " + view.header).toBe(true);
      }
    });

    it(`ends every ${locale} footer in 2× = back/exit where 2× works, gestures in order`, () => {
      const words = locale === "de" ? ["Tippen", "Wischen", "Halten"] : ["Tap", "Swipe", "Hold"];
      const end = locale === "de" ? { back: "2× = zurück", exit: "2× = Ende" } : { back: "2× = back", exit: "2× = exit" };
      for (const { name, view, end: kind } of screens(locale)) {
        if (kind === null) { expect(view.footer, name).not.toContain("2×"); continue; }
        expect(view.footer.endsWith(end[kind]), name + ": " + view.footer).toBe(true);
        const positions = words.map((word) => view.footer.indexOf(word + " = ")).filter((p) => p >= 0);
        expect(positions, name).toEqual([...positions].sort((a, b) => a - b));
      }
    });
  }

  it("uses the German glossary: no Tap, Wisch or 2x in German footers", () => {
    for (const { name, view } of screens("de")) expect(view.footer, name).not.toMatch(/\bTap\b|\bWisch\b|2x/);
  });

  it("drops the swipe hint, never the way out, when a footer would be too long", () => {
    const long = footer("de", { tap: "sprechen", swipe: "durchblättern", hold: "Foto machen" }, "exit");
    expect(long.length).toBeLessThanOrEqual(FOOTER_WIDTH);
    expect(long.endsWith("2× = Ende")).toBe(true);
    expect(long).not.toContain("Wischen");
  });
});

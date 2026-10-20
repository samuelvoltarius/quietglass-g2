import { describe, expect, it } from "vitest";
import { locales, type Locale } from "../src/i18n";
import { quickNotes } from "../src/messages";
import { addEntry, startInspection } from "../src/log/entries";
import { FOOTER_WIDTH, HEADER_WIDTH, notesView, pickView, readView, reviewView, startView, type LogView } from "../src/glasses/view";
import { cockpitHint } from "../src/cockpit/model";
import { footer } from "../src/glasses/footer";

// QIS v1 + QUS v1: the footer is the gestures that do something, Tippen -> Wischen -> Halten -> 2x, ending 2x = zurueck / Ende, one row wide.
const inspection = addEntry(startInspection("i", "Rundgang", 0), "Fenster beschädigt", "major", 1000);

interface Screen { name: string; view: { header: string; footer: string }; end: "back" | "exit" | null }

function screens(locale: Locale): Screen[] {
  const review = (reviewChoice: 0 | 1 | 2): LogView => reviewView({ locale, severity: "major", pending: "Riss im Putz", reviewChoice, confirmDiscard: false, truncated: false });
  return [
    { name: "start quick", view: startView(0, { locale, voice: false, demo: false, severity: "major", entryCount: 1 }), end: "exit" },
    { name: "start voice", view: startView(1, { locale, voice: true, demo: false, severity: "major", entryCount: 1 }), end: "exit" },
    { name: "start type", view: startView(2, { locale, voice: true, demo: false, severity: "note", entryCount: 0 }), end: "exit" },
    { name: "notes", view: notesView(inspection, 0, locale, true, false), end: "back" },
    { name: "read", view: readView(inspection, 0, 0, locale), end: "back" },
    { name: "pick", view: pickView({ locale, severity: "major", quickNotes: quickNotes(locale, []), pickIndex: 0 }), end: "back" },
    // 2x does nothing while a job runs or a decision is pending, so these footers do not end in 2x.
    { name: "recording", view: { header: "", footer: cockpitHint({ phase: "recording", locale, status: "idle", voice: true }) }, end: null },
    { name: "transcribing", view: { header: "", footer: cockpitHint({ phase: "transcribing", locale, status: "connecting", voice: true }) }, end: null },
    { name: "ready", view: { header: "", footer: cockpitHint({ phase: "idle", locale, status: "idle", voice: true }) }, end: "back" },
    { name: "review keep", view: review(0), end: null },
    { name: "review keep photo", view: review(1), end: null },
    { name: "review discard", view: review(2), end: null },
  ];
}

describe("footers follow QIS v1", () => {
  for (const locale of locales) {
    it(`keeps every ${locale} header and footer inside one row`, () => {
      for (const { name, view } of screens(locale)) {
        expect(view.footer.length, name + ": " + view.footer).toBeLessThanOrEqual(FOOTER_WIDTH);
        expect(view.header.length, name + ": " + view.header).toBeLessThanOrEqual(HEADER_WIDTH);
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

  it("uses the German glossary: no Tap, Wisch or 2x in German footers; never a Hold (it never reaches the app)", () => {
    for (const { name, view } of screens("de")) {
      expect(view.footer, name).not.toMatch(/\bTap\b|\bWisch\b|2x/);
      expect(view.footer, name).not.toContain("Halten");
    }
  });

  it("drops the swipe hint, never the way out, when a footer would be too long", () => {
    const long = footer("de", { tap: "sprechen", swipe: "durchblättern", hold: "Foto machen" }, "exit");
    expect(long.length).toBeLessThanOrEqual(FOOTER_WIDTH);
    expect(long.endsWith("2× = Ende")).toBe(true);
    expect(long).not.toContain("Wischen");
  });
});

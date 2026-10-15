import { describe, expect, it } from "vitest";
import { locales, type Locale } from "../src/i18n";
import { buildView } from "../src/glasses/view";
import { buildHelpView, HELP_PAGES } from "../src/glasses/menu-view";
import { buildSensorView } from "../src/glasses/sensor-view";
import { footer, FOOTER_WIDTH } from "../src/glasses/footer";
import { HEADER_COLS, LINE_COLS } from "../src/glasses/fit";
import { addSample, calibrate, createMonitor, DEFAULT_SETTINGS } from "../src/posture/monitor";
import { createStats, startRecording } from "../src/imu/diagnostics";
import { messages } from "../src/messages";

// QIS v1: header `POSTURE · state`, footer Tippen -> Wischen -> Halten -> 2x, ending 2x = zurueck / Ende, one row wide.
const fast = { ...DEFAULT_SETTINGS, smoothing: 1, sustainSeconds: 10, warnAngle: 25 };
const UPRIGHT = { x: 0, y: 0, z: 1 };
const TILTED = { x: 0, y: 1, z: 1 };

function screens(locale: Locale): { name: string; view: { header: string; body: readonly string[]; footer: string }; end: "back" | "exit" }[] {
  const fresh = createMonitor();
  const good = addSample(calibrate(createMonitor(), UPRIGHT, 0), UPRIGHT, fast, 10_000);
  const leaning = addSample(calibrate(createMonitor(), UPRIGHT, 0), TILTED, fast, 1000);
  const warned = addSample(leaning, TILTED, fast, 12_000);
  const o = { locale };
  return [
    { name: "first run", view: buildView(fresh, fast, o, 0), end: "exit" },
    { name: "good", view: buildView(good, fast, o, 10_000), end: "exit" },
    { name: "saved", view: buildView(good, fast, { ...o, justCalibrated: true }, 10_000), end: "exit" },
    { name: "leaning", view: buildView(leaning, fast, o, 4000), end: "exit" },
    { name: "warned", view: buildView(warned, fast, o, 12_000), end: "exit" },
    { name: "no sensor", view: buildView(fresh, fast, { ...o, sensorOff: true }, 0), end: "exit" },
    { name: "tally cleared", view: buildView(good, fast, { ...o, note: messages[locale]["g.m.cleared"] ?? "" }, 10_000), end: "exit" },
    ...Array.from({ length: HELP_PAGES }, (_, page) => ({ name: "help " + (page + 1), view: buildHelpView(locale, page), end: "back" as const })),
    { name: "sensor test", view: buildSensorView(createStats(), { locale, pace: 1000, recording: null }), end: "back" },
    { name: "sensor recording", view: buildSensorView(createStats(), { locale, pace: 1000, recording: startRecording(0) }, 1000), end: "back" },
  ];
}

describe("footers follow QIS v1", () => {
  for (const locale of locales) {
    it(`keeps every ${locale} header, row and footer inside the row width`, () => {
      for (const { name, view } of screens(locale)) {
        expect(view.header.length, name + ": " + view.header).toBeLessThanOrEqual(HEADER_COLS);
        expect(view.footer.length, name + ": " + view.footer).toBeLessThanOrEqual(LINE_COLS);
        expect(view.header.startsWith("POSTURE"), name + ": " + view.header).toBe(true);
      }
    });

    it(`ends every ${locale} footer in 2× = back/exit, gestures in order, nothing cut`, () => {
      const words = locale === "de" ? ["Tippen", "Wischen", "Halten"] : ["Tap", "Swipe", "Hold"];
      const end = locale === "de" ? { back: "2× = zurück", exit: "2× = Ende" } : { back: "2× = back", exit: "2× = exit" };
      for (const { name, view, end: kind } of screens(locale)) {
        expect(view.footer.endsWith(end[kind]), name + ": " + view.footer).toBe(true);
        expect(view.footer, name).not.toContain("…");
        const positions = words.map((word) => view.footer.indexOf(word + " = ")).filter((p) => p >= 0);
        expect(positions, name).toEqual([...positions].sort((a, b) => a - b));
      }
    });
  }

  it("uses the German glossary: no Tap, Wisch or 2x in German footers", () => {
    for (const { name, view } of screens("de")) expect(view.footer, name).not.toMatch(/\bTap\b|\bWisch\b|2x/);
  });

  it("never lists a swipe where a swipe does nothing", () => {
    const first = screens("en").find((s) => s.name === "good")!;
    expect(first.view.footer).not.toContain("Swipe");
  });

  it("drops the swipe hint, never the way out, when a footer would be too long", () => {
    const long = footer("de", { tap: "speichern", swipe: "durchblättern", hold: "Menü öffnen" }, "exit");
    expect(long.length).toBeLessThanOrEqual(FOOTER_WIDTH);
    expect(long.endsWith("2× = Ende")).toBe(true);
    expect(long).not.toContain("Wischen");
  });

  it("QIS v1.2: the armed footers name the action; the tally one asks for the same menu entry again", () => {
    const good = addSample(calibrate(createMonitor(), UPRIGHT, 0), UPRIGHT, fast, 10_000);
    expect(buildView(good, fast, { locale: "en", confirm: "calibrate" }, 10_000).footer).toBe("Tap again = save again · Swipe/2× = cancel");
    expect(buildView(good, fast, { locale: "en", confirm: "reset" }, 10_000).footer).toBe("Again in the menu = clear · 2× = cancel");
    expect(buildView(good, fast, { locale: "de", confirm: "reset" }, 10_000).footer).toBe("Nochmal im Menü = löschen · 2× = abbrechen");
    expect(buildView(good, fast, { locale: "de", confirm: "reset" }, 10_000).header).toBe("POSTURE · Zählung löschen?");
  });

  it("builds the recording footer with the helper: countdown first, the way back still last", () => {
    for (const locale of locales) {
      const view = buildSensorView(createStats(), { locale, pace: 1000, recording: startRecording(0) }, 1000);
      expect(view.footer.length).toBeLessThanOrEqual(LINE_COLS);
      expect(view.footer.endsWith(locale === "de" ? "2× = zurück" : "2× = back")).toBe(true);
    }
  });
});

import { describe, expect, it } from "vitest";
import { footer, GESTURE_WORDS } from "../src/glasses/footer";
import { buildPrintView, buildView, errorReason, type Connection, type ViewState } from "../src/glasses/views";
import { MAX_BODY_ROWS, ROW_WIDTH, type ScreenView } from "../src/glasses/screen";
import { locales, type Locale } from "../src/i18n";
import { messages } from "../src/messages";
import { parseStatus, type PrinterStatus } from "../src/printer/status";

/**
 * QIS v1 (docs/BEDIENSTANDARD.md): header `KLIPPER · state`, footer in the order
 * Tippen/Wischen/2× (never Halten) ending in back/exit, every row within the display
 * budget in German and English, plus the wording glossary.
 */

const LONG = "sehr_langer_dateiname_für_eine_halterung_mit_vielen_varianten_v12_final_final.gcode";
const online = (patch: Record<string, unknown> = {}): PrinterStatus => parseStatus({
  online: true, state: "printing", file: LONG, progress: 100, layer: 99999, layers: 99999, minutesLeft: 99999,
  nozzle: { now: 300, target: 300 }, bed: { now: 120, target: 120 }, speed: 999, message: LONG, controllable: true, ...patch,
});

function state(locale: Locale, patch: Partial<ViewState> = {}): ViewState {
  return {
    locale, demo: true, connection: { kind: "ok" }, status: online(), ageSeconds: 9999,
    screen: "hud", cursor: 0, armed: null, sending: false, message: LONG, model: "ready", ...patch,
  };
}

function views(locale: Locale): { name: string; view: ScreenView }[] {
  const out: { name: string; view: ScreenView }[] = [];
  const statuses: [string, PrinterStatus | null][] = [
    ["none", null], ["printing", online()], ["paused", online({ state: "paused" })], ["done", online({ state: "complete", layers: null })],
    ["view-only", online({ controllable: false })],
    ["offline", parseStatus({ online: false, reason: "no-printer", nextScanSeconds: 86400 })],
    ["searching", parseStatus({ online: false, reason: "searching" })],
  ];
  const connections: Connection[] = [{ kind: "ok" }, { kind: "loading" }, { kind: "setup" }, { kind: "error", code: "http", status: 503 }];
  for (const [name, status] of statuses) {
    for (const connection of connections) {
      const s = state(locale, { status, connection });
      out.push({ name: `hud ${name} ${connection.kind}`, view: buildView(s) });
      if (status?.online) out.push({ name: `print ${name} ${connection.kind}`, view: buildPrintView(s) });
    }
    for (const armed of [null, "pause", "resume", "cancel"] as const) {
      out.push({ name: `control ${name} armed=${String(armed)}`, view: buildView(state(locale, { status, screen: "control", armed })) });
    }
    out.push({ name: `control ${name} sending`, view: buildView(state(locale, { status, screen: "control", sending: true })) });
    for (const model of ["none", "preparing", "ready", "failed"] as const) {
      out.push({ name: `model ${name} ${model}`, view: buildView(state(locale, { status, screen: "model", model })) });
    }
  }
  out.push({ name: "help", view: buildView(state(locale, { screen: "help" })) });
  return out;
}

const order = (locale: Locale): string[] => [GESTURE_WORDS[locale].tap, GESTURE_WORDS[locale].swipe, "2×"];

describe("QIS v1 on the glasses", () => {
  for (const locale of locales) {
    it(`${locale}: header names the app, every row fits`, () => {
      for (const { name, view } of views(locale)) {
        expect(view.header.startsWith("KLIPPER · "), `${name}: ${view.header}`).toBe(true);
        expect(view.header.length, name).toBeLessThanOrEqual(ROW_WIDTH);
        expect(view.footer.length, name).toBeLessThanOrEqual(ROW_WIDTH);
        expect(view.body.length, name).toBeLessThanOrEqual(MAX_BODY_ROWS);
        for (const row of view.body) expect(row.length, `${name}: ${row}`).toBeLessThanOrEqual(ROW_WIDTH);
      }
    });

    it(`${locale}: footers keep the gesture order and end in back, exit or cancel`, () => {
      const end = locale === "de" ? /2× = (zurück|Ende|abbrechen)$/ : /2× = (back|exit|cancel)$/;
      const armed = locale === "de" ? /^Nochmal tippen = / : /^Tap again = /;
      for (const { name, view } of views(locale)) {
        expect(view.footer, name).toMatch(end);
        if (armed.test(view.footer)) {
          expect(view.footer, name).toMatch(locale === "de" ? / · (Wischen\/)?2× = abbrechen$/ : / · (Swipe\/)?2× = cancel$/);
          continue;
        }
        const positions = order(locale).map((word) => view.footer.indexOf(word)).filter((i) => i >= 0);
        expect(positions, `${name}: ${view.footer}`).toEqual([...positions].sort((a, b) => a - b));
        expect(view.footer.indexOf("2×"), name).toBeGreaterThanOrEqual(0);
      }
    });
  }

  it("every armed command names what the next tap does and how to cancel", () => {
    const footers = (locale: Locale): string[] => (["pause", "resume", "cancel"] as const).map((armed) => buildView(state(locale, { screen: "control", armed })).footer);
    expect(footers("de")).toEqual([
      "Nochmal tippen = Pause · Wischen/2× = abbrechen",
      "Nochmal tippen = weiter drucken · Wischen/2× = abbrechen",
      "Nochmal tippen = Druck abbrechen · 2× = abbrechen",
    ]);
    expect(footers("en")).toEqual([
      "Tap again = pause · Swipe/2× = cancel",
      "Tap again = resume · Swipe/2× = cancel",
      "Tap again = cancel print · Swipe/2× = cancel",
    ]);
  });

  it("the root footers end in Ende / exit, subpages in zurück / back", () => {
    expect(buildView(state("de", { demo: false })).footer).toBe("Tippen = steuern · Wischen = Modell · 2× = Ende");
    expect(buildView(state("en", { demo: false })).footer).toBe("Tap = control · Swipe = model · 2× = exit");
    // The side menu (SIDE_MENU in main.ts) changes nothing in the footer.
    expect(buildView(state("de", { demo: false, sideMenu: true })).footer).toBe("Tippen = steuern · Wischen = Modell · 2× = Ende");
    expect(buildView(state("en", { demo: false, sideMenu: true })).footer).toBe("Tap = control · Swipe = model · 2× = exit");
    expect(buildView(state("de", { screen: "control" })).footer).toBe("Tippen = wählen · Wischen = bewegen · 2× = zurück");
    expect(buildView(state("de", { screen: "model" })).footer).toBe("Tippen = neu · Wischen = drehen · 2× = zurück");
    expect(buildView(state("de", { screen: "model", model: "none" })).footer).toMatch(/Wischen = zurück/);
    expect(buildView(state("en", { screen: "help" })).footer).toBe("Tap = back · 2× = back");
  });

  it("no glasses footer, header or help row offers Halten/Hold (a temple hold never reaches the app, 21.10.2026)", () => {
    for (const locale of ["de", "en"] as const) {
      const all = views(locale);
      expect(all.length).toBeGreaterThan(0);
      for (const { name, view } of all) {
        expect([view.header, ...view.body, view.footer].join("\n"), name).not.toMatch(/\bHalten\b|\bHold\b/i);
      }
      for (const [key, text] of Object.entries(messages[locale])) {
        if (key.startsWith("g.")) expect(text, key).not.toMatch(/\bHalten\b|\bHold\b/i);
      }
    }
  });

  it("QIS v1.2: cancelling a print says abbrechen, never stoppen", () => {
    for (const locale of ["de", "en"] as const) {
      for (const [key, text] of Object.entries(messages[locale])) {
        if (key.startsWith("g.")) expect(text, key).not.toMatch(/stopp/i);
      }
    }
    expect(messages.de["g.v.cancel"]).toBe("Druck abbrechen");
  });

  it("QIS v1.2 #7: the demo shows the one-line hint on the HUD and the loading screen", () => {
    expect(buildView(state("de", { demo: true, message: "", status: online({ message: "" }) })).body.join("\n")).toContain("Demo · Verbindung am Handy einrichten");
    expect(buildView(state("en", { demo: true, status: null, connection: { kind: "loading" } })).body).toContain("Demo · set up the connection on the phone");
    expect(buildView(state("de", { demo: false })).body.join("\n")).not.toContain("Demo ·");
  });

  it("QIS v1.2 #8: no HTTP status on the glasses, the phone gets it", () => {
    const view = buildView(state("de", { status: null, connection: { kind: "error", code: "http", status: 503 } }));
    expect(view.body.join(" ")).not.toMatch(/503|HTTP/);
    expect(view.body.join(" ")).toContain("Serverfehler");
    expect(errorReason("de", "http", 503)).toBe("Serverfehler");
    expect(errorReason("en", "http", 503, true)).toBe("server error (503)");
  });

  it("the help page lists the gestures in footer order and what the app needs", () => {
    const help = buildView(state("de", { screen: "help" }));
    expect(help.header).toBe("KLIPPER · Hilfe");
    expect(help.body.slice(0, 3).map((row) => row.split(" = ")[0])).toEqual(["Tippen", "Wischen", "2×"]);
    expect(help.body.join("\n")).toContain("Braucht: Bridge");
    expect(buildView(state("en", { screen: "help" })).body.join("\n")).toContain("Needs: the bridge");
  });

  it("drops the swipe part first when the row would be too wide, never the 2×", () => {
    const wide = footer("de", { tap: "aktualisieren", swipe: "Modell der Schichten ansehen und drehen" }, "exit", "Druck 73 % · Schicht 120/300");
    expect(wide).toBe("Tippen = aktualisieren · 2× = Ende");
    expect(footer("de", { tap: "neu", swipe: "drehen" }, "back")).toBe("Tippen = neu · Wischen = drehen · 2× = zurück");
  });

  it("uses the glossary: German has no Tap, Wisch, 2x or Doppeltipp; English no 2x, Double tap", () => {
    const glasses = (locale: Locale): string => [
      ...Object.entries(messages[locale]).filter(([key]) => /^(g|p\.c)\./.test(key)).map(([, text]) => text),
      ...views(locale).flatMap(({ view }) => [view.header, view.footer, ...view.body]),
    ].join("\n");
    expect(glasses("de")).not.toMatch(/\bTap\b|\bWisch\b|\b2x\b|Doppeltipp/);
    expect(glasses("en")).not.toMatch(/\b2x\b|Double tap|Doppeltipp/);
  });
});

import { describe, expect, it } from "vitest";
import { locales, type Locale } from "../src/i18n";
import { MAX_BODY_ROWS, ROW_WIDTH, type ScreenView } from "../src/glasses/screen";
import { buildView, type Connection, type ViewState } from "../src/glasses/views";
import { parseStatus, type PrinterStatus } from "../src/printer/status";

const LONG = "sehr_langer_dateiname_für_eine_halterung_mit_vielen_varianten_v12_final_final.gcode";

const online = (patch: Record<string, unknown> = {}): PrinterStatus => parseStatus({
  online: true, state: "printing", file: LONG, progress: 100, layer: 99999, layers: 99999, minutesLeft: 99999,
  nozzle: { now: 300, target: 300 }, bed: { now: 120, target: 120 }, speed: 999, message: LONG, controllable: true, ...patch,
});

function state(locale: Locale, patch: Partial<ViewState> = {}): ViewState {
  return {
    locale, demo: true, connection: { kind: "ok" }, status: online(), ageSeconds: 9999,
    screen: "hud", cursor: 0, armed: null, sending: false, message: LONG, ...patch,
  };
}

function expectFits(view: ScreenView, label: string): void {
  expect(view.body.length, label).toBeLessThanOrEqual(MAX_BODY_ROWS);
  for (const row of [view.header, view.footer, ...view.body]) {
    expect(row.length, `${label}: ${row}`).toBeLessThanOrEqual(ROW_WIDTH);
    expect(row, label).not.toContain("▸");
  }
  expect(view.footer, label).not.toBe("");
}

describe("every glasses view fits 7 rows × 46 characters", () => {
  const statuses: Array<PrinterStatus | null> = [
    null, online(), online({ state: "paused" }), online({ state: "complete", layers: null }), online({ state: "error", controllable: false }),
    parseStatus({ online: false, reason: "no-printer", nextScanSeconds: 86400 }), parseStatus({ online: false, reason: "searching" }),
    parseStatus({ online: false, reason: "printer-silent" }),
  ];
  const connections: Connection[] = [{ kind: "ok" }, { kind: "loading" }, { kind: "setup" }, { kind: "error", code: "http", status: 503 }, { kind: "error", code: "auth" }];
  for (const locale of locales) {
    it(`${locale}: every status, connection, screen and confirmation`, () => {
      for (const status of statuses) {
        for (const connection of connections) {
          for (const screen of ["hud", "control"] as const) {
            for (const armed of [null, "pause", "resume", "cancel"] as const) {
              for (const sending of [false, true]) {
                for (const cursor of [0, 1, 2]) {
                  const view = buildView(state(locale, { status, connection, screen, armed, sending, cursor }));
                  expectFits(view, `${locale} ${String(status?.online)} ${connection.kind} ${screen} ${String(armed)}`);
                }
              }
            }
          }
        }
      }
    });
  }
});

describe("what the glasses say", () => {
  it("the HUD shows file, progress, layer, temperatures and speed", () => {
    const view = buildView(state("de", {
      demo: false, ageSeconds: 2, message: "",
      status: parseStatus({ online: true, state: "printing", file: "halterung.gcode", progress: 50, layer: 90, layers: 180, minutesLeft: 75,
        nozzle: { now: 219, target: 220 }, bed: { now: 60, target: 60 }, speed: 100, controllable: true }),
    }));
    expect(view.header).toBe("KLIPPER · druckt");
    expect(view.body).toEqual([
      "halterung", "", "●●●●●●●●●●○○○○○○○○○○  50 %", "Schicht 90/180 · noch 1 h 15 min",
      "Düse 219/220 °C · Bett 60/60 °C", "Tempo 100 %", "",
    ]);
    expect(view.footer).toBe("tippen = steuern · 2× = Ende");
  });

  it("without control permission, tap only refreshes", () => {
    const view = buildView(state("en", { status: online({ controllable: false }) }));
    expect(view.footer).toBe("tap = refresh · 2× = close");
  });

  it("marks old values as stale, and demo data as DEMO", () => {
    expect(buildView(state("en", { ageSeconds: 30, status: online({ state: "paused" }) })).header).toBe("KLIPPER · paused · DEMO · stale 30 s");
  });

  it("the control screen offers pause before cancel and asks for the confirming tap", () => {
    const first = buildView(state("de", { screen: "control", cursor: 1, message: "" }));
    expect(first.body.slice(0, 3)).toEqual(["  Pause", "> Druck abbrechen", "  Zurück"]);
    const armed = buildView(state("de", { screen: "control", cursor: 1, armed: "cancel" }));
    expect(armed.body).toContain("Nochmal tippen = Druck ABBRECHEN");
  });

  it("first run explains the setup", () => {
    const view = buildView(state("de", { connection: { kind: "setup" }, status: null }));
    expect(view.body).toEqual(["Noch keine Bridge eingerichtet.", "Adresse am Handy in der Even-App eintragen."]);
  });

  it("an unreachable bridge is said plainly", () => {
    const view = buildView(state("en", { connection: { kind: "error", code: "timeout" }, status: null, message: "" }));
    expect(view.header).toBe("KLIPPER · no connection");
    expect(view.body[0]).toBe("Bridge: no answer");
  });
});

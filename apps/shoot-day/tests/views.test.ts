import { describe, expect, it } from "vitest";
import { locales, type Locale } from "../src/i18n";
import { takeNotes } from "../src/messages";
import { fit, MAX_BODY_ROWS, ROW_WIDTH, wrap, type ScreenView } from "../src/glasses/screen";
import { buildView, MENU, TAKE_ACTIONS, type LoadStatus, type Mode, type TakeScreen, type ViewState } from "../src/glasses/views";
import type { EquipmentItem } from "../src/api/types";

const LONG = "Außenaufnahme am Fluss bei Gegenlicht mit Drohne, Gimbal und zweiter Kamera auf dem Dach".repeat(2);

function state(locale: Locale, patch: Partial<ViewState> = {}): ViewState {
  const items: EquipmentItem[] = Array.from({ length: 40 }, (_, i) => ({
    group: "G", name: `${LONG} ${i}`, need: true, packed: i % 3 === 0,
  }));
  return {
    locale,
    demo: true,
    configured: true,
    now: new Date(2026, 9, 7, 12, 0),
    mode: "menu",
    menuCursor: 0,
    project: LONG,
    pendingCount: 999,
    load: { kind: "ready" },
    message: LONG,
    rec: null,
    takes: {
      shots: Array.from({ length: 120 }, (_, i) => ({ scene: "12A" + i, shot: "B" + i, desc: LONG, size: "Insert" })),
      cursor: 118,
      screen: "card",
      actionCursor: 4,
      noteCursor: 6,
      ok: 999,
      ng: 999,
      last: { n: 999, status: "NG", note: LONG, ts: Date.now(), pending: false },
      nextN: 1000,
      notes: takeNotes(locale),
    },
    prompter: { lines: wrap(LONG.repeat(5)), pos: 3.6, speed: 2.9, playing: true },
    schedule: {
      sheet: {
        date: LONG, call: LONG, location: LONG, contact: LONG, notes: LONG,
        schedule: Array.from({ length: 30 }, (_, i) => ({ time: `${String(8 + (i % 12)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`, what: LONG })),
      },
      scroll: 25,
    },
    pack: { items, cursor: 39, missing: false },
    ...patch,
  };
}

function expectFits(view: ScreenView, label: string): void {
  expect(view.body.length, label).toBeLessThanOrEqual(MAX_BODY_ROWS);
  for (const row of [view.header, view.footer, ...view.body]) expect(row.length, `${label}: ${row}`).toBeLessThanOrEqual(ROW_WIDTH);
  expect(view.footer, `${label} footer`).not.toBe("");
  for (const row of [view.header, view.footer, ...view.body]) expect(row, label).not.toContain("▸");
}

describe("every glasses view fits 7 rows × 46 characters", () => {
  const modes: Mode[] = ["menu", ...MENU];
  const loads: LoadStatus[] = [{ kind: "ready" }, { kind: "loading" }, { kind: "error", code: "http", status: 503 }, { kind: "error", code: "auth" }];
  for (const locale of locales) {
    it(`${locale}: all modes, screens and load states, with long content`, () => {
      for (const mode of modes) {
        for (const load of loads) {
          for (const configured of [true, false]) {
            for (const screen of ["card", "actions", "notes"] as TakeScreen[]) {
              for (const missing of [false, true]) {
                const view = buildView(state(locale, {
                  mode, load, configured, demo: !configured ? false : true,
                  takes: { ...state(locale).takes, screen },
                  pack: { ...state(locale).pack, missing },
                }));
                expectFits(view, `${locale} ${mode} ${load.kind} ${screen} ${String(missing)}`);
              }
            }
          }
        }
      }
    });

    it(`${locale}: empty data and recording screens fit too`, () => {
      const empty = state(locale, {
        project: "", message: "", pendingCount: 0,
        takes: { ...state(locale).takes, shots: [], cursor: 0, last: null },
        prompter: { lines: [], pos: 0, speed: 0.4, playing: false },
        schedule: { sheet: { date: "", call: "", location: "", contact: "", notes: "", schedule: [] }, scroll: 0 },
        pack: { items: [], cursor: 0, missing: false },
      });
      for (const mode of ["menu", ...MENU] as Mode[]) expectFits(buildView({ ...empty, mode }), `${locale} empty ${mode}`);
      for (const target of ["takes", "pack"] as const) {
        for (const via of ["tap", "hold"] as const) {
          for (const busy of [false, true]) expectFits(buildView({ ...empty, rec: { target, via, busy } }), `${locale} rec ${target} ${via} ${String(busy)}`);
        }
      }
    });
  }
});

describe("what the glasses say", () => {
  it("the menu explains the first run when no server is set up", () => {
    const view = buildView(state("de", { configured: false, demo: false, project: "" }));
    expect(view.body.slice(0, 4)).toEqual(["> Takes", "  Teleprompter", "  Tagesplan", "  Packliste"]);
    expect(view.body).toContain("Noch kein Server eingerichtet.");
    expect(view.header).toBe("SHOOT DAY");
    expect(view.footer).toBe("wischen · tippen = öffnen · 2× = Ende");
  });

  it("demo data is labelled DEMO", () => {
    expect(buildView(state("en")).header).toBe("SHOOT DAY · DEMO");
  });

  it("the take card shows shot, counts and the last take", () => {
    const view = buildView(state("en", {
      mode: "takes", demo: false, message: "",
      takes: {
        ...state("en").takes,
        shots: [{ scene: "2", shot: "B", desc: "Over the shoulder", size: "MCU" }],
        cursor: 0, ok: 2, ng: 1, last: { n: 3, status: "OK", note: "great", ts: new Date(2026, 0, 1, 14, 5).getTime(), pending: false },
      },
    }));
    expect(view.header).toBe("TAKES · shot 1/1 · scene 2");
    expect(view.body).toEqual(["2 · B   MCU", "Over the shoulder", "", "OK 2 · NG 1", "Last: T3 OK 14:05 great", "", ""]);
    expect(view.footer).toBe("swipe = shot · tap = take · 2× = menu");
  });

  it("the actions list marks the selection", () => {
    const view = buildView(state("de", { mode: "takes", takes: { ...state("de").takes, screen: "actions", actionCursor: 1 } }));
    expect(view.body.slice(0, TAKE_ACTIONS.length)).toEqual(["  Take OK", "> Take NG", "  Notiz zum letzten Take", "  Sprechen", "  Zurück"]);
  });

  it("the packing list uses glyphs the G2 draws", () => {
    const view = buildView(state("de", {
      mode: "pack", message: "",
      pack: { items: [{ group: "", name: "Gimbal", need: true, packed: true }, { group: "", name: "Klappe", need: true, packed: false }], cursor: 1, missing: false },
    }));
    expect(view.header).toBe("PACKLISTE · 1/2 eingepackt · DEMO");
    expect(view.body.slice(0, 2)).toEqual(["  ● Gimbal", "> ○ Klappe"]);
  });

  it("the schedule shows now and next by the clock", () => {
    const view = buildView(state("de", {
      mode: "schedule", demo: false,
      schedule: {
        sheet: { date: "Mo", call: "07:30", location: "Halle", contact: "", notes: "", schedule: [{ time: "11:00", what: "Szene 1" }, { time: "12:30", what: "Mittag" }] },
        scroll: 0,
      },
    }));
    expect(view.header).toBe("TAGESPLAN · Mo · Call 07:30");
    expect(view.body[0]).toBe("JETZT 11:00 Szene 1");
    expect(view.body[1]).toBe("GLEICH 12:30 Mittag (in 30 min)");
    expect(view.body).toContain("● 11:00 Szene 1");
  });

  it("the microphone indicator is shown while listening", () => {
    const view = buildView(state("en", { mode: "pack", rec: { target: "pack", via: "hold", busy: false } }));
    expect(view.header).toBe("● MIC · speak now");
    expect(view.footer).toBe("release = done");
  });
});

describe("text helpers", () => {
  it("fit cuts with an ellipsis and flattens line breaks", () => {
    expect(fit("a\nb")).toBe("a b");
    const cut = fit("x".repeat(60));
    expect(cut).toHaveLength(ROW_WIDTH);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("wrap keeps words whole, splits overlong words and keeps blank lines", () => {
    const rows = wrap("eins zwei drei\n\n" + "y".repeat(100), 20);
    expect(rows[0]).toBe("eins zwei drei");
    expect(rows[1]).toBe("");
    expect(rows.slice(2).every((row) => row.length <= 20)).toBe(true);
    expect(rows.slice(2).join("")).toBe("y".repeat(100));
  });
});

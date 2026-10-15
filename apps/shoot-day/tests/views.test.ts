import { describe, expect, it } from "vitest";
import { locales, type Locale } from "../src/i18n";
import { takeNotes } from "../src/messages";
import { fit, MAX_BODY_ROWS, ROW_WIDTH, wrap, type ScreenView } from "../src/glasses/screen";
import { buildView, MENU, TAKE_ACTIONS, type LoadStatus, type Mode, type TakeScreen, type ViewState } from "../src/glasses/views";
import type { BoardScene, Brief, EquipmentItem } from "../src/api/types";

const LONG = "Außenaufnahme am Fluss bei Gegenlicht mit Drohne, Gimbal und zweiter Kamera auf dem Dach".repeat(2);
const SCENES: BoardScene[] = Array.from({ length: 12 }, (_, i) => ({
  n: i + 1, from: i * 3605, to: i * 3605 + 59, title: LONG, content: LONG, camera: LONG, overlay: LONG, goal: LONG, done: i % 2 === 0,
}));
const BRIEF: Brief = {
  id: "c_000000000001", name: LONG, company: LONG, phone: "+43 000 0000000000", email: "someone@example.invalid", notes: LONG.repeat(3),
  updated: Date.UTC(2026, 9, 14), ideas: Array.from({ length: 8 }, () => ({ text: LONG, tags: ["drohne", "licht"], project: LONG })),
  memory: [{ date: "2026-10-01T10:00:00", title: LONG, summary: LONG }], memoryError: false,
};

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
      actionCursor: 5,
      rollingSince: null,
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
    customerMode: false,
    customers: {
      list: Array.from({ length: 60 }, (_, i) => ({ id: `c_${String(i).padStart(12, "0")}`, name: `${LONG} ${i}`, company: LONG, projectCount: 99 })),
      cursor: 30,
      pending: null,
    },
    projects: {
      customer: { id: "c_000000000001", name: LONG, company: LONG, projectCount: 99 },
      list: Array.from({ length: 40 }, (_, i) => ({ id: `p_${String(i).padStart(12, "0")}`, name: `${LONG} ${i}`, date: "2026-10-14", place: LONG })),
      cursor: 20,
      active: "p_000000000020",
    },
    brief: { data: BRIEF, page: 1 },
    board: { boards: [{ id: "s_000000000001", title: LONG, scenes: SCENES }, { id: "s_000000000002", title: LONG, scenes: SCENES }], board: 0, cursor: 3, picking: false },
    ...patch,
  };
}

function expectFits(view: ScreenView, label: string): void {
  expect(view.body.length, label).toBeLessThanOrEqual(MAX_BODY_ROWS);
  for (const row of [view.header, view.footer, ...view.body]) expect(row.length, `${label}: ${row}`).toBeLessThanOrEqual(ROW_WIDTH);
  expect(view.footer, `${label} footer`).not.toBe("");
  for (const row of [view.header, view.footer, ...view.body]) expect(row, label).not.toContain("▸");
}

describe("every glasses view fits 7 rows × 56 characters", () => {
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
      for (const target of ["takes", "pack", "customer"] as const) {
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
    // The side menu is off: Hilfe is the last list row again.
    expect(view.body.slice(0, 6)).toEqual(["> Takes", "  Teleprompter", "  Tagesplan", "  Packliste", "  Licht & Sonne", "  Hilfe"]);
    expect(view.body).toContain("Noch kein Server: Adresse am Handy eintragen.");
    expect(view.header).toBe("SHOOT DAY · Menü");
    expect(view.footer).toBe("Tippen = öffnen · Wischen = wählen · 2× = Ende");
  });

  it("demo data is labelled DEMO", () => {
    expect(buildView(state("en", { project: "" })).header).toBe("SHOOT DAY · Menu · DEMO");
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
    expect(view.header).toBe("SHOOT DAY · TAKES · 1 of 1");
    expect(view.body).toEqual(["Scene 2 · shot B · MCU", "Over the shoulder", "", "OK 2 · NG 1", "Last: T3 OK 14:05 great", "", ""]);
    expect(view.footer).toBe("Tap = take · Swipe = shot · Hold = speak · 2× = back");
  });

  it("the actions list marks the selection", () => {
    const view = buildView(state("de", { mode: "takes", takes: { ...state("de").takes, screen: "actions", actionCursor: 2 } }));
    expect(view.body.slice(0, TAKE_ACTIONS.length)).toEqual(["  Take starten", "  Take OK", "> Take NG", "  Notiz zum letzten Take", "  Sprechen", "  Letzten Take löschen", "  Zurück"]);
  });

  it("the packing list uses glyphs the G2 draws", () => {
    const view = buildView(state("de", {
      mode: "pack", message: "",
      pack: { items: [{ group: "", name: "Gimbal", need: true, packed: true }, { group: "", name: "Klappe", need: true, packed: false }], cursor: 1, missing: false },
    }));
    expect(view.header).toBe("SHOOT DAY · PACKLISTE · 1/2 eingepackt · DEMO");
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
    expect(view.header).toBe("SHOOT DAY · TAGESPLAN · Mo · Call 07:30");
    expect(view.body[0]).toBe("JETZT 11:00 Szene 1");
    expect(view.body[1]).toBe("GLEICH 12:30 Mittag (in 30 min)");
    expect(view.body).toContain("● 11:00 Szene 1");
  });

  it("the microphone indicator is shown while listening", () => {
    const view = buildView(state("en", { mode: "pack", rec: { target: "pack", via: "hold", busy: false } }));
    expect(view.header).toBe("SHOOT DAY · ● MIC · speak now");
    expect(view.footer).toBe("Release = done · 2× = back");
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

describe("live text while speaking", () => {
  it("shows the newest words of the command, and keeps them while finishing", async () => {
    const { lastRows } = await import("../src/glasses/views");
    const long = Array.from({ length: 80 }, (_, i) => `wort${i}`).join(" ");
    const base = state("de", { mode: "pack", rec: { target: "pack", via: "hold", busy: false, live: long } });
    const view = buildView(base);
    expect(view.header).toBe("SHOOT DAY · ● MIC · sprich jetzt");
    expect(view.body.at(-1)).toContain("wort79");
    expect(view.body[0]?.startsWith("…")).toBe(true);
    expect(view.footer).toBe("Loslassen = fertig · 2× = zurück");
    const busy = buildView(state("de", { mode: "pack", rec: { target: "pack", via: "hold", busy: true, live: "Gimbal eingepackt" } }));
    expect(busy.body).toContain("Gimbal eingepackt");
    expect(lastRows(["a", "b", "c"], 2)).toEqual(["…b", "c"]);
  });
});

describe("customers, projects, the card before the appointment and the storyboard", () => {
  const CUSTOMER_MODES: Mode[] = ["customers", "projects", "brief", "menu", "board"];
  for (const locale of locales) {
    it(`${locale}: every screen fits with long content, empty lists and every load state`, () => {
      const loads: LoadStatus[] = [{ kind: "ready" }, { kind: "loading" }, { kind: "error", code: "http", status: 404 }];
      for (const mode of CUSTOMER_MODES) {
        for (const load of loads) {
          for (const picking of [false, true]) {
            for (const page of [0, 1, 99]) {
              const full = state(locale, { mode, load, customerMode: true, brief: { data: BRIEF, page }, board: { ...state(locale).board, picking } });
              expectFits(buildView(full), `${locale} ${mode} ${load.kind} ${String(picking)} ${page}`);
              const empty = state(locale, {
                mode, load, customerMode: true, message: "",
                customers: { list: [], cursor: 0, pending: null },
                projects: { customer: null, list: [], cursor: 0, active: "" },
                brief: { data: { ...BRIEF, notes: "", ideas: [], memory: null, phone: "", company: "", email: "" }, page },
                board: { boards: [], board: 0, cursor: 0, picking },
              });
              expectFits(buildView(empty), `${locale} empty ${mode} ${load.kind}`);
            }
          }
        }
      }
      expectFits(buildView(state(locale, { mode: "customers", customerMode: true, customers: { ...state(locale).customers, pending: LONG } })), `${locale} new customer`);
    });
  }

  it("lists customers in the server's order with the new-customer entry on top and a marked cursor", () => {
    const view = buildView(state("de", {
      mode: "customers", customerMode: true, demo: false, message: "",
      customers: {
        list: [
          { id: "c_000000000001", name: "Anna Beispiel", company: "", projectCount: 1 },
          { id: "c_000000000002", name: "Bäckerei Sonnenschein", company: "Sonnenschein KG", projectCount: 2 },
        ],
        cursor: 2,
        pending: null,
      },
    }));
    expect(view.header).toBe("SHOOT DAY · KUNDEN · 2");
    expect(view.body.slice(0, 3)).toEqual(["  + Neuer Kunde (sprechen)", "  Anna Beispiel", "> Bäckerei Sonnenschein · Sonnenschein KG"]);
    expect(view.body[3]).toBe("  Hilfe");
    expect(view.footer).toBe("Tippen = öffnen · Halten = neuer Kunde · 2× = Ende");
  });

  it("a long customer list scrolls with the cursor and shows where it goes on", () => {
    const view = buildView(state("en", { mode: "customers", customerMode: true, demo: false, message: "" }));
    expect(view.body.some((row) => row.startsWith(">"))).toBe(true);
    expect(view.body[0]?.startsWith("↑")).toBe(true);
    expect(view.body[5]?.startsWith("…")).toBe(true);
  });

  it("asks before a customer heard by voice is created", () => {
    const view = buildView(state("de", { mode: "customers", customerMode: true, message: "", customers: { list: [], cursor: 0, pending: "Anna Beispiel" } }));
    expect(view.header).toBe("SHOOT DAY · NEUER KUNDE");
    expect(view.body).toContain("\"Anna Beispiel\"");
    expect(view.body).toContain("So anlegen?");
    // 2× only asks to discard the name (QIS v1.2 no. 2), so it is not listed.
    expect(view.footer).toBe("Tippen = anlegen · Halten = neu sprechen");
  });

  it("projects start with the card before the appointment and mark the active project", () => {
    const view = buildView(state("de", {
      mode: "projects", customerMode: true, demo: false, message: "",
      projects: {
        customer: { id: "c_000000000001", name: "Anna Beispiel", company: "", projectCount: 1 },
        list: [{ id: "p_000000000001", name: "Porträt", date: "2026-10-20", place: "" }],
        cursor: 1,
        active: "p_000000000001",
      },
    }));
    expect(view.header).toBe("SHOOT DAY · KUNDE · Anna Beispiel");
    expect(view.body.slice(0, 2)).toEqual(["  Kunde vor dem Termin", "> 20.10.2026 · Porträt ●"]);
  });

  it("a scene card shows number, time, title, camera hint and text overlay", () => {
    const scene: BoardScene = { n: 2, from: 5, to: 12, title: "Hände im Teig", content: "Nahaufnahme der Hände.", camera: "Nah, langsamer Schwenk", overlay: "Ofenfrisch", goal: "Handwerk zeigen", done: true };
    const view = buildView(state("de", {
      mode: "board", customerMode: true, demo: false, message: "",
      board: { boards: [{ id: "s_000000000001", title: "Reel", scenes: [SCENES[0]!, scene] }], board: 0, cursor: 1, picking: false },
    }));
    expect(view.header).toBe("SHOOT DAY · SZENE 2/2 · 0:05–0:12");
    expect(view.body).toEqual(["● Hände im Teig", "Nahaufnahme der Hände.", "Kamera: Nah, langsamer Schwenk", "Text: \"Ofenfrisch\"", "Ziel: Handwerk zeigen", "", "● erledigt"]);
    expect(view.footer).toBe("Tippen = wieder offen · Wischen = Szene · 2× = zurück");
  });

  it("the card before the appointment lists notes, open ideas and Babel — and nothing about Babel without it", async () => {
    const { briefRows } = await import("../src/glasses/views");
    const rows = briefRows("de", {
      ...BRIEF, name: "Anna", company: "Muster GmbH", phone: "", email: "", notes: "Kaffee schwarz.",
      ideas: [{ text: "Drohnenflug", tags: ["drohne"], project: "" }],
      memory: [{ date: "2026-10-01T10:00", title: "Erstgespräch", summary: "Will ein Reel." }],
    });
    expect(rows).toContain("NOTIZEN");
    expect(rows).toContain("Kaffee schwarz.");
    expect(rows).toContain("OFFENE IDEEN (1)");
    expect(rows).toContain("· Drohnenflug #drohne");
    expect(rows).toContain("AUS BABEL");
    expect(rows).toContain("2026-10-01 · Erstgespräch");
    expect(briefRows("de", { ...BRIEF, memory: null }).join("\n")).not.toContain("BABEL");
  });

  it("the project menu puts the storyboard first and goes back to the projects", () => {
    const view = buildView(state("de", { mode: "menu", customerMode: true, demo: false, project: "Porträt", message: "", pendingCount: 0 }));
    expect(view.header).toBe("SHOOT DAY · Porträt");
    expect(view.body.slice(0, 2)).toEqual(["> Storyboard", "  Takes"]);
    expect(view.footer).toBe("Tippen = öffnen · Wischen = wählen · 2× = zurück");
  });
});

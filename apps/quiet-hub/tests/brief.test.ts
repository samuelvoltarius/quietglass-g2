import { describe, expect, it } from "vitest";
import { applyMenu, buildView, createModel, decide, menuFor, MENU, mergeReport, pickerEntries, ROOT_ITEMS, withBrief, type HubModel } from "../src/hub/model";
import { briefBlocks, briefPages, briefSummary, calendarRows, morningStart, rainText, serverRows, sugarRows, trendArrow, weatherWord } from "../src/hub/brief";
import { demoBrief, demoReport } from "../src/api/demo";
import { emptyReport } from "../src/api/empty";
import { MAX_BODY_ROWS, ROW_WIDTH } from "../src/glasses/screen";
import type { Brief, BriefEvent } from "../src/api/types";
import type { Locale } from "../src/i18n";

const NOW = new Date(2026, 9, 14, 7, 5).getTime();
const at = (h: number, m = 0): number => new Date(2026, 9, 14, h, m).getTime();
const ev = (title: string, h: number, m: number, minutes: number): BriefEvent => {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const end = new Date(at(h, m) + minutes * 60_000);
  return { title, allDay: false, startMs: at(h, m), endMs: end.getTime(), start: `${pad(h)}:${pad(m)}`, end: `${pad(end.getHours())}:${pad(end.getMinutes())}` };
};
const OFF = { status: "off" } as const;
const empty = (): Brief => ({ at: NOW, date: "2026-10-14", calendar: OFF, weather: OFF, car: OFF, sugar: OFF, printer: OFF, servers: OFF });

describe("words", () => {
  it("rain nowcast text", () => {
    expect(rainText({ kind: "later", from: "14:00", until: "16:00", mm: 2 }, "de")).toBe("Regen ab 14:00");
    expect(rainText({ kind: "now", from: "", until: "15:30", mm: 1 }, "de")).toBe("Regen bis 15:30");
    expect(rainText({ kind: "now", from: "", until: "", mm: 9 }, "de")).toBe("Regen jetzt");
    expect(rainText({ kind: "none", from: "", until: "", mm: 0 }, "de")).toBe("kein Regen");
    expect(rainText({ kind: "unknown", from: "", until: "", mm: 0 }, "de")).toBe("");
    expect(rainText({ kind: "later", from: "14:00", until: "", mm: 1 }, "en")).toBe("rain from 14:00");
  });

  it("weather words and trend arrows use only glyphs the G2 draws", () => {
    expect(weatherWord(0, "de")).toBe("klar");
    expect(weatherWord(63, "en")).toBe("rain");
    expect(weatherWord(null, "de")).toBe("");
    for (const d of ["DoubleUp", "SingleUp", "FortyFiveUp", "Flat", "FortyFiveDown", "SingleDown", "DoubleDown"]) expect(trendArrow(d)).toMatch(/^[↑↓→()]+$/);
    expect(trendArrow("NONE")).toBe("");
  });

  it("start page only in the morning and only when switched on", () => {
    expect(morningStart(true, new Date(2026, 9, 14, 6, 30))).toBe(true);
    expect(morningStart(true, new Date(2026, 9, 14, 10, 59))).toBe(true);
    expect(morningStart(true, new Date(2026, 9, 14, 11, 0))).toBe(false);
    expect(morningStart(false, new Date(2026, 9, 14, 7, 0))).toBe(false);
  });
});

describe("blocks", () => {
  it("calendar: no source, none today, upcoming first, overflow counted", () => {
    expect(calendarRows({ status: "off" }, "de", NOW)).toEqual(["Termine · keine Kalenderquelle"]);
    expect(calendarRows({ status: "ok", events: [], total: 0 }, "de", NOW)).toEqual(["Termine · heute keine"]);
    expect(calendarRows({ status: "error", error: "timeout" }, "de", NOW)).toEqual(["Termine · nicht erreichbar"]);
    const events = [ev("Früh", 6, 0, 30), ev("A", 8, 0, 30), ev("B", 9, 0, 30), ev("C", 10, 0, 30), ev("D", 11, 0, 30), ev("E", 12, 0, 30), ev("F", 13, 0, 30)];
    const rows = calendarRows({ status: "ok", events, total: 7 }, "de", NOW);
    expect(rows[0]).toBe("Termine · 7 heute · 1 vorbei");
    expect(rows[1]).toBe("  08:00–08:30 · A");
    expect(rows.at(-1)).toBe("  +2 weitere");
    expect(rows.length).toBe(6);
    const allDay = calendarRows({ status: "ok", events: [{ title: "Urlaub", allDay: true, startMs: at(0), endMs: at(23), start: "", end: "" }], total: 1 }, "de", NOW);
    expect(allDay).toEqual(["Termine · 1 heute", "  ganztags · Urlaub"]);
  });

  it("glucose: value, trend, night, disclaimer; empty says so", () => {
    const rows = sugarRows({ status: "ok", current: { mgdl: 124, direction: "SingleUp", ageMin: 3 }, night: { min: 88, max: 162, belowMin: 0, aboveMin: 25, count: 100 }, low: 70, high: 180 }, "de");
    expect(rows).toEqual(["Zucker · 124 mg/dL ↑ · vor 3 min · nur Info", "  Nacht 88–162 · <70: 0 min · >180: 25 min"]);
    expect(sugarRows({ status: "ok", current: null, night: null }, "de")).toEqual(["Zucker · keine Werte · nur Info"]);
    expect(sugarRows({ status: "error", error: "x" }, "en")).toEqual(["Glucose · unreachable · info only"]);
  });

  it("servers: all ok, someone down, new devices", () => {
    expect(serverRows({ status: "ok", machines: [{ name: "Pi", ok: true, newDevices: 0 }], down: 0, newDevices: 0 }, "de")).toEqual(["Server · alle 1 ok"]);
    expect(serverRows({ status: "ok", machines: [{ name: "Pi", ok: true, newDevices: 2 }, { name: "NAS", ok: false, newDevices: null }], down: 1, newDevices: 2 }, "de"))
      .toEqual(["Server · 1/2 ok · weg: NAS · 2 neue Geräte"]);
  });

  it("leaves unconfigured blocks out, marks stale ones, explains an empty setup", () => {
    expect(briefBlocks(empty(), "ready", "de", NOW)).toEqual([["Termine · keine Kalenderquelle"], ["Quellen im Daemon setzen: BRIEF_* (README)"]]);
    const stale = { ...empty(), car: { status: "ok" as const, soc: 50, rangeKm: 200, charging: false, locked: true, stale: true } };
    expect(briefBlocks(stale, "ready", "de", NOW)[1]).toEqual(["Auto · 50 % · 200 km · lädt nicht · zu · alt"]);
    expect(briefBlocks(null, "unsupported", "de", NOW)[0]?.[0]).toContain("Daemon");
    expect(briefBlocks(undefined, "loading", "en", NOW)).toEqual([["", "Loading day start …"]]);
  });

  it("packs whole blocks onto pages of seven rows", () => {
    expect(briefPages([["a", "b", "c"], ["d", "e", "f"], ["g", "h"]])).toEqual([["a", "b", "c", "d", "e", "f"], ["g", "h"]]);
    expect(briefPages([])).toEqual([[]]);
    expect(briefPages([Array.from({ length: 9 }, (_, i) => String(i))])[0]).toHaveLength(7);
  });

  it("summary for the overview row", () => {
    expect(briefSummary(demoBrief("de", NOW), "de", NOW)).toBe("nächster 09:00 · 9° Regen ab 14:00");
    expect(briefSummary(null, "de", NOW)).toBe("Tippen zum Laden");
  });
});

/** Every block filled with the longest content it can have. */
function worstBrief(): Brief {
  const long = "Sehr langer Termin mit noch längerem Titel und Ortsangabe Salzburg Hauptbahnhof";
  return {
    at: NOW, date: "2026-10-14",
    calendar: { status: "ok", stale: true, total: 14, events: [{ title: long, allDay: true, startMs: at(0), endMs: at(23), start: "", end: "" }, ...Array.from({ length: 11 }, (_, i) => ev(`${long} ${i}`, 8 + i, 45, 75))] },
    weather: { status: "ok", stale: true, tempC: -12, code: 86, minC: -18, maxC: -10, rain: { kind: "now", from: "", until: "23:45", mm: 30 } },
    sugar: { status: "ok", stale: true, current: { mgdl: 401, direction: "FortyFiveDown", ageMin: 1440 }, night: { min: 39, max: 401, belowMin: 540, aboveMin: 540, count: 300 }, low: 70, high: 180 },
    car: { status: "ok", stale: true, soc: 100, rangeKm: 1000, charging: true, etaMin: 1440, locked: false },
    printer: { status: "ok", stale: true, state: "paused", file: "ein_sehr_langer_dateiname_fuer_ein_gehaeuse_v12_final_final", progress: 100, minutesLeft: 9999 },
    servers: { status: "ok", stale: true, machines: Array.from({ length: 8 }, (_, i) => ({ name: `server-mit-namen-${i}`, ok: i % 2 === 0, newDevices: 30 })), down: 4, newDevices: 240 },
  };
}

const onBrief = (brief: Brief | null, extra: Partial<HubModel> = {}): HubModel => ({ ...createModel(emptyReport("connected")), screen: "brief", brief, briefLoad: brief ? "ready" : "loading", ...extra });

describe("glasses layout fits", () => {
  const cases: [string, Brief | null][] = [["worst", worstBrief()], ["demo", demoBrief("de", NOW)], ["empty", empty()], ["none", null],
    ["errors", { ...empty(), calendar: { status: "error" }, weather: { status: "error" }, car: { status: "error" }, sugar: { status: "error" }, printer: { status: "error" }, servers: { status: "error" } }]];
  for (const locale of ["de", "en"] as Locale[]) {
    for (const [name, brief] of cases) {
      it(`${name} (${locale}): every page within 7 rows x ${ROW_WIDTH} characters`, () => {
        let model = onBrief(brief);
        const pages = briefPages(briefBlocks(brief, "ready", locale, NOW)).length;
        for (let page = 0; page < pages + 1; page += 1) {
          const view = buildView(model, locale, NOW);
          expect(view.body.length).toBeLessThanOrEqual(MAX_BODY_ROWS);
          for (const row of view.body) expect(row.length).toBeLessThanOrEqual(ROW_WIDTH);
          expect(view.header.length).toBeLessThanOrEqual(ROW_WIDTH);
          expect(view.footer.length).toBeLessThanOrEqual(ROW_WIDTH);
          model = decide(model, "scrollDown", NOW, locale).model;
        }
      });
    }
  }

  it("rows use explicit separators, never column padding", () => {
    for (const block of briefBlocks(demoBrief("de", NOW), "ready", "de", NOW)) for (const row of block) expect(row.trim()).not.toMatch(/\S {2,}\S/);
  });

  it("the worst case needs several pages and the footer says which", () => {
    const view = buildView(onBrief(worstBrief()), "de", NOW);
    expect(view.footer).toMatch(/^1\/\d · Tippen = laden · Wischen = blättern · 2× = zurück$/);
    expect(view.header).toMatch(/^QUIET HUB · Tagesstart · /);
  });
});

describe("Tagesstart page", () => {
  it("opens from the overview row and from the menu, asking the daemon", () => {
    const root = { ...createModel(demoReport("de")), rootSelected: ROOT_ITEMS.indexOf("brief") };
    const opened = decide(root, "click", NOW, "de");
    expect(opened.model.screen).toBe("brief");
    expect(opened.effect).toEqual({ kind: "brief", refresh: false });
    const viaMenu = applyMenu(createModel(demoReport("de")), MENU.brief, NOW, "de");
    expect(viaMenu.model.screen).toBe("brief");
    expect(viaMenu.effect).toEqual({ kind: "brief", refresh: false });
    expect(pickerEntries(root, "de").map((entry) => entry.screen)).toContain("brief");
    expect(buildView(root, "de", NOW).body[4]).toMatch(/^> Tagesstart — /);
  });

  it("swipe pages (clamped), tap and hold refresh, double tap back", () => {
    const model = onBrief(worstBrief());
    const next = decide(model, "scrollDown", NOW, "de").model;
    expect(next.briefPage).toBe(1);
    expect(decide(model, "scrollUp", NOW, "de").model.briefPage).toBe(0);
    const tap = decide(next, "click", NOW, "de");
    expect(tap.effect).toEqual({ kind: "brief", refresh: true });
    expect(buildView(tap.model, "de", NOW).footer).toBe("lädt neu …");
    expect(decide(next, "longPress", NOW, "de").effect).toEqual({ kind: "brief", refresh: true });
    expect(decide(next, "doubleClick", NOW, "de").model.screen).toBe("root");
    expect(menuFor(model, "de", true).items.map((item) => item.id)).toEqual([MENU.briefRefresh, MENU.overview, MENU.help]);
    expect(applyMenu(model, MENU.briefRefresh, NOW, "de").effect).toEqual({ kind: "brief", refresh: true });
  });

  it("answers: data, an old daemon, a failed refresh keeps the last data", () => {
    const loading = onBrief(null);
    expect(buildView(loading, "de", NOW).body).toContain("Tagesstart wird geladen …");
    const old = withBrief(loading, null, "unsupported", "de", NOW);
    expect(buildView(old, "de", NOW).body[0]).toContain("Daemon");
    const ready = withBrief(loading, demoBrief("de", NOW), "ready", "de", NOW);
    expect(buildView(ready, "de", NOW).body[0]).toBe("Termine · 4 heute");
    const failed = withBrief(ready, null, "error", "de", NOW);
    expect(failed.brief).toBe(ready.brief);
    expect(buildView(failed, "de", NOW).footer).toBe("Tagesstart nicht erreichbar.");
  });

  it("a report carries the brief; only a newer one replaces what is shown", () => {
    const shown = demoBrief("de", NOW);
    const model = onBrief(shown);
    const older = mergeReport(model, { ...emptyReport("connected"), brief: { ...shown, at: NOW - 1000, calendar: { status: "off" } } });
    expect(older.brief).toBe(shown);
    const newer = mergeReport(model, { ...emptyReport("connected"), brief: { ...shown, at: NOW + 1000 } });
    expect(newer.brief?.at).toBe(NOW + 1000);
    expect(mergeReport(model, { ...emptyReport("connected"), brief: null }).brief).toBe(shown);
  });
});

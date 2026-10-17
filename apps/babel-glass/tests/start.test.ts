import { describe, expect, it } from "vitest";
import { startBody, startRows, START_MODES } from "../src/glasses/start";
import { BODY_ROWS, buildView, POPUP_WIDTH, type ViewOptions } from "../src/glasses/view";
import { createBuffer } from "../src/captions/buffer";
import type { CustomerEntry } from "../src/companion/customers";
import { locales } from "../src/i18n";
import { t } from "../src/messages";

// 1.0.0: the start screen: three modes, the customers under "Gespräch", one hint row while no voice is trained.
const NOW = new Date(2026, 9, 14, 8, 0);
const entry = (id: string, name: string, date: string | null): CustomerEntry => ({ id, name, company: "", next: date ? { date, name: "P" } : null });
const customers = (n: number): CustomerEntry[] => Array.from({ length: n }, (_, i) => entry("c" + i, "Kunde " + String.fromCharCode(65 + i), null));

describe("start rows", () => {
  it("are exactly the three modes when there is no customer list", () => {
    for (const state of [{ state: "off" }, { state: "loading" }, { state: "failed" }] as const) {
      expect(startRows(state, NOW).map((row) => (row.kind === "mode" ? row.mode : "customer"))).toEqual(["translate", "learn", "client"]);
    }
    expect([...START_MODES]).toEqual(["translate", "learn", "client"]);
  });

  it("list the customers under Gespräch, today's first", () => {
    const rows = startRows({ state: "ready", entries: [entry("a", "Zeta", null), entry("b", "Alpha", "2026-10-14 09:00")] }, NOW);
    expect(rows.map((row) => (row.kind === "mode" ? row.mode : row.entry.name))).toEqual(["translate", "learn", "client", "Alpha", "Zeta"]);
  });

  it("an empty list adds nothing", () => {
    expect(startRows({ state: "ready", entries: [] }, NOW)).toHaveLength(3);
  });
});

describe("start body", () => {
  it("marks the cursor, indents customers, and names the modes in the UI language", () => {
    const rows = startRows({ state: "ready", entries: [entry("a", "Alpha", "2026-10-14 09:00")] }, NOW);
    expect(startBody(rows, 0, NOW, "de", POPUP_WIDTH, BODY_ROWS, false)).toEqual([
      "> Übersetzen", "  Englisch sprechen", "  Gespräch", "    Alpha · heute 09:00",
    ]);
    expect(startBody(rows, 3, NOW, "en", POPUP_WIDTH, BODY_ROWS, false)).toEqual([
      "  Translate", "  Speak English", "  Conversation", ">   Alpha · today 09:00",
    ]);
  });

  it("shows the voice hint as the last row while no voice is trained, never selectable", () => {
    const rows = startRows({ state: "off" }, NOW);
    for (const locale of locales) {
      const body = startBody(rows, 2, NOW, locale, POPUP_WIDTH, BODY_ROWS, true);
      expect(body).toHaveLength(4);
      expect(body.at(-1)).toBe(t(locale, "g.start.voiceHint"));
      expect(body.at(-1)!.startsWith("> ")).toBe(false);
      expect(body.filter((row) => row.startsWith("> "))).toHaveLength(1);
      expect(startBody(rows, 2, NOW, locale, POPUP_WIDTH, BODY_ROWS, false)).toHaveLength(3);
    }
    expect(t("de", "g.start.voiceHint")).toBe("Tipp: Stimme am Handy lernen");
  });

  it("long lists scroll so the cursor stays visible, the hint keeps its row; every row fits", () => {
    const rows = startRows({ state: "ready", entries: customers(12) }, NOW);
    for (const cursor of [0, 3, 8, rows.length - 1]) {
      const body = startBody(rows, cursor, NOW, "de", POPUP_WIDTH, BODY_ROWS, true);
      expect(body).toHaveLength(BODY_ROWS);
      expect(body.at(-1)).toBe("Tipp: Stimme am Handy lernen");
      expect(body.filter((row) => row.startsWith("> "))).toHaveLength(1);
      for (const row of body) expect([...row].length).toBeLessThanOrEqual(POPUP_WIDTH);
    }
    const last = startBody(rows, rows.length - 1, NOW, "de", POPUP_WIDTH, BODY_ROWS, true);
    expect(last[last.length - 2]).toBe(">   Kunde L");
  });

  it("a very long customer name is shortened with an ellipsis", () => {
    const rows = startRows({ state: "ready", entries: [entry("a", "Ein sehr langer Kundenname mit Zusatz ".repeat(3), "2026-11-02 10:00")] }, NOW);
    const body = startBody(rows, 3, NOW, "de", POPUP_WIDTH, BODY_ROWS, false);
    expect([...body[3]!].length).toBeLessThanOrEqual(POPUP_WIDTH);
    expect(body[3]).toContain("…");
  });
});

describe("start and running screens", () => {
  const base: ViewOptions = { mode: "conversation", listening: false, status: "ready", translating: false, offset: 0, mock: false, locale: "de" };

  it("the start screen is header, body, one hint row; no help, no hold", () => {
    const rows = startRows({ state: "off" }, NOW);
    const view = buildView(createBuffer(), { ...base, start: { rows: startBody(rows, 0, NOW, "de", POPUP_WIDTH, BODY_ROWS, true) } });
    expect(view.header).toBe("BABEL · Mikro aus");
    expect(view.footer).toBe("Tippen: Start · Wischen: wählen · 2×: Ende");
    expect(view.body.join("\n")).not.toMatch(/Hilfe|Halten|Meine Stimme|Personen/);
  });

  it("the running footer is one short line; it follows popup and history", () => {
    const running: ViewOptions = { ...base, listening: true, modeLabel: "Übersetzen" };
    expect(buildView(createBuffer(), running).footer).toBe("Tippen: Stopp · Wischen: zurück");
    expect(buildView(createBuffer(), { ...running, locale: "en" }).footer).toBe("Tap: stop · Swipe: back");
    expect(buildView(createBuffer(), { ...running, popup: { term: "JAZ", info: "x" } }).footer).toBe("Tippen: schließen");
    for (const locale of locales) {
      for (const key of ["g.f.start", "g.f.run", "g.f.runHistory", "g.f.popup"]) {
        expect([...t(locale, key)].length, key).toBeLessThanOrEqual(46);
      }
    }
  });

  it("the running header: mode, then ● live, offline or connecting; the demo marker stays", () => {
    const head = (over: Partial<ViewOptions>): string => buildView(createBuffer(), { ...base, listening: true, modeLabel: "Englisch sprechen", ...over }).header;
    expect(head({})).toBe("Englisch sprechen · ● live");
    expect(head({ status: "connecting" })).toBe("Englisch sprechen · ● verbinde …");
    expect(head({ status: "reconnecting" })).toBe("Englisch sprechen · ● offline");
    expect(head({ mock: true })).toBe("Englisch sprechen · ● live · DEMO");
    // No clock, no helper list: only the mode and the state.
    expect(head({ now: new Date(2026, 9, 14, 8, 0).getTime() })).toBe("Englisch sprechen · ● live");
  });
});

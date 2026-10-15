import { describe, expect, it } from "vitest";
import { applyTranscript, createBuffer, type CaptionBuffer } from "../src/captions/buffer";
import { armedFooter, footer, ROW_WIDTH } from "../src/glasses/footer";
import { buildView, GLASS_COLS, summaryRows, type CaptionView, type ViewOptions } from "../src/glasses/view";
import { messages, t } from "../src/messages";
import type { Locale } from "../src/i18n";
import { locales } from "../src/i18n";

// QIS v1: every footer is built in the fixed order, uses the glossary and fits the row; every header is "BABEL · state".

const chars = (text: string): number => [...text].length;
const WORDS = {
  de: ["Tippen", "Wischen", "Halten", "2×"],
  en: ["Tap", "Swipe", "Hold", "2×"],
} as const;
const BANNED = { de: /\b(Tap|Wisch|Doppeltipp)\b|2x/, en: /\b(Double tap)\b|2x/i } as const;

const line = (text: string): CaptionBuffer => applyTranscript(createBuffer(), { text, final: true }, 1);
const history = (): CaptionBuffer => {
  let buffer = createBuffer();
  for (let i = 0; i < 30; i++) buffer = applyTranscript(buffer, { text: "line " + i, final: true }, i);
  return buffer;
};

function everyView(locale: Locale): Array<[string, CaptionView]> {
  const base: ViewOptions = { mode: "conversation", listening: false, status: "ready", translating: false, offset: 0, mock: false, locale };
  const view = (buffer: CaptionBuffer, over: Partial<ViewOptions>): CaptionView => buildView(buffer, { ...base, ...over });
  const long = Array.from({ length: 14 }, (_, i) => "Punkt " + (i + 1) + " mit etwas längerem Text, der umbricht");
  const helpRows = Array.from({ length: 20 }, (_, i) => "Zeile " + (i + 1));
  const out: Array<[string, CaptionView]> = [
    ["idle", view(createBuffer(), {})],
    ["idle mock", view(createBuffer(), { mock: true })],
    ["notice mic", view(createBuffer(), { notice: { kind: "micDenied" } })],
    ["notice server", view(createBuffer(), { notice: { kind: "noServer" } })],
    ["notice limit", view(createBuffer(), { notice: { kind: "micLimit", minutes: 90 } })],
    ["summary working", view(createBuffer(), { summary: { state: "working" } })],
    ["summary error", view(createBuffer(), { summary: { state: "error", error: "timed out" } })],
    ["summary done", view(createBuffer(), { summary: { state: "done", short: ["Termin Dienstag"] } })],
    ["help", view(createBuffer(), { help: { rows: helpRows.slice(0, 5), page: 0 } })],
    ["help listening", view(createBuffer(), { listening: true, now: new Date(2026, 9, 14, 23, 59).getTime(), help: { rows: helpRows, page: 1 } })],
    ["listening", view(createBuffer(), { listening: true })],
    ["listening word finder", view(line("Hallo"), { listening: true, wordFinder: true })],
    ["listening mock", view(line("Hallo"), { listening: true, mock: true, wordFinder: true })],
    ["armed stop", view(line("Hallo"), { listening: true, armed: "stop", wordFinder: true })],
    ["popup", view(line("Hallo"), { listening: true, popup: { term: "JAZ", info: "Jahresarbeitszahl" } })],
    ["history", view(history(), { listening: true, offset: 10, wordFinder: true })],
  ];
  for (let page = 0; page < 3; page++) {
    out.push([`summary page ${page}`, view(createBuffer(), { summaryPage: page, summary: { state: "done", short: long.slice(0, 3), long } })]);
  }
  for (const error of ["timed out", "unreachable", "a very long raw error message from somewhere deep in the network stack"]) {
    out.push(["worst " + error, view(history(), {
      listening: true, translating: true, translateError: error, status: "reconnecting", mock: true, offset: 10, wordFinder: true,
      now: new Date(2026, 9, 14, 23, 59).getTime(), active: { pair: "RU→DE", speakers: true, replies: true, own: true, info: true, memory: true },
    })]);
  }
  return out;
}

describe("footers follow QIS v1", () => {
  for (const locale of locales) {
    it(`every view: header, order, glossary, width (${locale})`, () => {
      const [tap, swipe, hold, double] = WORDS[locale];
      for (const [name, view] of everyView(locale)) {
        const row = view.footer;
        const label = `${name}: ${row}`;
        expect(view.header, name).toMatch(/^BABEL · \S/);
        expect(chars(view.header), name).toBeLessThanOrEqual(GLASS_COLS);
        expect(chars(row), label).toBeLessThanOrEqual(ROW_WIDTH);
        expect(row, label).not.toMatch(BANNED[locale]);
        const armed = row.startsWith(locale === "de" ? "Nochmal tippen = " : "Tap again = ");
        if (armed) {
          expect(row, label).toMatch(locale === "de" ? /^Nochmal tippen = .+ · (Wischen\/)?2× = abbrechen$/ : /^Tap again = .+ · (Swipe\/)?2× = cancel$/);
          continue;
        }
        // Tippen -> Wischen -> Halten -> 2x, and the 2x part is never dropped.
        const at = [tap, swipe, hold, double].map((word) => row.indexOf(word + " =")).filter((index) => index >= 0);
        expect(at, label).toEqual([...at].sort((a, b) => a - b));
        expect(row, label).toMatch(locale === "de" ? /2× = (zurück|Ende)$/ : /2× = (back|exit)$/);
      }
    });
  }

  it("the microphone indicator stays in the header whenever the microphone is open", () => {
    for (const locale of locales) {
      for (const [name, view] of everyView(locale)) {
        const open = /^(listening|armed stop|popup|history|worst)/.test(name) || name === "help listening";
        if (open) expect(view.header.startsWith("BABEL · " + (name === "help listening" ? messages[locale]["g.s.help"] + " · " : "") + messages[locale]["g.mic"]), name).toBe(true);
        else expect(view.header, name).not.toContain(messages[locale]["g.mic"]!);
      }
    }
  });

  it("a tap never stops running captions in one go: the footer arms first", () => {
    const base: ViewOptions = { mode: "conversation", listening: true, status: "ready", translating: false, offset: 0, mock: false, locale: "de", wordFinder: true };
    expect(buildView(line("Hallo"), base).footer).toBe("Tippen = Stopp · Halten = Wort · 2× = Ende");
    const armed = buildView(line("Hallo"), { ...base, armed: "stop" });
    expect(armed.header).toBe("BABEL · ● MIKRO · Stopp?");
    expect(armed.footer).toBe("Nochmal tippen = stoppen · 2× = abbrechen");
    expect(buildView(line("Hallo"), { ...base, locale: "en", armed: "stop" }).footer).toBe("Tap again = stop · Swipe/2× = cancel");
  });

  it("an armed stop only counts while captions run", () => {
    const base: ViewOptions = { mode: "conversation", listening: false, status: "ready", translating: false, offset: 0, mock: false, locale: "de" };
    expect(buildView(createBuffer(), { ...base, armed: "stop" }).footer).toBe("Tippen = Start · Halten = Hilfe · 2× = Ende");
  });

  it("2× is zurück on the help page and when a popup is open, Ende on the main screens", () => {
    const base: ViewOptions = { mode: "conversation", listening: false, status: "ready", translating: false, offset: 0, mock: false, locale: "de" };
    expect(buildView(createBuffer(), base).footer).toMatch(/2× = Ende$/);
    expect(buildView(createBuffer(), { ...base, help: { rows: ["a"], page: 0 } }).footer).toBe("Seite 1/1 · Tippen = schließen · 2× = zurück");
    expect(buildView(line("x"), { ...base, listening: true, popup: { term: "JAZ", info: "x" } }).footer).toBe("Tippen = schließen · 2× = zurück");
  });

  it("no footer or help text offers clearing on the glasses (0.6.1)", () => {
    const base: ViewOptions = { mode: "conversation", listening: false, status: "ready", translating: false, offset: 0, mock: false, locale: "en" };
    expect(buildView(createBuffer(), base).footer).toBe("Tap = start · Hold = help · 2× = exit");
    for (const locale of ["de", "en"] as const) {
      const summary = buildView(createBuffer(), { ...base, locale, summary: { state: "done", short: ["Termin Dienstag"] } });
      expect(summary.footer).not.toMatch(/lösch|clear/i);
      for (const n of [1, 2, 3, 4, 5]) expect(t(locale, "g.hg." + n)).not.toMatch(/lösch|clear/i);
    }
  });

  it("the phone confirm text for clearing exists in every language (0.6.1)", () => {
    for (const locale of locales) expect(messages[locale]["p.clearConfirm"]).toBeTruthy();
  });

  it("keeps the swipe on a paged summary and the page counter in the header", () => {
    const base: ViewOptions = { mode: "conversation", listening: false, status: "ready", translating: false, offset: 0, mock: false, locale: "de" };
    const long = Array.from({ length: 14 }, (_, i) => "Punkt " + (i + 1) + " mit etwas längerem Text, der umbricht");
    const pages = Math.ceil(summaryRows(long.slice(0, 3), long).length / 7);
    const view = buildView(createBuffer(), { ...base, summaryPage: 1, summary: { state: "done", short: long.slice(0, 3), long } });
    expect(view.header).toBe(`BABEL · Zusammenfassung · 2/${pages}`);
    expect(view.footer).toBe("Tippen = weiter · Wischen = Seite · 2× = Ende");
  });

  it("drops the swipe part first when a row would be too wide, never the 2× part", () => {
    const wide = footer("de", { tap: "Stopp", swipe: "Verlauf", hold: "Wortfinder" }, "exit");
    expect(chars(wide)).toBeLessThanOrEqual(ROW_WIDTH);
    expect(wide).not.toContain("Wischen");
    expect(wide).toMatch(/2× = Ende$/);
    expect(chars(armedFooter("de", "Mitschrift löschen"))).toBeLessThanOrEqual(ROW_WIDTH);
  });

  it("uses the glossary in every glasses and gesture string", () => {
    for (const locale of locales) {
      for (const [key, text] of Object.entries(messages[locale])) {
        if (key.startsWith("g.") || key.startsWith("p.tap") || key.startsWith("p.hold") || key.startsWith("p.double")) {
          expect(text, key).not.toMatch(BANNED[locale]);
        }
      }
    }
  });
});

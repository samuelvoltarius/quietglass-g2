import { describe, expect, it } from "vitest";
import { deriveRaw } from "../src/car/derive";
import { demoTelemetry, type DemoScene } from "../src/car/demo";
import { parseState, type CarState } from "../src/car/model";
import { armedFooter, footer } from "../src/glasses/footer";
import { buildView, errorReason, HEADER_WIDTH, ROW_WIDTH, type ViewState } from "../src/glasses/views";
import { messages } from "../src/messages";
import { CONTROL_ITEMS, INITIAL_CONTROL, PAGES, tapControl, type ControlState, type Page } from "../src/pages";
import type { Locale } from "../src/i18n";

// QIS v1: every footer in the app is built in the fixed order, uses the glossary and fits the row.

const car = (scene: DemoScene, over: Record<string, unknown> = {}): CarState => parseState({
  ...deriveRaw(demoTelemetry(scene, 1_000), 1, {}),
  rev: 1,
  control: { enabled: true, lock: true, unlock: true, climate_temp: true },
  ...over,
});

const base = (locale: Locale, page: Page, c: CarState | null, extra: Partial<ViewState> = {}): ViewState => ({
  locale, demo: false, connection: { kind: "ok" }, car: c, page, control: INITIAL_CONTROL, overlay: null, local: null, now: 1_000, ...extra,
});

const WORDS = {
  de: ["Tippen", "Wischen", "Halten", "2×"],
  en: ["Tap", "Swipe", "Hold", "2×"],
} as const;
const BANNED = { de: /\b(Tap|Wisch|Doppeltipp)\b|2x|Doppel/, en: /\b(Double tap)\b|2x/i } as const;

function everyView(locale: Locale): Array<[string, ReturnType<typeof buildView>]> {
  const parked = car("parked");
  const warn = car("warn");
  const views: Array<[string, ReturnType<typeof buildView>]> = [];
  for (const page of PAGES) {
    views.push([`${page} parked`, buildView(base(locale, page, parked))]);
    views.push([`${page} warnings`, buildView(base(locale, page, warn))]);
    views.push([`${page} drive`, buildView(base(locale, page, car("drive")))]);
    views.push([`${page} no car`, buildView(base(locale, page, null, { connection: { kind: "loading" } }))]);
    views.push([`${page} offline`, buildView(base(locale, page, null, { connection: { kind: "error", code: "unreachable" } }))]);
  }
  views.push(["overlay", buildView(base(locale, "drive", warn, { overlay: warn.warnings }))]);
  for (const page of PAGES) views.push([`${page} demo`, buildView(base(locale, page, warn, { demo: true }))]);
  views.push(["help", buildView(base(locale, "drive", parked, { help: true }))]);
  views.push(["help without car", buildView(base(locale, "drive", null, { help: true }))]);
  for (const item of CONTROL_ITEMS) {
    let control: ControlState = { ...INITIAL_CONTROL, cursor: CONTROL_ITEMS.indexOf(item), temp: 28 };
    for (let step = 0; step < 3; step += 1) {
      control = tapControl(control, 1_000 + step * 100, parked, parked.control).state;
      for (const now of [1_000 + step * 100, 1_000 + step * 100 + 1_500]) {
        views.push([`${item} step ${step}`, buildView(base(locale, "control", parked, { control, now }))]);
      }
    }
  }
  return views;
}

describe("footers follow QIS v1", () => {
  for (const locale of ["de", "en"] as const) {
    it(`every view: header, order, glossary, width (${locale})`, () => {
      const [tap, swipe, hold, double] = WORDS[locale];
      for (const [name, view] of everyView(locale)) {
        const row = view.footer;
        const label = `${name}: ${row}`;
        expect(view.header, name).toMatch(/^BYD · /);
        expect(view.header.length, name).toBeLessThanOrEqual(HEADER_WIDTH);
        expect(row.length, label).toBeLessThanOrEqual(ROW_WIDTH);
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

  it("a car command stays behind two confirmations whose footers name the send", () => {
    const parked = car("parked");
    const first = tapControl({ ...INITIAL_CONTROL, cursor: CONTROL_ITEMS.indexOf("lock") }, 1_000, parked, parked.control).state;
    const final = tapControl(first, 2_000, parked, parked.control).state;
    expect(buildView(base("de", "control", parked, { control: first, now: 2_000 })).footer).toBe("Nochmal tippen = weiter · Wischen/2× = abbrechen");
    expect(buildView(base("de", "control", parked, { control: final, now: 3_500 })).footer).toBe("Nochmal tippen = SENDEN · Wischen/2× = abbrechen");
    expect(buildView(base("en", "control", parked, { control: final, now: 3_500 })).footer).toBe("Tap again = SEND · Swipe/2× = cancel");
  });

  it("ends in 2× = Ende on the pages and 2× = zurück on help and the warning overlay", () => {
    const parked = car("parked");
    expect(buildView(base("de", "status", parked)).footer).toMatch(/2× = Ende$/);
    expect(buildView(base("de", "status", parked, { help: true })).footer).toBe("2× = zurück");
    expect(buildView(base("en", "status", parked, { help: true })).footer).toBe("2× = back");
    const warn = car("warn");
    expect(buildView(base("de", "status", warn, { overlay: warn.warnings })).footer).toBe("Tippen = ok · 2× = zurück");
  });

  it("offers the tap on the pages only when there is something to show", () => {
    expect(buildView(base("de", "status", car("parked"))).footer).toBe("Wischen = Seite · Halten = Hilfe · 2× = Ende");
    expect(buildView(base("de", "status", car("warn"))).footer).toBe("Tippen = Warnungen · Halten = Hilfe · 2× = Ende");
  });

  it("without the side menu the root pages offer Halten = Hilfe again (step log 15.10.)", () => {
    expect(buildView(base("en", "status", car("parked"))).footer).toBe("Swipe = page · Hold = help · 2× = exit");
    expect(buildView(base("de", "control", car("parked"))).footer).toContain("Halten = Hilfe");
  });

  it("QIS v1.2 #7: the demo leads with the one-line hint and keeps 2× = Ende", () => {
    const parked = buildView(base("de", "status", car("parked"), { demo: true }));
    expect(parked.footer).toBe("Demo · Verbindung am Handy einrichten · 2× = Ende");
    const en = buildView(base("en", "drive", car("warn"), { demo: true }));
    expect(en.footer).toBe("Demo · set up the connection on the phone · 2× = exit");
    // The control list keeps its gestures: the wearer must see what a tap does.
    expect(buildView(base("de", "control", car("parked"), { demo: true })).footer).toContain("Tippen = wählen");
  });

  it("QIS v1.2 #8: no HTTP status on the glasses, the phone gets it", () => {
    const view = buildView(base("de", "status", null, { connection: { kind: "error", code: "http", status: 503 } }));
    expect(view.body.join(" ")).not.toMatch(/503/);
    expect(view.body.join(" ")).toContain("Serverfehler");
    expect(errorReason("de", "http", 503)).toBe("Serverfehler");
    expect(errorReason("de", "http", 503, true)).toBe("Serverfehler (503)");
  });

  it("drops the swipe part first when a row would be too wide, never the 2× part", () => {
    const wide = footer("de", { tap: "Warnungen anzeigen", swipe: "nächste Seite", hold: "Hilfe" }, "exit");
    expect(wide.length).toBeLessThanOrEqual(ROW_WIDTH);
    expect(wide).not.toContain("Wischen");
    expect(wide).toMatch(/2× = Ende$/);
    expect(armedFooter("de", "SENDEN").length).toBeLessThanOrEqual(ROW_WIDTH);
  });

  it("uses the glossary in every glasses string", () => {
    for (const locale of ["de", "en"] as const) {
      for (const [key, text] of Object.entries(messages[locale])) {
        if (key.startsWith("g.") || key.startsWith("p.c.") || key.startsWith("p.rule.")) expect(text, key).not.toMatch(BANNED[locale]);
      }
    }
  });

  it("help lists the gestures in footer order", () => {
    const body = buildView(base("de", "status", car("parked"), { help: true })).body;
    const at = ["Tippen", "Wischen", "Halten", "2×"].map((word) => body.findIndex((row) => row.startsWith(word)));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    for (const row of body) expect(row.length).toBeLessThanOrEqual(ROW_WIDTH);
  });
});

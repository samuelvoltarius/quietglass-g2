import { describe, expect, it } from "vitest";
import { deriveRaw } from "../src/car/derive";
import { demoTelemetry, type DemoScene } from "../src/car/demo";
import { parseState, type CarState } from "../src/car/model";
import { footer } from "../src/glasses/footer";
import { buildView, errorReason, HEADER_WIDTH, ROW_WIDTH, type ViewState } from "../src/glasses/views";
import { messages } from "../src/messages";
import { INITIAL_CONTROL, PAGES, type Page } from "../src/pages";
import type { Locale } from "../src/i18n";

// QIS v1: every footer in the app is built in the fixed order, uses the glossary and fits the row.

const car = (scene: DemoScene, over: Record<string, unknown> = {}): CarState => parseState({
  ...deriveRaw(demoTelemetry(scene, 1_000), 1, {}),
  rev: 1,
  ...over,
});

const base = (locale: Locale, page: Page, c: CarState | null, extra: Partial<ViewState> = {}): ViewState => ({
  locale, demo: false, connection: { kind: "ok" }, car: c, page, overlay: null, now: 1_000, ...extra,
});

const WORDS = {
  de: ["Tippen", "Wischen", "Halten", "2×"],
  en: ["Tap", "Swipe", "Hold", "2×"],
} as const;
/** A footer or help row that offers a vehicle command (only the control page may, 0.7.0). */
const COMMAND = /sperr|entriegel|unlock|lock|senden|send|klima an|climate on|°C|wählen|choose/i;
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
  // The control page (bridge with control on): plain, armed, busy.
  const ctl = car("parked", { control: { enabled: true, lock: true, unlock: true, preheat: true, preheat_minutes: [10, 20, 30], car_off: true } });
  for (const cursor of [0, 1, 2, 3, 4]) views.push([`control ${cursor}`, buildView(base(locale, "control", ctl, { control: { ...INITIAL_CONTROL, cursor } }))]);
  for (const item of ["lock", "unlock", "preheat10", "preheat30"] as const) {
    views.push([`control armed ${item}`, buildView(base(locale, "control", ctl, { control: { ...INITIAL_CONTROL, armed: { item, token: "t", until: 5_000 } } }))]);
  }
  views.push(["control busy", buildView(base(locale, "control", ctl, { control: { ...INITIAL_CONTROL, busy: { item: "lock", step: "arm" } } }))]);
  views.push(["help", buildView(base(locale, "drive", parked, { help: true }))]);
  views.push(["help without car", buildView(base(locale, "drive", null, { help: true }))]);
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
        // No hold anywhere: from the temple a hold never reaches the app (step log 21.10.).
        expect(row, label).not.toMatch(locale === "de" ? /Halten/ : /Hold/);
        if (name.startsWith("control armed")) {
          // The second tap: "Nochmal tippen = <entry> · Wischen/2× = abbrechen".
          expect(row, label).toMatch(locale === "de" ? /^Nochmal tippen = .+ · (Wischen\/)?2× = abbrechen$/ : /^Tap again = .+ · (Swipe\/)?2× = cancel$/);
          continue;
        }
        // Only the control page offers a command.
        if (!name.startsWith("control")) expect(row, label).not.toMatch(COMMAND);
        // Tippen -> Wischen -> Halten -> 2x, and the 2x part is never dropped.
        const at = [tap, swipe, hold, double].map((word) => row.indexOf(word + " =")).filter((index) => index >= 0);
        expect(at, label).toEqual([...at].sort((a, b) => a - b));
        expect(row, label).toMatch(locale === "de" ? /2× = (zurück|Ende)$/ : /2× = (back|exit)$/);
      }
    });
  }

  it("ends in 2× = Ende on the pages and 2× = zurück on help and the warning overlay", () => {
    const parked = car("parked");
    expect(buildView(base("de", "status", parked)).footer).toMatch(/2× = Ende$/);
    expect(buildView(base("de", "status", parked, { help: true })).footer).toBe("2× = zurück");
    expect(buildView(base("en", "status", parked, { help: true })).footer).toBe("2× = back");
    const warn = car("warn");
    expect(buildView(base("de", "status", warn, { overlay: warn.warnings })).footer).toBe("Tippen = ok · 2× = zurück");
  });

  it("offers the tap on the pages only when there is something to show", () => {
    expect(buildView(base("de", "status", car("parked"))).footer).toBe("Wischen = Seite · 2× = Ende");
    expect(buildView(base("de", "status", car("warn"))).footer).toBe("Tippen = Warnungen · Wischen = Seite · 2× = Ende");
    expect(buildView(base("en", "status", car("parked"))).footer).toBe("Swipe = page · 2× = exit");
  });

  it("QIS v1.2 #7: the demo leads with the one-line hint and keeps 2× = Ende", () => {
    const parked = buildView(base("de", "status", car("parked"), { demo: true }));
    expect(parked.footer).toBe("Demo · Verbindung am Handy einrichten · 2× = Ende");
    const en = buildView(base("en", "drive", car("warn"), { demo: true }));
    expect(en.footer).toBe("Demo · set up the connection on the phone · 2× = exit");
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
  });

  it("uses the glossary in every glasses string", () => {
    for (const locale of ["de", "en"] as const) {
      for (const [key, text] of Object.entries(messages[locale])) {
        if (key.startsWith("g.") || key.startsWith("p.c.")) expect(text, key).not.toMatch(BANNED[locale]);
      }
    }
  });

  it("help lists the gestures in footer order and offers no command and no hold", () => {
    for (const locale of ["de", "en"] as const) {
      const body = buildView(base(locale, "status", car("parked"), { help: true })).body;
      const [tap, swipe, , double] = WORDS[locale];
      const at = [tap, swipe, double].map((word) => body.findIndex((row) => row.startsWith(word)));
      expect(at.every((index) => index >= 0)).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => a - b));
      for (const row of body) {
        expect(row.length).toBeLessThanOrEqual(ROW_WIDTH);
        expect(row).not.toMatch(COMMAND);
        expect(row).not.toMatch(locale === "de" ? /Halten/ : /Hold/);
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import { deriveRaw } from "../src/car/derive";
import { demoTelemetry, type DemoScene } from "../src/car/demo";
import { parseState, type CarState } from "../src/car/model";
import { buildView, HEADER_WIDTH, ROW_WIDTH, ROWS, type Connection, type ViewState } from "../src/glasses/views";
import { COCKPIT_TILES } from "../src/glasses/render";
import { MAX_BODY_ROWS } from "../src/glasses/screen";
import { ARM_MS, CONTROL_ITEMS, INITIAL_CONTROL, PAGES, tapControl, type ControlState, type Page } from "../src/pages";
import type { Locale } from "../src/i18n";

function car(scene: DemoScene, over: Record<string, unknown> = {}): CarState {
  return parseState({
    ...deriveRaw(demoTelemetry(scene, 1_000), 1, {}),
    rev: 1,
    control: { enabled: true, lock: true, unlock: false, climate_temp: false },
    ...over,
  });
}

/** Worst case: every warning at once, long numbers, stale, a refused command. */
function worst(): CarState {
  const base = car("warn");
  return {
    ...base,
    stale: true,
    ageS: 7_200,
    drive: { ...base.drive, speed: 188, cons50: 288.8, tripKm: 1234.5, gear: "D" },
    battery: { ...base.battery, soc: 100, rangeKm: 1000, cellTMin: -20, cellTMax: 55, volt12: 11.1, soh: 100, src: "cloud", cloudAgeMin: 999, odometerKm: 999999 },
    charge: { active: true, dc: true, kw: 150, etaMin: 599, kwh: 100.5, done: false },
    body: { ...base.body, extTemp: -25, setpoint: 28, lockSrc: "cloud", locked: false },
    command: { id: "c1", action: "climate_on", value: 28, status: "timeout", text: "", at: 0, note: null },
  };
}

const state = (locale: Locale, page: Page, c: CarState | null, extra: Partial<ViewState> = {}): ViewState => ({
  locale, demo: true, connection: { kind: "ok" }, car: c, page, control: INITIAL_CONTROL, overlay: null, local: null, now: 1_000, ...extra,
});

describe("views fit the display", () => {
  const cases: Array<[string, CarState | null, Connection]> = [
    ["drive", car("drive"), { kind: "ok" }],
    ["charge", car("charge"), { kind: "ok" }],
    ["parked", car("parked"), { kind: "ok" }],
    ["worst", worst(), { kind: "error", code: "auth", status: 401 }],
    ["waiting", null, { kind: "loading" }],
    ["offline", null, { kind: "error", code: "unreachable" }],
  ];
  for (const locale of ["de", "en"] as const) {
    for (const [name, c, connection] of cases) {
      for (const page of PAGES) {
        it(`${locale} ${name} ${page}`, () => {
          for (const now of [1_000, 1_600]) {
            const s = state(locale, page, c, { connection, now });
            const view = buildView(s);
            expect(view.header.length).toBeLessThanOrEqual(HEADER_WIDTH);
            expect(view.footer.length).toBeLessThanOrEqual(ROW_WIDTH);
            expect(view.body.length).toBeLessThanOrEqual(ROWS[view.layout]);
            for (const row of view.body) expect(row.length).toBeLessThanOrEqual(ROW_WIDTH);
            // Long texts are never cut on the waiting page.
            if (!c) expect(view.body.join(" ")).not.toContain("…");
            if (view.layout === "cockpit") {
              // The cockpit page: four tiles of 288 x 144 over the whole display.
              expect(COCKPIT_TILES).toHaveLength(4);
              for (const tile of COCKPIT_TILES) { expect(tile.width).toBe(288); expect(tile.height).toBe(144); expect(tile.x + tile.width).toBeLessThanOrEqual(576); expect(tile.y + tile.height).toBeLessThanOrEqual(288); }
            }
          }
        });
      }
    }
  }
});

describe("page content", () => {
  it("drive, charge and status are the cockpit layout with the gesture footer; the header keeps the summary", () => {
    for (const [page, scene] of [["drive", "drive"], ["charge", "charge"], ["status", "parked"]] as const) {
      const view = buildView(state("de", page, car(scene)));
      expect(view.layout).toBe("cockpit");
      expect(view.body).toEqual([]);
      expect(view.footer.endsWith("2× = Ende")).toBe(true);
    }
    expect(buildView(state("de", "drive", car("drive"))).header).toMatch(/^BYD · FAHRT · D · 58 % · 172 km · DEMO$/);
  });

  it("a critical warning pulses in the header", () => {
    const a = buildView(state("de", "drive", car("warn"), { now: 0 })).header;
    const b = buildView(state("de", "drive", car("warn"), { now: 500 })).header;
    expect(a).toContain("!! REIFEN HR VERLIERT DRUCK");
    expect(b).not.toContain("!!");
  });

  it("the overlay lists all warnings over any page", () => {
    const c = car("warn");
    const view = buildView(state("de", "control", c, { overlay: c.warnings }));
    expect(view.layout).toBe("plain");
    expect(view.header).toContain("ACHTUNG · 4");
    expect(view.body.join("\n")).toContain("Reifen hinten rechts: Druckverlust");
    expect(view.footer).toBe("Tippen = ok · 2× = zurück");
  });

  it("control: list with cursor, mapped temperature, refused unlock", () => {
    const c = car("parked");
    const view = buildView(state("de", "control", c));
    expect(view.body[0]).toBe("> Zusperren");
    expect(view.body[1]).toBe("  Aufsperren – nicht eingerichtet");
    expect(view.body[2]).toBe("  Klima an 21° (sendet 19°)");
    expect(view.footer).toBe("Tippen = wählen · Halten = Hilfe · 2× = Ende");
  });

  it("control: the confirmation screens differ, the final one waits before it accepts a tap", () => {
    const c = car("parked", { control: { enabled: true, lock: true, unlock: true, climate_temp: true } });
    const unlock = { ...INITIAL_CONTROL, cursor: CONTROL_ITEMS.indexOf("unlock") };
    const first = tapControl(unlock, 1_000, c, c.control).state;
    let view = buildView(state("de", "control", c, { control: first, now: 1_100 }));
    expect(view.header).toMatch(/^BYD · STEUERUNG · Rückfrage 1\/2/);
    expect(view.body[0]).toBe("Wirklich aufsperren?");
    expect(view.footer).toBe("Nochmal tippen = weiter · Wischen/2× = abbrechen");
    const final = tapControl(first, 2_000, c, c.control).state;
    view = buildView(state("de", "control", c, { control: final, now: 2_100 }));
    expect(view.header).toMatch(/^BYD · !! LETZTE BESTÄTIGUNG · 2\/2 !!/);
    expect(view.body.join("\n")).toContain(">>>  AUFSPERREN  <<<");
    expect(view.body[6]).toBe("(kurz warten)");
    view = buildView(state("de", "control", c, { control: final, now: 2_000 + ARM_MS }));
    expect(view.body[6]).toBe("Tippen = senden · 2× = abbrechen");
    expect(view.footer).toBe("Nochmal tippen = SENDEN · Wischen/2× = abbrechen");
    // Climate on starts with the temperature.
    const temp = tapControl({ ...INITIAL_CONTROL, cursor: CONTROL_ITEMS.indexOf("climate_on"), temp: 23 }, 1_000, c, c.control).state;
    view = buildView(state("en", "control", c, { control: temp, now: 1_100 }));
    expect(view.body[0]).toBe("Climate on – choose temperature");
    expect(view.body.join("\n")).toContain("23 °C");
  });

  it("control: every confirmation screen fits in both languages, worst case", () => {
    const c = { ...worst(), control: { enabled: true, lock: true, unlock: true, climateTemp: false }, stale: false, mode: "parked" as const, drive: { ...worst().drive, speed: 0 } };
    for (const locale of ["de", "en"] as const) {
      for (const item of CONTROL_ITEMS) {
        let s: ControlState = { ...INITIAL_CONTROL, cursor: CONTROL_ITEMS.indexOf(item), temp: 28 };
        for (let i = 0; i < 3; i += 1) {
          s = tapControl(s, 1_000 + i * 100, c, c.control).state;
          for (const now of [1_000 + i * 100, 1_000 + i * 100 + ARM_MS]) {
            const view = buildView(state(locale, "control", c, { control: s, now }));
            expect(view.header.length).toBeLessThanOrEqual(HEADER_WIDTH);
            expect(view.footer.length).toBeLessThanOrEqual(ROW_WIDTH);
            expect(view.body.length).toBeLessThanOrEqual(ROWS.plain);
            for (const row of view.body) { expect(row.length).toBeLessThanOrEqual(ROW_WIDTH); expect(row).not.toContain("…"); }
          }
        }
      }
    }
  });

  it("control: car on disables everything with a banner", () => {
    const c = car("parked", { car_on: true });
    const view = buildView(state("de", "control", c));
    expect(view.body[0]).toBe("Auto ist an – Steuerung nur bei ausgeschaltetem Auto");
    expect(view.body.slice(2, 6)).toEqual([
      "> Zusperren – gesperrt", "  Aufsperren – gesperrt", "  Klima an 21° (sendet 19°) – gesperrt", "  Klima aus – gesperrt",
    ]);
    expect(view.body.length).toBeLessThanOrEqual(7);
  });

  it("control: shows the command result from the bridge", () => {
    const c = car("parked", { command: { id: "c1", action: "climate_off", status: "busy", text: "⏳ BYD beschäftigt", at: 900 } });
    const view = buildView(state("de", "control", c));
    expect(view.body[5]).toBe("Klima aus: BYD beschäftigt – in 2 min nochmal");
  });

  it("body rows never exceed the plain page", () => {
    expect(ROWS.plain).toBe(MAX_BODY_ROWS);
  });
});

import { describe, expect, it } from "vitest";
import { deriveRaw } from "../src/car/derive";
import { demoTelemetry, type DemoScene } from "../src/car/demo";
import { parseState, type CarState } from "../src/car/model";
import { buildView, HEADER_WIDTH, ROW_WIDTH, ROWS, type Connection, type ViewState } from "../src/glasses/views";
import { COCKPIT_TILES } from "../src/glasses/render";
import { MAX_BODY_ROWS } from "../src/glasses/screen";
import { PAGES, type Page } from "../src/pages";
import type { Locale } from "../src/i18n";

function car(scene: DemoScene, over: Record<string, unknown> = {}): CarState {
  return parseState({
    ...deriveRaw(demoTelemetry(scene, 1_000), 1, {}),
    rev: 1,
    ...over,
  });
}

/** Worst case: every warning at once, long numbers, stale. */
function worst(): CarState {
  const base = car("warn");
  return {
    ...base,
    stale: true,
    ageS: 7_200,
    drive: { ...base.drive, speed: 188, cons50: 288.8, tripKm: 1234.5, gear: "D" },
    battery: { ...base.battery, soc: 100, rangeKm: 1000, cellTMin: -20, cellTMax: 55, volt12: 11.1, soh: 100, src: "cloud", cloudAgeMin: 999, odometerKm: 999999 },
    charge: { active: true, dc: true, kw: 150, etaMin: 599, kwh: 100.5, done: false },
    body: { ...base.body, extTemp: -25, acOn: true, acFan: 7, lockSrc: "cloud", locked: false, trunkOpen: true, hoodOpen: true },
  };
}

const state = (locale: Locale, page: Page, c: CarState | null, extra: Partial<ViewState> = {}): ViewState => ({
  locale, demo: true, connection: { kind: "ok" }, car: c, page, overlay: null, now: 1_000, ...extra,
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
    const view = buildView(state("de", "status", c, { overlay: c.warnings }));
    expect(view.layout).toBe("plain");
    expect(view.header).toContain("ACHTUNG · 4");
    expect(view.body.join("\n")).toContain("Reifen hinten rechts: Druckverlust");
    expect(view.footer).toBe("Tippen = ok · 2× = zurück");
  });

  it("control off at the bridge: no view offers a command, the control page falls back to the cockpit", () => {
    const c = car("parked", { car_on: true, control: { enabled: false, lock: true, unlock: true }, command: { id: "c1", action: "lock", status: "sent", at: 900 } });
    expect(c.control.enabled).toBe(false);
    for (const locale of ["de", "en"] as const) {
      for (const page of PAGES) {
        const view = buildView(state(locale, page, c));
        expect([view.header, ...view.body, view.footer].join(" ")).not.toMatch(/zusperr|aufsperr|unlock|\block\b|senden|send|klima an|climate on|steuer|control|vorheiz|preheat/i);
      }
    }
  });

  it("a status header without a known lock leaves the lock out", () => {
    const c = car("parked");
    const view = buildView(state("de", "status", { ...c, body: { ...c.body, locked: null } }));
    expect(view.header).toMatch(/^BYD · STATUS · 64 % · DEMO$/);
  });

  it("body rows never exceed the plain page", () => {
    expect(ROWS.plain).toBe(MAX_BODY_ROWS);
  });
});

import { describe, expect, it } from "vitest";
import { buildFrames, buildView, HEADER_WIDTH, PAGES, ROW_WIDTH, type Connection, type ViewState } from "../src/glasses/views";
import { createDemo, DEMO_SCENES, demoPump, demoReadings, demoTreatments } from "../src/ns/demo";
import { DEFAULT_LIMITS } from "../src/ns/alerts";
import { bitmapKey } from "../src/glasses/gfx";
import { MAX_BODY_ROWS } from "../src/glasses/screen";
import type { Locale } from "../src/i18n";
import type { Unit } from "../src/ns/units";

const NOW = Date.parse("2026-10-13T12:02:30Z");

function state(over: Partial<ViewState> = {}): ViewState {
  return {
    locale: "de", demo: false, connection: { kind: "ok" },
    data: { readings: demoReadings("normal", NOW), pump: demoPump("normal", NOW), treatments: demoTreatments(NOW) },
    page: "glucose", help: false, unit: "mgdl", limits: DEFAULT_LIMITS, now: NOW, ...over,
  };
}

describe("every view fits its rows", () => {
  const locales: Locale[] = ["de", "en"];
  const units: Unit[] = ["mgdl", "mmol"];
  const connections: Connection[] = [{ kind: "ok" }, { kind: "error", code: "bad-reply" }, { kind: "error", code: "http", status: 503 }];
  for (const locale of locales) for (const unit of units) for (const scene of DEMO_SCENES) for (const page of PAGES) for (const connection of connections) {
    it(`${locale} ${unit} ${scene} ${page} ${connection.kind}`, () => {
      const s = state({
        locale, unit, page, connection, demo: true,
        data: { readings: demoReadings(scene, NOW), pump: demoPump(scene, NOW), treatments: demoTreatments(NOW) },
      });
      for (const tick of [0, 600, 1200]) {
        const view = buildView({ ...s, now: NOW + tick });
        expect(view.header.length).toBeLessThanOrEqual(HEADER_WIDTH);
        expect(view.footer.length).toBeLessThanOrEqual(ROW_WIDTH);
        expect(view.body.length).toBeLessThanOrEqual(view.layout === "glucose" ? 2 : MAX_BODY_ROWS);
        for (const row of view.body) expect(row.length, row).toBeLessThanOrEqual(ROW_WIDTH);
        for (const row of [...view.body, view.footer]) expect(row.endsWith("…"), row).toBe(false);
      }
    });
  }

  it("setup, loading and no-server pages", () => {
    for (const connection of [{ kind: "setup" }, { kind: "loading" }, { kind: "error", code: "unreachable" }] as Connection[]) {
      for (const locale of locales) {
        const view = buildView(state({ connection, data: null, locale }));
        expect(view.layout).toBe("plain");
        expect(view.header.length).toBeLessThanOrEqual(HEADER_WIDTH);
        for (const row of view.body) expect(row.length).toBeLessThanOrEqual(ROW_WIDTH);
      }
    }
  });
});

describe("what the glasses say", () => {
  it("value, age and target in the normal case", () => {
    const view = buildView(state());
    expect(view.layout).toBe("glucose");
    expect(view.header).toMatch(/^SUGARGLASS · \d{2,3} mg\/dL · vor \d min$/);
    expect(view.body[0]).toMatch(/^Δ [+\-±]\d+ mg\/dL in 5 min · Ziel 70–180$/);
    expect(view.body[1]).toBe("IOB 1,2 E · Reservoir 87 E · SmartGuard Auto");
  });

  it("low pulses in the header", () => {
    const s = state({ data: { readings: demoReadings("low", NOW), pump: null, treatments: demoTreatments(NOW) } });
    const a = buildView({ ...s, now: NOW - (NOW % 1200) }).header;
    const b = buildView({ ...s, now: NOW - (NOW % 1200) + 600 }).header;
    expect(a).toMatch(/^SUGARGLASS · !! NIEDRIG \d+ mg\/dL !!$/);
    expect(b.trim()).toMatch(/^SUGARGLASS · +NIEDRIG \d+ mg\/dL$/);
  });

  it("stale: says how old, in mmol too", () => {
    const view = buildView(state({ unit: "mmol", data: { readings: demoReadings("stale", NOW), pump: null, treatments: demoTreatments(NOW) } }));
    expect(view.header).toContain("KEIN AKTUELLER WERT · vor 2");
  });

  it("pump page", () => {
    const view = buildView(state({ page: "pump" }));
    expect(view.body).toEqual([
      "SmartGuard: Auto-Modus",
      "Aktives Insulin (IOB): 1,2 E",
      "Reservoir: 87 E · Pumpen-Akku: 75 %",
      "Sensor: noch 4 T 5 h · ok",
      "Handy-Akku: 58 % · Stand vor 2 min",
      "Mahlzeit 45 g vor 2 h 22 · Bolus 4,5 E vor 2 h 24",
      "Nur Info – maßgeblich sind Pumpe und Sensor.",
    ]);
  });

  it("the curve and value pictures do not change between ticks without a new reading", () => {
    const s = state();
    const a = buildFrames(s, "glucose");
    const b = buildFrames({ ...s, now: NOW + 20_000 }, "glucose");
    expect(bitmapKey(a.curve!)).toBe(bitmapKey(b.curve!));
    expect(bitmapKey(a.value!)).toBe(bitmapKey(b.value!));
    expect(a.value!.width).toBe(288);
    expect(a.curve!.height).toBe(144);
  });

  it("the drop animates and pulses on an alert", () => {
    const low = state({ data: { readings: demoReadings("urgent", NOW), pump: null, treatments: demoTreatments(NOW) } });
    expect(bitmapKey(buildFrames(low, "glucose").icon)).not.toBe(bitmapKey(buildFrames({ ...low, now: NOW + 600 }, "glucose").icon));
  });

  it("the demo api serves the scene", async () => {
    const api = createDemo(() => NOW, "high");
    expect((await api.readings(10))[0]!.mgdl).toBeGreaterThan(250);
    expect((await api.pump())?.iob).toBe(3.4);
  });
});

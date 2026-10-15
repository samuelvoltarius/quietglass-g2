import { describe, expect, it } from "vitest";
import { composeLight, pathPoint, ROSE } from "../src/sun/compose";
import { dayLight } from "../src/sun/light";
import { duration, lightModel, shootLine, type LightInput } from "../src/sun/model";
import { bearing } from "../src/screen/draw";
import { tiles } from "../src/screen/frame";
import { pixelBackend } from "../src/screen/text";
import { parseCallSheet, type CallSheet } from "../src/api/types";

// Wall clocks are the phone's: pin the zone so CEST/CET hold on any machine.
(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = "Europe/Vienna";

const SALZBURG = { latitude: 47.8, longitude: 13.04 };
const utc = (iso: string): number => Date.parse(iso);
const sheet = (rows: Array<[string, string]>, extra: Partial<CallSheet> = {}): CallSheet => ({
  date: "", call: "", location: "", contact: "", notes: "", schedule: rows.map(([time, what]) => ({ time, what })), ...extra,
});
const input = (at: string, more: Partial<LightInput> = {}): LightInput => ({
  at: utc(at), now: utc(at), place: SALZBURG, source: "phone", locale: "de", sheet: null, ...more,
});

describe("light model (Salzburg, 21 June 2026, CEST)", () => {
  it("names the next golden hour with its countdown and span", () => {
    // 18:00 CEST; golden hour 20:21–21:34 CEST (astropy: 18:21:34–19:34:42 UTC).
    const model = lightModel(input("2026-06-21T16:00:00Z"));
    expect(model.ok).toBe(true);
    expect(model.title).toBe("GOLDENE STUNDE");
    expect(model.when).toMatch(/^in 2 h 2[12] min$/);
    expect(model.span).toMatch(/^20:2[01]–21:3[45]$/);
    expect(model.headline).toBe(`GOLDENE STUNDE ${model.when} (${model.span})`);
    expect(model.clock).toBe("18:00");
    expect(model.preview).toBe("");
    // astropy 16:00 UTC: 28.63° az 274.16° → W.
    expect(model.sunWords).toBe("29° W");
  });

  it("counts down the running golden hour and shows sunset and blue hour", () => {
    const model = lightModel(input("2026-06-21T18:30:00Z"));
    expect(model.when).toMatch(/^jetzt · noch 1 h 0[45] min$/);
    expect(model.golden).toBe(true);
    // Sunset 19:10:09 UTC = 21:10, blue hour 21:34–21:51.
    expect(model.facts[0]).toMatch(/^Untergang 21:1[01] · Blaue Stunde 21:3[45]–21:5[01]$/);
    expect(model.facts[1]).toMatch(/^Aufgang 05:0[89] · Höchststand 13:09 \(66°\)$/);
  });

  it("says the next shoot's light in one line", () => {
    const model = lightModel(input("2026-06-21T14:00:00Z", { sheet: sheet([["09:00", "Call"], ["18:30", "Außen Brücke"], ["21:00", "Dach"]]) }));
    expect(model.shoot?.what).toBe("Außen Brücke");
    expect(model.shoot?.line).toMatch(/^Shooting 18:30: Sonne 2\d° W\w*, goldene Stunde ab 20:2[01]$/);
    expect(model.shoots.map((s) => s.time)).toEqual(["09:00", "18:30", "21:00"]);
    // 21:00 CEST is inside the golden hour.
    expect(model.shoots[2]?.line).toMatch(/^Shooting 21:00: Sonne -?\d° \w+, goldene Stunde bis 21:3[45]$/);
    // The phone timeline holds the day's light and the shoots, in time order.
    const times = model.timeline.map((entry) => entry.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(model.timeline.filter((entry) => entry.kind === "shoot")).toHaveLength(3);
    expect(model.timeline.some((entry) => entry.label === "Sonnenaufgang")).toBe(true);
  });

  it("speaks English with E for east, and German with O", () => {
    const morning = "2026-06-21T05:00:00Z"; // 07:00 CEST, the sun is in the east
    expect(lightModel(input(morning)).sunWords).toMatch(/O/);
    const en = lightModel(input(morning, { locale: "en" }));
    expect(en.sunWords).toMatch(/E/);
    expect(en.title).toBe("GOLDEN HOUR");
    expect(en.when).toMatch(/^in \d+ h \d\d min$/);
  });

  it("marks a preview of a later time", () => {
    const now = utc("2026-06-21T16:00:00Z");
    const model = lightModel({ ...input("2026-06-21T17:30:00Z"), now });
    expect(model.preview).toBe("VORSCHAU 19:30 (+1:30)");
  });

  it("night, blue hour and missing golden light in shoot lines", () => {
    expect(shootLine(utc("2026-06-21T22:00:00Z"), SALZBURG, "de")).toMatch(/^Shooting 00:00: Nacht, Sonne -\d+°$/);
    expect(shootLine(utc("2026-06-21T19:40:00Z"), SALZBURG, "de")).toMatch(/^Shooting 21:40: blaue Stunde bis 21:5[01]$/);
    expect(shootLine(utc("2026-06-21T19:40:00Z"), SALZBURG, "en")).toMatch(/^Shoot 21:40: blue hour until 21:5[01]$/);
  });

  it("has no place: says so instead of inventing one", () => {
    const model = lightModel(input("2026-06-21T16:00:00Z", { place: null, source: null }));
    expect(model.ok).toBe(false);
    expect(model.title).toBe("KEIN STANDORT");
    expect(model.notice).toHaveLength(2);
  });

  it("formats durations", () => {
    expect(duration(42)).toBe("42 min");
    expect(duration(125)).toBe("2 h 05 min");
    expect(duration(-3)).toBe("0 min");
  });

  it("joins the polar-winter golden light round noon into one window", () => {
    const day = dayLight(utc("2026-12-21T11:00:00Z"), { latitude: 69.65, longitude: 18.96 });
    const golden = day.windows.filter((w) => w.kind === "golden");
    expect(golden).toHaveLength(1);
    expect(golden[0]!.end - golden[0]!.start).toBeGreaterThan(60 * 60_000);
  });
});

describe("call sheet coordinates", () => {
  it("reads lat/lon of the shoot's place, and ignores nonsense", () => {
    expect(parseCallSheet({ lat: 47.8, lon: "13.04" })).toMatchObject({ latitude: 47.8, longitude: 13.04 });
    expect(parseCallSheet({ latitude: 48.2, longitude: 16.37 })).toMatchObject({ latitude: 48.2, longitude: 16.37 });
    expect(parseCallSheet({ lat: 120, lon: 13 }).latitude).toBeUndefined();
    expect(parseCallSheet({ lat: 0, lon: 0 }).latitude).toBeUndefined();
    expect(parseCallSheet({}).latitude).toBeUndefined();
  });

  it("puts a shoot at the sheet's place, not the phone's", () => {
    // Same moment, far west (Lisbon): the sun is much higher there at 18:30 Vienna time.
    const lisbon = sheet([["18:30", "Shoot"]], { latitude: 38.72, longitude: -9.14 });
    const here = lightModel(input("2026-06-21T14:00:00Z", { sheet: sheet([["18:30", "Shoot"]]) }));
    const there = lightModel(input("2026-06-21T14:00:00Z", { sheet: lisbon }));
    expect(here.shoot?.line).not.toBe(there.shoot?.line);
  });
});

describe("light picture", () => {
  const backend = pixelBackend();

  it("fills the 576 x 288 display and puts the sun on the compass ring", () => {
    const model = lightModel(input("2026-06-21T16:00:00Z", { sheet: sheet([["18:30", "Außen"]]) }));
    const frame = composeLight(model, backend);
    expect(frame.width).toBe(576);
    expect(frame.height).toBe(288);
    const [dx, dy] = bearing(model.azimuth);
    const sx = Math.round(ROSE.x + dx * ROSE.r); const sy = Math.round(ROSE.y + dy * ROSE.r);
    expect(frame.pixels[sy * 576 + sx]).toBe(15);
    // The marker on the sun-path arc sits where the sun is now.
    const [px, py] = pathPoint(model, model.path.at, model.elevation);
    expect(frame.pixels[Math.round(py) * 576 + Math.round(px)]).toBe(15);
    // Every quarter of the display carries something.
    for (const tile of tiles(frame)) expect(tile.pixels.some((level) => level > 0)).toBe(true);
  });

  it("draws the same moment the same way, so an unchanged view sends nothing", () => {
    const a = composeLight(lightModel(input("2026-06-21T16:00:00Z")), backend);
    const b = composeLight(lightModel(input("2026-06-21T16:00:00Z")), backend);
    expect(Array.from(a.pixels)).toEqual(Array.from(b.pixels));
  });

  it("draws a notice without a place", () => {
    const frame = composeLight(lightModel(input("2026-06-21T16:00:00Z", { place: null, source: null })), backend);
    expect(frame.pixels.some((level) => level > 0)).toBe(true);
  });
});

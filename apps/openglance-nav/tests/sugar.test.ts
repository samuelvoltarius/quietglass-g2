import { describe, expect, it, vi } from "vitest";
import {
  arrowOf, buildSugarUrl, fetchSugar, parseSugarEntries, sugarChip, sugarDisplay,
  SUGAR_CRITICAL_MGDL, SUGAR_HIDE_MS, SUGAR_LOW_MGDL, SUGAR_STALE_MS, type Direction, type SugarReading,
} from "../src/sugar/glucose";
import { buildView, ROW_WIDTH, OVERVIEW_WIDTH_CHARS, SPEED_PLATE_CHARS, type ViewOptions } from "../src/glasses/view";
import { speedColumn } from "../src/nav/speed";
import { createMockProvider } from "../src/routing/provider";
import { progressOf, startNavigation, update } from "../src/nav/navigator";
import { EMPTY_DATA, parseData } from "../src/storage/persist";
import { locales } from "../src/i18n";

const NOW = 1_800_000_000_000;
const reading = (mgdl: number, direction: Direction = "Flat", ageMs = 60_000): SugarReading => ({ at: NOW - ageMs, mgdl, direction });

describe("glucose: reading the server", () => {
  it("takes only a valid http(s) address; empty means off", () => {
    expect(buildSugarUrl("https://sugar.example:8443/")).toBe("https://sugar.example:8443");
    expect(buildSugarUrl("")).toBe("");
    expect(buildSugarUrl(undefined)).toBe("");
    expect(buildSugarUrl("ftp://x.example")).toBe("");
    expect(buildSugarUrl("nonsense")).toBe("");
  });

  it("parses Nightscout entries newest first and skips error codes", () => {
    const body = [
      { type: "sgv", sgv: 118, direction: "FortyFiveDown", date: NOW - 300_000 },
      { sgv: "128", direction: "FortyFiveUp", date: NOW },
      { sgv: 5, direction: "Flat", date: NOW - 1000 },
      { sgv: 700, date: NOW - 1000 },
      { type: "mbg", sgv: 100, date: NOW },
      { sgv: 100, date: "x" },
      null,
    ];
    const out = parseSugarEntries(body);
    expect(out.map((r) => [r.mgdl, r.direction])).toEqual([[128, "FortyFiveUp"], [118, "FortyFiveDown"]]);
    expect(parseSugarEntries({ not: "a list" })).toEqual([]);
    expect(parseSugarEntries([{ sgv: 99, dateString: new Date(NOW).toISOString() }])[0]!.at).toBe(NOW);
  });

  it("maps every Nightscout direction to an arrow; unknown ones to none", () => {
    const names: Direction[] = ["DoubleUp", "SingleUp", "FortyFiveUp", "Flat", "FortyFiveDown", "SingleDown", "DoubleDown"];
    expect(names.map(arrowOf)).toEqual(["↑↑", "↑", "↗", "→", "↘", "↓", "↓↓"]);
    const [odd] = parseSugarEntries([{ sgv: 100, direction: "NOT COMPUTABLE", date: NOW }]);
    expect(odd!.direction).toBe("NONE");
    expect(arrowOf("NONE")).toBe("");
    expect(parseSugarEntries([{ sgv: 100, direction: "flat", date: NOW }])[0]!.direction).toBe("Flat");
  });

  it("asks the server with one plain GET (count=3, token only in the query)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ sgv: 128, direction: "FortyFiveUp", date: NOW }]), { status: 200 }));
    const got = await fetchSugar("https://sugar.example/", "", fetchImpl as unknown as typeof fetch);
    expect(got?.mgdl).toBe(128);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://sugar.example/api/v1/entries/sgv.json?count=3");
    expect(init.headers).toBeUndefined();
    await fetchSugar("https://sugar.example", "tok", fetchImpl as unknown as typeof fetch);
    expect((fetchImpl.mock.calls[1] as unknown as [string])[0]).toContain("token=tok");
  });

  it("returns null on every failure instead of throwing", async () => {
    const bad = (impl: () => Promise<Response>) => fetchSugar("https://s.example", "", impl as unknown as typeof fetch);
    expect(await bad(async () => new Response("{}", { status: 503 }))).toBeNull();
    expect(await bad(async () => { throw new TypeError("offline"); })).toBeNull();
    expect(await bad(async () => new Response("not json", { status: 200 }))).toBeNull();
    expect(await bad(async () => new Response("[]", { status: 200 }))).toBeNull();
  });
});

describe("glucose: stale values and the warning rule", () => {
  it("shows a fresh value with its arrow", () => {
    const d = sugarDisplay(reading(128, "FortyFiveUp"), NOW)!;
    expect(sugarChip(d)).toBe("128↗");
    expect(d.warning).toBeNull();
  });

  it("marks a value older than 15 minutes (128?), without arrow, and hides it after an hour", () => {
    const stale = sugarDisplay(reading(128, "FortyFiveUp", SUGAR_STALE_MS + 1), NOW)!;
    expect(sugarChip(stale)).toBe("128?");
    expect(sugarDisplay(reading(128, "Flat", SUGAR_STALE_MS), NOW)!.stale).toBe(false);
    expect(sugarDisplay(reading(128, "Flat", SUGAR_HIDE_MS + 1), NOW)).toBeNull();
    expect(sugarDisplay(null, NOW)).toBeNull();
  });

  it("a stale low value never warns (an old number says nothing about now)", () => {
    expect(sugarDisplay(reading(55, "DoubleDown", SUGAR_STALE_MS + 1), NOW)!.warning).toBeNull();
  });

  it("warns when low and falling, or critical in any direction", () => {
    expect(SUGAR_LOW_MGDL).toBe(80);
    expect(SUGAR_CRITICAL_MGDL).toBe(70);
    const w = (mgdl: number, dir: Direction) => sugarDisplay(reading(mgdl, dir), NOW)!.warning;
    for (const dir of ["FortyFiveDown", "SingleDown", "DoubleDown"] as const) expect(w(79, dir)).toBe("lowFalling");
    expect(w(80, "SingleDown")).toBeNull();
    expect(w(79, "Flat")).toBeNull();
    expect(w(79, "SingleUp")).toBeNull();
    expect(w(79, "NONE")).toBeNull();
    expect(w(69, "Flat")).toBe("low");
    expect(w(69, "NONE")).toBe("low");
    expect(w(69, "DoubleDown")).toBe("lowFalling");
    expect(w(70, "Flat")).toBeNull();
  });
});

async function turn() {
  const { route } = await createMockProvider().route({ from: { lat: 52, lon: 13 }, to: { lat: 53, lon: 14 }, mode: "driving" });
  return progressOf(update(startNavigation(route!), route!.shape[2]!));
}
const base: ViewOptions = { mode: "driving", navigating: true, rerouting: false, error: null, mock: false, waitingForFix: false, speed: { kmh: 52, limit: 50 } };

describe("glucose in the driving HUD", () => {
  it("shows the small value in the footer of the turn page and on the map plate", async () => {
    const p = await turn();
    const sugar = sugarDisplay(reading(128, "FortyFiveUp"), NOW)!;
    expect(buildView(p, { ...base, locale: "de", sugar }).footer).toContain("128↗");
    const map = buildView(p, { ...base, locale: "de", layout: "overview", sugar });
    expect(map.speed).toBe("52 | 50 km/h  128↗");
  });

  it("leaves the view as it was without a value, and never shows it on foot", async () => {
    const p = await turn();
    const sugar = sugarDisplay(reading(128, "Flat"), NOW)!;
    const plain = buildView(p, { ...base, locale: "en" });
    expect(buildView(p, { ...base, locale: "en", sugar: null })).toEqual(plain);
    expect(plain.footer).not.toContain("128");
    const walking = buildView(p, { ...base, mode: "walking", locale: "en", sugar });
    expect(walking.footer).not.toContain("128");
  });

  it("drops the plain value on the map plate when it does not fit", async () => {
    const p = await turn();
    const sugar = sugarDisplay(reading(128, "DoubleDown"), NOW)!;
    const map = buildView(p, { ...base, speed: { kmh: 52, limit: 50, source: "gps" }, layout: "overview", sugar });
    expect(map.speed).toBe("52 | 50 km/h·GPS");
  });

  for (const locale of locales) {
    it(`${locale}: the warning is prominent and every row fits`, async () => {
      const p = await turn();
      const lowFalling = sugarDisplay(reading(72, "SingleDown"), NOW)!;
      const lowFlat = sugarDisplay(reading(65, "Flat"), NOW)!;
      for (const sugar of [lowFalling, lowFlat, sugarDisplay(reading(128, "DoubleUp"), NOW)!, sugarDisplay(reading(128, "Flat", SUGAR_STALE_MS + 5), NOW)!]) {
        const turns = buildView(p, { ...base, locale, sugar });
        const map = buildView(p, { ...base, locale, layout: "overview", sugar });
        expect(turns.footer.length).toBeLessThanOrEqual(ROW_WIDTH);
        expect(map.speed!.length).toBeLessThanOrEqual(SPEED_PLATE_CHARS);
        expect(map.body[0]!.length).toBeLessThanOrEqual(OVERVIEW_WIDTH_CHARS);
        if (sugar.warning) {
          expect(turns.footer.startsWith("! " + sugarChip(sugar))).toBe(true);
          expect(map.speed!.startsWith("! " + sugarChip(sugar))).toBe(true);
        }
      }
      const falling = buildView(p, { ...base, locale, sugar: lowFalling }).footer;
      expect(falling).toBe(locale === "de" ? "! 72↓ niedrig & fallend" : "! 72↓ low & falling");
      const flat = buildView(p, { ...base, locale, sugar: lowFlat }).footer;
      expect(flat).toBe(locale === "de" ? "! 65→ niedrig" : "! 65→ low");
      // The speed column on the turn page is untouched.
      expect(buildView(p, { ...base, locale, sugar: lowFalling }).speed).toBe(speedColumn({ kmh: 52, limit: 50 }));
    });
  }

  it("the warning stays up close to a turn, where the footer is otherwise dropped", async () => {
    const full = await turn();
    const p = { ...full, distanceToManeuver: 50 };
    const view = buildView(p, { ...base, locale: "en", bigDistance: true, sugar: sugarDisplay(reading(60, "DoubleDown"), NOW)! });
    expect(view.footer).toBe("! 60↓↓ low & falling");
    const calm = buildView(p, { ...base, locale: "en", bigDistance: true, sugar: sugarDisplay(reading(128, "Flat"), NOW)! });
    expect(calm.footer).toBe("");
  });
});

describe("glucose: setting and requests", () => {
  it("is off by default without an address in the build, and a saved choice is kept", () => {
    expect(EMPTY_DATA.sugar).toBe(false);
    expect(parseData(JSON.stringify({ sugar: true })).sugar).toBe(true);
    expect(parseData(JSON.stringify({ sugar: "yes" })).sugar).toBe(false);
    expect(parseData("{}").sugar).toBe(false);
  });

  it("makes no request at all when no address is configured", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(buildSugarUrl("")).toBe("");
    // main.ts polls only with a non-empty address; the view code never fetches.
    const p = await turn();
    buildView(p, { ...base, locale: "en", sugar: null });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

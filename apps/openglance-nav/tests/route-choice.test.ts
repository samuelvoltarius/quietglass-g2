import { describe, expect, it, vi } from "vitest";
import { createValhallaProvider, parseValhalla, type Route } from "../src/routing/provider";
import { choicesFrom, energyPercent, mainRoad, moveChoice, routeChoiceView, routeRow, type RouteChoice } from "../src/routing/choice";
import { LINE_WIDTH, ROW_WIDTH } from "../src/glasses/view";
import { locales } from "../src/i18n";
import type { TrafficReport } from "../src/traffic/traffic";

function trip(minutes: number, km: number, streets: [string, number][], summary: Record<string, unknown> = {}) {
  return {
    legs: [{
      shape: "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
      maneuvers: [
        ...streets.map(([name, length], i) => ({ type: i === 0 ? 1 : 10, instruction: "x", street_names: [name], length, time: 60, begin_shape_index: i })),
        { type: 4, instruction: "Arrive", length: 0, time: 0, begin_shape_index: 2 },
      ],
    }],
    summary: { length: km, time: minutes * 60, ...summary },
  };
}

const A = trip(34, 41, [["Zubringer", 2], ["A1", 37], ["Ausfahrt", 2]], { has_highway: true, has_toll: false });
const B = trip(38, 33, [["Ort", 3], ["B158", 28], ["Weg", 2]], { has_highway: false, has_toll: false });
const C = trip(41, 39, [["Mautstraße", 39]], { has_toll: true });

function routes(): Route[] {
  const outcome = parseValhalla({ trip: A, alternates: [{ trip: B }, { trip: C }] });
  return choicesFrom(outcome.route!, outcome.alternates);
}

describe("Valhalla alternates", () => {
  it("parses the alternates beside the trip, with toll and motorway flags", () => {
    const outcome = parseValhalla({ trip: A, alternates: [{ trip: B }, { trip: { legs: [] } }, { trip: C }] });
    expect(outcome.route!.duration).toBe(34 * 60);
    expect(outcome.route!.highway).toBe(true);
    // A broken alternate is skipped, not guessed.
    expect(outcome.alternates!.map((r) => r.duration)).toEqual([38 * 60, 41 * 60]);
    expect(outcome.alternates![1]!.toll).toBe(true);
    expect(parseValhalla({ trip: A }).alternates).toBeUndefined();
  });

  it("asks for alternates only by car and only without stops", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => { urls.push(decodeURIComponent(url)); return new Response(JSON.stringify({ trip: A }), { status: 200 }); });
    const provider = createValhallaProvider({ url: "https://valhalla.test", fetchImpl: fetchImpl as never });
    const from = { lat: 47.8, lon: 13 }, to = { lat: 48.2, lon: 16.3 };
    await provider.route({ from, to, mode: "driving", alternates: 2 });
    await provider.route({ from, to, mode: "driving", alternates: 5 });
    await provider.route({ from, to, mode: "driving", alternates: 2, via: [{ lat: 48, lon: 14 }] });
    await provider.route({ from, to, mode: "walking", alternates: 2 });
    await provider.route({ from, to, mode: "driving" });
    const body = (url: string) => JSON.parse(url.split("?json=")[1]!) as { alternates?: number };
    expect(urls.map((u) => body(u).alternates)).toEqual([2, 2, undefined, undefined, undefined]);
  });
});

describe("route picker", () => {
  const choice = (traffic: (TrafficReport | null | undefined)[] = [null, null, null], selected = 0): RouteChoice => ({ routes: routes(), selected, traffic });

  it("names the road each way mostly follows", () => {
    const [a, b, c] = routes();
    expect(mainRoad(a!)).toBe("A1");
    expect(mainRoad(b!)).toBe("B158");
    expect(mainRoad(c!)).toBe("Mautstraße");
  });

  it("shows time, distance and what tells the ways apart", () => {
    const energy = { consumption: 16, usableKwh: 43.2 };
    expect(routeRow(choice(), 0, "de", energy, 42)).toBe("A 34 min · 41 km · A1");
    // B is shorter and slower: less battery than A.
    expect(routeRow(choice(), 1, "de", energy, 42)).toMatch(/^B 38 min · 33 km · B158 · Akku −\d+ %$/);
    expect(routeRow(choice(), 2, "de", null, 42)).toBe("C 41 min · 39 km · Mautstraße · Maut");
    expect(routeRow(choice(), 2, "en", null, 42)).toBe("C 41 min · 39 km · Mautstraße · toll");
  });

  it("adds the traffic delay, and drops the least telling part when the row is full", () => {
    const jam: TrafficReport = { incidents: [], delayMin: 12, closure: false };
    const closed: TrafficReport = { incidents: [], delayMin: 0, closure: true };
    expect(routeRow(choice([jam, null, closed]), 0, "de", null, 42)).toBe("A 34 min · 41 km · A1 · +12 min Stau");
    expect(routeRow(choice([jam, null, closed]), 2, "de", null, 42)).toBe("C 41 min · 39 km · Maut · Sperre");
    // Narrow: the road goes before the traffic does.
    expect(routeRow(choice([jam, null, null]), 0, "de", null, 32)).toBe("A 34 min · 41 km · +12 min Stau");
  });

  it("estimates more battery for a fast motorway than for the same distance slower", () => {
    const energy = { consumption: 16, usableKwh: 43.2 };
    const base = routes()[0]!;
    const slow = { ...base, distance: 40_000, duration: 3600 };
    const fast = { ...base, distance: 40_000, duration: 1200 };
    expect(energyPercent(fast, energy)).toBeGreaterThan(energyPercent(slow, energy));
    expect(energyPercent(slow, energy)).toBeCloseTo(((40 * 16) / 100 / 43.2) * 100, 6);
  });

  it("fits header, rows and footer in German and English, with the gesture order of QIS", () => {
    const jam: TrafficReport = { incidents: [], delayMin: 125, closure: false };
    for (const locale of locales) {
      for (const selected of [0, 1, 2]) {
        const view = routeChoiceView(choice([jam, undefined, jam], selected), locale, "Sehr langes Ziel mit Namen und Zusatz in Salzburg", { consumption: 18, usableKwh: 43.2 });
        expect(view.header.length).toBeLessThanOrEqual(ROW_WIDTH);
        expect(view.footer.length).toBeLessThanOrEqual(ROW_WIDTH);
        for (const line of view.body) expect(line.length, line).toBeLessThanOrEqual(LINE_WIDTH);
        expect(view.body[selected]!.startsWith("→ ")).toBe(true);
      }
      const footer = routeChoiceView(choice(), locale, null, null).footer;
      expect(footer).toBe(locale === "de" ? "Tippen = los · Wischen = wählen · 2× = zurück" : "Tap = go · Swipe = choose · 2× = back");
    }
    // While traffic is still being asked, the page says so.
    expect(routeChoiceView(choice([undefined, undefined, undefined]), "de", null, null).body.join("\n")).toContain("Verkehr wird abgefragt");
  });

  it("swipes within the ways without wrapping round", () => {
    let c = choice();
    c = moveChoice(c, -1);
    expect(c.selected).toBe(0);
    c = moveChoice(moveChoice(moveChoice(c, 1), 1), 1);
    expect(c.selected).toBe(2);
  });

  it("has nothing to choose with one way: no picker", () => {
    const outcome = parseValhalla({ trip: A });
    expect(choicesFrom(outcome.route!, outcome.alternates)).toHaveLength(1);
  });
});

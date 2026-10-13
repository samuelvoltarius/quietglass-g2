import { describe, expect, it } from "vitest";
import recorded from "../src/demo/plan-salzburg.json";
import shortPlan from "./fixtures/plan-short.json";
import geocodeAnswer from "./fixtures/geocode-salzburg.json";
import {
  arrivalOf, clock, departureOf, distanceText, firstTransit, lineLabel, parsePlan, waitText,
  type Journey, type TransitLeg, type WalkLeg,
} from "../src/route/journey";
import { parseGeocode } from "../src/route/geocode";
import { demoJourneys, shiftTimes } from "../src/demo/demo";
import { journeyRow, linesOf, plansView, ROUTE_ROWS, ROUTE_WIDTH } from "../src/route/view";
import { MotisBackend } from "../src/transit/motis";

/**
 * The fixtures are real answers of api.transitous.org (fetched with curl on
 * 2026-10-13, trimmed to the fields the app reads): plan-salzburg.json is a
 * connection with one change, plan-short.json a trip short enough to walk,
 * geocode-salzburg.json a place search.
 */
const HOME = { name: "Heim", lat: 47.796, lon: 13.016 };

const walkLegs = (journey: Journey): WalkLeg[] => journey.legs.filter((leg): leg is WalkLeg => leg.kind === "walk");
const transitLegs = (journey: Journey): TransitLeg[] => journey.legs.filter((leg): leg is TransitLeg => leg.kind === "transit");

describe("reading a MOTIS plan answer", () => {
  const journeys = parsePlan(recorded, HOME, "de");

  it("keeps both connections, in the order the service gave them", () => {
    expect(journeys).toHaveLength(2);
    expect(journeys.map((journey) => journey.transfers)).toEqual([1, 0]);
  });

  it("turns each connection into walk and ride legs", () => {
    const first = journeys[0]!;
    expect(first.legs.map((leg) => leg.kind)).toEqual(["walk", "transit", "walk", "transit", "walk"]);
    expect(transitLegs(first).map((leg) => leg.line)).toEqual(["O-Bus 2", "O-Bus 10"]);
    expect(transitLegs(first).map((leg) => leg.headsign)).toEqual(["Walserfeld", "Walserfeld"]);
    expect(linesOf(first)).toBe("O-Bus 2 → O-Bus 10");
  });

  it("reads boarding stop, intermediate stops and alighting stop of a ride", () => {
    const bus = transitLegs(journeys[0]!)[0]!;
    expect(bus.stops).toHaveLength(5);
    expect(bus.stops[0]?.stop.name).toBe("Salzburg Vogelweiderstraße");
    expect(bus.stops.at(-1)?.stop.name).toBe("Salzburg Mirabellplatz");
    expect(bus.stops.map((stop) => stop.expected.getTime())).toEqual(
      [...bus.stops.map((stop) => stop.expected.getTime())].sort((a, b) => a - b),
    );
    expect(departureOf(bus).toISOString()).toBe("2026-10-13T08:04:00.000Z");
    expect(arrivalOf(bus).getTime()).toBeGreaterThan(departureOf(bus).getTime());
    expect(bus.tripId).toMatch(/^20261013_/);
  });

  it("marks a timetable-only ride as scheduled, not live", () => {
    const bus = transitLegs(journeys[0]!)[0]!;
    expect(bus.stops.every((stop) => stop.source === "scheduled")).toBe(true);
  });

  it("carries the stand of the boarding stop when the service knows it", () => {
    expect(transitLegs(journeys[0]!)[1]?.boardTrack).toBe("A");
    expect(transitLegs(journeys[1]!)[0]?.boardTrack).toBe("D");
  });

  it("names the last walk after the destination, not the service's END", () => {
    const last = walkLegs(journeys[0]!).at(-1)!;
    expect(last.toDestination).toBe(true);
    expect(last.toName).toBe("Heim");
    expect(last.toLat).toBe(HOME.lat);
    expect(last.metres).toBe(432);
    const first = walkLegs(journeys[0]!)[0]!;
    expect(first.toDestination).toBe(false);
    expect(first.toName).toBe("Salzburg Vogelweiderstraße");
    expect(first.metres).toBe(203);
  });

  it("finds the first vehicle of a connection", () => {
    expect(firstTransit(journeys[0]!)?.line).toBe("O-Bus 2");
  });

  it("returns nothing for an answer it cannot read", () => {
    expect(parsePlan(null, HOME)).toEqual([]);
    expect(parsePlan({ itineraries: [{ legs: [] }] }, HOME)).toEqual([]);
    expect(parsePlan({ itineraries: [{ startTime: "x", endTime: "y", legs: [{}] }] }, HOME)).toEqual([]);
  });

  it("drops a connection with a hole in it instead of showing half a journey", () => {
    const broken = structuredClone(recorded) as unknown as { itineraries: { legs: { to: { lat?: number } }[] }[] };
    delete broken.itineraries[0]!.legs[0]!.to.lat;
    expect(parsePlan(broken, HOME, "de")).toHaveLength(1);
  });
});

describe("walking instead of waiting", () => {
  it("offers the walk first when it is short", () => {
    const journeys = parsePlan(shortPlan, { name: "Büro", lat: 47.807, lon: 13.05 }, "de");
    expect(journeys).toHaveLength(2);
    expect(journeys[0]?.legs.map((leg) => leg.kind)).toEqual(["walk"]);
    expect(journeys[0]?.transfers).toBe(0);
    expect(journeyRow(journeys[0]!, true, new Date(journeys[0]!.start), "de")).toMatch(/^> zu Fuß 8 min · an \d\d:\d\d$/);
  });

  it("does not offer a walk of a quarter of an hour or more", () => {
    const far = structuredClone(shortPlan) as unknown as { direct: { startTime: string; endTime: string }[] };
    far.direct[0]!.endTime = "2026-10-13T09:00:00Z";
    far.direct[0]!.startTime = "2026-10-13T08:00:00Z";
    expect(parsePlan(far, { name: "Büro", lat: 47.807, lon: 13.05 }, "de")).toHaveLength(1);
  });
});

describe("naming a line", () => {
  it("puts the vehicle in front of a bare number", () => {
    expect(lineLabel("BUS", "3", "Postbus", "de")).toBe("Bus 3");
    expect(lineLabel("BUS", "10", "Salzburg AG (OBus)", "de")).toBe("O-Bus 10");
    expect(lineLabel("TRAM", "5", "", "en")).toBe("Tram 5");
  });
  it("leaves a name that already says what it is", () => {
    expect(lineLabel("RAIL", "S3", "ÖBB", "de")).toBe("S3");
    expect(lineLabel("RAIL", "REX 1", "ÖBB", "de")).toBe("REX 1");
  });
});

describe("reading the clock and distances", () => {
  it("prints clock times with two digits", () => {
    expect(clock(new Date(2026, 9, 13, 7, 5))).toBe("07:05");
    expect(clock(new Date(2026, 9, 13, 14, 52))).toBe("14:52");
  });
  it("rounds down the waiting time, like the board", () => {
    const now = new Date("2026-10-13T12:00:00Z");
    expect(waitText(new Date(now.getTime() + 89000), now, "de")).toBe("1 min");
    expect(waitText(new Date(now.getTime() - 5000), now, "de")).toBe("jetzt");
    expect(waitText(new Date(now.getTime() + 65 * 60000), now, "de")).toBe("1h05");
  });
  it("speaks distances the way a walker reads them", () => {
    expect(distanceText(184, "de")).toBe("180 m");
    expect(distanceText(4, "de")).toBe("10 m");
    expect(distanceText(1240, "de")).toBe("1,2 km");
    expect(distanceText(1240, "en")).toBe("1.2 km");
  });
});

describe("the connections page", () => {
  const T0 = new Date("2026-10-13T12:00:00Z");
  const journeys = demoJourneys(recorded, T0, HOME, "de");

  it("shows when, which vehicles, when there, and how many changes", () => {
    expect(journeyRow(journeys[0]!, true, T0, "de")).toBe(`> in 4 min · O-Bus 2 → O-Bus 10 · an ${clock(journeys[0]!.end)} · 1×`);
    expect(journeyRow(journeys[1]!, false, T0, "de")).toBe(`  in 18 min · O-Bus 10 · an ${clock(journeys[1]!.end)}`);
    expect(journeyRow(journeys[0]!, true, T0, "en")).toContain("in 4 min");
    expect(journeyRow(journeys[0]!, true, T0, "en")).toContain(`arr ${clock(journeys[0]!.end)}`);
  });

  it("says jetzt for a vehicle that is about to leave", () => {
    const soon = new Date(departureOf(firstTransit(journeys[0]!)!).getTime() - 20000);
    expect(journeyRow(journeys[0]!, true, soon, "de")).toMatch(/^> jetzt · /);
  });

  it("lists up to four connections and details the selected one underneath", () => {
    expect(journeys).toHaveLength(4);
    const view = plansView("Heim", journeys, 1, T0, "de");
    expect(view.header).toBe(`→ Heim · ${clock(T0)}`);
    expect(view.body.slice(0, 4).map((line) => line[0])).toEqual([" ", ">", " ", " "]);
    expect(view.body[5]).toBe("Ab Salzburg Sterneckstraße · Steig D");
    expect(view.body[6]).toMatch(/^Gehen \d+ min · Dauer 42 min$/);
    expect(view.footer).toBe("tippen = los · × = Umstiege · 2× zurück");
  });

  for (const locale of ["de", "en"] as const) {
    it(`keeps every ${locale} row inside the display`, () => {
      for (let selected = 0; selected < journeys.length; selected += 1) {
        const view = plansView("Hauptbahnhof Salzburg (Südtiroler Platz)", journeys, selected, T0, locale);
        expect(view.body.length).toBeLessThanOrEqual(ROUTE_ROWS);
        expect(view.header.length).toBeLessThanOrEqual(ROUTE_WIDTH);
        for (const line of view.body) expect(line.length, line).toBeLessThanOrEqual(ROUTE_WIDTH);
      }
    });
  }

  it("lets the list of vehicles give way, never the times", () => {
    const long = { ...journeys[0]!, legs: journeys[0]!.legs.map((leg) => leg.kind === "transit" ? { ...leg, line: "Regionalexpress Sehr Lang 12345" } : leg) };
    const row = journeyRow(long, true, T0, "de");
    expect(row.length).toBeLessThanOrEqual(ROUTE_WIDTH);
    expect(row).toContain("…");
    expect(row.startsWith("> in 4 min · ")).toBe(true);
    expect(row.endsWith(` · an ${clock(long.end)} · 1×`)).toBe(true);
  });
});

describe("the demo answer", () => {
  it("moves every time by the same amount and nothing else", () => {
    const shifted = shiftTimes({ a: "2026-10-13T08:00:00Z", b: ["2026-10-13T08:30:00Z", "Walserfeld"], c: 5 }, 3600000);
    expect(shifted).toEqual({ a: "2026-10-13T09:00:00Z", b: ["2026-10-13T09:30:00Z", "Walserfeld"], c: 5 });
  });

  it("leaves the first bus four minutes from now", () => {
    const T0 = new Date("2026-10-13T12:00:00Z");
    const journeys = demoJourneys(recorded, T0, HOME, "de");
    expect(departureOf(firstTransit(journeys[0]!)!).getTime() - T0.getTime()).toBe(4 * 60000);
    expect(journeys.map((journey) => transitLegs(journey).length)).toEqual([2, 1, 2, 1]);
  });
});

describe("place search", () => {
  it("reads the real geocode answer: stop first, then places", () => {
    const found = parseGeocode(geocodeAnswer);
    expect(found).toHaveLength(4);
    expect(found[0]).toMatchObject({ name: "Salzburg Hauptbahnhof", kind: "stop" });
    expect(found[0]?.lat).toBeCloseTo(47.81, 1);
    expect(found[0]?.detail).toMatch(/Salzburg/);
    expect(found[1]?.kind).toBe("place");
  });

  it("drops entries without a name or coordinates and repeats", () => {
    const found = parseGeocode([
      { type: "STOP", name: "", lat: 1, lon: 1 },
      { type: "STOP", name: "A", lat: "x", lon: 1 },
      { type: "STOP", name: "B", lat: 47.8, lon: 13.0 },
      { type: "STOP", name: "B", lat: 47.8, lon: 13.0 },
      { type: "ADDRESS", name: "C 1", lat: 47.8, lon: 13.1, zip: "5020", country: "AT", areas: [{ name: "Salzburg", default: true }] },
    ]);
    expect(found.map((entry) => entry.name)).toEqual(["B", "C 1"]);
    expect(found[1]).toMatchObject({ kind: "address", detail: "5020 Salzburg, AT" });
    expect(parseGeocode("nonsense")).toEqual([]);
  });
});

describe("asking the service", () => {
  it("sends the plan request the real API expects", async () => {
    const urls: string[] = [];
    const backend = new MotisBackend({
      baseUrl: "https://api.transitous.org",
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(recorded), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const journeys = await backend.plan({ lat: 47.8095, lon: 13.055 }, HOME, "de", 4);
    const url = new URL(urls[0]!);
    expect(url.origin + url.pathname).toBe("https://api.transitous.org/api/v1/plan");
    expect(url.searchParams.get("fromPlace")).toBe("47.8095,13.055");
    expect(url.searchParams.get("toPlace")).toBe("47.796,13.016");
    expect(url.searchParams.get("numItineraries")).toBe("4");
    expect(url.searchParams.get("detailedLegs")).toBe("false");
    expect(journeys).toHaveLength(2);
  });

  it("sends the geocode request with a bias towards the position", async () => {
    const urls: string[] = [];
    const backend = new MotisBackend({
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(geocodeAnswer), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const found = await backend.geocode("Hauptbahnhof", { lat: 47.8095, lon: 13.055 }, "de");
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe("/api/v1/geocode");
    expect(url.searchParams.get("text")).toBe("Hauptbahnhof");
    expect(url.searchParams.get("place")).toBe("47.8095,13.055");
    expect(found[0]?.name).toBe("Salzburg Hauptbahnhof");
  });

  it("reports a refused request instead of an empty list", async () => {
    const backend = new MotisBackend({ fetchImpl: (async () => new Response("no", { status: 403 })) as unknown as typeof fetch });
    await expect(backend.plan({ lat: 1, lon: 1 }, HOME)).rejects.toThrow("HTTP 403");
  });
});

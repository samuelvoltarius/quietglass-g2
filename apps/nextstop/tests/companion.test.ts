import { describe, expect, it } from "vitest";
import recorded from "../src/demo/plan-salzburg.json";
import { demoJourneys } from "../src/demo/demo";
import { departureOf, type Journey, type TransitLeg, type WalkLeg } from "../src/route/journey";
import { buildSteps, guideState } from "../src/route/guide";
import type { Maneuver, WalkNav } from "../src/route/walk";
import type { Position } from "../src/ride/tracker";
import { Companion, spokenMeters, type CompanionInput } from "../src/speech/companion";

const HOME = { name: "Heim", lat: 47.796, lon: 13.016 };
const T0 = new Date("2026-10-13T12:00:00Z");
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60000);
const journey: Journey = demoJourneys(recorded, T0, HOME, "de")[0]!;
const steps = buildSteps(journey);
const bus1 = journey.legs[1] as TransitLeg;
const walk1 = journey.legs[0] as WalkLeg;
const here = (stop: { lat: number; lon: number }): Position => ({ lat: stop.lat, lon: stop.lon, accuracy: 10 });

const turn = (patch: Partial<Maneuver> = {}): Maneuver => ({ type: "left", length: 100, shapeIndex: 5, ...patch });
const nav = (toNext: number, next: Maneuver = turn()): WalkNav => ({ next, toNext, stretch: 300, remaining: toNext + 100, off: 2, atEnd: false });

function input(now: Date, position: Position | null, over: Partial<CompanionInput> = {}): CompanionInput {
  return { journeyId: 1, state: guideState(steps, now, position), now, walk: null, locale: "de", hasFix: position !== null, ...over };
}

describe("walking turns", () => {
  it("announces far once and near once", () => {
    const c = new Companion();
    const base = (toNext: number) => input(T0, here(HOME), { walk: nav(toNext) });
    expect(c.next(base(150))).toBeNull();
    expect(c.next(base(58))?.text).toBe("In 60 Metern links abbiegen.");
    expect(c.next(base(40))).toBeNull();
    const near = c.next(base(12));
    expect(near?.text).toBe("Jetzt links abbiegen.");
    expect(near?.priority).toBe(2);
    expect(c.next(base(8))).toBeNull();
  });

  it("names the street, and says nothing without a fix or for a straight stretch", () => {
    const c = new Companion();
    expect(c.next(input(T0, null, { walk: nav(50) }))).toBeNull();
    expect(c.next(input(T0, here(HOME), { walk: nav(50, turn({ type: "straight" })) }))).toBeNull();
    expect(c.next(input(T0, here(HOME), { walk: nav(50, turn({ type: "right", street: "Linzer Gasse", shapeIndex: 9 })) }))?.text)
      .toBe("In 50 Metern rechts abbiegen auf Linzer Gasse.");
  });

  it("says English when asked", () => {
    const c = new Companion();
    expect(c.next(input(T0, here(HOME), { locale: "en", walk: nav(55) }))?.text).toBe("In 60 meters turn left.");
  });

  it("warns before the stop at the end of the walk, with no near message", () => {
    const c = new Companion();
    const arrive = turn({ type: "arrive", shapeIndex: 20 });
    expect(c.next(input(T0, here(HOME), { walk: nav(55, arrive) }))?.text).toContain(`erreichen Sie`);
    expect(c.next(input(T0, here(HOME), { walk: nav(10, arrive) }))).toBeNull();
  });
});

describe("at the stop and on the ride", () => {
  const atStop = here(bus1.stops[0]!.stop);
  const minutesToBus = (departureOf(bus1).getTime() - T0.getTime()) / 60000;

  it("names the vehicle on arrival at the stop, then at two minutes and at once when it comes", () => {
    const c = new Companion();
    const first = c.next(input(at(0.5), atStop));
    expect(first?.text).toMatch(new RegExp(`^${bus1.line} Richtung ${bus1.headsign} in \\d+ Minuten`));
    expect(c.next(input(at(1), atStop))).toBeNull();
    const two = c.next(input(at(minutesToBus - 1.5), atStop));
    expect(two?.text).toBe(`${bus1.line} in einer Minute.`);
    expect(c.next(input(at(minutesToBus - 1.4), atStop))).toBeNull();
    const now = c.next(input(at(minutesToBus - 0.2), atStop));
    expect(now?.text).toBe(`${bus1.line} kommt jetzt.`);
    expect(now?.priority).toBe(3);
    expect(c.next(input(at(minutesToBus - 0.1), atStop))).toBeNull();
  });

  it("does not repeat the two-minute stage when the entry message came late", () => {
    const c = new Companion();
    const first = c.next(input(at(minutesToBus - 1.5), atStop));
    expect(first?.text).toContain("in einer Minute");
    expect(c.next(input(at(minutesToBus - 1.2), atStop))).toBeNull();
  });

  it("warns two stops and one stop before getting off", () => {
    const c = new Companion();
    const last = bus1.stops.length - 1;
    const stateAt = (index: number) => {
      const now = new Date(bus1.stops[index]!.expected.getTime() - 60000);
      return input(now, here(bus1.stops[index]!.stop));
    };
    const all: string[] = [];
    for (let i = 1; i <= last; i += 1) {
      const a = c.next(stateAt(i));
      if (a) all.push(a.text);
    }
    expect(all.map((text) => text.split(":")[0])).toEqual(["In 4 Stationen aussteigen", "In zwei Stationen aussteigen", "Nächster Halt aussteigen"]);
    expect(all.some((text) => text.startsWith("Nächster Halt aussteigen:"))).toBe(true);
    expect(new Set(all).size).toBe(all.length);
  });

  it("announces arrival at the goal once", () => {
    const c = new Companion();
    const end = new Date(journey.end.getTime() + 20 * 60000);
    const done = (): CompanionInput => ({ ...input(end, null), state: { ...guideState(steps, end, null), phase: "arrived" } });
    expect(c.next(done())?.text).toBe("Sie haben Ihr Ziel erreicht.");
    expect(c.next(done())).toBeNull();
    // A new journey starts the memory over.
    expect(c.next({ ...done(), journeyId: 2 })?.text).toBe("Sie haben Ihr Ziel erreicht.");
  });

  it("says a missed connection once", () => {
    const c = new Companion();
    const late = new Date(departureOf(bus1).getTime() + 3 * 60000);
    const state = { ...guideState(steps, late, atStop), phase: "missed" as const, index: 1, step: steps[1]! };
    const run = (): CompanionInput => ({ journeyId: 1, state, now: late, walk: null, locale: "de", hasFix: true });
    expect(c.next(run())?.text).toContain("neu planen");
    expect(c.next(run())).toBeNull();
  });

  it("rounds spoken distances", () => {
    expect(spokenMeters(58)).toBe(60);
    expect(spokenMeters(143)).toBe(150);
    expect(spokenMeters(2)).toBe(10);
  });

  it("walk leg exists in the fixture", () => {
    expect(walk1.kind).toBe("walk");
  });
});

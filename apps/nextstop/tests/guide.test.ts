import { describe, expect, it } from "vitest";
import recorded from "../src/demo/plan-salzburg.json";
import { demoJourneys } from "../src/demo/demo";
import {
  arrivalOf, clock, departureOf, type Journey, type TransitLeg, type WalkLeg,
} from "../src/route/journey";
import {
  autoStep, buildSteps, guideState, missedVehicle, resolveStep, stepBy, withFreshTimes, withLeg,
  type GuideState, type Step,
} from "../src/route/guide";
import { guideView, ROUTE_ROWS, ROUTE_WIDTH } from "../src/route/view";
import { locales } from "../src/i18n";
import type { Position } from "../src/ride/tracker";
import type { RideStop } from "../src/transit/types";

const HOME = { name: "Heim", lat: 47.796, lon: 13.016 };
/** "Now" for the tests; the first bus of the first connection leaves at 12:04. */
const T0 = new Date("2026-10-13T12:00:00Z");
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60000);

const journey: Journey = demoJourneys(recorded, T0, HOME, "de")[0]!;
const steps = buildSteps(journey);

const bus1 = journey.legs[1] as TransitLeg;
const bus2 = journey.legs[3] as TransitLeg;
const walk1 = journey.legs[0] as WalkLeg;
const transferWalk = journey.legs[2] as WalkLeg;
const lastWalk = journey.legs[4] as WalkLeg;

const here = (stop: { lat: number; lon: number }): Position => ({ lat: stop.lat, lon: stop.lon, accuracy: 10 });
const minutesFrom = (date: Date): number => (date.getTime() - T0.getTime()) / 60000;

describe("the steps of a connection", () => {
  it("are walk, ride, walk, ride, walk, arrived", () => {
    expect(steps.map((step) => step.kind)).toEqual(["walk", "transit", "walk", "transit", "walk", "arrived"]);
  });

  it("know which ones are changes", () => {
    expect(steps.map((step) => step.kind === "arrived" ? false : step.transfer)).toEqual([false, false, true, true, true, false]);
  });

  it("know which vehicle a walk leads to", () => {
    const first = steps[0] as Extract<Step, { kind: "walk" }>;
    const change = steps[2] as Extract<Step, { kind: "walk" }>;
    const goal = steps[4] as Extract<Step, { kind: "walk" }>;
    expect(first.next?.tripId).toBe(bus1.tripId);
    expect(change.next?.tripId).toBe(bus2.tripId);
    expect(goal.next).toBeUndefined();
  });

  it("skips a walk of a few metres between two vehicles", () => {
    const tiny: Journey = {
      ...journey,
      legs: [bus1, { ...transferWalk, metres: 4, end: new Date(transferWalk.start.getTime() + 30000) }, bus2],
    };
    expect(buildSteps(tiny).map((step) => step.kind)).toEqual(["transit", "transit", "arrived"]);
  });
});

describe("which step it is", () => {
  it("starts with the walk to the stop", () => {
    expect(autoStep(steps, T0, null)).toBe(0);
    expect(guideState(steps, T0, null).phase).toBe("walk");
  });

  it("stays on the walk until the vehicle has gone, when nothing else is known", () => {
    expect(autoStep(steps, at(3.5), null)).toBe(0);
    expect(autoStep(steps, at(4.1), null)).toBe(1);
  });

  it("moves on to boarding as soon as GPS puts the passenger at the stop", () => {
    const state = guideState(steps, at(1), here(bus1.stops[0]!.stop));
    expect(state.index).toBe(1);
    expect(state.phase).toBe("board");
  });

  it("does not trust a fix that is too vague to mean anything", () => {
    const vague = { ...here(bus1.stops[0]!.stop), accuracy: 400 };
    expect(autoStep(steps, at(1), vague)).toBe(0);
  });

  it("rides once the vehicle has left", () => {
    const state = guideState(steps, at(5), null);
    expect(state.index).toBe(1);
    expect(state.phase).toBe("ride");
    expect(state.progress?.basis).toBe("clock");
  });

  it("counts the halts left, including the one to get off at", () => {
    // Bus 1 has five stops: boarding, three in between, the stop to get off at.
    const afterFirst = new Date(bus1.stops[1]!.expected.getTime() - 20000);
    const justBoarded = guideState(steps, new Date(bus1.stops[0]!.expected.getTime() + 20000), null);
    expect(justBoarded.stopsLeft).toBe(4);
    const second = guideState(steps, afterFirst, null);
    expect(second.progress?.next.stop.name).toBe(bus1.stops[1]!.stop.name);
    expect(second.stopsLeft).toBe(4);
    const beforeLast = guideState(steps, new Date(bus1.stops[3]!.expected.getTime() + 20000), null);
    expect(beforeLast.progress?.next.stop.name).toBe(bus1.stops[4]!.stop.name);
    expect(beforeLast.stopsLeft).toBe(1);
  });

  it("moves to the change after the ride is over, then to the next vehicle", () => {
    const overBus1 = new Date(arrivalOf(bus1).getTime() + 2 * 60000);
    expect(autoStep(steps, overBus1, null)).toBe(2);
    expect(guideState(steps, overBus1, null).phase).toBe("walk");
    const atChange = guideState(steps, overBus1, here({ lat: transferWalk.toLat, lon: transferWalk.toLon }));
    expect(atChange.index).toBe(3);
    expect(atChange.phase).toBe("board");
  });

  it("lets the clock bring a walk to its end when there is no fix, and only then", () => {
    const due = new Date(transferWalk.end.getTime() + 130000);
    expect(autoStep(steps, due, null)).toBe(3);
    expect(guideState(steps, due, null).phase).toBe("board");
    // With a fix that says the passenger is still far from the stop, the clock does not decide.
    const stillAtTheLastStop = here(bus1.stops.at(-1)!.stop);
    expect(autoStep(steps, due, stillAtTheLastStop)).toBe(2);
    expect(autoStep(steps, new Date(transferWalk.end.getTime() + 60000), null)).toBe(2);
  });

  it("gives a ride a grace period on the clock alone, and none on GPS", () => {
    const justAfter = new Date(arrivalOf(bus1).getTime() + 30000);
    expect(autoStep(steps, justAfter, null)).toBe(1);
    const lastStop = bus1.stops.at(-1)!.stop;
    expect(autoStep(steps, justAfter, here(lastStop))).toBe(2);
  });

  it("arrives when GPS puts the passenger at the destination", () => {
    const rideDone = new Date(arrivalOf(bus2).getTime() + 3 * 60000);
    expect(autoStep(steps, rideDone, null)).toBe(4);
    const arrived = guideState(steps, rideDone, here({ lat: lastWalk.toLat, lon: lastWalk.toLon }));
    expect(arrived.phase).toBe("arrived");
    expect(arrived.index).toBe(5);
  });

  it("does not claim arrival on the clock alone until long after", () => {
    expect(autoStep(steps, new Date(lastWalk.end.getTime() + 5 * 60000), null)).toBe(4);
    expect(autoStep(steps, new Date(lastWalk.end.getTime() + 11 * 60000), null)).toBe(5);
  });
});

describe("a missed vehicle", () => {
  const stop = bus1.stops[0]!.stop;

  it("is noticed when the passenger still stands at the stop two minutes after departure", () => {
    const late = new Date(departureOf(bus1).getTime() + 150000);
    expect(missedVehicle(bus1, late, here(stop))).toBe(true);
    expect(guideState(steps, late, here(stop)).phase).toBe("missed");
  });

  it("is not claimed while the vehicle may just be late, or without a position", () => {
    expect(missedVehicle(bus1, new Date(departureOf(bus1).getTime() + 60000), here(stop))).toBe(false);
    expect(missedVehicle(bus1, new Date(departureOf(bus1).getTime() + 300000), null)).toBe(false);
    expect(missedVehicle(bus1, new Date(departureOf(bus1).getTime() + 300000), { lat: stop.lat + 0.01, lon: stop.lon })).toBe(false);
  });
});

describe("stepping by hand", () => {
  it("moves one step and holds only while the automatic answer stays put", () => {
    const state = guideState(steps, T0, null);
    const next = stepBy(state, 1);
    expect(next).toEqual({ index: 1, autoAtSet: 0 });
    expect(guideState(steps, T0, null, next).index).toBe(1);
    // The clock moves the automatic answer on: the hand-set step is let go.
    expect(guideState(steps, at(5), null, next).index).toBe(1);
    expect(guideState(steps, new Date(arrivalOf(bus1).getTime() + 2 * 60000), null, next).index).toBe(2);
  });

  it("can go back, and never past either end", () => {
    const state = guideState(steps, at(5), null);
    expect(guideState(steps, at(5), null, stepBy(state, -1)).index).toBe(0);
    expect(stepBy(guideState(steps, T0, null), -1).index).toBe(0);
    const end = guideState(steps, new Date(lastWalk.end.getTime() + 30 * 60000), null);
    expect(stepBy(end, 1).index).toBe(steps.length - 1);
    expect(resolveStep(2, { index: 9, autoAtSet: 2 }, 6)).toBe(5);
  });
});

describe("fresher times", () => {
  it("replaces the times of the stops the new answer knows and keeps the rest", () => {
    const late = (stop: RideStop): RideStop => ({
      ...stop, expected: new Date(stop.expected.getTime() + 3 * 60000), source: "realtime",
    });
    const fresh = [late(bus1.stops[0]!), late(bus1.stops[2]!)];
    const updated = withFreshTimes(bus1, fresh);
    expect(departureOf(updated).getTime() - departureOf(bus1).getTime()).toBe(3 * 60000);
    expect(updated.stops[1]?.expected).toEqual(bus1.stops[1]?.expected);
    expect(updated.stops[2]?.source).toBe("realtime");
    const swapped = withLeg(journey, bus1.tripId, updated);
    expect(departureOf(swapped.legs[1] as TransitLeg)).toEqual(departureOf(updated));
    expect(swapped.legs[3]).toBe(bus2);
  });

  it("moves the guide with a delay: the ride starts three minutes later", () => {
    const late = withLeg(journey, bus1.tripId, withFreshTimes(bus1, bus1.stops.map((stop) => ({
      ...stop, expected: new Date(stop.expected.getTime() + 3 * 60000), source: "realtime" as const,
    }))));
    const lateSteps = buildSteps(late);
    expect(guideState(lateSteps, at(5), null).phase).toBe("walk");
    expect(guideState(lateSteps, at(7.5), null).phase).toBe("ride");
  });
});

// ---- what the glasses show ---------------------------------------------------

function show(state: GuideState, now: Date, position: Position | null = null, locale: "de" | "en" = "de") {
  return guideView(state, now, position, locale);
}

describe("the guide on the glasses", () => {
  const stopOfBus1 = bus1.stops[0]!.stop;

  it("tells the walk to the stop, and what comes after it", () => {
    const view = show(guideState(steps, T0, null), T0);
    expect(view.header).toBe(`Zu Fuß · ${clock(T0)}`);
    expect(view.body[0]).toBe("> Geh zur Haltestelle");
    expect(view.body[1]).toBe("Salzburg Vogelweiderstraße");
    expect(view.body[2]).toBe("200 m · 3 min zu Fuß");
    expect(view.body[4]).toBe("Dann: O-Bus 2 Richtung Walserfeld");
    expect(view.body[5]).toBe(`um ${clock(departureOf(bus1))} ~ (in 4 min)`);
    expect(view.footer).toBe("Schritt 1/6 · Uhr · 2× = beenden");
  });

  it("uses the measured distance when GPS is there", () => {
    const near = { lat: stopOfBus1.lat + 0.0009, lon: stopOfBus1.lon, accuracy: 8 };
    const view = show(guideState(steps, T0, near), T0, near);
    expect(view.body[2]).toMatch(/^100 m · 1 min zu Fuß$/);
    expect(view.footer).toContain("GPS");
  });

  it("tells the boarding: vehicle, direction, time, stand, and where to get off", () => {
    const now = at(2);
    const view = show(guideState(steps, now, here(stopOfBus1)), now, here(stopOfBus1));
    expect(view.header).toBe(`Einsteigen · ${clock(now)}`);
    expect(view.body[0]).toBe("> Warte auf O-Bus 2");
    expect(view.body[1]).toBe("Richtung Walserfeld");
    expect(view.body[2]).toBe(`um ${clock(departureOf(bus1))} ~ (in 2 min)`);
    expect(view.body[3]).toBe("Salzburg Vogelweiderstraße");
    expect(view.body[5]).toBe("Aussteigen: Salzburg Mirabellplatz");
    expect(view.body[6]).toBe(`4 Stationen · an ${clock(arrivalOf(bus1))}`);
  });

  it("says jetzt, not 'in jetzt', when the vehicle is about to leave", () => {
    const now = new Date(departureOf(bus1).getTime() - 20000);
    const view = show(guideState(steps, now, here(stopOfBus1)), now, here(stopOfBus1));
    expect(view.body[2]).toBe(`um ${clock(departureOf(bus1))} ~ (jetzt)`);
    expect(show(guideState(steps, now, here(stopOfBus1)), now, here(stopOfBus1), "en").body[2]).toBe(`at ${clock(departureOf(bus1))} ~ (now)`);
  });

  it("tells when to get off and how many halts are left", () => {
    const now = new Date(bus1.stops[1]!.expected.getTime() - 20000);
    const view = show(guideState(steps, now, null), now);
    expect(view.header).toBe(`Unterwegs · O-Bus 2 · ${clock(now)}`);
    expect(view.body[0]).toBe("> Aussteigen: Salzburg Mirabellplatz");
    expect(view.body[1]).toBe(`noch 4 Stationen · an ${clock(arrivalOf(bus1))}`);
    expect(view.body[3]).toBe("Nächster Halt: Salzburg Bayerhamerstraße · jetzt");
    expect(view.body[5]).toBe("Danach: Umsteigen auf O-Bus 10");
  });

  it("says 'nächster Halt' before the last halt, and 'Gleich aussteigen' once it is close", () => {
    // A slow line: five minutes between stops, so the last halt is not yet "arriving".
    const first = departureOf(bus1).getTime();
    const slow: TransitLeg = { ...bus1, stops: bus1.stops.map((stop, i) => ({ ...stop, expected: new Date(first + i * 5 * 60000) })) };
    const slowSteps = buildSteps({ ...journey, legs: [walk1, slow, ...journey.legs.slice(2)] });

    const early = new Date(slow.stops[3]!.expected.getTime() + 60000);
    const view = show(guideState(slowSteps, early, null), early);
    expect(view.body[1]).toBe(`nächster Halt · an ${clock(arrivalOf(slow))}`);
    expect(view.body[3]).toBe("");

    const close = new Date(slow.stops[3]!.expected.getTime() + 4.5 * 60000);
    expect(show(guideState(slowSteps, close, null), close).body[1]).toBe("Gleich aussteigen!");
  });

  it("calls the change a change: walk, vehicle, direction, stand, time", () => {
    const now = new Date(arrivalOf(bus1).getTime() + 2 * 60000);
    const view = show(guideState(steps, now, null), now);
    expect(view.header).toBe(`Umsteigen · ${clock(now)}`);
    expect(view.body[0]).toBe("> Umsteigen: O-Bus 10");
    expect(view.body[1]).toMatch(/^Geh zu Salzburg Ferdinand-Hanusch-Platz · \d+0 m$/);
    expect(view.body[2]).toBe("Richtung Walserfeld · Steig A");
    expect(view.body[3]).toMatch(/^um \d\d:\d\d ~ \(in \d+ min\)$/);
  });

  it("tells the walk to the destination, and then that it is reached", () => {
    const rideDone = new Date(arrivalOf(bus2).getTime() + 3 * 60000);
    const walking = show(guideState(steps, rideDone, null), rideDone);
    expect(walking.body[0]).toBe("> Geh zum Ziel");
    expect(walking.body[1]).toBe("Heim");
    const position = here({ lat: lastWalk.toLat, lon: lastWalk.toLon });
    const done = show(guideState(steps, rideDone, position), rideDone, position);
    expect(done.header).toBe(`Ziel erreicht · ${clock(rideDone)}`);
    expect(done.body).toEqual(["> Ziel erreicht", "Heim", "", "Tippen = zurück zu den Zielen"]);
    expect(done.footer).toBe("Tippen = fertig");
  });

  it("says plainly that the vehicle has gone", () => {
    const late = new Date(departureOf(bus1).getTime() + 150000);
    const view = show(guideState(steps, late, here(stopOfBus1)), late, here(stopOfBus1));
    expect(view.header).toBe(`Verpasst? · ${clock(late)}`);
    expect(view.body[0]).toBe("> O-Bus 2 ist schon abgefahren.");
    expect(view.body[2]).toBe("Tippen = neue Verbindung suchen");
  });

  it("asks before ending the guide", () => {
    const state = guideState(steps, T0, null);
    expect(guideView(state, T0, null, "de", { confirmStop: true }).footer).toBe("Nochmal doppeltippen = Begleitung beenden");
  });

  it("speaks English too", () => {
    const view = show(guideState(steps, T0, null), T0, null, "en");
    expect(view.body[0]).toBe("> Walk to the stop");
    expect(view.body[4]).toBe("Then: O-Bus 2 towards Walserfeld");
  });

  it("changes straight from one vehicle to the next when there is no walk between", () => {
    const direct: Journey = { ...journey, legs: [bus1, bus2, lastWalk] };
    const directSteps = buildSteps(direct);
    const state = guideState(directSteps, new Date(arrivalOf(bus1).getTime() - 60000), here(bus1.stops.at(-1)!.stop));
    expect(state.index).toBe(0);
    const after = new Date(arrivalOf(bus1).getTime() + 5000);
    const onPlatform = guideState(directSteps, after, here(bus1.stops.at(-1)!.stop));
    expect(onPlatform.index).toBe(1);
    expect(onPlatform.phase === "board" || onPlatform.phase === "ride").toBe(true);
  });

  for (const locale of locales) {
    it(`keeps every ${locale} screen inside ${ROUTE_ROWS} rows of ${ROUTE_WIDTH} characters`, () => {
      const rideDone = new Date(arrivalOf(bus2).getTime() + 3 * 60000);
      const moments: [Date, Position | null][] = [
        [T0, null],
        [at(2), here(bus1.stops[0]!.stop)],
        [new Date(departureOf(bus1).getTime() + 150000), here(bus1.stops[0]!.stop)],
        [at(5), null],
        [new Date(bus1.stops[1]!.expected.getTime() - 20000), null],
        [new Date(bus1.stops[3]!.expected.getTime() + 20000), here(bus1.stops[4]!.stop)],
        [new Date(arrivalOf(bus1).getTime() + 2 * 60000), null],
        [new Date(arrivalOf(bus1).getTime() + 3 * 60000), here({ lat: transferWalk.toLat, lon: transferWalk.toLon })],
        [rideDone, null],
        [rideDone, here({ lat: lastWalk.toLat, lon: lastWalk.toLon })],
      ];
      for (const [now, position] of moments) {
        for (const confirmStop of [false, true]) {
          const view = guideView(guideState(steps, now, position), now, position, locale, { confirmStop });
          expect(view.header.length, view.header).toBeLessThanOrEqual(ROUTE_WIDTH);
          expect(view.footer.length, view.footer).toBeLessThanOrEqual(46);
          expect(view.body.length, view.body.join("|")).toBeLessThanOrEqual(ROUTE_ROWS);
          for (const line of view.body) expect(line.length, line).toBeLessThanOrEqual(ROUTE_WIDTH);
        }
      }
    });
  }

  it("is always at the first row for the instruction that matters", () => {
    for (const minute of [0, 2, 5, 9, 12, 20]) {
      const now = at(minute);
      const view = show(guideState(steps, now, null), now);
      expect(view.body.some((line) => line.startsWith("> "))).toBe(true);
    }
    expect(minutesFrom(departureOf(bus1))).toBe(4);
  });
});

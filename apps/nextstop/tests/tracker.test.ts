import { describe, it, expect } from "vitest";
import type { Ride, RideStop } from "../src/transit/types";
import { delayMinutes, metresBetween, minutesUntil } from "../src/transit/types";
import { etaLabel, indexFromClock, indexFromPosition, trackRide } from "../src/ride/tracker";
import { HafasBackend, parseHafasTime } from "../src/transit/hafas";

const T0 = new Date("2026-09-25T19:00:00Z");

function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60000);
}

/**
 * A straight line of stops roughly 500 m apart, one minute between each.
 * Coordinates are real Salzburg latitudes so the distance maths is exercised
 * on numbers of the right magnitude.
 */
function line(count: number, delay = 0): Ride {
  const stops: RideStop[] = [];
  for (let i = 0; i < count; i += 1) {
    stops.push({
      stop: { id: `s${i}`, name: `Halt ${i}`, lat: 47.8 + i * 0.0045, lon: 13.04 },
      scheduled: at(i),
      expected: at(i + delay),
      source: delay === 0 ? "scheduled" : "realtime",
      cancelled: false,
    });
  }
  return { line: "O-Bus 6", headsign: "Itzling West", stops };
}

describe("reading the timetable", () => {
  it("names the first stop the vehicle has not yet left", () => {
    expect(indexFromClock(line(6), at(2.5))).toBe(3);
  });

  it("follows a reported delay instead of ignoring it", () => {
    // Three minutes late, so at 19:02:30 the bus has only just left stop 0.
    expect(indexFromClock(line(6, 3), at(2.5))).toBe(0);
  });

  it("runs off the end once the ride is over", () => {
    expect(indexFromClock(line(4), at(99))).toBe(4);
  });
});

describe("reading GPS", () => {
  const ride = line(6);

  it("names the nearest stop and how far off it is", () => {
    // Between stop 2 and 3, closer to 3.
    const near = indexFromPosition(ride, { lat: 47.8 + 2.8 * 0.0045, lon: 13.04 });
    expect(near?.index).toBe(3);
    expect(near?.metres).toBeGreaterThan(80);
    expect(near?.metres).toBeLessThan(130);
  });

  it("does not decide on its own whether a stop is ahead or behind", () => {
    // Sitting on stop 2, the honest geometric answer is 2. Whether the bus
    // is about to arrive or has just pulled away is the timetable's call.
    expect(indexFromPosition(ride, { lat: 47.8 + 2 * 0.0045, lon: 13.04 })?.index).toBe(2);
  });

  it("ignores a fix too vague to distinguish stops", () => {
    expect(indexFromPosition(ride, { lat: 47.8, lon: 13.04, accuracy: 2000 })).toBeNull();
  });
});

describe("standing at a stop", () => {
  it("still points at it while its time is yet to come", () => {
    // On top of stop 2 at 19:01:30, and stop 2 is due at 19:02 — it is the
    // stop being pulled into, not one already served.
    const progress = trackRide(line(6), at(1.5), { lat: 47.8 + 2 * 0.0045, lon: 13.04 });
    expect(progress?.next.stop.name).toBe("Halt 2");
    expect(progress?.arriving).toBe(true);
  });

  it("moves on once that time has passed", () => {
    const progress = trackRide(line(6), at(2.5), { lat: 47.8 + 2 * 0.0045, lon: 13.04 });
    expect(progress?.next.stop.name).toBe("Halt 3");
  });
});

describe("reconciling the two", () => {
  it("uses GPS when it agrees with the clock", () => {
    const progress = trackRide(line(8), at(3.5), { lat: 47.8 + 3.8 * 0.0045, lon: 13.04 });
    expect(progress?.basis).toBe("gps");
    expect(progress?.next.stop.name).toBe("Halt 4");
  });

  it("falls back to the clock when GPS is unavailable underground", () => {
    const progress = trackRide(line(8), at(3.5), null);
    expect(progress?.basis).toBe("clock");
    expect(progress?.next.stop.name).toBe("Halt 4");
    expect(progress?.metresToNext).toBeUndefined();
  });

  it("distrusts GPS that matches a stop from the far end of a loop", () => {
    // A route that returns near its start: physically closest to stop 7,
    // while the timetable says the bus left stop 0 a moment ago. Believing
    // GPS here would announce the end of the line two minutes into the ride.
    const ride = line(8);
    const loop: Ride = {
      ...ride,
      stops: ride.stops.map((s, i) => (i === 7
        ? { ...s, stop: { ...s.stop, lat: 47.8002, lon: 13.04 } }
        : s)),
    };
    // Sitting exactly on the returning stop 7, half a minute into the ride.
    const progress = trackRide(loop, at(0.5), { lat: 47.8002, lon: 13.04 });
    expect(progress?.basis).toBe("clock");
    expect(progress?.next.stop.name).toBe("Halt 1");
  });

  it("lists what comes after, so the display can show more than one", () => {
    const progress = trackRide(line(8), at(2.5), null);
    expect(progress?.upcoming.map((s) => s.stop.name)).toEqual([
      "Halt 4", "Halt 5", "Halt 6", "Halt 7",
    ]);
  });

  it("says when to stand up", () => {
    const close = trackRide(line(6), at(2.5), { lat: 47.8 + 3 * 0.0045 - 0.0005, lon: 13.04 });
    expect(close?.arriving).toBe(true);
    const far = trackRide(line(6), at(2.0), { lat: 47.8 + 2.1 * 0.0045, lon: 13.04 });
    expect(far?.arriving).toBe(false);
  });

  it("reports the end of the line rather than an empty screen", () => {
    const progress = trackRide(line(5), at(99), null);
    expect(progress?.finished).toBe(true);
    expect(progress?.next.stop.name).toBe("Halt 4");
    expect(progress?.upcoming).toEqual([]);
  });

  it("never re-derives from its own previous answer", () => {
    // Called out of order, each answer must depend only on the time given.
    const ride = line(8);
    const late = trackRide(ride, at(5.5), null);
    const early = trackRide(ride, at(1.5), null);
    expect(early?.next.stop.name).toBe("Halt 2");
    expect(late?.next.stop.name).toBe("Halt 6");
  });

  it("copes with a ride carrying no stops at all", () => {
    expect(trackRide({ line: "x", headsign: "y", stops: [] }, T0, null)).toBeNull();
  });
});

describe("wording", () => {
  it("says jetzt rather than counting below zero", () => {
    const stop = line(2).stops[0] as RideStop;
    expect(etaLabel(stop, at(0), "de")).toBe("jetzt");
    expect(etaLabel(stop, at(5), "de")).toBe("jetzt");
  });

  it("uses singular for one minute", () => {
    expect(etaLabel(line(4).stops[3] as RideStop, at(2), "de")).toBe("1 min");
  });

  it("switches to hours on a long ride", () => {
    const stop = { ...(line(2).stops[0] as RideStop), expected: at(135) };
    expect(etaLabel(stop, at(0), "de")).toBe("2h 15m");
  });
});

describe("times as ÖBB writes them", () => {
  const day = new Date("2026-09-25T12:00:00Z");

  it("reads a plain HHMMSS time", () => {
    const parsed = parseHafasTime("193900", day);
    expect(parsed?.getHours()).toBe(19);
    expect(parsed?.getMinutes()).toBe(39);
  });

  it("honours the day-offset prefix a night service carries", () => {
    // "01000500" is five past midnight the following day. Dropping the prefix
    // would place it sixteen hours in the past, at the top of the board.
    const parsed = parseHafasTime("01000500", day);
    expect(parsed?.getDate()).toBe(day.getDate() + 1);
    expect(parsed?.getHours()).toBe(0);
    expect(parsed?.getMinutes()).toBe(5);
  });

  it("returns nothing rather than a wrong time for junk", () => {
    expect(parseHafasTime(undefined, day)).toBeNull();
    expect(parseHafasTime("12", day)).toBeNull();
  });
});

describe("stop names", () => {
  it("reduces a stand to the place it belongs to", () => {
    expect(HafasBackend.baseName("Salzburg Mirabellplatz (Schloss Mirabell)"))
      .toBe("Salzburg Mirabellplatz");
  });

  it("leaves a plain name alone", () => {
    expect(HafasBackend.baseName("Salzburg Hbf")).toBe("Salzburg Hbf");
  });

  it("does not eat brackets from the middle of a name", () => {
    expect(HafasBackend.baseName("Bad Ischl (Bahnhof) Busterminal"))
      .toBe("Bad Ischl (Bahnhof) Busterminal");
  });
});

describe("shared arithmetic", () => {
  it("rounds waiting time down, never up", () => {
    // 89 seconds is "1 min". Rounding to 2 would send someone to a bus
    // that has already gone.
    expect(minutesUntil(new Date(T0.getTime() + 89000), T0)).toBe(1);
  });

  it("reports a delay only when it is actually known", () => {
    const base = line(4).stops[0] as RideStop;
    expect(delayMinutes({ ...base, expected: at(3), source: "realtime" })).toBe(3);
    expect(delayMinutes({ ...base, expected: at(3), source: "scheduled" })).toBe(0);
  });

  it("measures distance to within a few metres", () => {
    // Salzburg Hbf to Mirabellplatz is about 900 m as the crow flies.
    const metres = metresBetween(47.8130, 13.0451, 47.8057, 13.0429);
    expect(metres).toBeGreaterThan(800);
    expect(metres).toBeLessThan(1000);
  });
});

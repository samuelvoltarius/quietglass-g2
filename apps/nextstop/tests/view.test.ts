import { describe, it, expect } from "vitest";
import type { Departure, Ride, Stop } from "../src/transit/types";
import {
  BODY_ROWS, CURSOR, LINE_WIDTH, certainty, departureBoard, errorView, rideStopName, ridingView,
  waitLabel, wrap,
} from "../src/glasses/view";
import { trackRide } from "../src/ride/tracker";

const NOW = new Date("2026-09-25T19:00:00Z");
const STOP: Stop = { id: "1350162", name: "Salzburg Mirabellplatz", lat: 47.8057, lon: 13.0429 };

function departure(over: Partial<Departure> = {}): Departure {
  return {
    line: "O-Bus 6",
    headsign: "Itzling West",
    inMinutes: 4,
    scheduled: new Date(NOW.getTime() + 4 * 60000),
    expected: new Date(NOW.getTime() + 4 * 60000),
    source: "scheduled",
    cancelled: false,
    tripId: "t1",
    ...over,
  };
}

describe("how certain a time is", () => {
  it("marks a timetable time as unconfirmed", () => {
    expect(certainty(departure({ source: "scheduled" }))).toBe("~");
  });

  it("marks a confirmed on-time departure differently from an unconfirmed one", () => {
    // The whole point: these two must never print the same.
    const live = certainty(departure({ source: "realtime" }));
    const planned = certainty(departure({ source: "scheduled" }));
    expect(live).toBe("●");
    expect(live).not.toBe(planned);
  });

  it("shows a delay as a number", () => {
    expect(certainty(departure({
      source: "realtime",
      expected: new Date(NOW.getTime() + 11 * 60000),
      scheduled: new Date(NOW.getTime() + 4 * 60000),
    }))).toBe("+7");
  });

  it("does not hide a service running early", () => {
    expect(certainty(departure({
      source: "realtime",
      expected: new Date(NOW.getTime() + 2 * 60000),
      scheduled: new Date(NOW.getTime() + 4 * 60000),
    }))).toBe("-2");
  });

  it("calls out a cancellation above everything else", () => {
    expect(certainty(departure({ cancelled: true, source: "realtime" }))).toBe("X");
  });
});

describe("waiting time", () => {
  it("says jetzt instead of 0", () => {
    expect(waitLabel(departure({ inMinutes: 0 }))).toBe("jetzt");
    expect(waitLabel(departure({ inMinutes: -2 }))).toBe("jetzt");
  });

  it("says so plainly when a service is cancelled", () => {
    expect(waitLabel(departure({ cancelled: true }))).toBe("fällt aus");
  });

  it("switches to hours rather than printing 95 min", () => {
    expect(waitLabel(departure({ inMinutes: 95 }))).toBe("1h35");
  });
});

describe("the departure board", () => {
  const board = departureBoard(STOP, [
    departure({ line: "175", headsign: "Salzburg Hbf", inMinutes: 0, source: "realtime",
      expected: new Date(NOW.getTime() + 7 * 60000), track: "B" }),
    departure({ line: "150", headsign: "Bad Ischl", inMinutes: 1, source: "realtime" }),
    departure({ line: "1", headsign: "Makartplatz", inMinutes: 2 }),
  ], 35);

  it("names the stop and how far off it is", () => {
    expect(board.header).toContain("Mirabellplatz");
    expect(board.header).toContain("35 m");
  });

  it("fits the display", () => {
    for (const row of board.body) expect(row.length).toBeLessThanOrEqual(LINE_WIDTH);
  });

  it("shows line, destination and wait on one row", () => {
    const row = board.body[0] ?? "";
    expect(row).toContain("175");
    expect(row).toContain("Salzburg Hbf");
    expect(row).toContain("jetzt");
  });

  it("says in the footer that some times are live", () => {
    expect(board.footer).toContain("live");
  });

  it("does not claim live data when there is none", () => {
    const planned = departureBoard(STOP, [departure(), departure()], null);
    expect(planned.footer).toContain("nur Fahrplan");
    expect(planned.footer).not.toContain("live");
  });

  it("never shows more rows than the container holds", () => {
    const many = departureBoard(STOP, Array.from({ length: 20 }, () => departure()), null);
    expect(many.body.length).toBeLessThanOrEqual(BODY_ROWS);
  });

  it("explains an empty board instead of showing nothing", () => {
    const empty = departureBoard(STOP, [], 12);
    expect(empty.body.join(" ")).toContain("Keine Abfahrten");
    expect(empty.body.join(" ")).toMatch(/Betriebsschluss|bedient/);
  });

  it("omits the distance when the position is unknown", () => {
    expect(departureBoard(STOP, [departure()], null).header).toBe(STOP.name);
  });
});

describe("the ride", () => {
  function ride(count: number): Ride {
    return {
      line: "O-Bus 6",
      headsign: "Itzling West",
      stops: Array.from({ length: count }, (_, i) => ({
        stop: { id: `s${i}`, name: `Halt ${i}`, lat: 47.8 + i * 0.0045, lon: 13.04 },
        scheduled: new Date(NOW.getTime() + i * 60000),
        expected: new Date(NOW.getTime() + i * 60000),
        source: "scheduled" as const,
        cancelled: false,
      })),
    };
  }

  const progress = trackRide(ride(10), new Date(NOW.getTime() + 150000), null);

  it("puts the next stop first and marks it", () => {
    const view = ridingView(progress!, new Date(NOW.getTime() + 150000), "O-Bus 6", "Itzling West");
    expect(view.body[0]).toContain(CURSOR);
    expect(view.body[0]).toContain("Halt 3");
  });

  it("names the line and where it is going", () => {
    const view = ridingView(progress!, NOW, "O-Bus 6", "Itzling West");
    expect(view.header).toBe("O-Bus 6 → Itzling West");
  });

  it("says how many stops are left", () => {
    const view = ridingView(progress!, new Date(NOW.getTime() + 150000), "O-Bus 6", "Itzling West");
    expect(view.body.join(" ")).toContain("noch 6 Halte");
  });

  it("admits when the next stop is only a timetable estimate", () => {
    const view = ridingView(progress!, NOW, "O-Bus 6", "Itzling West");
    expect(view.footer).toContain("geschätzt");
  });

  it("says GPS, with the distance, when it actually has a fix", () => {
    const tracked = trackRide(ride(10), new Date(NOW.getTime() + 150000),
      { lat: 47.8 + 2.7 * 0.0045, lon: 13.04 });
    const view = ridingView(tracked!, new Date(NOW.getTime() + 150000), "O-Bus 6", "Itzling");
    expect(view.footer).toContain("GPS");
    expect(view.footer).toMatch(/\d+ m/);
  });

  it("fits the display", () => {
    const view = ridingView(progress!, NOW, "O-Bus 6", "Itzling West");
    for (const row of view.body) expect(row.length).toBeLessThanOrEqual(LINE_WIDTH);
    expect(view.body.length).toBeLessThanOrEqual(BODY_ROWS);
  });

  it("says the ride is over rather than showing an empty list", () => {
    const done = trackRide(ride(5), new Date(NOW.getTime() + 99 * 60000), null);
    const view = ridingView(done!, NOW, "O-Bus 6", "Itzling West");
    expect(view.body.join(" ")).toContain("Endstation");
  });
});

describe("failure", () => {
  it("says what went wrong and what to do", () => {
    const view = errorView("ÖBB nicht erreichbar", "Läuft der Proxy?");
    expect(view.body.join(" ")).toContain("nicht erreichbar");
    expect(view.body.join(" ")).toContain("Proxy");
    expect(view.footer).toContain("nochmal");
  });

  it("wraps text to the display width", () => {
    expect(wrap("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
  });
});

describe("what the glasses can actually draw", () => {
  it("uses a marker the display renders", () => {
    // "▸" was drawn as nothing at all on real output, which silently removed
    // the only sign of which row a tap would act on.
    expect(CURSOR).toMatch(/^[\x20-\x7e]$/);
  });

  it("never runs the line number into the destination", () => {
    // The font is proportional, so "Bus 175" padded to seven characters left
    // no gap at all and printed as "Bus 175Rif Ortsmitte".
    const board = departureBoard(
      { id: "x", name: "Test", lat: 0, lon: 0 },
      [departure({ line: "Bus 175", headsign: "Rif Ortsmitte" })],
      null,
    );
    expect(board.body[0]).not.toContain("Bus 175Rif");
    expect(board.body[0]).toMatch(/Bus 175\s+Rif Ortsmitte/);
  });

  it("separates the time from the destination with a visible mark", () => {
    const board = departureBoard(
      { id: "x", name: "Test", lat: 0, lon: 0 },
      [departure({ headsign: "Itzling West", inMinutes: 3 })],
      null,
    );
    expect(board.body[0]).toContain("· 3 min");
  });
});

describe("stop names while riding", () => {
  it("drops the stand, which is meaningless from inside the vehicle", () => {
    expect(rideStopName("Salzburg Makartplatz (Aicherpassage)"))
      .toBe("Salzburg Makartplatz");
  });

  it("never leaves a bracket hanging open", () => {
    // The failure seen on real output: a straight cut at 32 characters
    // produced "Salzburg Makartplatz (Aicherpass".
    const shown = rideStopName("Salzburg Mozartsteg (Landhausgasse)");
    const opens = (shown.match(/\(/g) ?? []).length;
    const closes = (shown.match(/\)/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it("marks a name it had to shorten", () => {
    const shown = rideStopName("Ein ausgesprochen langer Haltestellenname ohne Klammern");
    expect(shown.length).toBeLessThanOrEqual(32);
    expect(shown.endsWith("…")).toBe(true);
  });
});

describe("review regressions", () => {
  it("keeps the waiting time on the row when the line name is long", () => {
    // Regression: the destination was always given 22 characters and the row
    // cut at 46, so a long line name pushed the time and the delay off the end.
    const board = departureBoard(STOP, [departure({
      line: "Railjet Xpress 563", headsign: "Wien Hauptbahnhof Bahnsteig 1-2", track: "10A",
      inMinutes: 12, source: "realtime",
      expected: new Date(NOW.getTime() + 15 * 60000), scheduled: new Date(NOW.getTime() + 12 * 60000),
    })], null);
    expect(board.body[0]!.length).toBeLessThanOrEqual(LINE_WIDTH);
    expect(board.body[0]).toContain("· 12 min +3 10A");
  });

  it("counts the minutes down between fetches", () => {
    // Regression: the minute count was frozen when the board was fetched, so
    // with a 2-minute refresh the board said "4 min" for a bus 1 minute away.
    const leavingSoon = departure({ inMinutes: 4, expected: new Date(NOW.getTime() + 90000) });
    const board = departureBoard(STOP, [leavingSoon], null, 0, NOW);
    expect(board.body[0]).toContain("· 1 min");
  });

  it("fits a long stop name and its distance into the header", () => {
    // Regression: the header was never cut, so it wrapped into the body.
    const long = { ...STOP, name: "Salzburg Hauptbahnhof (Südtiroler Platz) Bussteig F" };
    const board = departureBoard(long, [departure()], 120);
    expect(board.header.length).toBeLessThanOrEqual(LINE_WIDTH);
    expect(board.header.endsWith(" · 120 m")).toBe(true);
  });

  it("fits a long headsign into the ride header", () => {
    const ride: Ride = {
      line: "REX 1", headsign: "Wien Hauptbahnhof über Linz, St. Pölten und Tullnerfeld",
      stops: [0, 1].map((i) => ({
        stop: { id: `s${i}`, name: `Halt ${i}`, lat: 47.8 + i * 0.01, lon: 13.04 },
        scheduled: new Date(NOW.getTime() + (i + 1) * 60000),
        expected: new Date(NOW.getTime() + (i + 1) * 60000),
        source: "scheduled" as const, cancelled: false,
      })),
    };
    const view = ridingView(trackRide(ride, NOW, null)!, NOW, ride.line, ride.headsign);
    expect(view.header.length).toBeLessThanOrEqual(LINE_WIDTH);
  });

  it("does not count down to a next stop that is cancelled", () => {
    // Regression: a cancelled next stop showed "3 min" like any other, so the
    // passenger got up for a stop the vehicle would drive past.
    const ride: Ride = {
      line: "O-Bus 6", headsign: "Itzling West",
      stops: [0, 1, 2].map((i) => ({
        stop: { id: `s${i}`, name: `Halt ${i}`, lat: 47.8 + i * 0.01, lon: 13.04 },
        scheduled: new Date(NOW.getTime() + (i * 3 + 3) * 60000),
        expected: new Date(NOW.getTime() + (i * 3 + 3) * 60000),
        source: "realtime" as const, cancelled: i === 0,
      })),
    };
    const view = ridingView(trackRide(ride, NOW, null)!, NOW, ride.line, ride.headsign);
    expect(view.body[0]).toContain("Halt 0");
    expect(view.body[0]).toContain("fällt aus");
    expect(view.body[0]).not.toContain("3 min");
  });

  it("keeps an error with a long unbroken hint inside the body", () => {
    // Regression: a URL in the hint became one 80-character "word" that wrap()
    // could not break, so it wrapped on the glasses anyway.
    const view = errorView("Abfrage fehlgeschlagen", "http://" + "x".repeat(120));
    for (const row of view.body) expect(row.length).toBeLessThanOrEqual(LINE_WIDTH);
    expect(view.body.length).toBeLessThanOrEqual(BODY_ROWS);
  });
});

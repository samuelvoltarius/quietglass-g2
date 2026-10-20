import { describe, expect, it } from "vitest";
import type { Departure, Ride, RideStop, Stop } from "../src/transit/types";
import { boardingIndex, followRide } from "../src/ride/follow";
import { bySoonest, glanceHeadsign, messageScene, sureness } from "../src/glasses/board";
import { boardScene } from "../src/cockpit/scene";
import { followLoadingModel, followModel, followLoadingScene, followScene } from "../src/cockpit/follow";
import { boardModel } from "../src/cockpit/model";
import { BOARD_ROWS } from "../src/glasses/layout";

const NOW = new Date("2026-10-13T10:00:00Z");
const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60000);

/**
 * Bus 150 as ÖBB sent it on 13.10.2026 at Mirabellplatz (trimmed): the trip
 * starts at the station, passes the passenger's stop as its third stop and
 * goes on far out of town.
 */
const names = [
  ["Salzburg Hbf (Südtiroler Platz)", 47.8128, 13.0456],
  ["Salzburg Kiesel (Saint-Julien-Straße)", 47.8096, 13.0447],
  ["Salzburg Mirabellplatz (Schloss Mirabell)", 47.8057, 13.0431],
  ["Salzburg Hofwirt (Schallmooser Hauptstraße)", 47.8077, 13.0503],
  ["Salzburg Sterneckstraße (Linzer Bundesstraße)", 47.8122, 13.0628],
  ["Salzburg Gnigl Bahnhst", 47.8141, 13.0659],
] as const;
function stops(firstMinutes: number, live = true): RideStop[] {
  return names.map(([name, lat, lon], index) => ({
    stop: { id: String(index), name, lat, lon },
    scheduled: at(firstMinutes + index * 2),
    expected: at(firstMinutes + index * 2),
    source: live ? "realtime" as const : "scheduled" as const,
    cancelled: false,
  }));
}
const MIRABELL: Stop = { id: "1350162", name: "Salzburg Mirabellplatz", lat: 47.80514, lon: 13.04331 };
const AT_STOP = { lat: 47.8060, lon: 13.0430, accuracy: 10 };

function departure(over: Partial<Departure> = {}): Departure {
  return {
    line: "Bus 150", headsign: "Bad Ischl via Hof", inMinutes: 4, scheduled: at(4), expected: at(4),
    source: "realtime", track: "G", cancelled: false, tripId: "t", ...over,
  };
}

describe("following a bus from the board", () => {
  it("finds the passenger's stop in the trip by its name without the stand", () => {
    const ride: Ride = { line: "Bus 150", headsign: "Bad Ischl", stops: stops(0) };
    expect(boardingIndex(ride, MIRABELL, at(4))).toBe(2);
  });

  it("takes the visit closest in time when a route passes the place twice", () => {
    const loop = [...stops(0), ...stops(20)];
    expect(boardingIndex({ line: "1", headsign: "Ring", stops: loop }, MIRABELL, at(23))).toBe(8);
  });

  it("falls back to a stop a few hundred metres away, and to -1 when none", () => {
    const renamed = stops(0).map((s, i) => (i === 2 ? { ...s, stop: { ...s.stop, name: "Mirabellplatz Ost" } } : s));
    expect(boardingIndex({ line: "1", headsign: "x", stops: renamed }, MIRABELL, at(4))).toBe(2);
    const far = { ...MIRABELL, name: "Elsewhere", lat: 48.2, lon: 16.37 };
    expect(boardingIndex({ line: "1", headsign: "x", stops: stops(0) }, far, at(4))).toBe(-1);
  });

  it("waits for the bus at the passenger's stop instead of following it far away (0.3.7 showed Gnigl)", () => {
    // The bus is still two stops away; 0.3.7 showed its own next stop and the rest of its trip.
    const ride: Ride = { line: "Bus 150", headsign: "Bad Ischl", stops: stops(1) };
    const state = followRide(ride, 2, at(5), NOW, AT_STOP);
    expect(state?.phase).toBe("coming");
    if (state?.phase !== "coming") return;
    expect(state.departs.getTime()).toBe(at(5).getTime());
    expect(state.busAt?.stop.name).toMatch(/^Salzburg Hbf/);
    expect(state.stopsAway).toBe(2);
  });

  it("keeps waiting while the passenger stands at the stop and the bus is late beyond the report", () => {
    // 0.3.7: once the printed time had passed, the stop counted as served and
    // the screen jumped to the next stop while the passenger was still waiting.
    const ride: Ride = { line: "Bus 150", headsign: "Bad Ischl", stops: stops(-6) };
    const waiting = followRide(ride, 2, at(-2), NOW, AT_STOP);
    expect(waiting?.phase).toBe("coming");
    // Without a position, a bus two minutes past its time has gone.
    expect(followRide(ride, 2, at(-2), NOW, null)?.phase).toBe("riding");
  });

  it("rides from the passenger's stop on: the next stop is the one after it", () => {
    const ride: Ride = { line: "Bus 150", headsign: "Bad Ischl", stops: stops(-6) };
    const moving = { lat: 47.8068, lon: 13.0470, accuracy: 15 };
    const state = followRide(ride, 2, at(-2), NOW, moving);
    expect(state?.phase).toBe("riding");
    if (state?.phase !== "riding") return;
    expect(state.progress.next.stop.name).toMatch(/^Salzburg Hofwirt/);
    expect(state.terminus.stop.name).toBe("Salzburg Gnigl Bahnhst");
  });

  it("ends after the last stop, and follows the whole trip when the stop was not found", () => {
    const ride: Ride = { line: "Bus 150", headsign: "Bad Ischl", stops: stops(-30) };
    expect(followRide(ride, 2, at(-26), NOW, null)?.phase).toBe("finished");
    const whole = followRide({ ...ride, stops: stops(-1) }, -1, at(4), NOW, null);
    expect(whole?.phase).toBe("riding");
  });
});

describe("the board page: one thing big, little text", () => {
  const departures = [
    departure({ line: "O-Bus 3", headsign: "Salzburg Süd", expected: at(9), scheduled: at(9), track: "E", tripId: "a" }),
    departure({ line: "Bus 25", headsign: "Hauptbahnhof", expected: at(1), scheduled: at(1), source: "scheduled", track: "A", tripId: "b" }),
    departure({ line: "Bus 150", headsign: "Salzburg Hbf", expected: at(16), scheduled: at(2), track: "C", tripId: "c" }),
    departure({ line: "O-Bus 6", headsign: "Itzling West (Bahnhof)", expected: at(4), scheduled: at(4), track: "A", tripId: "d" }),
  ];

  it("sorts by the time now expected, not the printed one", () => {
    expect(bySoonest(departures).map((d) => d.tripId)).toEqual(["b", "d", "a", "c"]);
  });

  it("the board is the cockpit: the line and minutes as the headline, the direction under it, six cells, one hint line", () => {
    const sorted = bySoonest(departures);
    const model = boardModel({ stop: MIRABELL, departures: sorted, selected: 1, metresAway: 99, now: NOW, locale: "de" });
    expect(model.headline).toBe("O-BUS 6 · 4 MIN");
    expect(model.direction).toBe("→ ITZLING WEST");
    expect(model.cells).toEqual([
      { label: "DANACH", value: "9 MIN" },
      { label: "STEIG", value: "A" },
      { label: "VERSPÄTUNG", value: "0 MIN" },
      { label: "HALT", value: "SALZBURG MIRABELLPLATZ" },
      { label: "WEG", value: "100 M" },
      { label: "ABFAHRT", value: expect.stringMatching(/^\d\d:\d\d$/) },
    ]);
    expect(model.hint).toBe("2/4 · Tippen = folgen · Wischen = wählen · Halten = Ziel · 2× = zurück");
    expect(model.hint.length).toBeLessThanOrEqual(70);
    expect(model.hint.endsWith("2× = zurück")).toBe(true);
    const scene = boardScene(MIRABELL, sorted, 99, "de", 1, NOW);
    expect(scene.kind).toBe("cockpit");
    expect(scene.images.map((image) => image.id)).toEqual([4, 5, 6, 7]);
    expect(scene.view.footer).toBe(model.hint);
  });

  it("keeps only where a bus goes, not the way it takes", () => {
    expect(glanceHeadsign("Hallein via Aigen ~ Puch Gewerbegebiet ~ Oberalm")).toBe("Hallein");
    expect(glanceHeadsign("Salzburg via Strobl ~ St.Gilgen ~ Fuschl")).toBe("Salzburg");
    expect(glanceHeadsign("Wien Westbahnhof über Linz")).toBe("Wien Westbahnhof");
    expect(glanceHeadsign("Itzling West (Bahnhof)")).toBe("Itzling West");
  });

  it("says a delay and a timetable-only time in words", () => {
    expect(sureness(departures[2]!, "de")).toBe("+14 min");
    expect(sureness(departures[1]!, "de")).toBe("~ Fahrplan");
    expect(sureness({ ...departures[0]!, cancelled: true }, "de")).toBe("fällt aus");
  });

  it("board and followed bus share the cockpit page, so tapping a departure never rebuilds", () => {
    const ride: Ride = { line: "Bus 150", headsign: "Bad Ischl via Hof ~ Fuschl", stops: stops(1) };
    const chosen = departure();
    const coming = followRide(ride, 2, at(5), NOW, AT_STOP)!;
    const riding = followRide({ ...ride, stops: stops(-6) }, 2, at(-2), NOW, { lat: 47.8068, lon: 13.047 })!;
    const scenes = [
      boardScene(MIRABELL, bySoonest(departures), 99, "de", 0, NOW),
      followLoadingScene(chosen, NOW, "de", MIRABELL.name),
      followScene(chosen, coming, NOW, "de"),
      followScene(chosen, riding, NOW, "de"),
    ];
    for (const scene of scenes) {
      expect(scene.kind).toBe("cockpit");
      expect(scene.images.map((image) => image.id)).toEqual([4, 5, 6, 7]);
      expect(scene.view.footer.length).toBeLessThanOrEqual(70);
    }
    // Empty boards and failures stay on the message page.
    const message = messageScene("ÖBB nicht erreichbar", "Prüfe das Internet am Handy und tippe nochmal.", "Tippen = nochmal · 2× = zurück", "!");
    expect(message.kind).toBe("board");
    expect(message.view.body.length).toBeLessThanOrEqual(BOARD_ROWS);
    expect(boardScene(MIRABELL, [], 99, "de", 0, NOW).kind).toBe("board");
  });

  it("answers the tap with the picked bus while its stops load", () => {
    const model = followLoadingModel(departure(), NOW, "de", MIRABELL.name);
    expect(model.title).toBe("FOLGEN · ● live");
    expect(model.headline).toBe("BUS 150 · 4 MIN");
    expect(model.direction).toBe("→ BAD ISCHL");
    expect(model.caption).toBe("Fahrt wird geladen …");
    expect(model.hint).toBe("Tippen = abbrechen · 2× = Ende");
  });

  it("waiting: minutes until it leaves here, where the bus is, the board's direction", () => {
    const ride: Ride = { line: "Bus 150", headsign: "Bad Ischl via Hof ~ Fuschl ~ St.Gilgen", stops: stops(1) };
    const model = followModel(departure(), followRide(ride, 2, at(5), NOW, AT_STOP)!, NOW, "de");
    expect(model.headline).toBe("BUS 150 · 5 MIN");
    expect(model.ring).toMatchObject({ center: "5", sub: "MIN" });
    expect(model.cells.find((cell) => cell.label === "BUS BEI")?.value).toBe("SALZBURG HBF");
    expect(model.cells.find((cell) => cell.label === "VOR DIR")?.value).toBe("2");
    // In the last minute the ring is full and says "jetzt".
    const last = followModel(departure(), followRide(ride, 2, at(5), at(5), AT_STOP)!, at(5), "de");
    expect(last.ring).toMatchObject({ progress: 1, center: "JETZT" });
  });

  it("riding: the next stop is the headline, minutes to it in the ring, then and the terminus in cells (place left out)", () => {
    const ride: Ride = { line: "Bus 150", headsign: "Bad Ischl", stops: stops(-6) };
    const state = followRide(ride, 2, at(-2), NOW, { lat: 47.8068, lon: 13.047 })!;
    const model = followModel(departure(), state, NOW, "de");
    expect(model.headline).toBe("HOFWIRT");
    expect(model.direction).toMatch(/^NÄCHSTER HALT · (\d+ MIN|JETZT)$/);
    expect(model.cells.find((cell) => cell.label === "DANACH")?.value).toBe("STERNECKSTRASSE");
    expect(model.cells.find((cell) => cell.label === "ZIEL")?.value).toBe("GNIGL BAHNHST");
    expect(model.cells.find((cell) => cell.label === "AN")?.value).toBe(clockOf(at(4)));
    expect(model.cells.find((cell) => cell.label === "NOCH")?.value).toBe("3");
    expect(model.hint).toBe("GPS · Tippen = Fahrt abbrechen · 2× = Ende");
  });

  it("armed, the hint is the confirming line", () => {
    const ride: Ride = { line: "Bus 150", headsign: "Bad Ischl", stops: stops(-6) };
    const state = followRide(ride, 2, at(-2), NOW, { lat: 47.8068, lon: 13.047 })!;
    expect(followScene(departure(), state, NOW, "de", true).view.footer).toBe("Nochmal tippen = Fahrt abbrechen · 2× = abbrechen");
  });
});

function clockOf(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

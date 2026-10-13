import type { Ride, RideStop, Stop } from "../transit/types";
import { metresBetween } from "../transit/types";
import { indexFromClock, trackRide, type Position, type RideProgress } from "./tracker";

/**
 * Following a bus picked on the departure board.
 *
 * A ride from the backend is the vehicle's whole trip, from its first stop to
 * its last. The passenger, though, stands at one stop in the middle of it, and
 * until the bus has been there nothing about its later stops matters. Treating
 * the whole trip as "the ride" (0.3.7) showed, right after the tap, the stop
 * the bus happened to be approaching kilometres away - or, standing at the
 * stop, "Mirabellplatz · gleich" for ten minutes without a change. On the
 * glasses that read as a frozen app.
 *
 * So the ride is anchored at the stop it was picked from:
 *
 *  - "coming": the bus has not reached the passenger's stop yet. What matters
 *    is how long until it leaves there, and where the bus is now.
 *  - "riding": the bus has left that stop; from here on it is the stops ahead.
 *  - "finished": past the last stop.
 */

/** Grace after the departure time before the bus counts as gone. */
const DEPARTED_GRACE_MS = 60000;
/** Standing this close to the boarding stop after the departure time: the bus is late, not gone. */
const STILL_AT_STOP_METRES = 150;
/** How long being at the stop keeps the bus "coming" past its time. */
const LATE_AT_STOP_MS = 5 * 60000;
/** A stop of the ride this close to the board's stop is the same place under another stand name. */
const SAME_PLACE_METRES = 400;

/** "Salzburg Mirabellplatz (Mozarteum)" -> "salzburg mirabellplatz". */
function placeName(name: string): string {
  return name.replace(/\s*\([^()]*\)\s*$/, "").trim().toLowerCase();
}

/**
 * Index in `ride.stops` of the stop the bus was picked at, or -1.
 *
 * The board shows a place ("Mirabellplatz", all stands together); the ride
 * lists one stand ("Mirabellplatz (Mozarteum)"). The name without the stand
 * decides, and when a route passes a place twice, the visit whose time is
 * closest to the departure on the board. Without a name match, a stop within
 * a few hundred metres of the board's stop will do.
 */
export function boardingIndex(ride: Ride, stop: Stop, departs: Date): number {
  const wanted = placeName(stop.name);
  let best = -1;
  let bestGap = Number.POSITIVE_INFINITY;
  ride.stops.forEach((entry, index) => {
    if (placeName(entry.stop.name) !== wanted) return;
    const gap = Math.abs(entry.expected.getTime() - departs.getTime());
    if (gap < bestGap) { best = index; bestGap = gap; }
  });
  if (best >= 0) return best;

  ride.stops.forEach((entry, index) => {
    const metres = metresBetween(stop.lat, stop.lon, entry.stop.lat, entry.stop.lon);
    if (metres > SAME_PLACE_METRES) return;
    const gap = Math.abs(entry.expected.getTime() - departs.getTime());
    if (gap < bestGap) { best = index; bestGap = gap; }
  });
  return best;
}

export type Follow =
  | {
    readonly phase: "coming";
    /** When the bus leaves the passenger's stop. */
    readonly departs: Date;
    readonly boarding: RideStop;
    /** The stop the bus reaches next on its way here, when it is not here yet. */
    readonly busAt: RideStop | null;
    /** Stops between the bus and the passenger (0: it is at or just before this stop). */
    readonly stopsAway: number;
  }
  | {
    readonly phase: "riding";
    readonly progress: RideProgress;
    /** The last stop of the ride. */
    readonly terminus: RideStop;
    /** The stops of the ride from the passenger's stop on (for naming them short). */
    readonly stops: readonly RideStop[];
  }
  | { readonly phase: "finished"; readonly terminus: RideStop };

/**
 * Where the followed bus is, from the passenger's point of view.
 * `boarding` of -1 (stop not found in the ride) follows the whole trip, as before.
 */
export function followRide(ride: Ride, boarding: number, departs: Date, now: Date, position: Position | null): Follow | null {
  const terminus = ride.stops[ride.stops.length - 1];
  if (!terminus) return null;

  const stop = boarding >= 0 ? ride.stops[boarding] : undefined;
  if (stop) {
    const leaves = stop.expected.getTime() || departs.getTime();
    const atStop = position !== null
      && metresBetween(position.lat, position.lon, stop.stop.lat, stop.stop.lon) <= STILL_AT_STOP_METRES;
    const late = now.getTime() - leaves;
    const coming = late < DEPARTED_GRACE_MS || (atStop && late < LATE_AT_STOP_MS);
    if (coming) {
      const reaching = Math.min(indexFromClock(ride, now), boarding);
      return {
        phase: "coming",
        departs: new Date(leaves),
        boarding: stop,
        busAt: reaching < boarding ? ride.stops[reaching] ?? null : null,
        stopsAway: Math.max(0, boarding - reaching),
      };
    }
  }

  const ahead: Ride = boarding > 0 ? { ...ride, stops: ride.stops.slice(boarding) } : ride;
  const progress = trackRide(ahead, now, position);
  if (!progress || progress.finished) return { phase: "finished", terminus };
  return { phase: "riding", progress, terminus, stops: ahead.stops };
}

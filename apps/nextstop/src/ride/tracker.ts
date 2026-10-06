import type { Ride, RideStop } from "../transit/types";
import { metresBetween } from "../transit/types";
import type { Locale } from "../i18n";
import { t } from "../messages";

/**
 * Working out where along a ride you currently are.
 *
 * Two independent answers are available, and neither is trustworthy alone:
 *
 *   - **The clock.** Always available, and with live data it already knows the
 *     vehicle is running three minutes late. But it describes the timetable,
 *     not the bus: stuck in traffic beyond what the operator has reported, it
 *     confidently announces stops you have not reached.
 *   - **GPS.** Describes the actual vehicle, but goes away in tunnels and
 *     underground, and on a route that loops or runs back along itself it will
 *     happily match a stop from the other half of the journey.
 *
 * So both are computed and then reconciled. GPS wins when it broadly agrees
 * with the clock, because then it is the more precise of the two. When they
 * disagree wildly the clock wins, because that disagreement almost always
 * means GPS matched a coincidentally nearby stop rather than that the bus
 * teleported.
 *
 * Nothing here accumulates. Every call re-derives the position from the ride,
 * the time and the position given — a tracker that counted stops as they went
 * past would drift permanently the first time a reading was missed.
 */

/** How far GPS may disagree with the clock before the clock is believed. */
const AGREEMENT_WINDOW = 3;

/** Within this distance of a stop, the vehicle is treated as being at it. */
const AT_STOP_METRES = 120;

export interface Position {
  readonly lat: number;
  readonly lon: number;
  /** Reported accuracy in metres, when the platform supplies one. */
  readonly accuracy?: number;
}

export type Basis = "gps" | "clock";

export interface RideProgress {
  /** Index into `ride.stops` of the stop being approached. */
  readonly nextIndex: number;
  readonly next: RideStop;
  /** Stops after `next`, in order. */
  readonly upcoming: readonly RideStop[];
  /** Metres to the next stop, only when a position was supplied. */
  readonly metresToNext?: number;
  /** True once close enough that "next stop" means "get up now". */
  readonly arriving: boolean;
  /** Whether the ride has run past its last stop. */
  readonly finished: boolean;
  /** Which of the two sources decided this, so the display can be honest. */
  readonly basis: Basis;
}

/**
 * The first stop the vehicle has not yet left, according to the timetable.
 *
 * Uses `expected` rather than `scheduled`, so a reported delay moves the whole
 * estimate along with it instead of being ignored.
 */
export function indexFromClock(ride: Ride, now: Date): number {
  const index = ride.stops.findIndex((stop) => stop.expected.getTime() > now.getTime());
  return index === -1 ? ride.stops.length : index;
}

/**
 * The stop the vehicle is physically closest to, and how far away it is.
 *
 * Deliberately nothing more. Being 50 m from a stop means either "about to
 * arrive" or "just left", and no amount of distance tells the two apart —
 * that needs the timetable, so it is decided in `trackRide` instead. An
 * earlier version advanced to the next stop whenever it came within 120 m,
 * which announced the following stop while the current one was still ahead
 * through the windscreen.
 */
export function indexFromPosition(
  ride: Ride,
  position: Position,
): { index: number; metres: number } | null {
  if (ride.stops.length === 0) return null;
  // A fix so vague that half the route falls inside it says nothing useful.
  if (position.accuracy !== undefined && position.accuracy > 500) return null;

  let closest = 0;
  let closestMetres = Number.POSITIVE_INFINITY;
  for (const [index, stop] of ride.stops.entries()) {
    const metres = metresBetween(position.lat, position.lon, stop.stop.lat, stop.stop.lon);
    if (metres < closestMetres) {
      closestMetres = metres;
      closest = index;
    }
  }
  return { index: closest, metres: closestMetres };
}

export function trackRide(
  ride: Ride,
  now: Date,
  position: Position | null,
): RideProgress | null {
  if (ride.stops.length === 0) return null;

  const byClock = indexFromClock(ride, now);
  const nearest = position ? indexFromPosition(ride, position) : null;

  // GPS is preferred, but only where it corroborates the timetable. A match
  // many stops away is the signature of a route that passes close to itself,
  // not of a vehicle that has genuinely skipped ahead.
  const useGps = nearest !== null && Math.abs(nearest.index - byClock) <= AGREEMENT_WINDOW;
  const basis: Basis = useGps ? "gps" : "clock";

  let index = byClock;
  if (useGps && nearest) {
    // Standing at the nearest stop, the timetable decides whether it is still
    // ahead or already behind: a stop whose time has come and gone while the
    // vehicle sits on top of it has been served, and the next one is the
    // answer. Further away than that, the nearest stop is simply the one
    // being approached.
    const atStop = nearest.metres <= AT_STOP_METRES;
    const served = (ride.stops[nearest.index]?.expected.getTime() ?? 0) <= now.getTime();
    index = atStop && served ? nearest.index + 1 : nearest.index;
  }

  if (index >= ride.stops.length) {
    const last = ride.stops[ride.stops.length - 1];
    if (!last) return null;
    return {
      nextIndex: ride.stops.length - 1,
      next: last,
      upcoming: [],
      arriving: false,
      finished: true,
      basis,
    };
  }

  const next = ride.stops[index];
  if (!next) return null;

  const metres = position
    ? metresBetween(position.lat, position.lon, next.stop.lat, next.stop.lon)
    : undefined;

  return {
    nextIndex: index,
    next,
    upcoming: ride.stops.slice(index + 1),
    ...(metres === undefined ? {} : { metresToNext: metres }),
    // Without GPS, "arriving" falls back to the clock — within a minute of the
    // expected arrival is close enough to be worth standing up for.
    arriving: metres !== undefined
      ? metres <= AT_STOP_METRES * 2
      : next.expected.getTime() - now.getTime() <= 60000,
    finished: false,
    basis,
  };
}

/**
 * How the time to a stop is spoken on the display.
 *
 * "jetzt" rather than "0 min", and an overdue stop stays "jetzt" instead of
 * counting into negative numbers, which would read as an error.
 */
export function etaLabel(stop: RideStop, now: Date, locale: Locale): string {
  const minutes = Math.round((stop.expected.getTime() - now.getTime()) / 60000);
  if (minutes <= 0) return t(locale, "g.now");
  if (minutes < 60) return t(locale, "g.minutes", { minutes });
  return t(locale, "g.hoursMinutes", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

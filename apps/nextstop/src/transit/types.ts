/**
 * The shape both backends are flattened into.
 *
 * NextStop talks to two very different services — ÖBB's HAFAS and Transitous'
 * MOTIS — and the rest of the app must not be able to tell which one answered.
 * Everything below is therefore expressed in the terms a passenger uses, not
 * in either backend's vocabulary.
 */

/** Where a time came from. The display must never present a guess as a fact. */
export type TimeSource = "realtime" | "scheduled";

export interface Stop {
  readonly id: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
}

export interface Departure {
  /** "S3", "O-Bus 6", "ICE 873" — printed as the operator writes it. */
  readonly line: string;
  /** Where the vehicle is heading, as shown on its own front display. */
  readonly headsign: string;
  /** Minutes from now until it leaves. Negative means it is overdue. */
  readonly inMinutes: number;
  readonly scheduled: Date;
  /** The time it will actually leave, when the operator says so. */
  readonly expected: Date;
  readonly source: TimeSource;
  /** Platform or stand, when the backend knows one. */
  readonly track?: string;
  readonly cancelled: boolean;
  /** Opaque handle for fetching the full ride; shape differs per backend. */
  readonly tripId: string;
}

/** One stop along a ride, with the time this particular vehicle reaches it. */
export interface RideStop {
  readonly stop: Stop;
  readonly scheduled: Date;
  readonly expected: Date;
  readonly source: TimeSource;
  readonly cancelled: boolean;
}

export interface Ride {
  readonly line: string;
  readonly headsign: string;
  readonly stops: readonly RideStop[];
  /** Route geometry, when the backend supplies it. Not every one does. */
  readonly shape?: readonly (readonly [number, number])[];
}

/**
 * A backend. Both implementations are pure request/response — no caching and
 * no state — so the ride tracker can be tested without a network at all.
 */
export interface TransitBackend {
  readonly id: "oebb" | "motis";
  readonly label: string;
  /** Whether this backend is expected to carry live delays in its region. */
  readonly hasRealtime: boolean;
  nearbyStops(lat: number, lon: number, limit: number): Promise<readonly Stop[]>;
  departures(stopId: string, limit: number): Promise<readonly Departure[]>;
  ride(tripId: string): Promise<Ride | null>;
}

/**
 * Minutes until a departure, rounded the way a passenger reads a board.
 *
 * Rounding down is deliberate: a bus leaving in 89 seconds is "1 min", not
 * "2 min". Telling someone they have longer than they do is the one error
 * that makes them miss it.
 */
export function minutesUntil(when: Date, now: Date): number {
  return Math.floor((when.getTime() - now.getTime()) / 60000);
}

/** Delay in whole minutes; 0 when on time or when nothing live is known. */
export function delayMinutes(departure: Departure | RideStop): number {
  if (departure.source !== "realtime") return 0;
  return Math.round((departure.expected.getTime() - departure.scheduled.getTime()) / 60000);
}

export function metresBetween(
  aLat: number, aLon: number, bLat: number, bLon: number,
): number {
  const R = 6371000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

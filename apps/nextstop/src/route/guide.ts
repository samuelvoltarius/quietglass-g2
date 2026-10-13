import type { Ride, RideStop } from "../transit/types";
import { metresBetween } from "../transit/types";
import { trackRide, type Position, type RideProgress } from "../ride/tracker";
import { departureOf, type Journey, type TransitLeg, type WalkLeg } from "./journey";

/**
 * Companion logic: which step of a connection the passenger is in, worked out
 * from nothing but the connection, the clock and the position.
 *
 * Like the ride tracker this keeps no count. Every call re-derives the step,
 * so a missed GPS fix or a backgrounded app costs one frame, never the rest of
 * the journey. The only memory is the passenger's own override ("next step"
 * pressed by hand), and that expires the moment the automatic answer moves on.
 */

export type Step =
  | { readonly kind: "walk"; readonly leg: WalkLeg; readonly transfer: boolean; readonly next: TransitLeg | undefined }
  | { readonly kind: "transit"; readonly leg: TransitLeg; readonly transfer: boolean; readonly after: Step | undefined }
  | { readonly kind: "arrived" };

/** Within this distance of the end of a walk, the walk is done. */
export const ARRIVED_METRES = 40;
/** Within this distance of the boarding stop after departure, the vehicle was missed. */
export const MISSED_METRES = 80;
/** How long after departure a passenger still standing there counts as having missed it. */
export const MISSED_AFTER_SECONDS = 120;
/** Further than this from the line of the vehicle, after its arrival time, a passenger has got off. */
const OFF_LINE_METRES = 60;
/** A fix this vague proves nothing about where the passenger is. */
const MAX_USEFUL_ACCURACY = 100;
/** Clock-only: how long past its planned end a walk to a stop is assumed to be over. */
const WALK_GRACE_SECONDS = 120;
/** Whatever GPS says, a ride this long past its arrival time is over (and stays over). */
const RIDE_LATE_SECONDS = 300;
/** Clock-only: how long past the arrival time a ride is assumed to be over. */
const RIDE_GRACE_SECONDS = 90;
/** Clock-only: how long past its end the last walk is assumed to be over. */
const FINAL_WALK_GRACE_MINUTES = 10;

/** The steps of a connection, in order, ending in "arrived". */
export function buildSteps(journey: Journey): readonly Step[] {
  const steps: Step[] = [];
  let ridden = false;
  const legs = journey.legs.filter((leg) => !(leg.kind === "walk" && leg.metres <= 10
    && leg.end.getTime() - leg.start.getTime() <= 60000));

  for (const [index, leg] of legs.entries()) {
    if (leg.kind === "walk") {
      const next = legs.slice(index + 1).find((later): later is TransitLeg => later.kind === "transit");
      steps.push({ kind: "walk", leg, transfer: ridden, next });
    } else {
      steps.push({ kind: "transit", leg, transfer: ridden, after: undefined });
      ridden = true;
    }
  }
  steps.push({ kind: "arrived" });

  // What comes after each ride, so the ride screen can say "Danach: …".
  return steps.map((step, index) => step.kind === "transit"
    ? { ...step, after: steps[index + 1] }
    : step);
}

/** A ride, in the shape the tracker understands. */
export function rideOf(leg: TransitLeg): Ride {
  return { line: leg.line, headsign: leg.headsign, stops: leg.stops };
}

function usable(position: Position | null): Position | null {
  if (!position) return null;
  if (position.accuracy !== undefined && position.accuracy > MAX_USEFUL_ACCURACY) return null;
  return position;
}

function near(position: Position | null, lat: number, lon: number, metres: number): boolean {
  const fix = usable(position);
  return fix !== null && metresBetween(fix.lat, fix.lon, lat, lon) <= metres;
}

/** Whether the passenger has got on: the vehicle's departure time has come. */
export function hasBoarded(leg: TransitLeg, now: Date): boolean {
  return now.getTime() >= departureOf(leg).getTime();
}

/** True when the passenger is still standing at the stop well after departure. */
export function missedVehicle(leg: TransitLeg, now: Date, position: Position | null): boolean {
  const boarding = leg.stops[0];
  if (!boarding) return false;
  const lateBy = (now.getTime() - departureOf(leg).getTime()) / 1000;
  return lateBy >= MISSED_AFTER_SECONDS
    && near(position, boarding.stop.lat, boarding.stop.lon, MISSED_METRES);
}

function rideFinished(leg: TransitLeg, now: Date, position: Position | null): boolean {
  if (!hasBoarded(leg, now)) return false;
  const last = leg.stops[leg.stops.length - 1];
  if (!last) return true;
  // However late, a ride long past its arrival time is over, and stays over.
  if (now.getTime() >= last.expected.getTime() + RIDE_LATE_SECONDS * 1000) return true;
  const progress = trackRide(rideOf(leg), now, usable(position));
  if (!progress?.finished) return false;
  // On the clock alone the arrival time merely passing proves little: a
  // vehicle stuck in traffic is still on its way. Give it a grace period.
  return progress.basis === "gps" || now.getTime() >= last.expected.getTime() + RIDE_GRACE_SECONDS * 1000;
}

/** Distance from a point to the path through the given stops, in metres. */
export function distanceToPath(stops: readonly { lat: number; lon: number }[], at: { lat: number; lon: number }): number {
  const cosLat = Math.cos((at.lat * Math.PI) / 180);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < stops.length; i += 1) {
    const ax = (stops[i - 1]!.lon - at.lon) * 111320 * cosLat;
    const ay = (stops[i - 1]!.lat - at.lat) * 110540;
    const dx = (stops[i]!.lon - at.lon) * 111320 * cosLat - ax;
    const dy = (stops[i]!.lat - at.lat) * 110540 - ay;
    const len2 = dx * dx + dy * dy;
    const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + u * dx, ay + u * dy));
  }
  return best;
}

/**
 * After the scheduled arrival, a passenger who is no longer anywhere near the
 * line of the vehicle has got off and gone. The tracker alone cannot say so:
 * once the walker is beyond reach of the last stop it only sees "approaching
 * it", and a step that flips back to "riding" as soon as the walker is 150 m
 * from the stop would make the guide jump between stages.
 */
function walkedAway(step: Extract<Step, { kind: "transit" }>, now: Date, position: Position | null): boolean {
  const last = step.leg.stops[step.leg.stops.length - 1];
  const fix = usable(position);
  if (!last || !fix) return false;
  if (now.getTime() < last.expected.getTime()) return false;
  return distanceToPath(step.leg.stops.map((stop) => stop.stop), fix) > OFF_LINE_METRES;
}

function stepDone(steps: readonly Step[], index: number, now: Date, position: Position | null): boolean {
  const step = steps[index];
  if (!step || step.kind === "arrived") return false;
  if (step.kind === "transit") return rideFinished(step.leg, now, position) || walkedAway(step, now, position);

  if (near(position, step.leg.toLat, step.leg.toLon, ARRIVED_METRES)) return true;
  if (step.leg.toDestination) {
    return now.getTime() >= step.leg.end.getTime() + FINAL_WALK_GRACE_MINUTES * 60000;
  }
  // Walking to a stop: once the vehicle has left, there is nothing to walk to.
  if (step.next !== undefined && hasBoarded(step.next, now)) return true;
  // Without a usable fix the clock decides: a couple of minutes after the walk
  // was due to end, the passenger is at the stop and waiting.
  return usable(position) === null && now.getTime() >= step.leg.end.getTime() + WALK_GRACE_SECONDS * 1000;
}

/** The step the clock and the position agree on. */
export function autoStep(steps: readonly Step[], now: Date, position: Position | null): number {
  for (let index = 0; index < steps.length - 1; index += 1) {
    if (!stepDone(steps, index, now, position)) return index;
  }
  return steps.length - 1;
}

/** A hand-set step that holds only while the automatic answer stays where it was. */
export interface StepOverride {
  readonly index: number;
  readonly autoAtSet: number;
}

export function resolveStep(auto: number, override: StepOverride | null, count: number): number {
  const wanted = override && override.autoAtSet === auto ? override.index : auto;
  return Math.max(0, Math.min(count - 1, wanted));
}

export type Phase = "walk" | "board" | "ride" | "missed" | "arrived";

export interface GuideState {
  readonly steps: readonly Step[];
  readonly index: number;
  readonly auto: number;
  readonly step: Step;
  readonly phase: Phase;
  /** For the ride phase: where along the vehicle's stops we are. */
  readonly progress?: RideProgress;
  /** Halts left until getting off, counting the stop where to get off. */
  readonly stopsLeft?: number;
}

/**
 * Everything the screen needs for one frame. `override` lets the passenger
 * step by hand when GPS is missing or wrong.
 */
export function guideState(
  steps: readonly Step[],
  now: Date,
  position: Position | null,
  override: StepOverride | null = null,
): GuideState {
  const auto = autoStep(steps, now, position);
  const index = resolveStep(auto, override, steps.length);
  const step = steps[index] ?? { kind: "arrived" as const };

  if (step.kind === "arrived") return { steps, index, auto, step, phase: "arrived" };
  if (step.kind === "walk") return { steps, index, auto, step, phase: "walk" };

  if (!hasBoarded(step.leg, now)) return { steps, index, auto, step, phase: "board" };
  if (missedVehicle(step.leg, now, position) && index === auto) {
    return { steps, index, auto, step, phase: "missed" };
  }

  const progress = trackRide(rideOf(step.leg), now, usable(position));
  const lastIndex = step.leg.stops.length - 1;
  const stopsLeft = progress ? Math.max(1, lastIndex - progress.nextIndex + 1) : 1;
  return {
    steps, index, auto, step, phase: "ride",
    ...(progress ? { progress } : {}),
    stopsLeft: progress?.finished ? 1 : stopsLeft,
  };
}

/**
 * When the whole journey is expected to end: the planned end, moved later by
 * the delay the last vehicle is reported to have.
 */
export function estimatedArrival(journey: Journey): Date {
  const last = [...journey.legs].reverse().find((leg): leg is TransitLeg => leg.kind === "transit");
  const stop = last?.stops[last.stops.length - 1];
  const delay = stop ? Math.max(0, stop.expected.getTime() - stop.scheduled.getTime()) : 0;
  return new Date(journey.end.getTime() + delay);
}

/** Stand-in for the user's own pressing of "next step" / "previous step". */
export function stepBy(state: GuideState, direction: -1 | 1): StepOverride {
  const index = Math.max(0, Math.min(state.steps.length - 1, state.index + direction));
  return { index, autoAtSet: state.auto };
}

/**
 * Replaces the times of one leg with fresher ones, matched by stop. A stop the
 * fresh answer does not know keeps its old time.
 */
export function withFreshTimes(leg: TransitLeg, fresh: readonly RideStop[]): TransitLeg {
  const byId = new Map(fresh.map((stop) => [stop.stop.id, stop]));
  return {
    ...leg,
    stops: leg.stops.map((stop) => {
      const update = byId.get(stop.stop.id);
      return update ? { ...stop, scheduled: update.scheduled, expected: update.expected, source: update.source, cancelled: update.cancelled } : stop;
    }),
  };
}

/** Swaps one leg of a journey for an updated one (same position in the list). */
export function withLeg(journey: Journey, tripId: string, updated: TransitLeg): Journey {
  return {
    ...journey,
    legs: journey.legs.map((leg) => leg.kind === "transit" && leg.tripId === tripId ? updated : leg),
  };
}

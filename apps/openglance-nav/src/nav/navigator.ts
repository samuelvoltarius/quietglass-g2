import {
  distanceMeters, projectOntoPath, remainingAlong, type LatLng,
} from "../geo/geometry";
import type { Maneuver, Route } from "../routing/provider";

/**
 * Turning a route plus a position into the two numbers a navigator needs:
 * what to do next, and how far away it is.
 */

export interface NavState {
  readonly route: Route;
  /** Index of the manoeuvre currently being approached. */
  readonly maneuverIndex: number;
  /** Last accepted position. */
  readonly position: LatLng | null;
  /** Metres from the route; used for off-route detection. */
  readonly offRouteMeters: number;
  /** Consecutive fixes that were off-route. */
  readonly offRouteFixes: number;
  readonly arrived: boolean;
}

export interface NavSettings {
  /** Distance from the route that counts as off-route. */
  readonly offRouteMeters: number;
  /** Consecutive off-route fixes before rerouting; guards against GPS noise. */
  readonly offRouteFixes: number;
  /** Distance to the destination that counts as arrival. */
  readonly arriveMeters: number;
}

export const DEFAULT_SETTINGS: NavSettings = {
  offRouteMeters: 40,
  offRouteFixes: 3,
  arriveMeters: 25,
};

export function startNavigation(route: Route): NavState {
  return {
    route,
    maneuverIndex: 0,
    position: null,
    offRouteMeters: 0,
    offRouteFixes: 0,
    arrived: false,
  };
}

export interface Progress {
  /** The manoeuvre to announce now. */
  readonly maneuver: Maneuver | null;
  /** Metres to that manoeuvre. */
  readonly distanceToManeuver: number;
  /** Metres remaining on the whole route. */
  readonly distanceRemaining: number;
  /** Seconds remaining, scaled from the router's own estimate. */
  readonly secondsRemaining: number;
  readonly offRoute: boolean;
  readonly arrived: boolean;
}

/**
 * Applies a GPS fix.
 *
 * Advancing the manoeuvre index is based on progress **along the route**, not
 * on proximity to the manoeuvre point: on a road that doubles back, proximity
 * alone would announce the wrong turn.
 */
export function update(
  state: NavState,
  position: LatLng,
  settings: NavSettings = DEFAULT_SETTINGS,
): NavState {
  const projection = projectOntoPath(position, state.route.shape);
  if (!projection) return { ...state, position };

  const offRoute = projection.distance > settings.offRouteMeters;
  const offRouteFixes = offRoute ? state.offRouteFixes + 1 : 0;

  // The manoeuvre being approached is the first one whose start lies ahead of
  // where we are on the route.
  let maneuverIndex = state.maneuverIndex;
  while (
    maneuverIndex < state.route.maneuvers.length - 1 &&
    (state.route.maneuvers[maneuverIndex + 1]?.shapeIndex ?? Infinity) <= projection.index
  ) {
    maneuverIndex++;
  }

  const destination = state.route.shape[state.route.shape.length - 1];
  const arrived = destination
    ? distanceMeters(position, destination) <= settings.arriveMeters
    : false;

  return {
    ...state,
    position,
    maneuverIndex,
    offRouteMeters: projection.distance,
    offRouteFixes,
    arrived: state.arrived || arrived,
  };
}

export function progressOf(
  state: NavState,
  settings: NavSettings = DEFAULT_SETTINGS,
): Progress {
  const maneuvers = state.route.maneuvers;
  const maneuver = maneuvers[state.maneuverIndex] ?? null;

  if (!state.position) {
    return {
      maneuver,
      distanceToManeuver: maneuver?.length ?? 0,
      distanceRemaining: state.route.distance,
      secondsRemaining: state.route.duration,
      offRoute: false,
      arrived: state.arrived,
    };
  }

  const projection = projectOntoPath(state.position, state.route.shape);
  const distanceRemaining = projection ? remainingAlong(state.route.shape, projection) : 0;

  // Distance to the next manoeuvre: along the route to where the following
  // manoeuvre begins, not straight-line to it.
  const next = maneuvers[state.maneuverIndex + 1];
  let distanceToManeuver = 0;
  if (next && projection) {
    const target = state.route.shape[next.shapeIndex];
    if (target) {
      const targetProjection = projectOntoPath(target, state.route.shape);
      const remainingAtTarget = targetProjection
        ? remainingAlong(state.route.shape, targetProjection)
        : 0;
      distanceToManeuver = Math.max(0, distanceRemaining - remainingAtTarget);
    }
  } else {
    distanceToManeuver = distanceRemaining;
  }

  // Scale the router's own duration by how much of the route is left, rather
  // than inventing a speed model.
  const fraction = state.route.distance > 0 ? distanceRemaining / state.route.distance : 0;

  return {
    maneuver: next ?? maneuver,
    distanceToManeuver,
    distanceRemaining,
    secondsRemaining: state.route.duration * fraction,
    offRoute: state.offRouteFixes >= settings.offRouteFixes,
    arrived: state.arrived,
  };
}

/** True when a reroute is warranted: persistently off-route and not arrived. */
export function needsReroute(state: NavState, settings: NavSettings = DEFAULT_SETTINGS): boolean {
  return !state.arrived && state.offRouteFixes >= settings.offRouteFixes;
}

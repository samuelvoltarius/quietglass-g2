import type { Ride } from "../transit/types";
import type { Destination, Journey } from "./journey";
import type { GeoResult } from "./geocode";

/**
 * What the route features ask of a timetable service. MotisBackend answers it
 * for real; the demo mode answers it from a recorded sample. The ÖBB backend
 * does not, so planning always goes to MOTIS (Transitous by default), whichever
 * source the departure board uses.
 */
export interface Planner {
  plan(
    from: { readonly lat: number; readonly lon: number },
    to: Destination,
    language?: "de" | "en",
    count?: number,
  ): Promise<readonly Journey[]>;
  geocode(
    text: string,
    near: { readonly lat: number; readonly lon: number } | null,
    language?: "de" | "en",
  ): Promise<readonly GeoResult[]>;
  /** Fresh stop times of one trip, for live delays during the guide. */
  ride(tripId: string): Promise<Ride | null>;
}

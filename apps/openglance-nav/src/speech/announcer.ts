import type { Progress } from "../nav/navigator";
import type { ManeuverType, TravelMode } from "../routing/provider";
import type { Locale } from "../i18n";

/**
 * Spoken turn instructions: "In 200 metres turn left" far out, "Turn left
 * now" just before the turn, each once per turn. Pure logic: the caller feeds
 * it the progress after each GPS fix and speaks whatever it returns.
 */

export interface Thresholds {
  /** First announcement at this distance (m). */
  readonly far: number;
  /** Second, short one at this distance (m). */
  readonly near: number;
}

/** Faster travel needs the warning earlier. */
export function thresholdsFor(mode: TravelMode): Thresholds {
  switch (mode) {
    case "driving": return { far: 200, near: 30 };
    case "cycling": return { far: 100, near: 25 };
    default: return { far: 60, near: 15 };
  }
}

export interface Announcement {
  readonly text: string;
  /** 1 = far announcement, 2 = near / arrival / off route. */
  readonly priority: number;
  /** Same key replaces a queued older announcement. */
  readonly key: string;
  /** Not worth saying anymore after this long (ms). */
  readonly maxAgeMs: number;
}

export interface AnnounceContext {
  /** Changes with every new route, so a reroute starts announcing afresh. */
  readonly routeId: number;
  readonly mode: TravelMode;
  readonly locale: Locale;
  /** A GPS fix exists; without one the distances are only the route's own. */
  readonly hasFix: boolean;
}

const TURN: Readonly<Record<Locale, Partial<Record<ManeuverType, string>>>> = {
  de: {
    left: "links abbiegen", slightLeft: "leicht links halten", sharpLeft: "scharf links abbiegen",
    right: "rechts abbiegen", slightRight: "leicht rechts halten", sharpRight: "scharf rechts abbiegen",
    uturn: "wenden", roundabout: "in den Kreisverkehr fahren", merge: "einfädeln", fork: "an der Gabelung halten", exit: "die Ausfahrt nehmen",
  },
  en: {
    left: "turn left", slightLeft: "keep slightly left", sharpLeft: "turn sharp left",
    right: "turn right", slightRight: "keep slightly right", sharpRight: "turn sharp right",
    uturn: "make a U-turn", roundabout: "enter the roundabout", merge: "merge", fork: "keep at the fork", exit: "take the exit",
  },
};

/** 187 m reads as "190", 140 m as "150": no false precision, no 5-metre jitter. */
export function spokenMeters(meters: number): number {
  if (meters >= 100) return Math.round(meters / 50) * 50;
  return Math.max(10, Math.round(meters / 10) * 10);
}

function say(locale: Locale, key: "far" | "near" | "arriveFar" | "arrived" | "offRoute", vars: { meters?: number; turn?: string; street?: string } = {}): string {
  const street = vars.street ? (locale === "de" ? ` auf ${vars.street}.` : ` onto ${vars.street}.`) : ".";
  if (locale === "de") {
    switch (key) {
      case "far": return `In ${vars.meters} Metern ${vars.turn}${vars.street ? street : "."}`;
      case "near": return `Jetzt ${vars.turn}.`;
      case "arriveFar": return `In ${vars.meters} Metern erreichen Sie Ihr Ziel.`;
      case "arrived": return "Sie haben Ihr Ziel erreicht.";
      default: return "Sie haben die Route verlassen. Neue Route wird berechnet.";
    }
  }
  switch (key) {
    case "far": return `In ${vars.meters} meters ${vars.turn}${vars.street ? street : "."}`;
    case "near": return `${(vars.turn ?? "").replace(/^./, (c) => c.toUpperCase())} now.`;
    case "arriveFar": return `In ${vars.meters} meters you will arrive at your destination.`;
    case "arrived": return "You have arrived.";
    default: return "You left the route. Calculating a new route.";
  }
}

export class TurnAnnouncer {
  #route = -1;
  #turn = "";
  /** 0 nothing said for this turn, 1 far said, 2 near said. */
  #stage = 0;
  #arrived = false;
  #off = false;

  reset(): void {
    this.#route = -1; this.#turn = ""; this.#stage = 0; this.#arrived = false; this.#off = false;
  }

  /** What to say now, if anything. At most one thing per call. */
  next(progress: Progress, context: AnnounceContext): Announcement | null {
    if (context.routeId !== this.#route) {
      this.#route = context.routeId; this.#turn = ""; this.#stage = 0; this.#arrived = false; this.#off = false;
    }
    if (!context.hasFix) return null;
    const { locale } = context;

    if (progress.arrived) {
      if (this.#arrived) return null;
      this.#arrived = true;
      return { text: say(locale, "arrived"), priority: 2, key: "arrived", maxAgeMs: 10_000 };
    }
    if (progress.offRoute) {
      if (this.#off) return null;
      this.#off = true;
      return { text: say(locale, "offRoute"), priority: 2, key: "offroute", maxAgeMs: 8_000 };
    }
    this.#off = false;

    const maneuver = progress.maneuver;
    if (!maneuver) return null;
    const isArrival = maneuver.type === "arrive";
    const phrase = TURN[locale][maneuver.type] ?? "";
    // Starting out and "keep going straight" are not worth interrupting anyone for.
    if (!isArrival && phrase === "") return null;

    const turnKey = `${context.routeId}:${maneuver.shapeIndex}`;
    if (turnKey !== this.#turn) { this.#turn = turnKey; this.#stage = 0; }
    const { far, near } = thresholdsFor(context.mode);
    const distance = progress.distanceToManeuver;

    if (distance <= near && this.#stage < 2) {
      this.#stage = 2;
      // The arrival itself is announced once the destination is reached.
      if (isArrival) return null;
      return { text: say(locale, "near", { turn: phrase }), priority: 2, key: turnKey, maxAgeMs: 6_000 };
    }
    if (distance > near && distance <= far && this.#stage < 1) {
      this.#stage = 1;
      const meters = spokenMeters(distance);
      if (isArrival) return { text: say(locale, "arriveFar", { meters }), priority: 1, key: turnKey, maxAgeMs: 10_000 };
      return {
        text: say(locale, "far", { meters, turn: phrase, ...(maneuver.street ? { street: maneuver.street } : {}) }),
        priority: 1, key: turnKey, maxAgeMs: 10_000,
      };
    }
    return null;
  }
}

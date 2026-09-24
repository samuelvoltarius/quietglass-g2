import { formatDistance, formatEta } from "../geo/geometry";
import type { ManeuverType, TravelMode } from "../routing/provider";
import type { Progress } from "../nav/navigator";

/**
 * What the glasses show.
 *
 * Driving mode is the constraint that shapes this whole file. A navigation
 * display in a car competes with the road, so it carries exactly three things:
 * the arrow, the distance, and the road name. No ETA, no progress bar, no
 * decoration — those are available on foot, where looking at them is safe.
 */
export interface NavView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

/** Arrows chosen to be unmistakable at a glance in monochrome. */
const ARROWS: Readonly<Record<ManeuverType, string>> = {
  depart: "↑",
  arrive: "◉",
  left: "←",
  slightLeft: "↖",
  sharpLeft: "↰",
  right: "→",
  slightRight: "↗",
  sharpRight: "↱",
  straight: "↑",
  uturn: "↶",
  roundabout: "↻",
  merge: "↗",
  fork: "⤴",
  exit: "↗",
};

export interface ViewOptions {
  readonly mode: TravelMode;
  readonly navigating: boolean;
  /** True while a reroute is being fetched. */
  readonly rerouting: boolean;
  readonly error: string | null;
  readonly mock: boolean;
  /** No position fix yet. */
  readonly waitingForFix: boolean;
}

export function buildView(
  progress: Progress | null,
  options: ViewOptions,
  now = Date.now(),
): NavView {
  if (options.error) {
    return { header: "OpenGlance", body: [options.error], footer: "tap = retry" };
  }

  if (!options.navigating || !progress) {
    return {
      header: "OpenGlance",
      body: ["No route.", "Set a destination in the phone app."],
      footer: options.mock ? "mock routing" : "",
    };
  }

  if (progress.arrived) {
    return {
      header: "",
      body: [ARROWS.arrive + "  Arrived"],
      footer: "double tap = exit",
    };
  }

  if (options.waitingForFix) {
    return { header: "", body: ["Waiting for position…"], footer: statusFooter(options, null, now) };
  }

  if (options.rerouting) {
    return { header: "", body: ["Off route", "Rerouting…"], footer: "" };
  }

  if (progress.offRoute) {
    return { header: "", body: ["Off route"], footer: "tap = reroute" };
  }

  const maneuver = progress.maneuver;
  const arrow = maneuver ? ARROWS[maneuver.type] : ARROWS.straight;
  const distance = formatDistance(progress.distanceToManeuver);

  const body: string[] = [];
  // The arrow and the distance on one line: this is the line a driver reads.
  body.push(arrow + "  " + distance);

  const road = roadLabel(maneuver?.street, maneuver?.instruction);
  if (road) body.push(road);

  if (maneuver?.type === "roundabout" && maneuver.exitNumber) {
    body.push("exit " + maneuver.exitNumber);
  }

  return {
    header: "",
    body,
    footer: statusFooter(options, progress, now),
  };
}

/**
 * Driving carries no footer at all. Walking and cycling get the remaining
 * distance and the arrival time, which are worth a glance when stationary.
 */
function statusFooter(options: ViewOptions, progress: Progress | null, now: number): string {
  if (options.mode === "driving") return options.mock ? "MOCK" : "";

  const parts: string[] = [];
  if (progress) {
    parts.push(formatDistance(progress.distanceRemaining));
    parts.push(formatEta(progress.secondsRemaining, now));
  }
  if (options.mock) parts.push("MOCK");
  return parts.join("  ·  ");
}

/**
 * Prefers the street name; falls back to the router's instruction with the
 * leading verb stripped, since the arrow already says what to do.
 */
export function roadLabel(street: string | undefined, instruction: string | undefined): string {
  if (street) return street;
  if (!instruction) return "";
  const onto = /\b(?:onto|on to|toward|towards|on)\s+(.+?)\.?$/i.exec(instruction);
  if (onto?.[1]) return onto[1].trim();
  return instruction.replace(/\.$/, "");
}

export function arrowFor(type: ManeuverType): string {
  return ARROWS[type];
}

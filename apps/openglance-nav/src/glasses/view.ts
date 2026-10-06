import { formatDistance, formatEta } from "../geo/geometry";
import type { ManeuverType, TravelMode } from "../routing/provider";
import type { Progress } from "../nav/navigator";
import { tr, type Locale } from "../i18n";
import { messages } from "../messages";

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

/**
 * Characters that fit on one body line beside the 96 px pixel arrow (472 px of
 * proportional font). Router text is cut to this: a long instruction would
 * otherwise wrap down the body in the one mode where nobody should be reading.
 */
export const ROAD_WIDTH = 36;

/** Hard limits of a full-width body: 7 rows of at most 46 characters. */
export const MAX_ROWS = 7;
export const LINE_WIDTH = 46;
/** In the overview the map takes the top half; the text below has 3 rows. */
export const OVERVIEW_ROWS = 3;

export type GlassLayout = "turns" | "overview";

export interface ViewOptions {
  readonly mode: TravelMode;
  readonly navigating: boolean;
  /** True while a reroute is being fetched. */
  readonly rerouting: boolean;
  readonly error: string | null;
  readonly mock: boolean;
  /** No position fix yet. */
  readonly waitingForFix: boolean;
  /** Language of the glasses text; English when omitted. */
  readonly locale?: Locale;
  /** Label of the selected destination, shown while idle. */
  readonly destination?: string | null;
  /** Which glasses layout the text is for; "turns" when omitted. */
  readonly layout?: GlassLayout;
}

export function buildView(
  progress: Progress | null,
  options: ViewOptions,
  now = Date.now(),
): NavView {
  const view = rawView(progress, options, now);
  const overview = options.layout === "overview";
  return {
    header: overview && !view.header ? t(options, "g.overview") : view.header,
    // Beside the pixel arrow a line holds 36 characters; the overview text runs full width.
    body: fitLines(view.body, overview ? OVERVIEW_ROWS : MAX_ROWS, overview ? LINE_WIDTH : ROAD_WIDTH),
    footer: clip(view.footer, LINE_WIDTH),
  };
}

function rawView(progress: Progress | null, options: ViewOptions, now: number): NavView {
  if (options.error) {
    return { header: "OpenGlance", body: [options.error], footer: t(options, "g.tapRetry") };
  }

  if (!options.navigating || !progress) {
    return {
      header: "OpenGlance",
      body: options.destination
        ? [t(options, "g.ready1", { place: options.destination }), t(options, "g.ready2")]
        : [t(options, "g.noDest1"), t(options, "g.noDest2")],
      footer: options.mock ? t(options, "g.demoFooter") : "",
    };
  }

  if (progress.arrived) {
    return {
      header: "",
      body: [ARROWS.arrive + "  " + t(options, "g.arrived")],
      footer: t(options, "g.doubleTapExit"),
    };
  }

  if (options.waitingForFix) {
    return { header: "", body: [t(options, "g.waitingFix")], footer: statusFooter(options, null, now) };
  }

  if (options.rerouting) {
    return { header: "", body: [t(options, "g.offRoute"), t(options, "g.rerouting")], footer: "" };
  }

  if (progress.offRoute) {
    return { header: "", body: [t(options, "g.offRoute")], footer: t(options, "g.tapReroute") };
  }

  const maneuver = progress.maneuver;
  const arrow = maneuver ? ARROWS[maneuver.type] : ARROWS.straight;
  const distance = formatDistance(progress.distanceToManeuver, options.locale ?? "en");

  const body: string[] = [];
  // The arrow and the distance on one line: this is the line a driver reads.
  body.push(arrow + "  " + distance);

  // Beside the pixel arrow there is room for 36 characters; the overview
  // text runs the full width.
  const width = options.layout === "overview" ? LINE_WIDTH : ROAD_WIDTH;
  const road = roadLabel(maneuver?.street, maneuver?.instruction);
  if (road) body.push(clip(road, width));

  if (maneuver?.type === "roundabout" && maneuver.exitNumber) {
    body.push(t(options, "g.exit", { n: maneuver.exitNumber }));
  }

  return {
    header: "",
    body,
    footer: statusFooter(options, progress, now),
  };
}

/** Cuts text to `width` characters, marking the cut with an ellipsis. */
export function clip(text: string, width: number): string {
  return text.length > width ? text.slice(0, width - 1) + "…" : text;
}

/** Keeps a body within the glasses' row and character limits. */
export function fitLines(lines: readonly string[], rows = MAX_ROWS, width = LINE_WIDTH): string[] {
  return lines.slice(0, rows).map((line) => clip(line, width));
}

function t(options: ViewOptions, key: string, vars: Record<string, string | number> = {}): string {
  return tr(messages, options.locale ?? "en", key, vars);
}

/**
 * Driving carries no footer at all. Walking and cycling get the remaining
 * distance and the arrival time, which are worth a glance when stationary.
 */
function statusFooter(options: ViewOptions, progress: Progress | null, now: number): string {
  const tag = t(options, "g.demoTag");
  if (options.mode === "driving") return options.mock ? tag : "";

  const parts: string[] = [];
  if (progress) {
    parts.push(formatDistance(progress.distanceRemaining, options.locale ?? "en"));
    parts.push(formatEta(progress.secondsRemaining, now));
  }
  if (options.mock) parts.push(tag);
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

import { formatDistance, formatDistanceBig, formatEta } from "../geo/geometry";
import type { ManeuverType, TravelMode } from "../routing/provider";
import type { Progress } from "../nav/navigator";
import { tr, type Locale } from "../i18n";
import { messages } from "../messages";
import { shortenName } from "../overview/labels";

/**
 * What the glasses show.
 *
 * Driving mode is the constraint that shapes this whole file. A navigation
 * display in a car competes with the road, so it carries exactly three things:
 * the arrow, the distance, and the road name. No ETA, no progress bar, no
 * decoration — those are available on foot, where looking at them is safe.
 *
 * In the turn layout the first body line is the road (or the headline of a
 * state such as "Rerouting"): the glasses draw it as a large image across the
 * full width. Any further lines are small text below it.
 */
export interface NavView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
  /**
   * Distance to the turn for the large pixel digits of the turn card, when
   * the card is in use and there is a turn to show; the body then leaves
   * the distance out instead of repeating it in small text.
   */
  readonly big?: string;
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
 * Characters of the road line. It is drawn large across the full width, and
 * the image shrinks the type to fit this many. Router text is cut to it: a long
 * instruction would otherwise be unreadable in the one mode where nobody
 * should be reading.
 */
export const ROAD_WIDTH = 40;

/** Within this distance of the turn nothing but arrow, distance and road is shown. */
export const NEAR_TURN_M = 200;

/** Hard limits of a full-width body: 7 rows of at most 46 characters. */
export const MAX_ROWS = 7;
export const LINE_WIDTH = 46;
/** In the overview the map fills the display; one short line of text sits on it, top left. */
export const OVERVIEW_ROWS = 1;
export const OVERVIEW_WIDTH_CHARS = 22;

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
  /** The turn card shows the distance in large digits (turn layout only). */
  readonly bigDistance?: boolean;
  /** While a start is under way and nothing is routed yet: what it is doing ("Finding your position…"). */
  readonly status?: string | null;
}

export function buildView(
  progress: Progress | null,
  options: ViewOptions,
  now = Date.now(),
): NavView {
  const view = rawView(progress, options, now);
  const overview = options.layout === "overview";
  return {
    // Over the map there is room for one short line and nothing else.
    header: overview ? "" : view.header,
    body: fitLines(view.body, overview ? OVERVIEW_ROWS : MAX_ROWS, overview ? OVERVIEW_WIDTH_CHARS : ROAD_WIDTH),
    footer: overview ? "" : clip(view.footer, LINE_WIDTH),
    ...(view.big !== undefined ? { big: view.big } : {}),
  };
}

function rawView(progress: Progress | null, options: ViewOptions, now: number): NavView {
  if (options.error) {
    // An error may carry a second line saying what to do about it.
    return { header: "OpenGlance", body: options.error.split("\n"), footer: t(options, "g.errorFooter") };
  }

  if (options.status && (!options.navigating || !progress)) {
    return {
      header: "OpenGlance",
      body: [...(options.destination ? [t(options, "g.ready1", { place: options.destination })] : []), options.status],
      footer: t(options, "g.startFooter"),
    };
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
  const locale = options.locale ?? "en";
  const distance = formatDistance(progress.distanceToManeuver, locale);

  const body: string[] = [];
  // With the turn card the distance is drawn large beside the pixel arrow;
  // otherwise arrow and distance share one line: the line a driver reads.
  const big = options.bigDistance === true && options.layout !== "overview";
  const overview = options.layout === "overview";
  const road = roadLabel(maneuver?.street, maneuver?.instruction);
  if (overview) {
    // The one line over the map: arrow, distance and, when it fits, the street of the turn.
    const head = arrow + " " + distance;
    const room = OVERVIEW_WIDTH_CHARS - head.length - 3;
    // Only a real street name goes on the line, never the router's English instruction.
    const street = maneuver?.street;
    body.push(street && room >= 6 ? head + " · " + shortenName(street, room) : arrow + "  " + distance);
  } else {
    if (!big) body.push(arrow + "  " + distance);
    if (road) body.push(clip(road, ROAD_WIDTH));
  }

  if (maneuver?.type === "roundabout" && maneuver.exitNumber) {
    body.push(t(options, "g.exit", { n: maneuver.exitNumber }));
  }

  // Close to the turn the footer goes: nothing but arrow, distance and road.
  const near = big && progress.distanceToManeuver < NEAR_TURN_M;
  return {
    header: "",
    body,
    footer: near ? "" : statusFooter(options, progress, now),
    ...(big ? { big: formatDistanceBig(progress.distanceToManeuver, locale) } : {}),
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
 * The remaining distance and the arrival time, in small text at the bottom.
 * They stay out of the way: close to a turn the footer is dropped altogether.
 */
function statusFooter(options: ViewOptions, progress: Progress | null, now: number): string {
  const tag = t(options, "g.demoTag");
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

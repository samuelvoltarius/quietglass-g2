import { formatDistance, formatDistanceBig, formatEta } from "../geo/geometry";
import type { ManeuverType, TravelMode } from "../routing/provider";
import type { Progress } from "../nav/navigator";
import { tr, type Locale } from "../i18n";
import { messages } from "../messages";
import { armedStopFooter, footer, ft, word } from "./footer";
import { shortenName } from "../overview/labels";
import { speedColumn, speedLine, type SpeedReading } from "../nav/speed";
import type { BatteryEstimate } from "../car/byd";
import { sugarChip, type SugarDisplay } from "../sugar/glucose";
import { arrivalChip, arrivalDelta, arrivalHint, arrivalText } from "../appointments/appointments";
import type { HudContent } from "./hud";

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
  /**
   * The speed box (driving and cycling): beside the arrow on the turn page
   * ("52 / km/h / [50]" in rows), one line on the map ("52 | 50 km/h"). Absent = blank.
   */
  readonly speed?: string;
  /** The HUD layout (driving, "neu"): its own text boxes and the two pictures it picks. */
  readonly hud?: HudContent;
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
/** Header and footer span the full display width (same budget as the other Quietglass apps). */
export const ROW_WIDTH = 56;
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
  /** "Laden in 12 km · 150 kW": the next charging station ahead, shown below the road when not close to a turn. */
  readonly charger?: string | null;
  /** Current speed and the road's limit; shown while driving or cycling along a route. */
  readonly speed?: SpeedReading | null;
  /** Car link (private build, driving): battery now and at arrival; footer, and a warning line when low. */
  readonly battery?: BatteryEstimate | null;
  /** Glucose of the owner's server (driving only): small value in the footer / speed line, a warning line when low. */
  readonly sugar?: SugarDisplay | null;
  /** A hold asked to stop the navigation; one more tap within a few seconds does it (QIS v1). */
  readonly armedStop?: boolean;
  /**
   * Navigating to one of today's appointments (private build): the footer
   * compares the arrival with its start, the arrival page names it.
   */
  readonly appointment?: { readonly startMs: number; readonly title: string } | null;
}

export function buildView(
  progress: Progress | null,
  options: ViewOptions,
  now = Date.now(),
): NavView {
  const view = rawView(progress, options, now);
  const overview = options.layout === "overview";
  const fitted = fitLines(view.body, overview ? OVERVIEW_ROWS : MAX_ROWS, overview ? OVERVIEW_WIDTH_CHARS : ROAD_WIDTH);
  return {
    // Over the map there is room for one short line and nothing else.
    header: overview ? "" : view.header,
    // The text page's small lines after the first may use the whole row (the arrival page's appointment hint).
    body: view.wideAfterFirst && !overview ? [fitted[0] ?? "", ...view.body.slice(1, MAX_ROWS).map((line) => clip(line, LINE_WIDTH))].slice(0, view.body.length) : fitted,
    footer: overview ? "" : clip(view.footer, ROW_WIDTH),
    ...(view.big !== undefined ? { big: view.big } : {}),
    ...(view.speed !== undefined ? { speed: view.speed } : {}),
  };
}

/** A view before fitting; `wideAfterFirst`: lines after the first are plain text and may use LINE_WIDTH. */
type RawView = NavView & { readonly wideAfterFirst?: boolean };

function rawView(progress: Progress | null, options: ViewOptions, now: number): RawView {
  // A stop waits for its confirming tap. Over the map there is room for one short line only.
  if (options.armedStop) {
    return {
      header: t(options, "g.h.armed"),
      body: options.layout === "overview"
        ? [t(options, "g.armed.short")]
        : [t(options, "g.armed.1"), ...(options.destination ? [t(options, "g.ready1", { place: options.destination })] : [])],
      footer: armedStopFooter(options.locale ?? "en"),
    };
  }

  if (options.error) {
    // An error may carry a second line saying what to do about it.
    return { header: t(options, "g.h.error"), body: options.error.split("\n"), footer: ft(options.locale ?? "en", "exit", { tap: "retry" }) };
  }

  if (options.status && (!options.navigating || !progress)) {
    return {
      header: t(options, "g.h.starting"),
      body: [...(options.destination ? [t(options, "g.ready1", { place: options.destination })] : []), options.status],
      footer: ft(options.locale ?? "en", "exit"),
    };
  }

  if (!options.navigating || !progress) {
    return {
      header: t(options, "g.h.idle"),
      body: options.destination
        ? [t(options, "g.ready1", { place: options.destination }), t(options, "g.ready2")]
        : [t(options, "g.noDest1"), t(options, "g.noDest2")],
      footer: options.mock ? t(options, "g.demoRoute") : "",
    };
  }

  if (progress.arrived) {
    return {
      header: t(options, "g.h.arrived"),
      body: [
        ARROWS.arrive + "  " + t(options, "g.arrived"),
        // A hint only: the wearer may want Babel's customer-talk mode now.
        ...(options.appointment ? [arrivalHint(options.appointment.title, options.locale ?? "en", LINE_WIDTH)] : []),
      ],
      wideAfterFirst: true,
      footer: ft(options.locale ?? "en", "exit", { tap: "destinations" }),
    };
  }

  if (options.waitingForFix) {
    return { header: "", body: [t(options, "g.waitingFix")], footer: statusFooter(options, null, now) };
  }

  if (options.rerouting) {
    return { header: "", body: [t(options, "g.offRoute"), t(options, "g.rerouting")], footer: "" };
  }

  if (progress.offRoute) {
    return { header: "", body: [t(options, "g.offRoute")], footer: ft(options.locale ?? "en", "exit", { tap: "reroute" }) };
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
  // Arriving almost empty beats the next charging station for the small line under the road.
  const low = options.mode === "driving" && options.battery?.low === true;
  const small = low ? t(options, "g.lowArrival", { arr: options.battery!.arrival }) : options.charger;
  // The small line under the road, when it is free and the turn is not close.
  if (small && !overview && !near && body.length < (big ? 2 : 3)) body.push(small);
  const warning = sugarWarning(options, overview);
  const plain = options.speed && options.mode !== "walking" ? (overview ? speedLine(options.speed) : speedColumn(options.speed)) : undefined;
  // Over the map the warning takes the corner of the speed; on the turn page it takes the footer, even close to a turn.
  const speed = overview && warning ? warning : overview && plain !== undefined ? withAppointment(withSugar(plain, options), options, progress, now) : plain;
  return {
    header: "",
    body,
    footer: !overview && warning ? warning : near ? "" : low ? lowFooter(options) : statusFooter(options, progress, now),
    ...(big ? { big: formatDistanceBig(progress.distanceToManeuver, locale) } : {}),
    ...(speed !== undefined ? { speed } : {}),
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
  const locale = options.locale ?? "en";
  const distance = progress ? formatDistance(progress.distanceRemaining, locale) : null;
  const eta = progress ? formatEta(progress.secondsRemaining, now) : null;
  const battery = options.mode === "driving" && progress && options.battery ? t(options, "g.battery", { soc: options.battery.soc, arr: options.battery.arrival }) : null;
  const sugar = options.mode === "driving" && options.sugar ? sugarChip(options.sugar) : null;
  const demo = options.mock ? tag : null;
  const delta = appointmentDelta(options, progress, now);
  const join = (parts: (string | null)[]): string => parts.filter((p): p is string => p !== null && p !== "").join("  ·  ");
  if (delta === null || eta === null) return join([distance, eta, battery, sugar, demo]);
  // To an appointment: arrival against its start, fitted into the same one row (shorter wording, then the battery, then the distance give way).
  const candidates = [
    [distance, arrivalText(eta, delta, locale), battery, sugar, demo],
    [distance, arrivalText(eta, delta, locale, true), battery, sugar, demo],
    [distance, arrivalText(eta, delta, locale, true), sugar, demo],
    [arrivalText(eta, delta, locale, true), sugar, demo],
  ];
  for (const parts of candidates) {
    const line = join(parts);
    if (line.length <= ROW_WIDTH) return line;
  }
  return join(candidates[candidates.length - 1]!);
}

/** Minutes early (> 0) or late (< 0) against the appointment being driven to, or null. */
function appointmentDelta(options: ViewOptions, progress: Progress | null, now: number): number | null {
  const appt = options.appointment;
  if (!appt || !progress || progress.arrived || !Number.isFinite(progress.secondsRemaining) || progress.secondsRemaining < 0) return null;
  return arrivalDelta(now + progress.secondsRemaining * 1000, appt.startMs);
}

/** Characters of the speed plate over the map. */
export const SPEED_PLATE_CHARS = 19;

/** `! 72↘ niedrig & fallend` for a low value, or null; the short form fits the plate over the map. */
function sugarWarning(options: ViewOptions, short: boolean): string | null {
  const sugar = options.mode === "driving" ? options.sugar : null;
  if (!sugar || !sugar.warning) return null;
  const key = sugar.warning === "lowFalling" ? (short ? "g.sugarLowFallingShort" : "g.sugarLowFalling") : "g.sugarLow";
  return t(options, key, { v: sugarChip(sugar) });
}

/** The value after the speed on the map plate, when it fits. */
function withSugar(speedText: string, options: ViewOptions): string {
  const sugar = options.mode === "driving" ? options.sugar : null;
  if (!sugar) return speedText;
  const joined = speedText + "  " + sugarChip(sugar);
  return joined.length <= SPEED_PLATE_CHARS ? joined : speedText;
}

/** The early/late chip after speed (and glucose) on the map plate, when it fits. */
function withAppointment(text: string, options: ViewOptions, progress: Progress, now: number): string {
  const delta = appointmentDelta(options, progress, now);
  if (delta === null) return text;
  const joined = text + "  " + arrivalChip(delta, options.locale ?? "en");
  return joined.length <= SPEED_PLATE_CHARS ? joined : text;
}

/** Arriving almost empty: the tap opens "charging nearby"; the battery stays in view. */
function lowFooter(options: ViewOptions): string {
  const b = options.battery!;
  return footer(options.locale ?? "en", { tap: word(options.locale ?? "en", "charging") }, "none") + "  ·  " + t(options, "g.battery", { soc: b.soc, arr: b.arrival });
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

import type { Locale } from "../i18n";
import { t } from "../messages";
import { ft } from "../footer";
import { fit, rideStopName, stopNamer, type StopView } from "../glasses/view";
import { minutesUntil } from "../transit/types";
import type { Position } from "../ride/tracker";
import type { PageKind } from "../glasses/layout";
import { RIDE_BAND, RIDE_IMAGES, WAIT_BAND, WAIT_IMAGES } from "../glasses/layout";
import { numberKey, renderNumberPng, type BigNumber } from "../glasses/turncard";
import { renderWordsPng, type WordLine } from "../glasses/words";
import { busFrame, busKey, renderBusPng } from "../glasses/bus";
import { arrivalOf, clock, departureOf, waitText } from "./journey";
import type { GuideState } from "./guide";
import type { WalkNav } from "./walk";
import type { WalkMapInput } from "../map/draw";
import { walkCockpitScene, walkModel } from "../cockpit/walk";
import { ROUTE_WIDTH, guideView, type GuideDisplay } from "./view";

/**
 * What the glasses show for the guide, as a whole: the words (`view`), which
 * page kind they belong on and the pictures that go with it.
 *
 * The three stages of a journey get a picture each, because the glasses'
 * text cannot be made larger and these are read at a glance, on the move:
 *
 *  - walking with a route: the cockpit (QUS v1) - a small map of the walk on
 *    the left, the next instruction in big letters on the right;
 *  - waiting at a stop: the countdown in big digits, and a bus that drives
 *    into the stop picture in the last minute;
 *  - riding: "noch 2 Stationen" in big digits, and in the last stretch a pulsing
 *    "get off" warning.
 *
 * Every other state (no walking route yet, a missed bus, arrival) stays plain
 * text, exactly as the text guide shows it.
 */

/** One image of the page: where it goes, a key that changes with its content, how to draw it. */
export interface SceneImage {
  readonly id: number;
  readonly key: string;
  readonly render: () => Promise<Uint8Array>;
}

export interface Scene {
  readonly view: StopView;
  readonly kind: PageKind;
  readonly images: readonly SceneImage[];
  /** The scene changes with the beat (bus, pulse): the caller redraws it every 500 ms. */
  readonly animated: boolean;
}

export const plainScene = (view: StopView): Scene => ({ view, kind: "text", images: [], animated: false });

/** Milliseconds per animation beat. */
export const BEAT_MS = 500;
export const beatOf = (nowMs: number): number => Math.floor(nowMs / BEAT_MS);

const row = (text: string): string => fit(text, ROUTE_WIDTH);

/** A line that ends in something that must survive: the head gives way, the tail never. */
function withTail(head: string, tail: string): string {
  const room = Math.max(8, ROUTE_WIDTH - tail.length);
  return `${fit(head, room)}${tail}`;
}

/** "Aussteigen: Mirabellplatz · an 02:06": the stop gives way when it is long, the time never. */
function alightRow(stop: string, arrives: Date, prefix: string, locale: Locale): string {
  return withTail(`${prefix}${t(locale, "r.alight", { stop })}`, ` · ${t(locale, "r.arrive", { time: clock(arrives) })}`);
}

export interface SceneDisplay extends GuideDisplay {
  /** The animation beat (see {@link beatOf}); 0 keeps everything still. */
  readonly beat?: number;
  /** The map of the walking page (settled view, route, streets); without it the walk stays text. */
  readonly map?: WalkMapInput | null;
}

export function guideScene(
  state: GuideState, now: Date, position: Position | null, locale: Locale, display: SceneDisplay = {},
): Scene {
  const view = guideView(state, now, position, locale, display);
  const beat = display.beat ?? 0;
  const step = state.step;

  if (step.kind === "walk" && display.walk && display.map) {
    return walkScene(view, step, { ...display, walk: display.walk, map: display.map }, now, locale);
  }
  if (step.kind === "transit" && state.phase === "board") return waitScene(view, step, now, locale, beat);
  if (step.kind === "transit" && state.phase === "ride") return rideScene(view, step, state, now, locale, beat, display);
  return plainScene(view);
}

// ---- walking --------------------------------------------------------------------

/** The walking page: the cockpit with the map (src/cockpit/walk.ts). */
function walkScene(
  view: StopView, step: Extract<GuideState["step"], { kind: "walk" }>,
  display: SceneDisplay & { readonly walk: WalkNav; readonly map: WalkMapInput }, now: Date, locale: Locale,
): Scene {
  const model = walkModel({
    nav: display.walk, leg: step.leg, next: step.next, arrival: display.arrival, now, locale, hint: view.footer,
  });
  return walkCockpitScene(model, display.map);
}

// ---- waiting --------------------------------------------------------------------

/** The countdown as big digits: "jetzt", "2" + "min", "1h05". */
export function countdownNumber(departs: Date, now: Date, locale: Locale): BigNumber {
  const minutes = minutesUntil(departs, now);
  if (minutes <= 0) return { value: t(locale, "g.now"), unit: "" };
  if (minutes >= 60) return { value: waitText(departs, now, locale), unit: "" };
  return { value: String(minutes), unit: "min" };
}

function waitScene(
  view: StopView, step: Extract<GuideState["step"], { kind: "transit" }>, now: Date, locale: Locale, beat: number,
): Scene {
  const leg = step.leg;
  const departs = departureOf(leg);
  const number = countdownNumber(departs, now, locale);
  const arriving = minutesUntil(departs, now) <= 0;
  const frame = arriving ? busFrame(beat) : -1;

  const track = leg.boardTrack ? ` · ${t(locale, "r.track", { track: leg.boardTrack })}` : "";
  const alight = leg.stops[leg.stops.length - 1];
  // Two rows: which bus and from where, where to get off. The minutes are the big picture.
  const body = [
    withTail(`${step.transfer ? t(locale, "r.transferPrefix") : ""}${t(locale, "r.board", { line: leg.line, to: leg.headsign })}`, track),
    alightRow(rideStopName(alight?.stop.name ?? ""), arrivalOf(leg), "", locale),
  ];

  const [countdown, bus] = WAIT_IMAGES;
  return {
    view: { header: "", body, footer: view.footer },
    kind: "wait",
    animated: arriving,
    images: [
      { id: countdown!.id, key: `count:${numberKey(number)}`, render: () => renderNumberPng(number, countdown!.width, WAIT_BAND) },
      { id: bus!.id, key: busKey(frame), render: () => renderBusPng(frame, bus!.width, WAIT_BAND) },
    ],
  };
}

// ---- riding ---------------------------------------------------------------------

const lineKey = (lines: readonly WordLine[]): string => lines.map((line) => `${line.size}:${line.text}`).join("/");

/**
 * The stops ahead as a short list in the order they come (0.4.1, Alfred on the
 * glasses): the next one with its time ("jetzt" when the bus is there), the one
 * before getting off, and the one to get off at, marked. Rows that would name
 * the same stop twice fold together, so two stops left are two rows and the
 * last stretch is the marked row alone. A gap between the first two rows is
 * shown as "…"; how many stops it hides is the big number above.
 */
export function rideList(
  leg: Extract<GuideState["step"], { kind: "transit" }>["leg"], state: GuideState, now: Date, locale: Locale,
): string[] {
  const stops = leg.stops;
  const last = stops.length - 1;
  const progress = state.progress;
  const nextIndex = progress && !progress.finished ? Math.min(progress.nextIndex, last) : last;
  // The whole leg decides whether the place can go, so a name does not grow back on the last stretch.
  const name = stopNamer(stops.map((stop) => stop.stop.name), 34);

  const at = (index: number): string => {
    const stop = stops[index]!;
    if (stop.cancelled) return t(locale, "g.cancelled");
    const isNext = index === nextIndex;
    if (isNext && (progress?.arriving || minutesUntil(stop.expected, now) <= 0)) return t(locale, "g.now");
    return clock(stop.expected);
  };

  const rows: string[] = [];
  if (nextIndex < last - 1) rows.push(withTail(`→ ${name(stops[nextIndex]!.stop.name)}`, ` · ${at(nextIndex)}`));
  if (nextIndex <= last - 1) {
    const gap = nextIndex < last - 2 ? "… " : nextIndex === last - 1 ? "→ " : "  ";
    rows.push(withTail(`${gap}${name(stops[last - 1]!.stop.name)}`, ` · ${at(last - 1)}`));
  }
  const alight = stops[last];
  rows.push(withTail(
    `● ${name(alight?.stop.name ?? "")}`,
    ` ${t(locale, "r.listAlight")} · ${clock(arrivalOf(leg))}`,
  ));
  return rows;
}

/** "Umstieg O-Bus 10 · 2/6 · GPS · 2× = Ende": what comes after the ride, short, in the footer. */
function rideFooter(
  step: Extract<GuideState["step"], { kind: "transit" }>, state: GuideState, locale: Locale,
): string {
  const after = step.after;
  const line = after?.kind === "transit" ? after.leg.line : after?.kind === "walk" ? after.next?.line : undefined;
  const key = line ? "r.leadRideTransfer" : after?.kind === "walk" ? "r.leadRideGoal" : "r.leadRideDone";
  const basis = t(locale, state.progress?.basis === "gps" ? "r.footerGuideGps" : "r.footerGuideClock");
  const lead = `${t(locale, key, { line: line ? fit(line, 10) : "" })} · ${Math.min(state.index + 1, state.steps.length)}/${state.steps.length} · ${basis}`;
  // While riding there is nothing to tap or swipe for; the footer says what comes next.
  return ft(locale, "exit", {}, lead);
}

function rideScene(
  view: StopView, step: Extract<GuideState["step"], { kind: "transit" }>, state: GuideState,
  now: Date, locale: Locale, beat: number, display: SceneDisplay,
): Scene {
  const leg = step.leg;
  const left = state.stopsLeft ?? 1;
  const alert = left <= 1;

  const number: BigNumber = alert
    ? { value: "!", unit: "", inverted: beat % 2 === 1 }
    : { value: String(left), unit: "" };
  const before: readonly WordLine[] = alert
    ? [{ text: t(locale, "r.bigNext1"), size: 34, align: "right" }, { text: t(locale, "r.bigNext2"), size: 34, align: "right" }]
    : [{ text: t(locale, "r.bigBefore"), size: 48, align: "right" }];
  const after: readonly WordLine[] = alert
    ? [{ text: t(locale, "r.bigAlight"), size: 56, align: "left" }]
    : [{ text: t(locale, "r.bigAfterMany"), size: 64, align: "left" }];

  const list = rideList(leg, state, now, locale);
  const body = alert && state.progress?.arriving && !state.progress.finished
    ? [...list.slice(-1), row(t(locale, "r.alightNow"))]
    : alert ? list.slice(-1) : list;
  const footer = display.armed || display.rerouted ? view.footer : rideFooter(step, state, locale);

  const [pre, digits, post] = RIDE_IMAGES;
  return {
    view: { header: "", body, footer },
    kind: "ride",
    animated: alert,
    images: [
      {
        id: pre!.id, key: `before:${lineKey(before)}`,
        render: () => renderWordsPng(before, pre!.width, RIDE_BAND, { margin: 6 }),
      },
      { id: digits!.id, key: `digits:${numberKey(number)}`, render: () => renderNumberPng(number, digits!.width, RIDE_BAND) },
      { id: post!.id, key: `after:${lineKey(after)}`, render: () => renderWordsPng(after, post!.width, RIDE_BAND, { margin: 6 }) },
    ],
  };
}

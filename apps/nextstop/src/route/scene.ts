import type { Locale } from "../i18n";
import { t } from "../messages";
import { CURSOR, fit, rideStopName, type StopView } from "../glasses/view";
import { minutesUntil } from "../transit/types";
import type { Position } from "../ride/tracker";
import type { PageKind } from "../glasses/layout";
import { ARROW_SIZE, CARD_HEIGHT, CARD_WIDTH, RIDE_BAND, RIDE_IMAGES, WAIT_BAND, WAIT_IMAGES } from "../glasses/layout";
import { pixelArrowFor } from "../glasses/icons";
import { renderPixelIcon } from "../glasses/pixel";
import {
  approachSteps, bigDistance, cardKey, numberKey, renderNumberPng, renderTurnCardPng, type BigNumber,
} from "../glasses/turncard";
import { renderStreetPngs } from "../glasses/street";
import { renderWordsPng, type WordLine } from "../glasses/words";
import { busFrame, busKey, renderBusPng } from "../glasses/bus";
import { arrivalOf, clock, departureOf, distanceText, waitText, whenPhrase } from "./journey";
import type { GuideState } from "./guide";
import { ROUTE_WIDTH, TURN_KEYS, boardLines, guideView, type GuideDisplay } from "./view";

/**
 * What the glasses show for the guide, as a whole: the words (`view`), which
 * page kind they belong on and the pictures that go with it.
 *
 * The three stages of a journey get a picture each, because the glasses'
 * text cannot be made larger and these are read at a glance, on the move:
 *
 *  - walking with a route: the arrow, the distance in big digits with the
 *    approach bar, the street as a bold strip;
 *  - waiting at a stop: the countdown in big digits, and a bus that drives
 *    into the stop picture in the last minute;
 *  - riding: "noch 2 Halte" in big digits, and in the last stretch a pulsing
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
}

export function guideScene(
  state: GuideState, now: Date, position: Position | null, locale: Locale, display: SceneDisplay = {},
): Scene {
  const view = guideView(state, now, position, locale, display);
  const beat = display.beat ?? 0;
  const step = state.step;

  if (step.kind === "walk" && display.walk) return walkScene(view, step, display, now, locale);
  if (step.kind === "transit" && state.phase === "board") return waitScene(view, step, now, locale, beat);
  if (step.kind === "transit" && state.phase === "ride") return rideScene(view, step, state, now, locale, beat);
  return plainScene(view);
}

// ---- walking --------------------------------------------------------------------

function walkScene(
  view: StopView, step: Extract<GuideState["step"], { kind: "walk" }>,
  display: SceneDisplay, now: Date, locale: Locale,
): Scene {
  const nav = display.walk!;
  const turn = nav.next;
  const arriving = turn.type === "arrive";
  const leg = step.leg;

  const card = { label: bigDistance(nav.toNext, locale), steps: approachSteps(nav.toNext, nav.stretch) };
  const road = arriving
    ? (leg.toDestination ? leg.toName : rideStopName(leg.toName))
    : turn.street ?? t(locale, TURN_KEYS[turn.type]);

  const next = step.next;
  const line = !leg.toDestination && next
    ? withTail(
      t(locale, "r.then", { line: next.line, to: next.headsign }),
      ` · ${whenPhrase(departureOf(next), now, locale)}`,
    )
    : row(t(locale, "r.walkLeft", {
      distance: distanceText(nav.remaining, locale), minutes: Math.max(1, Math.round(nav.remaining / 80)),
    }));

  const arrowKey = turn.type;
  return {
    view: { header: "", body: [line], footer: view.footer },
    kind: "walk",
    animated: false,
    images: [
      { id: 4, key: `arrow:${arrowKey}`, render: () => renderPixelIcon(pixelArrowFor(turn.type), ARROW_SIZE, ARROW_SIZE) },
      { id: 5, key: `card:${cardKey(card)}`, render: () => renderTurnCardPng(card, CARD_WIDTH, CARD_HEIGHT) },
      ...streetImages(road),
    ],
  };
}

function streetImages(road: string): SceneImage[] {
  let halves: Promise<[Uint8Array, Uint8Array]> | null = null;
  const both = (): Promise<[Uint8Array, Uint8Array]> => (halves ??= renderStreetPngs(road));
  return [
    { id: 6, key: `street:${road}`, render: async () => (await both())[0] },
    { id: 7, key: `street:${road}`, render: async () => (await both())[1] },
  ];
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

  const boarding = leg.stops[0];
  const track = leg.boardTrack ? ` · ${t(locale, "r.track", { track: leg.boardTrack })}` : "";
  const alight = leg.stops[leg.stops.length - 1];
  const body = [
    row(`${CURSOR} ${step.transfer ? t(locale, "r.transferPrefix") : ""}${t(locale, "r.board", { line: leg.line, to: leg.headsign })}`),
    row(boardLines(leg, now, locale, "r.boardAt")),
    row(`${rideStopName(boarding?.stop.name ?? "")}${track}`),
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

function rideScene(
  view: StopView, step: Extract<GuideState["step"], { kind: "transit" }>, state: GuideState,
  now: Date, locale: Locale, beat: number,
): Scene {
  const leg = step.leg;
  const left = state.stopsLeft ?? 1;
  const progress = state.progress;
  const alert = left <= 1;
  const alight = leg.stops[leg.stops.length - 1];
  const alightName = rideStopName(alight?.stop.name ?? "");

  const number: BigNumber = alert
    ? { value: "!", unit: "", inverted: beat % 2 === 1 }
    : { value: String(left), unit: "" };
  const before: readonly WordLine[] = alert
    ? [{ text: t(locale, "r.bigNext1"), size: 34, align: "right" }, { text: t(locale, "r.bigNext2"), size: 34, align: "right" }]
    : [{ text: t(locale, "r.bigBefore"), size: 48, align: "right" }];
  const after: readonly WordLine[] = alert
    ? [{ text: t(locale, "r.bigAlight"), size: 56, align: "left" }]
    : [{ text: t(locale, "r.bigAfterMany"), size: 64, align: "left" }];

  const nextStop = progress && !progress.finished ? progress.next : undefined;
  const when = nextStop ? waitText(nextStop.expected, now, locale) : "";
  const second = alert
    ? (progress?.arriving ? t(locale, "r.alightNow") : "")
    : left === 2
      ? t(locale, "r.warnNext")
      : nextStop
        ? withTail(t(locale, "r.nextStop", { stop: rideStopName(nextStop.stop.name), when: "" }).replace(/ · $/, ""), ` · ${when}`)
        : "";
  const after2 = step.after;
  const afterLine = after2?.kind === "transit"
    ? t(locale, "r.afterTransfer", { line: after2.leg.line })
    : after2?.kind === "walk"
      ? (after2.next ? t(locale, "r.afterTransfer", { line: after2.next.line }) : t(locale, "r.afterGoal"))
      : t(locale, "r.afterDone");
  const body = [
    alightRow(alightName, arrivalOf(leg), `${CURSOR} `, locale),
    row(second),
    "",
    row(afterLine),
  ];

  const [pre, digits, post] = RIDE_IMAGES;
  return {
    view: { header: "", body, footer: view.footer },
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

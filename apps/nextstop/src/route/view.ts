import type { RideStop } from "../transit/types";
import { delayMinutes, metresBetween } from "../transit/types";
import type { Position } from "../ride/tracker";
import { CURSOR, fit, rideStopName, wrap, type StopView } from "../glasses/view";
import { tailLines } from "../voice/live-stt";
import type { Locale } from "../i18n";
import { t } from "../messages";
import { armedFooter, ft } from "../footer";
import {
  arrivalOf, clock, departureOf, distanceText, firstTransit, waitText, whenPhrase,
  type Journey, type TransitLeg, type WalkLeg,
} from "./journey";
import type { GuideState, Step } from "./guide";
import type { TurnType, WalkNav } from "./walk";
import type { Target } from "./places";
import type { GeoResult } from "./geocode";

/**
 * The route screens: the goal list, the connections and the companion.
 *
 * Text only, and wide: with no icon beside it the body runs the full width of
 * the display. The font cannot be made larger, so "large and clear" means the
 * instruction owns the first row and the detail follows beneath it.
 */

/** Characters per row on the full-width body. A little under what fits on average text. */
export const ROUTE_WIDTH = 50;
/** Rows the body can show without clipping. */
export const ROUTE_ROWS = 7;

/** One character of certainty after a time, in the same alphabet as the board. */
export function timeMark(stop: RideStop): string {
  if (stop.cancelled) return "X ";
  if (stop.source !== "realtime") return "~ ";
  const delay = delayMinutes(stop);
  if (delay === 0) return "● ";
  return delay > 0 ? `+${delay} ` : `${delay} `;
}

const row = (text: string): string => fit(text, ROUTE_WIDTH);

// ---- goals ----------------------------------------------------------------

export function placesView(targets: readonly Target[], selected: number, now: Date, locale: Locale): StopView {
  const header = t(locale, "r.placesHeader", { time: clock(now) });
  if (targets.length === 0) {
    return {
      header,
      body: ["", t(locale, "r.noPlaces1"), "", t(locale, "r.noPlaces2"), t(locale, "r.noPlaces3"), "", t(locale, "r.hintVoice")],
      footer: ft(locale, "back", { tap: "speak" }),
    };
  }
  const first = Math.max(0, Math.min(selected - ROUTE_ROWS + 1, targets.length - ROUTE_ROWS));
  const body = targets.slice(first, first + ROUTE_ROWS).map((target, offset) => {
    const label = target.isNow ? t(locale, "r.nowPrefix", { name: target.name }) : target.name;
    return row(`${first + offset === selected ? CURSOR : " "} ${label}`);
  });
  return { header, body, footer: ft(locale, "back", { tap: "go", swipe: "select" }) };
}

// ---- connections ----------------------------------------------------------

/** "Bus 3 → O-Bus 7": the vehicles of a connection, in the order they are taken. */
export function linesOf(journey: Journey): string {
  return journey.legs
    .filter((leg): leg is TransitLeg => leg.kind === "transit")
    .map((leg) => leg.line)
    .join(" → ");
}

function walkMinutes(journey: Journey): number {
  return Math.round(journey.legs
    .filter((leg): leg is WalkLeg => leg.kind === "walk")
    .reduce((sum, leg) => sum + (leg.end.getTime() - leg.start.getTime()), 0) / 60000);
}

/**
 * One connection as one row:
 *   `> in 4 min · Bus 3 → O-Bus 7 · an 14:52 · 1×`
 * The vehicle list is the part that gives way when the row is too long; the
 * waiting time and the arrival never truncate.
 */
export function journeyRow(journey: Journey, selected: boolean, now: Date, locale: Locale): string {
  const cursor = selected ? CURSOR : " ";
  const transit = firstTransit(journey);
  const arrival = t(locale, "r.arrive", { time: clock(journey.end) });
  if (!transit) {
    const minutes = Math.max(1, Math.round((journey.end.getTime() - journey.start.getTime()) / 60000));
    return row(`${cursor} ${t(locale, "r.walkOnly", { minutes })} · ${arrival}`);
  }
  const departs = departureOf(transit);
  const when = departs.getTime() - now.getTime() < 60000
    ? t(locale, "g.now")
    : t(locale, "r.in", { when: waitText(departs, now, locale) });
  const changes = journey.transfers > 0 ? ` · ${journey.transfers}×` : "";
  const head = `${cursor} ${when} · `;
  const tail = ` · ${arrival}${changes}`;
  const room = ROUTE_WIDTH - head.length - tail.length;
  return `${head}${fit(linesOf(journey), Math.max(4, room))}${tail}`;
}

export function plansView(
  destination: string, journeys: readonly Journey[], selected: number, now: Date, locale: Locale,
): StopView {
  const header = fit(t(locale, "r.plansHeader", { name: destination, time: clock(now) }), ROUTE_WIDTH);
  const shown = journeys.slice(0, 4);
  const body = shown.map((journey, index) => journeyRow(journey, index === selected, now, locale));

  const chosen = shown[selected];
  const transit = chosen ? firstTransit(chosen) : undefined;
  if (chosen && transit) {
    const boarding = transit.stops[0];
    const track = transit.boardTrack ? ` · ${t(locale, "r.track", { track: transit.boardTrack })}` : "";
    while (body.length < 5) body.push("");
    body.push(row(`${t(locale, "r.leaveFrom", { stop: rideStopName(boarding?.stop.name ?? "") })}${track}`));
    body.push(row(t(locale, "r.walkAndTotal", {
      walk: walkMinutes(chosen),
      total: Math.round((chosen.end.getTime() - chosen.start.getTime()) / 60000),
    })));
  }
  return { header, body, footer: ft(locale, "back", { tap: "go", swipe: "select" }) };
}

// ---- companion ------------------------------------------------------------

function metresLeft(leg: WalkLeg, position: Position | null): number {
  if (!position || (position.accuracy !== undefined && position.accuracy > 100)) return leg.metres;
  return metresBetween(position.lat, position.lon, leg.toLat, leg.toLon);
}

export function boardLines(leg: TransitLeg, now: Date, locale: Locale, keyTime: "r.boardAt" | "r.thenAt"): string {
  const boarding = leg.stops[0];
  const departs = departureOf(leg);
  return t(locale, keyTime, {
    time: clock(departs),
    mark: boarding ? timeMark(boarding) : "",
    when: whenPhrase(departs, now, locale),
  });
}

export interface GuideDisplay {
  /**
   * QIS v1: the next single tap carries out the armed action ("stop" = end the guide, "search" =
   * plan anew after a missed bus). Swipe, 2x or 4 s without input cancel it.
   */
  readonly armed?: "stop" | "search" | undefined;
  /** Where the walker is on the walking route of this step, when there is one. */
  readonly walk?: WalkNav | null;
  /** When the whole journey is expected to end; shown in every header. */
  readonly arrival?: Date;
  /** A new walking route was just worked out because the walker left the old one. */
  readonly rerouted?: boolean;
}

/** An arrow per turn. The glasses cannot enlarge text, so the arrow leads the row. */
export const ARROWS: Readonly<Record<TurnType, string>> = {
  depart: "↑", straight: "↑", arrive: "●",
  left: "←", slightLeft: "↖", sharpLeft: "↰",
  right: "→", slightRight: "↗", sharpRight: "↱",
  uturn: "↓", roundabout: "↻",
};

export const TURN_KEYS: Readonly<Record<TurnType, string>> = {
  depart: "r.turnStraight", straight: "r.turnStraight", arrive: "r.turnStraight",
  left: "r.turnLeft", slightLeft: "r.turnSlightLeft", sharpLeft: "r.turnSharpLeft",
  right: "r.turnRight", slightRight: "r.turnSlightRight", sharpRight: "r.turnSharpRight",
  uturn: "r.turnUturn", roundabout: "r.turnRoundabout",
};

/** The three rows of a walking instruction: the turn, the street, what is left. */
export function walkRows(nav: WalkNav, leg: WalkLeg, locale: Locale): string[] {
  const turn = nav.next;
  const arriving = turn.type === "arrive";
  const first = arriving
    ? `${ARROWS.arrive} ${t(locale, leg.toDestination ? "r.walkEndGoal" : "r.walkEndStop", { distance: distanceText(nav.toNext, locale) })}`
    : `${ARROWS[turn.type]}  ${distanceText(nav.toNext, locale)}  ${t(locale, TURN_KEYS[turn.type])}`;
  const second = arriving
    ? (leg.toDestination ? leg.toName : rideStopName(leg.toName))
    : turn.street ? t(locale, "r.turnInto", { street: turn.street }) : "";
  const minutes = Math.max(1, Math.round(nav.remaining / 80));
  return [row(first), row(second), row(t(locale, "r.walkLeft", { distance: distanceText(nav.remaining, locale), minutes }))];
}

export function guideView(
  state: GuideState, now: Date, position: Position | null, locale: Locale, display: GuideDisplay = {},
): StopView {
  const view = guideViewInner(state, now, position, locale, display);
  const arrival = display.arrival && state.step.kind !== "arrived"
    ? ` · ${t(locale, "r.arrive", { time: clock(display.arrival) })}`
    : "";
  return {
    ...view,
    header: fit(`${view.header}${arrival}`, ROUTE_WIDTH),
    footer: display.rerouted && !display.armed ? ft(locale, "exit", { tap: "next" }, t(locale, "r.footerRerouted")) : view.footer,
  };
}

function guideViewInner(
  state: GuideState, now: Date, position: Position | null, locale: Locale, display: GuideDisplay,
): StopView {
  const time = clock(now);
  const step = state.step;
  const basis = state.progress?.basis === "gps" || (position !== null && state.phase !== "ride")
    ? t(locale, "r.footerGuideGps")
    : t(locale, "r.footerGuideClock");
  const counter = ft(locale, "exit", { tap: "next" }, `${Math.min(state.index + 1, state.steps.length)}/${state.steps.length} · ${basis}`);
  const armed = display.armed !== undefined;
  const footer = display.armed ? armedFooter(locale, t(locale, display.armed === "stop" ? "q.end" : "q.search")) : counter;

  if (step.kind === "arrived") {
    const goal = [...state.steps].reverse().find((s): s is Extract<Step, { kind: "walk" }> => s.kind === "walk");
    return {
      header: t(locale, "r.headerDone", { time }),
      body: [`${CURSOR} ${t(locale, "r.arrived")}`, goal ? row(goal.leg.toName) : "", "", t(locale, "r.arrivedHint")],
      footer: armed ? footer : ft(locale, "back", { tap: "done" }),
    };
  }

  if (step.kind === "walk") {
    const leg = step.leg;
    const metres = metresLeft(leg, position);
    const walkMin = Math.max(1, Math.round(metres / 80));
    const info = t(locale, "r.walkInfo", { distance: distanceText(metres, locale), minutes: walkMin });

    if (display.walk) {
      const next = step.next;
      return {
        header: t(locale, "r.headerWalk", { time }),
        body: [
          ...walkRows(display.walk, leg, locale),
          ...(!leg.toDestination && next
            ? ["", row(step.transfer ? t(locale, "r.transfer", { line: next.line }) : t(locale, "r.then", { line: next.line, to: next.headsign })),
              row(boardLines(next, now, locale, "r.thenAt"))]
            : []),
        ],
        footer,
      };
    }
    if (leg.toDestination) {
      return {
        header: t(locale, "r.headerWalk", { time }),
        body: [`${CURSOR} ${t(locale, "r.walkToGoal")}`, row(leg.toName), row(info)],
        footer,
      };
    }
    const next = step.next;
    if (step.transfer && next) {
      const track = next.boardTrack ? ` · ${t(locale, "r.track", { track: next.boardTrack })}` : "";
      return {
        header: t(locale, "r.headerTransfer", { time }),
        body: [
          row(`${CURSOR} ${t(locale, "r.transfer", { line: next.line })}`),
          row(t(locale, "r.transferWalk", { stop: rideStopName(leg.toName), distance: distanceText(metres, locale) })),
          row(`${t(locale, "r.towards", { to: next.headsign })}${track}`),
          row(boardLines(next, now, locale, "r.boardAt")),
        ],
        footer,
      };
    }
    return {
      header: t(locale, "r.headerWalk", { time }),
      body: [
        `${CURSOR} ${t(locale, "r.walkToStop")}`,
        row(rideStopName(leg.toName)),
        row(info),
        "",
        ...(next ? [row(t(locale, "r.then", { line: next.line, to: next.headsign })), row(boardLines(next, now, locale, "r.thenAt"))] : []),
      ],
      footer,
    };
  }

  // Transit step.
  const leg = step.leg;
  const alight = leg.stops[leg.stops.length - 1];
  const alightName = rideStopName(alight?.stop.name ?? "");

  if (state.phase === "missed") {
    return {
      header: t(locale, "r.headerMissed", { time }),
      body: [`${CURSOR} ${t(locale, "r.missedTitle", { line: leg.line })}`, "", t(locale, "r.missedHint")],
      footer: armed ? footer : ft(locale, "exit", { tap: "search" }),
    };
  }

  if (state.phase === "board") {
    const boarding = leg.stops[0];
    const track = leg.boardTrack ? ` · ${t(locale, "r.track", { track: leg.boardTrack })}` : "";
    const count = leg.stops.length - 1;
    return {
      header: t(locale, step.transfer ? "r.headerTransfer" : "r.headerBoard", { time }),
      body: [
        row(`${CURSOR} ${step.transfer ? t(locale, "r.transfer", { line: leg.line }) : t(locale, "r.waitFor", { line: leg.line })}`),
        row(t(locale, "r.towards", { to: leg.headsign })),
        row(boardLines(leg, now, locale, "r.boardAt")),
        row(`${rideStopName(boarding?.stop.name ?? "")}${track}`),
        "",
        row(t(locale, "r.alight", { stop: alightName })),
        row(t(locale, count === 1 ? "r.rideLengthOne" : "r.rideLengthMany", { count, time: clock(arrivalOf(leg)) })),
      ],
      footer,
    };
  }

  // Riding.
  const progress = state.progress;
  const left = state.stopsLeft ?? 1;
  const arrives = arrivalOf(leg);
  const next = progress && !progress.finished ? progress.next : undefined;
  const after = step.after;
  const afterLine = after?.kind === "transit"
    ? t(locale, "r.afterTransfer", { line: after.leg.line })
    : after?.kind === "walk"
      ? (after.next ? t(locale, "r.afterTransfer", { line: after.next.line }) : t(locale, "r.afterGoal"))
      : t(locale, "r.afterDone");

  const second = left <= 1
    ? (progress?.arriving ? t(locale, "r.alightNow") : t(locale, "r.stopsLeftOne", { time: clock(arrives) }))
    : t(locale, "r.stopsLeftMany", { count: left, time: clock(arrives) });

  return {
    header: row(`${t(locale, "r.headerRide", { line: leg.line })} · ${time}`),
    body: [
      row(`${CURSOR} ${t(locale, "r.alight", { stop: alightName })}`),
      row(second),
      "",
      left === 2
        ? row(t(locale, "r.warnNext"))
        : next && left > 1
          ? row(t(locale, "r.nextStop", { stop: rideStopName(next.stop.name), when: waitText(next.expected, now, locale) }))
          : "",
      "",
      row(afterLine),
    ],
    footer,
  };
}

// ---- spoken destination -----------------------------------------------------

export type VoiceState =
  /** `live`: what the live recogniser heard so far, shown while still speaking. */
  | { readonly phase: "recording"; readonly live?: string }
  | { readonly phase: "working"; readonly heard?: string }
  | {
    readonly phase: "results"; readonly heard: string; readonly results: readonly GeoResult[];
    readonly selected: number; readonly saved: boolean;
  }
  /** `retry: false`: a tap cannot help (no speech server), it goes back instead of recording again. */
  | { readonly phase: "error"; readonly error: string; readonly hint: string; readonly retry?: boolean };

export function voiceView(state: VoiceState, now: Date, locale: Locale): StopView {
  const header = t(locale, "r.headerVoice", { time: clock(now) });
  switch (state.phase) {
    case "recording":
      // Live words: the newest at the bottom, the start scrolls off the top while speaking.
      if (state.live) {
        return {
          header,
          body: [t(locale, "r.voiceRecording"), "", ...tailLines(state.live, ROUTE_WIDTH, ROUTE_ROWS - 2)],
          footer: ft(locale, "back", { tap: "done" }),
        };
      }
      return {
        header,
        body: [t(locale, "r.voiceRecording"), t(locale, "r.voiceRelease"), "", row(t(locale, "r.voiceSay"))],
        footer: ft(locale, "back", { tap: "done" }),
      };
    case "working":
      return {
        header,
        body: [t(locale, "r.voiceWorking"), ...(state.heard ? ["", ...tailLines(state.heard, ROUTE_WIDTH, ROUTE_ROWS - 2)] : [])],
        footer: ft(locale, "back"),
      };
    case "error":
      return {
        header,
        body: [...wrapRows(state.error), "", ...wrapRows(state.hint)].slice(0, ROUTE_ROWS),
        // A tap tries again where that can help; without a speech server it only goes back.
        footer: ft(locale, "back", { tap: state.retry === false ? "back" : "again" }),
      };
    case "results": {
      const rows: string[] = [row(t(locale, "r.voiceHeard", { text: state.heard }))];
      state.results.slice(0, 3).forEach((result, index) => {
        rows.push(row(`${index === state.selected ? CURSOR : " "} ${result.name}`));
        rows.push(row(`  ${result.detail}`));
      });
      return { header, body: rows, footer: ft(locale, "back", { tap: "go", swipe: "select" }, state.saved ? t(locale, "r.leadSaved") : "") };
    }
  }
}

/** The help page (QIS v1): the four gestures in footer order, then what the app needs. */
export function helpView(locale: Locale): StopView {
  return {
    header: `NEXTSTOP · ${t(locale, "h.title")}`,
    body: ["", t(locale, "h.tap"), t(locale, "h.swipe"), t(locale, "h.voice"), t(locale, "h.back"), t(locale, "h.arm"), t(locale, "h.needs")],
    footer: ft(locale, "back", { tap: "close" }),
  };
}

function wrapRows(text: string): string[] {
  return wrap(text, ROUTE_WIDTH) as string[];
}

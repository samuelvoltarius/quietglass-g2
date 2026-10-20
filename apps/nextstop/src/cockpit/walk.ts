import type { Locale } from "../i18n";
import { t } from "../messages";
import { createFrame, frameKey, tiles, blit } from "../screen/frame";
import type { TextBackend } from "../screen/text";
import { rideStopName } from "../glasses/view";
import { departureOf, distanceText, type TransitLeg, type WalkLeg } from "../route/journey";
import type { Scene } from "../route/scene";
import type { TurnType, WalkNav } from "../route/walk";
import { renderWalkMap, type WalkMapInput } from "../map/draw";
import { drawChrome, type ChromeModel, type ComposedTiles } from "./compose";
import { awayLabel, hhmm, type CockpitCell } from "./model";
import { textBackend, tilesScene } from "./scene";

/**
 * The walking page as a cockpit (QUS v1): the left half is a small map
 * (src/map/*), the right half says what to do next.
 *
 *   ┌──────────────────────────┐ ┌──────────────────────────────┐
 *   │  streets, the rest of    │ │ NEXTSTOP               14:05 │
 *   │  the route (bright), the │ │ LINKS · 80 M                 │
 *   │  stop / goal, the walker │ │ STERNECKSTRASSE              │
 *   │                          │ │ WEG     ABFAHRT  PUFFER      │
 *   │                          │ │ 320 M   14:12    4 MIN       │
 *   │                          │ │ LINIE   STEIG                │
 *   ├──────────────────────────┴─┴──────────────────────────────┤
 *   │ 1/5 · GPS · Tippen = weiter · 2× = Ende                   │
 *   └───────────────────────────────────────────────────────────┘
 *
 * Words and numbers are decided here without drawing (pure, tested); the
 * picture is laid out by compose.ts's right half and the map's own drawing.
 */

/** Metres a passenger walks in a minute (the same pace the rest of the app counts with). */
export const WALK_METRES_PER_MINUTE = 80;
/** A buffer below this many minutes is framed. */
export const TIGHT_BUFFER_MINUTES = 2;

const upper = (text: string): string => text.toUpperCase();

const TURN_WORDS: Readonly<Record<Exclude<TurnType, "arrive">, string>> = {
  depart: "w.straight", straight: "w.straight",
  left: "w.left", slightLeft: "w.slightLeft", sharpLeft: "w.sharpLeft",
  right: "w.right", slightRight: "w.slightRight", sharpRight: "w.sharpRight",
  uturn: "w.uturn", roundabout: "w.roundabout",
};

/** The one big line: "LINKS · 80 M", "HALTESTELLE · 320 M", "ZIEL · 120 M". */
export function walkHeadline(nav: WalkNav, leg: WalkLeg, locale: Locale): string {
  const turn = nav.next;
  const word = turn.type === "arrive"
    ? t(locale, leg.toDestination ? "w.goal" : "w.stop")
    : t(locale, TURN_WORDS[turn.type]);
  return `${word} · ${upper(distanceText(nav.toNext, locale))}`;
}

/**
 * Line two: the street of the next instruction ("IN LINZER GASSE"), else the
 * street walked on now, else the place the walk ends at (which the last
 * stretch shows too; the place also has a cell of its own).
 */
export function walkDirection(nav: WalkNav, leg: WalkLeg, locale: Locale): string {
  const place = leg.toDestination ? leg.toName : rideStopName(leg.toName);
  if (nav.next.type === "arrive") return upper(place);
  if (nav.next.street) return upper(t(locale, "r.turnInto", { street: nav.next.street }));
  return upper(nav.current ?? place);
}

/** Minutes to spare at the stop: until the vehicle leaves, less the minutes still to walk. */
export function bufferMinutes(departs: Date, now: Date, remainingMetres: number): number {
  return Math.floor((departs.getTime() - now.getTime()) / 60000 - remainingMetres / WALK_METRES_PER_MINUTE);
}

/**
 * The cells: the walk left, the time of the connection to catch, the buffer
 * (framed when it is under two minutes), the line and the stand. A walk to
 * the destination has no vehicle to catch: the walk, the arrival, the time.
 */
export function walkCells(
  nav: WalkNav, leg: WalkLeg, next: TransitLeg | undefined, arrival: Date | undefined, now: Date, locale: Locale,
): CockpitCell[] {
  const cells: CockpitCell[] = [{ label: t(locale, "c.walk"), value: awayLabel(nav.remaining, locale) }];
  if (!leg.toDestination && next) {
    const departs = departureOf(next);
    const spare = bufferMinutes(departs, now, nav.remaining);
    cells.push(
      { label: t(locale, "c.at"), value: hhmm(departs) },
      { label: t(locale, "w.buffer"), value: `${spare} MIN`, ...(spare < TIGHT_BUFFER_MINUTES ? { alert: true } : {}) },
      { label: t(locale, "c.line"), value: upper(next.line) },
      { label: t(locale, "c.track"), value: next.boardTrack ? upper(next.boardTrack) : "–" },
      { label: t(locale, "c.stop"), value: upper(rideStopName(leg.toName, 24)) },
    );
    return cells;
  }
  cells.push(
    { label: t(locale, "w.arrival"), value: hhmm(arrival ?? leg.end) },
    { label: t(locale, "w.time"), value: `${Math.max(1, Math.round(nav.remaining / WALK_METRES_PER_MINUTE))} MIN` },
    { label: t(locale, "c.goal"), value: upper(leg.toName) },
  );
  return cells;
}

export interface WalkModelInput {
  readonly nav: WalkNav;
  readonly leg: WalkLeg;
  readonly next: TransitLeg | undefined;
  /** When the whole journey ends; the destination walk shows it. */
  readonly arrival: Date | undefined;
  readonly now: Date;
  readonly locale: Locale;
  /** The hint line: the counter and the gestures, or the armed row. */
  readonly hint: string;
}

/** The right half and the hint line of the walking cockpit. */
export function walkModel(input: WalkModelInput): ChromeModel {
  const { nav, leg, next, arrival, now, locale } = input;
  return {
    title: "NEXTSTOP",
    clock: hhmm(now),
    headline: walkHeadline(nav, leg, locale),
    direction: walkDirection(nav, leg, locale),
    cells: walkCells(nav, leg, next, arrival, now, locale),
    hint: input.hint,
  };
}

let remembered: { key: string; composed: ComposedTiles } | null = null;

/** The four tiles of a walking cockpit; the same model and map are composed once. */
export function composeWalkTiles(model: ChromeModel, map: WalkMapInput, backend: TextBackend): ComposedTiles {
  const key = JSON.stringify([model, map.view, map.routeKey, map.streetsKey, map.target, map.targetKind, map.turn, map.nextStreet, map.currentStreet, backend.name]);
  if (remembered && remembered.key === key) return remembered.composed;
  const frame = createFrame();
  blit(frame, renderWalkMap(map, backend), 0, 0);
  drawChrome(frame, model, backend);
  const parts = tiles(frame);
  const composed: ComposedTiles = { tiles: parts, keys: parts.map(frameKey) };
  remembered = { key, composed };
  return composed;
}

/**
 * The walking page as a scene. The map comes from the caller already settled
 * (src/map/camera.ts `settleView`), so a position that barely changed leaves
 * the two left tiles with the same key and they are not sent again; the
 * clock changes only the tile at the top right.
 */
export function walkCockpitScene(model: ChromeModel, map: WalkMapInput, text: TextBackend = textBackend()): Scene {
  return tilesScene(model.hint, composeWalkTiles(model, map, text));
}

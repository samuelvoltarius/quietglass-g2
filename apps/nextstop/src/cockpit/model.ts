import type { Locale } from "../i18n";
import { t } from "../messages";
import { footer } from "../footer";
import { waitText } from "../route/journey";
import { glanceHeadsign } from "../glasses/board";
import { rideStopName } from "../glasses/view";
import type { Departure, Stop } from "../transit/types";
import { delayMinutes, minutesUntil } from "../transit/types";

/**
 * What the departures cockpit shows, in words and numbers, decided without
 * drawing (QUS v1): the headline, the label/value cells, the countdown ring
 * for the left half, the caption and the hint line. compose.ts only lays this out.
 */

export type Tone = "ok" | "warn" | "critical" | "offline";

export interface CockpitCell {
  readonly label: string;
  readonly value: string;
  /** Drawn with a frame round it (something is wrong here). */
  readonly alert?: boolean;
}

/** The countdown ring: fills up as the vehicle gets closer. */
export interface CockpitRing {
  /** 0 = far away (15 min or more), 1 = here. */
  readonly progress: number;
  readonly center: string;
  readonly sub: string;
  readonly tone: Tone;
}

export interface CockpitModel {
  readonly title: string;
  readonly clock: string;
  /** The big line, e.g. "BUS 3 · 4 MIN". */
  readonly headline: string;
  /** Under it, smaller: the direction. */
  readonly direction: string;
  /** Rows of three columns. */
  readonly cells: readonly CockpitCell[];
  readonly ring: CockpitRing;
  /** Left bottom: the stop. */
  readonly caption: string;
  /** The one footer line with the gestures. */
  readonly hint: string;
  readonly tone: Tone;
}

export interface BoardInput {
  readonly stop: Stop;
  readonly departures: readonly Departure[];
  readonly selected: number;
  readonly metresAway: number | null;
  readonly now: Date;
  readonly locale: Locale;
}

/** The hint line is drawn into the picture: about 70 characters fit the 552 px of the bottom row. */
export const HINT_WIDTH = 70;

/** The minutes at which the ring starts to fill. */
export const RING_MINUTES = 15;

/** "HH:MM" of a date in the phone's time (24 h). */
export function hhmm(time: Date): string {
  return `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
}

/** "BUS 3" for a bare number, otherwise the line as the operator writes it ("S3", "O-BUS 6"), upper case. */
export function lineLabel(line: string, locale: Locale): string {
  const plain = line.trim();
  return /^\d+[A-Za-z]?$/.test(plain) ? `${t(locale, "c.bus")} ${plain}`.toUpperCase() : plain.toUpperCase();
}

/** The time part of the headline: "4 MIN", "JETZT", "1H05", "FÄLLT AUS". */
export function whenLabel(departure: Departure, now: Date, locale: Locale): string {
  if (departure.cancelled) return t(locale, "g.cancelled").toUpperCase();
  return waitText(departure.expected, now, locale).toUpperCase();
}

function toneOf(departure: Departure): Tone {
  if (departure.cancelled) return "offline";
  return delayMinutes(departure) > 0 ? "warn" : "ok";
}

/** How late: "+3 MIN", "0 MIN" (on time, confirmed), "FAHRPLAN" (nothing confirmed), "–" (cancelled). */
export function delayCell(departure: Departure, locale: Locale): CockpitCell {
  const label = t(locale, "c.delay");
  if (departure.cancelled) return { label, value: t(locale, "g.cancelled").toUpperCase(), alert: true };
  if (departure.source !== "realtime") return { label, value: t(locale, "c.planned").toUpperCase() };
  const delay = delayMinutes(departure);
  const value = `${delay > 0 ? "+" : ""}${delay} MIN`;
  return delay > 0 ? { label, value, alert: true } : { label, value };
}

/** "120 M", "1,2 KM" for the walk to the stop. */
export function awayLabel(metres: number | null, locale: Locale): string {
  if (metres === null) return "–";
  if (metres < 1000) return `${Math.max(10, Math.round(metres / 10) * 10)} M`;
  const km = (metres / 1000).toFixed(1);
  return `${locale === "de" ? km.replace(".", ",") : km} KM`;
}

/** The six cells of a departure: the one after, the track, the delay, the stop, the walk, the clock time. */
export function boardCells(input: BoardInput, chosen: Departure, index: number): CockpitCell[] {
  const { departures, now, locale } = input;
  const after = departures[index + 1];
  return [
    { label: t(locale, "c.next"), value: after ? (after.cancelled ? "–" : waitText(after.expected, now, locale).toUpperCase()) : "–" },
    { label: t(locale, "c.track"), value: chosen.track ? chosen.track.toUpperCase() : "–" },
    delayCell(chosen, locale),
    { label: t(locale, "c.stop"), value: rideStopName(input.stop.name, 40).toUpperCase() },
    { label: t(locale, "c.walk"), value: awayLabel(input.metresAway, locale) },
    { label: t(locale, "c.at"), value: chosen.cancelled ? "–" : hhmm(chosen.expected) },
  ];
}

/** The hint line: only the gestures that do something here; the counter stands in front. */
export function boardHint(locale: Locale, position: number, total: number): string {
  const lead = total > 1 ? `${position}/${total}` : "";
  return footer(locale, {
    tap: t(locale, "q.follow"), ...(total > 1 ? { swipe: t(locale, "q.select") } : {}),
  }, "back", lead, HINT_WIDTH);
}

/** The ring of one departure. */
export function boardRing(chosen: Departure, now: Date, locale: Locale): CockpitRing {
  const tone = toneOf(chosen);
  if (chosen.cancelled) return { progress: 0, center: "–", sub: t(locale, "c.cancelledShort").toUpperCase(), tone };
  const minutes = minutesUntil(chosen.expected, now);
  const progress = Math.max(0, Math.min(1, 1 - minutes / RING_MINUTES));
  if (minutes <= 0) return { progress: 1, center: t(locale, "g.now").toUpperCase(), sub: "", tone };
  if (minutes >= 60) return { progress, center: waitText(chosen.expected, now, locale).toUpperCase(), sub: "", tone };
  return { progress, center: String(minutes), sub: "MIN", tone };
}

/** The whole model of the departures page; `departures` must not be empty. */
export function boardModel(input: BoardInput): CockpitModel {
  const { departures, now, locale } = input;
  const index = Math.max(0, Math.min(input.selected, departures.length - 1));
  const chosen = departures[index]!;
  return {
    title: "NEXTSTOP",
    clock: hhmm(now),
    headline: `${lineLabel(chosen.line, locale)} · ${whenLabel(chosen, now, locale)}`,
    direction: `→ ${glanceHeadsign(chosen.headsign).toUpperCase()}`,
    cells: boardCells(input, chosen, index),
    ring: boardRing(chosen, now, locale),
    caption: rideStopName(input.stop.name, 24),
    hint: boardHint(locale, index + 1, departures.length),
    tone: toneOf(chosen),
  };
}

/** A key that changes exactly when what the cockpit would draw changes. */
export function modelKey(model: CockpitModel): string {
  return JSON.stringify([model.clock, model.headline, model.direction, model.cells, model.ring, model.caption, model.hint]);
}

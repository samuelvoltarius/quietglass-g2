import type { Locale } from "../i18n";
import { t } from "../messages";
import type { Departure, RideStop, Stop } from "../transit/types";
import { delayMinutes, minutesUntil } from "../transit/types";
import type { Follow } from "../ride/follow";
import { BIG_BAND, BOARD_IMAGES, BOARD_ROWS, BOARD_STRIP } from "./layout";
import { numberKey, renderNumberPng, type BigNumber } from "./turncard";
import { renderBadgePng, renderWordsPng, type WordLine } from "./words";
import { renderStreetPngs } from "./street";
import { busFrame, busKey, renderBusPng } from "./bus";
import { fit, rideStopName, shortHeadsign, wrap } from "./view";
import type { Scene, SceneImage } from "../route/scene";
import { clock, waitText } from "../route/journey";

/**
 * The "board" page: one thing big, little else.
 *
 * Alfred on the glasses (0.3.7): "alles zu viel Text". Seven rows of small
 * type are a list to be read, not a glance. Every page on the board screen now
 * has the same shape - the minutes as big pixel digits, a picture beside them,
 * one bold line across the display, at most three short rows, the footer - so
 * the eye always finds the answer in the same place, and moving between the
 * board, a followed bus and their messages never rebuilds the page (a rebuild
 * costs seconds on the glasses and swallows taps meanwhile).
 */

/** Characters of a small row; the bold line and the pictures carry the rest. */
export const ROW_WIDTH = 50;

export type Picture =
  | { readonly kind: "badge"; readonly text: string }
  | { readonly kind: "bus"; readonly frame: number }
  | { readonly kind: "words"; readonly lines: readonly WordLine[] }
  | { readonly kind: "blank" };

export interface BigPage {
  readonly number: BigNumber | null;
  readonly picture: Picture;
  /** The bold line across the display. */
  readonly strip: string;
  readonly rows: readonly string[];
  readonly footer: string;
  readonly animated?: boolean;
}

const [BIG, PICTURE, STRIP_LEFT, STRIP_RIGHT] = BOARD_IMAGES;
const STRIP_FONT = 42;

function pictureImage(picture: Picture): SceneImage {
  const spec = PICTURE!;
  switch (picture.kind) {
    case "badge":
      return { id: spec.id, key: `badge:${picture.text}`, render: () => renderBadgePng(picture.text, spec.width, BIG_BAND) };
    case "bus":
      return { id: spec.id, key: `stop-${busKey(picture.frame)}`, render: () => renderBusPng(picture.frame, spec.width, BIG_BAND) };
    case "words":
      return {
        id: spec.id,
        key: `words:${picture.lines.map((line) => `${line.size}:${line.text}`).join("/")}`,
        render: () => renderWordsPng(picture.lines, spec.width, BIG_BAND, { margin: 8 }),
      };
    default:
      return { id: spec.id, key: "blank", render: () => renderWordsPng([], spec.width, BIG_BAND) };
  }
}

/** Puts a page of this shape together: the words and the four pictures. */
export function bigScene(page: BigPage): Scene {
  let halves: Promise<[Uint8Array, Uint8Array]> | null = null;
  const both = (): Promise<[Uint8Array, Uint8Array]> => (halves ??= renderStreetPngs(page.strip, BOARD_STRIP, STRIP_FONT));
  const rows = page.rows.slice(0, BOARD_ROWS).map((row) => fit(row, ROW_WIDTH));
  return {
    view: { header: "", body: rows, footer: page.footer },
    kind: "board",
    animated: page.animated ?? false,
    images: [
      { id: BIG!.id, key: `big:${numberKey(page.number)}`, render: () => renderNumberPng(page.number, BIG!.width, BIG_BAND) },
      pictureImage(page.picture),
      { id: STRIP_LEFT!.id, key: `strip:${page.strip}`, render: async () => (await both())[0] },
      { id: STRIP_RIGHT!.id, key: `strip:${page.strip}`, render: async () => (await both())[1] },
    ],
  };
}

/** Waiting, a failure, an empty board: the message bold, the hint in at most three rows. */
export function messageScene(title: string, hint: string, footer: string, big = "", animated = false): Scene {
  return bigScene({
    number: big ? { value: big, unit: "" } : null,
    picture: { kind: "bus", frame: -1 },
    strip: title,
    rows: hint ? wrap(hint, ROW_WIDTH) : [],
    footer,
    animated,
  });
}

/** The countdown as big digits: "jetzt", "4" + "min", "1h05". */
export function minutesNumber(when: Date, now: Date, locale: Locale): BigNumber {
  const minutes = minutesUntil(when, now);
  if (minutes <= 0) return { value: t(locale, "g.now"), unit: "" };
  if (minutes >= 60) return { value: waitText(when, now, locale), unit: "" };
  return { value: String(minutes), unit: "min" };
}

/**
 * A destination for a glance: "Hallein via Aigen ~ Puch ~ Oberalm" is where
 * it goes plus how; on the glasses only where it goes is kept.
 */
export function glanceHeadsign(headsign: string): string {
  const short = shortHeadsign(headsign);
  const cut = short.replace(/\s+(?:via|über)\s.*$/iu, "").replace(/\s*~.*$/u, "").trim();
  return cut || short;
}

/** How sure the time is, in words: "● pünktlich", "+3 min", "~ Fahrplan". */
export function sureness(departure: Departure | RideStop, locale: Locale): string {
  if (departure.cancelled) return t(locale, "g.cancelled");
  if (departure.source !== "realtime") return t(locale, "g.planned");
  const delay = delayMinutes(departure);
  if (delay === 0) return t(locale, "g.onTime");
  return t(locale, delay > 0 ? "g.late" : "g.early", { minutes: Math.abs(delay) });
}

/** "4 min · O-Bus 5 · Salzburg Hbf": one of the departures after the big one. */
export function laterRow(departure: Departure, now: Date, locale: Locale): string {
  const when = departure.cancelled ? t(locale, "g.cancelled") : waitText(departure.expected, now, locale);
  const head = `${when} · ${departure.line} · `;
  return `${head}${fit(glanceHeadsign(departure.headsign), Math.max(6, ROW_WIDTH - head.length))}`;
}

/** Departures soonest first, by the time the operator now expects, not the printed one. */
export function bySoonest(departures: readonly Departure[]): Departure[] {
  return [...departures].sort((a, b) => a.expected.getTime() - b.expected.getTime());
}

const metresText = (metres: number | null): string => metres === null
  ? ""
  : ` · ${metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`}`;

/**
 * The departure board: the selected departure big (minutes, line badge,
 * destination), the stop and how sure the time is in one row, the next two
 * departures below. Swiping moves the selection; a tap follows it.
 */
export function boardScene(
  stop: Stop, departures: readonly Departure[], metresAway: number | null, locale: Locale, selected: number, now: Date,
): Scene {
  const place = `${rideStopName(stop.name, 30)}${metresText(metresAway)}`;
  if (departures.length === 0) {
    return messageScene(t(locale, "g.emptyBoardTitle"), `${place} · ${t(locale, "g.emptyBoardHint")}`, t(locale, "g.footerEmptyBoard"), "--");
  }
  const index = Math.max(0, Math.min(selected, departures.length - 1));
  const chosen = departures[index]!;
  const track = chosen.track ? ` · ${t(locale, "g.track", { track: chosen.track })}` : "";
  const later = departures.slice(index + 1, index + 3).map((departure) => laterRow(departure, now, locale));
  const position = departures.length > 1 ? `${index + 1}/${departures.length} · ` : "";
  return bigScene({
    number: chosen.cancelled ? { value: "--", unit: "" } : minutesNumber(chosen.expected, now, locale),
    picture: { kind: "badge", text: chosen.line },
    strip: `${chosen.cancelled ? `${t(locale, "g.cancelled")}: ` : "→ "}${glanceHeadsign(chosen.headsign)}`,
    // What matters about the big one first; the stop's name is the part that gives way.
    rows: [`${track ? `${track.slice(3)} · ` : ""}${sureness(chosen, locale)} · ${place}`, ...later],
    footer: `${position}${t(locale, "g.footerBoard")}`,
  });
}

/** Right after the tap: the bus that was picked, while its stops are being fetched. */
export function followLoadingScene(departure: Departure, now: Date, locale: Locale): Scene {
  return bigScene({
    number: minutesNumber(departure.expected, now, locale),
    picture: { kind: "bus", frame: -1 },
    strip: `${departure.line} → ${glanceHeadsign(departure.headsign)}`,
    rows: [t(locale, "g.followLoading")],
    footer: t(locale, "g.footerFollow"),
  });
}

/**
 * Following a bus: before it arrives, the minutes until it leaves your stop
 * and where it is now (the bus drives into the picture in the last minute);
 * on board, the minutes to the next stop and its name in bold.
 */
export function followScene(departure: Departure, follow: Follow, now: Date, locale: Locale, beat: number): Scene {
  // The board's words for the bus: a trip's own direction text is often a
  // whole itinerary ("Salzburg via Strobl ~ St.Gilgen ~ Fuschl").
  const title = `${departure.line} → ${glanceHeadsign(departure.headsign)}`;
  if (follow.phase === "coming") {
    const minutes = minutesUntil(follow.departs, now);
    const arriving = minutes <= 0;
    const where = follow.busAt && follow.stopsAway > 0
      ? t(locale, "g.busAt", { stop: rideStopName(follow.busAt.stop.name, 26), count: follow.stopsAway })
      : t(locale, "g.busHere");
    return bigScene({
      number: minutesNumber(follow.departs, now, locale),
      picture: { kind: "bus", frame: arriving ? busFrame(beat) : -1 },
      strip: title,
      rows: [
        `${clock(follow.departs)} · ${sureness(follow.boarding, locale)} · ${rideStopName(follow.boarding.stop.name, 30)}`,
        where,
      ],
      footer: t(locale, "g.footerFollow"),
      animated: arriving,
    });
  }
  if (follow.phase === "finished") {
    return bigScene({
      number: null,
      picture: { kind: "words", lines: [{ text: t(locale, "g.rideOverTitle"), size: 40 }] },
      strip: rideStopName(follow.terminus.stop.name),
      rows: [t(locale, "g.rideOver")],
      footer: t(locale, "g.footerFollow"),
    });
  }

  const { progress, terminus } = follow;
  const next = progress.next;
  const number: BigNumber = progress.arriving || minutesUntil(next.expected, now) <= 0
    ? { value: t(locale, "g.now"), unit: "" }
    : minutesNumber(next.expected, now, locale);
  const then = progress.upcoming[0];
  const left = progress.upcoming.length + 1;
  return bigScene({
    number: next.cancelled ? { value: "--", unit: "" } : number,
    picture: { kind: "words", lines: [{ text: t(locale, "g.bigNext1"), size: 40 }, { text: t(locale, "g.bigNext2"), size: 40 }] },
    strip: next.cancelled ? `${t(locale, "g.cancelled")}: ${rideStopName(next.stop.name)}` : rideStopName(next.stop.name),
    rows: [
      ...(then ? [t(locale, "g.thenStop", { stop: rideStopName(then.stop.name, 28), when: waitText(then.expected, now, locale) })] : []),
      t(locale, left === 1 ? "g.terminusOne" : "g.terminusMany", { stop: rideStopName(terminus.stop.name, 24), time: clock(terminus.expected), count: left }),
    ],
    footer: `${t(locale, progress.basis === "gps" ? "g.basisGps" : "g.basisClock")} · ${t(locale, "g.footerFollow")}`,
  });
}

import type { Locale } from "../i18n";
import { t } from "../messages";
import type { Departure, RideStop } from "../transit/types";
import { delayMinutes, minutesUntil } from "../transit/types";
import { BIG_BAND, BOARD_IMAGES, BOARD_ROWS, BOARD_STRIP } from "./layout";
import { numberKey, renderNumberPng, type BigNumber } from "./turncard";
import { renderBadgePng, renderWordsPng, type WordLine } from "./words";
import { renderStreetPngs } from "./street";
import { busKey, renderBusPng } from "./bus";
import { fit, shortHeadsign, wrap } from "./view";
import type { Scene, SceneImage } from "../route/scene";
import { waitText } from "../route/journey";

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

/** Departures soonest first, by the time the operator now expects, not the printed one. */
export function bySoonest(departures: readonly Departure[]): Departure[] {
  return [...departures].sort((a, b) => a.expected.getTime() - b.expected.getTime());
}

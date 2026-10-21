/**
 * Footer builder of the Quietglass Interaction Standard (QIS v1): the gestures
 * that do something on a screen, always in the order Tippen -> Wischen -> 2x,
 * ending in `2× = zurück` (subpage) or `2× = Ende` (root). One helper so no
 * footer is ever hand-built and the order cannot drift.
 *
 * There is deliberately no "Halten/Hold": on the real glasses a hold on the
 * temple touchpad opens the system menu and never reaches the app (only the
 * optional R1 ring delivers it, measured 21.10.2026). A footer may only offer
 * gestures that arrive from the temple: tap, swipe, double tap.
 */
import type { Locale } from "./i18n";
import { t } from "./messages";

/** Characters one footer/header row holds (the app's row width, same as the route pages). */
export const ROW_WIDTH = 50;

export interface FooterParts {
  /** What a single tap does ("folgen"), already translated. */
  readonly tap?: string;
  /** What a swipe does ("wählen"). Dropped first when the row would be too wide. */
  readonly swipe?: string;
}

export type FooterEnd = "back" | "exit";

const WORDS = {
  de: { tap: "Tippen", swipe: "Wischen", back: "zurück", exit: "Ende" },
  en: { tap: "Tap", swipe: "Swipe", back: "back", exit: "exit" },
} as const;

/**
 * "Tippen = folgen · Wischen = wählen · 2× = Ende"; `lead` (a page counter,
 * the source of the times) stands in front. Too wide for the row: the swipe
 * goes first, then the lead. The 2× never goes.
 */
export function footer(locale: Locale, parts: FooterParts, end: FooterEnd = "back", lead = "", limit = ROW_WIDTH): string {
  const w = WORDS[locale];
  const tail = `2× = ${end === "exit" ? w.exit : w.back}`;
  const build = (p: FooterParts, withLead: boolean): string => [
    ...(withLead && lead !== "" ? [lead] : []),
    ...(p.tap === undefined ? [] : [`${w.tap} = ${p.tap}`]),
    ...(p.swipe === undefined ? [] : [`${w.swipe} = ${p.swipe}`]),
    tail,
  ].join(" · ");
  const noSwipe: FooterParts = parts.tap === undefined ? {} : { tap: parts.tap };
  const candidates: Array<[FooterParts, boolean]> = [[parts, true], [noSwipe, true], [noSwipe, false]];
  for (const [candidate, withLead] of candidates) {
    const row = build(candidate, withLead);
    if (row.length <= limit) return row;
  }
  // Still too wide: the tap label gives way, the 2× stays.
  const head = `${w.tap} = `;
  const room = Math.max(1, limit - head.length - ` · ${tail}`.length);
  const label = parts.tap ?? "";
  return `${head}${label.length <= room ? label : label.slice(0, room - 1).trimEnd() + "…"} · ${tail}`;
}

/**
 * The armed row: "Nochmal tippen = beenden · Wischen/2× = abbrechen". A long
 * action keeps the full wording when it fits, else the cancel hint shrinks to
 * "2× = abbrechen" before the action is cut.
 */
export function armedFooter(locale: Locale, label: string): string {
  const head = locale === "de" ? "Nochmal tippen = " : "Tap again = ";
  const tails = locale === "de" ? [" · Wischen/2× = abbrechen", " · 2× = abbrechen"] : [" · Swipe/2× = cancel", " · 2× = cancel"];
  for (const tail of tails) {
    if ((head + label + tail).length <= ROW_WIDTH) return head + label + tail;
  }
  const tail = tails[1] ?? "";
  const room = Math.max(4, ROW_WIDTH - head.length - tail.length);
  return head + (label.length <= room ? label : label.slice(0, room - 1).trimEnd() + "…") + tail;
}

/** An action word from the message table ("q.follow" -> "folgen"). */
export const word = (locale: Locale, key: string): string => t(locale, `q.${key}`);

/** Footer from message-table action words: `ft(locale, "exit", { tap: "follow", swipe: "select" }, "1/5")`. */
export function ft(
  locale: Locale, end: FooterEnd, keys: { readonly tap?: string; readonly swipe?: string } = {}, lead = "",
): string {
  const parts: { tap?: string; swipe?: string } = {};
  if (keys.tap !== undefined) parts.tap = word(locale, keys.tap);
  if (keys.swipe !== undefined) parts.swipe = word(locale, keys.swipe);
  return footer(locale, parts, end, lead);
}

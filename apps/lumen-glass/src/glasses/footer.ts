/**
 * Footer builder of the Quietglass Interaction Standard (QIS v1): the gestures
 * that do something on a screen, always in the order Tippen -> Wischen ->
 * Halten -> 2x, ending in `2× = zurück` (subpage) or `2× = Ende` (root).
 * One helper so no footer is ever hand-built and the order cannot drift.
 */
import type { Locale } from "../i18n";

/** Characters the footer holds on one line in the G2's proportional font. */
export const ROW_WIDTH = 56;

export interface FooterParts {
  readonly tap?: string;
  /** Dropped first when the row would be too wide. */
  readonly swipe?: string;
  /** Dropped second. */
  readonly hold?: string;
}

export type FooterEnd = "back" | "exit";

export const GESTURE_WORDS: Record<Locale, { tap: string; swipe: string; hold: string; back: string; exit: string }> = {
  de: { tap: "Tippen", swipe: "Wischen", hold: "Halten", back: "zurück", exit: "Ende" },
  en: { tap: "Tap", swipe: "Swipe", hold: "Hold", back: "back", exit: "exit" },
};

/** Cuts a row to the display width, marking the cut with an ellipsis. */
export function fit(text: string, width = ROW_WIDTH): string {
  const flat = text.replace(/[\r\n\t]+/g, " ");
  return flat.length <= width ? flat : flat.slice(0, Math.max(0, width - 1)).trimEnd() + "…";
}

/**
 * "Tippen = Foto · Halten = Quest · 2× = Ende". `lead` (optional text) stands in front
 * and goes first when the row is too wide, then the swipe part, then the hold; the 2× part never goes.
 */
export function footer(locale: Locale, parts: FooterParts, end: FooterEnd = "back", lead = ""): string {
  const w = GESTURE_WORDS[locale];
  const tail = `2× = ${end === "exit" ? w.exit : w.back}`;
  const build = (p: FooterParts, front: string): string => [
    ...(front === "" ? [] : [front]),
    ...(p.tap === undefined ? [] : [`${w.tap} = ${p.tap}`]),
    ...(p.swipe === undefined ? [] : [`${w.swipe} = ${p.swipe}`]),
    ...(p.hold === undefined ? [] : [`${w.hold} = ${p.hold}`]),
    tail,
  ].join(" · ");
  const noSwipe: FooterParts = { ...(parts.tap === undefined ? {} : { tap: parts.tap }), ...(parts.hold === undefined ? {} : { hold: parts.hold }) };
  const tapOnly: FooterParts = parts.tap === undefined ? {} : { tap: parts.tap };
  const candidates: readonly (readonly [FooterParts, string])[] = [[parts, lead], [parts, ""], [noSwipe, lead], [noSwipe, ""], [tapOnly, lead], [tapOnly, ""]];
  for (const [candidate, front] of candidates) {
    const row = build(candidate, front);
    if (row.length <= ROW_WIDTH) return row;
  }
  return fit(build(tapOnly, ""));
}

/**
 * The armed row: "Nochmal tippen = auslassen · Wischen/2× = abbrechen". A long action keeps the
 * full wording when it fits, else the cancel hint shrinks to "2× = abbrechen" before the action is cut.
 */
export function armedFooter(locale: Locale, label: string): string {
  const head = locale === "de" ? "Nochmal tippen = " : "Tap again = ";
  const tails = locale === "de" ? [" · Wischen/2× = abbrechen", " · 2× = abbrechen"] : [" · Swipe/2× = cancel", " · 2× = cancel"];
  for (const tail of tails) {
    if ((head + label + tail).length <= ROW_WIDTH) return head + label + tail;
  }
  const tail = tails[1] ?? "";
  return head + fit(label, Math.max(4, ROW_WIDTH - head.length - tail.length)) + tail;
}

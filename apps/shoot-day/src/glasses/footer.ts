/**
 * Footer builder of the Quietglass Interaction Standard (QIS v1): the gestures
 * that do something on a screen, always in the order Tippen -> Wischen ->
 * Halten -> 2x, ending in `2× = zurück` (subpage) or `2× = Ende` (root).
 * One helper so no footer is ever hand-built and the order cannot drift.
 */
import type { Locale } from "../i18n";
import { fit, ROW_WIDTH } from "./screen";

export interface FooterParts {
  /** What a single tap does ("öffnen"), already translated. */
  readonly tap?: string;
  /** What a swipe does ("wählen"). Dropped first when the row would be too wide. */
  readonly swipe?: string;
  /** What a hold does ("sprechen"). Dropped second. */
  readonly hold?: string;
}

export type FooterEnd = "back" | "exit" | "none";

const WORDS = {
  de: { tap: "Tippen", swipe: "Wischen", hold: "Halten", back: "zurück", exit: "Ende" },
  en: { tap: "Tap", swipe: "Swipe", hold: "Hold", back: "back", exit: "exit" },
} as const;

/** "Tippen = öffnen · Wischen = wählen · 2× = Ende"; `lead` (e.g. a page indicator) stands in front. */
export function footer(locale: Locale, parts: FooterParts, end: FooterEnd = "back", lead = ""): string {
  const w = WORDS[locale];
  const tail = end === "none" ? [] : [`2× = ${end === "exit" ? w.exit : w.back}`];
  const build = (p: FooterParts): string => [
    ...(lead === "" ? [] : [lead]),
    ...(p.tap === undefined ? [] : [`${w.tap} = ${p.tap}`]),
    ...(p.swipe === undefined ? [] : [`${w.swipe} = ${p.swipe}`]),
    ...(p.hold === undefined ? [] : [`${w.hold} = ${p.hold}`]),
    ...tail,
  ].join(" · ");
  // Too wide for the row: the swipe goes first (it is the obvious one), then the hold.
  const noSwipe: FooterParts = { ...(parts.tap === undefined ? {} : { tap: parts.tap }), ...(parts.hold === undefined ? {} : { hold: parts.hold }) };
  const tapOnly: FooterParts = parts.tap === undefined ? {} : { tap: parts.tap };
  for (const candidate of [parts, noSwipe, tapOnly]) {
    const row = build(candidate);
    if (row.length <= ROW_WIDTH) return row;
  }
  // Even the tap alone does not fit: shorten its label, the 2× part stays.
  if (parts.tap === undefined) return fit(build(tapOnly));
  const fixed = build({ tap: "" }).length;
  return build({ tap: fit(parts.tap, Math.max(1, ROW_WIDTH - fixed)) });
}

/**
 * The armed row: "Nochmal tippen = stoppen · Wischen/2× = abbrechen". A long action keeps the
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

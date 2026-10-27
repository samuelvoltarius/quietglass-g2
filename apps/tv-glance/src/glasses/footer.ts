/**
 * Footer builder of the Quietglass Interaction Standard (QIS v1): the gestures
 * that do something on a screen, always in the order Tippen -> Wischen -> 2x,
 * ending in `2× = zurück` (subpage) or `2× = Ende` (root).
 *
 * There is deliberately no "Halten/Hold": a hold from the temple never reaches
 * the app (it opens the system menu; only the R1 ring delivers it), so no
 * footer may offer it.
 */
import type { Locale } from "../i18n";
import { fit, ROW_WIDTH } from "./screen";

export interface FooterParts {
  /** What a single tap does ("öffnen"), already translated. */
  readonly tap?: string;
  /** What a swipe does ("wählen"). Dropped first when the row would be too wide. */
  readonly swipe?: string;
}

export type FooterEnd = "back" | "exit" | "none";

const WORDS = {
  de: { tap: "Tippen", swipe: "Wischen", back: "zurück", exit: "Ende" },
  en: { tap: "Tap", swipe: "Swipe", back: "back", exit: "exit" },
} as const;

/** "Tippen = öffnen · Wischen = wählen · 2× = Ende"; `lead` (e.g. a page indicator) stands in front. */
export function footer(locale: Locale, parts: FooterParts, end: FooterEnd = "back", lead = ""): string {
  const w = WORDS[locale];
  const tail = end === "none" ? [] : [`2× = ${end === "exit" ? w.exit : w.back}`];
  const build = (p: FooterParts): string => [
    ...(lead === "" ? [] : [lead]),
    ...(p.tap === undefined ? [] : [`${w.tap} = ${p.tap}`]),
    ...(p.swipe === undefined ? [] : [`${w.swipe} = ${p.swipe}`]),
    ...tail,
  ].join(" · ");
  // Too wide for the row: the swipe goes first (it is the obvious one).
  const tapOnly: FooterParts = parts.tap === undefined ? {} : { tap: parts.tap };
  for (const candidate of [parts, tapOnly]) {
    const row = build(candidate);
    if (row.length <= ROW_WIDTH) return row;
  }
  return fit(build(tapOnly));
}

/**
 * The armed row: "Nochmal tippen = ausschalten · Wischen/2× = abbrechen". A long action keeps the
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

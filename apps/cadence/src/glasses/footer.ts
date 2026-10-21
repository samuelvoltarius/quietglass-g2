/**
 * Footer builder of the Quietglass Interaction Standard (QIS v1): the gestures
 * that do something on a screen, always in the order Tippen -> Wischen -> 2x,
 * ending in `2× = zurück` (subpage) or `2× = Ende` (root).
 * One helper so no footer is ever hand-built and the order cannot drift.
 * There is deliberately no hold part: on the temple pad a hold opens the
 * system menu and never reaches the app (only the optional R1 ring delivers
 * it, step log 21.10.2026), so the glasses never offer one.
 */
import type { Locale } from "../i18n";

/** Characters one footer row holds on the display. */
export const ROW_WIDTH = 56;

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

function cut(text: string, width = ROW_WIDTH): string {
  const flat = text.replace(/[\r\n\t]+/g, " ");
  if (flat.length <= width) return flat;
  return flat.slice(0, Math.max(0, width - 1)).trimEnd() + "…";
}

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
  // Too wide for the row: the swipe goes first (it is the obvious one). The 2× part always stays.
  const tapOnly: FooterParts = parts.tap === undefined ? {} : { tap: parts.tap };
  for (const candidate of [parts, tapOnly]) {
    const row = build(candidate);
    if (row.length <= ROW_WIDTH) return row;
  }
  return cut(build(tapOnly));
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
  return head + cut(label, Math.max(4, ROW_WIDTH - head.length - tail.length)) + tail;
}

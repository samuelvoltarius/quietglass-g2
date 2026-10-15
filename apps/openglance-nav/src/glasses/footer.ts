/**
 * Footer builder of the Quietglass Interaction Standard (QIS v1): the gestures
 * that do something on a screen, always in the order Tippen -> Wischen ->
 * Halten -> 2×, ending in `2× = zurück` (subpage) or `2× = Ende` (root).
 * One helper so no footer is ever hand-built and the order cannot drift.
 */
import { tr, type Locale } from "../i18n";
import { messages } from "../messages";

/** Characters one footer row holds (same budget as `ROW_WIDTH` in view.ts). */
export const FOOTER_WIDTH = 56;

export interface FooterParts {
  /** What a single tap does ("los"), already translated. */
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

function cut(text: string, width = FOOTER_WIDTH): string {
  const flat = text.replace(/[\r\n\t]+/g, " ");
  return flat.length <= width ? flat : flat.slice(0, Math.max(0, width - 1)).trimEnd() + "…";
}

/**
 * "Tippen = los · Wischen = wählen · 2× = Ende"; `lead` (a state such as
 * "Gemerkt ●") stands in front. Too wide for the row: the swipe goes first,
 * then the hold. The `2×` part never goes.
 */
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
  const noSwipe: FooterParts = { ...(parts.tap === undefined ? {} : { tap: parts.tap }), ...(parts.hold === undefined ? {} : { hold: parts.hold }) };
  const tapOnly: FooterParts = parts.tap === undefined ? {} : { tap: parts.tap };
  for (const candidate of [parts, noSwipe, tapOnly]) {
    const row = build(candidate);
    if (row.length <= FOOTER_WIDTH) return row;
  }
  return cut(build(tapOnly));
}

/**
 * The armed row: "Nochmal tippen = stoppen · Wischen/2× = abbrechen". A long
 * action keeps the full wording when it fits, else the cancel hint shrinks to
 * "2× = abbrechen" before the action is cut.
 */
export function armedFooter(locale: Locale, label: string): string {
  const head = locale === "de" ? "Nochmal tippen = " : "Tap again = ";
  const tails = locale === "de" ? [" · Wischen/2× = abbrechen", " · 2× = abbrechen"] : [" · Swipe/2× = cancel", " · 2× = cancel"];
  for (const tail of tails) {
    if ((head + label + tail).length <= FOOTER_WIDTH) return head + label + tail;
  }
  const tail = tails[1] ?? "";
  return head + cut(label, Math.max(4, FOOTER_WIDTH - head.length - tail.length)) + tail;
}

/** An action word from the message table (`w.go` -> "los"). */
export const word = (locale: Locale, key: string): string => tr(messages, locale, `w.${key}`);

/** Footer from message-table action words: `ft(locale, "exit", { tap: "go", hold: "speak" })`. */
export function ft(
  locale: Locale, end: FooterEnd, keys: { readonly tap?: string; readonly swipe?: string; readonly hold?: string } = {}, lead = "",
): string {
  const parts: { tap?: string; swipe?: string; hold?: string } = {};
  if (keys.tap !== undefined) parts.tap = word(locale, keys.tap);
  if (keys.swipe !== undefined) parts.swipe = word(locale, keys.swipe);
  if (keys.hold !== undefined) parts.hold = word(locale, keys.hold);
  return footer(locale, parts, end, lead);
}

/** The armed stop row. */
export const armedStopFooter = (locale: Locale): string => armedFooter(locale, word(locale, "stop"));

import type { Locale } from "../i18n";
import { t } from "../messages";
import { LINE_COLS } from "./fit";

/**
 * The footer line of every glasses screen (Quietglass interaction standard, QIS v1).
 *
 * Only the gestures that do something on the screen, always in the order
 * Tippen -> Wischen -> 2x, ending in `2x = zurueck` (a subpage) or
 * `2x = Ende` (the root). Never build a footer by hand.
 * There is deliberately no hold part: on the temple pad a hold opens the system
 * menu and never reaches the app (only the optional R1 ring delivers it, step
 * log 21.10.2026), so no glasses line may offer one.
 */

/** Characters one footer row holds (same limit as every other row). */
export const FOOTER_WIDTH = LINE_COLS;

/** Between two footer parts. */
export const FOOTER_SEPARATOR = " · ";

export interface FooterParts {
  /** What a single tap does, already in the chosen language. */
  readonly tap?: string;
  /** What a swipe does (it never changes data). */
  readonly swipe?: string;
}

/**
 * `end` is the meaning of the double tap. When the line would not fit, the
 * swipe hint goes first - a swipe is the gesture people try on their own.
 */
export function footer(locale: Locale, parts: FooterParts, end: "back" | "exit", width: number = FOOTER_WIDTH): string {
  const part = (key: string, text: string | undefined): string[] => (text ? [`${t(locale, key)} = ${text}`] : []);
  const last = `${t(locale, "g.f.double")} = ${t(locale, end === "back" ? "g.f.back" : "g.f.exit")}`;
  const build = (withSwipe: boolean): string => [
    ...part("g.f.tap", parts.tap),
    ...(withSwipe ? part("g.f.swipe", parts.swipe) : []),
    last,
  ].join(FOOTER_SEPARATOR);
  const full = build(true);
  return full.length <= width ? full : build(false);
}

/** The armed state of a risky action: the second tap carries it out, anything else cancels. */
export function armedFooter(locale: Locale, action: string): string {
  return t(locale, "g.f.armed", { action });
}

/**
 * A footer that starts with a lead (e.g. the recording countdown): the lead takes its room first,
 * the gestures get the rest of the row. Never concatenate a footer by hand.
 */
export function leadFooter(locale: Locale, lead: string, parts: FooterParts, end: "back" | "exit"): string {
  const prefix = `${lead}${FOOTER_SEPARATOR}`;
  return prefix + footer(locale, parts, end, FOOTER_WIDTH - prefix.length);
}

/** The armed state of a risky action chosen in the side menu: the same menu entry again confirms. */
export function armedMenuFooter(locale: Locale, action: string): string {
  return t(locale, "g.f.armedMenu", { action });
}

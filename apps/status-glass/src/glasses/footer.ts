import type { Locale } from "../i18n";
import { t } from "../messages";

/**
 * The footer line of every glasses screen (Quietglass interaction standard, QIS v1).
 *
 * Only the gestures that do something on the screen, always in the order
 * Tippen -> Wischen -> Halten -> 2x, ending in `2x = zurueck` (a subpage) or
 * `2x = Ende` (the root). Never build a footer by hand.
 */

/** Characters one footer row holds (same limit as every other row). */
export const FOOTER_WIDTH = 56;

/** Between two footer parts. */
export const FOOTER_SEPARATOR = " · ";

export interface FooterParts {
  /** What a single tap does, already in the chosen language. */
  readonly tap?: string;
  /** What a swipe does (it only ever moves). */
  readonly swipe?: string;
  /** What holding does. */
  readonly hold?: string;
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
    ...part("g.f.hold", parts.hold),
    last,
  ].join(FOOTER_SEPARATOR);
  const full = build(true);
  return full.length <= width ? full : build(false);
}

/** The armed state of a risky action: the second tap carries it out, anything else cancels. */
export function armedFooter(locale: Locale, action: string): string {
  return t(locale, "g.f.armed", { action });
}

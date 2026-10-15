/**
 * Footer builder of the Quietglass Interaction Standard (QIS v1): the gestures
 * that do something on a screen, always in the order Tippen -> Wischen ->
 * Halten -> 2x, ending in `2× = zurück` (subpage) or `2× = Ende` (root).
 * One helper so no footer is ever hand-built and the order cannot drift.
 */
import type { Locale } from "../i18n";

/** Characters one row holds in the G2's proportional font. */
export const ROW_WIDTH = 56;

export interface FooterParts {
  readonly tap?: string;
  /** Dropped first when the row would be too wide. */
  readonly swipe?: string;
  readonly hold?: string;
}

export type FooterEnd = "back" | "exit";

export const GESTURE_WORDS: Record<Locale, { tap: string; swipe: string; hold: string; back: string; exit: string }> = {
  de: { tap: "Tippen", swipe: "Wischen", hold: "Halten", back: "zurück", exit: "Ende" },
  en: { tap: "Tap", swipe: "Swipe", hold: "Hold", back: "back", exit: "exit" },
  fr: { tap: "Toucher", swipe: "Glisser", hold: "Maintenir", back: "retour", exit: "fin" },
  es: { tap: "Tocar", swipe: "Deslizar", hold: "Mantener", back: "atrás", exit: "salir" },
  it: { tap: "Tocca", swipe: "Scorri", hold: "Tieni", back: "indietro", exit: "fine" },
};

/** Cuts a row to the display width, marking the cut with an ellipsis. */
export function fit(text: string, width = ROW_WIDTH): string {
  const flat = text.replace(/[\r\n\t]+/g, " ");
  return flat.length <= width ? flat : flat.slice(0, Math.max(0, width - 1)).trimEnd() + "…";
}

/** "Tippen = neu · Halten = Hilfe · 2× = Ende". The swipe part goes first when the row is too wide, then the hold. */
export function footer(locale: Locale, parts: FooterParts, end: FooterEnd = "back"): string {
  const w = GESTURE_WORDS[locale];
  const tail = `2× = ${end === "exit" ? w.exit : w.back}`;
  const build = (p: FooterParts): string => [
    ...(p.tap === undefined ? [] : [`${w.tap} = ${p.tap}`]),
    ...(p.swipe === undefined ? [] : [`${w.swipe} = ${p.swipe}`]),
    ...(p.hold === undefined ? [] : [`${w.hold} = ${p.hold}`]),
    tail,
  ].join(" · ");
  const noSwipe: FooterParts = { ...(parts.tap === undefined ? {} : { tap: parts.tap }), ...(parts.hold === undefined ? {} : { hold: parts.hold }) };
  const tapOnly: FooterParts = parts.tap === undefined ? {} : { tap: parts.tap };
  for (const candidate of [parts, noSwipe, tapOnly]) {
    const row = build(candidate);
    if (row.length <= ROW_WIDTH) return row;
  }
  return fit(build(tapOnly));
}

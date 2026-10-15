/**
 * Footer builder of the Quietglass Interaction Standard (QIS v1): the gestures
 * that do something on a screen, always in the order Tippen -> Wischen ->
 * Halten -> 2x, ending in `2× = zurück` (help) or `2× = Ende` (every view:
 * a double tap there asks to leave the app). One helper so no footer is ever
 * hand-built and the order cannot drift. RainLens has no destructive gesture,
 * so there is no armed footer.
 */
import { fit } from "../rain/model";
import type { Locale } from "../i18n";

/** Characters one footer row holds (the full 576 px). */
export const ROW_WIDTH = 56;

export interface FooterParts {
  /** What a single tap does ("neu"), already translated. */
  readonly tap?: string;
  /** What a swipe does ("Ansicht"). Dropped first when the row would be too wide. */
  readonly swipe?: string;
  /** What a hold does ("Hilfe"). Dropped second. */
  readonly hold?: string;
}

export type FooterEnd = "back" | "exit";

const WORDS: Record<Locale, { tap: string; swipe: string; hold: string; back: string; exit: string }> = {
  de: { tap: "Tippen", swipe: "Wischen", hold: "Halten", back: "zurück", exit: "Ende" },
  en: { tap: "Tap", swipe: "Swipe", hold: "Hold", back: "back", exit: "exit" },
  fr: { tap: "Tap", swipe: "Swipe", hold: "Maintenir", back: "retour", exit: "fermer" },
  es: { tap: "Tap", swipe: "Deslizar", hold: "Mantener", back: "atrás", exit: "cerrar" },
  it: { tap: "Tap", swipe: "Scorri", hold: "Tieni", back: "indietro", exit: "chiudi" },
};

/**
 * "Tippen = neu · Halten = Hilfe · 2× = Ende". `lead` (a credit, a page mark) stands in front
 * and is kept; too wide: the swipe goes first (it is the obvious one), then the hold. 2× never goes.
 */
export function footer(locale: Locale, parts: FooterParts, end: FooterEnd = "exit", lead = ""): string {
  const w = WORDS[locale] ?? WORDS.en;
  const tail = `2× = ${end === "exit" ? w.exit : w.back}`;
  const build = (p: FooterParts): string => [
    ...(lead === "" ? [] : [lead]),
    ...(p.tap === undefined ? [] : [`${w.tap} = ${p.tap}`]),
    ...(p.swipe === undefined ? [] : [`${w.swipe} = ${p.swipe}`]),
    ...(p.hold === undefined ? [] : [`${w.hold} = ${p.hold}`]),
    tail,
  ].join(" · ");
  const noSwipe: FooterParts = { ...(parts.tap === undefined ? {} : { tap: parts.tap }), ...(parts.hold === undefined ? {} : { hold: parts.hold }) };
  const tapOnly: FooterParts = parts.tap === undefined ? {} : { tap: parts.tap };
  for (const candidate of [parts, noSwipe, tapOnly]) {
    const row = build(candidate);
    if (Array.from(row).length <= ROW_WIDTH) return row;
  }
  return fit(build(tapOnly), ROW_WIDTH);
}

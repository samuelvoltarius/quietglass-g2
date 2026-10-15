/**
 * Footer builder of the Quietglass Interaction Standard (QIS v1): the gestures
 * that do something on a screen, always in the order Tippen -> Wischen ->
 * Halten -> 2x, ending in `2× = zurück` (subpage) or `2× = Ende` (root).
 * One helper so no footer is ever hand-built and the order cannot drift.
 */
import type { Locale } from "../i18n";

/** Characters one footer/header row holds (proportional font, 576 px). */
export const ROW_WIDTH = 46;

export interface FooterParts {
  /** What a single tap does ("neu laden"), already translated. */
  readonly tap?: string;
  /** What a swipe does ("wählen"). Dropped first when the row would be too wide. */
  readonly swipe?: string;
  /** What a hold does. Dropped second. */
  readonly hold?: string;
}

export type FooterEnd = "back" | "exit";

const WORDS: Record<Locale, { tap: string; swipe: string; hold: string; back: string; exit: string }> = {
  de: { tap: "Tippen", swipe: "Wischen", hold: "Halten", back: "zurück", exit: "Ende" },
  en: { tap: "Tap", swipe: "Swipe", hold: "Hold", back: "back", exit: "exit" },
  fr: { tap: "Taper", swipe: "Glisser", hold: "Maintenir", back: "retour", exit: "fin" },
  es: { tap: "Tocar", swipe: "Deslizar", hold: "Mantener", back: "atrás", exit: "salir" },
  it: { tap: "Tocca", swipe: "Scorri", hold: "Tieni", back: "indietro", exit: "esci" },
};

/** "Tippen = neu · Wischen = wählen · 2× = Ende". Too wide: the swipe goes first, then the hold; the 2× never. */
export function footer(locale: Locale, parts: FooterParts, end: FooterEnd = "back"): string {
  const w = WORDS[locale];
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
  // Still too wide: the tap label gives way, the 2× stays.
  const head = `${w.tap} = `;
  const room = Math.max(1, ROW_WIDTH - head.length - ` · ${tail}`.length);
  const label = parts.tap ?? "";
  return `${head}${label.length <= room ? label : label.slice(0, room - 1).trimEnd() + "…"} · ${tail}`;
}

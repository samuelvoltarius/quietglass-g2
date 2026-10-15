import type { Locale } from "../i18n";
import { t } from "../messages";

/** What each gesture does on one screen; a gesture without an entry is not shown. */
export interface FooterParts {
  /** Text after `Tippen = `. */
  readonly tap?: string;
  /** Text after `Wischen = `; `true` = the bare word (a swipe that only moves). */
  readonly swipe?: string | true;
  /** Text after `Halten = `. */
  readonly hold?: string;
  /** A plain leading hint (demo mode), before the gestures. */
  readonly hint?: string;
}

/**
 * The footer row, always in the QIS order Tippen → Wischen → Halten → 2×,
 * ending in `2× = zurück` (a subpage) or `2× = Ende` (the root). When the row
 * would not fit `width`, the swipe hint is dropped first: the cursor or the
 * pages show what a swipe does.
 */
export function footer(locale: Locale, parts: FooterParts, end: "back" | "exit", width = 56): string {
  const build = (withSwipe: boolean): string => {
    const out: string[] = [];
    if (parts.hint) out.push(parts.hint);
    if (parts.tap) out.push(`${t(locale, "g.k.tap")} = ${parts.tap}`);
    if (withSwipe && parts.swipe) out.push(parts.swipe === true ? t(locale, "g.k.swipe") : `${t(locale, "g.k.swipe")} = ${parts.swipe}`);
    if (parts.hold) out.push(`${t(locale, "g.k.hold")} = ${parts.hold}`);
    out.push(`2× = ${t(locale, end === "back" ? "g.k.back" : "g.k.exit")}`);
    return out.join(" · ");
  };
  const full = build(true);
  return full.length <= width ? full : build(false);
}

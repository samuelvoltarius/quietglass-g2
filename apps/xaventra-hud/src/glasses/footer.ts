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
  /** Text after `Loslassen = ` (the end of a hold that is recording). */
  readonly release?: string;
}

/**
 * How the row ends: `2× = zurück` (a subpage), `2× = Ende` (the root),
 * `2× = abbrechen` (a running recording) or `2× = verwerfen` (recognised text not sent yet).
 */
export type FooterEnd = "back" | "exit" | "cancel" | "discard";

const END_KEY: Readonly<Record<FooterEnd, string>> = {
  back: "g.k.back", exit: "g.k.exit", cancel: "g.k.cancel", discard: "g.k.discard",
};

/**
 * The footer row, always in the QIS order Tippen → Wischen → Halten (Loslassen) → 2×,
 * ending in what 2× does on this screen. Every footer goes through here, none is hand-built.
 */
export function footer(locale: Locale, parts: FooterParts, end: FooterEnd): string {
  const out: string[] = [];
  if (parts.tap) out.push(`${t(locale, "g.k.tap")} = ${parts.tap}`);
  if (parts.swipe) out.push(parts.swipe === true ? t(locale, "g.k.swipe") : `${t(locale, "g.k.swipe")} = ${parts.swipe}`);
  if (parts.hold) out.push(`${t(locale, "g.k.hold")} = ${parts.hold}`);
  if (parts.release) out.push(`${t(locale, "g.k.release")} = ${parts.release}`);
  out.push(`2× = ${t(locale, END_KEY[end])}`);
  return out.join(" · ");
}

/** The armed row (QIS §2): `Nochmal tippen = Ja senden · Wischen/2× = abbrechen`. */
export function armedFooter(locale: Locale, label: string): string {
  return `${t(locale, "g.k.again")} = ${label} · ${t(locale, "g.k.swipe")}/2× = ${t(locale, "g.k.cancel")}`;
}

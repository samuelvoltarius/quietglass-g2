import { AUTO, sameLanguage } from "../text/languages";
import type { TranslationRequest } from "../translate/provider";
import { lineOwner, type OwnerContext } from "./replies";
import type { TranscriptEntry } from "./transcript";
import { OWNER_SPEAKER } from "../stt/voice";

/**
 * Eigene Sätze übersetzen (0.5.0). Babel normally translates what the OTHER
 * person says (spoken language → "Übersetzen in", e.g. Russian → German).
 * This is the other direction: the user's own lines, in their own language
 * (= the translation target), are translated INTO the conversation language,
 * so the user can read them out ("→ Как дела?").
 */

export interface OwnContext extends OwnerContext {
  /** The conversation's foreign language; null = not known yet. */
  readonly foreign: string | null;
}

/**
 * A final line to translate automatically: the user's own (speaker letter, or
 * with speakers off / "auto" the user's language) and not already in the
 * foreign language.
 */
export function isOwnLine(entry: TranscriptEntry, ctx: OwnContext): boolean {
  if (!ctx.foreign || !ctx.ownLanguage || sameLanguage(ctx.foreign, ctx.ownLanguage)) return false;
  if (lineOwner(entry, ctx) !== "me") return false;
  if (entry.language && entry.language !== AUTO && sameLanguage(entry.language, ctx.foreign)) return false;
  return true;
}

export const OWN_WINDOW_MS = 60_000;

/**
 * "My last sentence" on demand (swipe at the live edge), for when speaker
 * letters are unreliable: the newest line in the user's own language within
 * the last minute, else the newest line with the user's speaker letter, else
 * the newest line that is not in the foreign language. null = nothing.
 */
export function lastOwnLine(log: readonly TranscriptEntry[], ctx: OwnContext, now: number, windowMs = OWN_WINDOW_MS): TranscriptEntry | null {
  const recent = log.filter((entry) => entry.at >= now - windowMs);
  const newest = (test: (entry: TranscriptEntry) => boolean): TranscriptEntry | null => {
    for (let i = recent.length - 1; i >= 0; i--) if (test(recent[i]!)) return recent[i]!;
    return null;
  };
  const inForeign = (entry: TranscriptEntry): boolean =>
    Boolean(ctx.foreign && entry.language && entry.language !== AUTO && sameLanguage(entry.language, ctx.foreign));
  const own = ctx.ownLanguage;
  // 0.8.0: a line the server recognised by the user's voice ("ME") is the surest.
  return newest((entry) => entry.speaker === OWNER_SPEAKER && !inForeign(entry))
    ?? newest((entry) => Boolean(own && entry.language && entry.language !== AUTO && sameLanguage(entry.language, own)))
    ?? (ctx.speakers && ctx.mySpeaker !== "auto" ? newest((entry) => entry.speaker === ctx.mySpeaker && !inForeign(entry)) : null)
    ?? newest((entry) => !inForeign(entry));
}

/** The translation request: own language → foreign language. null = nothing to do. */
export function ownTranslationRequest(text: string, ctx: OwnContext): TranslationRequest | null {
  if (!text.trim() || !ctx.foreign || !ctx.ownLanguage || sameLanguage(ctx.foreign, ctx.ownLanguage)) return null;
  return { text, from: ctx.ownLanguage, to: ctx.foreign };
}

/** How an own translation is marked everywhere (glasses and phone). */
export const OWN_MARK = "→ ";

import type { WordResult } from "./wordfinder";

/**
 * "Meine Wörter" (0.9.0): every word the word finder found is kept on the
 * phone, newest first, so the user can learn them later. One entry per word.
 */

export interface VocabEntry {
  /** The word the finder put first. */
  readonly word: string;
  /** The alternatives it gave next to it. */
  readonly alternatives: readonly string[];
  /** The German meaning (learner case), "" when the finder gave none. */
  readonly meaning: string;
  /** When it was found last. */
  readonly at: number;
}

export const VOCAB_CAP = 300;

/** The entry a successful lookup produces; null for an empty result. */
export function vocabFromResult(result: WordResult, at: number): VocabEntry | null {
  const word = result.words[0]?.trim();
  if (!word) return null;
  return { word, alternatives: result.words.slice(1), meaning: result.translation ?? "", at };
}

/** Adds an entry at the top; the same word (any case) only moves up with the new time and answer. The oldest drop off the cap. */
export function addVocab(list: readonly VocabEntry[], entry: VocabEntry, cap = VOCAB_CAP): VocabEntry[] {
  const key = entry.word.toLowerCase();
  const rest = list.filter((item) => item.word.toLowerCase() !== key);
  return [entry, ...rest].slice(0, cap);
}

export function removeVocab(list: readonly VocabEntry[], word: string): VocabEntry[] {
  const key = word.toLowerCase();
  return list.filter((item) => item.word.toLowerCase() !== key);
}

/** Reads the stored list; anything unusable is dropped, never thrown. */
export function parseVocab(raw: string): VocabEntry[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    let out: VocabEntry[] = [];
    // Stored newest first: adding oldest-first keeps that order and drops duplicates.
    for (const item of [...value].reverse()) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.word !== "string" || !entry.word.trim() || typeof entry.at !== "number") continue;
      out = addVocab(out, {
        word: entry.word.trim(),
        alternatives: Array.isArray(entry.alternatives) ? entry.alternatives.filter((a): a is string => typeof a === "string") : [],
        meaning: typeof entry.meaning === "string" ? entry.meaning : "",
        at: entry.at,
      });
    }
    return out;
  } catch {
    return [];
  }
}

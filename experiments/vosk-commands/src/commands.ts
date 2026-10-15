/**
 * Command matching: Vosk text → one command from a fixed list.
 *
 * Vosk with a grammar already restricts the output to the listed phrases (or
 * "[unk]"), but real speech still slips through as near misses ("licht in der
 * küche aus", "küchenlicht aus", "kueche"). This layer is the safety net and
 * also works without a grammar (free recognition with the small model).
 *
 * Pure, no Vosk dependency, fully unit-tested.
 */

export interface CommandDef {
  /** Stable id the app acts on, e.g. "light.kitchen.off". */
  readonly id: string;
  /** Ways to say it. The first is the canonical one. Lower case, words separated by spaces. */
  readonly phrases: readonly string[];
}

export interface CommandMatch {
  readonly id: string;
  /** The phrase that matched best. */
  readonly phrase: string;
  /** 0…1, 1 = exact. */
  readonly score: number;
}

export interface MatchOptions {
  /** Below this the text is not a command. Default 0.75. */
  readonly threshold?: number;
  /** If the best two *different* commands are closer than this, nothing is chosen. Default 0.08. */
  readonly ambiguityGap?: number;
  /** Words that never carry meaning; dropped before matching. */
  readonly fillers?: ReadonlySet<string>;
}

/** German and English filler words (articles, politeness, hesitation). */
export const DEFAULT_FILLERS: ReadonlySet<string> = new Set([
  "bitte", "mal", "doch", "äh", "ähm", "öhm", "hm", "hey", "okay", "ok", "so", "jetzt",
  "der", "die", "das", "den", "dem", "des", "im", "in", "am", "vom", "von", "zum", "zur",
  "please", "the", "a", "uh", "um", "now",
]);

/** Vosk's marker for out-of-grammar speech. */
export const UNKNOWN = "[unk]";

/**
 * Lower case, NFC, umlauts folded (ä→ae, ö→oe, ü→ue, ß→ss) so "kueche" and
 * "küche" are the same word; punctuation and "[unk]" removed.
 */
export function normalise(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replaceAll(UNKNOWN, " ")
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(text: string, fillers: ReadonlySet<string> = DEFAULT_FILLERS): string[] {
  const folded = new Set([...fillers].map(normalise));
  return normalise(text).split(" ").filter((word) => word !== "" && !folded.has(word));
}

/** Classic Levenshtein distance (insert, delete, substitute = 1). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost));
    }
    prev = row;
  }
  return prev[b.length]!;
}

/** 0…1 similarity of two words. Short words must match exactly ("an" ≠ "aus"). */
export function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (Math.min(a.length, b.length) <= 3) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/**
 * Score of heard words against one phrase: every phrase word looks for its best
 * heard word (order-free, each heard word used once); extra heard words cost a
 * little, missing phrase words cost fully. A joined-up compound ("küchenlicht"
 * for "küche licht") is caught by also comparing the words glued together.
 */
export function phraseScore(heard: readonly string[], phrase: readonly string[]): number {
  if (phrase.length === 0 || heard.length === 0) return 0;
  const free = [...heard];
  let sum = 0;
  for (const word of phrase) {
    let best = 0;
    let bestIndex = -1;
    free.forEach((candidate, index) => {
      const similarity = wordSimilarity(word, candidate);
      if (similarity > best) { best = similarity; bestIndex = index; }
    });
    // Weak partial matches count as misses; otherwise "licht" half-matches everything.
    if (best >= 0.7 && bestIndex >= 0) { sum += best; free.splice(bestIndex, 1); }
  }
  const tokenScore = sum / (phrase.length + 0.5 * free.length);
  const glued = wordSimilarity(heard.join(""), phrase.join(""));
  const gluedSorted = wordSimilarity([...heard].sort().join(""), [...phrase].sort().join(""));
  return Math.max(tokenScore, glued, gluedSorted);
}

/** Best command for a recognised text, or null (nothing close enough, or ambiguous). */
export function matchCommand(text: string, commands: readonly CommandDef[], options: MatchOptions = {}): CommandMatch | null {
  const threshold = options.threshold ?? 0.75;
  const gap = options.ambiguityGap ?? 0.08;
  const heard = tokens(text, options.fillers);
  if (heard.length === 0) return null;

  const best = new Map<string, CommandMatch>();
  for (const command of commands) {
    for (const phrase of command.phrases) {
      const score = phraseScore(heard, tokens(phrase, options.fillers));
      const current = best.get(command.id);
      if (!current || score > current.score) best.set(command.id, { id: command.id, phrase, score });
    }
  }
  const ranked = [...best.values()].sort((a, b) => b.score - a.score);
  const top = ranked[0];
  if (!top || top.score < threshold) return null;
  const second = ranked[1];
  if (second && top.score - second.score < gap) return null;
  return top;
}

/**
 * Vosk grammar (JSON array of phrases) for a command list: every phrase in
 * lower case, plus "[unk]" so out-of-list speech is reported as unknown
 * rather than forced onto the nearest command. Umlauts are kept — the German
 * model's vocabulary uses them. Words missing from the model vocabulary are
 * dropped by Vosk with a warning, so test each new phrase once.
 */
export function voskGrammar(commands: readonly CommandDef[]): string {
  const phrases = new Set<string>();
  for (const command of commands) {
    for (const phrase of command.phrases) {
      const clean = phrase.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
      if (clean) phrases.add(clean);
    }
  }
  return JSON.stringify([...phrases, UNKNOWN]);
}

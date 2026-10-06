/**
 * Voice grammar for the take log: "Szene 2 B OK unscharf", "scene 3 shot A
 * no good", or just "OK" / "NG nochmal". Pure — no SDK imports.
 */

export interface ShotRef {
  readonly scene: string;
  readonly shot: string;
}

export interface TakeCommand {
  /** Shot index to move to, if a scene/shot or next/previous was said. */
  readonly index: number | null;
  readonly status: "OK" | "NG" | null;
  /** One of the offered notes, if it was said. */
  readonly note: string;
}

const NUMBERS: Readonly<Record<string, string>> = {
  null: "0", eins: "1", eine: "1", ein: "1", zwei: "2", zwo: "2", drei: "3", vier: "4", "fünf": "5", fuenf: "5",
  sechs: "6", sieben: "7", acht: "8", neun: "9", zehn: "10", elf: "11", "zwölf": "12", zwoelf: "12",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8",
  nine: "9", ten: "10", eleven: "11", twelve: "12",
};

export const takeNorm = (text: string): string =>
  text.toLowerCase().replace(/[.,!?;:"„“”]/g, " ").replace(/\s+/g, " ").trim();

const SCENE_WORD = /^(szene|scene)\w*$/;
const SHOT_WORDS = new Set(["shot", "einstellung", "bild"]);
const NEXT = /nächst|naechst|\bweiter\b|\bnext\b/;
const PREVIOUS = /vorig|zurück|zurueck|\bprevious\b|\bback\b/;
const BAD = /\bng\b|nicht ok|nicht okay|schlecht|nochmal|no good|\bnein\b|\bbad\b|\bagain\b|not good/;
const GOOD = /\bok\b|\bokay\b|\bpasst\b|\bgut\b|\bsuper\b|\btop\b|\bgood\b|\bgreat\b/;

/** Sentence → intent, given the shot list, the current index and the offered notes. */
export function parseTakeCommand(
  text: string,
  shots: readonly ShotRef[],
  current: number,
  notes: readonly string[],
): TakeCommand {
  const heard = takeNorm(text);
  if (!heard || shots.length === 0) return { index: null, status: null, note: "" };
  const words = heard.split(" ");
  const number = (word: string | undefined): string => (word ? NUMBERS[word] ?? word : "");

  let scene = "";
  let shot = "";
  const sceneAt = words.findIndex((w) => SCENE_WORD.test(w));
  if (sceneAt >= 0) scene = number(words[sceneAt + 1]);
  const shotAt = words.findIndex((w) => SHOT_WORDS.has(w));
  if (shotAt >= 0) shot = (words[shotAt + 1] ?? "").toUpperCase();
  // "Szene 2 B": a single letter right after the scene number is the shot.
  if (!shot && sceneAt >= 0) {
    const after = words[sceneAt + 2];
    if (after && /^[a-z]$/.test(after)) shot = after.toUpperCase();
  }

  let index: number | null = null;
  if (scene) {
    const found = shots.findIndex((s) =>
      s.scene.toLowerCase() === scene.toLowerCase() && (!shot || s.shot.toUpperCase() === shot));
    if (found >= 0) index = found;
  } else if (NEXT.test(heard)) {
    index = (current + 1) % shots.length;
  } else if (PREVIOUS.test(heard)) {
    index = (current - 1 + shots.length) % shots.length;
  }

  // "nicht ok" contains "ok": the negative wins.
  const status = BAD.test(heard) ? "NG" : GOOD.test(heard) ? "OK" : null;

  let note = "";
  for (const candidate of notes) {
    if (candidate.startsWith("(")) continue;
    if (heard.includes(candidate.toLowerCase())) note = candidate;
  }
  return { index, status, note };
}

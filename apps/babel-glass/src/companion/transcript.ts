/**
 * The running transcript of one conversation: every final line, in order, with
 * its speaker. Kept in memory only (like the captions) and capped, so a day of
 * listening cannot exhaust the WebView.
 */

export interface TranscriptEntry {
  readonly text: string;
  readonly at: number;
  readonly speaker?: string;
  readonly language?: string;
  readonly translated?: string;
}

export const TRANSCRIPT_CAP = 1500;

export function appendEntry(
  log: readonly TranscriptEntry[],
  entry: TranscriptEntry,
  cap = TRANSCRIPT_CAP,
): TranscriptEntry[] {
  const text = entry.text.normalize("NFC").trim();
  if (!text) return [...log];
  return [...log, { ...entry, text }].slice(-cap);
}

/** Attaches a translation to the newest entry with exactly this text. */
export function attachTranslation(
  log: readonly TranscriptEntry[],
  source: string,
  translated: string,
): TranscriptEntry[] {
  const wanted = source.normalize("NFC").trim();
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry && entry.text === wanted) {
      return [...log.slice(0, i), { ...entry, translated }, ...log.slice(i + 1)];
    }
  }
  return [...log];
}

/** "A: text" when a speaker is known, otherwise just the text. */
export function speakerLine(entry: Pick<TranscriptEntry, "text" | "speaker">): string {
  return entry.speaker ? entry.speaker + ": " + entry.text : entry.text;
}

/**
 * The transcript as plain lines for the language model, newest kept when the
 * whole thing would exceed `maxChars` (the start is then marked as cut).
 */
export function transcriptForLlm(log: readonly TranscriptEntry[], maxChars = 12_000): string {
  const lines = log.map(speakerLine);
  let total = 0;
  let first = lines.length;
  while (first > 0) {
    const next = (lines[first - 1] ?? "").length + 1;
    if (total + next > maxChars) break;
    total += next;
    first--;
  }
  const kept = lines.slice(first);
  return (first > 0 ? "[…]\n" : "") + kept.join("\n");
}

/** Distinct speaker labels in order of appearance. */
export function speakersIn(log: readonly TranscriptEntry[]): string[] {
  const seen: string[] = [];
  for (const entry of log) {
    if (entry.speaker && !seen.includes(entry.speaker)) seen.push(entry.speaker);
  }
  return seen;
}

/** "14:05" in local time. */
export function clockLabel(at: number): string {
  const d = new Date(at);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

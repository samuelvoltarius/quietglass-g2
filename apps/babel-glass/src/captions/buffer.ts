import type { Transcript } from "../stt/provider";

/**
 * The caption buffer.
 *
 * Live captioning has one hard problem on a small display: recognisers revise
 * their output. A naive implementation appends every partial result and the
 * text stutters and repeats. This buffer keeps **one** in-progress line that
 * gets replaced until it is final, and only then commits it to history.
 */

export interface CaptionLine {
  readonly text: string;
  readonly at: number;
  /** Language the recogniser reported for this line, if any. */
  readonly language?: string;
  /** Translation of `text`, when translation is on and has arrived. */
  readonly translated?: string;
}

export interface CaptionBuffer {
  /** Committed lines, oldest first. */
  readonly lines: readonly CaptionLine[];
  /** The line still being revised, if any. */
  readonly pending: CaptionLine | null;
}

export function createBuffer(): CaptionBuffer {
  return { lines: [], pending: null };
}

export interface BufferOptions {
  /** Committed lines to retain. */
  readonly keep?: number;
}

const DEFAULT_KEEP = 40;

/**
 * Applies one transcript.
 *
 * A non-final transcript replaces the pending line rather than adding to it —
 * that is what stops the display stuttering.
 */
export function applyTranscript(
  buffer: CaptionBuffer,
  transcript: Transcript,
  now: number,
  options: BufferOptions = {},
): CaptionBuffer {
  // NFC so that a decomposed "u + combining diaeresis" from a server becomes
  // one "ü": one character on screen, one character for wrapping.
  const text = transcript.text.normalize("NFC").trim();
  if (!text) {
    return transcript.final ? { ...buffer, pending: null } : buffer;
  }

  const line: CaptionLine = transcript.language
    ? { text, at: now, language: transcript.language }
    : { text, at: now };

  if (!transcript.final) {
    return { ...buffer, pending: line };
  }

  const keep = options.keep ?? DEFAULT_KEEP;
  return {
    lines: [...buffer.lines, line].slice(-keep),
    pending: null,
  };
}

/** Attaches a translation to the most recent committed line matching `text`. */
export function applyTranslation(
  buffer: CaptionBuffer,
  sourceText: string,
  translated: string,
): CaptionBuffer {
  // Lines are stored NFC-normalised and trimmed; match the same way.
  const source = sourceText.normalize("NFC").trim();
  for (let i = buffer.lines.length - 1; i >= 0; i--) {
    const line = buffer.lines[i];
    if (line && line.text === source) {
      const updated: CaptionLine = { ...line, translated: translated.normalize("NFC") };
      return {
        ...buffer,
        lines: [...buffer.lines.slice(0, i), updated, ...buffer.lines.slice(i + 1)],
      };
    }
  }
  return buffer;
}

export function clearBuffer(): CaptionBuffer {
  return createBuffer();
}

/**
 * The lines to display, newest last, including the pending one.
 *
 * `offset` scrolls back through history; 0 means "follow the live edge".
 */
export function visibleLines(
  buffer: CaptionBuffer,
  rows: number,
  offset = 0,
): CaptionLine[] {
  const all = buffer.pending ? [...buffer.lines, buffer.pending] : [...buffer.lines];
  if (all.length === 0) return [];

  const maxOffset = Math.max(0, all.length - rows);
  const back = Math.min(Math.max(0, offset), maxOffset);
  const end = all.length - back;
  return all.slice(Math.max(0, end - rows), end);
}

export function isFollowingLive(buffer: CaptionBuffer, rows: number, offset: number): boolean {
  const total = buffer.lines.length + (buffer.pending ? 1 : 0);
  return offset <= 0 || total <= rows;
}

/**
 * Characters as they appear on screen: code points, not UTF-16 units, and
 * combining marks do not count. Cyrillic, umlauts and ß are one each.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (!/\p{M}/u.test(ch)) width++;
  }
  return width;
}

/** Wraps a caption to the display width, longest-fitting lines first. */
export function wrap(text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (maxWidth <= 0) return [text];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : current + " " + word;
    if (displayWidth(candidate) <= maxWidth) {
      current = candidate;
    } else {
      if (current !== "") lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

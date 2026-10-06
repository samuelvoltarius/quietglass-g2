import type { Script } from "../script/model";

/**
 * Wraps paragraphs into display lines.
 *
 * Text width measurement is injected: the G2 font is not metrically available
 * here, and pulling in a measurement package would be an extra dependency for
 * every app. The default counts characters, which is exact for the monospace
 * case and a safe approximation otherwise; a caller holding real metrics can
 * pass them in.
 */
export type Measure = (text: string) => number;

export const measureByChars: Measure = (text) => text.length;

export interface LayoutOptions {
  /** Budget per line, in whatever unit `measure` returns. */
  readonly maxWidth: number;
  readonly measure?: Measure;
}

export interface DisplayLine {
  readonly text: string;
  /** Index into `Script.paragraphs`, so sections and bookmarks stay resolvable. */
  readonly paragraph: number;
  /** True for the first line of its paragraph — used for spacing. */
  readonly paragraphStart: boolean;
  readonly words: number;
}

export function layoutScript(script: Script, options: LayoutOptions): DisplayLine[] {
  const measure = options.measure ?? measureByChars;
  const lines: DisplayLine[] = [];

  script.paragraphs.forEach((paragraph, index) => {
    const wrapped = wrapText(paragraph, options.maxWidth, measure);
    wrapped.forEach((text, line) => {
      lines.push({
        text,
        paragraph: index,
        paragraphStart: line === 0,
        words: countWords(text),
      });
    });
  });

  return lines;
}

/**
 * Greedy wrap. A word longer than the budget is hard-split rather than dropped,
 * so a pasted URL cannot make a line disappear off the display.
 */
export function wrapText(text: string, maxWidth: number, measure: Measure = measureByChars): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (maxWidth <= 0) return [text];

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current === "") {
      if (measure(word) <= maxWidth) { current = word; continue; }
      for (const piece of hardSplit(word, maxWidth, measure)) {
        if (measure(piece) >= maxWidth) lines.push(piece);
        else current = piece;
      }
      continue;
    }

    const candidate = `${current} ${word}`;
    if (measure(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }

    lines.push(current);
    current = "";
    if (measure(word) <= maxWidth) {
      current = word;
    } else {
      for (const piece of hardSplit(word, maxWidth, measure)) {
        if (measure(piece) >= maxWidth) lines.push(piece);
        else current = piece;
      }
    }
  }

  if (current !== "") lines.push(current);
  return lines;
}

function hardSplit(word: string, maxWidth: number, measure: Measure): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const char of word) {
    const candidate = piece + char;
    if (piece !== "" && measure(candidate) > maxWidth) {
      pieces.push(piece);
      piece = char;
    } else {
      piece = candidate;
    }
  }
  if (piece !== "") pieces.push(piece);
  return pieces;
}

function countWords(text: string): number {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length;
}

/** First display line of a paragraph, for jumping to sections. */
export function lineOfParagraph(lines: readonly DisplayLine[], paragraph: number): number {
  const index = lines.findIndex((line) => line.paragraph === paragraph && line.paragraphStart);
  return index === -1 ? 0 : index;
}

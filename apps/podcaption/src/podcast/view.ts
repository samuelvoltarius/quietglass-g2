import type { Caption } from "./parse";

/** Roughly the characters across the 576 px display (proportional font, same budget as the sibling apps). */
export const LINE_WIDTH = 46;
/** Rows the 214 px body container shows without clipping. */
export const BODY_ROWS = 7;

export function formatTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Word wrap that never drops text: an over-long word is cut across lines. The prefix is kept verbatim on the first line. */
export function wrap(text: string, width: number = LINE_WIDTH, prefix = ""): string[] {
  const lines: string[] = []; let current = prefix; let fresh = true;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let index = 0; index < word.length; index += width) {
      const piece = word.slice(index, index + width); const joiner = fresh ? "" : " ";
      if (current.length + joiner.length + piece.length <= width) current += joiner + piece; else { lines.push(current.trimEnd()); current = piece; }
      fresh = false;
    }
  }
  if (!fresh) lines.push(current);
  return lines;
}

const cut = (line: string, width: number): string => (line.length < width ? line : line.slice(0, width - 1)) + "…";

/**
 * The episode line, a spacer, then captions from the cursor on, wrapped and
 * cut so the body never holds more rows than the display shows. The selected
 * caption always gets at least its first line.
 */
export function captionRows(episode: string, captions: readonly Caption[], cursor: number, rows: number = BODY_ROWS, width: number = LINE_WIDTH): string[] {
  const title = episode.toUpperCase();
  const body = [title.length > width ? cut(title, width) : title, ""];
  for (const caption of captions.slice(Math.max(0, cursor))) {
    if (body.length > 2) { if (body.length + 2 > rows) break; body.push(""); }
    const lines = wrap(caption.text, width, `${formatTime(caption.start)}  `);
    const room = rows - body.length;
    if (room <= 0) break;
    if (lines.length <= room) { body.push(...lines); continue; }
    body.push(...lines.slice(0, room - 1), cut(lines[room - 1] ?? "", width));
    break;
  }
  return body;
}

/** Captions, titles and feed errors come from third-party feeds; never let them become markup on the phone. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

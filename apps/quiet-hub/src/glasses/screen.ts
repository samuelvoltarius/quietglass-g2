/**
 * The one screen every view is drawn on: a header row, up to seven body rows
 * and a footer row. Width limits are in characters of the G2's proportional
 * font; the tests check every view against them with worst-case content.
 */
export interface ScreenView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

/** Rows the body container holds; more are pushed off the display. */
export const MAX_BODY_ROWS = 7;
/** Characters one row holds. */
export const ROW_WIDTH = 46;

/** Cuts a row to the display width, marking the cut with an ellipsis. */
export function fit(text: string, width = ROW_WIDTH): string {
  const flat = text.replace(/[\r\n\t]+/g, " ");
  if (flat.length <= width) return flat;
  return flat.slice(0, Math.max(0, width - 1)).trimEnd() + "…";
}

/** Breaks text into rows of at most `width` characters, on word boundaries where possible. */
export function wrap(text: string, width = ROW_WIDTH): string[] {
  const rows: string[] = [];
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    if (paragraph.trim() === "") { rows.push(""); continue; }
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      // A word longer than a row is split hard; nothing may overflow.
      let rest = word;
      while (rest.length > width) {
        if (line) { rows.push(line); line = ""; }
        rows.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      if (!rest) continue;
      if (!line) line = rest;
      else if ((line + " " + rest).length <= width) line += " " + rest;
      else { rows.push(line); line = rest; }
    }
    if (line) rows.push(line);
  }
  return rows;
}

/** Puts a highlight marker in front of the selected row. */
export function marked(label: string, selected: boolean): string {
  return fit((selected ? "> " : "  ") + label);
}

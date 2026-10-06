/**
 * Text budget on the G2 (576 x 288): one header row, up to four body rows and
 * one footer row. Header and footer span the full width (~46 characters); the
 * body sits beside the 96 px level meter, so it gets ~38, and above the dose
 * bar, so it gets four rows. German runs longer
 * than English, so every line is cut safely rather than allowed to wrap.
 */
export const LINE_COLS = 46;
export const BODY_COLS = 38;
export const BODY_ROWS = 4;

export function fit(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

export function fitView<T extends { header: string; body: readonly string[]; footer: string }>(view: T): T {
  return {
    ...view,
    header: fit(view.header, LINE_COLS),
    body: view.body.slice(0, BODY_ROWS).map((line) => fit(line, BODY_COLS)),
    footer: fit(view.footer, LINE_COLS),
  };
}

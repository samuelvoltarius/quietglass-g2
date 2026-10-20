/**
 * Text budget on the G2 (576 x 288) for the text pages (the menu and the sensor test): one header row, up to
 * five body rows and one footer row, each about 56 characters across the full width. German runs longer than
 * English, so every line is cut safely rather than allowed to wrap.
 */
export const LINE_COLS = 56;
export const BODY_COLS = 56;
export const HEADER_COLS = 56;
export const BODY_ROWS = 5;

export function fit(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

export function fitView<T extends { header: string; body: readonly string[]; footer: string }>(view: T): T {
  return {
    ...view,
    header: fit(view.header, HEADER_COLS),
    body: view.body.slice(0, BODY_ROWS).map((line) => fit(line, BODY_COLS)),
    footer: fit(view.footer, LINE_COLS),
  };
}

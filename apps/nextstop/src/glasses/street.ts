import { STREET_HALF, STREET_HEIGHT, STREET_WIDTH } from "./layout";
import { fitText, renderWordsPng } from "./words";

/**
 * The street name of the walking page as a picture, across the full width:
 * two image containers of 288 x 56 side by side show one 576 x 56 line of
 * bold type. It is redrawn only when the name changes.
 */

export { STREET_HALF, STREET_HEIGHT, STREET_WIDTH };
export const MAX_FONT_PX = 46;
export const MIN_FONT_PX = 30;

export function fitStreetText(measure: (text: string, size: number) => number, text: string, available = STREET_WIDTH - 20) {
  return fitText(measure, text, available, MAX_FONT_PX, MIN_FONT_PX);
}

/** The two PNG halves (left, right) of the street name; empty text gives two black images. */
export async function renderStreetPngs(text: string, height = STREET_HEIGHT, size = MAX_FONT_PX): Promise<[Uint8Array, Uint8Array]> {
  const line = [{ text, size }] as const;
  return [
    await renderWordsPng(line, STREET_HALF, height, { offsetX: 0, fullWidth: STREET_WIDTH }),
    await renderWordsPng(line, STREET_HALF, height, { offsetX: STREET_HALF, fullWidth: STREET_WIDTH }),
  ];
}

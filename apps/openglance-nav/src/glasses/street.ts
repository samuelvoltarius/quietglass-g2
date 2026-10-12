import { encodePng, createGrayCanvas } from "./png";

/**
 * The road name of the turn layout as a picture.
 *
 * The glasses' text has one small fixed size, too small to read at a glance
 * in a car. So the name is drawn as an image across the full width: two image
 * containers of 288 × 56 side by side, which together show one 576 × 56
 * line of bold type. It is redrawn only when the name changes.
 */

export const STREET_WIDTH = 576;
export const STREET_HEIGHT = 56;
/** Each of the two halves is as wide as an image container may be. */
export const STREET_HALF = STREET_WIDTH / 2;

export const MAX_FONT_PX = 46;
export const MIN_FONT_PX = 30;
/** Space kept free at both ends of the line. */
const MARGIN = 12;

export interface FittedText {
  readonly text: string;
  readonly size: number;
  readonly width: number;
}

/**
 * The biggest type size (in steps of 2 px, down to MIN_FONT_PX) at which
 * `text` fits the line. Text that is still too wide at the smallest size is
 * cut, with an ellipsis, until it fits.
 */
export function fitStreetText(measure: (text: string, size: number) => number, text: string, available = STREET_WIDTH - 2 * MARGIN): FittedText {
  for (let size = MAX_FONT_PX; size >= MIN_FONT_PX; size -= 2) {
    const width = measure(text, size);
    if (width <= available) return { text, size, width };
  }
  let cut = text;
  while (cut.length > 1) {
    cut = cut.slice(0, -1);
    const shown = cut.trimEnd() + "…";
    const width = measure(shown, MIN_FONT_PX);
    if (width <= available) return { text: shown, size: MIN_FONT_PX, width };
  }
  return { text: "…", size: MIN_FONT_PX, width: measure("…", MIN_FONT_PX) };
}

const FONT = (size: number): string => `bold ${size}px "Arial Narrow", Arial, Helvetica, sans-serif`;

/** The two PNG halves (left, right) of the road name, white bold type centred on black. Empty text gives two black images. */
export async function renderStreetPngs(text: string): Promise<[Uint8Array, Uint8Array]> {
  const label = text.trim();
  const make = async (half: 0 | 1): Promise<Uint8Array> => {
    if (!label) return encodePng(STREET_HALF, STREET_HEIGHT, createGrayCanvas(STREET_HALF, STREET_HEIGHT).pixels);
    const canvas = document.createElement("canvas"); canvas.width = STREET_HALF; canvas.height = STREET_HEIGHT;
    const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("2d canvas unavailable");
    const fitted = fitStreetText((value, size) => { ctx.font = FONT(size); return ctx.measureText(value).width; }, label);
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, STREET_HALF, STREET_HEIGHT);
    ctx.fillStyle = "#fff"; ctx.font = FONT(fitted.size); ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillText(fitted.text, (STREET_WIDTH - fitted.width) / 2 - half * STREET_HALF, STREET_HEIGHT / 2 + 2);
    const blob: Blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encode failed")), "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  };
  return [await make(0), await make(1)];
}

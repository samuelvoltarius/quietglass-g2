/**
 * The pages of the glasses and where everything sits on the 576 x 288 display.
 *
 * Four page kinds exist. None has more than four image containers (each at
 * most 288 x 144) and every one has exactly one container that captures input:
 * the body text.
 *
 *  - "text": header, body, footer. Everything that is just words.
 *  - "walk": a big arrow (144 x 144) and the distance with its approach bar
 *    (288 x 144) side by side, the street name as two image halves across the
 *    full width, one line of small text, the footer.
 *  - "ride": "noch 2 Halte" as three images in one row (the word before, the
 *    big pixel digits, the word after), small text below, the footer.
 *  - "wait": the big countdown (288 x 120) next to a bus-stop scene (288 x 120)
 *    that a bus drives into in the last minute; text below, the footer.
 *
 * Changing the kind rebuilds the page, which on hardware takes a moment and
 * swallows input meanwhile. It happens when the guide moves to another stage,
 * never for an update; updates are `textContainerUpgrade` and
 * `updateImageRawData`, and only for what changed.
 */

export const SCREEN_WIDTH = 576;
export const SCREEN_HEIGHT = 288;

export type PageKind = "text" | "walk" | "ride" | "wait";

export interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface ImageSpec extends Box { readonly id: number; readonly name: string }

/** Text container ids; image containers use 4 and up. */
export const HEADER_ID = 1;
export const BODY_ID = 2;
export const FOOTER_ID = 3;

export const HEADER_BOX: Box = { x: 0, y: 0, width: SCREEN_WIDTH, height: 32 };
export const FOOTER_BOX: Box = { x: 0, y: 252, width: SCREEN_WIDTH, height: 34 };

/** Body of the plain text page. */
export const TEXT_BODY: Box = { x: 0, y: 36, width: SCREEN_WIDTH, height: 214 };

// ---- walk ---------------------------------------------------------------------

export const ARROW_SIZE = 144;
export const CARD_WIDTH = 288;
export const CARD_HEIGHT = 144;
export const STREET_WIDTH = 576;
export const STREET_HEIGHT = 56;
export const STREET_HALF = STREET_WIDTH / 2;

export const WALK_IMAGES: readonly ImageSpec[] = [
  { id: 4, name: "arrow", x: 64, y: 4, width: ARROW_SIZE, height: ARROW_SIZE },
  { id: 5, name: "distance", x: 224, y: 4, width: CARD_WIDTH, height: CARD_HEIGHT },
  { id: 6, name: "street-left", x: 0, y: 152, width: STREET_HALF, height: STREET_HEIGHT },
  { id: 7, name: "street-right", x: STREET_HALF, y: 152, width: STREET_HALF, height: STREET_HEIGHT },
];
export const WALK_BODY: Box = { x: 0, y: 212, width: SCREEN_WIDTH, height: 38 };

// ---- ride ---------------------------------------------------------------------

export const RIDE_BAND = 120;
/** "noch" + the digits + "Halte": 144 + 144 + 288 = 576 pixels, edge to edge. */
export const RIDE_IMAGES: readonly ImageSpec[] = [
  { id: 4, name: "before", x: 0, y: 4, width: 144, height: RIDE_BAND },
  { id: 5, name: "count", x: 144, y: 4, width: 144, height: RIDE_BAND },
  { id: 6, name: "after", x: 288, y: 4, width: 288, height: RIDE_BAND },
];
export const RIDE_BODY: Box = { x: 0, y: 130, width: SCREEN_WIDTH, height: 120 };

// ---- wait ---------------------------------------------------------------------

export const WAIT_BAND = 120;
export const WAIT_IMAGES: readonly ImageSpec[] = [
  { id: 4, name: "countdown", x: 0, y: 4, width: 288, height: WAIT_BAND },
  { id: 5, name: "bus", x: 288, y: 4, width: 288, height: WAIT_BAND },
];
export const WAIT_BODY: Box = { x: 0, y: 130, width: SCREEN_WIDTH, height: 120 };

export const IMAGES: Readonly<Record<PageKind, readonly ImageSpec[]>> = {
  text: [], walk: WALK_IMAGES, ride: RIDE_IMAGES, wait: WAIT_IMAGES,
};

export const BODY_BOX: Readonly<Record<PageKind, Box>> = {
  text: TEXT_BODY, walk: WALK_BODY, ride: RIDE_BODY, wait: WAIT_BODY,
};

export function imageSpec(kind: PageKind, id: number): ImageSpec | undefined {
  return IMAGES[kind].find((spec) => spec.id === id);
}

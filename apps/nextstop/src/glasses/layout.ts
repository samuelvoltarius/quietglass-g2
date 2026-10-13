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
 *  - "board": one thing big - minutes in pixel digits (288 x 104) beside a
 *    picture (the line as a badge, the bus stop, "next stop") - then one bold
 *    line across the full width (two 288 x 50 halves), three short text
 *    lines, the footer. The departure board, following a bus, the
 *    connections and every waiting or error message of those pages all use
 *    it, so moving between them never rebuilds the page.
 *
 * Changing the kind rebuilds the page, which on hardware takes a moment and
 * swallows input meanwhile. It happens when the guide moves to another stage,
 * never for an update; updates are `textContainerUpgrade` and
 * `updateImageRawData`, and only for what changed.
 */

export const SCREEN_WIDTH = 576;
export const SCREEN_HEIGHT = 288;

export type PageKind = "text" | "walk" | "ride" | "wait" | "board";

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
/**
 * "noch" + the digits + "Halte", the digits centred on the display: the word
 * before hugs them from the left, the word after from the right.
 */
export const RIDE_IMAGES: readonly ImageSpec[] = [
  { id: 4, name: "before", x: 72, y: 4, width: 144, height: RIDE_BAND },
  { id: 5, name: "count", x: 216, y: 4, width: 144, height: RIDE_BAND },
  { id: 6, name: "after", x: 360, y: 4, width: 216, height: RIDE_BAND },
];
export const RIDE_BODY: Box = { x: 0, y: 130, width: SCREEN_WIDTH, height: 120 };

// ---- wait ---------------------------------------------------------------------

export const WAIT_BAND = 120;
export const WAIT_IMAGES: readonly ImageSpec[] = [
  { id: 4, name: "countdown", x: 0, y: 4, width: 288, height: WAIT_BAND },
  { id: 5, name: "bus", x: 288, y: 4, width: 288, height: WAIT_BAND },
];
export const WAIT_BODY: Box = { x: 0, y: 130, width: SCREEN_WIDTH, height: 120 };

// ---- board --------------------------------------------------------------------

export const BIG_BAND = 104;
export const BOARD_STRIP = 50;
export const BOARD_IMAGES: readonly ImageSpec[] = [
  { id: 4, name: "big", x: 0, y: 2, width: 288, height: BIG_BAND },
  { id: 5, name: "picture", x: 288, y: 2, width: 288, height: BIG_BAND },
  { id: 6, name: "strip-left", x: 0, y: 108, width: STREET_HALF, height: BOARD_STRIP },
  { id: 7, name: "strip-right", x: STREET_HALF, y: 108, width: STREET_HALF, height: BOARD_STRIP },
];
/** Three rows of small text under the bold line. */
export const BOARD_BODY: Box = { x: 0, y: 160, width: SCREEN_WIDTH, height: 90 };
export const BOARD_ROWS = 3;

export const IMAGES: Readonly<Record<PageKind, readonly ImageSpec[]>> = {
  text: [], walk: WALK_IMAGES, ride: RIDE_IMAGES, wait: WAIT_IMAGES, board: BOARD_IMAGES,
};

export const BODY_BOX: Readonly<Record<PageKind, Box>> = {
  text: TEXT_BODY, walk: WALK_BODY, ride: RIDE_BODY, wait: WAIT_BODY, board: BOARD_BODY,
};

export function imageSpec(kind: PageKind, id: number): ImageSpec | undefined {
  return IMAGES[kind].find((spec) => spec.id === id);
}

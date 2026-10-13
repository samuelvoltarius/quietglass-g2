import { createGrayCanvas, encodePng } from "./png";
import { drawLabel, type CardContext } from "./turncard";
import { WAIT_BAND } from "./layout";

/**
 * The bus-stop scene beside the countdown. Normally an empty stop; in the last
 * minute before departure a bus drives in from the left and slows down at the
 * sign. Drawn from filled rectangles only, so it is byte-for-byte testable.
 */

export const BUS_WIDTH = 288;
export const BUS_HEIGHT = WAIT_BAND;
/** Frames of the arrival; the last one is the bus standing at the stop. */
export const BUS_FRAMES = 6;
/** Left edge of the bus per frame: it starts outside the image and brakes. */
export const BUS_X: readonly number[] = [-130, -78, -26, 26, 54, 70];
/** Ticks (of 500 ms) of one pass: the arrival plus a pause with the bus standing. */
export const BUS_CYCLE = 9;

const GROUND_Y = 112;
const BODY = { y: 34, width: 150, height: 58 };
const SIGN_X = 246;

/** The frame (0…BUS_FRAMES-1) shown at beat `tick`: it arrives, then waits, then comes again. */
export function busFrame(tick: number): number {
  const at = ((tick % BUS_CYCLE) + BUS_CYCLE) % BUS_CYCLE;
  return Math.min(at, BUS_FRAMES - 1);
}

/** Frame -1 is the empty stop; 0…BUS_FRAMES-1 the arriving bus. */
export function busKey(frame: number): string {
  return `bus:${frame}`;
}

function rect(ctx: CardContext, color: string, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

export function drawBusScene(ctx: CardContext, frame: number, width = BUS_WIDTH, height = BUS_HEIGHT): void {
  rect(ctx, "#000", 0, 0, width, height);
  // The road, and the stop: a pole with a round-ish sign carrying an "H".
  rect(ctx, "#fff", 0, GROUND_Y, width, 4);
  rect(ctx, "#fff", SIGN_X + 14, 30, 6, GROUND_Y - 30);
  rect(ctx, "#fff", SIGN_X, 6, 34, 32);
  rect(ctx, "#000", SIGN_X + 3, 9, 28, 26);
  drawLabel(ctx, "H", SIGN_X + 10, 12, 3);
  if (frame < 0) return;

  const x = BUS_X[Math.max(0, Math.min(BUS_FRAMES - 1, frame))] ?? 0;
  // Speed lines behind the bus while it is still rolling.
  if (frame < BUS_FRAMES - 2) {
    for (const [dy, len] of [[44, 34], [62, 46], [80, 28]] as const) rect(ctx, "#fff", x - len - 8, dy, len, 4);
  }
  // Body, windows, the door at the front, wheels with hubs.
  rect(ctx, "#fff", x, BODY.y, BODY.width, BODY.height);
  for (let i = 0; i < 4; i++) rect(ctx, "#000", x + 10 + i * 30, BODY.y + 8, 24, 20);
  rect(ctx, "#000", x + 126, BODY.y + 8, 16, 42);
  rect(ctx, "#000", x, BODY.y + 38, BODY.width - 22, 4);
  for (const wx of [x + 18, x + 106]) {
    rect(ctx, "#fff", wx, BODY.y + BODY.height - 8, 26, 26);
    rect(ctx, "#000", wx + 9, BODY.y + BODY.height + 1, 8, 8);
  }
}

export async function renderBusPng(frame: number, width = BUS_WIDTH, height = BUS_HEIGHT): Promise<Uint8Array> {
  const canvas = createGrayCanvas(width, height);
  drawBusScene(canvas, frame, width, height);
  return encodePng(width, height, canvas.pixels);
}

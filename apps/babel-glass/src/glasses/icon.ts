/**
 * The sign in the top-right corner of the header (64 x 30 px image container),
 * drawn as an 18 x 9 pixel pattern scaled by 3. Frames depend only on
 * (kind, now), so they are testable and redraw only when they change.
 *
 * Same idea as the Quiet Hub mascot: an ear with sound waves while listening.
 */

export type PixelIcon = readonly string[];
export type IconKind = "idle" | "listening" | "thinking" | "info" | "done" | "off";

export const ICON_WIDTH = 64;
export const ICON_HEIGHT = 30;
export const ICON_STEP_MS = 500;

/** An ear seen from the side, waves pulsing into it (three frames). */
function ear(step: number): PixelIcon {
  const shell = [
    "....######..",
    "...#......#.",
    "..#..####..#",
    "..#..#...#.#",
    "..#..#..#..#",
    "...#..##..#.",
    "....#....#..",
    ".....#..#...",
    "......##....",
  ];
  const wave = [
    ["......", "......", "......", "...#..", "...#..", "......", "......", "......", "......"],
    ["......", "......", ".#....", "#..#..", "#..#..", ".#....", "......", "......", "......"],
    ["#.....", ".#....", "#.#...", "#..#..", "#..#..", "#.#...", ".#....", "#.....", "......"],
  ][step % 3]!;
  return shell.map((row, i) => (wave[i] ?? "......") + row);
}

/** A notebook with a line growing dash by dash (summarising). */
function notebook(step: number): PixelIcon {
  const fill = ["........", "##......", "##.#....", "##.###..", "##.###.#"][step % 5]!;
  return [
    "..##############..",
    "..#............#..",
    `..#.${fill}...#..`,
    "..#............#..",
    "..#.##.####....#..",
    "..#............#..",
    "..#.###.##.##..#..",
    "..#............#..",
    "..##############..",
  ];
}

/** A light bulb: an explanation is on screen. */
function bulb(step: number): PixelIcon {
  const glow = step % 2 === 0;
  return [
    glow ? ".#......#####.....#" : ".......#####......",
    "......#.....#.....",
    glow ? "#....#..#.#..#...#" : ".....#..#.#..#....",
    ".....#...#...#....",
    "......#..#..#.....",
    ".......#.#.#......",
    ".......#####......",
    ".......#####......",
    "........###.......",
  ].map((row) => row.slice(0, 18));
}

/** Glasses with eyes, blinking every five seconds. */
function face(step: number): PixelIcon {
  const eye = step % 10 === 0 ? ["......", "......", "######", "......"] : ["......", "..##..", "..##..", "......"];
  const lens = (row: string): string => `#${row}#`;
  return [
    ".######....######.",
    `${lens(eye[0]!)}..${lens(eye[0]!)}`,
    `${lens(eye[1]!)}##${lens(eye[1]!)}`,
    `${lens(eye[2]!)}..${lens(eye[2]!)}`,
    `${lens(eye[3]!)}..${lens(eye[3]!)}`,
    ".######....######.",
    "..................",
    ".......####.......",
    "..................",
  ];
}

function check(): PixelIcon {
  return [
    "..................",
    "...............##.",
    "..............##..",
    ".............##...",
    "..##........##....",
    "...##......##.....",
    "....##....##......",
    ".....##..##.......",
    "......####........",
  ];
}

export function iconFrame(kind: IconKind, now: number): PixelIcon {
  const step = Math.floor(now / ICON_STEP_MS);
  switch (kind) {
    case "listening": return ear(step);
    case "thinking": return notebook(step);
    case "info": return bulb(step);
    case "done": return check();
    case "off": return face(1);
    case "idle":
    default: return face(step);
  }
}

export function iconKey(icon: PixelIcon): string {
  return icon.join("|");
}

/** Rasterises a pattern into a grayscale bitmap, scaled to fit with 1 px padding. */
export function rasterize(pattern: PixelIcon, width = ICON_WIDTH, height = ICON_HEIGHT, padding = 1): Uint8Array {
  const pixels = new Uint8Array(width * height);
  const rows = pattern.length;
  const columns = Math.max(1, ...pattern.map((row) => row.length));
  const scale = Math.max(1, Math.floor(Math.min((width - padding * 2) / columns, (height - padding * 2) / rows)));
  const left = Math.floor((width - columns * scale) / 2);
  const top = Math.floor((height - rows * scale) / 2);
  pattern.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] !== "#") continue;
      for (let py = 0; py < scale; py += 1) {
        for (let px = 0; px < scale; px += 1) {
          const tx = left + x * scale + px;
          const ty = top + y * scale + py;
          if (tx >= 0 && tx < width && ty >= 0 && ty < height) pixels[ty * width + tx] = 255;
        }
      }
    }
  });
  return pixels;
}

/** PNG bytes for updateImageRawData (the phone host converts to Gray4). Needs a canvas. */
export async function iconPng(pattern: PixelIcon): Promise<Uint8Array> {
  const pixels = rasterize(pattern);
  const canvas = document.createElement("canvas");
  canvas.width = ICON_WIDTH;
  canvas.height = ICON_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas unavailable");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, ICON_WIDTH, ICON_HEIGHT);
  ctx.fillStyle = "#fff";
  for (let y = 0; y < ICON_HEIGHT; y += 1) {
    let x = 0;
    while (x < ICON_WIDTH) {
      if (!pixels[y * ICON_WIDTH + x]) { x += 1; continue; }
      let end = x + 1;
      while (end < ICON_WIDTH && pixels[y * ICON_WIDTH + end]) end += 1;
      ctx.fillRect(x, y, end - x, 1);
      x = end;
    }
  }
  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("PNG encode failed"))), "image/png");
  });
  return new Uint8Array(await blob.arrayBuffer());
}

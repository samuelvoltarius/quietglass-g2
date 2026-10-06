// Writes docs/graphic-preview.png: the progress bar in a few typical states,
// drawn by the same pure function the app uses, encoded with node's zlib.
// Each row shows the bar where it sits: the right half of the header row.
// Run: node tools/preview.mjs   (Node 22.18+ loads the .ts module directly)
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drawProgressBar } from "../src/glasses/progressbar.ts";

/** 7 steps, the 3rd and 6th critical (marked "(!)" in the list). */
const seven = (done) => ({
  segments: Array.from({ length: 7 }, (_, i) => ({
    status: i < done ? "done" : i === done ? "current" : "open",
    critical: i === 2 || i === 5,
  })),
});
const long = {
  segments: Array.from({ length: 60 }, (_, i) => ({
    status: i < 25 ? "done" : i === 25 ? "current" : "open",
    critical: i % 17 === 8,
  })),
};
const states = [seven(0), seven(2), seven(5), seven(7), long];

const SCALE = 2;
const GAP = 8;
const bitmaps = states.map(drawProgressBar);
const panelW = 292 + 280 + 4; // the header row: text half, then the bar
const width = (panelW + 2 * GAP) * SCALE;
const height = (bitmaps.length * (32 + GAP) + GAP) * SCALE;
const rgb = Buffer.alloc(width * height * 3);
for (let i = 0; i < width * height; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = 24;
bitmaps.forEach((bmp, index) => {
  const top = (GAP + index * (32 + GAP)) * SCALE;
  // The 576 x 32 header row in black; the bar at x 292, y 4 inside it.
  for (let y = 0; y < 32 * SCALE; y++) {
    for (let x = 0; x < panelW * SCALE; x++) {
      const bx = Math.floor(x / SCALE) - 292;
      const by = Math.floor(y / SCALE) - 4;
      const level = bx >= 0 && bx < bmp.width && by >= 0 && by < bmp.height ? bmp.pixels[by * bmp.width + bx] : 0;
      const at = ((top + y) * width + GAP * SCALE + x) * 3;
      rgb[at] = Math.round(level * 0.25); rgb[at + 1] = level; rgb[at + 2] = Math.round(level * 0.35);
    }
  }
});

writeFileSync(fileURLToPath(new URL("../docs/graphic-preview.png", import.meta.url)), png(width, height, rgb));
console.log(`wrote docs/graphic-preview.png (${width}x${height})`);

function png(w, h, pixels) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) pixels.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0); head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function crc32(buffer) {
  let c = ~0;
  for (const byte of buffer) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

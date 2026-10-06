// Writes docs/graphic-preview.png: the day bar in a few typical states, drawn
// by the same pure function the app uses, encoded with node's zlib.
// Run: node tools/preview.mjs   (Node 22.18+ loads the .ts module directly)
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dayBarState, drawDayBar } from "../src/glasses/daybar.ts";

const H = 3600;
const states = [
  dayBarState(0, 0, false),                 // start of the day
  dayBarState(4 * H, 0, false),             // 4 h recorded, stopped
  dayBarState(3 * H, 80 * 60, true, 8),     // 3 h + 1:20 running, target 8 h
  dayBarState(8 * H, 30 * 60, true, 8),     // target reached, still running
  dayBarState(9 * H, 2 * H, true),          // past the 10 h scale
];

const SCALE = 2;
const GAP = 8;
const bitmaps = states.map(drawDayBar);
const width = (bitmaps.length * 96 + (bitmaps.length + 1) * GAP) * SCALE;
const height = (144 + 2 * GAP) * SCALE;
const rgb = Buffer.alloc(width * height * 3);
// Frame each panel in dark grey so the 96 x 144 container edge is visible.
for (let i = 0; i < width * height; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = 24;
bitmaps.forEach((bmp, index) => {
  const left = (GAP + index * (96 + GAP)) * SCALE;
  for (let y = 0; y < bmp.height * SCALE; y++) {
    for (let x = 0; x < bmp.width * SCALE; x++) {
      const level = bmp.pixels[Math.floor(y / SCALE) * bmp.width + Math.floor(x / SCALE)];
      const at = ((GAP * SCALE + y) * width + left + x) * 3;
      // The G2 draws in green; show it the way it will look.
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

// Renders docs/graphic-preview.png: the glasses screen in a few states, drawn
// with the app's own pure pixel functions. Text is set in the 3x5 chart font
// as a stand-in for the G2 system font; positions and graphics are exact.
//
//   node scripts/graphic-preview.mjs
//
// Node runs the TypeScript sources directly (type stripping); the hook below
// only adds the ".ts" the sources leave off their imports.
import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
      try { return next(`${specifier}.ts`, context); } catch { /* fall through */ }
    }
    return next(specifier, context);
  },
});

const { createBitmap, drawText } = await import("../src/glasses/bitmap.ts");
const { DOSE_BAR, METER, dosePercent, drawDoseBar, drawMeter } = await import("../src/glasses/gauge.ts");
const { buildView } = await import("../src/glasses/view.ts");
const { DEFAULT_DOSE } = await import("../src/noise/dose.ts");

const W = 576, H = 288, GAP = 6;
const ascii = (text) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "SS");

function screen(view, images) {
  const bitmap = createBitmap(W, H);
  const put = (image, x, y) => { for (let row = 0; row < image.height; row += 1) for (let col = 0; col < image.width; col += 1) { const v = image.pixels[row * image.width + col]; if (v) bitmap.pixels[(y + row) * W + x + col] = v; } };
  for (const { bitmap: image, x, y } of images) put(image, x, y);
  drawText(bitmap, ascii(view.header), 4, 10, 2, 15);
  view.body.forEach((line, index) => drawText(bitmap, ascii(line), 108, 44 + index * 25, 2, 15));
  drawText(bitmap, ascii(view.footer), 4, 264, 2, 15);
  return bitmap;
}

function png(screens) {
  const height = screens.length * H + (screens.length - 1) * GAP;
  const raw = Buffer.alloc((W * 3 + 1) * height);
  screens.forEach((bitmap, index) => {
    for (let y = 0; y < H; y += 1) {
      const row = (index * (H + GAP) + y) * (W * 3 + 1);
      for (let x = 0; x < W; x += 1) { const level = bitmap.pixels[y * W + x]; raw[row + 1 + x * 3 + 1] = level * 17; raw[row + 1 + x * 3] = level * 4; }
    }
    if (index > 0) for (let y = index * (H + GAP) - GAP; y < index * (H + GAP); y += 1) raw.fill(60, y * (W * 3 + 1) + 1, (y + 1) * (W * 3 + 1));
  });
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes) => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, "ascii"); data.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(W, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const states = [
  { listening: false, level: null, fraction: 0.3 },
  { listening: true, level: 78, fraction: 0.46 },
  { listening: true, level: 94, fraction: 0.71 },
  { listening: true, level: 97, fraction: 1.12 },
];
const screens = states.map(({ listening, level, fraction }) => {
  const dose = { fraction, measuredSeconds: 3600, peakDb: level, startedAt: 0 };
  const view = buildView(dose, DEFAULT_DOSE, { listening, level, calibrated: true, locale: "de" });
  return screen(view, [
    { bitmap: drawMeter({ listening, level, criterionDb: DEFAULT_DOSE.criterionDb }), x: METER.x, y: METER.y },
    { bitmap: drawDoseBar(dosePercent(fraction)), x: DOSE_BAR.x, y: DOSE_BAR.y },
  ]);
});
writeFileSync(new URL("../docs/graphic-preview.png", import.meta.url), png(screens));
console.log(`docs/graphic-preview.png: ${screens.length} states`);

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
const { CHART, chartData, chartSummary, drawChart } = await import("../src/weather/chart.ts");
const { ICONS, drawWeatherIcons } = await import("../src/weather/icons.ts");
const { demoWeather } = await import("../src/rain/model.ts");

const W = 576, H = 288, GAP = 6;
const ascii = (text) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "SS");

function screen(view, images) {
  const bitmap = createBitmap(W, H);
  const put = (image, x, y) => { for (let row = 0; row < image.height; row += 1) for (let col = 0; col < image.width; col += 1) { const v = image.pixels[row * image.width + col]; if (v) bitmap.pixels[(y + row) * W + x + col] = v; } };
  for (const { bitmap: image, x, y } of images) put(image, x, y);
  drawText(bitmap, ascii(view.header), 4, 10, 2, 15);
  view.body.forEach((line, index) => drawText(bitmap, ascii(line), 108, 44 + index * 25, 2, 15));
  (view.side ?? []).forEach((line, index) => drawText(bitmap, ascii(line), CHART.x + CHART.width + 8, CHART.y + 8 + index * 25, 2, 15));
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

// Body lines as main.ts builds them for the German demo forecast (sample text; the graphics are the real thing).
const forecast = demoWeather(new Date("2026-10-07T13:20:00"));
const summary = chartSummary(forecast.hourly);
const side = ["Regenrisiko", `${summary.rain}% ${forecast.hourly.find((h) => h.precipitationProbability === summary.rain).time.slice(11, 16)}`, `${summary.high}° / ${summary.low}°`];
const footer = "Tippen: neu · Wischen: Ansicht · 2x: Ende";
const views = [
  { page: 0, view: { header: "RAINLENS  JETZT  HALLEIN", body: ["BEWÖLKT  15°", "Gefühlt 14°   Feuchte 72%", "Wind SW 14 km/h   Böen 24", "Max / Min 18° / 8°"], side, footer } },
  { page: 1, view: { header: "RAINLENS  STUNDEN  HALLEIN", body: forecast.hourly.filter((_, i) => i % 3 === 0).map((h) => `${h.time.slice(11, 16)}  ${Math.round(h.temperature)}°  ${h.precipitationProbability}%`), side, footer } },
  { page: 2, view: { header: "RAINLENS  3 TAGE  HALLEIN", body: ["MI.  18° / 8°   Regen      75%", "DO.  19° / 9°   Bewölkt    25%", "FR.  20° / 10°  Klar       10%", "Sonne 07:08 - 18:42"], side, footer } },
  { page: -1, view: { header: "RAINLENS", body: ["Kein Standort.", "Erlaube den Standort in der Even-App", "oder gib am Handy einen Ort ein.", "Tippen = nochmal versuchen"], side: [], footer } },
];
const screens = views.map(({ page, view }) => screen(view, [
  { bitmap: drawWeatherIcons(forecast, page), x: ICONS.x, y: ICONS.y },
  ...(page < 0 ? [] : [{ bitmap: drawChart(chartData(forecast.hourly, "JETZT")), x: CHART.x, y: CHART.y }]),
]));
writeFileSync(new URL("../docs/graphic-preview.png", import.meta.url), png(screens));
console.log(`docs/graphic-preview.png: ${screens.length} states`);

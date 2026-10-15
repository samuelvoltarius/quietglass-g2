// Renders docs/cockpit-preview.png: the cockpit view in three states, drawn
// with the app's own pure code and the fallback text backend (5 x 7 pixel
// font; on the glasses the same layout uses the phone's bold sans).
//
//   node scripts/cockpit-preview.mjs
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

const { cockpitModel } = await import("../src/cockpit/model.ts");
const { composeCockpit } = await import("../src/cockpit/compose.ts");
const { pixelBackend } = await import("../src/screen/text.ts");
const { demoWeather } = await import("../src/rain/model.ts");
const { tr } = await import("../src/i18n.ts");
const { messages } = await import("../src/messages.ts");
const { cockpitMap, cockpitRing, cockpitPlace } = await import("../src/radar/cockpit-map.ts");
const { syntheticRadar } = await import("../src/radar/load.ts");

const W = 576, H = 288, GAP = 6;
const now = new Date("2026-10-07T13:20:00");
const position = { latitude: 47.8095, longitude: 13.055 };
const backend = pixelBackend();
const t = (locale) => (key, vars = {}) => tr(messages, locale, key, vars);
const live = { ...demoWeather(now), source: "live" };
const radar = syntheticRadar(position, now.valueOf(), 7, "de");
const last = radar.frames.length - 1;

const states = [
  // Private build: radar on the left, newest frame, a yellow storm warning.
  cockpitModel({ forecast: live, now: now.valueOf(), t: t("de"), locale: "de", notice: null, warning: { type: "wind", level: 1, start: now.valueOf(), end: now.valueOf() + 6 * 3_600_000 }, gustLimit: null,
    place: cockpitPlace(position, "de") ?? "", map: cockpitMap(position, radar, last, "de"), ring: cockpitRing(position), frameTimes: radar.frames.map((f) => f.time * 1000), shownFrame: last }),
  // Mid-loop (frame 2), English, no warning.
  cockpitModel({ forecast: live, now: now.valueOf(), t: t("en"), locale: "en", notice: null, warning: null, gustLimit: null,
    place: cockpitPlace(position, "en") ?? "", map: cockpitMap(position, radar, 2, "en"), ring: cockpitRing(position), frameTimes: radar.frames.map((f) => f.time * 1000), shownFrame: 2 }),
  // Public build: no radar, the weather pictogram; the gust alert is on (20 km/h).
  cockpitModel({ forecast: live, now: now.valueOf(), t: t("de"), locale: "de", notice: null, warning: undefined, gustLimit: 20, place: "Salzburg" }),
];
const screens = states.map((model) => composeCockpit(model, backend));

function png(frames) {
  const height = frames.length * H + (frames.length - 1) * GAP;
  const raw = Buffer.alloc((W * 3 + 1) * height);
  frames.forEach((frame, index) => {
    for (let y = 0; y < H; y += 1) {
      const row = (index * (H + GAP) + y) * (W * 3 + 1);
      for (let x = 0; x < W; x += 1) { const level = frame.pixels[y * W + x]; raw[row + 1 + x * 3 + 1] = level * 17; raw[row + 1 + x * 3] = level * 4; }
    }
    if (index > 0) for (let y = index * (H + GAP) - GAP; y < index * (H + GAP); y += 1) raw.fill(60, y * (W * 3 + 1) + 1, (y + 1) * (W * 3 + 1));
  });
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes) => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, "ascii"); data.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(W, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

writeFileSync(new URL("../docs/cockpit-preview.png", import.meta.url), png(screens));
console.log(`docs/cockpit-preview.png: ${screens.length} states`);

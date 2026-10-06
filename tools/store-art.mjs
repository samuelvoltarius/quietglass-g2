#!/usr/bin/env node
/**
 * Generates the Even Hub store art for each Quietglass app, from plain pixel
 * definitions and with Node built-ins only (zlib for the PNG encoding).
 *
 * Per app, into apps/<app>/store/:
 *   icon.png        1024×1024  greyscale, the app's pixel icon scaled up with
 *                              nearest-neighbour on a black background
 *   icon-24.png     24×24      the same icon at an integer scale, pure black
 *                              and white (the portal's "monochrome" app icon)
 *   background.png  1920×1080  calm dark gradient, icon, name and tagline
 *   tagline.txt     English tagline (line 1) and German tagline (line 2),
 *                   each at most 60 characters (the portal's limit)
 *   README.md       what the files are and where the screenshot lives
 *
 * Every pixel is written as RGB with R = G = B, so the art is strictly
 * greyscale whatever the viewer does with colour types.
 *
 * Where an app already draws a pixel icon in its source, the icon is read
 * from that file so the store art cannot drift from what the glasses show.
 *
 *   node tools/store-art.mjs                    all apps
 *   node tools/store-art.mjs rain-lens cadence  only these
 *   node tools/store-art.mjs --icon 512 --small 32 --bg 1280x720
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAGLINE_MAX = 60;
const NAME_MAX = 20;

// ---------------------------------------------------------------------------
// Per-app definitions. `icon` is either { file, name } (read from source) or
// an inline pattern of "#" (lit) and "." (dark) rows.

const APPS = {
  "agent-glass": {
    name: "Agent Glass",
    tagline: ["Watch and answer your coding agent from your glasses.", "Deinen Coding-Agenten auf der Brille verfolgen und steuern."],
    icon: [
      "############",
      "#..........#",
      "#.#........#",
      "#..#.......#",
      "#...#......#",
      "#..#.......#",
      "#.#........#",
      "#..........#",
      "#.....####.#",
      "#..........#",
      "############",
    ],
  },
  "babel-glass": {
    name: "Babel Glass",
    tagline: ["Live captions and translation in your field of view.", "Live-Untertitel und Übersetzung direkt im Blickfeld."],
    icon: [
      ".##########.",
      "#..........#",
      "#.########.#",
      "#..........#",
      "#.#####....#",
      "#..........#",
      ".##.#######.",
      "..#.#.......",
      "..##........",
      "..#.........",
    ],
  },
  cadence: {
    name: "Cadence",
    tagline: ["A visual metronome and practice log for musicians.", "Visuelles Metronom und Übungsprotokoll für Musiker."],
    icon: { file: "src/main.ts", name: "PIXEL_ICON" },
  },
  "decibel-guard": {
    name: "DecibelGuard",
    tagline: ["Sound level and daily noise dose. Nothing is recorded.", "Lautstärke und Lärmdosis im Blick. Nichts wird aufgenommen."],
    icon: { file: "src/glasses/gauge.ts", name: "SPEAKER" },
  },
  "endurance-hud": {
    name: "Endurance HUD",
    tagline: ["Live pace, power and heart rate for runs and rides.", "Pace, Leistung und Puls live beim Laufen und Radfahren."],
    // A bicycle, redrawn for 24 px: the app's run figure is too close to
    // PostureLens's standing figure, and its bike pictogram blurs at this size.
    icon: [
      "...##...##..",
      "....#...#...",
      "....#####...",
      ".###.#..###.",
      "#...#.##...#",
      "#...##.#...#",
      "#...#..#...#",
      ".###....###.",
    ],
  },
  "field-log": {
    name: "FieldLog",
    tagline: ["Hands-free inspection notes: dictate, rate, photograph.", "Inspektionsnotizen freihändig: diktieren, bewerten, Fotos."],
    icon: [
      "....####....",
      ".###....###.",
      ".#.######.#.",
      ".#........#.",
      ".#......#.#.",
      ".#.#...#..#.",
      ".#..#.#...#.",
      ".#...#....#.",
      ".#........#.",
      ".##########.",
    ],
  },
  flowlist: {
    name: "FlowList",
    tagline: ["Step-by-step checklists, one step at a time.", "Checklisten Schritt für Schritt, immer nur ein Schritt."],
    icon: [
      "###.........",
      "###.########",
      "###.........",
      "............",
      "###.........",
      "#.#.########",
      "###.........",
      "............",
      "###.........",
      "#.#.#######.",
      "###.........",
    ],
  },
  "lumen-glass": {
    name: "Lumen Glass",
    tagline: ["Your LUMEN moth in view: quests, light and photos.", "Deine LUMEN-Motte im Blick: Quests, Licht und Fotos."],
    // A moth: antennae, body, two pairs of wings. Not the app's in-source
    // PIXEL_ICON, which is the "unreachable" X shown on errors.
    icon: [
      "..#......#..",
      "...#....#...",
      "##..#..#..##",
      "###..##..###",
      "####.##.####",
      ".###.##.###.",
      "..##.##.##..",
      "...#.##.#...",
      "..##.##.##..",
      ".###.##.###.",
      ".##..##..##.",
    ],
  },
  "market-glance": {
    name: "Market Glance",
    tagline: ["Read-only Polymarket and Kalshi positions at a glance.", "Polymarket- und Kalshi-Positionen auf einen Blick."],
    icon: [
      "..........##",
      "..........##",
      ".......##.##",
      ".......##.##",
      "....##.##.##",
      "....##.##.##",
      ".##.##.##.##",
      ".##.##.##.##",
      ".##.##.##.##",
      ".##.##.##.##",
      "############",
    ],
  },
  nextstop: {
    name: "NextStop",
    tagline: ["Departures nearby and your next stop while riding.", "Abfahrten in der Nähe und die nächste Station unterwegs."],
    icon: [
      ".##########.",
      "#..........#",
      "#.########.#",
      "#.#......#.#",
      "#.#......#.#",
      "#.########.#",
      "#..........#",
      "#.##....##.#",
      "#..........#",
      ".##########.",
      ".##......##.",
    ],
  },
  podcaption: {
    name: "PodCaption",
    tagline: ["Podcast captions in time, right in your field of view.", "Podcast-Untertitel im Takt, direkt im Blickfeld."],
    icon: [
      "..#.........",
      "..###.......",
      "..#####.....",
      "..#######...",
      "..#####.....",
      "..###.......",
      "..#.........",
      "............",
      "############",
      "............",
      "########....",
    ],
  },
  "posture-lens": {
    name: "PostureLens",
    tagline: ["A quiet nudge when your head drifts forward.", "Ein leiser Hinweis, wenn der Kopf nach vorn sinkt."],
    icon: { file: "src/glasses/gauge.ts", name: "FIGURE" },
  },
  "rain-lens": {
    name: "RainLens",
    tagline: ["Rain chance, forecast and wind at a glance.", "Regenrisiko, Vorhersage und Wind auf einen Blick."],
    icon: { file: "src/weather/icons.ts", name: "rain" },
  },
  "shift-clock": {
    name: "ShiftClock",
    tagline: ["One-tap time tracking for projects and shifts.", "Zeiterfassung für Projekte und Schichten mit einem Tipp."],
    icon: [
      "....####....",
      "..##....##..",
      ".#........#.",
      ".#....#...#.",
      "#.....#....#",
      "#.....#....#",
      "#.....####.#",
      "#..........#",
      ".#........#.",
      ".#........#.",
      "..##....##..",
      "....####....",
    ],
  },
  "status-glass": {
    name: "Status Glass",
    tagline: ["Your servers' health and alerts on your glasses.", "Zustand und Warnungen deiner Server auf der Brille."],
    icon: [
      "....#.......",
      "....#.......",
      "...#.#......",
      "...#.#......",
      "##.#.#...###",
      "..#..#..#...",
      ".....#..#...",
      "......##....",
    ],
  },
};

// ---------------------------------------------------------------------------
// 5×7 pixel font, upper case only (text is drawn upper case).

const FONT = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  0: [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  1: ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  2: [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  3: ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  4: ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  5: ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  6: ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  7: ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  8: [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  9: [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  ",": [".....", ".....", ".....", ".....", ".##..", "..#..", ".#..."],
  "'": ["..#..", "..#..", ".#...", ".....", ".....", ".....", "....."],
  "-": [".....", ".....", ".....", ".###.", ".....", ".....", "....."],
  ":": [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
  "/": ["....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."],
  "&": [".##..", "#..#.", "#.#..", ".#...", "#.#.#", "#..#.", ".##.#"],
  "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
  "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
  "(": ["...#.", "..#..", ".#...", ".#...", ".#...", "..#..", "...#."],
  ")": [".#...", "..#..", "...#.", "...#.", "...#.", "..#..", ".#..."],
  "+": [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
  "%": ["##...", "##..#", "...#.", "..#..", ".#...", "#..##", "...##"],
};

// ---------------------------------------------------------------------------
// Greyscale canvas and PNG encoding.

function canvas(width, height, value = 0) {
  return { width, height, data: new Uint8Array(width * height).fill(value) };
}

function fillRect(image, x, y, w, h, value) {
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  const x1 = Math.min(image.width, x + w), y1 = Math.min(image.height, y + h);
  for (let row = y0; row < y1; row++) image.data.fill(value, row * image.width + x0, row * image.width + x1);
}

function drawPattern(image, rows, x, y, scale, value) {
  rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      if (row[rx] === "#") fillRect(image, x + rx * scale, y + ry * scale, scale, scale, value);
    }
  });
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), payload]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** 8-bit RGB PNG with R = G = B for every pixel. */
function encodePng(image) {
  const { width, height, data } = image;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x];
      const at = y * stride + 1 + x * 3;
      raw[at] = v; raw[at + 1] = v; raw[at + 2] = v;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;  // bit depth
  header[9] = 2;  // colour type: RGB
  header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Icons and text.

function loadIcon(app, source) {
  if (Array.isArray(source)) return normalise(source);
  const text = readFileSync(join(ROOT, "apps", app, source.file), "utf8");
  const match = new RegExp(`\\b${source.name}\\s*(?::[^=\\[]*)?[:=]\\s*\\[([^\\]]*)\\]`).exec(text);
  if (!match) throw new Error(`${app}: icon ${source.name} not found in ${source.file}`);
  const rows = [...match[1].matchAll(/"([.#]+)"/g)].map((m) => m[1]);
  if (rows.length === 0) throw new Error(`${app}: icon ${source.name} is empty`);
  return normalise(rows);
}

/** Pads rows to one width and crops to the lit pixels. */
function normalise(rows) {
  const width = Math.max(...rows.map((row) => row.length));
  const padded = rows.map((row) => row.padEnd(width, "."));
  const lit = (row) => row.includes("#");
  const top = padded.findIndex(lit);
  const bottom = padded.length - 1 - [...padded].reverse().findIndex(lit);
  let left = width, right = -1;
  for (const row of padded) {
    const first = row.indexOf("#"), last = row.lastIndexOf("#");
    if (first >= 0) { left = Math.min(left, first); right = Math.max(right, last); }
  }
  return padded.slice(top, bottom + 1).map((row) => row.slice(left, right + 1));
}

const iconSize = (rows) => ({ w: rows[0].length, h: rows.length });

/** Draws `rows` at the largest integer scale that fits `box`, centred on (cx, cy). */
function drawIconFit(image, rows, cx, cy, box, value) {
  const { w, h } = iconSize(rows);
  const scale = Math.max(1, Math.floor(box / Math.max(w, h)));
  drawPattern(image, rows, Math.round(cx - (w * scale) / 2), Math.round(cy - (h * scale) / 2), scale, value);
  return { scale, width: w * scale, height: h * scale };
}

function textWidth(text, scale) {
  return text.length === 0 ? 0 : text.length * 6 * scale - scale;
}

function drawText(image, text, x, y, scale, value) {
  [...text.toUpperCase()].forEach((char, index) => {
    const glyph = FONT[char];
    if (!glyph) throw new Error(`no glyph for ${JSON.stringify(char)} in "${text}"`);
    drawPattern(image, glyph, x + index * 6 * scale, y, scale, value);
  });
}

/** Largest scale ≤ max at which `text` fits in `width`. */
function fitScale(text, width, max) {
  for (let scale = max; scale > 1; scale--) if (textWidth(text, scale) <= width) return scale;
  return 1;
}

// ---------------------------------------------------------------------------
// The three images.

function makeIcon(rows, size) {
  const image = canvas(size, size, 0);
  drawIconFit(image, rows, size / 2, size / 2, Math.round(size * 0.62), 255);
  return image;
}

/** Pure black and white; integer scale so every source pixel stays a crisp block. */
function makeSmallIcon(rows, size) {
  const image = canvas(size, size, 0);
  drawIconFit(image, rows, size / 2, size / 2, size, 255);
  return image;
}

function makeBackground(rows, name, tagline, width, height) {
  const image = canvas(width, height);
  // Calm vertical gradient, near-black to dark grey.
  for (let y = 0; y < height; y++) fillRect(image, 0, y, width, 1, Math.round(14 + (y / (height - 1)) * 16));

  const unit = height / 1080;
  const iconBox = Math.round(300 * unit);
  const nameScale = fitScale(name, width * 0.8, Math.max(2, Math.round(14 * unit)));
  const tagScale = fitScale(tagline, width * 0.9, Math.max(2, Math.round(5 * unit)));
  const { h } = iconSize(rows);
  const iconScale = Math.max(1, Math.floor(iconBox / Math.max(...Object.values(iconSize(rows)))));
  const iconHeight = h * iconScale;
  const gapA = Math.round(80 * unit), gapB = Math.round(48 * unit);
  const total = iconHeight + gapA + 7 * nameScale + gapB + 7 * tagScale;
  let y = Math.round((height - total) / 2);

  drawIconFit(image, rows, width / 2, y + iconHeight / 2, iconBox, 235);
  y += iconHeight + gapA;
  drawText(image, name, Math.round((width - textWidth(name, nameScale)) / 2), y, nameScale, 245);
  y += 7 * nameScale + gapB;
  drawText(image, tagline, Math.round((width - textWidth(tagline, tagScale)) / 2), y, tagScale, 165);

  const brand = "QUIETGLASS";
  const brandScale = Math.max(1, Math.round(3 * unit));
  drawText(image, brand, Math.round((width - textWidth(brand, brandScale)) / 2), height - Math.round(70 * unit) - 7 * brandScale, brandScale, 90);
  return image;
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { icon: 1024, small: 24, bg: [1920, 1080], apps: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--icon") options.icon = Number(argv[++i]);
    else if (arg === "--small") options.small = Number(argv[++i]);
    else if (arg === "--bg") options.bg = String(argv[++i]).split("x").map(Number);
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else options.apps.push(arg);
  }
  if (options.apps.length === 0) options.apps = Object.keys(APPS);
  return options;
}

function check(app, def) {
  if (def.name.length > NAME_MAX) throw new Error(`${app}: name longer than ${NAME_MAX}`);
  def.tagline.forEach((line) => {
    if ([...line].length > TAGLINE_MAX) throw new Error(`${app}: tagline over ${TAGLINE_MAX} chars: ${line}`);
  });
}

function readme(app, def, options) {
  return `# ${def.name} — store assets

Generated by \`node tools/store-art.mjs ${app}\` — edit the definition there and
regenerate rather than editing these files.

| File | Size | Notes |
|---|---|---|
| \`icon.png\` | ${options.icon}×${options.icon} | Greyscale (R = G = B), pixel icon on black |
| \`icon-24.png\` | ${options.small}×${options.small} | Monochrome: only black and white pixels |
| \`background.png\` | ${options.bg[0]}×${options.bg[1]} | Greyscale, name and tagline |
| \`tagline.txt\` | — | Line 1 English, line 2 German, each ≤ ${TAGLINE_MAX} characters |

Screenshot: the simulator capture is kept at [\`../docs/screenshot.png\`](../docs/screenshot.png)
and is not duplicated here.
`;
}

const options = parseArgs(process.argv.slice(2));
for (const app of options.apps) {
  const def = APPS[app];
  if (!def) throw new Error(`unknown app ${app}; known: ${Object.keys(APPS).join(", ")}`);
  check(app, def);
  const rows = loadIcon(app, def.icon);
  const out = join(ROOT, "apps", app, "store");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "icon.png"), encodePng(makeIcon(rows, options.icon)));
  writeFileSync(join(out, "icon-24.png"), encodePng(makeSmallIcon(rows, options.small)));
  writeFileSync(join(out, "background.png"), encodePng(makeBackground(rows, def.name, def.tagline[0], options.bg[0], options.bg[1])));
  writeFileSync(join(out, "tagline.txt"), `${def.tagline[0]}\n${def.tagline[1]}\n`);
  writeFileSync(join(out, "README.md"), readme(app, def, options));
  console.log(`${app}: icon ${iconSize(rows).w}×${iconSize(rows).h} px source -> ${out}`);
}

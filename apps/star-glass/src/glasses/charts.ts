import { DIM, FULL, MID, createBitmap, drawPattern, drawText, fillRect, line, setPixel, strokeRect, textWidth, type Bitmap } from "./gfx";

/**
 * Every picture on the glasses as a pure function of its inputs: the same
 * values always give the same bitmap, so nothing is resent unless it changed.
 */

/** Exposure ring at the left of the overview. */
export const RING_SIZE = 144;
/** Metric panel (big value + sparkline) on the guiding page. */
export const PANEL_WIDTH = 288;
export const PANEL_HEIGHT = 106;
/** Preview of the newest frame. */
export const PREVIEW_WIDTH = 288;
export const PREVIEW_HEIGHT = 144;
/** The telescope sign in the top-right corner of the header. */
export const ICON_WIDTH = 64;
export const ICON_HEIGHT = 30;

const RING_OUTER = 69;
const RING_INNER = 56;

/**
 * Exposure ring: fills clockwise from the top as the frame is exposed, the
 * seconds left in large pixel digits inside, the frame length below. Without
 * an exposure the ring is a dim track with "--".
 */
export function ringFrame(percent: number | null, remainingSeconds: number | null, totalSeconds: number | null, size = RING_SIZE): Bitmap {
  const b = createBitmap(size, size);
  const value = percent === null ? null : Math.max(0, Math.min(100, Math.round(percent)));
  const c = (size - 1) / 2;
  const sweep = ((value ?? 0) / 100) * Math.PI * 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - c;
      const dy = y - c;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r < RING_INNER || r > RING_OUTER) continue;
      let angle = Math.atan2(dx, -dy);
      if (angle < 0) angle += Math.PI * 2;
      b.pixels[y * size + x] = value !== null && (value >= 100 || angle <= sweep) ? FULL : DIM;
    }
  }
  const big = remainingSeconds === null ? "--" : countdown(remainingSeconds);
  let scale = 5;
  while (scale > 2 && textWidth(big, scale) > (RING_INNER - 6) * 2) scale -= 1;
  const small = totalSeconds === null ? "" : `${Math.round(totalSeconds)} S`;
  const smallScale = 2;
  const height = 7 * scale + (small ? 6 + 7 * smallScale : 0);
  const top = Math.round((size - height) / 2);
  drawText(b, big, Math.round((size - textWidth(big, scale)) / 2), top, scale);
  if (small) drawText(b, small, Math.round((size - textWidth(small, smallScale)) / 2), top + 7 * scale + 6, smallScale, MID);
  return b;
}

/** "2:13" below an hour, "75" for plain seconds under a minute. */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return String(s);
  if (s >= 3600) return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}H`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export interface PanelSpec {
  /** Short label in pixel letters, e.g. "RMS". */
  readonly label: string;
  /** The value already formatted ("0,62"), or null for "--". */
  readonly value: string | null;
  /** Unit drawn small after the value ('"', "PX"). */
  readonly unit: string;
  readonly series: readonly number[];
  /** Dotted line at this value (a limit), if inside the range. */
  readonly mark?: number;
  /** Lowest upper end of the vertical scale, so small noise does not look dramatic. */
  readonly minSpan?: number;
  /** Frame the panel: something is wrong with this value. */
  readonly alarm?: boolean;
}

/**
 * Big value with its label on top, the last readings as a line chart below.
 * The newest reading is the dot at the right edge.
 */
export function panelFrame(spec: PanelSpec, width = PANEL_WIDTH, height = PANEL_HEIGHT): Bitmap {
  const b = createBitmap(width, height);
  drawText(b, spec.label, 2, 2, 2, MID);
  const value = spec.value ?? "--";
  const valueScale = 6;
  const vx = 2 + textWidth(spec.label, 2) + 14;
  drawText(b, value, vx, 2, valueScale, FULL);
  if (spec.unit) drawText(b, spec.unit, vx + textWidth(value, valueScale) + 6, 2 + 7 * valueScale - 14, 2, MID);
  if (spec.alarm) strokeRect(b, 0, 0, width, height, FULL, 2);

  const top = 54;
  const bottom = height - 5;
  const left = 4;
  const right = width - 6;
  fillRect(b, left, bottom + 1, right - left + 1, 1, DIM);
  const values = spec.series;
  if (values.length === 0) {
    for (let x = left; x <= right; x += 6) fillRect(b, x, Math.round((top + bottom) / 2), 3, 1, DIM);
    return b;
  }
  let low = Math.min(...values, ...(spec.mark === undefined ? [] : [spec.mark]));
  let high = Math.max(...values, ...(spec.mark === undefined ? [] : [spec.mark]));
  const span = spec.minSpan ?? 0.2;
  if (high - low < span) {
    const middle = (high + low) / 2;
    low = middle - span / 2;
    high = middle + span / 2;
  }
  const y = (v: number): number => bottom - ((v - low) / (high - low)) * (bottom - top);
  if (spec.mark !== undefined) {
    const my = Math.round(y(spec.mark));
    for (let x = left; x <= right; x += 5) fillRect(b, x, my, 2, 1, DIM);
  }
  const step = values.length > 1 ? (right - left) / (values.length - 1) : 0;
  const pts = values.map((v, i) => ({ x: values.length > 1 ? left + i * step : right, y: y(v) }));
  for (let i = 1; i < pts.length; i += 1) line(b, pts[i - 1]!.x, pts[i - 1]!.y, pts[i]!.x, pts[i]!.y, FULL, 2);
  const tip = pts[pts.length - 1]!;
  fillRect(b, tip.x - 2, tip.y - 2, 5, 5, FULL);
  return b;
}

// ---- the telescope sign --------------------------------------------------

/** What the telescope shows: exposing (twinkling star, light falling in), idle, a problem, no connection. */
export type Mood = "working" | "idle" | "error" | "offline";

/** One animation step every 600 ms. */
export const ICON_STEP_MS = 600;

const SCOPE = [
  "..................",
  "..................",
  "...........##.....",
  ".........####.....",
  ".......#####......",
  ".....#####........",
  "...###.#..........",
  "......#.#.........",
  ".....#...#........",
];

/**
 * The 64 x 30 sign: an 18 x 9 telescope pattern scaled by three. Working: the
 * star top right twinkles and three dots at the bottom right fill up like a
 * small progress bar.
 * Idle: a calm dim star. Error: a pulsing "!" in place of the star. Offline: a
 * small "z". Depends only on (mood, now) — testable.
 */
export function telescopeFrame(mood: Mood, now: number): Bitmap {
  const rows = SCOPE.map((row) => row.split(""));
  const put = (x: number, y: number, c: string): void => {
    const row = rows[y];
    if (row && x >= 0 && x < row.length) row[x] = c;
  };
  const phase = Math.floor(now / ICON_STEP_MS) % 4;
  switch (mood) {
    case "working": {
      const bright = phase % 2 === 0;
      // Star at (15, 1): a cross when bright, a dot with dim arms otherwise.
      put(15, 1, "#");
      put(14, 1, bright ? "#" : "-"); put(16, 1, bright ? "#" : "-");
      put(15, 0, bright ? "#" : "-"); put(15, 2, bright ? "#" : "-");
      // Three dots filling up: 0, 1, 2, 3 lit.
      [12, 14, 16].forEach((x, i) => put(x, 7, i < phase ? "#" : "-"));
      break;
    }
    case "idle":
      put(15, 1, "+");
      break;
    case "error": {
      const on = phase % 2 === 0;
      for (let y = 0; y <= 3; y += 1) put(15, y, on ? "#" : "+");
      put(15, 5, on ? "#" : "+");
      break;
    }
    case "offline":
      for (const [x, y] of [[13, 0], [14, 0], [15, 0], [14, 1], [13, 2], [14, 2], [15, 2]] as Array<[number, number]>) put(x, y, "-");
      break;
  }
  const b = createBitmap(ICON_WIDTH, ICON_HEIGHT);
  const pattern = rows.map((row) => row.join(""));
  const scale = 3;
  drawPattern(b, pattern, Math.floor((ICON_WIDTH - 18 * scale) / 2), Math.floor((ICON_HEIGHT - 9 * scale) / 2), scale);
  return b;
}

// ---- demo sky ----------------------------------------------------------------

function prng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A stand-in for the newest frame in demo mode: a tilted galaxy with a bright
 * core and a few hundred stars, 4:3 inside the 288 x 144 box. Repeatable per seed.
 */
export function starField(seed: number, width = PREVIEW_WIDTH, height = PREVIEW_HEIGHT): Bitmap {
  const b = createBitmap(width, height);
  const w = Math.round((height * 4) / 3);
  const ox = Math.floor((width - w) / 2);
  const rnd = prng(20261013);
  const jitter = prng(seed);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = (x - w / 2) / w;
      const dy = (y - height / 2) / height;
      const u = dx * Math.cos(0.6) + dy * Math.sin(0.6);
      const v = -dx * Math.sin(0.6) + dy * Math.cos(0.6);
      const r = Math.sqrt((u / 0.42) ** 2 + (v / 0.12) ** 2);
      const glow = Math.max(0, 1 - r) ** 2 * 150 + Math.max(0, 1 - r * 6) * 105;
      b.pixels[y * width + x + ox] = Math.min(255, Math.round(8 + glow));
    }
  }
  for (let i = 0; i < 260; i += 1) {
    const sx = ox + rnd() * w;
    const sy = rnd() * height;
    const bright = rnd() ** 3;
    const peak = Math.round(110 + bright * 145 - jitter() * 10);
    setPixel(b, sx, sy, Math.max(peak, b.pixels[Math.round(sy) * width + Math.round(sx)] ?? 0));
    if (bright > 0.35) for (const [ddx, ddy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Array<[number, number]>) setPixel(b, sx + ddx, sy + ddy, Math.round(peak * 0.6));
  }
  return b;
}

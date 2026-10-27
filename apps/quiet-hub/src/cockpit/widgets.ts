import type { Frame } from "../screen/frame";
import { arrow, circle, dashedLine, fillCircle, fillRect, line, pattern, strokeRect, triangle } from "../screen/draw";
import { drawText, fitFont, type TextBackend } from "../screen/text";

/**
 * Pictures of the standalone apps, for the hub's pages (QUS v1, same Frame / draw / text as everywhere):
 * the battery ring of BYD Glass, the segment ring of Status Glass, the weather pictograms of Rain Lens,
 * plus a lamp and a printer drawn the same way. Pure functions of the frame, the values and `now`.
 *
 * Animations (only where something is going on): a charging ring pulses, a printing ring has a bright
 * marker running round it. Both change once per MASCOT_STEP_MS, so only the tiles they touch are sent.
 */

/** Tone of the standalone apps: calm, warning, critical, no data. */
export type Tone = "ok" | "warn" | "critical" | "offline";
export const W_LEVELS = { text: 15, label: 8, dim: 4, grid: 3, ok: 11, strong: 15, faint: 5 } as const;
const CENTER_SIZES = [56, 48, 42, 36, 30, 26, 22, 18] as const;

interface ArcStyle { readonly level: number; readonly dash: number; readonly gap: number }

/** How a fill looks: fine = calm solid, warning = bright dashes, critical = solid bright, offline = faint dots (BYD Glass). */
export function arcStyle(tone: Tone): ArcStyle {
  switch (tone) {
    case "ok": return { level: W_LEVELS.ok, dash: 1, gap: 0 };
    case "warn": return { level: W_LEVELS.strong, dash: 9, gap: 5 };
    case "critical": return { level: W_LEVELS.strong, dash: 1, gap: 0 };
    case "offline": return { level: W_LEVELS.faint, dash: 2, gap: 5 };
  }
}

/** The fill sweep in radians for a percentage. */
export function sweepFor(percent: number): number {
  return (Math.max(0, Math.min(100, percent)) / 100) * Math.PI * 2;
}

/** A stroke along a ring from angle `from` to `to` (radians, 0 = up, clockwise). */
function arc(frame: Frame, cx: number, cy: number, from: number, to: number, radius: number, thickness: number, style: ArcStyle): void {
  const steps = Math.max(1, Math.ceil((to - from) * radius));
  const offset = Math.floor(thickness / 2);
  for (let step = 0; step <= steps; step += 1) {
    if (style.gap > 0 && step % (style.dash + style.gap) >= style.dash) continue;
    const angle = from + ((to - from) * step) / steps;
    fillRect(frame, Math.round(cx + Math.sin(angle) * radius) - offset, Math.round(cy - Math.cos(angle) * radius) - offset, thickness, thickness, style.level);
  }
}

/** Animation step: changes every 500 ms (the mascot's beat). */
export function beat(now: number): number {
  return Math.floor(now / 500);
}

export interface RingOptions {
  /** Charging: the fill pulses between calm and bright. */
  readonly pulse?: boolean;
  /** Working (printing): a bright marker runs round the track. */
  readonly spin?: boolean;
}

/** A battery / progress ring: track, fill from twelve o'clock, optional pulse or running marker. */
export function drawRingAt(frame: Frame, cx: number, cy: number, outer: number, thickness: number, percent: number | null, tone: Tone, now: number, options: RingOptions = {}): void {
  const radius = outer - Math.floor(thickness / 2);
  circle(frame, cx, cy, radius, W_LEVELS.dim, { dash: 1, gap: 0, thickness });
  if (percent === null) {
    circle(frame, cx, cy, radius, W_LEVELS.faint, { dash: 5, gap: 5, thickness: 2 });
  } else if (percent > 0) {
    const style = arcStyle(tone);
    const pulsed = options.pulse === true && beat(now) % 2 === 1 ? { ...style, level: W_LEVELS.strong } : style;
    arc(frame, cx, cy, 0, sweepFor(percent), radius, thickness, pulsed);
  }
  if (options.spin === true) {
    const at = (beat(now) % 12) * (Math.PI / 6);
    arc(frame, cx, cy, at, at + 0.3, radius, thickness + 2, { level: W_LEVELS.strong, dash: 1, gap: 0 });
  }
}

/** One segment per machine (Status Glass): ok calm, warn dashed, down bright, unknown faint. */
export function drawSegmentsAt(frame: Frame, cx: number, cy: number, outer: number, thickness: number, segments: readonly Tone[]): void {
  const radius = outer - Math.floor(thickness / 2);
  if (segments.length === 0) {
    circle(frame, cx, cy, radius, W_LEVELS.faint, { dash: 5, gap: 5, thickness: 2 });
    return;
  }
  const span = (Math.PI * 2) / segments.length;
  const gap = segments.length > 1 ? Math.min(0.12, span * 0.15) : 0;
  segments.forEach((tone, index) => {
    const style = tone === "critical" ? { level: W_LEVELS.strong, dash: 1, gap: 0 } : arcStyle(tone);
    arc(frame, cx, cy, index * span + gap, (index + 1) * span - gap, radius, tone === "critical" ? thickness + 2 : thickness, style);
  });
}

/** The big number in a ring's middle and a small line under it. */
export function drawRingText(frame: Frame, backend: TextBackend, cx: number, cy: number, inner: number, center: string, sub: string, sizes: readonly number[] = CENTER_SIZES): void {
  const font = fitFont(backend, center, { size: sizes[0] ?? 56, weight: 800 }, sizes, inner * 2 - 16);
  const subSize = font.size >= 36 ? 16 : 13;
  drawText(frame, backend, center, cx, cy - Math.round(font.size * 0.62), font, { align: "center", level: W_LEVELS.text });
  if (sub !== "") drawText(frame, backend, sub, cx, cy + Math.round(font.size * 0.36), { size: subSize, weight: 700 }, { align: "center", level: W_LEVELS.label, maxWidth: inner * 2 - 8 });
}

// ---- curve (Sugar Glass) -------------------------------------------------------------------------

/** The curve's box in the left half (Sugar Glass `SPARK`). */
export const SPARK = { left: 14, right: 274, top: 44, bottom: 192 } as const;

function sparkScale(points: readonly number[], band: { low: number; high: number }): (value: number) => number {
  const values = [...points, band.low, band.high];
  let min = Math.min(...values); let max = Math.max(...values);
  if (max - min < 1e-9) { min -= 1; max += 1; }
  const pad = (max - min) * 0.08; min -= pad; max += pad;
  return (value) => SPARK.top + Math.round(((max - value) / (max - min)) * (SPARK.bottom - SPARK.top));
}

/** Points of the curve: evenly across the box, oldest left (Sugar Glass `sparkPoints`). */
export function sparkPoints(points: readonly number[], band: { low: number; high: number }): { x: number; y: number }[] {
  if (points.length === 0) return [];
  const y = sparkScale(points, band);
  const width = SPARK.right - SPARK.left;
  return points.map((value, index) => ({ x: SPARK.left + (points.length === 1 ? width : Math.round((index * width) / (points.length - 1))), y: y(value) }));
}

/** Nightscout direction -> arrow bearing (0 = up, clockwise); undefined = no arrow. */
export function trendBearing(direction: string | undefined): number | undefined {
  switch (direction) {
    case "DoubleUp": case "SingleUp": return 0;
    case "FortyFiveUp": return 45;
    case "Flat": return 90;
    case "FortyFiveDown": return 135;
    case "SingleDown": case "DoubleDown": return 180;
    default: return undefined;
  }
}

/** The glucose curve with the target band, the newest point as a dot, highest / lowest marked, time ticks below. */
export function drawSpark(frame: Frame, backend: TextBackend, points: readonly number[], band: { low: number; high: number }, top: string, ticks: readonly string[], bearing?: number): void {
  const width = SPARK.right - SPARK.left;
  dashedLine(frame, SPARK.left, SPARK.bottom + 6, SPARK.right, SPARK.bottom + 6, W_LEVELS.grid, { dash: 3, gap: 3 });
  if (points.length > 0) {
    const y = sparkScale(points, band);
    const small = { size: 15, weight: 600 } as const;
    const high = Math.max(SPARK.top, y(band.high));
    const low = Math.min(SPARK.bottom, y(band.low));
    dashedLine(frame, SPARK.left, high, SPARK.right, high, W_LEVELS.dim, { dash: 2, gap: 4 });
    dashedLine(frame, SPARK.left, low, SPARK.right, low, W_LEVELS.dim, { dash: 2, gap: 4 });
    drawText(frame, backend, String(band.high), SPARK.left, Math.max(SPARK.top - 2, high - 18), small, { level: W_LEVELS.label, halo: true });
    drawText(frame, backend, String(band.low), SPARK.left, Math.min(SPARK.bottom - 14, low + 3), small, { level: W_LEVELS.label, halo: true });
  }
  const at = sparkPoints(points, band);
  if (at.length === 0) {
    dashedLine(frame, SPARK.left, (SPARK.top + SPARK.bottom) / 2, SPARK.right, (SPARK.top + SPARK.bottom) / 2, W_LEVELS.dim, { dash: 5, gap: 5, thickness: 2 });
  } else {
    for (let index = 1; index < at.length; index += 1) line(frame, at[index - 1]!.x, at[index - 1]!.y, at[index]!.x, at[index]!.y, W_LEVELS.strong, 2);
    const last = at[at.length - 1]!;
    fillCircle(frame, Math.min(last.x, SPARK.right - 3), last.y, 4, W_LEVELS.text);
    if (at.length > 2) {
      const iMax = points.indexOf(Math.max(...points)); const iMin = points.indexOf(Math.min(...points));
      const mark = (index: number, above: boolean): void => {
        if (iMax === iMin) return;
        const p = at[index]!;
        const text = String(points[index]);
        const w = backend.measure(text, { size: 15, weight: 700 });
        const x = Math.max(SPARK.left + 30, Math.min(SPARK.right - w - 22, p.x - Math.round(w / 2)));
        const yy = above ? Math.max(SPARK.top - 4, p.y - 20) : Math.min(SPARK.bottom - 12, p.y + 6);
        drawText(frame, backend, text, x, yy, { size: 15, weight: 700 }, { level: W_LEVELS.text, halo: true });
      };
      mark(iMax, true);
      mark(iMin, false);
    }
  }
  drawText(frame, backend, top, SPARK.left, 6, { size: 22, weight: 700 }, { level: W_LEVELS.label, maxWidth: width - 50 });
  if (bearing !== undefined) arrow(frame, SPARK.right - 18, 22, 30, bearing, W_LEVELS.text, 3);
  ticks.forEach((tick, index) => {
    const x = SPARK.left + Math.round((index * width) / Math.max(1, ticks.length - 1));
    const align = index === 0 ? "left" : index === ticks.length - 1 ? "right" : "center";
    line(frame, x, SPARK.bottom + 3, x, SPARK.bottom + 9, W_LEVELS.dim, 1);
    drawText(frame, backend, tick, x, SPARK.bottom + 10, { size: 15, weight: 600 }, { level: W_LEVELS.label, align });
  });
}

// ---- TV (TV Glance) -----------------------------------------------------------------------------

export type TvScreen = "playing" | "paused" | "idle" | "off" | "unknown";
const TV_BOX = { left: 44, right: 244, top: 12, bottom: 122, barTop: 180, barHeight: 16 } as const;
const BARS = { left: 16, right: 272 } as const;

/** The TV of TV Glance: outline with stand, play / pause / power sign on the screen, the volume bar below. */
export function drawTv(frame: Frame, backend: TextBackend, screen: TvScreen, volume: number | null, muted: boolean, volumeLabel: string, volumeText: string): void {
  const width = TV_BOX.right - TV_BOX.left; const height = TV_BOX.bottom - TV_BOX.top;
  const cx = Math.round((TV_BOX.left + TV_BOX.right) / 2); const cy = Math.round((TV_BOX.top + TV_BOX.bottom) / 2);
  const dark = screen === "off" || screen === "unknown";
  if (screen === "unknown") {
    const dash = { dash: 4, gap: 4, thickness: 3 };
    dashedLine(frame, TV_BOX.left, TV_BOX.top, TV_BOX.right, TV_BOX.top, W_LEVELS.dim, dash);
    dashedLine(frame, TV_BOX.left, TV_BOX.bottom, TV_BOX.right, TV_BOX.bottom, W_LEVELS.dim, dash);
    dashedLine(frame, TV_BOX.left, TV_BOX.top, TV_BOX.left, TV_BOX.bottom, W_LEVELS.dim, dash);
    dashedLine(frame, TV_BOX.right, TV_BOX.top, TV_BOX.right, TV_BOX.bottom, W_LEVELS.dim, dash);
  } else {
    strokeRect(frame, TV_BOX.left, TV_BOX.top, width, height, dark ? W_LEVELS.label : W_LEVELS.strong, 4);
  }
  fillRect(frame, cx - 6, TV_BOX.bottom + 2, 12, 9, dark ? W_LEVELS.dim : W_LEVELS.label);
  fillRect(frame, cx - 40, TV_BOX.bottom + 11, 80, 4, dark ? W_LEVELS.dim : W_LEVELS.label);
  if (screen === "playing") triangle(frame, cx + 4, cy, 26, 90, W_LEVELS.text);
  else if (screen === "paused") { fillRect(frame, cx - 20, cy - 24, 14, 48, W_LEVELS.text); fillRect(frame, cx + 6, cy - 24, 14, 48, W_LEVELS.text); }
  else if (screen === "idle") fillCircle(frame, cx, cy, 9, W_LEVELS.ok);
  else if (screen === "off") {
    circle(frame, cx, cy + 4, 22, W_LEVELS.label, { thickness: 4 });
    fillRect(frame, cx - 9, cy - 24, 18, 14, 0);
    fillRect(frame, cx - 2, cy - 26, 5, 28, W_LEVELS.label);
  }
  drawText(frame, backend, volumeLabel, BARS.left, TV_BOX.barTop - 26, { size: 15, weight: 700 }, { level: W_LEVELS.label, maxWidth: 150 });
  drawText(frame, backend, volumeText, BARS.right, TV_BOX.barTop - 34, { size: 28, weight: 800 }, { align: "right", level: volume === null ? W_LEVELS.label : W_LEVELS.text });
  const track = BARS.right - BARS.left;
  strokeRect(frame, BARS.left, TV_BOX.barTop, track, TV_BOX.barHeight, W_LEVELS.dim);
  if (volume !== null && !muted) fillRect(frame, BARS.left + 2, TV_BOX.barTop + 2, Math.round(((track - 4) * Math.max(0, Math.min(100, volume))) / 100), TV_BOX.barHeight - 4, W_LEVELS.ok);
  if (muted) dashedLine(frame, BARS.left + 4, TV_BOX.barTop + 8, BARS.right - 4, TV_BOX.barTop + 8, W_LEVELS.label, { dash: 3, gap: 4, thickness: 2 });
}

// ---- pictograms (12 x 12, Rain Lens style) -------------------------------------------------------

export type WeatherKind = "clear" | "cloud" | "fog" | "rain" | "snow" | "storm";

/** The weather pictograms of Rain Lens (`apps/rain-lens/src/weather/icons.ts`). */
export const WEATHER_PATTERNS: Readonly<Record<WeatherKind, readonly string[]>> = {
  clear: [".....##.....", "..#..##..#..", "...#....#...", "............", ".#...####...#", "....######..", "##..######..", "##..######..", "....######..", ".#...####...#", "...#....#...", "..#..##..#.."],
  cloud: ["............", "............", ".....####...", "...########.", "..##########", ".###########", "############", "############", "############", ".###########", "............", "............"],
  fog: ["............", "...######...", ".##########.", "############", "............", ".##########.", "............", "..########..", "............", ".##########.", "............", "............"],
  rain: ["............", ".....####...", "...########.", ".###########", "############", "############", "............", "..#...#...#.", ".##..##..##..", ".#...#...#...", "#...#...#...", "............"],
  snow: ["............", ".....####...", "...########.", ".###########", "############", "############", "............", ".#...#...#...", "..#.#.#.#...", ".###.###.###.", "..#...#...#.", "............"],
  storm: ["............", ".....####...", "...########.", ".###########", "############", "############", ".....##.....", "....###.....", "...#####....", ".....##.....", "....##......", "...##......."],
};

/** WMO code -> pictogram (Rain Lens `weatherKind`). */
export function weatherKind(code: number | null | undefined): WeatherKind {
  if (typeof code !== "number") return "cloud";
  if (code === 0 || code === 1) return "clear";
  if (code === 2 || code === 3) return "cloud";
  if (code === 45 || code === 48) return "fog";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";
  return "cloud";
}

/** A lamp: lit = rays round the bulb. */
export const LAMP_ON = ["#....##....#", ".#..####..#.", "...######...", "..########..", "#.########.#", "..########..", "...######...", "....####....", "....####....", ".....##.....", "....####....", "....####...."];
export const LAMP_OFF = ["............", "....####....", "...#....#...", "..#......#..", "..#......#..", "..#......#..", "...#....#...", "....#..#....", "....####....", ".....##.....", "....####....", "....####...."];
/** A printer (3D, gantry + plate). */
export const PRINTER = ["############", "#..........#", "#....##....#", "#....##....#", "#...####...#", "#..........#", "#..........#", "#.########.#", "#..........#", "############", "#..........#", "##........##"];
/** A plug / switch. */
export const PLUG = ["....#..#....", "....#..#....", "....#..#....", "..########..", ".##########.", ".##########.", ".##########.", "..########..", "...######...", ".....##.....", ".....##.....", ".....##....."];
/** A room (house). */
export const HOUSE = [".....##.....", "....####....", "...######...", "..########..", ".##########.", "############", ".##......##.", ".##......##.", ".##..##..##.", ".##..##..##.", ".##..##..##.", ".##########."];
/** A scene (star). */
export const STAR = [".....##.....", ".....##.....", "....####....", "############", ".##########.", "..########..", "...######...", "...######...", "..###..###..", "..##....##..", ".##......##.", "............"];
/** A thermometer (sensor). */
export const SENSOR = [".....##.....", "....#..#....", "....#..#....", "....#..#....", "....#..#....", "....####....", "....####....", "...######...", "..########..", "..########..", "...######...", "....####...."];
/** A blind (cover). */
export const BLIND = ["############", "#..........#", "############", "#..........#", "############", "#..........#", "############", "#..........#", "############", ".....##.....", ".....##.....", "............"];
/** A lock. */
export const LOCK = ["....####....", "...#....#...", "..#......#..", "..#......#..", "############", "############", "#####..#####", "#####..#####", "######.#####", "############", "############", "............"];
/** A TV with stand. */
export const TV = ["############", "#..........#", "#..........#", "#..........#", "#..........#", "#..........#", "#..........#", "############", ".....##.....", "....####....", "............", "............"];

/** A 12 x 12 pictogram at `scale` px per cell. */
export function drawPictogram(frame: Frame, rows: readonly string[], x: number, y: number, scale: number, level: number = W_LEVELS.text): void {
  pattern(frame, rows, x, y, scale, level);
}

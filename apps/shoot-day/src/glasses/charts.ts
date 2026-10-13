import { clockMinutes, type CallSheet } from "../api/types";
import type { Mode } from "./views";
import { DIM, FULL, MID, createBitmap, drawText, fillRect, iconBitmap, strokeRect, textWidth, type Bitmap } from "./gfx";

/** The sign sits in the top-right corner of the header. */
export const ICON_WIDTH = 64;
export const ICON_HEIGHT = 30;
/** The day bar on the schedule page (image containers are at least 20 px high). */
export const BAR_WIDTH = 288;
export const BAR_HEIGHT = 20;

/** One pulse per second: bright for 500 ms, dim for 500 ms. */
export const PULSE_MS = 500;

const SIGNS: Readonly<Record<Mode, readonly string[]>> = {
  menu: ["#.##.##.##", "##########", "#........#", "#........#", "#........#", "#........#", "##########"],
  takes: ["#.##.##.##", "##########", "#........#", "#........#", "#........#", "#........#", "##########"],
  prompter: ["##########", "..........", "######....", "..........", "########..", "..........", "#####....."],
  schedule: [".#######.", "#...#...#", "#...#...#", "#...#...#", "#...###.#", "#.......#", "#.......#", "#.......#", ".#######."],
  pack: ["..######..", ".#......#.", "##########", "#........#", "#..####..#", "#........#", "##########"],
};

/**
 * The header sign of the current page. While a take runs on the takes page it
 * is a recording dot that pulses at 1 Hz (bright half a second, dim the next).
 * Pure in (mode, rolling, now).
 */
export function headerIcon(mode: Mode, rolling: boolean, now: number): Bitmap {
  if (mode === "takes" && rolling) {
    const b = createBitmap(ICON_WIDTH, ICON_HEIGHT);
    const bright = Math.floor(now / PULSE_MS) % 2 === 0;
    const cx = ICON_WIDTH / 2;
    const cy = ICON_HEIGHT / 2;
    const r = 12;
    // Bright: a filled dot. Dim: only its outline, so the pulse stays visible whatever the gray levels do.
    for (let y = -r; y <= r; y += 1) {
      for (let x = -r; x <= r; x += 1) {
        const d = x * x + y * y;
        if (d <= r * r && (bright || d >= (r - 3) * (r - 3))) fillRect(b, cx + x, cy + y, 1, 1, bright ? FULL : MID);
      }
    }
    return b;
  }
  return iconBitmap(SIGNS[mode], ICON_WIDTH, ICON_HEIGHT);
}

/** Minutes of the day the bar spans: from the call time to the last entry. Null without any time. */
export function daySpan(sheet: CallSheet): { start: number; end: number } | null {
  const times = sheet.schedule.map((row) => clockMinutes(row.time)).filter((m): m is number => m !== null);
  const call = clockMinutes(sheet.call);
  const start = call ?? (times.length > 0 ? Math.min(...times) : null);
  if (start === null) return null;
  const last = Math.max(start, ...times);
  return { start, end: last > start ? last : start + 60 };
}

const clockText = (minutes: number): string =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * The shooting day as a bar from call time to the last entry: filled up to now,
 * a tick for every entry, a thick marker for "now", and the start and end time
 * below. Pure in (sheet, minutes of the day).
 */
export function dayBarFrame(sheet: CallSheet, nowMinutes: number): Bitmap | null {
  const span = daySpan(sheet);
  if (!span) return null;
  const b = createBitmap(BAR_WIDTH, BAR_HEIGHT);
  const left = 1;
  const right = BAR_WIDTH - 2;
  const x = (minutes: number): number =>
    Math.round(left + (Math.min(span.end, Math.max(span.start, minutes)) - span.start) / (span.end - span.start) * (right - left));

  strokeRect(b, left, 1, right - left + 1, 8, DIM);
  const nowX = x(nowMinutes);
  fillRect(b, left + 1, 3, Math.max(0, nowX - left - 1), 4, MID);
  for (const row of sheet.schedule) {
    const at = clockMinutes(row.time);
    if (at !== null) fillRect(b, x(at), 0, 1, 10, FULL);
  }
  const before = nowMinutes < span.start;
  const after = nowMinutes > span.end;
  fillRect(b, nowX - 1, 0, 3, 10, before || after ? MID : FULL);

  drawText(b, clockText(span.start), 0, 12, 1, MID);
  const end = clockText(span.end);
  drawText(b, end, BAR_WIDTH - textWidth(end, 1), 12, 1, MID);
  return b;
}

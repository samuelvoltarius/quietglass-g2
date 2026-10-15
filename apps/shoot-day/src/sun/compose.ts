import { createFrame, SCREEN_WIDTH, type Frame } from "../screen/frame";
import { bearing, circle, dashedLine, fillCircle, fillRect, line, plot } from "../screen/draw";
import { drawText, fitFont, type Font, type TextBackend } from "../screen/text";
import { compassPoint } from "./solar";
import type { LightModel } from "./model";

/**
 * The Light view on the glasses: the whole display as one frame (four tiles).
 *
 *   left (compass)                   right (the words)
 *   ┌──────────────────────┐ ┌─────────────────────────────────┐
 *   │          N           │ │ LICHT                     17:30 │
 *   │      ·   |   ·       │ │ GOLDENE STUNDE                  │
 *   │   W ─────┼───── O    │ │ in 42 min                       │
 *   │       ·  ╲  ·        │ │ 19:12–19:48                     │
 *   │          S ☀         │ │ ⌒ sun path, ● now, ▒ golden     │
 *   │   SONNE 12° WSW      │ │ Untergang 19:40 · Blaue …       │
 *   │   Mond 63 % · …      │ │ Aufgang 06:25 · Höchststand …   │
 *   ├──────────────────────┴─┴─────────────────────────────────┤
 *   │ Shooting 18:30: Sonne 12° WSW, goldene Stunde ab 19:12   │
 *   └───────────────────────────────────────────────────────────┘
 *
 * The clock only changes the top-right tile, the sun moves slowly: most
 * minutes nothing at all crosses Bluetooth.
 */

export const ROSE = { x: 126, y: 104, r: 78 } as const;
const RIGHT_X = 266;
const RIGHT_END = SCREEN_WIDTH - 8;
const RIGHT_WIDTH = RIGHT_END - RIGHT_X;
export const PATH_BOX = { x: RIGHT_X, y: 122, width: RIGHT_WIDTH, height: 72 } as const;
const BOTTOM_Y = 252;
export const LEVELS = { text: 15, label: 8, dim: 4, ring: 6, golden: 3, curve: 10 } as const;
/** Lowest elevation the sun-path arc shows; the night below is cut off. */
const PATH_FLOOR = -18;

const bold = (size: number): Font => ({ size, weight: 700 });
const plain = (size: number): Font => ({ size, weight: 500 });

export function composeLight(model: LightModel, backend: TextBackend): Frame {
  const frame = createFrame();
  if (!model.ok) return composeNoPlace(frame, model, backend);

  drawRose(frame, model, backend);
  drawWords(frame, model, backend);
  drawPath(frame, model);

  // Bottom row across the whole width: the next shoot, or how to operate the view.
  line(frame, 8, BOTTOM_Y - 6, SCREEN_WIDTH - 8, BOTTOM_Y - 6, LEVELS.dim);
  const bottom = model.shoot ? model.shoot.line : model.hint;
  const width = SCREEN_WIDTH - 16;
  const font = fitFont(backend, bottom, model.shoot ? bold(22) : plain(16), model.shoot ? [22, 20, 18, 16, 14] : [16, 14], width);
  drawText(frame, backend, bottom, 8, BOTTOM_Y + (model.shoot ? 2 : 6), font, { maxWidth: width, level: model.shoot ? LEVELS.text : LEVELS.label });
  return frame;
}

function composeNoPlace(frame: Frame, model: LightModel, backend: TextBackend): Frame {
  const center = SCREEN_WIDTH / 2;
  drawText(frame, backend, model.title, center, 70, bold(40), { align: "center", maxWidth: SCREEN_WIDTH - 32 });
  model.notice.forEach((row, index) => {
    drawText(frame, backend, row, center, 140 + index * 30, plain(20), { align: "center", maxWidth: SCREEN_WIDTH - 32, level: LEVELS.label + 3 });
  });
  drawText(frame, backend, model.hint, center, BOTTOM_Y + 6, plain(16), { align: "center", maxWidth: SCREEN_WIDTH - 16, level: LEVELS.label });
  return frame;
}

/** Compass rose, north up, with the sun on the ring and sunrise/sunset directions dashed. */
function drawRose(frame: Frame, model: LightModel, backend: TextBackend): void {
  const { x, y, r } = ROSE;
  circle(frame, x, y, r, LEVELS.ring);
  for (let index = 0; index < 16; index += 1) {
    const [dx, dy] = bearing(index * 22.5);
    const long = index % 4 === 0;
    const inner = r - (long ? 9 : 4);
    line(frame, x + dx * inner, y + dy * inner, x + dx * r, y + dy * r, long ? LEVELS.label : LEVELS.ring);
  }
  for (const degrees of [0, 90, 180, 270]) {
    const [dx, dy] = bearing(degrees);
    const letter = compassPoint(degrees, model.locale);
    const at = r - 22;
    drawText(frame, backend, letter, x + dx * at, y + dy * at - 9, bold(degrees === 0 ? 20 : 17), { align: "center", level: degrees === 0 ? LEVELS.text : LEVELS.label + 2 });
  }
  for (const azimuth of [model.sunriseAzimuth, model.sunsetAzimuth]) {
    if (azimuth === null) continue;
    const [dx, dy] = bearing(azimuth);
    dashedLine(frame, x + dx * 10, y + dy * 10, x + dx * (r - 2), y + dy * (r - 2), LEVELS.dim, { dash: 3, gap: 4 });
  }
  const [dx, dy] = bearing(model.azimuth);
  const sx = x + dx * r; const sy = y + dy * r;
  const above = model.elevation > -0.833;
  line(frame, x, y, x + dx * (r - 11), y + dy * (r - 11), above ? LEVELS.text - 3 : LEVELS.dim, 2);
  fillCircle(frame, x, y, 2, LEVELS.label);
  // A dark collar so the sun stands off the ring.
  fillCircle(frame, sx, sy, 10, 0);
  if (above) {
    fillCircle(frame, sx, sy, 7, LEVELS.text);
  } else {
    circle(frame, sx, sy, 7, LEVELS.label);
  }

  const words = `${model.sunLabel} ${model.sunWords}`;
  const font = fitFont(backend, words, bold(26), [26, 24, 22, 20, 18], 244);
  drawText(frame, backend, words, x, 190, font, { align: "center", maxWidth: 248 });
  if (model.moon) drawText(frame, backend, model.moon, x, 222, plain(14), { align: "center", maxWidth: 248, level: LEVELS.label });
}

function drawWords(frame: Frame, model: LightModel, backend: TextBackend): void {
  if (model.preview) {
    drawText(frame, backend, model.preview, RIGHT_X, 2, bold(16), { maxWidth: RIGHT_WIDTH, level: LEVELS.text });
  } else {
    drawText(frame, backend, model.label, RIGHT_X, 2, bold(15), { level: LEVELS.label });
    drawText(frame, backend, model.clock, RIGHT_END, 2, bold(16), { align: "right", level: LEVELS.text - 3 });
  }
  const title = fitFont(backend, model.title, bold(34), [34, 30, 27, 24, 21, 18], RIGHT_WIDTH);
  drawText(frame, backend, model.title, RIGHT_X, 24, title, { maxWidth: RIGHT_WIDTH });
  if (model.when) {
    const when = fitFont(backend, model.when, bold(30), [30, 26, 22, 19], RIGHT_WIDTH);
    drawText(frame, backend, model.when, RIGHT_X, 60, when, { maxWidth: RIGHT_WIDTH });
  }
  if (model.span) drawText(frame, backend, model.span, RIGHT_X, 94, bold(20), { maxWidth: RIGHT_WIDTH, level: LEVELS.label + 3 });
  model.facts.slice(0, 2).forEach((fact, index) => {
    const font = fitFont(backend, fact, plain(16), [16, 14, 13], RIGHT_WIDTH);
    drawText(frame, backend, fact, RIGHT_X, 200 + index * 21, font, { maxWidth: RIGHT_WIDTH, level: index === 0 ? LEVELS.text - 2 : LEVELS.label + 1 });
  });
}

/** Where a moment and an elevation land in the path box. */
export function pathPoint(model: LightModel, at: number, elevation: number): [number, number] {
  const { start, end, maxElevation } = model.path;
  const box = PATH_BOX;
  const fx = end > start ? (at - start) / (end - start) : 0;
  const clamped = Math.max(PATH_FLOOR, Math.min(maxElevation, elevation));
  const fy = (clamped - PATH_FLOOR) / (maxElevation - PATH_FLOOR);
  return [box.x + fx * (box.width - 1), box.y + (1 - fy) * (box.height - 1)];
}

/** The day's sun path: golden hours shaded, blue hours dotted, the horizon, and where the sun is now. */
function drawPath(frame: Frame, model: LightModel): void {
  const box = PATH_BOX;
  const { samples, windows, start, end } = model.path;
  if (samples.length < 2) return;
  for (const window of windows) {
    const [x0] = pathPoint(model, Math.max(start, window.start), 0);
    const [x1] = pathPoint(model, Math.min(end, window.end), 0);
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x += 1) {
      for (let y = box.y; y < box.y + box.height; y += 1) {
        if (window.kind === "golden" || (x + y) % 3 === 0) plot(frame, x, y, LEVELS.golden);
      }
    }
  }
  const [, horizon] = pathPoint(model, start, 0);
  line(frame, box.x, horizon, box.x + box.width - 1, horizon, LEVELS.ring);
  // Six-hour ticks under the horizon.
  for (let hour = 6; hour < 24; hour += 6) {
    const [tx] = pathPoint(model, start + hour * 3_600_000, 0);
    fillRect(frame, Math.round(tx), Math.round(horizon), 1, 5, LEVELS.label);
  }
  for (let index = 1; index < samples.length; index += 1) {
    const [t0, e0] = samples[index - 1]!; const [t1, e1] = samples[index]!;
    const [x0, y0] = pathPoint(model, t0, e0); const [x1, y1] = pathPoint(model, t1, e1);
    const up = e0 > 0 || e1 > 0;
    line(frame, x0, y0, x1, y1, up ? LEVELS.curve : LEVELS.dim, up ? 2 : 1);
  }
  const [nx, ny] = pathPoint(model, model.path.at, model.elevation);
  dashedLine(frame, nx, box.y, nx, box.y + box.height - 1, LEVELS.label, { dash: 2, gap: 3 });
  fillCircle(frame, nx, ny, 7, 0);
  fillCircle(frame, nx, ny, 5, LEVELS.text);
}

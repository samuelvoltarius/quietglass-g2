import { columnDivider, createBitmap, drawIcon, fillCircle, fillRect, line, MAX_LEVEL, quantize, type Bitmap } from "./bitmap";

/**
 * PostureLens's graphic: the head seen from the side.
 *
 * A dotted vertical line is the saved upright position. The neck pivots at the
 * shoulders, bottom left, and swings the head forward under a scale arc; the
 * arc turns into a thick band from the warning angle on. The drawn tilt is the real tilt, so the picture says
 * "how far forward" without a number. While upright everything is dim (good
 * posture costs no attention); leaning lights the head up.
 *
 * The SDK does not say which way the head tilts — the angle is measured
 * against the calibrated pose (see imu/vector.ts) — so any tilt is drawn
 * forward, which is what sitting at a desk almost always means.
 */

/** Wider than the other apps' icon column: the body beside it is mostly empty, and the gauge is the point. */
export const GAUGE = { id: 4, name: "pixel-icon", x: 0, y: 36, width: 144, height: 144 } as const;

/** The angle is drawn in 2° steps. */
export const ANGLE_STEP = 2;

const FIGURE = ["....##....", "...####...", "....##....", "...####...", "..######..", "..#.##.#..", "....##....", "...#..#...", "..##..##..", ".##....##."] as const;

/** Neck base height, head size and the span the drawing may use inside the column. */
const PIVOT_Y = 128;
const HEAD = 15;
const LEFT_EDGE = 14;
const RIGHT_EDGE = 138;
const MAX_RADIUS = 104;
/** The head centre sits this far inside the scale arc. */
const NECK_INSET = 26;

export interface GaugeState {
  /** False shows the figure icon: there is no upright position to compare with yet. */
  readonly calibrated: boolean;
  /** Quantised degrees from upright, or null before the first sample. */
  readonly angle: number | null;
  readonly warnAngle: number;
  /** Leaning or warned: draw bright. */
  readonly alert: boolean;
}

/** Next angle to draw, in 2° steps with hysteresis against the one drawn now. */
export function gaugeAngle(previous: number | null, angle: number | null): number | null {
  return quantize(previous, angle, ANGLE_STEP);
}

export function gaugeKey(state: GaugeState): string {
  return state.calibrated ? `g:${state.angle ?? "-"}:${state.warnAngle}:${state.alert ? 1 : 0}` : "icon";
}

/** The sweep shown: the warning angle plus room to see it pass, at most 90°. */
export function gaugeRange(warnAngle: number): number {
  return Math.min(90, Math.round(warnAngle + Math.max(15, warnAngle * 0.6)));
}

/** Radius of the scale arc: as large as the column allows for this sweep. */
export function gaugeRadius(range: number): number {
  const sin = Math.sin((Math.min(90, range) * Math.PI) / 180);
  return Math.floor(Math.min(MAX_RADIUS, (RIGHT_EDGE - LEFT_EDGE) / sin));
}

/** Neck base: placed so the drawing for this sweep sits centred in the column. */
export function gaugePivot(range: number): { x: number; y: number } {
  const reach = gaugeRadius(range) * Math.sin((Math.min(90, range) * Math.PI) / 180);
  return { x: Math.round(LEFT_EDGE + (RIGHT_EDGE - LEFT_EDGE - reach) / 2), y: PIVOT_Y };
}

/** Point at `degrees` forward of upright, `radius` from the neck base, for a gauge sweeping `range`. */
export function gaugePoint(degrees: number, radius: number, range: number): { x: number; y: number } {
  const pivot = gaugePivot(range); const radians = (degrees * Math.PI) / 180;
  return { x: pivot.x + radius * Math.sin(radians), y: pivot.y - radius * Math.cos(radians) };
}

/** Where the head is drawn for an angle; beyond the sweep it rests at the end. */
export function headCentre(angle: number, warnAngle: number): { x: number; y: number } {
  const range = gaugeRange(warnAngle);
  const point = gaugePoint(Math.min(range, Math.max(0, angle)), gaugeRadius(range) - NECK_INSET, range);
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

export function drawGauge(state: GaugeState): Bitmap {
  const bitmap = createBitmap(GAUGE.width, GAUGE.height);
  columnDivider(bitmap);
  if (!state.calibrated) { drawIcon(bitmap, FIGURE); return bitmap; }
  const range = gaugeRange(state.warnAngle);
  const radius = gaugeRadius(range);
  const pivot = gaugePivot(range);
  const at = (degrees: number, distance: number): { x: number; y: number } => gaugePoint(degrees, distance, range);
  // Saved upright position: a dotted vertical line up to the scale.
  for (let y = pivot.y - 3; y >= pivot.y - radius - 4; y -= 4) fillRect(bitmap, pivot.x - 1, y, 2, 2, 8);
  // Scale: dotted up to the warning angle, a thick band from there on.
  for (let degrees = 0; degrees < state.warnAngle; degrees += 4) {
    const point = at(degrees, radius); fillRect(bitmap, Math.round(point.x) - 1, Math.round(point.y) - 1, 2, 2, 6);
  }
  for (let degrees = state.warnAngle; degrees <= range; degrees += 0.5) {
    const point = at(degrees, radius); line(bitmap, point.x, point.y, point.x, point.y, state.alert ? MAX_LEVEL : 9, 5);
  }
  const inner = at(state.warnAngle, radius - 10); const outer = at(state.warnAngle, radius + 9);
  line(bitmap, inner.x, inner.y, outer.x, outer.y, MAX_LEVEL, 3);
  // Back below the neck base.
  line(bitmap, pivot.x, pivot.y, pivot.x - 5, GAUGE.height - 3, 6, 7);
  if (state.angle !== null) {
    const level = state.alert ? MAX_LEVEL : 8;
    const head = headCentre(state.angle, state.warnAngle);
    line(bitmap, pivot.x, pivot.y, head.x, head.y, level, 6);
    fillCircle(bitmap, head.x, head.y, HEAD, level);
  }
  return bitmap;
}

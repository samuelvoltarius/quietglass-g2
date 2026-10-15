import { DIM, FULL, createBitmap, fillRect, type Bitmap } from "./gfx";

/**
 * The layer view: the print's G-code toolpaths (from the bridge, one list of
 * line segments per layer) drawn as a small 3D picture. Printed layers are
 * lit, the layer being printed is brightest, the layers still to come are a
 * faint outline. Pure: same model, layer and angle → same picture, so nothing
 * is resent while the print stays on one layer.
 */

export interface LayerModel {
  readonly file: string;
  /** [x0, y0, z0, x1, y1, z1] in mm. */
  readonly bounds: readonly number[];
  /** Height of each kept layer, mm. */
  readonly z: readonly number[];
  /** Index of each layer's first segment. */
  readonly start: readonly number[];
  /** x0, y0, x1, y1 per segment, in 0.1 mm. */
  readonly segs: Int16Array;
  /** Layers in the file before thinning. */
  readonly layersTotal: number;
}

/** Turns the bridge's JSON into a model; null when it does not hold together. */
export function parseLayerModel(raw: unknown): LayerModel | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const nums = (value: unknown): number[] | null =>
    Array.isArray(value) && value.every((n) => typeof n === "number" && Number.isFinite(n)) ? (value as number[]) : null;
  const bounds = nums(v["bounds"]);
  const z = nums(v["z"]);
  const start = nums(v["start"]);
  if (!bounds || bounds.length !== 6 || !z || !start || z.length !== start.length || z.length === 0) return null;
  if (typeof v["segs"] !== "string") return null;
  let segs: Int16Array;
  try {
    const binary = atob(v["segs"]);
    if (binary.length % 8 !== 0) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    segs = new Int16Array(bytes.buffer);
  } catch {
    return null;
  }
  const count = segs.length / 4;
  if (start.some((s, i) => s < 0 || s > count || (i > 0 && s < start[i - 1]!))) return null;
  return {
    file: typeof v["file"] === "string" ? v["file"] : "",
    bounds, z, start, segs,
    layersTotal: typeof v["layersTotal"] === "number" ? v["layersTotal"] : z.length,
  };
}

/**
 * Which kept layer is being printed: by nozzle height when known (the highest
 * layer at or below it), else by the layer counter, else by progress.
 */
export function currentLayerIndex(model: LayerModel, at: { z: number | null; layer: number | null; layers: number | null; progress: number }): number {
  const last = model.z.length - 1;
  if (at.z !== null && at.z > 0) {
    let index = -1;
    for (let i = 0; i <= last; i += 1) if (model.z[i]! <= at.z + 0.02) index = i;
    if (index >= 0) return index;
  }
  if (at.layer !== null && at.layers) return Math.max(0, Math.min(last, Math.round((at.layer / at.layers) * (last + 1)) - 1));
  return Math.max(0, Math.min(last, Math.round((at.progress / 100) * (last + 1)) - 1));
}

export const VIEW_WIDTH = 576;
export const VIEW_HEIGHT = 216;
/** How far the camera looks down, degrees. */
const TILT = 32;
const PRINTED = 150;
const FUTURE = 60;

/** Draws a line keeping the brighter value where lines cross (so a faint outline never covers a lit one). */
function plot(b: Bitmap, x0: number, y0: number, x1: number, y1: number, value: number): void {
  let x = Math.round(x0), y = Math.round(y0);
  const tx = Math.round(x1), ty = Math.round(y1);
  const dx = Math.abs(tx - x), dy = -Math.abs(ty - y);
  const sx = x < tx ? 1 : -1, sy = y < ty ? 1 : -1;
  let err = dx + dy;
  const w = b.width, h = b.height, px = b.pixels;
  for (let guard = 0; guard < 4000; guard += 1) {
    if (x >= 0 && y >= 0 && x < w && y < h) {
      const i = y * w + x;
      if (px[i]! < value) px[i] = value;
    }
    if (x === tx && y === ty) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

/**
 * The picture: model rotated by `angle` degrees around its vertical axis,
 * seen from slightly above, fitted into the frame. `current` = index of the
 * layer being printed (-1 = nothing printed yet).
 */
export function layerFrame(model: LayerModel, current: number, angle: number, width = VIEW_WIDTH, height = VIEW_HEIGHT): Bitmap {
  const b = createBitmap(width, height);
  const [x0, y0, z0, x1, y1, z1] = model.bounds as [number, number, number, number, number, number];
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const a = (angle * Math.PI) / 180, t = (TILT * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a), st = Math.sin(t), ct = Math.cos(t);
  // Screen u to the right, v down; z up.
  const project = (x: number, y: number, z: number): [number, number] => {
    const rx = (x - cx) * ca - (y - cy) * sa;
    const ry = (x - cx) * sa + (y - cy) * ca;
    return [rx, ry * st - (z - z0) * ct];
  };
  // Fit the eight corners of the bounding box for this angle.
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) {
    const [u, v] = project(x, y, z);
    umin = Math.min(umin, u); umax = Math.max(umax, u); vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
  }
  const margin = 6;
  const scale = Math.min((width - 2 * margin) / Math.max(1, umax - umin), (height - 2 * margin) / Math.max(1, vmax - vmin));
  const ou = (width - (umax - umin) * scale) / 2 - umin * scale;
  const ov = (height - (vmax - vmin) * scale) / 2 - vmin * scale;

  const segs = model.segs;
  const total = segs.length / 4;
  const drawLayer = (index: number, value: number, step = 1): void => {
    const from = model.start[index]!;
    const to = index + 1 < model.start.length ? model.start[index + 1]! : total;
    const z = model.z[index]!;
    for (let s = from; s < to; s += step) {
      const [ua, va] = project(segs[s * 4]! / 10, segs[s * 4 + 1]! / 10, z);
      const [ub, vb] = project(segs[s * 4 + 2]! / 10, segs[s * 4 + 3]! / 10, z);
      plot(b, ou + ua * scale, ov + va * scale, ou + ub * scale, ov + vb * scale, value);
    }
  };

  const last = model.z.length - 1;
  // Layers still to come: only every third one, as a faint outline.
  for (let i = last; i > current; i -= 1) if ((last - i) % 3 === 0) drawLayer(i, FUTURE, 2);
  // Printed layers: brighter towards the top, so the shape reads.
  for (let i = 0; i < current; i += 1) drawLayer(i, Math.round(PRINTED * (0.55 + 0.45 * (i / Math.max(1, current)))));
  if (current >= 0 && current <= last) drawLayer(current, FULL);
  return b;
}

/**
 * The middle while there is no model (not there yet / none): an empty dim box.
 * The words stand in the header; the pixel font here only has digits, so text
 * came out in fragments on the glasses ("M u M RUC", 15.10.2026).
 */
export function messageFrame(_text: string, width = VIEW_WIDTH, height = VIEW_HEIGHT): Bitmap {
  const b = createBitmap(width, height);
  const w = 120, h = 72, x = Math.round((width - w) / 2), y = Math.round((height - h) / 2), line = 3;
  fillRect(b, x, y, w, line, DIM);
  fillRect(b, x, y + h - line, w, line, DIM);
  fillRect(b, x, y, line, h, DIM);
  fillRect(b, x + w - line, y, line, h, DIM);
  return b;
}

/** Cuts the frame into the 2 × 2 image containers the SDK allows (max 288 × 144 each). */
export function tiles(frame: Bitmap, columns = 2, rows = 2): Bitmap[] {
  const w = Math.floor(frame.width / columns), h = Math.floor(frame.height / rows);
  const out: Bitmap[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const tile = createBitmap(w, h);
      for (let y = 0; y < h; y += 1) {
        const from = (r * h + y) * frame.width + c * w;
        tile.pixels.set(frame.pixels.subarray(from, from + w), y * w);
      }
      out.push(tile);
    }
  }
  return out;
}

/** A small stepped pyramid, for the demo printer and the simulator. */
export function demoLayerModel(): LayerModel {
  const z: number[] = [], start: number[] = [], values: number[] = [];
  const layers = 60;
  for (let i = 0; i < layers; i += 1) {
    start.push(values.length / 4);
    z.push(Math.round((i + 1) * 0.3 * 100) / 100);
    const inset = Math.floor(i / 6) * 20;              // 0.1 mm units
    const lo = 100 + inset, hi = 700 - inset;
    for (const ring of [0, 40]) {
      const a = lo + ring, c = hi - ring;
      if (a >= c) continue;
      values.push(a, a, c, a, c, a, c, c, c, c, a, c, a, c, a, a);
    }
    if (i % 2 === 0) for (let x = lo + 80; x < hi - 80; x += 60) values.push(x, lo + 80, x, hi - 80);
  }
  return { file: "demo", bounds: [10, 10, 0.3, 70, 70, layers * 0.3], z, start, segs: Int16Array.from(values), layersTotal: layers };
}

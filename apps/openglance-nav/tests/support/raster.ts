import type { MapContext } from "../../src/overview/draw";
import { grayOf } from "../../src/glasses/png";

/**
 * A tiny software rasteriser for the slice of the canvas API the overview
 * uses, so drawing can be turned into real pixels in node — for assertions
 * on what the glasses would show, and for the preview PNG. No anti-aliasing:
 * the glasses quantise to 16 greys anyway.
 */
export interface Raster { readonly ctx: MapContext; readonly pixels: Uint8Array; readonly width: number; readonly height: number; }

type Shape = { kind: "line"; points: { x: number; y: number }[] } | { kind: "arc"; x: number; y: number; r: number };

const N_GLYPH = ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"];

export function createRaster(width: number, height: number): Raster {
  const pixels = new Uint8Array(width * height);
  let shapes: Shape[] = [];
  const state = { fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, lineCap: "butt", lineJoin: "miter", font: "" };
  const plot = (x: number, y: number, value: number): void => {
    if (x >= 0 && y >= 0 && x < width && y < height) pixels[y * width + x] = value;
  };
  const each = (minX: number, minY: number, maxX: number, maxY: number, inside: (x: number, y: number) => boolean, value: number): void => {
    for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(height - 1, Math.ceil(maxY)); y++) {
      for (let x = Math.max(0, Math.floor(minX)); x <= Math.min(width - 1, Math.ceil(maxX)); x++) {
        if (inside(x + 0.5, y + 0.5)) plot(x, y, value);
      }
    }
  };
  const segmentDistance = (px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number => {
    const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  };
  const thickLine = (a: { x: number; y: number }, b: { x: number; y: number }, lineWidth: number, value: number): void => {
    const half = Math.max(0.5, lineWidth / 2);
    each(Math.min(a.x, b.x) - half, Math.min(a.y, b.y) - half, Math.max(a.x, b.x) + half, Math.max(a.y, b.y) + half,
      (x, y) => segmentDistance(x, y, a, b) <= half, value);
  };
  const ctx = Object.assign(state, {
    fillRect(x: number, y: number, w: number, h: number) { each(x, y, x + w - 1, y + h - 1, () => true, grayOf(state.fillStyle)); },
    strokeRect(x: number, y: number, w: number, h: number) {
      const value = grayOf(state.strokeStyle);
      const corners = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
      corners.forEach((corner, i) => thickLine(corner, corners[(i + 1) % 4]!, state.lineWidth, value));
    },
    beginPath() { shapes = []; },
    moveTo(x: number, y: number) { shapes.push({ kind: "line", points: [{ x, y }] }); },
    lineTo(x: number, y: number) {
      const last = shapes[shapes.length - 1];
      if (last?.kind === "line") last.points.push({ x, y }); else shapes.push({ kind: "line", points: [{ x, y }] });
    },
    arc(x: number, y: number, r: number) { shapes.push({ kind: "arc", x, y, r }); },
    stroke() {
      const value = grayOf(state.strokeStyle);
      for (const shape of shapes) {
        if (shape.kind === "arc") {
          const half = state.lineWidth / 2;
          each(shape.x - shape.r - half, shape.y - shape.r - half, shape.x + shape.r + half, shape.y + shape.r + half,
            (x, y) => Math.abs(Math.hypot(x - shape.x, y - shape.y) - shape.r) <= half, value);
        } else {
          for (let i = 1; i < shape.points.length; i++) thickLine(shape.points[i - 1]!, shape.points[i]!, state.lineWidth, value);
        }
      }
    },
    fill() {
      const value = grayOf(state.fillStyle);
      for (const shape of shapes) {
        if (shape.kind === "arc") {
          each(shape.x - shape.r, shape.y - shape.r, shape.x + shape.r, shape.y + shape.r, (x, y) => Math.hypot(x - shape.x, y - shape.y) <= shape.r, value);
        } else {
          const poly = shape.points;
          const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
          each(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), (x, y) => {
            let inside = false;
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
              const a = poly[i]!, b = poly[j]!;
              if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
            }
            return inside;
          }, value);
        }
      }
    },
    fillText(text: string, x: number, y: number) {
      // Only "N" is ever drawn; a 5 × 7 glyph at twice the size, sitting on the baseline.
      if (text !== "N") return;
      const value = grayOf(state.fillStyle);
      N_GLYPH.forEach((row, gy) => { for (let gx = 0; gx < 5; gx++) if (row[gx] === "#") { for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) plot(Math.round(x - 5 + gx * 2 + dx), Math.round(y - 14 + gy * 2 + dy), value); } });
    },
  });
  return { ctx: ctx as unknown as MapContext, pixels, width, height };
}

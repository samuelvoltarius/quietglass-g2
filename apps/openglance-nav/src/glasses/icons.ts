import type { ManeuverType } from "../routing/provider";
import type { PixelIcon } from "./pixel";

/**
 * The big direction arrows of the turn layout, drawn for a 144 × 144 image.
 *
 * Each arrow is a few simple shapes — thick strokes, a triangular head, a
 * ring — in the image's own coordinates, sampled once into a 72 × 72 grid of
 * "#" and "." (a 2 px cell). The grid is the arrow's identity: it is what is
 * compared to decide whether the image changed, and what the tests read. The
 * strokes are 32 px thick and the heads 80 px wide, so the direction reads at
 * a glance from the corner of the eye.
 */

/** Cells per side of the grid, and the pixel size of the image they are drawn into. */
export const ARROW_GRID = 72;
export const ARROW_SIZE = 144;

type Point = readonly [number, number];
type Shape =
  | { readonly kind: "seg"; readonly a: Point; readonly b: Point; readonly half: number }
  | { readonly kind: "tri"; readonly a: Point; readonly b: Point; readonly c: Point }
  | { readonly kind: "ring"; readonly at: Point; readonly r: number; readonly half: number }
  | { readonly kind: "disc"; readonly at: Point; readonly r: number };

const seg = (a: Point, b: Point, half: number): Shape => ({ kind: "seg", a, b, half });
const tri = (a: Point, b: Point, c: Point): Shape => ({ kind: "tri", a, b, c });

const STROKE = 16;
const HEAD_LENGTH = 56;
const HEAD_HALF = 42;

/** An arrowhead whose tip is `tip`, pointing along unit vector `d`. */
function head(tip: Point, d: Point, length = HEAD_LENGTH, half = HEAD_HALF): Shape {
  const base: Point = [tip[0] - d[0] * length, tip[1] - d[1] * length];
  const perp: Point = [-d[1], d[0]];
  return tri(tip, [base[0] + perp[0] * half, base[1] + perp[1] * half], [base[0] - perp[0] * half, base[1] - perp[1] * half]);
}

const dir = (degrees: number): Point => [Math.sin((degrees * Math.PI) / 180), -Math.cos((degrees * Math.PI) / 180)];

/**
 * A stem up from the bottom edge to a corner, then on for `run` pixels in the
 * direction `angle` (degrees clockwise from straight up) and the arrowhead.
 */
function bent(angle: number, stemX: number, cornerY: number, run: number): Shape[] {
  const d = dir(angle);
  const corner: Point = [stemX, cornerY];
  const end: Point = [stemX + d[0] * run, cornerY + d[1] * run];
  const tip: Point = [end[0] + d[0] * HEAD_LENGTH, end[1] + d[1] * HEAD_LENGTH];
  return [seg([stemX, 200], corner, STROKE), seg(corner, end, STROKE), head(tip, d)];
}

function mirror(shapes: readonly Shape[]): Shape[] {
  const flip = (p: Point): Point => [ARROW_SIZE - p[0], p[1]];
  return shapes.map((shape): Shape => {
    switch (shape.kind) {
      case "seg": return { ...shape, a: flip(shape.a), b: flip(shape.b) };
      case "tri": return { ...shape, a: flip(shape.a), b: flip(shape.b), c: flip(shape.c) };
      default: return { ...shape, at: flip(shape.at) };
    }
  });
}

const STRAIGHT: Shape[] = [seg([72, 200], [72, 58], STROKE), head([72, 2], [0, -1])];
const RIGHT = bent(90, 40, 80, 32);
const SLIGHT_RIGHT = bent(45, 52, 72, 20);
const SHARP_RIGHT = bent(135, 44, 40, 20);

// Up the right side, over the top in a half circle, down the left: the head points back.
const UTURN: Shape[] = (() => {
  const centre: Point = [74, 66], r = 34, half = 14;
  const arc: Point[] = [];
  for (let degrees = 0; degrees <= 180; degrees += 10) {
    const t = (degrees * Math.PI) / 180;
    arc.push([centre[0] + r * Math.cos(t), centre[1] - r * Math.sin(t)]);
  }
  const shapes: Shape[] = [seg([centre[0] + r, 200], arc[0]!, half), seg([centre[0] - r, centre[1]], [centre[0] - r, 92], half)];
  for (let i = 1; i < arc.length; i++) shapes.push(seg(arc[i - 1]!, arc[i]!, half));
  shapes.push(head([centre[0] - r, 140], [0, 1], 50, 38));
  return shapes;
})();

// A ring with the entry from below and the way out straight up through the top.
const ROUNDABOUT: Shape[] = [
  { kind: "ring", at: [72, 82], r: 30, half: 11 },
  seg([72, 200], [72, 108], 11),
  seg([72, 52], [72, 38], 11),
  head([72, 0], [0, -1], 34, 30),
];

// A target: ring with a dot.
const ARRIVE: Shape[] = [{ kind: "ring", at: [72, 72], r: 46, half: 12 }, { kind: "disc", at: [72, 72], r: 20 }];

const SHAPES: Readonly<Record<ManeuverType, readonly Shape[]>> = {
  depart: STRAIGHT,
  arrive: ARRIVE,
  left: mirror(RIGHT),
  slightLeft: mirror(SLIGHT_RIGHT),
  sharpLeft: mirror(SHARP_RIGHT),
  right: RIGHT,
  slightRight: SLIGHT_RIGHT,
  sharpRight: SHARP_RIGHT,
  straight: STRAIGHT,
  uturn: UTURN,
  roundabout: ROUNDABOUT,
  merge: SLIGHT_RIGHT,
  fork: SLIGHT_RIGHT,
  exit: SLIGHT_RIGHT,
};

function segmentDistance(x: number, y: number, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

function inTriangle(x: number, y: number, a: Point, b: Point, c: Point): boolean {
  const side = (p: Point, q: Point): number => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
  const s1 = side(a, b), s2 = side(b, c), s3 = side(c, a);
  return !((s1 < 0 || s2 < 0 || s3 < 0) && (s1 > 0 || s2 > 0 || s3 > 0));
}

function covers(shape: Shape, x: number, y: number): boolean {
  switch (shape.kind) {
    case "seg": return segmentDistance(x, y, shape.a, shape.b) <= shape.half;
    case "tri": return inTriangle(x, y, shape.a, shape.b, shape.c);
    case "ring": return Math.abs(Math.hypot(x - shape.at[0], y - shape.at[1]) - shape.r) <= shape.half;
    case "disc": return Math.hypot(x - shape.at[0], y - shape.at[1]) <= shape.r;
  }
}

const cache = new Map<ManeuverType | "blank", PixelIcon>();

/** The arrow of a manoeuvre as a 72 × 72 grid of "#" (white) and "." (black); all "." without one. */
export function pixelArrowFor(type?: ManeuverType): PixelIcon {
  const key = type ?? "blank";
  const known = cache.get(key);
  if (known) return known;
  const cell = ARROW_SIZE / ARROW_GRID;
  const shapes = type ? SHAPES[type] : [];
  const rows: string[] = [];
  for (let row = 0; row < ARROW_GRID; row++) {
    let line = "";
    for (let column = 0; column < ARROW_GRID; column++) {
      const x = (column + 0.5) * cell, y = (row + 0.5) * cell;
      line += shapes.some((shape) => covers(shape, x, y)) ? "#" : ".";
    }
    rows.push(line);
  }
  cache.set(key, rows);
  return rows;
}

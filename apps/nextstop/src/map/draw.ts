import { createFrame, type Frame } from "../screen/frame";
import { circle, dashedLine, fillCircle, fillRect, fillTriangle, line, strokeRect, triangle } from "../screen/draw";
import { drawText, type TextBackend } from "../screen/text";
import type { LatLon } from "../route/walk";
import { MAP_H, MAP_W, mapProjector, markerFor, remainingRoute, locate, type MapView } from "./camera";
import { clipSegment, prepareStreets, type PixelPoint, type Street } from "./streets";
import { LABEL_HEIGHT, placeLabels, type PlacedLabel, type Rect } from "./labels";

/**
 * Draws the walking map into a 288 x 254 grey frame (the two left tiles of the
 * cockpit, above the hint line), in the brightness levels of the QUS:
 *
 *   route 15 (thick, on a black edge)   major roads 8   minor roads 6   footpaths 4
 *
 * The walker is a chevron when the map is turned to a direction, a ringed dot
 * when north is up; the stop is a ring, the destination a square; a target
 * beyond the picture is shown by an arrow at the edge pointing to it. A scale
 * bar and (while turned) a north needle are the only other marks. No streets
 * simply means the route and the markers on black.
 */

export const MAP_LEVELS = { route: 15, major: 8, minor: 6, path: 4, mark: 15, scale: 11, edge: 4 } as const;

export type TargetKind = "stop" | "goal";

export interface WalkMapInput {
  readonly view: MapView;
  /** The whole walking route; the part already walked is not drawn. */
  readonly shape: readonly LatLon[];
  readonly target: LatLon;
  readonly targetKind: TargetKind;
  /** Where the next turn is, and the streets of the next turn and of the stretch walked now (their names are labelled first). */
  readonly turn?: LatLon | null;
  readonly nextStreet?: string | undefined;
  readonly currentStreet?: string | undefined;
  /** Null or empty: no streets (not loaded yet, or the load failed). */
  readonly streets: readonly Street[] | null;
  /** Names the shape / the streets in the picture key, so an unchanged map is drawn once. */
  readonly routeKey: string;
  readonly streetsKey: string;
}

/** Strokes a segment cut to the picture (with a little margin so thick lines end cleanly). */
function stroke(frame: Frame, a: PixelPoint, b: PixelPoint, level: number, thickness: number): void {
  const clipped = clipSegment(a, b, -12, -12, MAP_W + 12, MAP_H + 12);
  if (clipped) line(frame, clipped[0].x, clipped[0].y, clipped[1].x, clipped[1].y, level, thickness);
}

/** A polyline with points closer than `step` pixels merged. */
function thin(points: readonly PixelPoint[], step: number): PixelPoint[] {
  const out: PixelPoint[] = [];
  points.forEach((point, index) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const last = out[out.length - 1];
    if (last && index !== points.length - 1 && Math.hypot(point.x - last.x, point.y - last.y) < step) return;
    out.push(point);
  });
  return out;
}

function drawWalker(frame: Frame, at: PixelPoint, heading: boolean): void {
  const x = Math.round(at.x); const y = Math.round(at.y);
  if (heading) {
    fillCircle(frame, x, y, 15, 0);
    fillTriangle(frame, [x, y - 14], [x + 10, y + 11], [x, y + 5], MAP_LEVELS.mark);
    fillTriangle(frame, [x, y - 14], [x, y + 5], [x - 10, y + 11], MAP_LEVELS.mark);
    return;
  }
  // No direction known: a ringed dot says "you are here" without claiming a heading.
  fillCircle(frame, x, y, 12, 0);
  fillCircle(frame, x, y, 8, MAP_LEVELS.mark);
  fillCircle(frame, x, y, 5, 0);
  fillCircle(frame, x, y, 2, MAP_LEVELS.mark);
}

function drawTarget(frame: Frame, at: PixelPoint, kind: TargetKind): void {
  const x = Math.round(at.x); const y = Math.round(at.y);
  if (kind === "stop") {
    // The stop: a ring with a dot.
    fillCircle(frame, x, y, 12, 0);
    circle(frame, x, y, 8, MAP_LEVELS.mark, { thickness: 3 });
    fillCircle(frame, x, y, 2, MAP_LEVELS.mark);
    return;
  }
  // The destination: a square.
  fillRect(frame, x - 12, y - 12, 25, 25, 0);
  strokeRect(frame, x - 8, y - 8, 17, 17, MAP_LEVELS.mark, 3);
  fillRect(frame, x - 2, y - 2, 5, 5, MAP_LEVELS.mark);
}

/** Where a target beyond the picture is marked: on the edge, in its direction from the walker. */
export function edgePoint(from: PixelPoint, to: PixelPoint, inset = 12): PixelPoint {
  const dx = to.x - from.x; const dy = to.y - from.y;
  const limits: number[] = [];
  if (dx > 0) limits.push((MAP_W - inset - from.x) / dx); else if (dx < 0) limits.push((inset - from.x) / dx);
  if (dy > 0) limits.push((MAP_H - inset - from.y) / dy); else if (dy < 0) limits.push((inset - from.y) / dy);
  const t = Math.max(0, Math.min(...limits, 1));
  return { x: from.x + dx * t, y: from.y + dy * t };
}

/** The longest "nice" length that fits `maxPixels`, in metres, and its length in pixels. */
export function scaleBar(spanM: number, maxPixels = 96): { readonly metres: number; readonly pixels: number } {
  const pixelsPerMetre = MAP_W / spanM;
  const metres = [500, 200, 100, 50, 25].find((candidate) => candidate * pixelsPerMetre <= maxPixels) ?? 25;
  return { metres, pixels: Math.round(metres * pixelsPerMetre) };
}

const LABEL_FONT = { size: 12, weight: 700 } as const;
const LABEL_STYLE: Record<PlacedLabel["rank"], { text: number; border: number }> = {
  next: { text: 15, border: 12 }, current: { text: 13, border: 9 }, other: { text: 8, border: 4 },
};

/** What no street name may cover: the walker, the target, the scale bar and the north needle. */
function reservedRects(view: MapView, target: PixelPoint, barPixels: number): Rect[] {
  const marker = markerFor(view.bearing);
  return [
    { x: marker.x - 26, y: marker.y - 26, w: 52, h: 52 },
    { x: target.x - 22, y: target.y - 22, w: 44, h: 44 },
    { x: 0, y: MAP_H - 32, w: barPixels + 20, h: 32 },
    { x: MAP_W - 46, y: 0, w: 46, h: 64 },
  ];
}

export function drawWalkMap(frame: Frame, input: WalkMapInput, backend: TextBackend): void {
  const { view } = input;
  const toPixel = mapProjector(view);
  const marker = markerFor(view.bearing);

  // Streets, faintest first so a major road is never painted over by a footpath.
  if (input.streets && input.streets.length > 0) {
    const segments = prepareStreets(input.streets, toPixel, MAP_W, MAP_H);
    for (const cls of ["path", "minor", "major"] as const) {
      const level = MAP_LEVELS[cls];
      for (const segment of segments) {
        if (segment.cls === cls) stroke(frame, segment.from, segment.to, level, cls === "major" ? 2 : 1);
      }
    }
  }

  // The rest of the walk: a thick bright line on a black edge, so it stands clear of the streets.
  const rest = remainingRoute(input.shape, view.user);
  const route = thin(rest.map(toPixel), 2);
  for (let i = 1; i < route.length; i += 1) stroke(frame, route[i - 1]!, route[i]!, 0, 9);
  for (let i = 1; i < route.length; i += 1) stroke(frame, route[i - 1]!, route[i]!, MAP_LEVELS.route, 4);

  // Off the route: a thin dashed link back to it.
  const near = locate(input.shape, view.user);
  const first = rest[0];
  if (near && first && near.off >= 12) {
    const a = marker; const b = toPixel(first);
    const clipped = clipSegment(a, b, -12, -12, MAP_W + 12, MAP_H + 12);
    if (clipped) dashedLine(frame, clipped[0].x, clipped[0].y, clipped[1].x, clipped[1].y, 10, { dash: 3, gap: 3 });
  }

  // Street names, over the streets and the route, under the markers.
  const bar = scaleBar(view.spanM);
  const targetAt = toPixel(input.target);
  const labels = placeLabels({
    width: MAP_W, height: MAP_H, toPixel, rest, turn: input.turn ?? null, nextStreet: input.nextStreet, currentStreet: input.currentStreet,
    streets: input.streets ?? [], reserved: reservedRects(view, targetAt, bar.pixels),
    measure: (text) => backend.measure(text, LABEL_FONT),
  });
  for (const label of [...labels].reverse()) {
    const { x, y, w } = label.rect;
    const style = LABEL_STYLE[label.rank];
    fillRect(frame, x, y, w, LABEL_HEIGHT, 0);
    strokeRect(frame, x, y, w, LABEL_HEIGHT, style.border, 1);
    drawText(frame, backend, label.text, x + 4, y + 2, LABEL_FONT, { level: style.text });
  }

  // The target: its own mark, or an arrow at the edge when it is beyond the picture.
  const target = toPixel(input.target);
  const inside = target.x >= 14 && target.x <= MAP_W - 14 && target.y >= 14 && target.y <= MAP_H - 14;
  if (inside) drawTarget(frame, target, input.targetKind);
  else {
    const edge = edgePoint(marker, target);
    const degrees = (Math.round((Math.atan2(target.x - marker.x, -(target.y - marker.y)) * 180) / Math.PI) + 360) % 360;
    fillCircle(frame, Math.round(edge.x), Math.round(edge.y), 10, 0);
    triangle(frame, edge.x, edge.y, 8, degrees, MAP_LEVELS.mark);
  }

  drawWalker(frame, marker, view.bearing !== null);

  // Scale bar, bottom left.
  fillRect(frame, 0, MAP_H - 30, bar.pixels + 16, 30, 0);
  fillRect(frame, 8, MAP_H - 9, bar.pixels, 2, MAP_LEVELS.scale);
  fillRect(frame, 8, MAP_H - 13, 2, 6, MAP_LEVELS.scale);
  fillRect(frame, 8 + bar.pixels - 2, MAP_H - 13, 2, 6, MAP_LEVELS.scale);
  drawText(frame, backend, `${bar.metres} M`, 8, MAP_H - 29, { size: 14, weight: 700 }, { level: MAP_LEVELS.scale });

  // North needle, top right, only while the map is turned.
  if (view.bearing !== null) {
    const cx = MAP_W - 22; const cy = 22;
    fillCircle(frame, cx, cy, 16, 0);
    circle(frame, cx, cy, 15, MAP_LEVELS.edge);
    triangle(frame, cx, cy, 8, (360 - view.bearing) % 360, MAP_LEVELS.mark);
    drawText(frame, backend, "N", cx, cy + 18, { size: 12, weight: 700 }, { align: "center", level: MAP_LEVELS.scale });
  }
}

let remembered: { key: string; frame: Frame } | null = null;

/** The map as a frame; the same input is drawn once (the clock and the text change often, the map does not). */
export function renderWalkMap(input: WalkMapInput, backend: TextBackend): Frame {
  const key = JSON.stringify([input.view, input.routeKey, input.streetsKey, input.target, input.targetKind, input.turn, input.nextStreet, input.currentStreet, backend.name]);
  if (remembered && remembered.key === key) return remembered.frame;
  const frame = createFrame(MAP_W, MAP_H);
  drawWalkMap(frame, input, backend);
  remembered = { key, frame };
  return frame;
}

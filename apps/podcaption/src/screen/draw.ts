import { MAX_LEVEL, type Frame } from "./frame";

/**
 * Full-screen kit, part 2: drawing primitives over a grey frame (levels 0…15).
 * Meant to be copied into other Quietglass G2 apps. Everything is clipped to
 * the frame, pure and testable in node.
 */

const clampLevel = (level: number): number => Math.max(0, Math.min(MAX_LEVEL, Math.round(level)));

export function plot(frame: Frame, x: number, y: number, level: number): void {
  const px = Math.round(x); const py = Math.round(y);
  if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) return;
  frame.pixels[py * frame.width + px] = clampLevel(level);
}

export function read(frame: Frame, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return 0;
  return frame.pixels[y * frame.width + x]!;
}

export function fillRect(frame: Frame, x: number, y: number, width: number, height: number, level: number): void {
  const x0 = Math.max(0, Math.round(x)); const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(frame.width, Math.round(x + width)); const y1 = Math.min(frame.height, Math.round(y + height));
  const value = clampLevel(level);
  for (let py = y0; py < y1; py += 1) frame.pixels.fill(value, py * frame.width + x0, py * frame.width + Math.max(x0, x1));
}

export function strokeRect(frame: Frame, x: number, y: number, width: number, height: number, level: number, thickness = 1): void {
  fillRect(frame, x, y, width, thickness, level); fillRect(frame, x, y + height - thickness, width, thickness, level);
  fillRect(frame, x, y, thickness, height, level); fillRect(frame, x + width - thickness, y, thickness, height, level);
}

/** Straight line with a square brush `thickness` pixels wide. */
export function line(frame: Frame, x0: number, y0: number, x1: number, y1: number, level: number, thickness = 1): void {
  dashedLine(frame, x0, y0, x1, y1, level, { dash: 1, gap: 0, thickness });
}

export interface DashOptions { readonly dash?: number; readonly gap?: number; readonly thickness?: number; }

/** A line drawn `dash` pixels on, `gap` pixels off (gap 0 = solid). */
export function dashedLine(frame: Frame, x0: number, y0: number, x1: number, y1: number, level: number, options: DashOptions = {}): void {
  const dash = Math.max(1, options.dash ?? 4); const gap = Math.max(0, options.gap ?? 3); const thickness = Math.max(1, options.thickness ?? 1);
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
  const offset = Math.floor(thickness / 2);
  for (let step = 0; step <= steps; step += 1) {
    if (gap > 0 && step % (dash + gap) >= dash) continue;
    const x = Math.round(x0 + ((x1 - x0) * step) / steps); const y = Math.round(y0 + ((y1 - y0) * step) / steps);
    fillRect(frame, x - offset, y - offset, thickness, thickness, level);
  }
}

/** Circle outline; with `dash`/`gap` (pixels along the circumference) a dashed one. */
export function circle(frame: Frame, cx: number, cy: number, radius: number, level: number, options: DashOptions = {}): void {
  const dash = Math.max(1, options.dash ?? 1); const gap = Math.max(0, options.gap ?? 0); const thickness = Math.max(1, options.thickness ?? 1);
  const steps = Math.max(16, Math.round(2 * Math.PI * radius));
  const offset = Math.floor(thickness / 2);
  for (let step = 0; step < steps; step += 1) {
    if (gap > 0 && step % (dash + gap) >= dash) continue;
    const angle = (step / steps) * Math.PI * 2;
    fillRect(frame, Math.round(cx + Math.cos(angle) * radius) - offset, Math.round(cy + Math.sin(angle) * radius) - offset, thickness, thickness, level);
  }
}

export function dashedCircle(frame: Frame, cx: number, cy: number, radius: number, level: number, options: DashOptions = {}): void {
  circle(frame, cx, cy, radius, level, { dash: options.dash ?? 5, gap: options.gap ?? 4, thickness: options.thickness ?? 1 });
}

export function fillCircle(frame: Frame, cx: number, cy: number, radius: number, level: number): void {
  for (let y = -radius; y <= radius; y += 1) for (let x = -radius; x <= radius; x += 1) if (x * x + y * y <= radius * radius + radius) plot(frame, cx + x, cy + y, level);
}

export type Point = readonly [number, number];

/** Filled triangle (scanline over the bounding box, edge-function test). */
export function fillTriangle(frame: Frame, a: Point, b: Point, c: Point, level: number): void {
  const minX = Math.floor(Math.min(a[0], b[0], c[0])); const maxX = Math.ceil(Math.max(a[0], b[0], c[0]));
  const minY = Math.floor(Math.min(a[1], b[1], c[1])); const maxY = Math.ceil(Math.max(a[1], b[1], c[1]));
  const edge = (p: Point, q: Point, x: number, y: number): number => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
  const area = edge(a, b, c[0], c[1]);
  if (area === 0) return;
  for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
    const w0 = edge(b, c, x, y); const w1 = edge(c, a, x, y); const w2 = edge(a, b, x, y);
    if (area > 0 ? w0 >= 0 && w1 >= 0 && w2 >= 0 : w0 <= 0 && w1 <= 0 && w2 <= 0) plot(frame, x, y, level);
  }
}

/** Unit vector for a compass bearing on a north-up screen (0 = up, 90 = right). */
export function bearing(degrees: number): [number, number] {
  const radians = (degrees * Math.PI) / 180;
  return [Math.sin(radians), -Math.cos(radians)];
}

/** A small filled triangle centred on (cx, cy), its tip pointing to `degrees` (0 = up). */
export function triangle(frame: Frame, cx: number, cy: number, size: number, degrees: number, level: number): void {
  const [dx, dy] = bearing(degrees); const [px, py] = [-dy, dx];
  const tip: Point = [cx + dx * size, cy + dy * size];
  const back: Point = [cx - dx * size * 0.6, cy - dy * size * 0.6];
  fillTriangle(frame, tip, [back[0] + px * size * 0.7, back[1] + py * size * 0.7], [back[0] - px * size * 0.7, back[1] - py * size * 0.7], level);
}

/** An arrow through (cx, cy), `length` long, pointing to `degrees` (0 = up). */
export function arrow(frame: Frame, cx: number, cy: number, length: number, degrees: number, level: number, thickness = 2): void {
  const [dx, dy] = bearing(degrees); const half = length / 2; const head = Math.max(4, length * 0.28);
  line(frame, cx - dx * half, cy - dy * half, cx + dx * (half - head * 0.8), cy + dy * (half - head * 0.8), level, thickness);
  triangle(frame, cx + dx * (half - head * 0.5), cy + dy * (half - head * 0.5), head * 0.6, degrees, level);
}

export interface CrosshairOptions { readonly arm?: number; readonly gap?: number; readonly halo?: boolean; readonly thickness?: number; }

/** A crosshair with a free centre; with `halo` a black border keeps it readable on any background. */
export function crosshair(frame: Frame, cx: number, cy: number, level: number, options: CrosshairOptions = {}): void {
  const arm = options.arm ?? 9; const gap = options.gap ?? 3; const thickness = options.thickness ?? 1;
  const half = Math.floor(thickness / 2);
  if (options.halo ?? true) {
    fillRect(frame, cx - arm - 1, cy - half - 1, arm * 2 + 3, thickness + 2, 0);
    fillRect(frame, cx - half - 1, cy - arm - 1, thickness + 2, arm * 2 + 3, 0);
  }
  for (const sign of [-1, 1]) {
    fillRect(frame, sign < 0 ? cx - arm : cx + gap, cy - half, arm - gap + 1, thickness, level);
    fillRect(frame, cx - half, sign < 0 ? cy - arm : cy + gap, thickness, arm - gap + 1, level);
  }
  plot(frame, cx, cy, level);
}

/** `#` cells of a text pattern, each drawn as a `scale` x `scale` block. */
export function pattern(frame: Frame, rows: readonly string[], x: number, y: number, scale: number, level: number): void {
  rows.forEach((row, rowIndex) => { for (let column = 0; column < row.length; column += 1) if (row[column] === "#") fillRect(frame, x + column * scale, y + rowIndex * scale, scale, scale, level); });
}

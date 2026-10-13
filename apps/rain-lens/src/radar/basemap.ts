import { createBitmap, drawText, textWidth, type Bitmap } from "../glasses/bitmap";
import { drawLabel, GLYPH_HEIGHT, labelText, labelWidth } from "./label-font";
import { ANCHOR, MAP, SCREEN_HEIGHT, SCREEN_WIDTH } from "./layout";
import { BORDERS, COAST, LAKES, MAP_ZOOM, PLACES, RIVERS } from "./map-data";
import { RADAR_ZOOM, metersPerPixel, worldPixel, type Position } from "./tiles";

/**
 * The base map under the radar, drawn offline from embedded Natural Earth data
 * (map-data.ts): country borders, coastline, lakes, big rivers and place names.
 *
 * It comes in two layers so the rain stays the brightest thing on screen:
 * - `lines` lies under the radar and is dim (levels 2…3). Where it rains, a
 *   line is cut black into the rain, so the borders stay readable inside it.
 * - `overlay` lies on top: place dots and names with a black halo
 *   (TRANSPARENT where it has nothing).
 *
 * A base map depends only on place, zoom and language, so it is drawn once and
 * reused for every radar frame (`baseMapFor` keeps the last one).
 */

export const TRANSPARENT = 255;
/**
 * Grey levels of the map. The display lifts dark levels a lot (in the
 * simulator level 5 already shows at ~77 % brightness), so the map stays at
 * 2…3 and the rain starts at 6.
 */
export const LEVEL = { border: 3, coast: 3, lake: 3, river: 2, ring: 2, ringLabel: 3, dot: 12, label: 10 } as const;
/** Line pixels under rain are cut black into it. */
export const CUT_LEVEL = 0;
export const RING_KM = [100, 200] as const;
/** At most this many names, so the radar stays the main thing. */
export const MAX_LABELS = 14;
/** The nearest place is named in the header when it is at most this far away. */
export const NEAREST_MAX_KM = 30;

export interface Place { readonly de: string; readonly en: string; readonly x: number; readonly y: number; readonly population: number }
interface Polyline { readonly points: Int32Array; readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }

export interface LabelBox { readonly name: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly dotX: number; readonly dotY: number }

export interface BaseMap {
  readonly key: string;
  readonly lines: Uint8Array;
  readonly overlay: Uint8Array;
  readonly labels: readonly LabelBox[];
  /** The nearest place within NEAREST_MAX_KM, in the display language. */
  readonly nearest: string | null;
}

function decodeLines(encoded: string): Polyline[] {
  if (!encoded) return [];
  return encoded.split(" ").map((word) => {
    const values: number[] = [];
    let index = 0;
    while (index < word.length) {
      let shift = 0; let result = 0; let byte: number;
      do { byte = word.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20 && index < word.length);
      values.push(result & 1 ? ~(result >> 1) : result >> 1);
    }
    const points = new Int32Array(values.length & ~1);
    let x = 0; let y = 0; let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (let at = 0; at + 1 < values.length; at += 2) {
      x += values[at]!; y += values[at + 1]!;
      points[at] = x; points[at + 1] = y;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return { points, minX, minY, maxX, maxY };
  });
}

let decoded: { borders: Polyline[]; coast: Polyline[]; lakes: Polyline[]; rivers: Polyline[]; places: Place[] } | null = null;
/** The embedded data, decoded on first use. */
function data(): NonNullable<typeof decoded> {
  decoded ??= {
    borders: decodeLines(BORDERS), coast: decodeLines(COAST), lakes: decodeLines(LAKES), rivers: decodeLines(RIVERS),
    places: PLACES.split("\n").flatMap((line) => {
      const [de, en, x, y, population] = line.split("|");
      if (!de || x === undefined || y === undefined) return [];
      return [{ de, en: en || de, x: Number(x), y: Number(y), population: Number(population) || 0 }];
    }),
  };
  return decoded;
}

/** Every place in the data, most populous first. */
export function allPlaces(): readonly Place[] { return data().places; }

export const placeName = (place: Place, locale: string): string => (locale === "de" ? place.de : place.en);

/** Longest name written on the map; a longer one gives way to its shorter other-language name, or is left out. */
export const MAX_NAME = 14;

/** The name as written on the map (capitals of the label font), or null when none fits. */
export function mapName(place: Place, locale: string): string | null {
  const names = [placeName(place, locale), locale === "de" ? place.en : place.de].map(labelText).filter((name): name is string => name !== null);
  const first = names[0];
  if (first && first.length <= 12) return first;
  const shortest = names.sort((a, b) => a.length - b.length)[0];
  return shortest && shortest.length <= MAX_NAME ? shortest : null;
}

/** Screen position of a world pixel at the map zoom, for a map centred on `position` at `zoom`. */
function projector(position: Position, zoom: number): (wx: number, wy: number) => [number, number] {
  const center = worldPixel(position, zoom);
  const scale = 2 ** (zoom - MAP_ZOOM);
  const offsetX = MAP.x + ANCHOR.x - center.x; const offsetY = MAP.y + ANCHOR.y - center.y;
  return (wx, wy) => [wx * scale + offsetX, wy * scale + offsetY];
}

const inMap = (x: number, y: number): boolean => x >= MAP.x && x < MAP.x + MAP.width && y >= MAP.y && y < MAP.y + MAP.height;

/** Draws a polyline pixel by pixel; `dash` = [on, off] keeps its rhythm across the corners. */
function stroke(target: Uint8Array, line: Polyline, project: (wx: number, wy: number) => [number, number], level: number, dash?: readonly [number, number]): void {
  let step = 0;
  for (let at = 0; at + 3 < line.points.length; at += 2) {
    const [x0, y0] = project(line.points[at]!, line.points[at + 1]!);
    const [x1, y1] = project(line.points[at + 2]!, line.points[at + 3]!);
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let i = at === 0 ? 0 : 1; i <= steps; i += 1) {
      const on = !dash || step % (dash[0] + dash[1]) < dash[0];
      step += 1;
      if (!on) continue;
      const x = Math.round(x0 + ((x1 - x0) * i) / steps); const y = Math.round(y0 + ((y1 - y0) * i) / steps);
      if (inMap(x, y)) target[y * SCREEN_WIDTH + x] = Math.max(target[y * SCREEN_WIDTH + x]!, level);
    }
  }
}

function strokeAll(target: Uint8Array, lines: readonly Polyline[], position: Position, zoom: number, level: number, dash?: readonly [number, number]): void {
  const project = projector(position, zoom);
  const [left, top] = project(0, 0); const scale = 2 ** (zoom - MAP_ZOOM);
  // Only lines whose box touches the map area (in world pixels at the data zoom).
  const minX = (MAP.x - left) / scale - 1; const maxX = (MAP.x + MAP.width - left) / scale + 1;
  const minY = (MAP.y - top) / scale - 1; const maxY = (MAP.y + MAP.height - top) / scale + 1;
  for (const line of lines) if (line.maxX >= minX && line.minX <= maxX && line.maxY >= minY && line.minY <= maxY) stroke(target, line, project, level, dash);
}

/** A dotted circle clipped to the map area. */
function ring(target: Uint8Array, cx: number, cy: number, radius: number, level: number): void {
  const steps = Math.max(24, Math.round(radius * 1.2));
  for (let step = 0; step < steps; step += 1) {
    if (step % 3 === 2) continue;
    const angle = (step / steps) * Math.PI * 2;
    const x = Math.round(cx + Math.cos(angle) * radius); const y = Math.round(cy + Math.sin(angle) * radius);
    if (inMap(x, y)) target[y * SCREEN_WIDTH + x] = level;
  }
}

interface Box { x: number; y: number; width: number; height: number }
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Rough distance in km between two places given as world pixels at the data zoom. */
function kmBetween(position: Position, place: Place): number {
  const here = worldPixel(position, MAP_ZOOM);
  return (Math.hypot(here.x - place.x, here.y - place.y) * metersPerPixel(position.latitude, MAP_ZOOM)) / 1000;
}

/** The nearest place to `position` within `maxKm`, or null. */
export function nearestPlace(position: Position, maxKm = NEAREST_MAX_KM): Place | null {
  let best: Place | null = null; let bestKm = maxKm;
  for (const place of data().places) {
    const km = kmBetween(position, place);
    if (km <= bestKm) { best = place; bestKm = km; }
  }
  return best;
}

/**
 * Chooses which names fit: most populous first, each tried right, left, above
 * and below its dot; a name that would touch another name, a dot, the cross,
 * a ring label or the edge of the map is left out together with its dot.
 */
export function placeLabels(position: Position, zoom: number, locale: string, blocked: readonly Box[] = []): LabelBox[] {
  const project = projector(position, zoom);
  const cx = MAP.x + ANCHOR.x; const cy = MAP.y + ANCHOR.y;
  const taken: Box[] = [{ x: cx - 13, y: cy - 13, width: 27, height: 27 }, ...blocked];
  const labels: LabelBox[] = [];
  const GAP = 2;
  for (const place of data().places) {
    if (labels.length >= MAX_LABELS) break;
    const [fx, fy] = project(place.x, place.y);
    const x = Math.round(fx); const y = Math.round(fy);
    if (x < MAP.x + 3 || x > MAP.x + MAP.width - 4 || y < MAP.y + 3 || y > MAP.y + MAP.height - 4) continue;
    const text = mapName(place, locale);
    if (!text) continue;
    const width = labelWidth(text);
    const dot: Box = { x: x - 2, y: y - 2, width: 5, height: 5 };
    if (taken.some((box) => overlaps(box, dot))) continue;
    const options: Box[] = [
      { x: x + 4, y: y - 3, width, height: GLYPH_HEIGHT },
      { x: x - 4 - width, y: y - 3, width, height: GLYPH_HEIGHT },
      { x: x - Math.floor(width / 2), y: y - 4 - GLYPH_HEIGHT, width, height: GLYPH_HEIGHT },
      { x: x - Math.floor(width / 2), y: y + 4, width, height: GLYPH_HEIGHT },
    ];
    const fits = options.find((box) => box.x >= MAP.x + 1 && box.x + box.width <= MAP.x + MAP.width - 1 && box.y >= MAP.y + 1 && box.y + box.height <= MAP.y + MAP.height - 1
      && !taken.some((other) => overlaps({ x: box.x - GAP, y: box.y - GAP, width: box.width + GAP * 2, height: box.height + GAP * 2 }, other)));
    if (!fits) continue;
    taken.push(dot, { x: fits.x - 1, y: fits.y - 1, width: fits.width + 2, height: fits.height + 2 });
    labels.push({ name: text, ...fits, dotX: x, dotY: y });
  }
  return labels;
}

/** Draws the base map for a place (no cache; see `baseMapFor`). */
export function drawBaseMap(position: Position, zoom = RADAR_ZOOM, locale = "de"): BaseMap {
  const { borders, coast, lakes, rivers } = data();
  const lines = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  strokeAll(lines, rivers, position, zoom, LEVEL.river);
  strokeAll(lines, lakes, position, zoom, LEVEL.lake);
  strokeAll(lines, coast, position, zoom, LEVEL.coast);
  strokeAll(lines, borders, position, zoom, LEVEL.border, [2, 2]);

  // Range rings for scale, with their label at the upper right.
  const cx = MAP.x + ANCHOR.x; const cy = MAP.y + ANCHOR.y;
  const perPixel = metersPerPixel(position.latitude, zoom);
  const ringLabels: Box[] = [];
  const ringBitmap: Bitmap = { width: SCREEN_WIDTH, height: SCREEN_HEIGHT, pixels: lines };
  for (const km of RING_KM) {
    const radius = (km * 1000) / perPixel;
    ring(lines, cx, cy, radius, LEVEL.ring);
    const label = `${km} KM`;
    const labelX = Math.round(cx + radius * Math.SQRT1_2 + 3); const labelY = Math.round(cy - radius * Math.SQRT1_2 - 5);
    if (labelX + textWidth(label, 1) < MAP.x + MAP.width && labelY > MAP.y && labelY + 5 < MAP.y + MAP.height) {
      drawText(ringBitmap, label, labelX, labelY, 1, LEVEL.ringLabel);
      ringLabels.push({ x: labelX - 2, y: labelY - 2, width: textWidth(label, 1) + 4, height: 9 });
    }
  }

  const labels = placeLabels(position, zoom, locale, ringLabels);
  const overlay = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT).fill(TRANSPARENT);
  const ink = createBitmap(SCREEN_WIDTH, SCREEN_HEIGHT);
  for (const label of labels) {
    for (let y = -1; y <= 1; y += 1) for (let x = -1; x <= 1; x += 1) ink.pixels[(label.dotY + y) * SCREEN_WIDTH + label.dotX + x] = LEVEL.dot;
    drawLabel(ink, label.name, label.x, label.y, LEVEL.label);
  }
  // Black halo one pixel around everything inked, then the ink itself.
  for (let y = MAP.y; y < MAP.y + MAP.height; y += 1) for (let x = MAP.x; x < MAP.x + MAP.width; x += 1) {
    const level = ink.pixels[y * SCREEN_WIDTH + x]!;
    if (level > 0) { overlay[y * SCREEN_WIDTH + x] = level; continue; }
    let near = false;
    for (let dy = -1; dy <= 1 && !near; dy += 1) for (let dx = -1; dx <= 1; dx += 1) if ((ink.pixels[(y + dy) * SCREEN_WIDTH + x + dx] ?? 0) > 0) { near = true; break; }
    if (near) overlay[y * SCREEN_WIDTH + x] = 0;
  }

  const nearest = nearestPlace(position);
  return { key: mapKey(position, zoom, locale), lines, overlay, labels, nearest: nearest ? placeName(nearest, locale) : null };
}

/** Same key = same picture: the place rounded to whole map pixels, the zoom and the language. */
export function mapKey(position: Position, zoom: number, locale: string): string {
  const at = worldPixel(position, zoom);
  return `${zoom}/${Math.round(at.x)}/${Math.round(at.y)}/${locale}`;
}

let last: BaseMap | null = null;
/** The base map for this place, drawn only when place, zoom or language changed. */
export function baseMapFor(position: Position, zoom = RADAR_ZOOM, locale = "de"): BaseMap {
  const key = mapKey(position, zoom, locale);
  if (last?.key !== key) last = drawBaseMap(position, zoom, locale);
  return last;
}

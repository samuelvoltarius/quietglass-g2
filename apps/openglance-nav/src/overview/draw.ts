import type { LatLng } from "../geo/geometry";
import type { PixelPoint } from "./project";
import type { RoadClass, Street } from "./streets";
import { drawLabels, placeLabels } from "./labels";
import { mapProjector, MARKER_AT, MAP_HEIGHT, MAP_TILES, MAP_WIDTH, PLATE, SPEED_PLATE, TILE_HEIGHT, TILE_WIDTH, type MapView } from "./camera";

/**
 * Map drawing for the whole display: black background, the real streets
 * around the route in grey (when they could be loaded), the route as one thick
 * white line with a black edge so it stands clear of them, a ring on the next
 * turn, a square at the destination, and the car as a large chevron.
 *
 * The picture is 576 x 288 and is cut into four 288 x 144 images, the largest
 * the G2 accepts, which together cover the display. The glasses convert images
 * to 16 grey levels, so streets can be dimmer than the route without
 * disappearing: major roads brighter and thicker, minor roads dim, footpaths
 * faint.
 */

/** The slice of the 2D canvas API the map uses, so drawing can be checked against a recording fake in node. */
export type MapContext = Pick<CanvasRenderingContext2D, "fillStyle" | "strokeStyle" | "lineWidth" | "lineCap" | "lineJoin" | "font" | "fillRect" | "beginPath" | "moveTo" | "lineTo" | "stroke" | "arc" | "fill" | "strokeRect" | "fillText">;

/** Stroke per road class: brightness and width on a 16-grey display. */
export const STREET_STYLE: Readonly<Record<RoadClass, { readonly color: string; readonly width: number }>> = {
  major: { color: "#b0b0b0", width: 5 },
  minor: { color: "#707070", width: 3 },
  path: { color: "#484848", width: 2 },
};

/** Faintest first, so a major road is never painted over by a footpath. */
const STREET_ORDER: readonly RoadClass[] = ["path", "minor", "major"];
/** The route: a white line this thick on a black edge this thick. */
export const ROUTE_WIDTH = 16;
export const ROUTE_EDGE = 28;

export interface MapScene {
  /** The whole route. */
  readonly route: readonly LatLng[];
  /** Where the next manoeuvre happens; null shows no ring. */
  readonly next: LatLng | null;
  readonly streets: readonly Street[];
  readonly view: MapView;
  /** Index into `route` of the next manoeuvre; with the two names below it decides which streets get a label. */
  readonly nextIndex?: number | null;
  /** The street the next manoeuvre leads onto, and the one the car is on now. */
  readonly nextStreet?: string | undefined;
  readonly currentStreet?: string | undefined;
  /** Charging stations to mark (driving, when the setting is on). */
  readonly chargers?: readonly LatLng[];
  /** Draw the black plate for the speed line on the bottom left (driving, cycling). */
  readonly speedPlate?: boolean;
}

/** A charging station: a white plate with a black lightning bolt, black-edged so it reads on the route too. */
export function drawCharger(ctx: MapContext, at: PixelPoint): void {
  const s = 13;
  ctx.fillStyle = "#000"; ctx.fillRect(at.x - s - 3, at.y - s - 3, 2 * s + 6, 2 * s + 6);
  ctx.fillStyle = "#fff"; ctx.fillRect(at.x - s, at.y - s, 2 * s, 2 * s);
  const bolt = [
    { x: 3, y: -11 }, { x: -7, y: 2 }, { x: -1, y: 2 }, { x: -3, y: 11 }, { x: 7, y: -2 }, { x: 1, y: -2 }, { x: 3, y: -11 },
  ];
  ctx.fillStyle = "#000"; ctx.beginPath();
  bolt.forEach((p, i) => (i === 0 ? ctx.moveTo(at.x + p.x, at.y + p.y) : ctx.lineTo(at.x + p.x, at.y + p.y)));
  ctx.fill();
}

/** Beyond this the canvas has nothing to draw; keeps absurd coordinates (zoomed far in on a far-off point) out of the strokes. */
const LIMIT = 4000;
const clampPoint = (point: PixelPoint): PixelPoint => ({
  x: Math.max(-LIMIT, Math.min(LIMIT, point.x)),
  y: Math.max(-LIMIT, Math.min(LIMIT, point.y)),
});

/** Adds a polyline to the current path, skipping points less than `step` pixels from the last one. */
function polyline(ctx: MapContext, points: readonly PixelPoint[], step: number): void {
  let last: PixelPoint | null = null;
  points.forEach((raw, index) => {
    if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) { last = null; return; }
    const point = clampPoint(raw);
    if (!last) { ctx.moveTo(point.x, point.y); last = point; return; }
    const isEnd = index === points.length - 1;
    if (!isEnd && Math.hypot(point.x - last.x, point.y - last.y) < step) return;
    ctx.lineTo(point.x, point.y); last = point;
  });
}

/** The car: a chevron pointing up (the map is turned to the direction of travel), black-edged. */
function drawCar(ctx: MapContext, at: PixelPoint, upward: boolean): void {
  if (!upward) {
    // North up and no direction known: a ringed dot says "you are here" without claiming a heading.
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(at.x, at.y, 17, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#000"; ctx.beginPath(); ctx.arc(at.x, at.y, 11, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(at.x, at.y, 6, 0, Math.PI * 2); ctx.fill();
    return;
  }
  const chevron = [
    { x: at.x, y: at.y - 36 }, { x: at.x + 27, y: at.y + 24 }, { x: at.x, y: at.y + 9 }, { x: at.x - 27, y: at.y + 24 }, { x: at.x, y: at.y - 36 },
  ];
  const trace = (): void => { ctx.beginPath(); chevron.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)); };
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.strokeStyle = "#000"; ctx.lineWidth = 12; trace(); ctx.stroke();
  ctx.fillStyle = "#fff"; trace(); ctx.fill();
}

/** A small compass top right: the needle points to north wherever the map is turned to. */
function drawCompass(ctx: MapContext, width: number, bearing: number | null): void {
  const centre = { x: width - 44, y: 52 };
  const phi = (-(bearing ?? 0) * Math.PI) / 180;
  const north = { x: Math.sin(phi), y: -Math.cos(phi) };
  const side = { x: Math.cos(phi), y: Math.sin(phi) };
  ctx.fillStyle = "#000"; ctx.beginPath(); ctx.arc(centre.x, centre.y, 24, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#808080"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(centre.x, centre.y, 24, 0, Math.PI * 2); ctx.stroke();
  const tip = { x: centre.x + north.x * 20, y: centre.y + north.y * 20 };
  const base = { x: centre.x - north.x * 3, y: centre.y - north.y * 3 };
  ctx.fillStyle = "#fff"; ctx.beginPath();
  ctx.moveTo(tip.x, tip.y); ctx.lineTo(base.x + side.x * 9, base.y + side.y * 9); ctx.lineTo(base.x - side.x * 9, base.y - side.y * 9); ctx.lineTo(tip.x, tip.y);
  ctx.fill();
  ctx.font = "bold 18px sans-serif";
  ctx.fillText("N", centre.x + north.x * 37 - 6, centre.y + north.y * 37 + 6);
}

/**
 * Draws the whole map. An empty route draws only the background, the car and
 * the plate; no streets means the route alone.
 */
export function drawMap(ctx: MapContext, scene: MapScene, width = MAP_WIDTH, height = MAP_HEIGHT): void {
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height);
  const toPixel = mapProjector(scene.view);
  ctx.lineCap = "round"; ctx.lineJoin = "round";

  if (scene.route.length && scene.streets.length) {
    for (const cls of STREET_ORDER) {
      const own = scene.streets.filter((street) => street.cls === cls);
      if (!own.length) continue;
      const style = STREET_STYLE[cls];
      ctx.strokeStyle = style.color; ctx.lineWidth = style.width;
      // One path per class: hundreds of tiny strokes cost far more than one.
      ctx.beginPath();
      for (const street of own) polyline(ctx, street.points.map(toPixel), 1.5);
      ctx.stroke();
    }
  }

  const pixels = scene.route.map(toPixel);
  if (pixels.length) {
    if (scene.streets.length) {
      // A black edge keeps the route readable where it runs along a street.
      ctx.strokeStyle = "#000"; ctx.lineWidth = ROUTE_EDGE;
      ctx.beginPath(); polyline(ctx, pixels, 2); ctx.stroke();
    }
    ctx.strokeStyle = "#fff"; ctx.lineWidth = ROUTE_WIDTH;
    ctx.beginPath(); polyline(ctx, pixels, 2); ctx.stroke();
  }

  if (scene.next && pixels.length) {
    const turn = toPixel(scene.next);
    ctx.strokeStyle = "#000"; ctx.lineWidth = 9; ctx.beginPath(); ctx.arc(turn.x, turn.y, 24, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(turn.x, turn.y, 24, 0, Math.PI * 2); ctx.stroke();
  }

  const end = pixels[pixels.length - 1];
  if (end) {
    ctx.strokeStyle = "#000"; ctx.lineWidth = 9; ctx.strokeRect(end.x - 13, end.y - 13, 26, 26);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 4; ctx.strokeRect(end.x - 13, end.y - 13, 26, 26);
  }

  // Charging stations on the picture (not under the plate or the car).
  for (const charger of scene.chargers ?? []) {
    const p = toPixel(charger);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 16 || p.x > width - 16 || p.y < 16 || p.y > height - 16) continue;
    if (p.x < PLATE.width + 16 && p.y < PLATE.height + 16) continue;
    if (scene.speedPlate && p.x < SPEED_PLATE.width + 16 && p.y > height - SPEED_PLATE.height - 16) continue;
    drawCharger(ctx, p);
  }

  // Street names, over streets and route but under the car, compass and plate.
  if (pixels.length) {
    drawLabels(ctx, placeLabels({
      width, height, toPixel, route: scene.route, nextIndex: scene.next ? scene.nextIndex ?? null : null,
      nextStreet: scene.nextStreet, currentStreet: scene.currentStreet, streets: scene.streets,
      ...(scene.speedPlate ? { speedPlate: true } : {}),
    }));
  }

  // The map is centred on the car, so the car is always at the marker place.
  drawCar(ctx, MARKER_AT, scene.view.bearing !== null);

  drawCompass(ctx, width, scene.view.bearing);

  // The plate goes last, over everything, so the text on it always reads.
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, PLATE.width, PLATE.height);
  ctx.strokeStyle = "#606060"; ctx.lineWidth = 2; ctx.strokeRect(0, 0, PLATE.width, PLATE.height);
  if (scene.speedPlate) {
    const top = height - SPEED_PLATE.height;
    ctx.fillStyle = "#000"; ctx.fillRect(0, top, SPEED_PLATE.width, SPEED_PLATE.height);
    ctx.strokeStyle = "#606060"; ctx.lineWidth = 2; ctx.strokeRect(0, top, SPEED_PLATE.width, SPEED_PLATE.height);
  }
}

/** The map as four PNG tiles in {@link MAP_TILES} order. */
export async function renderMapTiles(scene: MapScene): Promise<Uint8Array[]> {
  const canvas = document.createElement("canvas"); canvas.width = MAP_WIDTH; canvas.height = MAP_HEIGHT;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("2d canvas unavailable");
  drawMap(ctx, scene, MAP_WIDTH, MAP_HEIGHT);
  const tiles: Uint8Array[] = [];
  for (const tile of MAP_TILES) {
    const part = document.createElement("canvas"); part.width = TILE_WIDTH; part.height = TILE_HEIGHT;
    const partCtx = part.getContext("2d"); if (!partCtx) throw new Error("2d canvas unavailable");
    partCtx.drawImage(canvas, tile.x, tile.y, TILE_WIDTH, TILE_HEIGHT, 0, 0, TILE_WIDTH, TILE_HEIGHT);
    const blob: Blob = await new Promise((resolve, reject) => part.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encode failed")), "image/png"));
    tiles.push(new Uint8Array(await blob.arrayBuffer()));
  }
  return tiles;
}

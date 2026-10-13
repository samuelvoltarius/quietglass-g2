import type { Bitmap } from "../glasses/bitmap";
import { RAINVIEWER_HOST, RADAR_ZOOM, TILE_SIZE, tileUrl, type Position } from "./tiles";
import { bitmapKey, composeFrame, neededTiles, splitTiles, type TileLevels } from "./frame";
import { levelsFromRgba } from "./intensity";

/**
 * Loading the radar: the list of recent frames, then the tiles of each frame,
 * composed into the four display pieces. Network and decoding are injected, so
 * everything here runs in node tests.
 *
 * Radar data: RainViewer (https://www.rainviewer.com/api.html). Their terms
 * allow personal and educational use and ask for a visible source credit,
 * which the radar page carries; the radar is only built into the private
 * build for that reason.
 */

export const INDEX_URL = "https://api.rainviewer.com/public/weather-maps.json";
/** The loop shows this many of the most recent frames, oldest first. */
export const FRAME_COUNT = 6;
export const FETCH_TIMEOUT_MS = 10_000;
/** Tiles fetched at once; RainViewer allows about 500 requests a minute. */
export const CONCURRENCY = 6;
/** A loaded radar is reloaded after this long (frames are ten minutes apart). */
export const MAX_AGE_MS = 5 * 60_000;

export interface RadarIndexFrame { readonly time: number; readonly path: string; }
export interface RadarIndex { readonly frames: readonly RadarIndexFrame[]; }

/** Only paths RainViewer really uses; a path comes from the network and ends up in a URL. */
const PATH = /^\/v2\/radar\/[0-9a-zA-Z_-]{4,64}$/;

/**
 * The newest `FRAME_COUNT` frames of the index (past, then nowcast if there
 * is any), oldest first. Throws when there is nothing usable.
 */
export function parseIndex(json: unknown): RadarIndex {
  const radar = (json as { radar?: { past?: unknown; nowcast?: unknown } } | null)?.radar;
  const list = (value: unknown): RadarIndexFrame[] => (Array.isArray(value) ? value : []).flatMap((item) => {
    const entry = item as { time?: unknown; path?: unknown };
    return typeof entry.time === "number" && Number.isFinite(entry.time) && typeof entry.path === "string" && PATH.test(entry.path)
      ? [{ time: entry.time, path: entry.path }]
      : [];
  });
  const frames = [...list(radar?.past), ...list(radar?.nowcast)].sort((a, b) => a.time - b.time).slice(-FRAME_COUNT);
  if (frames.length === 0) throw new Error("radar has no frames");
  return { frames };
}

export type Fetcher = typeof fetch;
/** Decodes a tile image into grey levels (256 x 256 bytes). */
export type TileDecoder = (blob: Blob) => Promise<Uint8Array>;

async function timedFetch(fetchImpl: Fetcher, url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } catch (cause) {
    if (controller.signal.aborted) throw new Error("timed out");
    throw cause;
  } finally { clearTimeout(timeout); }
}

export async function fetchIndex(fetchImpl: Fetcher = fetch): Promise<RadarIndex> {
  return parseIndex(await (await timedFetch(fetchImpl, INDEX_URL)).json());
}

/** Browser decoding: the PNG onto a canvas, then pixel by pixel to grey levels. */
export const decodeTileInBrowser: TileDecoder = async (blob) => {
  const image = await createImageBitmap(blob);
  const canvas = document.createElement("canvas"); canvas.width = TILE_SIZE; canvas.height = TILE_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true }); if (!ctx) throw new Error("2d canvas unavailable");
  ctx.drawImage(image, 0, 0, TILE_SIZE, TILE_SIZE);
  image.close?.();
  return levelsFromRgba(ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data, TILE_SIZE * TILE_SIZE);
};

export interface RadarFrame {
  /** When the radar was taken, seconds since 1970. */
  readonly time: number;
  /** The four display pieces, in container order. */
  readonly tiles: readonly [Bitmap, Bitmap, Bitmap, Bitmap];
  /** Fingerprints of the pieces; unchanged pieces are not sent again. */
  readonly keys: readonly [string, string, string, string];
}

export interface RadarData {
  readonly position: Position;
  readonly frames: readonly RadarFrame[];
  readonly loadedAt: number;
  /** True for the made-up demo radar. */
  readonly synthetic?: boolean;
}

export interface LoadOptions {
  readonly fetchImpl?: Fetcher;
  readonly decode?: TileDecoder;
  readonly now?: () => number;
  readonly zoom?: number;
}

/** Runs `jobs` with at most `limit` at a time. */
async function pool<T>(jobs: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < jobs.length; index = next++) results[index] = await jobs[index]!();
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

export function composeData(position: Position, frames: readonly { time: number; lookup: (tx: number, ty: number) => TileLevels }[], now: number, zoom = RADAR_ZOOM, synthetic = false): RadarData {
  return {
    position, loadedAt: now, ...(synthetic ? { synthetic: true } : {}),
    frames: frames.map((frame) => {
      const tiles = splitTiles(composeFrame(position, frame.lookup, zoom));
      return { time: frame.time, tiles, keys: [bitmapKey(tiles[0]), bitmapKey(tiles[1]), bitmapKey(tiles[2]), bitmapKey(tiles[3])] };
    }),
  };
}

/**
 * Loads the recent frames around `position`. A tile that cannot be fetched
 * counts as "no data" (blank); only when every tile fails is it an error, so a
 * flaky link still gives a picture.
 */
export async function loadRadar(position: Position, options: LoadOptions = {}): Promise<RadarData> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const decode = options.decode ?? decodeTileInBrowser;
  const zoom = options.zoom ?? RADAR_ZOOM;
  const index = await fetchIndex(fetchImpl);
  const placements = neededTiles(position, zoom);
  let attempted = 0; let failed = 0;
  const jobs = index.frames.flatMap((frame) => placements.map((placement) => async (): Promise<{ frame: number; key: string; levels: TileLevels }> => {
    attempted += 1;
    try {
      const response = await timedFetch(fetchImpl, tileUrl(frame.path, zoom, placement.tx, placement.ty, RAINVIEWER_HOST));
      return { frame: frame.time, key: `${placement.tx}/${placement.ty}`, levels: await decode(await response.blob()) };
    } catch {
      failed += 1;
      return { frame: frame.time, key: `${placement.tx}/${placement.ty}`, levels: null };
    }
  }));
  const results = await pool(jobs, CONCURRENCY);
  if (attempted > 0 && failed === attempted) throw new Error("radar tiles could not be loaded");
  const byFrame = new Map<number, Map<string, TileLevels>>();
  for (const result of results) {
    const tiles = byFrame.get(result.frame) ?? new Map<string, TileLevels>();
    tiles.set(result.key, result.levels); byFrame.set(result.frame, tiles);
  }
  const now = (options.now ?? Date.now)();
  return composeData(position, index.frames.map((frame) => ({ time: frame.time, lookup: (tx, ty) => byFrame.get(frame.time)?.get(`${tx}/${ty}`) ?? null })), now, zoom);
}

/** True when the loaded radar is for another place or has grown old. */
export function isStale(data: RadarData | null, position: Position, now: number): boolean {
  if (!data) return true;
  if (now - data.loadedAt > MAX_AGE_MS) return true;
  return Math.abs(data.position.latitude - position.latitude) > 0.05 || Math.abs(data.position.longitude - position.longitude) > 0.05;
}

/**
 * Which frame the loop shows at `tick`: oldest to newest, with the newest
 * held for two ticks so the eye rests on "now" before it starts again.
 */
export function frameAt(tick: number, count: number): number {
  if (count <= 0) return 0;
  const cycle = count + 1;
  const step = ((tick % cycle) + cycle) % cycle;
  return Math.min(step, count - 1);
}

/** A made-up radar for the ?demo=1 mode: a few rain cells drifting north-east. */
export function syntheticRadar(position: Position, now: number, zoom = RADAR_ZOOM): RadarData {
  const cells = [{ x: 90, y: 60, rx: 70, ry: 38 }, { x: 40, y: 150, rx: 35, ry: 20 }, { x: 160, y: 210, rx: 28, ry: 40 }];
  const frames = Array.from({ length: FRAME_COUNT }, (_, index) => ({
    time: Math.round(now / 1000) - (FRAME_COUNT - 1 - index) * 600,
    lookup: (tx: number, ty: number): TileLevels => {
      // The same cells over the tile grid, shifted by the frame number: a drift of 14 px per step.
      const levels = new Uint8Array(TILE_SIZE * TILE_SIZE);
      const shift = index * 14;
      for (let y = 0; y < TILE_SIZE; y += 1) for (let x = 0; x < TILE_SIZE; x += 1) {
        const gx = tx * TILE_SIZE + x - shift; const gy = ty * TILE_SIZE + y + shift * 0.5;
        let strength = 0;
        for (const cell of cells) {
          const dx = ((gx - cell.x * 4 + 1024) % 1024 + 1024) % 1024; const dy = ((gy - cell.y * 4 + 1024) % 1024 + 1024) % 1024;
          const wx = dx > 512 ? dx - 1024 : dx; const wy = dy > 512 ? dy - 1024 : dy;
          const d = (wx / (cell.rx * 1.6)) ** 2 + (wy / (cell.ry * 1.6)) ** 2;
          if (d < 1) strength = Math.max(strength, 1 - d);
        }
        levels[y * TILE_SIZE + x] = strength > 0.05 ? Math.min(15, 2 + Math.round(strength * 12)) : 0;
      }
      return levels;
    },
  }));
  return composeData(position, frames, now, zoom, true);
}

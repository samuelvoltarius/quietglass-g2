import { frameKey, TILE_HEIGHT, TILE_WIDTH, tiles, type Frame } from "./frame";
import { encodeGreyPng } from "./png";

/**
 * Full-screen kit, part 4: getting a frame onto the glasses.
 *
 * Meant to be copied into other Quietglass G2 apps. A frame is cut into the
 * four 288 x 144 tiles; only tiles whose pixels changed since they were last
 * shown are sent, one transfer at a time, newest frame wins. The page owner
 * calls `reset()` after every page (re)build, because a new page starts with
 * blank image containers.
 */

export interface TileSlot { readonly id: number; readonly name: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number; }

/** The four image containers of a full-screen page, ids `firstId`…`firstId + 3`. */
export function tileSlots(firstId: number, prefix: string): [TileSlot, TileSlot, TileSlot, TileSlot] {
  const slot = (index: number, suffix: string): TileSlot => ({ id: firstId + index, name: `${prefix}-${suffix}`, x: (index % 2) * TILE_WIDTH, y: Math.floor(index / 2) * TILE_HEIGHT, width: TILE_WIDTH, height: TILE_HEIGHT });
  return [slot(0, "nw"), slot(1, "ne"), slot(2, "sw"), slot(3, "se")];
}

/** One image write; resolves true on success. */
export type TileSend = (slot: TileSlot, png: Uint8Array) => Promise<boolean>;

export interface TileSender {
  /** Asks for `frame` to be on the glasses; resolves once its changed tiles went out (or a newer frame took over). */
  push(frame: Frame): Promise<void>;
  /** The page was rebuilt: every tile counts as blank again. */
  reset(): void;
  /** True when no transfer is in flight or waiting. */
  idle(): boolean;
  /** Tiles really sent so far (for tests and diagnostics). */
  sent(): number;
  close(): void;
}

export const TILE_SEND_TIMEOUT_MS = 10_000;

export function createTileSender(slots: readonly TileSlot[], send: TileSend, encode: (frame: Frame) => Uint8Array = encodeGreyPng, timeoutMs = TILE_SEND_TIMEOUT_MS): TileSender {
  const shown: (string | null)[] = slots.map(() => null);
  let wanted: { tiles: Frame[]; keys: string[] } | null = null;
  let busy: Promise<void> | null = null;
  let generation = 0; let count = 0; let closed = false;
  /** Set by push; a pump that ends while it is set runs once more (a push can land after its last check). */
  let dirty = false;

  const sendOne = async (index: number, tile: Frame, key: string): Promise<void> => {
    const slot = slots[index]!; const started = generation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ok = false;
    try {
      ok = await Promise.race([send(slot, encode(tile)), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
    } catch { ok = false; } finally { clearTimeout(timer); }
    if (ok && started === generation) { shown[index] = key; count += 1; }
  };

  /** Sends changed tiles until the newest wanted frame is on the glasses. A failed tile is tried again on the next push. */
  const pump = async (): Promise<void> => {
    const attempted = new Set<string>();
    for (;;) {
      dirty = false;
      if (closed || !wanted) return;
      const target = wanted;
      const index = target.keys.findIndex((key, at) => key !== shown[at] && !attempted.has(`${at}:${key}`));
      if (index < 0) return;
      attempted.add(`${index}:${target.keys[index]}`);
      await sendOne(index, target.tiles[index]!, target.keys[index]!);
    }
  };

  const kick = (): Promise<void> => {
    if (busy) return busy;
    if (closed) return Promise.resolve();
    const run: Promise<void> = pump().finally(() => { busy = null; if (dirty && !closed) void kick(); });
    busy = run;
    return run;
  };

  return {
    push(frame) {
      if (closed) return Promise.resolve();
      const parts = tiles(frame);
      wanted = { tiles: parts, keys: parts.map(frameKey) };
      dirty = true;
      return kick();
    },
    reset() { generation += 1; shown.fill(null); },
    // A tile that failed is not waited for: it is tried again with the next push.
    idle: () => busy === null,
    sent: () => count,
    close() { closed = true; wanted = null; },
  };
}

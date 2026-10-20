import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { tileSlots, type TileSend, type TileSlot } from "../screen/sender";

/**
 * Puts Endurance HUD on the G2 (QUS v1): the whole 576 x 288 display is four
 * 288 x 144 image tiles (drawn by src/cockpit), plus one empty text container
 * that owns the input.
 *
 * `createStartUpPageContainer` runs exactly once. Every later page is a
 * `rebuildPageContainer`; everything else goes through `updateImageRawData`,
 * and only for tiles whose pixels changed: on real hardware a rebuild costs
 * seconds and discards input.
 */

export const SCREEN_WIDTH = 576;
export const SCREEN_HEIGHT = 288;

/**
 * Every call into the glasses is bounded. Draws run one after another, so a
 * single answer that never comes (a Bluetooth write lost on the way) used to
 * freeze the display for good on its last page. A call that times out counts
 * as failed: the draw fails, the page is marked broken and the next draw
 * rebuilds it.
 */
export const PAGE_CALL_MS = 8_000;
export const IMAGE_CALL_MS = 10_000;

export function bounded<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer from the glasses within ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The cockpit's four image containers; the input container sits under them. */
export const COCKPIT_TILES = tileSlots(21, "endurance");
const COCKPIT_INPUT_ID = 20;

export interface RenderResult {
  readonly ok: boolean;
  /** Present when page creation failed, for the caller to surface or log. */
  readonly reason?: string;
}

/** The glasses' side menu (off while SIDE_MENU is false in main.ts): ids are never 0, labels at most 32 bytes. */
export interface MenuSpec {
  readonly items: readonly { readonly id: number; readonly label: string }[];
}

export function buildCockpitPage(): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer({
    containerTotalNum: 1 + COCKPIT_TILES.length,
    textObject: [new TextContainerProperty({
      containerID: COCKPIT_INPUT_ID, containerName: "cockpit-input", xPosition: 0, yPosition: 0, width: SCREEN_WIDTH, height: SCREEN_HEIGHT,
      paddingLength: 0, zOrderIndex: 1, isEventCapture: 1, content: " ",
    })],
    imageObject: COCKPIT_TILES.map((tile, index) => new ImageContainerProperty({
      containerID: tile.id, containerName: tile.name, xPosition: tile.x, yPosition: tile.y, width: tile.width, height: tile.height, zOrderIndex: index + 2,
    })),
  });
}

/**
 * The very first time on a bridge, one `rebuildPageContainer` goes out first
 * (result ignored, failure swallowed: on real glasses it is what registers the
 * input route) and then `createStartUpPageContainer` runs exactly once. Every
 * later page replaces it with `rebuildPageContainer`.
 */
const started = new WeakSet<EvenAppBridge>();

/**
 * The next page goes the way of the very first one again (rebuild + create).
 * Needed after the system's exit dialog was cancelled: on the real glasses the
 * dialog takes the page away, and a plain rebuild no longer reaches it (store
 * review 16.10.2026).
 */
export function forgetPage(bridge: EvenAppBridge): void {
  started.delete(bridge);
}

export async function createCockpitPage(bridge: EvenAppBridge, _menu: MenuSpec | null = null): Promise<RenderResult> {
  const page = buildCockpitPage();
  try {
    if (!started.has(bridge)) {
      try {
        await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild");
      } catch {
        // Expected on current firmware; the creation below is the real path.
      }
      const result = await bounded(bridge.createStartUpPageContainer(page), PAGE_CALL_MS, "create page");
      if (result !== StartUpPageCreateResult.success) return { ok: false, reason: describeCreateResult(result) };
      started.add(bridge);
    } else {
      const ok = await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild");
      if (!ok) return { ok: false, reason: "rebuild refused" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** One image tile to the glasses; resolves true on success. */
export async function sendTile(bridge: EvenAppBridge, slot: TileSlot, imageData: Uint8Array): Promise<boolean> {
  const result = await bounded(bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: slot.id, containerName: slot.name, imageData })), IMAGE_CALL_MS, "image " + slot.name);
  return result === ImageRawDataUpdateResult.success;
}

/**
 * The tile sender's write function. It writes only while `allowed()` says so:
 * not while the system exit dialog may be on screen (a page call could cover
 * it). A refused tile counts as failed and is tried again with the next frame.
 */
export function guardedTileSend(bridge: EvenAppBridge, allowed: () => boolean): TileSend {
  return (slot, png) => (allowed() ? sendTile(bridge, slot, png) : Promise.resolve(false));
}

export function describeCreateResult(result: StartUpPageCreateResult): string {
  switch (result) {
    case StartUpPageCreateResult.success: return "success";
    case StartUpPageCreateResult.invalid: return "page rejected as invalid";
    case StartUpPageCreateResult.oversize: return "page exceeds the display budget";
    case StartUpPageCreateResult.outOfMemory: return "glasses are out of memory";
    default: return `unknown result (${String(result)})`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

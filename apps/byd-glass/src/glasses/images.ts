import {
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { bitmapKey, encodePng, type Bitmap } from "./gfx";

/**
 * Every call into the glasses is bounded. Draws run one after another, so a
 * single answer that never comes (a Bluetooth write lost on the way) used to
 * freeze the display for good on whatever it showed last. A call that times
 * out counts as failed: the caller marks the page broken and the next draw
 * rebuilds it.
 */
export const PAGE_CALL_MS = 8_000;
export const TEXT_CALL_MS = 5_000;
export const IMAGE_CALL_MS = 10_000;

export function bounded<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer from the glasses within ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Where one image container sits on the 576 x 288 display. */
export interface ImageSlot {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly z: number;
}

/** SDK limits for a single image container. */
export const IMAGE_LIMITS = { minWidth: 20, maxWidth: 288, minHeight: 20, maxHeight: 144, maxContainers: 4 } as const;

export function imageContainer(slot: ImageSlot): ImageContainerProperty {
  return new ImageContainerProperty({
    containerID: slot.id,
    containerName: slot.name,
    xPosition: slot.x,
    yPosition: slot.y,
    width: slot.width,
    height: slot.height,
    zOrderIndex: slot.z,
  });
}

export interface ImageResult {
  readonly ok: boolean;
  /** True when bytes actually went to the glasses; false when the picture was unchanged. */
  readonly sent: boolean;
  readonly reason?: string;
}

/**
 * Sends bitmaps to image containers, but only when a picture really changed:
 * each image crosses BLE as a whole, so an unchanged frame must cost nothing.
 */
export class ImageLink {
  private readonly shown = new Map<number, string>();
  /** Counts the pictures that really went out; tests and diagnostics read it. */
  sentCount = 0;

  /** Whether a picture has been sent to this container since the page was built. */
  has(id: number): boolean {
    return this.shown.has(id);
  }

  /** The page was (re)built: its image containers are empty again. */
  reset(): void {
    this.shown.clear();
  }

  async push(bridge: EvenAppBridge, slot: ImageSlot, bitmap: Bitmap): Promise<ImageResult> {
    const key = bitmapKey(bitmap);
    if (this.shown.get(slot.id) === key) return { ok: true, sent: false };
    return this.pushBytes(bridge, slot, key, () => encodePng(bitmap));
  }

  /** Sends ready PNG bytes (e.g. the preview from the bridge) under a key of the caller's choosing. */
  async pushBytes(bridge: EvenAppBridge, slot: ImageSlot, key: string, bytes: () => Uint8Array): Promise<ImageResult> {
    if (this.shown.get(slot.id) === key) return { ok: true, sent: false };
    try {
      const result = await bounded(bridge.updateImageRawData(new ImageRawDataUpdate({
        containerID: slot.id,
        containerName: slot.name,
        imageData: bytes(),
      })), IMAGE_CALL_MS, "image " + slot.name);
      if (result !== ImageRawDataUpdateResult.success) return { ok: false, sent: false, reason: `image:${String(result)}` };
      this.shown.set(slot.id, key);
      this.sentCount += 1;
      return { ok: true, sent: true };
    } catch (error) {
      return { ok: false, sent: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

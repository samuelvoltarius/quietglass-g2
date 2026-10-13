import {
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { bitmapKey, encodePng, type Bitmap } from "./gfx";

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
    try {
      const result = await bridge.updateImageRawData(new ImageRawDataUpdate({
        containerID: slot.id,
        containerName: slot.name,
        imageData: encodePng(bitmap),
      }));
      if (result !== ImageRawDataUpdateResult.success) return { ok: false, sent: false, reason: `image:${String(result)}` };
      this.shown.set(slot.id, key);
      this.sentCount += 1;
      return { ok: true, sent: true };
    } catch (error) {
      return { ok: false, sent: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

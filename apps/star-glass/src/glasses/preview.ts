import { createFrame, type Frame } from "../screen/frame";

/** The preview box on the cockpit's left half. */
export const PREVIEW_BOX = { width: 288, height: 144 } as const;

/**
 * RGBA pixels as grey levels 0…15 (the glasses show sixteen brightnesses of
 * green). A linear stretch to the 99.5th percentile keeps faint stars visible
 * on an unstretched night frame without blowing out a bright one.
 */
export function frameFromRgba(rgba: ArrayLike<number>, width: number, height: number): Frame {
  const frame = createFrame(width, height);
  const luma = new Uint8Array(width * height);
  const histogram = new Uint32Array(256);
  for (let index = 0; index < luma.length; index += 1) {
    const value = Math.round(0.2126 * rgba[index * 4]! + 0.7152 * rgba[index * 4 + 1]! + 0.0722 * rgba[index * 4 + 2]!);
    luma[index] = value;
    histogram[value] = (histogram[value] ?? 0) + 1;
  }
  let seen = 0; let top = 255;
  for (let value = 0; value < 256; value += 1) {
    seen += histogram[value] ?? 0;
    if (seen >= luma.length * 0.995) { top = value; break; }
  }
  const range = Math.max(48, top);
  for (let index = 0; index < luma.length; index += 1) frame.pixels[index] = Math.min(15, Math.round((luma[index]! / range) * 15));
  return frame;
}

/**
 * The camera's PNG as a 288 x 144 frame, fitted inside the box. Needs the
 * browser's image decoder: anywhere else (tests, a host without it) it
 * answers null and the cockpit draws its placeholder.
 */
export async function decodePreview(bytes: Uint8Array): Promise<Frame | null> {
  try {
    const host = globalThis as unknown as {
      createImageBitmap?: (blob: Blob) => Promise<{ width: number; height: number; close?: () => void }>;
      OffscreenCanvas?: new (w: number, h: number) => { getContext(kind: "2d"): unknown };
      document?: { createElement(tag: "canvas"): { width: number; height: number; getContext(kind: "2d"): unknown } };
    };
    if (typeof host.createImageBitmap !== "function") return null;
    const bitmap = await host.createImageBitmap(new Blob([bytes as BlobPart], { type: "image/png" }));
    let canvas: { getContext(kind: "2d"): unknown } | undefined;
    if (typeof host.OffscreenCanvas === "function") canvas = new host.OffscreenCanvas(PREVIEW_BOX.width, PREVIEW_BOX.height);
    else {
      const element = host.document?.createElement("canvas");
      if (element) { element.width = PREVIEW_BOX.width; element.height = PREVIEW_BOX.height; canvas = element; }
    }
    if (!canvas) return null;
    const context = canvas.getContext("2d") as {
      fillStyle: string; fillRect(x: number, y: number, w: number, h: number): void;
      drawImage(image: unknown, x: number, y: number, w: number, h: number): void;
      getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> };
    } | null;
    if (!context) return null;
    const scale = Math.min(PREVIEW_BOX.width / bitmap.width, PREVIEW_BOX.height / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale)); const height = Math.max(1, Math.round(bitmap.height * scale));
    context.fillStyle = "#000";
    context.fillRect(0, 0, PREVIEW_BOX.width, PREVIEW_BOX.height);
    context.drawImage(bitmap, Math.floor((PREVIEW_BOX.width - width) / 2), Math.floor((PREVIEW_BOX.height - height) / 2), width, height);
    bitmap.close?.();
    return frameFromRgba(context.getImageData(0, 0, PREVIEW_BOX.width, PREVIEW_BOX.height).data, PREVIEW_BOX.width, PREVIEW_BOX.height);
  } catch {
    return null;
  }
}

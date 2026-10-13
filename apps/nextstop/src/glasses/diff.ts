import type { StopView } from "./view";
import type { Scene } from "../route/scene";

/**
 * The run screen redraws on every gesture, but the display should only be
 * written when something actually changed: each update crosses BLE, and
 * needless writes cost latency and battery for no visible benefit.
 */
export function sameView(a: StopView | null, b: StopView): boolean {
  if (!a) return false;
  return (
    a.header === b.header &&
    a.footer === b.footer &&
    a.body.length === b.body.length &&
    a.body.every((line, i) => line === b.body[i])
  );
}

/**
 * The same for a whole scene: the words, the page kind and the pictures.
 * Pictures are compared by their key, which changes exactly when their
 * content does, so a pulsing or counting image is redrawn and a still one never.
 */
export function sameScene(a: Scene | null, b: Scene): boolean {
  if (!a) return false;
  return (
    a.kind === b.kind &&
    sameView(a.view, b.view) &&
    a.images.length === b.images.length &&
    a.images.every((image, i) => image.id === b.images[i]?.id && image.key === b.images[i]?.key)
  );
}

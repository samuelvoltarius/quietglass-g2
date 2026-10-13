import type { ScreenView } from "./screen";

/**
 * Views are rebuilt on every gesture and timer tick, but the display should
 * only be written when something actually changed: each update crosses BLE,
 * and needless writes cost latency and battery for no visible benefit.
 */
type View = ScreenView & { readonly temps?: readonly string[] };

export function sameView(a: View | null, b: View): boolean {
  if (!a) return false;
  return (
    (a.temps ?? []).join("|") === (b.temps ?? []).join("|") &&
    a.header === b.header &&
    a.footer === b.footer &&
    a.body.length === b.body.length &&
    a.body.every((line, i) => line === b.body[i])
  );
}

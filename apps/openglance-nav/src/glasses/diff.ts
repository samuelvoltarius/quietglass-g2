import { speedBigKey } from "./hud";
import type { NavView } from "./view";

/**
 * The run screen redraws on every gesture, but the display should only be
 * written when something actually changed: each update crosses BLE, and
 * needless writes cost latency and battery for no visible benefit.
 */
export function sameView(a: NavView | null, b: NavView): boolean {
  if (!a) return false;
  return (
    a.header === b.header &&
    a.footer === b.footer &&
    a.big === b.big &&
    a.speed === b.speed &&
    sameHud(a, b) &&
    a.body.length === b.body.length &&
    a.body.every((line, i) => line === b.body[i])
  );
}

function sameHud(a: NavView, b: NavView): boolean {
  const x = a.hud, y = b.hud;
  if (!x || !y) return x === y;
  return x.status === y.status && x.speed === y.speed && x.center === y.center && x.distance === y.distance
    && x.street === y.street && x.alert === y.alert && x.arrow === y.arrow && x.limit === y.limit
    && speedBigKey(x.speedBig) === speedBigKey(y.speedBig);
}

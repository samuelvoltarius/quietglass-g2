import type { PrompterView } from "./view";

/**
 * The prompter ticks several times a second, but the display should only be
 * written when something actually changed: each update crosses BLE, and
 * needless writes cost latency and battery for no visible benefit.
 */
export function sameView(a: PrompterView | null, b: PrompterView): boolean {
  if (!a) return false;
  return (
    a.header === b.header &&
    a.footer === b.footer &&
    a.body.length === b.body.length &&
    a.body.every((line, i) => line === b.body[i])
  );
}

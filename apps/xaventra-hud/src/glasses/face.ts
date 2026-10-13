import type { HudModel } from "../hud/model";
import { iconBitmap, type Bitmap } from "./gfx";
import { mascotFrame, type Mood } from "./mascot";

/** The face sits in the top-right corner of the header; the header text gets 576 - 64. */
export const ICON_WIDTH = 64;
export const ICON_HEIGHT = 30;

export { MASCOT_STEP_MS } from "./mascot";

/** Status lines that mean "nothing going on" rather than "Xaventra is busy". */
const QUIET_STATUS = /^(alles ruhig|ruhig|nichts|bereit|idle|ok\b|all quiet|nothing|ready)/i;

/**
 * How Xaventra feels, from what the HUD knows. Pure: the same model always
 * gives the same mood.
 *
 *  - asleep:   not configured, or the server cannot be reached
 *  - error:    the server answered, but with a problem (auth, HTTP error, bad reply)
 *  - waiting:  a card waits for your yes or no
 *  - listening / working: while you speak, or while it works on a status
 */
export function hudMood(model: HudModel): Mood {
  if (!model.configured) return "asleep";
  if (!model.online && !model.fault) return "asleep";
  if (model.fault) return "error";
  if (model.rec === "opening" || model.rec === "listening") return "listening";
  if (model.rec === "sending") return "working";
  if ((model.feed?.cards.length ?? 0) > 0) return "waiting";
  const status = model.feed?.status.trim() ?? "";
  return status !== "" && !QUIET_STATUS.test(status) ? "working" : "idle";
}

export function headerIcon(model: HudModel, now: number): Bitmap {
  return iconBitmap(mascotFrame(hudMood(model), now), ICON_WIDTH, ICON_HEIGHT);
}

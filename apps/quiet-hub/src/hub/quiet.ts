/**
 * "Ruhe während der Agent arbeitet" — a near-blank display while an agent works.
 *
 * SDK 0.0.16 has no display-off call. What it has: a per-text-container
 * brightness 0..4 (`textColor`), changeable in place with the cheap
 * `textContainerUpgrade`, and black image pixels, which are transparent on
 * the G2. So "quiet" = all text emptied, header and body at brightness 0, a
 * single "·" in the footer at brightness 1 as a sign of life, and the face
 * replaced by one all-black frame (sent once; the 500 ms face animation does
 * not send anything while quiet). No page rebuild, no create.
 *
 * Quiet only on the overview and the open session, only while the agent on
 * display is busy, and never when the wearer has to look: a permission card,
 * a message or confirm countdown, recording / a voice transcript, help, the
 * page picker, a broken link, the smile after an answer. Any tap or swipe
 * while quiet wakes the display for WAKE_MS and is otherwise swallowed;
 * double tap and hold keep their meaning (back / exit / speak); tap arms the stop.
 */
import type { ScreenView } from "../glasses/screen";
import type { PixelIcon } from "../glasses/pixel";
import { linkBlocks, selectedAgent, voiceOwns, type HubGesture, type HubModel } from "./model";

/** How long a gesture (or a new alert) shows the working agent before it goes quiet again. */
export const WAKE_MS = 20_000;

/** The one sign of life while quiet: a dot in the footer at the dimmest visible level. */
export const QUIET_VIEW: ScreenView = { header: "", body: [""], footer: "·", dim: true };

/** Black = transparent on the G2: the face disappears without a rebuild. */
export const BLANK_ICON: PixelIcon = ["."];

/** The agent the wearer is looking at works right now. */
export function displayedAgentBusy(model: HubModel): boolean {
  if (model.screen === "agent") return model.agentView === "ask" && selectedAgent(model)?.busy === true;
  if (model.screen === "root") return model.report.agents.some((agent) => agent.busy);
  return false;
}

/** True when the display should be (nearly) dark right now. */
export function isQuiet(model: HubModel, now: number): boolean {
  if (model.quietWhileWorking !== true) return false;
  if ((model.wakeUntil ?? 0) > now) return false;
  if (model.report.approvals.length > 0) return false;
  if (model.recording || voiceOwns(model) || model.help || model.picker !== null) return false;
  if (model.message !== null && model.message.until > now) return false;
  if (model.confirm !== null && model.confirm.until > now) return false;
  if ((model.cheerUntil ?? 0) > now) return false;
  if (model.link !== null && linkBlocks(model.link)) return false;
  return displayedAgentBusy(model);
}

/** Keeps the display awake for WAKE_MS from now. */
export function wake(model: HubModel, now: number): HubModel {
  return { ...model, wakeUntil: now + WAKE_MS };
}

/**
 * A gesture arrives. While quiet, tap and swipe only wake the display (they are
 * consumed); everything else, and every gesture while awake, goes on to
 * `decide` and also keeps the display awake for another WAKE_MS.
 */
export function quietGesture(model: HubModel, gesture: HubGesture, now: number): { model: HubModel; consumed: boolean } {
  const quiet = isQuiet(model, now);
  const woken = wake(model, now);
  if (quiet && (gesture === "click" || gesture === "scrollUp" || gesture === "scrollDown")) return { model: woken, consumed: true };
  // longPressRelease belongs to a hold that already started; it neither wakes nor counts.
  if (gesture === "longPressRelease") return { model, consumed: false };
  return { model: woken, consumed: false };
}

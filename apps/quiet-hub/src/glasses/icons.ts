import { selectedAgent, voiceOwns, type HubModel } from "../hub/model";
import type { PixelIcon } from "./pixel";
import { mascotFrame, type Mood } from "./mascot";

const HOME = ["..##..", ".####.", "######", "##..##", "##..##", "######"];
const PRINTER = ["######", "#....#", "######", ".####.", ".#..#.", ".####."];
const CHECK = ["......", ".....#", "....##", "#..##.", ".###..", "..#..."];
const WAIT = ["..##..", "..##..", "..##..", "..##..", "......", "..##.."];
const ERROR = ["#....#", ".#..#.", "..##..", "..##..", ".#..#.", "#....#"];
const INBOX = ["######", "#....#", "#....#", "#.##.#", "######", "......"];

/** How the hub feels right now, for the face on the overview and agent pages. */
export function moodFor(model: HubModel, now: number): Mood {
  if (model.link !== null) return "asleep";
  if (model.report.approvals.length > 0) return "waiting";
  if (model.recording || voiceOwns(model)) return "listening";
  const agent = selectedAgent(model);
  if (model.screen === "agent" && agent?.error !== null && agent?.error !== undefined && !agent.busy) return "error";
  if ((model.cheerUntil ?? 0) > now) return "happy";
  const working = model.screen === "agent" && model.agentView === "ask" ? agent?.busy === true : model.report.agents.some((a) => a.busy);
  return working ? "working" : "idle";
}

export function pixelIconFor(model: HubModel, now: number = Date.now()): PixelIcon {
  if (model.screen === "root" || model.screen === "agent" || model.screen === "cockpit") return mascotFrame(moodFor(model, now), now);
  if (model.screen === "home") return HOME;
  if (model.screen === "printer") return PRINTER;
  const event = model.report.inbox.events[model.report.inbox.selected];
  if (event?.status === "done") return CHECK;
  if (event?.status === "waiting") return WAIT;
  if (event?.status === "error") return ERROR;
  return INBOX;
}

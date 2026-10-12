import { selectedAgent, type HubModel } from "../hub/model";
import { describeActivity, type ActivityKind } from "../hub/activity";
import type { PixelIcon } from "./pixel";

const HUB = ["##..##", "##..##", "......", "##..##", "##..##", "......"];
const AGENT = [".####.", "#....#", "#.##.#", "#....#", ".####.", "..##.."];
const HOME = ["..##..", ".####.", "######", "##..##", "##..##", "######"];
const PRINTER = ["######", "#....#", "######", ".####.", ".#..#.", ".####."];
const CHECK = ["......", ".....#", "....##", "#..##.", ".###..", "..#..."];
const WAIT = ["..##..", "..##..", "..##..", "..##..", "......", "..##.."];
const ERROR = ["#....#", ".#..#.", "..##..", "..##..", ".#..#.", "#....#"];
const INBOX = ["######", "#....#", "#....#", "#.##.#", "######", "......"];

/** What a working agent is doing, as a 6x6 sign next to its text. */
const ACTIVITY: Readonly<Record<ActivityKind, readonly string[]>> = {
  think: [".####.", "#....#", "...##.", "..##..", "......", "..##.."],
  run: ["#.....", ".#....", "..#...", ".#....", "#..###", "......"],
  test: ["......", ".....#", "....##", "#..##.", ".###..", "..#..."],
  git: ["#.....", "#...#.", "#..#..", "####..", "#.....", "#....."],
  edit: ["....##", "...###", "..###.", ".###..", "###...", "##...."],
  read: ["#####.", "#...##", "#.##.#", "#....#", "#.##.#", "######"],
  search: [".###..", "#...#.", "#...#.", ".###..", "....#.", ".....#"],
  web: [".####.", "#.##.#", "######", "######", "#.##.#", ".####."],
  memory: [".#..#.", "######", ".#..#.", ".#..#.", "######", ".#..#."],
  agent: ["##..##", "##..##", "..##..", "..##..", "##..##", "##..##"],
};

export function pixelIconFor(model: HubModel): PixelIcon {
  if (model.screen === "root") return HUB;
  if (model.screen === "agent") {
    if (model.report.approvals.length > 0) return WAIT;
    const agent = selectedAgent(model);
    if (agent?.busy === true && model.agentView === "ask") return ACTIVITY[describeActivity(agent.activity, "de").kind];
    return AGENT;
  }
  if (model.screen === "home") return HOME;
  if (model.screen === "printer") return PRINTER;
  const event = model.report.inbox.events[model.report.inbox.selected];
  if (event?.status === "done") return CHECK;
  if (event?.status === "waiting") return WAIT;
  if (event?.status === "error") return ERROR;
  return INBOX;
}

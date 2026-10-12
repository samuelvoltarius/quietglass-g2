import type { HubModel } from "../hub/model";
import type { PixelIcon } from "./pixel";

const HUB = ["##..##", "##..##", "......", "##..##", "##..##", "......"];
const AGENT = [".####.", "#....#", "#.##.#", "#....#", ".####.", "..##.."];
const HOME = ["..##..", ".####.", "######", "##..##", "##..##", "######"];
const PRINTER = ["######", "#....#", "######", ".####.", ".#..#.", ".####."];
const CHECK = ["......", ".....#", "....##", "#..##.", ".###..", "..#..."];
const WAIT = ["..##..", "..##..", "..##..", "..##..", "......", "..##.."];
const ERROR = ["#....#", ".#..#.", "..##..", "..##..", ".#..#.", "#....#"];
const INBOX = ["######", "#....#", "#....#", "#.##.#", "######", "......"];

export function pixelIconFor(model: HubModel): PixelIcon {
  if (model.screen === "root") return HUB;
  if (model.screen === "agent") return AGENT;
  if (model.screen === "home") return HOME;
  if (model.screen === "printer") return PRINTER;
  const event = model.report.inbox.events[model.report.inbox.selected];
  if (event?.status === "done") return CHECK;
  if (event?.status === "waiting") return WAIT;
  if (event?.status === "error") return ERROR;
  return INBOX;
}

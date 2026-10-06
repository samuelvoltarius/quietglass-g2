import type { ManeuverType } from "../routing/provider";
import type { PixelIcon } from "./pixel";

const BLANK = Array.from({ length: 10 }, () => "..........");
const STRAIGHT = [
  "...####...", "..######..", ".########.", "...####...", "...####...",
  "...####...", "...####...", "...####...", "...####...", "...####...",
];
const RIGHT = [
  "......#...", "......##..", "......###.", "##########", "##########",
  "......###.", "......##..", "......#...", "..........", "..........",
];
const LEFT = RIGHT.map((row) => [...row].reverse().join(""));
const TURN_RIGHT = [
  "......#...", "......##..", "......###.", "..########", "..########",
  "..##..###.", "..##......", "..##......", "..##......", "..##......",
];
const TURN_LEFT = TURN_RIGHT.map((row) => [...row].reverse().join(""));
// Up the right side, over the top, down the left: the head points back.
const UTURN = [
  "..######..", ".########.", "###....###", "##......##", "##......##",
  "##......##", "######..##", ".####...##", "..##....##", "........##",
];
const ROUNDABOUT = [
  "...####...", ".##....##.", "##......##", "##..##..##", "##.####.##",
  "##..##..##", "##......##", ".##....##.", "...####...", "....##....",
];
const ARRIVE = [
  "....##....", "...####...", "..##..##..", ".##....##.", "##......##",
  "##......##", ".##....##.", "..##..##..", "...####...", "....##....",
];

const ICONS: Readonly<Record<ManeuverType, PixelIcon>> = {
  depart: STRAIGHT,
  arrive: ARRIVE,
  left: LEFT,
  slightLeft: TURN_LEFT,
  sharpLeft: TURN_LEFT,
  right: RIGHT,
  slightRight: TURN_RIGHT,
  sharpRight: TURN_RIGHT,
  straight: STRAIGHT,
  uturn: UTURN,
  roundabout: ROUNDABOUT,
  merge: TURN_RIGHT,
  fork: TURN_RIGHT,
  exit: TURN_RIGHT,
};

/** A large monochrome direction arrow matched to the active manoeuvre. */
export function pixelArrowFor(type?: ManeuverType): PixelIcon {
  return type ? ICONS[type] : BLANK;
}

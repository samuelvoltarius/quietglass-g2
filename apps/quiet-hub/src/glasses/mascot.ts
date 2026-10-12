/**
 * Quiet Hub's face: a pair of round glasses with eyes and a small mouth,
 * drawn as an 18x9 pixel pattern in the left image container. It shows how
 * the hub feels at a glance — idle eyes that blink now and then, eyes that
 * look left and right while an agent works, a smile when an answer just
 * arrived, wide eyes when something waits for you, crosses on an error and
 * closed eyes when the server is unreachable.
 *
 * Frames depend only on (mood, now), so they are testable and the caller
 * decides how often to redraw (the image is only resent when the frame changes).
 */
import type { PixelIcon } from "./pixel";

export type Mood = "idle" | "working" | "happy" | "waiting" | "error" | "asleep" | "listening";

/** Lens interiors are 6x4 pixels; each eye is drawn into both lenses. */
type Eye = readonly [string, string, string, string];

const EYES: Readonly<Record<string, Eye>> = {
  center: ["......", "..##..", "..##..", "......"],
  left: ["......", "##....", "##....", "......"],
  right: ["......", "....##", "....##", "......"],
  up: ["..##..", "..##..", "......", "......"],
  closed: ["......", "......", "######", "......"],
  happy: ["......", "..##..", ".#..#.", "......"],
  wide: [".####.", ".#..#.", ".#..#.", ".####."],
  cross: ["#....#", ".#..#.", "..##..", ".#..#."],
};

const MOUTHS: Readonly<Record<string, readonly [string, string]>> = {
  flat: ["..................", ".......####......."],
  smile: [".......#..#.......", "........##........"],
  open: [".......####.......", ".......####......."],
  wavy: ["......#.##.#......", ".......#..#......."],
  none: ["..................", ".................."],
};

function face(eye: Eye, mouth: keyof typeof MOUTHS): PixelIcon {
  const lens = (row: string): string => `#${row}#`;
  const [m1, m2] = MOUTHS[mouth] ?? MOUTHS.none!;
  return [
    ".######....######.",
    `${lens(eye[0])}..${lens(eye[0])}`,
    `${lens(eye[1])}##${lens(eye[1])}`,
    `${lens(eye[2])}..${lens(eye[2])}`,
    `${lens(eye[3])}..${lens(eye[3])}`,
    ".######....######.",
    "..................",
    m1!,
    m2!,
  ];
}

/** The writing on the notebook page, one frame per step (8 inner columns). */
const WRITING = ["........", "##......", "##.#....", "##.###..", "##.###.#", "##.###.#"] as const;
/** Pupils looking down at the pen as it moves right. */
const WRITING_EYES: readonly Eye[] = [
  ["......", "......", ".##...", ".##..."],
  ["......", "......", ".##...", ".##..."],
  ["......", "......", "..##..", "..##.."],
  ["......", "......", "..##..", "..##.."],
  ["......", "......", "...##.", "...##."],
  ["......", "......", "...##.", "...##."],
];

/** A small open notebook below the glasses, with the line being written. */
function notebook(line: string): string[] {
  return ["....##########....", `....#${line}#....`, "....##########...."];
}

/**
 * Listening: the head turned so one ear faces you — one lens with an eye on
 * the left, a big ear on the right and sound waves pulsing into it.
 */
function ear(step: number): PixelIcon {
  const shell = [".####.", "#....#", "#.##.#", "#.#..#", "#..#.#", ".#..#.", "..##.."];
  const waves = step % 2 === 0 ? ["..", "..", "#.", "#.", "..", "..", ".."] : ["..", ".#", "#.", "#.", ".#", "..", ".."];
  const eye: Eye = ["......", "...##.", "...##.", "......"];
  const lens = [".######.", `#${eye[0]}#`, `#${eye[1]}#`, `#${eye[2]}#`, `#${eye[3]}#`, ".######.", "........"];
  const rows = lens.map((left, i) => `${left}${i === 2 ? "#" : "."}${shell[i] ?? "......"}.${waves[i] ?? ".."}`.slice(0, 18));
  return [...rows, "..................", ".................."];
}

/** How long one step of an animation lasts. Redraw at least this often to see it. */
export const MASCOT_STEP_MS = 500;

export function mascotFrame(mood: Mood, now: number): PixelIcon {
  const step = Math.floor(now / MASCOT_STEP_MS);
  switch (mood) {
    case "working": {
      // Head down over a notebook: a line of writing grows dash by dash and
      // the eyes follow the pen from left to right, then a fresh line starts.
      const frame = step % WRITING.length;
      return [...face(WRITING_EYES[frame]!, "none").slice(0, 6), ...notebook(WRITING[frame]!)];
    }
    case "happy":
      return face(EYES.happy!, "smile");
    case "waiting":
      return face(EYES.wide!, step % 4 === 0 ? "none" : "open");
    case "error":
      return face(EYES.cross!, "wavy");
    case "asleep":
      return face(EYES.closed!, "none");
    case "listening":
      return ear(step);
    case "idle":
    default:
      // A short blink every five seconds.
      return face(step % 10 === 0 ? EYES.closed! : EYES.center!, "flat");
  }
}

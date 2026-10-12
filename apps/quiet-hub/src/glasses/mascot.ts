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

/** How long one step of an animation lasts. Redraw at least this often to see it. */
export const MASCOT_STEP_MS = 500;

export function mascotFrame(mood: Mood, now: number): PixelIcon {
  const step = Math.floor(now / MASCOT_STEP_MS);
  switch (mood) {
    case "working": {
      // Look left, centre, right, centre — one position per second.
      const look = ["left", "center", "right", "center"][Math.floor(step / 2) % 4] ?? "center";
      return face(EYES[look]!, "flat");
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
      return face(EYES.up!, "open");
    case "idle":
    default:
      // A short blink every five seconds.
      return face(step % 10 === 0 ? EYES.closed! : EYES.center!, "flat");
  }
}

import { describe, expect, it } from "vitest";
import { MASCOT_STEP_MS, mascotFrame, type Mood } from "../src/glasses/mascot";

describe("the face", () => {
  it("every frame of every mood is a clean 18x9 pattern", () => {
    for (const mood of ["idle", "working", "happy", "waiting", "error", "asleep", "listening"] as Mood[]) {
      for (let i = 0; i < 12; i++) {
        const frame = mascotFrame(mood, i * MASCOT_STEP_MS);
        expect(frame).toHaveLength(9);
        for (const row of frame) expect(row).toMatch(/^[#.]{18}$/);
      }
    }
  });

  it("writes in a notebook while working: the line grows and the eyes follow", () => {
    const frames = [0, 1, 2, 3, 4].map((i) => mascotFrame("working", i * MASCOT_STEP_MS));
    const ink = frames.map((f) => (f[7]!.match(/#/g) ?? []).length);
    expect(ink[4]).toBeGreaterThan(ink[0]!);
    expect(new Set(frames.map((f) => f[3])).size).toBeGreaterThan(2);
  });

  it("blinks now and then when idle", () => {
    const rows = Array.from({ length: 10 }, (_, i) => mascotFrame("idle", i * MASCOT_STEP_MS)[3]);
    expect(new Set(rows).size).toBe(2);
  });
});

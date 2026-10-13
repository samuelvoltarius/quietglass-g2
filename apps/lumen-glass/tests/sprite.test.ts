import { describe, expect, it } from "vitest";
import { FLAP_STEP_MS, isFlapping, mothSprite, spriteKey } from "../src/glasses/sprite";
import type { MothState } from "../src/lumen/moth";

const STATES: MothState[] = ["leuchtet", "wach", "matt", "schläfrig", "eingerollt"];

describe("the pixel moth", () => {
  it("fits 16 x 9 for every state and frame", () => {
    for (const state of STATES) for (const t of [0, FLAP_STEP_MS, 2 * FLAP_STEP_MS]) {
      const icon = mothSprite(state, t);
      expect(icon.length).toBe(9);
      for (const row of icon) expect(row).toMatch(/^[.#]{16}$/);
    }
  });

  it("beats its wings once per second when awake", () => {
    const a = spriteKey(mothSprite("wach", 0));
    const b = spriteKey(mothSprite("wach", FLAP_STEP_MS));
    expect(a).not.toBe(b);
    expect(spriteKey(mothSprite("wach", 2 * FLAP_STEP_MS))).toBe(a);
    // Constant inside one step: no needless image writes.
    expect(spriteKey(mothSprite("wach", FLAP_STEP_MS - 1))).toBe(a);
  });

  it("only moves while awake", () => {
    for (const state of STATES) {
      const moves = spriteKey(mothSprite(state, 0)) !== spriteKey(mothSprite(state, FLAP_STEP_MS));
      expect(moves, state).toBe(state === "wach");
      expect(isFlapping(state)).toBe(state === "wach");
    }
  });

  it("looks different for different states", () => {
    const keys = new Set(STATES.map((state) => spriteKey(mothSprite(state, 0))));
    expect(keys.size).toBeGreaterThanOrEqual(4);
  });
});

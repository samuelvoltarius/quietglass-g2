import { describe, expect, it } from "vitest";
import { activeConfirm, CONFIRM_WINDOW_MS, confirmStep } from "../src/input/confirm";

describe("two-step confirmation", () => {
  it("the first gesture only arms, the second within the window confirms", () => {
    const first = confirmStep(null, "wipe", 1000);
    expect(first.confirmed).toBe(false);
    expect(first.pending).toEqual({ kind: "wipe", until: 1000 + CONFIRM_WINDOW_MS });
    const second = confirmStep(first.pending, "wipe", 1000 + CONFIRM_WINDOW_MS - 1);
    expect(second.confirmed).toBe(true);
    expect(second.pending).toBeNull();
  });

  it("too late re-arms instead of confirming", () => {
    const first = confirmStep(null, "wipe", 0);
    const late = confirmStep(first.pending, "wipe", CONFIRM_WINDOW_MS + 1);
    expect(late.confirmed).toBe(false);
    expect(late.pending?.kind).toBe("wipe");
  });

  it("a different action does not confirm the armed one", () => {
    const first = confirmStep(null, "a", 0);
    expect(confirmStep(first.pending, "b", 10).confirmed).toBe(false);
  });

  it("activeConfirm drops an expired arm", () => {
    const { pending } = confirmStep(null, "a", 0);
    expect(activeConfirm(pending, 100)).not.toBeNull();
    expect(activeConfirm(pending, CONFIRM_WINDOW_MS + 1)).toBeNull();
  });
});

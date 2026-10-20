import { describe, expect, it } from "vitest";
import { PENDULUM_MAX_BPM, PENDULUM_MIDSWING_MAX_BPM, pendulumSwing } from "../src/glasses/charts";
import { DEFAULT_SETTINGS, createState, msPerBeat, start, type MetronomeSettings } from "../src/metronome/engine";

const at = (bpm: number): MetronomeSettings => ({ ...DEFAULT_SETTINGS, bpm });

describe("pendulum position", () => {
  it("hangs upright when stopped, and is not drawn above 120 bpm", () => {
    expect(pendulumSwing(createState(), at(100), 0)).toBe(0);
    expect(pendulumSwing(start(createState(), 0), at(PENDULUM_MAX_BPM + 1), 10)).toBeNull();
    expect(pendulumSwing(start(createState(), 0), at(240), 10)).toBeNull();
    expect(pendulumSwing(start(createState(), 0), at(PENDULUM_MAX_BPM), 10)).not.toBeNull();
  });

  it("stands at the far side on each beat and alternates left and right", () => {
    const settings = at(100);
    const running = start(createState(), 1000);
    const period = msPerBeat(100);
    const sides = [0, 1, 2, 3, 4, 5].map((beat) => pendulumSwing(running, settings, 1000 + beat * period + 5));
    expect(sides).toEqual([-2, 2, -2, 2, -2, 2]);
  });

  it("passes through the middle half-way only at slow tempi", () => {
    const slow = at(PENDULUM_MIDSWING_MAX_BPM);
    const running = start(createState(), 0);
    const period = msPerBeat(slow.bpm);
    expect(pendulumSwing(running, slow, 10)).toBe(-2);
    expect(pendulumSwing(running, slow, period * 0.6)).toBe(0);
    expect(pendulumSwing(running, slow, period + 10)).toBe(2);
    const medium = at(100);
    expect(pendulumSwing(running, medium, msPerBeat(100) * 0.6)).toBe(-2);
  });
});

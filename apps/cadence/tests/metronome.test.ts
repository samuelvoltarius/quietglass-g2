import { describe, it, expect } from "vitest";
import {
  bpmFromTaps, clampBpm, createState, DEFAULT_SETTINGS, MAX_BPM, MIN_BPM,
  msPerBeat, msToNextBeat, positionAt, reset, start, stop, toggle, totalBeats,
  type MetronomeSettings,
} from "../src/metronome/engine";

const fourFour: MetronomeSettings = { bpm: 120, signature: { beats: 4, unit: 4 }, mark: "beat" };
// 120 bpm = 500 ms per beat, 2000 ms per bar.

describe("tempo", () => {
  it("converts bpm to a beat period", () => {
    expect(msPerBeat(120)).toBe(500);
    expect(msPerBeat(60)).toBe(1000);
  });

  it("clamps to the supported range and rounds", () => {
    expect(clampBpm(5)).toBe(MIN_BPM);
    expect(clampBpm(9999)).toBe(MAX_BPM);
    expect(clampBpm(100.4)).toBe(100);
    expect(clampBpm(Number.NaN)).toBe(DEFAULT_SETTINGS.bpm);
  });
});

describe("transport", () => {
  it("starts and stops", () => {
    const running = start(createState(), 1000);
    expect(running.running).toBe(true);
    expect(stop(running, fourFour, 2000).running).toBe(false);
  });

  it("ignores a second start", () => {
    const running = start(createState(), 1000);
    expect(start(running, 5000)).toBe(running);
  });

  it("ignores a stop when not running", () => {
    const state = createState();
    expect(stop(state, fourFour, 1000)).toBe(state);
  });

  it("toggles", () => {
    const state = createState();
    expect(toggle(state, fourFour, 0).running).toBe(true);
    expect(toggle(toggle(state, fourFour, 0), fourFour, 1000).running).toBe(false);
  });

  it("keeps the beat count across a pause", () => {
    let state = start(createState(), 0);
    state = stop(state, fourFour, 2000);        // 4 beats at 120 bpm
    expect(state.beatsBefore).toBe(4);

    state = start(state, 10_000);
    expect(totalBeats(state, fourFour, 11_000)).toBe(6);  // 4 + 2
  });

  it("clears everything on reset", () => {
    expect(reset()).toEqual(createState());
  });
});

describe("position is derived from time, never accumulated", () => {
  it("counts beats within the bar", () => {
    const state = start(createState(), 0);
    expect(positionAt(state, fourFour, 0).beat).toBe(1);
    expect(positionAt(state, fourFour, 500).beat).toBe(2);
    expect(positionAt(state, fourFour, 1500).beat).toBe(4);
    expect(positionAt(state, fourFour, 2000).beat).toBe(1);
  });

  it("counts bars", () => {
    const state = start(createState(), 0);
    expect(positionAt(state, fourFour, 0).bar).toBe(1);
    expect(positionAt(state, fourFour, 2000).bar).toBe(2);
    expect(positionAt(state, fourFour, 4000).bar).toBe(3);
  });

  it("marks the downbeat", () => {
    const state = start(createState(), 0);
    expect(positionAt(state, fourFour, 0).downbeat).toBe(true);
    expect(positionAt(state, fourFour, 500).downbeat).toBe(false);
    expect(positionAt(state, fourFour, 2000).downbeat).toBe(true);
  });

  it("gives the same answer regardless of how often it is asked", () => {
    // This is the drift guarantee: sampling more often must not change the
    // result, which a per-tick counter could not promise.
    const state = start(createState(), 0);
    const direct = positionAt(state, fourFour, 3750);
    for (let t = 0; t <= 3750; t += 37) positionAt(state, fourFour, t);
    expect(positionAt(state, fourFour, 3750)).toEqual(direct);
  });

  it("reports phase through the beat", () => {
    const state = start(createState(), 0);
    expect(positionAt(state, fourFour, 250).phase).toBeCloseTo(0.5, 6);
    expect(positionAt(state, fourFour, 0).phase).toBeCloseTo(0, 6);
  });

  it("has no phase while stopped", () => {
    expect(positionAt(createState(), fourFour, 1234).phase).toBe(0);
  });

  it("handles odd time signatures", () => {
    const sevenEight: MetronomeSettings = { ...fourFour, signature: { beats: 7, unit: 8 } };
    const state = start(createState(), 0);
    expect(positionAt(state, sevenEight, 3000).beat).toBe(7);
    expect(positionAt(state, sevenEight, 3500).beat).toBe(1);
    expect(positionAt(state, sevenEight, 3500).bar).toBe(2);
  });
});

describe("scheduling", () => {
  it("reports the time to the next beat so redraws land on the beat", () => {
    const state = start(createState(), 0);
    expect(msToNextBeat(state, fourFour, 0)).toBe(500);
    expect(msToNextBeat(state, fourFour, 300)).toBe(200);
  });

  it("falls back to a whole period while stopped", () => {
    expect(msToNextBeat(createState(), fourFour, 999)).toBe(500);
  });
});

describe("tap tempo", () => {
  it("averages the gaps between taps", () => {
    expect(bpmFromTaps([0, 500, 1000, 1500])).toBe(120);
  });

  it("needs at least two taps", () => {
    expect(bpmFromTaps([])).toBeNull();
    expect(bpmFromTaps([1000])).toBeNull();
  });

  it("ignores a stale gap from an abandoned attempt", () => {
    // The 9-second gap is dropped; the remaining taps are 500 ms apart.
    expect(bpmFromTaps([0, 9000, 9500, 10_000, 10_500])).toBe(120);
  });

  it("clamps an implausible result", () => {
    expect(bpmFromTaps([0, 10])).toBe(MAX_BPM);
  });

  it("returns null when every gap is unusable", () => {
    expect(bpmFromTaps([1000, 1000])).toBeNull();
  });
});

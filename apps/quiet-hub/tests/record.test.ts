/**
 * Voice note plumbing: WAV assembly and the record state machine.
 *
 * The microphone path itself needs real hardware — what is tested here is
 * everything either side of it: that the file is a valid PCM WAV, and that
 * hold-to-speak cannot leak gestures into the rest of the app.
 */
import { describe, expect, it } from "vitest";
import { buildWav, toBase64 } from "../src/audio/wav";
import { buildView, createModel, decide } from "../src/hub/model";
import { demoReport } from "../src/api/demo";

function agentModel() {
  return { ...createModel(demoReport()), screen: "agent" as const, agentView: "ask" as const };
}

describe("buildWav", () => {
  it("writes a valid 16 kHz mono PCM header around the samples", () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const wav = buildWav([pcm]);
    expect(wav.length).toBe(48);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    expect(String.fromCharCode(...wav.subarray(36, 40))).toBe("data");
    const view = new DataView(wav.buffer);
    expect(view.getUint32(4, true)).toBe(36 + 4);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(4); // data size
    expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4]);
  });

  it("concatenates several PCM blocks in order", () => {
    const wav = buildWav([new Uint8Array([1, 2]), new Uint8Array([3])]);
    expect([...wav.subarray(44)]).toEqual([1, 2, 3]);
  });

  it("encodes to base64 without corrupting samples", () => {
    const pcm = new Uint8Array([0, 255, 128, 64, 1, 2, 3]);
    const wav = buildWav([pcm]);
    const decoded = atob(toBase64(wav));
    expect([...decoded].map((char) => char.charCodeAt(0))).toEqual([...wav]);
  });
});

describe("hold-to-speak", () => {
  it("long press starts recording on the agent page", () => {
    const model = agentModel();
    const out = decide(model, "longPress", 1000);
    expect(out.model.recording).toBe(true);
    expect(out.effect).toEqual({ kind: "recordStart" });
  });

  it("releasing sends the note", () => {
    const model = agentModel();
    const recording = decide(model, "longPress", 1000).model;
    const out = decide(recording, "longPressRelease", 1500);
    expect(out.model.recording).toBe(false);
    expect(out.effect).toEqual({ kind: "recordStop", agentId: "hermes-spark" });
  });

  it("swipes are swallowed while recording; tap sends, double tap discards", () => {
    const model = agentModel();
    const recording = decide(model, "longPress", 1000).model;
    for (const gesture of ["scrollDown", "scrollUp"] as const) {
      const out = decide(recording, gesture, 1100);
      expect(out.effect).toBeUndefined();
      expect(out.model.recording).toBe(true);
      expect(out.model.screen).toBe("agent");
    }
    // The release event can get lost on real hardware: these two are the way out.
    const sent = decide(recording, "click", 1100);
    expect(sent.effect).toEqual({ kind: "recordStop", agentId: "hermes-spark" });
    expect(sent.model.recording).toBe(false);
    const discarded = decide(recording, "doubleClick", 1100);
    expect(discarded.effect).toEqual({ kind: "recordAbort" });
    expect(discarded.model.recording).toBe(false);
    expect(discarded.model.screen).toBe("agent");
  });

  it("shows the recording line over everything else", () => {
    const model = agentModel();
    const recording = decide(model, "longPress", 1000).model;
    const view = buildView(recording, "de", 1100);
    expect(view.footer).toContain("sprich");
  });

  it("long press on the home page stays a refresh", () => {
    const model = agentModel();
    const onHome = { ...model, screen: "home" as const };
    const out = decide(onHome, "longPress", 1100);
    expect(out.model.recording).toBe(false);
    expect(out.effect).toBeUndefined();
  });

  it("release without recording does nothing", () => {
    const model = agentModel();
    const out = decide(model, "longPressRelease", 1000);
    expect(out.effect).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { pcmBytes, resample, s16leToFloat32 } from "../src/pcm";
import { createCommandRecognizer, createVoskEngine, type SpeechEngine, type VoskModelLike } from "../src/recognizer";
import type { CommandDef } from "../src/commands";

const COMMANDS: readonly CommandDef[] = [
  { id: "light.kitchen.off", phrases: ["licht küche aus"] },
  { id: "light.kitchen.on", phrases: ["licht küche an"] },
];

describe("pcm", () => {
  it("reads signed 16-bit little-endian into [-1, 1)", () => {
    const f = s16leToFloat32(new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0xff, 0xff, 0x01]));
    expect(Array.from(f)).toEqual([0, 32767 / 32768, -1, -1 / 32768]);
  });

  it("accepts Uint8Array, number[] and base64 like the SDK documents", () => {
    expect(pcmBytes(new Uint8Array([1, 2]))).toEqual(new Uint8Array([1, 2]));
    expect(pcmBytes([1, 2])).toEqual(new Uint8Array([1, 2]));
    expect(pcmBytes(btoa(String.fromCharCode(1, 2)))).toEqual(new Uint8Array([1, 2]));
    expect(pcmBytes("not base64 !!!")).toBeNull();
    expect(pcmBytes({})).toBeNull();
  });

  it("resamples 48 kHz to 16 kHz and leaves 16 kHz alone", () => {
    const input = new Float32Array(480).map((_, i) => i / 480);
    const out = resample(input, 48_000);
    expect(out).toHaveLength(160);
    expect(out[1]).toBeCloseTo(3 / 480);
    expect(resample(input, 16_000)).toBe(input);
  });
});

function fakeEngine() {
  const fed: Float32Array[] = [];
  let listener: ((text: string) => void) | null = null;
  const state = { finished: 0, disposed: false };
  const engine: SpeechEngine = {
    accept: (samples) => { fed.push(samples); },
    finish: () => { state.finished += 1; },
    onText: (l) => { listener = l; },
    dispose: () => { state.disposed = true; },
  };
  return { engine, fed, state, say: (text: string) => listener?.(text) };
}

describe("command recognizer", () => {
  it("feeds PCM chunks as floats and reports the matched command", () => {
    const fake = fakeEngine();
    const rec = createCommandRecognizer(fake.engine, COMMANDS);
    const results: unknown[] = [];
    rec.onResult((r) => results.push(r));
    rec.pushPcm([0x00, 0x40, 0x00, 0xc0]);
    expect(Array.from(fake.fed[0]!)).toEqual([0.5, -0.5]);
    rec.finish();
    expect(fake.state.finished).toBe(1);
    fake.say("licht küche aus");
    expect(results).toEqual([{ text: "licht küche aus", match: { id: "light.kitchen.off", phrase: "licht küche aus", score: 1 } }]);
  });

  it("reports unknown speech with match null and ignores silence", () => {
    const fake = fakeEngine();
    const rec = createCommandRecognizer(fake.engine, COMMANDS);
    const results: { text: string; match: unknown }[] = [];
    rec.onResult((r) => results.push(r));
    fake.say("");
    fake.say("[unk]");
    expect(results).toEqual([{ text: "[unk]", match: null }]);
  });

  it("stops after dispose", () => {
    const fake = fakeEngine();
    const rec = createCommandRecognizer(fake.engine, COMMANDS);
    const results: unknown[] = [];
    rec.onResult((r) => results.push(r));
    rec.dispose();
    rec.pushPcm([0, 1]);
    fake.say("licht küche aus");
    expect(fake.state.disposed).toBe(true);
    expect(fake.fed).toHaveLength(0);
    expect(results).toHaveLength(0);
  });
});

describe("vosk adapter", () => {
  it("creates a 16 kHz recognizer with the command grammar and passes copies", () => {
    const created: { rate: number; grammar: string | undefined }[] = [];
    const accepted: { buffer: Float32Array; rate: number }[] = [];
    let onResult: ((m: { result?: { text?: string } }) => void) | null = null;
    const model: VoskModelLike = {
      KaldiRecognizer: class {
        constructor(rate: number, grammar?: string) { created.push({ rate, grammar }); }
        on(event: string, listener: (m: { result?: { text?: string } }) => void) { if (event === "result") onResult = listener; }
        acceptWaveformFloat(buffer: Float32Array, rate: number) { accepted.push({ buffer, rate }); }
        retrieveFinalResult() { onResult?.({ result: { text: "licht küche an" } }); }
        remove() { /* nothing */ }
      },
    };
    const engine = createVoskEngine(model, COMMANDS);
    expect(created[0]!.rate).toBe(16_000);
    expect(JSON.parse(created[0]!.grammar!)).toEqual(["licht küche aus", "licht küche an", "[unk]"]);
    const rec = createCommandRecognizer(engine, COMMANDS);
    const ids: (string | undefined)[] = [];
    rec.onResult((r) => ids.push(r.match?.id));
    rec.pushPcm(new Uint8Array([0, 0x40]));
    expect(accepted[0]!.rate).toBe(16_000);
    rec.finish();
    expect(ids).toEqual(["light.kitchen.on"]);
  });
});

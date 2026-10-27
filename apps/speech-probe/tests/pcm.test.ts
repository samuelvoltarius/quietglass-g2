import { describe, expect, it } from "vitest";
import { concatBytes, levelDbfs, PcmRecorder, pcm16leToFloat32, SAMPLE_RATE, toBytes } from "../src/audio/pcm";

describe("PCM conversion", () => {
  it("reads signed 16-bit little-endian samples", () => {
    // 0, +16384, -32768, +32767, -1
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x40, 0x00, 0x80, 0xff, 0x7f, 0xff, 0xff]);
    const out = pcm16leToFloat32(bytes);
    expect(Array.from(out)).toEqual([0, 0.5, -1, 32767 / 32768, -1 / 32768]);
  });

  it("ignores a trailing odd byte", () => {
    expect(pcm16leToFloat32(new Uint8Array([0x00, 0x40, 0x12])).length).toBe(1);
  });

  it("keeps a sample that is split across two chunks", () => {
    const rec = new PcmRecorder();
    rec.push(new Uint8Array([0x00, 0x40, 0x00]), 0);
    rec.push(new Uint8Array([0xc0]), 10);
    expect(Array.from(rec.toFloat32())).toEqual([0.5, -0.5]);
    expect(concatBytes([new Uint8Array([1]), new Uint8Array([2, 3])])).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("accepts the containers older hosts used (number[], base64)", () => {
    expect(toBytes([1, 2, 3])).toEqual(new Uint8Array([1, 2, 3]));
    expect(toBytes(btoa(String.fromCharCode(0, 64)))).toEqual(new Uint8Array([0, 64]));
    const u = new Uint8Array([9]);
    expect(toBytes(u)).toBe(u);
    expect(toBytes(42)).toBeNull();
    expect(toBytes("%%%not base64")).toBeNull();
  });

  it("measures length and rate of a recording window", () => {
    const rec = new PcmRecorder();
    // 5 s at 16 kHz in 100 ms chunks of 3200 bytes.
    for (let i = 0; i < 50; i += 1) rec.push(new Uint8Array(3200), 1000 + i * 100);
    expect(rec.chunkCount).toBe(50);
    expect(rec.sampleCount).toBe(80_000);
    expect(rec.audioSeconds).toBe(5);
    expect(rec.samplesPerSecond(5000)).toBe(SAMPLE_RATE);
    expect(rec.firstChunkAt).toBe(1000);
    expect(rec.lastChunkAt).toBe(5900);
    rec.push(new Uint8Array(0), 9999);
    expect(rec.chunkCount).toBe(50);
  });

  it("reports level in dBFS, -120 for silence", () => {
    expect(levelDbfs(new Float32Array(100))).toEqual({ rms: -120, peak: -120 });
    expect(levelDbfs(new Float32Array(0))).toEqual({ rms: -120, peak: -120 });
    const half = new Float32Array(10).fill(0.5);
    expect(levelDbfs(half)).toEqual({ rms: -6, peak: -6 });
  });
});

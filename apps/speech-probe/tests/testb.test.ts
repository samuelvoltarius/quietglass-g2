import { describe, expect, it } from "vitest";
import { RECORD_MS, TestBRunner, type TestBDeps } from "../src/probe/testb";
import type { LoadStats } from "../src/probe/whisper";

const STATS: LoadStats = {
  device: "wasm", dtype: "q8", modelBytes: 41_000_000, netBytes: 41_000_000, netFiles: 9, hosts: "https://huggingface.co",
  fetchMs: 8000, sessionMs: 1500, loadMs: 9500, fallback: "", runtime: "bundled",
};

/** A fake clock: sleep advances time and delivers one 100 ms PCM frame (3200 bytes) per 100 ms. */
function fakeDeps(over: Partial<TestBDeps> = {}, feed?: (runner: TestBRunner, t: number) => void) {
  let t = 0;
  const calls: string[] = [];
  const holder: { runner?: TestBRunner } = {};
  const deps: TestBDeps = {
    audioControl: async (open) => { calls.push(`audio:${open}`); return true; },
    detectWebGpu: async () => ({ available: false, detail: "no navigator.gpu" }),
    loadWhisper: async (model, device, wasm) => { calls.push(`load:${model}:${device}:${wasm}`); return { pipe: "pipe", stats: { ...STATS, device }, reused: false }; },
    transcribe: async (_pipe, audio, lang) => { calls.push(`transcribe:${audio.length}:${lang}`); return { text: "hallo", ms: 1000 }; },
    netReport: () => ({ hosts: "", failures: "" }),
    cacheApi: true,
    now: () => t,
    sleep: async (ms) => {
      const end = t + ms;
      while (t < end) {
        t += 100;
        if (feed) feed(holder.runner!, t);
        else holder.runner!.feed({ audioEvent: { audioPcm: new Uint8Array(3200), speakerRole: t % 1000 < 700 ? "self" : "other" } });
      }
    },
    ...over,
  };
  const runner = new TestBRunner(deps);
  holder.runner = runner;
  return { runner, calls };
}

describe("test B runner", () => {
  it("records 5 s from the glasses, closes the mic, transcribes and reports the numbers", async () => {
    const { runner, calls } = fakeDeps();
    const result = await runner.run({ lang: "de", model: "whisper-tiny", device: "auto", wasm: "bundled" });
    expect(calls[0]).toBe("audio:true");
    expect(calls[1]).toBe("audio:false");
    expect(calls[2]).toBe("load:whisper-tiny:wasm:bundled");
    expect(calls[3]).toBe(`transcribe:${(RECORD_MS / 1000) * 16000}:de`);
    expect(result.error).toBe("");
    expect(result.audioSeconds).toBe(5);
    expect(result.samplesPerSecond).toBe(16000);
    expect(result.transcribeMs).toBe(1000);
    expect(result.rtf).toBe(0.2);
    expect(result.roleSelf).toBe(70);
    expect(result.roleOther).toBe(30);
    expect(result.text).toBe("hallo");
    expect(runner.recording).toBe(false);
    // Audio after the window is ignored.
    expect(runner.feed({ audioEvent: { audioPcm: new Uint8Array(2) } })).toBe(false);
  });

  it("falls back to WASM when WebGPU was chosen automatically and fails", async () => {
    const { runner, calls } = fakeDeps({
      detectWebGpu: async () => ({ available: true, detail: "adapter apple/x" }),
      loadWhisper: async (_m, device) => {
        calls.push(`load:${device}`);
        if (device === "webgpu") throw new Error("no shader-f16");
        return { pipe: "p", stats: { ...STATS, device }, reused: false };
      },
    });
    const result = await runner.run({ lang: "en", model: "whisper-tiny", device: "auto", wasm: "cdn" });
    expect(calls.filter((c) => c.startsWith("load:"))).toEqual(["load:webgpu", "load:wasm"]);
    expect(result.device).toBe("wasm");
    expect(result.fallback).toContain("no shader-f16");
    expect(result.error).toBe("");
  });

  it("reports a refused microphone without loading the model", async () => {
    const { runner, calls } = fakeDeps({ audioControl: async () => false });
    const result = await runner.run({ lang: "de", model: "whisper-tiny", device: "wasm", wasm: "bundled" });
    expect(result.failedAt).toBe("mic");
    expect(calls.some((c) => c.startsWith("load"))).toBe(false);
  });

  it("reports when no audio frame arrived", async () => {
    const { runner } = fakeDeps({}, () => undefined);
    const result = await runner.run({ lang: "de", model: "whisper-tiny", device: "wasm", wasm: "bundled" });
    expect(result.failedAt).toBe("noAudio");
    expect(result.roles).toBe("no frames");
  });

  it("a cancelled recording stops early and closes the microphone", async () => {
    let cancel = false;
    const { runner, calls } = fakeDeps({}, (r, t) => { r.feed({ audioEvent: { audioPcm: new Uint8Array(3200) } }); if (t >= 1000) cancel = true; });
    const result = await runner.run({ lang: "de", model: "whisper-tiny", device: "wasm", wasm: "bundled", cancelled: () => cancel });
    expect(result.failedAt).toBe("cancelled");
    expect(result.recordMs).toBeLessThan(RECORD_MS);
    expect(calls).toContain("audio:false");
  });
});

import { describe, expect, it } from "vitest";
import { copyText, diagFields, fmtBytes, fmtMs, glassesLinesB, realTimeFactor, rowsA, rowsB, summaryA, type ResultA, type ResultB } from "../src/probe/results";
import { readResult, summarizeVoices } from "../src/probe/speech";
import { viewFor } from "../src/glasses/view";

const A: ResultA = {
  at: "2026-10-23T12:00:00.000Z", lang: "de", userAgent: "UA", secureContext: true, protocol: "https:",
  hasSpeechRecognition: false, hasWebkitSpeechRecognition: true, hasGetUserMedia: true, started: true,
  permissionBefore: "prompt", permissionAfter: "granted", promptSeen: "yes", events: "start@40 audiostart@900 end@3000",
  audioStartMs: 900, transcript: "Hallo Welt", confidence: 0.91, isFinal: true, errors: "", errorMessage: "",
  durationMs: 3100, voices: 3, voiceLangs: "de-DE,en-US", deVoices: 2, enVoices: 1,
};

const B: ResultB = {
  at: "2026-10-23T12:01:00.000Z", lang: "en", model: "whisper-tiny", deviceWanted: "auto", device: "wasm", dtype: "q8",
  webgpu: "no (no navigator.gpu)", cacheApi: true, reused: false, modelBytes: 41_000_000, netBytes: 41_000_000, netFiles: 9,
  hosts: "https://huggingface.co https://us.aws.cdn.hf.co", fetchMs: 8000, sessionMs: 1500, loadMs: 9500, fallback: "",
  runtime: "bundled", audioControl: "true", recordMs: 5010, chunks: 50, firstChunkMs: 120, audioSeconds: 5, samplesPerSecond: 15968,
  rmsDb: -32.5, peakDb: -8, roles: "self 70% · other 30%", roleSelf: 70, roleOther: 30, roleUnknown: 0, roleMissing: 0,
  transcribeMs: 1250, rtf: 0.25, text: "hello world", failedAt: "", error: "",
};

describe("formatting", () => {
  it("formats times, sizes and the real-time factor", () => {
    expect(fmtMs(null)).toBe("–");
    expect(fmtMs(830)).toBe("830 ms");
    expect(fmtMs(1234)).toBe("1.23 s");
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(40_853_016)).toBe("40.9 MB");
    expect(fmtBytes(5_500)).toBe("6 kB");
    expect(realTimeFactor(1250, 5)).toBe(0.25);
    expect(realTimeFactor(12_345, 5)).toBe(2.47);
    expect(realTimeFactor(null, 5)).toBeNull();
    expect(realTimeFactor(1000, 0)).toBeNull();
  });

  it("test A table names the API and the exact error names", () => {
    const rows = new Map(rowsA(A));
    expect(rows.get("Available")).toBe("yes (webkitSpeechRecognition)");
    expect(rows.get("Result")).toBe("Hallo Welt");
    expect(rows.get("Errors")).toBe("none");
    expect(rows.get("Permission")).toBe("prompt → granted");
    expect(rows.get("Voices")).toBe("3 (de 2, en 1)");
    const failed = new Map(rowsA({ ...A, hasWebkitSpeechRecognition: false, errors: "not-available" }));
    expect(failed.get("Available")).toBe("no");
    expect(failed.get("Errors")).toBe("not-available");
    expect(summaryA({ ...A, errors: "not-allowed" })).toBe("Last run: error not-allowed");
    expect(summaryA(A)).toBe('Last run: "Hallo Welt"');
  });

  it("test B table and glasses lines carry the timing", () => {
    const rows = new Map(rowsB(B));
    expect(rows.get("Transcribe")).toBe("1.25 s");
    expect(rows.get("RTF")).toBe("0.25");
    expect(rows.get("Load total")).toBe("9.50 s");
    expect(rows.get("Speaker role")).toBe("self 70% · other 30%");
    expect(rows.get("Audio")).toBe("5.00 s · 50 chunks · 15968 samples/s");
    expect(glassesLinesB(B)).toEqual([
      "hello world",
      "",
      "1.25 s for 5.0 s · RTF 0.25 · wasm",
      "load 9.50 s · 41.0 MB · net 41.0 MB",
      "role: self 70% · other 30%",
    ]);
    expect(glassesLinesB({ ...B, reused: true })[3]).toBe("whisper-tiny · model in memory");
    expect(new Map(rowsB({ ...B, reused: true })).get("Load total")).toBe("–");
    expect(glassesLinesB({ ...B, failedAt: "noAudio", error: "no audio frames" })).toEqual(["Failed at noAudio:", "no audio frames"]);
  });

  it("copy text holds both tests, or says which was not run", () => {
    const text = copyText(A, B, "0.1.0");
    expect(text.startsWith("Speech Probe 0.1.0")).toBe(true);
    expect(text).toContain("Test A · platform speech recognition (2026-10-23T12:00:00.000Z)");
    expect(text).toContain("Result: Hallo Welt");
    expect(text).toContain("RTF: 0.25");
    expect(copyText(null, null, "0.1.0")).toBe("Speech Probe 0.1.0\n\nTest A: not run\n\nTest B: not run");
  });

  it("the step-log event keeps numbers as numbers and has no audio", () => {
    const fields = diagFields(B);
    expect(fields["transcribeMs"]).toBe(1250);
    expect(fields["rtf"]).toBe(0.25);
    expect(fields["reused"]).toBe(false);
    expect(fields["firstChunkMs"]).toBe(120);
    expect(Object.values(fields).every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))).toBe(true);
  });
});

describe("speech recognition helpers", () => {
  it("joins all results and tracks interim/final", () => {
    const results = Object.assign([Object.assign([{ transcript: " Hallo ", confidence: 0.8 }], { isFinal: true }), Object.assign([{ transcript: "Welt", confidence: 0 }], { isFinal: false })]);
    expect(readResult({ results })).toEqual({ transcript: "Hallo Welt", confidence: 0.8, isFinal: false });
    expect(readResult({})).toBeNull();
  });

  it("counts voices per language", () => {
    expect(summarizeVoices([{ lang: "de-DE" }, { lang: "en-US" }, { lang: "en_GB" }, { lang: "de-DE" }])).toEqual({ count: 4, langs: "de-DE,en-US,en_GB", de: 2, en: 2 });
  });
});

describe("glasses views (QUS calm)", () => {
  it("start screen: two entries, the selected one marked, one hint line", () => {
    const view = viewFor({ kind: "start", sel: 1 }, { lang: "de", model: "whisper-tiny" });
    expect(view.header).toBe("Speech Probe");
    expect(view.body[0]).toBe("○ Test A · phone speech");
    expect(view.body[3]).toBe("● Test B · Whisper 5 s");
    expect(view.footer).toBe("Swipe choose · tap start · 2× exit");
    expect(view.footer).not.toMatch(/hold|halten/i);
  });

  it("recording and result views", () => {
    expect(viewFor({ kind: "recording", secondsLeft: 3, chunks: 4 }, { lang: "en", model: "x" }).header).toBe("Test B · ● rec");
    const done = viewFor({ kind: "result", ok: true, lines: ["hi"] }, { lang: "en", model: "x" });
    expect(done.header).toBe("Test B · done");
    expect(done.footer).toBe("Tap again · 2× back");
  });
});

import { describe, expect, it, vi } from "vitest";
import { pcmBytes, sttBase, sttEndpoint, transcribe } from "../src/stt/provider";
import { buildWav } from "../src/audio/wav";
import { parseData, usesMockStt } from "../src/storage/persist";

describe("Whisper over HTTP", () => {
  it("takes the phone setting, else the build default, else none", () => {
    expect(sttBase(" https://a.test:8457/ ", "https://build.test")).toBe("https://a.test:8457");
    expect(sttBase("", "https://build.test:8457")).toBe("https://build.test:8457");
    expect(sttBase("", undefined)).toBe("");
  });

  it("adds the transcription path unless a full endpoint is given", () => {
    expect(sttEndpoint("https://a.test")).toBe("https://a.test/v1/audio/transcriptions");
    expect(sttEndpoint("https://a.test/v1/audio/transcriptions")).toBe("https://a.test/v1/audio/transcriptions");
  });

  it("leaves the language out on auto and sends a token only when set", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: "  Hallo   Welt " }), { status: 200 }));
    const wav = buildWav([new Uint8Array(64)]);
    expect(await transcribe(wav, "https://a.test", { language: "auto", fetchImpl: fetchImpl as never })).toBe("Hallo Welt");
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.body as FormData).get("language")).toBeNull();
    expect(init.headers).toBeUndefined();
    await transcribe(wav, "https://a.test", { language: "de", token: "t", fetchImpl: fetchImpl as never });
    const [, second] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect((second.body as FormData).get("language")).toBe("de");
    expect(second.headers).toEqual({ Authorization: "Bearer t" });
  });

  it("fails loudly on an HTTP error", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 500 }));
    await expect(transcribe(new Uint8Array(44), "https://a.test", { language: "de", fetchImpl: fetchImpl as never })).rejects.toThrow("HTTP 500");
  });

  it("normalises every PCM shape the bridge sends", () => {
    expect(pcmBytes(new Uint8Array([1, 2]))).toEqual(new Uint8Array([1, 2]));
    expect(pcmBytes([3, 4])).toEqual(new Uint8Array([3, 4]));
    expect(pcmBytes(btoa("\u0005\u0006"))).toEqual(new Uint8Array([5, 6]));
    expect(pcmBytes(42)).toBeNull();
  });

  it("drops a ws:// address from the retired WebSocket protocol", () => {
    const data = parseData(JSON.stringify({ sttUrl: "wss://old.test/asr" }));
    expect(data.sttUrl).toBe("");
    expect(usesMockStt(data, "")).toBe(true);
    expect(usesMockStt(data, "https://build.test:8457")).toBe(false);
    expect(parseData(JSON.stringify({ sttUrl: "https://new.test:8457" })).sttUrl).toBe("https://new.test:8457");
  });
});

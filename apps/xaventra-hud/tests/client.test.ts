import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createClient, isLoopback, isPlainHttp, validateServerUrl } from "../src/api/client";
import { parseFeed, parseVoice } from "../src/api/types";
import { errorText } from "../src/hud/errors";
import { pcmToWav, toPcm } from "../src/voice/wav";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

afterEach(() => { vi.useRealTimers(); });

describe("client", () => {
  it("long-polls /hud with since and wait, token only in the header", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => json({ version: "v2", status: "ok", cards: [] }));
    const client = createClient({ baseUrl: "https://x.example/", token: "tok", fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.feed("v 1", new AbortController().signal);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://x.example/hud?since=v%201&wait=20");
    expect(String(url)).not.toContain("tok");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
  });

  it("answers with JSON and sends WAV for voice", async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).includes("/hud/voice") ? json({ transcript: "ja", action: "answered_ja", cardId: "c1" }) : json({ message: "Angenommen." }));
    const client = createClient({ baseUrl: "https://x.example", token: "t", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await client.answer("c1", "ja")).toEqual({ message: "Angenommen." });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ cardId: "c1", answer: "ja" });
    const wav = pcmToWav(new Uint8Array(100));
    expect(await client.voice(wav)).toEqual({ transcript: "ja", action: "answered_ja", cardId: "c1", reply: "" });
    const init = fetchImpl.mock.calls[1]?.[1];
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("audio/wav");
    expect((init?.body as Blob).size).toBe(144);
    await client.voice(wav, "k 1");
    expect(fetchImpl.mock.calls[2]?.[0]).toBe("https://x.example/hud/voice?cardId=k%201");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://x.example/hud/voice");
  });

  it("maps failures to short codes", async () => {
    const make = (impl: () => Promise<Response>) =>
      createClient({ baseUrl: "https://x.example", token: "t", fetchImpl: impl as unknown as typeof fetch });
    await expect(make(async () => json({}, 401)).answer("c", "ja")).rejects.toMatchObject({ code: "auth", status: 401 });
    await expect(make(async () => json({}, 409)).answer("c", "ja")).rejects.toMatchObject({ code: "http", status: 409 });
    await expect(make(async () => { throw new TypeError("Failed to fetch"); }).answer("c", "ja")).rejects.toMatchObject({ code: "unreachable" });
    await expect(make(async () => new Response("<html>", { status: 200 })).answer("c", "ja")).rejects.toMatchObject({ code: "bad-reply" });
    await expect(make(async () => json({ nope: true })).voice(new ArrayBuffer(0))).rejects.toMatchObject({ code: "bad-reply" });
    await expect(make(async () => json({ nope: true })).feed("", new AbortController().signal)).rejects.toMatchObject({ code: "bad-reply" });
  });

  it("times out and tells a timeout from the caller's own abort", async () => {
    const hang = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;
    const slow = createClient({ baseUrl: "https://x.example", token: "t", fetchImpl: hang, timeoutMs: 5, voiceTimeoutMs: 5, pollTimeoutMs: 5 });
    await expect(slow.answer("c", "ja")).rejects.toMatchObject({ code: "timeout" });
    await expect(slow.voice(new ArrayBuffer(0))).rejects.toMatchObject({ code: "timeout" });
    const patient = createClient({ baseUrl: "https://x.example", token: "t", fetchImpl: hang, pollTimeoutMs: 60_000 });
    const controller = new AbortController();
    const running = patient.feed("", controller.signal);
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "aborted" });
    const already = new AbortController();
    already.abort();
    await expect(patient.feed("", already.signal)).rejects.toMatchObject({ code: "aborted" });
  });

  it("errors never carry the address or the token", () => {
    const error = new ApiError("http", 503);
    expect(error.message).toBe("HTTP 503");
    expect(errorText("de", error)).toBe("Dienst nicht bereit");
    expect(errorText("en", new ApiError("http", 418))).toBe("Error 418");
    expect(errorText("de", new Error("https://secret.example tok"))).toBe("Xaventra nicht erreichbar");
  });
});

describe("parsing", () => {
  it("keeps only well-formed cards, caps them and clips the texts", () => {
    const feed = parseFeed({
      version: "abc", status: "x".repeat(1000),
      cards: [
        { id: "k1", titel: "T", text: "B", wirkung: "physisch", antworten: ["ja", "nein"] },
        { titel: "no id" }, "junk", null,
        ...Array.from({ length: 10 }, (_, i) => ({ id: "n" + i, titel: "t", text: "t", wirkung: "intern" })),
      ],
    });
    expect(feed?.status.length).toBe(300);
    expect(feed?.cards.length).toBe(5);
    expect(feed?.cards[0]).toEqual({ id: "k1", title: "T", text: "B", effect: "physisch" });
  });

  it("treats a missing effect as internal and refuses a body without a version", () => {
    expect(parseFeed({ version: "v", status: "", cards: [{ id: "k" }] })?.cards[0]?.effect).toBe("intern");
    expect(parseFeed({ status: "x" })).toBeNull();
    expect(parseFeed(null)).toBeNull();
  });

  it("accepts only known voice actions", () => {
    expect(parseVoice({ transcript: "ja", action: "answered_ja", cardId: "c" })?.action).toBe("answered_ja");
    expect(parseVoice({ transcript: "ja", action: "format_disk" })).toBeNull();
    expect(parseVoice("nope")).toBeNull();
  });
});

describe("address check", () => {
  it("accepts https and local http, refuses the rest", () => {
    expect(validateServerUrl("https://x.example:8790").valid).toBe(true);
    expect(validateServerUrl("http://127.0.0.1:18790").valid).toBe(true);
    for (const bad of ["", "ftp://x", "https://u:p@x.example", "https://x.example/?token=1", "nope"]) {
      expect(validateServerUrl(bad).valid, bad).toBe(false);
    }
    expect(isPlainHttp("http://x.example")).toBe(true);
    expect(isLoopback("http://localhost:1")).toBe(true);
    expect(isLoopback("http://x.example")).toBe(false);
  });
});

describe("audio", () => {
  it("wraps PCM in a 16 kHz mono 16-bit WAV header", () => {
    const view = new DataView(pcmToWav(new Uint8Array(10)));
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(10);
  });

  it("reads PCM from bytes, arrays and base64", () => {
    expect([...toPcm(new Uint8Array([1, 2]))]).toEqual([1, 2]);
    expect([...toPcm([1, 2, "x"])]).toEqual([1, 2]);
    expect([...toPcm(btoa("\u0001\u0002"))]).toEqual([1, 2]);
    expect(toPcm(42).length).toBe(0);
  });
});

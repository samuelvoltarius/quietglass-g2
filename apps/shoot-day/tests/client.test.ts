import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createClient, validateServerUrl } from "../src/api/client";
import { clockMinutes, parseCallSheet, parseEquipment, parseShotList, parseTakes, scheduleNow } from "../src/api/types";
import { concat, pcmToWav, toPcm } from "../src/voice/wav";
import { createDemoApi } from "../src/api/demo";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

describe("server client", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("sends the token as a header, never in the URL, and joins paths onto a base with a prefix", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ project: "P", shots: [] }));
    await createClient({ baseUrl: "https://x.example/shoot/", token: "abc", fetchImpl }).shotList();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://x.example/shoot/api/shotlist");
    expect(String(url)).not.toContain("abc");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer abc");
  });

  it("maps failures to short codes", async () => {
    const code = async (fetchImpl: typeof fetch): Promise<string> =>
      createClient({ baseUrl: "https://x.example", fetchImpl }).shotList().then(() => "none", (e: ApiError) => e.code + (e.status ? ":" + e.status : ""));
    expect(await code(async () => json({}, 401))).toBe("auth:401");
    expect(await code(async () => json({}, 500))).toBe("http:500");
    expect(await code(async () => new Response("not json"))).toBe("bad-reply");
    expect(await code(async () => { throw new TypeError("Failed to fetch"); })).toBe("unreachable");
  });

  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    const hang: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    const pending = createClient({ baseUrl: "https://x.example", fetchImpl: hang, timeoutMs: 1000 }).equipment().catch((e: ApiError) => e.code);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await pending).toBe("timeout");
  });

  it("sends speech with the language hint and caps the answer", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ text: "x".repeat(2000) }));
    const text = await createClient({ baseUrl: "https://x.example", fetchImpl }).transcribe(pcmToWav(new Uint8Array(10)), "de");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://x.example/api/stt?lang=de");
    expect(text).toHaveLength(500);
  });
});

describe("reply validation", () => {
  it("coerces, cuts and drops malformed entries", () => {
    const list = parseShotList({ project: 7, shots: [{ scene: 1, shot: "A", desc: "x".repeat(500) }, null, { desc: "no ids" }, "junk"] });
    expect(list.project).toBe("7");
    expect(list.shots).toHaveLength(1);
    expect(list.shots[0]?.desc).toHaveLength(200);
    expect(parseShotList("nonsense").shots).toEqual([]);
    expect(parseTakes({ takes: [{ scene: "1", shot: "A", n: 0 }, { scene: "1", shot: "A", n: 2, status: "weird" }] }))
      .toEqual([{ scene: "1", shot: "A", n: 2, status: "OK", note: "", ts: 0 }]);
    expect(parseEquipment({ items: [{ name: " ", need: true }, { name: "Gimbal", need: "yes" }] }).items).toEqual([{ group: "", name: "Gimbal", need: false, packed: false }]);
    expect(parseCallSheet({ schedule: [{}, { time: "9:00", what: "Call" }] }).schedule).toEqual([{ time: "9:00", what: "Call" }]);
  });

  it("reads clock times and finds now and next", () => {
    expect(clockMinutes("09:30")).toBe(570);
    expect(clockMinutes("9.05 Uhr")).toBe(545);
    expect(clockMinutes("25:00")).toBeNull();
    expect(clockMinutes("morgens")).toBeNull();
    const rows = [{ time: "08:00", what: "a" }, { time: "?", what: "b" }, { time: "10:00", what: "c" }, { time: "12:00", what: "d" }];
    expect(scheduleNow(rows, new Date(2026, 0, 1, 10, 30))).toEqual({ now: rows[2], next: rows[3], inMinutes: 90 });
    expect(scheduleNow(rows, new Date(2026, 0, 1, 7, 0))).toEqual({ next: rows[0], inMinutes: 60 });
  });

  it("validates the server address", () => {
    expect(validateServerUrl("https://a.example").valid).toBe(true);
    expect(validateServerUrl("http://127.0.0.1:8899").valid).toBe(true);
    expect(validateServerUrl("ws://a").errors).toEqual(["p.err.urlScheme"]);
    expect(validateServerUrl("nope").errors).toEqual(["p.err.urlInvalid"]);
  });
});

describe("audio", () => {
  it("wraps PCM in a 16 kHz mono WAV header", () => {
    const wav = new DataView(pcmToWav(new Uint8Array([1, 2, 3, 4])));
    expect(wav.byteLength).toBe(48);
    expect(String.fromCharCode(wav.getUint8(0), wav.getUint8(1), wav.getUint8(2), wav.getUint8(3))).toBe("RIFF");
    expect(wav.getUint32(24, true)).toBe(16000);
    expect(wav.getUint32(40, true)).toBe(4);
  });

  it("accepts the PCM shapes hosts deliver and joins blocks", () => {
    expect([...toPcm([1, 2])]).toEqual([1, 2]);
    expect([...toPcm(btoa("\u0001\u0002"))]).toEqual([1, 2]);
    expect(toPcm({})).toHaveLength(0);
    expect([...concat([new Uint8Array([1]), new Uint8Array([2, 3])])]).toEqual([1, 2, 3]);
  });
});

describe("demo data", () => {
  it("is marked as demo and needs no network", async () => {
    const api = createDemoApi("de");
    expect(api.demo).toBe(true);
    expect((await api.shotList()).shots.length).toBeGreaterThan(0);
    await api.setPacked("Gimbal", false);
    expect((await api.equipment()).items.find((i) => i.name === "Gimbal")?.packed).toBe(false);
  });
});

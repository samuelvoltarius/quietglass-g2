import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RECORDING_MS, MIN_RECORDING_MS, PCM_BYTES_PER_SECOND, askAssistant, fitLines, isTooLong, isTooShort, joinPcm, parseReply, recordingMs, wrap } from "../src/assistant/audio";

describe("assistant transport", () => {
  it("joins PCM without gaps", () => { expect([...joinPcm([new Uint8Array([1, 2]), new Uint8Array([3])])]).toEqual([1, 2, 3]); });
  it("joins an empty recording into an empty buffer", () => { expect(joinPcm([]).length).toBe(0); expect(joinPcm([new Uint8Array(0)]).length).toBe(0); });
  it("validates replies", () => { expect(parseReply({ answer: "Hallo", actions: ["Licht"] }).actions).toEqual(["Licht"]); });
  it("defaults missing heard text and drops non-string actions", () => {
    expect(parseReply({ answer: "ok", actions: ["a", 3, null, "b"] })).toEqual({ heard: "", answer: "ok", actions: ["a", "b"] });
    expect(parseReply({ answer: "ok", actions: "not a list" }).actions).toEqual([]);
  });
  it("rejects a reply without a string answer", () => {
    expect(() => parseReply({ heard: "x" })).toThrow("no answer");
    expect(() => parseReply({ answer: 42 })).toThrow("no answer");
  });
  it("rejects a null or primitive body with a readable error instead of a TypeError", () => {
    // Regression: `null` from response.json() used to surface "Cannot read properties of null".
    expect(() => parseReply(null)).toThrow("assistant response has no answer");
    expect(() => parseReply("hello")).toThrow("assistant response has no answer");
  });
});

describe("glasses text wrapping", () => {
  it("wraps readable lines", () => { expect(wrap("eins zwei drei vier", 9)).toEqual(["eins zwei", "drei vier"]); });
  it("collapses runs of whitespace and newlines", () => { expect(wrap("  a \n\n b\tc  ", 10)).toEqual(["a b c"]); });
  it("returns no lines for empty or blank text", () => { expect(wrap("")).toEqual([]); expect(wrap("   ")).toEqual([]); });
  it("keeps a word that exactly fills the width on one line", () => { expect(wrap("abcde fg", 5)).toEqual(["abcde", "fg"]); });
  it("hard-splits a word longer than the display width", () => {
    // Regression: a long URL used to come back as one 80-character line and run off the lens.
    const url = "https://example.com/" + "x".repeat(60);
    const lines = wrap(`see ${url}`, 20);
    expect(lines.every((line) => line.length <= 20)).toBe(true);
    expect(lines.join("")).toBe(`see${url}`);
  });
  it("never produces a line wider than the requested width", () => {
    const text = "Der Wetterbericht für morgen: Donaudampfschifffahrtsgesellschaftskapitän sagt 12 °C und Regen.";
    for (const width of [5, 12, 30, 54]) expect(wrap(text, width).every((line) => line.length <= width)).toBe(true);
  });
  it("leaves short text untouched in fitLines", () => { expect(fitLines("kurz", 54, 6)).toEqual(["kurz"]); });
  it("marks text cut off by the line limit with an ellipsis", () => {
    // Regression: the answer was silently sliced to 6 lines with no hint that more existed.
    const lines = fitLines("one two three four five six", 9, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith("…")).toBe(true);
    expect(lines.every((line) => line.length <= 9)).toBe(true);
  });
  it("returns nothing when no lines are allowed", () => { expect(fitLines("a b c", 1, 0)).toEqual([]); });
});

describe("asking the assistant bridge", () => {
  afterEach(() => { vi.useRealTimers(); });
  const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  type Call = [string, RequestInit];

  it("posts raw PCM with format and language headers", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ok({ answer: "Hi" }));
    const reply = await askAssistant("http://bridge/ask", new Uint8Array([1, 2, 3]), { locale: "fr", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(reply.answer).toBe("Hi");
    const [url, init] = fetchImpl.mock.calls[0] as Call;
    expect(url).toBe("http://bridge/ask");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-language"]).toBe("fr");
    expect([...new Uint8Array(init.body as ArrayBuffer)]).toEqual([1, 2, 3]);
  });

  it("sends only the recording even when the PCM is a view into a larger buffer", async () => {
    const backing = new Uint8Array([9, 9, 1, 2, 9]);
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ok({ answer: "x" }));
    await askAssistant("http://b", backing.subarray(2, 4), { locale: "en", fetchImpl: fetchImpl as unknown as typeof fetch });
    const init = (fetchImpl.mock.calls[0] as Call)[1];
    expect([...new Uint8Array(init.body as ArrayBuffer)]).toEqual([1, 2]);
  });

  it("reports HTTP errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));
    await expect(askAssistant("http://b", new Uint8Array(), { locale: "en", fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow("HTTP 503");
  });

  it("gives up on a bridge that never answers", async () => {
    // Regression: without a timeout a hung bridge left the app in "BUSY" forever and blocked every new recording.
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = askAssistant("http://b", new Uint8Array([1]), { locale: "en", timeoutMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch });
    const assertion = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
});

describe("recording length", () => {
  const bytesFor = (ms: number): number => Math.round(ms / 1000 * PCM_BYTES_PER_SECOND);
  it("converts 16 kHz 16-bit mono bytes to milliseconds", () => { expect(recordingMs(32000)).toBe(1000); expect(recordingMs(-5)).toBe(0); });
  it("treats empty and sub-minimum recordings as too short", () => {
    expect(isTooShort(new Uint8Array(0))).toBe(true);
    expect(isTooShort(new Uint8Array(bytesFor(MIN_RECORDING_MS) - 2))).toBe(true);
    expect(isTooShort(new Uint8Array(bytesFor(MIN_RECORDING_MS)))).toBe(false);
  });
  it("flags a recording that reached the maximum", () => {
    expect(isTooLong(bytesFor(MAX_RECORDING_MS) - 2)).toBe(false);
    expect(isTooLong(bytesFor(MAX_RECORDING_MS))).toBe(true);
  });
});

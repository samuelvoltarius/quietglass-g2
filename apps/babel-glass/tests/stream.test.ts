import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSseParser, parseEventData, readChunk, streamChat, visibleText,
} from "../src/llm/stream";
import { partialJsonString } from "../src/llm/partial-json";
import { cleanPartialOutput, createOpenAiTranslator, translationMaxTokens } from "../src/translate/provider";
import {
  createCompanionLlm, partialInsight, partialSummary, SUMMARY_MAX_TOKENS,
} from "../src/companion/llm";
import { createInsightWatcher } from "../src/companion/insights";
import { createThrottle } from "../src/glasses/throttle";
import { buildView, summaryPageCount, summaryRows, type ViewOptions } from "../src/glasses/view";
import { applyTranscript, applyTranslation, createBuffer, dropTranslation } from "../src/captions/buffer";
import type { TranscriptEntry } from "../src/companion/transcript";

const encoder = new TextEncoder();

/** A streamed response delivered in exactly these pieces. */
function sseResponse(pieces: readonly string[], type = "text/event-stream"): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": type } });
}

/** A stream that breaks after these pieces. */
function brokenResponse(pieces: readonly string[]): Response {
  let i = 0;
  // Pieces are handed out one per read; the read after the last one fails.
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const piece = pieces[i++];
      if (piece === undefined) controller.error(new TypeError("network connection was lost"));
      else controller.enqueue(encoder.encode(piece));
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const delta = (content: string, extra: Record<string, unknown> = {}): string =>
  "data: " + JSON.stringify({ choices: [{ index: 0, delta: { content, ...extra }, finish_reason: null }] }) + "\n\n";
const finish = "data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\n";
const done = "data: [DONE]\n\n";
const jsonReply = (content: string): Response =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });

const timing = { firstTokenMs: 5000, idleMs: 5000, totalMs: 20_000 };

describe("SSE parser", () => {
  it("joins events split anywhere, also inside \\r\\n", () => {
    const seen: string[] = [];
    const parser = createSseParser((data) => seen.push(data));
    const stream = ": keep-alive\r\ndata: {\"a\":1}\r\n\r\ndata: x\ndata: y\n\nevent: ping\ndata: [DONE]\r\n\r\n";
    for (const ch of stream) parser.push(ch);
    parser.end();
    expect(seen).toEqual(['{"a":1}', "x\ny", "[DONE]"]);
  });

  it("dispatches a last event without a trailing blank line", () => {
    const seen: string[] = [];
    const parser = createSseParser((data) => seen.push(data));
    parser.push("data: last");
    parser.end();
    expect(seen).toEqual(["last"]);
  });

  it("reads several JSON lines in one event and skips broken ones", () => {
    expect(parseEventData('{"a":1}\n{"b":2}\n{broken')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(parseEventData("[DONE]")).toEqual([]);
  });
});

describe("chunk contents", () => {
  it("takes only content, never reasoning", () => {
    expect(readChunk({ choices: [{ delta: { reasoning_content: "hmm", content: null } }] }).delta).toBe("");
    expect(readChunk({ choices: [{ delta: { reasoning: "hmm" } }] }).delta).toBe("");
    expect(readChunk({ choices: [{ delta: { content: "Hi" }, finish_reason: null }] })).toEqual({ delta: "Hi", error: null, finished: false });
    expect(readChunk({ choices: [{ delta: {}, finish_reason: "stop" }] }).finished).toBe(true);
    expect(readChunk({ error: { message: "model overloaded" } }).error).toBe("model overloaded");
  });

  it("hides thinking while it streams", () => {
    expect(visibleText("<think>plan")).toBe("");
    expect(visibleText("<think>plan</think>Hallo")).toBe("Hallo");
    expect(visibleText("plan</think>Hallo")).toBe("Hallo");
    expect(visibleText("Hallo <thi")).toBe("Hallo ");
    expect(visibleText("a < b")).toBe("a < b");
  });
});

describe("partial JSON strings", () => {
  it("reads a field while it is being written", () => {
    expect(partialJsonString('{"kurz":"Termin Dien', "kurz")).toEqual({ value: "Termin Dien", complete: false });
    expect(partialJsonString('{"kurz":"a\\nb\\"c","lang":"x', "kurz")).toEqual({ value: "a\nb\"c", complete: true });
    expect(partialJsonString('{"kurz":"Gr\\u00fc', "kurz")).toEqual({ value: "Grü", complete: false });
    expect(partialJsonString('{"kurz":"x\\', "kurz")).toEqual({ value: "x", complete: false });
    expect(partialJsonString('{"kurz":"x\\u00', "kurz")).toEqual({ value: "x", complete: false });
    expect(partialJsonString('{"ku', "kurz")).toBeNull();
  });
});

describe("streamed chat call", () => {
  it("streams text as it arrives and returns the whole answer", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseResponse([delta("Gu"), delta("ten ").slice(0, 10), delta("ten ").slice(10), delta("Tag", { reasoning_content: "x" }), finish, done]);
    });
    const seen: string[] = [];
    const result = await streamChat({
      endpoint: "https://x/v1/chat/completions", body: { model: "m" }, fetchImpl: fetchImpl as never,
      onText: (text) => seen.push(text), ...timing,
    });
    expect(result).toEqual({ ok: true, text: "Guten Tag", streamed: true });
    expect(seen).toEqual(["Gu", "Guten ", "Guten Tag"]);
    expect(bodies[0]?.["stream"]).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reads a plain JSON answer (proxy without streaming) without a second request", async () => {
    const fetchImpl = vi.fn(async () => jsonReply("Hallo"));
    const seen: string[] = [];
    const result = await streamChat({ endpoint: "e", body: {}, fetchImpl: fetchImpl as never, onText: (t) => seen.push(t), ...timing });
    expect(result).toEqual({ ok: true, text: "Hallo", streamed: false });
    expect(seen).toEqual(["Hallo"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to an ordinary request when the stream breaks before the first token", async () => {
    const streams: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      streams.push(body["stream"]);
      return body["stream"] ? brokenResponse([": hello\n\n"]) : jsonReply("Hallo");
    });
    const result = await streamChat({ endpoint: "e", body: {}, fetchImpl: fetchImpl as never, ...timing });
    expect(result).toEqual({ ok: true, text: "Hallo", streamed: false });
    expect(streams).toEqual([true, false]);
  });

  it("falls back when the stream reports an error before any text", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      (JSON.parse(String(init?.body)) as { stream: boolean }).stream
        ? sseResponse(['data: {"error":{"message":"bad"}}\n\n', done])
        : jsonReply("ok"));
    expect(await streamChat({ endpoint: "e", body: {}, fetchImpl: fetchImpl as never, ...timing })).toMatchObject({ ok: true, text: "ok" });
  });

  it("falls back when the server refuses stream, not on other errors", async () => {
    const refusing = vi.fn(async (_url: string, init?: RequestInit) =>
      (JSON.parse(String(init?.body)) as { stream: boolean }).stream ? new Response("no", { status: 400 }) : jsonReply("ok"));
    expect(await streamChat({ endpoint: "e", body: {}, fetchImpl: refusing as never, ...timing })).toMatchObject({ ok: true, text: "ok" });
    const broken = vi.fn(async () => new Response("down", { status: 502 }));
    expect(await streamChat({ endpoint: "e", body: {}, fetchImpl: broken as never, ...timing })).toEqual({ ok: false, error: "HTTP 502" });
    expect(broken).toHaveBeenCalledTimes(1);
  });

  it("reports a stream that breaks after text instead of retrying", async () => {
    const fetchImpl = vi.fn(async () => brokenResponse([delta("Hal")]));
    expect(await streamChat({ endpoint: "e", body: {}, fetchImpl: fetchImpl as never, ...timing })).toEqual({ ok: false, error: "interrupted" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("accepts a stream that ends cleanly without [DONE]", async () => {
    const fetchImpl = vi.fn(async () => sseResponse([delta("A"), delta("B")]));
    expect(await streamChat({ endpoint: "e", body: {}, fetchImpl: fetchImpl as never, ...timing })).toEqual({ ok: true, text: "AB", streamed: true });
  });

  it("times out when the first token never comes", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_r, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }));
      const pending = streamChat({ endpoint: "e", body: {}, fetchImpl: fetchImpl as never, firstTokenMs: 1000, idleMs: 1000, totalMs: 5000 });
      await vi.advanceTimersByTimeAsync(1001);
      expect(await pending).toEqual({ ok: false, error: "timed out" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("streamed translation", () => {
  it("replaces the translation step by step and ends with the clean text", async () => {
    const fetchImpl = vi.fn(async () => sseResponse([delta("<think>\n\n</think>\n\n"), delta("„Guten"), delta(" Tag“"), done]));
    const partials: string[] = [];
    const result = await createOpenAiTranslator({ url: "https://x/v1", model: "m", fetchImpl: fetchImpl as never })
      .translate({ text: "Добры дзень", from: "be", to: "de" }, (p) => partials.push(p));
    expect(partials).toEqual(["Guten", "Guten Tag"]);
    expect(result).toEqual({ text: "Guten Tag", error: null });
  });

  it("does not show a preamble being typed and sizes the output budget", () => {
    expect(cleanPartialOutput("Here is the transl")).toBe("");
    expect(cleanPartialOutput("Hallo")).toBe("Hallo");
    expect(translationMaxTokens("kurz")).toBe(256);
    expect(translationMaxTokens("x".repeat(600))).toBe(1264);
    expect(translationMaxTokens("x".repeat(5000))).toBe(2048);
  });

  it("puts a partial translation on its line and takes it away again", () => {
    let buffer = applyTranscript(createBuffer(), { text: "Привет", final: true }, 0);
    buffer = applyTranslation(buffer, "Привет", "Hal");
    expect(buffer.lines[0]?.translated).toBe("Hal");
    buffer = dropTranslation(buffer, "Привет");
    expect(buffer.lines[0]?.translated).toBeUndefined();
  });
});

const entry = (text: string, speaker?: string): TranscriptEntry => ({ text, at: 0, ...(speaker ? { speaker } : {}) });

describe("streamed companion", () => {
  it("lets the summary grow and asks for a long enough answer", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseResponse([delta('{"kurz":"Termin'), delta(' Dienstag\\nKosten"'), delta(',"lang":"- Thema: WP\\n- Ter'), delta('min: Di"}'), done]);
    });
    const llm = createCompanionLlm({ url: "https://x/v1", model: "q", fetchImpl: fetchImpl as never });
    const progress: string[][] = [];
    const result = await llm.summarize([entry("Hallo", "A"), entry("Servus", "B")], "de", (p) => progress.push([...p.short, "|", ...p.long]));
    expect(result).toEqual({ ok: true, value: { short: ["Termin Dienstag", "Kosten"], long: ["Thema: WP", "Termin: Di"] } });
    expect(progress[0]).toEqual(["Termin", "|"]);
    expect(progress.at(-1)).toEqual(["Termin Dienstag", "Kosten", "|", "Thema: WP", "Termin: Di"]);
    expect(bodies[0]?.["max_tokens"]).toBe(SUMMARY_MAX_TOKENS);
    expect(bodies[0]?.["stream"]).toBe(true);
    expect(bodies[0]?.["chat_template_kwargs"]).toEqual({ enable_thinking: false });
  });

  it("sends long transcripts far beyond the old 12k characters", async () => {
    let sent = "";
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      sent = String((JSON.parse(String(init?.body)) as { messages: { content: string }[] }).messages[1]?.content);
      return jsonReply('{"kurz":"a","lang":"- b"}');
    });
    const log = Array.from({ length: 600 }, (_, i) => entry("Satz Nummer " + i + " mit etwas Inhalt dazu.", "A"));
    await createCompanionLlm({ url: "https://x/v1", model: "q", fetchImpl: fetchImpl as never }).summarize(log, "de");
    expect(sent.length).toBeGreaterThan(20_000);
    expect(sent.startsWith("[…]")).toBe(false);
  });

  it("reads partial summaries and explanations", () => {
    expect(partialSummary("{")).toBeNull();
    expect(partialSummary('<think>x</think>```json\n{"kurz":"a\\nb')).toEqual({ short: ["a", "b"], long: [] });
    expect(partialSummary("- eins\n- zw")).toEqual({ short: ["eins", "zw"], long: ["eins", "zw"] });
    expect(partialInsight('{"begriff":"JA')).toBeNull();
    expect(partialInsight('{"begriff":"JAZ","info":"Jahres')).toEqual({ term: "JAZ", info: "Jahres" });
    expect(partialInsight('{"keine":true}')).toBeNull();
  });

  it("shows an explanation while it is written and withdraws one that never finishes", async () => {
    vi.useFakeTimers();
    try {
      const partials: string[] = [];
      let dropped = 0;
      const watcher = createInsightWatcher({
        llm: () => ({
          name: "fake",
          summarize: async () => ({ ok: false, error: "x" }),
          explain: async (_recent, _known, _locale, onProgress) => {
            onProgress?.({ term: "JAZ", info: "Jahres" });
            return { ok: false, error: "interrupted" };
          },
        }),
        locale: () => "de",
        onInsight: () => undefined,
        onPartial: (i) => partials.push(i.info),
        onPartialDropped: () => { dropped++; },
        debounceMs: 10,
      });
      watcher.onFinal([entry("Was ist JAZ?")]);
      await vi.advanceTimersByTimeAsync(20);
      expect(partials).toEqual(["Jahres"]);
      expect(dropped).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("redraw throttle", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("draws at once, then at most every 300 ms, never losing the last request", async () => {
    vi.useFakeTimers();
    let runs = 0;
    const throttle = createThrottle(() => { runs++; }, 300);
    throttle.request();
    expect(runs).toBe(1);
    throttle.request();
    throttle.request();
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(299);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(2);
    throttle.request();
    throttle.cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(2);
  });
});

const base: ViewOptions = { mode: "conversation", listening: false, status: "idle", translating: false, offset: 0, mock: false, locale: "de" };

describe("summary pages on the glasses", () => {
  const long = Array.from({ length: 12 }, (_, i) => "Punkt " + (i + 1) + ": " + "Inhalt ".repeat(6).trim());

  it("pages a long summary instead of cutting it", () => {
    const rows = summaryRows(["Kurz eins", "Kurz zwei"], long);
    const pages = summaryPageCount(["Kurz eins", "Kurz zwei"], long);
    expect(pages).toBe(Math.ceil(rows.length / 7));
    const seen: string[] = [];
    for (let page = 0; page < pages; page++) {
      const view = buildView(createBuffer(), { ...base, summary: { state: "done", short: ["Kurz eins", "Kurz zwei"], long }, summaryPage: page });
      expect(view.body.length).toBeLessThanOrEqual(7);
      expect(view.header).toBe(`BABEL · Zusammenfassung · ${page + 1}/${pages}`);
      expect(view.footer).toBe("Tippen = weiter · Wischen = Seite · 2× = Ende");
      seen.push(...view.body);
    }
    expect(seen).toEqual(rows);
    expect(seen.join(" ")).toContain("Punkt 12");
  });

  it("shows the newest rows while the summary is being written", () => {
    const view = buildView(createBuffer(), { ...base, summary: { state: "working", short: ["Kurz"], long } });
    expect(view.body.length).toBe(7);
    expect(view.body.join(" ")).toContain("Punkt 12");
    expect(buildView(createBuffer(), { ...base, summary: { state: "working" } }).body[0]).toContain("Fasse");
  });

  it("gives a long explanation the whole body", () => {
    const buffer = applyTranscript(createBuffer(), { text: "Was ist JAZ?", final: true }, 0);
    const info = "Die Jahresarbeitszahl gibt an, wie viel Wärme eine Wärmepumpe im Jahr pro eingesetzter Kilowattstunde Strom liefert; Werte über vier gelten als gut und sparsam, darunter lohnt ein Blick auf die Anlage.";
    const view = buildView(buffer, { ...base, listening: true, status: "ready", popup: { term: "JAZ", info } });
    expect(view.body.length).toBeLessThanOrEqual(7);
    expect(view.body.join(" ")).toContain("Blick auf die Anlage.");
  });
});

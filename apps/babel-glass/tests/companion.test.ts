import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendEntry, attachTranslation, speakerLine, speakersIn, transcriptForLlm, type TranscriptEntry,
} from "../src/companion/transcript";
import {
  createCompanionLlm, createMockCompanion, extractJson, parseInsight, parseSummary, summaryPrompt, explainPrompt,
} from "../src/companion/llm";
import { createInsightWatcher } from "../src/companion/insights";
import { createWebSocketStt, parseTranscript } from "../src/stt/provider";
import { applyTranscript, createBuffer } from "../src/captions/buffer";
import { buildView, PENDING_MARK, type ViewOptions } from "../src/glasses/view";
import { iconFrame, iconKey, rasterize, ICON_WIDTH, ICON_HEIGHT } from "../src/glasses/icon";
import { conversationInner } from "../src/ui/phone";
import { parseData, EMPTY_DATA, withBuildDefaults } from "../src/storage/persist";

const entry = (text: string, speaker?: string): TranscriptEntry => ({ text, at: 0, ...(speaker ? { speaker } : {}) });

describe("transcript", () => {
  it("appends trimmed lines and skips empty ones", () => {
    let log = appendEntry([], entry("  Hallo  ", "A"));
    log = appendEntry(log, entry("   "));
    expect(log).toEqual([{ text: "Hallo", at: 0, speaker: "A" }]);
  });

  it("caps the transcript", () => {
    let log: TranscriptEntry[] = [];
    for (let i = 0; i < 10; i++) log = appendEntry(log, entry("l" + i), 3);
    expect(log.map((e) => e.text)).toEqual(["l7", "l8", "l9"]);
  });

  it("attaches a translation to the newest matching line", () => {
    const log = attachTranslation([entry("Hi"), entry("Hi")], "Hi", "Hallo");
    expect(log[0]?.translated).toBeUndefined();
    expect(log[1]?.translated).toBe("Hallo");
  });

  it("formats speakers and keeps the newest text when cutting for the model", () => {
    expect(speakerLine(entry("Ja", "B"))).toBe("B: Ja");
    const log = [entry("alt alt alt", "A"), entry("neu", "B")];
    expect(transcriptForLlm(log, 8)).toBe("[…]\nB: neu");
    expect(transcriptForLlm(log)).toBe("A: alt alt alt\nB: neu");
    expect(speakersIn([entry("x", "B"), entry("y", "A"), entry("z", "B")])).toEqual(["B", "A"]);
  });
});

describe("language model replies", () => {
  it("reads JSON even inside fences or after a think block", () => {
    expect(extractJson("<think>hm {x}</think>```json\n{\"keine\":true}\n```")).toEqual({ keine: true });
    expect(extractJson("no json")).toBeNull();
  });

  it("parses a summary into short and long lines", () => {
    const s = parseSummary('{"kurz":"Termin Dienstag\\nKosten 15k","lang":"- Thema: Wärmepumpe\\n- Termin: Dienstag"}');
    expect(s).toEqual({ short: ["Termin Dienstag", "Kosten 15k"], long: ["Thema: Wärmepumpe", "Termin: Dienstag"] });
  });

  it("falls back to plain text when the model ignores JSON", () => {
    expect(parseSummary("- eins\n- zwei\n- drei\n- vier")).toEqual({ short: ["eins", "zwei", "drei"], long: ["eins", "zwei", "drei", "vier"] });
  });

  it("parses an explanation or nothing", () => {
    expect(parseInsight('{"begriff":"JAZ","info":"Jahresarbeitszahl"}')).toEqual({ term: "JAZ", info: "Jahresarbeitszahl" });
    expect(parseInsight('{"keine":true}')).toBeNull();
    expect(parseInsight('{"begriff":"JAZ"}')).toBeNull();
  });

  it("asks in the UI language and lists terms already explained", () => {
    expect(summaryPrompt("de")).toContain("Deutsch");
    expect(summaryPrompt("en")).toContain("English");
    expect(explainPrompt("de", ["JAZ"])).toContain("JAZ");
  });

  it("calls an OpenAI-compatible server without thinking and returns the summary", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"kurz":"a","lang":"- b"}' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const llm = createCompanionLlm({ url: "https://llm.example/v1", model: "qwen", fetchImpl });
    const result = await llm.summarize([entry("Hallo", "A")], "de");
    expect(result).toEqual({ ok: true, value: { short: ["a"], long: ["b"] } });
    expect(bodies[0]?.["chat_template_kwargs"]).toEqual({ enable_thinking: false });
    expect(JSON.stringify(bodies[0]?.["messages"])).toContain("A: Hallo");
  });

  it("reports HTTP errors instead of throwing", async () => {
    const fetchImpl = (async () => new Response("no", { status: 502 })) as unknown as typeof fetch;
    const llm = createCompanionLlm({ url: "https://llm.example/v1", model: "qwen", fetchImpl });
    expect(await llm.explain([entry("x")], [], "de")).toEqual({ ok: false, error: "HTTP 502" });
  });

  it("demo companion explains the demo term once", async () => {
    const mock = createMockCompanion();
    const first = await mock.explain([entry("Was bedeutet JAZ?")], [], "de");
    expect(first.ok && first.value?.term).toBe("JAZ");
    const again = await mock.explain([entry("Was bedeutet JAZ?")], ["JAZ"], "de");
    expect(again).toEqual({ ok: true, value: null });
  });
});

describe("insight watcher", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("debounces, keeps a gap and shows each term once", async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const shown: string[] = [];
    const watcher = createInsightWatcher({
      llm: () => ({
        name: "fake",
        summarize: async () => ({ ok: false, error: "x" }),
        explain: async (recent) => { calls.push(recent.length); return { ok: true, value: { term: "JAZ", info: "…" } }; },
      }),
      locale: () => "de",
      onInsight: (i) => shown.push(i.term),
      debounceMs: 100,
      minGapMs: 1000,
      now: () => Date.now(),
    });
    watcher.onFinal([entry("a")]);
    watcher.onFinal([entry("a"), entry("b")]);
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toEqual([2]);
    expect(shown).toEqual(["JAZ"]);
    watcher.onFinal([entry("a"), entry("b"), entry("c")]);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toEqual([2]); // within the minimum gap
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([2, 3]);
    expect(shown).toEqual(["JAZ"]); // same term is not shown twice
    expect(watcher.known).toEqual(["JAZ"]);
  });

  it("does nothing without a language model", async () => {
    vi.useFakeTimers();
    const shown: string[] = [];
    const watcher = createInsightWatcher({ llm: () => null, locale: () => "de", onInsight: (i) => shown.push(i.term), debounceMs: 10 });
    watcher.onFinal([entry("a")]);
    await vi.advanceTimersByTimeAsync(100);
    expect(shown).toEqual([]);
  });
});

describe("streaming recogniser", () => {
  it("parses partial lines with their stable part and finals with a speaker", () => {
    expect(parseTranscript('{"type":"partial","text":"Guten Tag ich","stable":"Guten Tag","final":false}'))
      .toEqual({ text: "Guten Tag ich", final: false, stable: "Guten Tag" });
    expect(parseTranscript('{"type":"final","text":"Guten Tag.","final":true,"language":"de","speaker":"B"}'))
      .toEqual({ text: "Guten Tag.", final: true, language: "de", speaker: "B" });
    // Old servers: no speaker, nothing breaks.
    expect(parseTranscript('{"text":"Hallo","final":true}')).toEqual({ text: "Hallo", final: true });
    // Only single capital letters count as speaker labels.
    expect(parseTranscript('{"text":"x","final":true,"speaker":"<b>"}')).toEqual({ text: "x", final: true });
  });

  it("asks for streaming in the start frame and sends stop before closing", async () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    class FakeSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() { setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 1); }
      send(data: unknown): void { sent.push(data); }
      close(): void { this.readyState = 3; this.onclose?.(); }
    }
    const stt = createWebSocketStt({
      url: "wss://x", language: "de", stream: true, onTranscript: () => undefined,
      WS: FakeSocket as unknown as typeof WebSocket,
    });
    const started = stt.start();
    await vi.advanceTimersByTimeAsync(5);
    await started;
    expect(JSON.parse(String(sent[0]))).toMatchObject({ type: "start", stream: true, language: "de" });
    const stopping = stt.stop();
    await vi.advanceTimersByTimeAsync(1000);
    await stopping;
    expect(JSON.parse(String(sent[1]))).toEqual({ type: "stop" });
    vi.useRealTimers();
  });
});

const base: ViewOptions = {
  mode: "conversation", listening: true, status: "ready", translating: false, offset: 0, mock: false, locale: "de",
};

describe("glasses view (companion)", () => {
  it("prefixes speakers and marks the provisional line", () => {
    let buffer = applyTranscript(createBuffer(), { text: "Guten Morgen", final: true, speaker: "A" }, 0);
    buffer = applyTranscript(buffer, { text: "Mir geht", final: false }, 0);
    const view = buildView(buffer, { ...base, speakers: true });
    expect(view.body).toEqual(["A: Guten Morgen", PENDING_MARK + "Mir geht"]);
    expect(buildView(buffer, { ...base, speakers: false }).body[0]).toBe("Guten Morgen");
  });

  it("1.0.0: the header holds the mode and the state, nothing else (no helper list, no clock)", () => {
    const now = new Date(2026, 9, 13, 14, 5).getTime();
    expect(buildView(createBuffer(), { ...base, now }).header).toBe("BABEL · ● live");
    expect(buildView(createBuffer(), { ...base, now, modeLabel: "Übersetzen" }).header).toBe("Übersetzen · ● live");
    expect(buildView(createBuffer(), { ...base, now, modeLabel: "Englisch sprechen", mock: true }).header).toBe("Englisch sprechen · ● live · DEMO");
  });

  it("puts an explanation above the newest captions", () => {
    const buffer = applyTranscript(createBuffer(), { text: "Was ist JAZ?", final: true, speaker: "A" }, 0);
    const view = buildView(buffer, { ...base, speakers: true, popup: { term: "JAZ", info: "Jahresarbeitszahl einer Wärmepumpe." } });
    expect(view.header.startsWith("BABEL · ● live")).toBe(true);
    expect(view.body[0]).toBe("Info: JAZ");
    expect(view.body).toContain("A: Was ist JAZ?");
    expect(view.body.length).toBeLessThanOrEqual(7);
    expect(view.footer).toBe("Tippen: schließen");
  });

  it("shows the short summary after stopping", () => {
    const view = buildView(createBuffer(), { ...base, listening: false, summary: { state: "done", short: ["Termin Dienstag", "Kosten 15k"] } });
    expect(view.header).toBe("BABEL · Zusammenfassung");
    expect(view.body).toEqual(["· Termin Dienstag", "· Kosten 15k", "", "Ausführlich auf dem Handy."]);
    expect(buildView(createBuffer(), { ...base, listening: false, summary: { state: "working" } }).body[0]).toContain("Fasse");
    expect(buildView(createBuffer(), { ...base, listening: false, summary: { state: "error", error: "timed out" } }).body.join(" ")).toContain("keine Antwort");
  });
});

describe("header sign", () => {
  it("animates the ear while listening and fits 64 x 30", () => {
    const a = iconFrame("listening", 0);
    const b = iconFrame("listening", 500);
    expect(iconKey(a)).not.toBe(iconKey(b));
    for (const kind of ["listening", "thinking", "info", "done", "off", "idle"] as const) {
      const frame = iconFrame(kind, 1000);
      expect(frame.length, kind).toBe(9);
      for (const row of frame) expect(row.length, kind).toBe(18);
      const pixels = rasterize(frame);
      expect(pixels.length).toBe(ICON_WIDTH * ICON_HEIGHT);
      expect(pixels.some((p) => p > 0), kind).toBe(true);
    }
    expect(iconKey(iconFrame("off", 0))).toBe(iconKey(iconFrame("off", 9999)));
  });
});

describe("phone conversation card", () => {
  it("lists lines with speakers, the provisional line, summary and explanations", () => {
    const html = conversationInner({
      log: [{ text: "Hallo <b>", at: 0, speaker: "A" }],
      pending: "Mir geht",
      summary: { state: "done", long: ["Thema: Test"] },
      insights: [{ term: "JAZ", info: "Jahresarbeitszahl" }],
      canSummarize: true,
    }, "de");
    expect(html).toContain("spk-0");
    expect(html).toContain("Hallo &lt;b&gt;");
    expect(html).toContain("vorläufig");
    expect(html).toContain("Thema: Test");
    expect(html).toContain("JAZ");
    expect(html).toContain('id="summarize"');
  });
});

describe("settings", () => {
  it("turns the companion on for old settings and keeps an explicit off", () => {
    expect(parseData(JSON.stringify({ mode: "lecture" }))).toMatchObject({ speakers: true, insights: true, autoSummary: true });
    expect(parseData(JSON.stringify({ insights: false })).insights).toBe(false);
  });

  it("gives the companion the build's language model even when LibreTranslate translates", () => {
    const data = withBuildDefaults({ ...EMPTY_DATA, translateUrl: "https://libre.example" }, { llm: "https://llm.example/v1", model: "qwen" });
    expect(data.translateProvider).toBe("libretranslate");
    expect(data.llmUrl).toBe("https://llm.example/v1");
    expect(data.llmModel).toBe("qwen");
  });
});

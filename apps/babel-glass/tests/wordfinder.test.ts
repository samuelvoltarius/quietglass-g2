import { describe, expect, it } from "vitest";
import {
  conversationLanguage, findWord, parseWords, resolveSpeaker, wordContext, wordFinderPrompt, wordPopupLines,
  WORD_LINE_CHARS, WORD_MAX_TOKENS,
} from "../src/companion/wordfinder";
import type { TranscriptEntry } from "../src/companion/transcript";
import { buildView, GLASS_COLS, type ViewOptions } from "../src/glasses/view";
import { applyTranscript, createBuffer } from "../src/captions/buffer";

const at = (text: string, ms: number, speaker?: string, language?: string): TranscriptEntry =>
  ({ text, at: ms, ...(speaker ? { speaker } : {}), ...(language ? { language } : {}) });

const jsonReply = (content: string): Response =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });

describe("Wortfinder prompt", () => {
  it("asks exactly for the word and 2–3 alternatives, separated by ' · '", () => {
    const prompt = wordFinderPrompt("de");
    expect(prompt).toContain("Der Sprecher sucht ein Wort. Gib das wahrscheinlich gesuchte Wort und 2–3 Ausweichwörter, nur die Wörter, durch ' · ' getrennt.");
    expect(prompt).not.toContain("zweiten Zeile");
  });

  it("adds the target language as a second line only when it differs", () => {
    expect(wordFinderPrompt("de", "en")).toContain("zweiten Zeile nur das erste Wort auf English");
    expect(wordFinderPrompt("de", "de")).not.toContain("zweiten Zeile");
    expect(wordFinderPrompt("en")).toContain("only the words, separated by ' · '");
  });
});

describe("Wortfinder answer", () => {
  it("reads the words, the likely one first", () => {
    expect(parseWords("Kostenvoranschlag · Angebot · Offerte")).toEqual({ words: ["Kostenvoranschlag", "Angebot", "Offerte"] });
  });

  it("cleans numbering, quotes, think blocks and other separators", () => {
    expect(parseWords("<think>hm</think>1. „Angebot“, 2. Offerte; Kalkulation.")).toEqual({ words: ["Angebot", "Offerte", "Kalkulation"] });
    expect(parseWords("Angebot | angebot / Schätzung")).toEqual({ words: ["Angebot", "Schätzung"] });
  });

  it("keeps at most four words and drops sentences", () => {
    expect(parseWords("a1 · b2 · c3 · d4 · e5")?.words).toEqual(["a1", "b2", "c3", "d4"]);
    expect(parseWords("Ich weiß leider nicht, welches Wort gemeint ist")).toBeNull();
    expect(parseWords("-")).toBeNull();
    expect(parseWords("")).toBeNull();
  });

  it("reads the translation from the second line when asked for", () => {
    expect(parseWords("Angebot · Offerte\nquote", true)).toEqual({ words: ["Angebot", "Offerte"], translation: "quote" });
    expect(parseWords("Angebot · Offerte\nquote")).toEqual({ words: ["Angebot", "Offerte"] });
  });
});

describe("Wortfinder popup", () => {
  it("fits one line of 40 characters, words that do not fit are left out", () => {
    const lines = wordPopupLines({ words: ["Kostenvoranschlag", "Angebotsunterlagen", "Offerte", "Preis"] });
    expect(lines).toEqual(["Kostenvoranschlag · Angebotsunterlagen"]);
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(WORD_LINE_CHARS);
  });

  it("cuts a single over-long word and adds the translation as a second line", () => {
    const lines = wordPopupLines({ words: ["Donaudampfschifffahrtsgesellschaftskapitänsmütze"], translation: "captain's hat" });
    expect(lines).toHaveLength(2);
    expect(lines[0]!.endsWith("…")).toBe(true);
    expect(lines[1]).toBe("→ captain's hat");
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(WORD_LINE_CHARS);
  });

  it("shows on the glasses above the newest captions; the footer only says what a tap does", () => {
    const buffer = applyTranscript(createBuffer(), { text: "Ich brauche noch so ein, äh …", final: true }, 0);
    const base: ViewOptions = { mode: "conversation", listening: true, status: "ready", translating: false, offset: 0, mock: false, locale: "de" };
    const view = buildView(buffer, { ...base, popup: { term: "", info: "", kind: "word", lines: ["Angebot · Offerte"] } });
    expect(view.header).toContain("● live");
    expect(view.body[0]).toBe("Wort: Angebot · Offerte");
    expect(view.body.join("\n")).toContain("Ich brauche");
    expect(view.footer).toBe("Tippen: schließen");
    // No hold anywhere: it does not arrive on the real glasses.
    expect(buildView(buffer, base).footer).toBe("Tippen: Stopp · Wischen: zurück");
    expect([...buildView(buffer, base).footer].length).toBeLessThanOrEqual(GLASS_COLS);
  });
});

describe("Wortfinder context", () => {
  const log = [at("alt", 0, "A"), at("Guten Tag", 50_000, "B"), at("Ich hätte gern so ein", 60_000, "A"), at("Ja?", 65_000, "B")];

  it("finds the user's letter: setting, or the newest speaker", () => {
    expect(resolveSpeaker(log, "auto")).toBe("B");
    expect(resolveSpeaker(log, "A")).toBe("A");
    expect(resolveSpeaker([at("x", 0)], "auto")).toBeNull();
  });

  it("uses the last 20 s, the user's own lines first, and the provisional line last", () => {
    expect(wordContext(log, { now: 66_000, speaker: null })).toBe("B: Guten Tag\nA: Ich hätte gern so ein\nB: Ja?");
    expect(wordContext(log, { now: 66_000, speaker: "A", pending: "für die Heizung" })).toBe("A: Ich hätte gern so ein\nfür die Heizung …");
    // Nothing in the window: the last lines stand in.
    expect(wordContext(log, { now: 500_000, speaker: null }).split("\n")).toHaveLength(3);
  });

  it("knows the conversation language", () => {
    expect(conversationLanguage([], "auto")).toBe("de");
    expect(conversationLanguage([at("hi", 0, undefined, "en")], "auto")).toBe("en");
    expect(conversationLanguage([], "ru")).toBe("ru");
  });
});

describe("Wortfinder request", () => {
  it("asks fast: few tokens, low temperature, no thinking", async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonReply("Angebot · Offerte · Kalkulation\nquote");
    }) as unknown as typeof fetch;
    const result = await findWord({ url: "http://llm/v1", model: "qwen", fetchImpl }, { context: "A: so ein", language: "de", target: "en" });
    expect(result).toEqual({ ok: true, value: { words: ["Angebot", "Offerte", "Kalkulation"], translation: "quote" } });
    expect(sent["max_tokens"]).toBe(WORD_MAX_TOKENS);
    expect(sent["temperature"]).toBeLessThanOrEqual(0.2);
    expect(sent["chat_template_kwargs"]).toEqual({ enable_thinking: false });
  });

  it("gives up after the timeout", async () => {
    const fetchImpl = ((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;
    const result = await findWord({ url: "http://llm/v1", model: "qwen", fetchImpl, timeoutMs: 30 }, { context: "x", language: "de" });
    expect(result.ok).toBe(false);
  });

  it("reports an answer without a word as an error", async () => {
    const fetchImpl = (async () => jsonReply("Tut mir leid, das weiß ich wirklich nicht genau.")) as unknown as typeof fetch;
    expect((await findWord({ url: "http://llm/v1", model: "q", fetchImpl }, { context: "x", language: "de" })).ok).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  AUTO_AFTER_POPUP_MS, AUTO_MIN_GAP_MS, endsWithHesitation, findWord, hasGermanWord, isLearnerCase, parseWords,
  stuckReason, wordFinderPrompt, wordPopupLines, WORD_MAX_TOKENS, type StuckInput,
} from "../src/companion/wordfinder";
import { addVocab, parseVocab, removeVocab, vocabFromResult, VOCAB_CAP, type VocabEntry } from "../src/companion/vocab";
import type { TranscriptEntry } from "../src/companion/transcript";
import { EMPTY_DATA, parseData } from "../src/storage/persist";
import { wordsInner } from "../src/ui/phone";
import { t } from "../src/messages";

const NOW = 100_000;
const line = (text: string, speaker?: string): TranscriptEntry => ({ text, at: NOW - 5_000, ...(speaker ? { speaker } : {}) });

/** A quiet, idle state with the user (ME) having said `text` 3 s ago. */
const input = (over: Partial<StuckInput> = {}): StuckInput => ({
  now: NOW, log: [line("We could meet at the", "ME")], pending: null, lastTextAt: NOW - 3_000,
  speaker: "ME", language: "en", lastAutoAt: 0, lastText: null, busy: false, popupOpen: false, popupClosedAt: 0,
  ...over,
});

describe("automatic word finder: stuckReason", () => {
  it("(a) fires for an unfinished sentence after 2.5 s without new text", () => {
    expect(stuckReason(input())).toEqual({ reason: "unfinished", text: "We could meet at the" });
    expect(stuckReason(input({ lastTextAt: NOW - 2_400 }))).toBeNull();
  });

  it("(a) reads the provisional line, not only the final ones (no voice profile: the letter of the last final line decides)", () => {
    expect(stuckReason(input({ log: [line("Hello.", "A")], speaker: "A", pending: "I would like to order a" }))?.text).toBe("I would like to order a");
    // Speakers off: all speech is the user's.
    expect(stuckReason(input({ log: [line("Hello.")], speaker: null, pending: "I would like to order a" }))?.text).toBe("I would like to order a");
  });

  it("(a) a finished sentence is no trigger", () => {
    for (const text of ["That works for me.", "Does that work?", "Great!", "Well…", "He said \"yes.\""]) {
      expect(stuckReason(input({ log: [line(text, "ME")] })), text).toBeNull();
    }
  });

  it("(b) fires on a hesitation at the end after a short pause, even if the sentence looks finished", () => {
    for (const text of ["I think we should, ähm", "So the, uh...", "It is a, um", "Das ist, äh", "I need the, how do you say", "What's the word"]) {
      expect(stuckReason(input({ log: [line(text, "ME")], lastTextAt: NOW - 1_200 }))?.reason, text).toBe("hesitation");
    }
    expect(stuckReason(input({ log: [line("I need an erm", "ME")], lastTextAt: NOW - 500 }))).toBeNull();
    expect(endsWithHesitation("Hmm, hmm")).toBe(true);
    expect(endsWithHesitation("That is about umbrellas")).toBe(false);
  });

  it("(c) fires for a German word in an English line", () => {
    expect(stuckReason(input({ log: [line("The meeting is on Brötchen at ten", "ME")], lastTextAt: NOW - 1_200 }))?.reason).toBe("german");
    expect(stuckReason(input({ log: [line("We should do it und then go home.", "ME")], lastTextAt: NOW - 1_200 }))?.reason).toBe("german");
    expect(hasGermanWord("Ich weiß nicht")).toBe(false);
    expect(hasGermanWord("I think it is fine")).toBe(false);
  });

  it("(c) only in an English conversation", () => {
    expect(stuckReason(input({ language: "de", log: [line("The meeting is on Brötchen at ten.", "ME")], lastTextAt: NOW - 1_200 }))).toBeNull();
  });

  it("is silent for the other person's speech and speakers it cannot tie to the user", () => {
    expect(stuckReason(input({ log: [line("We could meet at the", "A")] }))).toBeNull();
    expect(stuckReason(input({ log: [line("Hello.", "A")], pending: "and then the" }))).toBeNull();
    expect(stuckReason(input({ log: [line("Fine.", "ME"), line("What about the", "A")] }))).toBeNull();
    // Speakers off (speaker null): everything is the user's.
    expect(stuckReason(input({ speaker: null, log: [line("We could meet at the")] }))?.reason).toBe("unfinished");
  });

  it("debounces: one lookup per 8 s, never while busy, never the same text twice, not right after a popup", () => {
    expect(stuckReason(input({ lastAutoAt: NOW - (AUTO_MIN_GAP_MS - 100) }))).toBeNull();
    expect(stuckReason(input({ lastAutoAt: NOW - AUTO_MIN_GAP_MS }))?.reason).toBe("unfinished");
    expect(stuckReason(input({ busy: true }))).toBeNull();
    expect(stuckReason(input({ popupOpen: true }))).toBeNull();
    expect(stuckReason(input({ lastText: "We could meet at the" }))).toBeNull();
    expect(stuckReason(input({ lastText: "  We could meet   at the " }))).toBeNull();
    expect(stuckReason(input({ lastText: "something else" }))?.reason).toBe("unfinished");
    expect(stuckReason(input({ popupClosedAt: NOW - (AUTO_AFTER_POPUP_MS - 100) }))).toBeNull();
    expect(stuckReason(input({ popupClosedAt: NOW - AUTO_AFTER_POPUP_MS }))?.reason).toBe("unfinished");
  });

  it("does nothing without text or before the recogniser delivered anything", () => {
    expect(stuckReason(input({ log: [] }))).toBeNull();
    expect(stuckReason(input({ lastTextAt: 0 }))).toBeNull();
  });
});

describe("learner prompt", () => {
  it("is chosen for an English conversation and for mostly English text", () => {
    expect(isLearnerCase("en", "A: anything")).toBe(true);
    expect(isLearnerCase("de", "I think that we should go to the market and buy it")).toBe(true);
    expect(isLearnerCase("de", "Ich glaube, wir sollten auf den Markt gehen")).toBe(false);
    expect(isLearnerCase("ru", "да")).toBe(false);
  });

  it("asks for the English word, English alternatives and the German meaning", () => {
    const prompt = wordFinderPrompt("en", "de", true);
    expect(prompt).toContain("German native speaker talking English");
    expect(prompt).toContain("2–3 English alternatives");
    expect(prompt).toContain("separated by ' · '");
    expect(prompt).toContain("first English word must be its translation");
    expect(prompt).toContain("German meaning of the first word");
    expect(wordFinderPrompt("en")).not.toContain("German meaning");
  });

  it("findWord sends it with the usual cheap settings and flags the answer", async () => {
    let body: { messages: { role: string; content: string }[]; temperature: number; max_tokens: number; chat_template_kwargs: unknown } | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "screwdriver · wrench · tool\nSchraubenzieher" } }] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const result = await findWord(
      { url: "https://llm.example/v1", model: "m", fetchImpl },
      { context: "ME: I need the Schraubenzieher …", language: "en" },
    );
    expect(body?.messages[0]?.content).toContain("German native speaker talking English");
    expect(body?.temperature).toBe(0.1);
    expect(body?.max_tokens).toBe(WORD_MAX_TOKENS);
    expect(body?.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(result).toEqual({ ok: true, value: { words: ["screwdriver", "wrench", "tool"], translation: "Schraubenzieher", learner: true } });
  });

  it("shows the German meaning on the second popup line, labelled", () => {
    const parsed = parseWords("screwdriver · wrench\nSchraubenzieher", true)!;
    expect(wordPopupLines(parsed)).toEqual(["screwdriver · wrench", "→ Schraubenzieher"]);
    expect(wordPopupLines(parsed, undefined, t("de", "g.wordMeaning"))).toEqual(["screwdriver · wrench", "→ DE: Schraubenzieher"]);
  });

  it("the German word-finder prompt stays as before", () => {
    expect(wordFinderPrompt("de")).toContain("Der Sprecher sucht ein Wort.");
  });
});

describe("Meine Wörter", () => {
  const entry = (word: string, at: number, meaning = "", alternatives: string[] = []): VocabEntry => ({ word, alternatives, meaning, at });

  it("keeps newest first and updates a known word instead of duplicating it", () => {
    let list: VocabEntry[] = [];
    list = addVocab(list, entry("wrench", 1, "Schraubenschlüssel"));
    list = addVocab(list, entry("screwdriver", 2, "Schraubenzieher"));
    list = addVocab(list, entry("Wrench", 3, "Schraubenschlüssel", ["spanner"]));
    expect(list.map((e) => e.word)).toEqual(["Wrench", "screwdriver"]);
    expect(list[0]).toMatchObject({ at: 3, alternatives: ["spanner"] });
  });

  it("caps at 300 and drops the oldest", () => {
    let list: VocabEntry[] = [];
    for (let i = 0; i < VOCAB_CAP + 25; i++) list = addVocab(list, entry("w" + i, i));
    expect(list).toHaveLength(VOCAB_CAP);
    expect(list[0]?.word).toBe("w" + (VOCAB_CAP + 24));
    expect(list.some((e) => e.word === "w0")).toBe(false);
  });

  it("deletes one word (any case)", () => {
    const list = [entry("a", 3), entry("b", 2), entry("c", 1)];
    expect(removeVocab(list, "B").map((e) => e.word)).toEqual(["a", "c"]);
  });

  it("is built from a lookup result and survives a storage round trip", () => {
    const found = vocabFromResult({ words: ["screwdriver", "wrench"], translation: "Schraubenzieher", learner: true }, 5);
    expect(found).toEqual({ word: "screwdriver", alternatives: ["wrench"], meaning: "Schraubenzieher", at: 5 });
    expect(vocabFromResult({ words: [] }, 1)).toBeNull();
    const list = [entry("b", 2, "B"), entry("a", 1, "A")];
    expect(parseVocab(JSON.stringify(list))).toEqual(list);
    expect(parseVocab("")).toEqual([]);
    expect(parseVocab("{oops")).toEqual([]);
    expect(parseVocab(JSON.stringify([{ word: "x" }, 7, null, { word: "ok", at: 1 }])).map((e) => e.word)).toEqual(["ok"]);
  });

  it("is listed on the phone with word, meaning and a delete button each", () => {
    const html = wordsInner([entry("screwdriver", 2, "Schraubenzieher", ["wrench"])], "de");
    expect(html).toContain("<b>screwdriver</b> → Schraubenzieher");
    expect(html).toContain('data-word-del="screwdriver"');
    expect(html).toContain('id="words-clear"');
    expect(wordsInner([], "en")).toContain(t("en", "p.wordsEmpty"));
    expect(wordsInner([entry("<i>", 1)], "en")).toContain("&lt;i&gt;");
  });
});

describe("setting 'Wortfinder automatisch'", () => {
  it("is on by default and by absence, off only when stored false", () => {
    expect(EMPTY_DATA.wordAuto).toBe(true);
    expect(parseData(JSON.stringify({})).wordAuto).toBe(true);
    expect(parseData(JSON.stringify({ wordAuto: false })).wordAuto).toBe(false);
  });

  it("1.0.0: Englisch sprechen has the automatic finder always on; the phone switch decides elsewhere (see main)", () => {
    expect(t("de", "g.mode.learn")).toBe("Englisch sprechen");
    expect(t("en", "p.wordAutoLearn")).toContain("Speak English");
  });
});

describe("1.0.0 word finder speaker rule: with a voice profile only the user's own FINAL lines count", () => {
  const voice = (over: Partial<StuckInput> = {}): StuckInput => input({ voiceProfile: true, ...over });

  it("a provisional line of unknown speaker never triggers, even when the last final line was the user's", () => {
    // The user said something, the other person is talking now (no speaker on a pending line yet).
    expect(stuckReason(voice({ log: [line("We could meet at the", "ME")], pending: "and then we could go to the" }))).toBeNull();
    // Without the profile the old guess stays: the pending line counts as the user's.
    expect(stuckReason(input({ log: [line("We could meet at the", "A")], speaker: "A", pending: "and then we could go to the" }))?.reason).toBe("unfinished");
  });

  it("the profile is also known from ME lines in the log (the server reported the voice)", () => {
    expect(stuckReason(input({ log: [line("Hello there.", "ME"), line("What do you think of the", "A")], pending: "What do you think of the" }))).toBeNull();
    expect(stuckReason(input({ log: [line("Hello there.", "ME")], pending: "I would like to order a" }))).toBeNull();
  });

  it("only a final line of ME can make the user stuck; a letter or no speaker cannot", () => {
    expect(stuckReason(voice({ log: [line("The other person says the", "A")] }))).toBeNull();
    expect(stuckReason(voice({ log: [line("Somebody with no label says the")] }))).toBeNull();
    expect(stuckReason(voice({ log: [line("We could meet at the", "ME")] }))).toEqual({ reason: "unfinished", text: "We could meet at the" });
    expect(stuckReason(voice({ log: [line("I think we should, ähm", "ME")], lastTextAt: NOW - 1_100 }))?.reason).toBe("hesitation");
  });

  it("a hesitation or a German word in a pending line is ignored just the same", () => {
    expect(stuckReason(voice({ log: [line("Fine.", "ME")], pending: "I think we should, ähm", lastTextAt: NOW - 1_100 }))).toBeNull();
    expect(stuckReason(voice({ log: [line("Fine.", "ME")], pending: "We meet at the Bahnhof tomorrow", lastTextAt: NOW - 1_100 }))).toBeNull();
  });

  it("the other limits still apply (gap, same text twice, busy, popup)", () => {
    expect(stuckReason(voice({ lastText: "We could meet at the" }))).toBeNull();
    expect(stuckReason(voice({ busy: true }))).toBeNull();
    expect(stuckReason(voice({ popupOpen: true }))).toBeNull();
    expect(stuckReason(voice({ lastAutoAt: NOW - AUTO_MIN_GAP_MS + 1 }))).toBeNull();
    expect(stuckReason(voice({ popupClosedAt: NOW - AUTO_AFTER_POPUP_MS + 1 }))).toBeNull();
  });
});

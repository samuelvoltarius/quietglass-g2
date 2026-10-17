import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  callsForReply, createReplyWatcher, foreignLanguage, lineOwner, parseReply, replyBody, replyContext, replyPrompt,
  suggestReply, REPLY_MAX_WORDS, REPLY_MIN_GAP_MS, type OwnerContext, type ReplySuggestion,
} from "../src/companion/replies";
import { isOwnLine, lastOwnLine, ownTranslationRequest, type OwnContext } from "../src/companion/own";
import {
  advancePopups, closePopup, dropKind, emptySlot, offerPopup, visiblePopup, QUEUE_MAX_MS, type PopupSlot,
} from "../src/companion/popups";
import { annotateEntry, type TranscriptEntry } from "../src/companion/transcript";
import { buildView, GLASS_COLS, liveHeader, popupRows, POPUP_WIDTH, type ViewOptions } from "../src/glasses/view";
import { applyTranscript, applyTranslation, createBuffer, displayWidth } from "../src/captions/buffer";
import { EMPTY_DATA, parseConversation, parseData } from "../src/storage/persist";
import { conversationInner } from "../src/ui/phone";
import { locales } from "../src/i18n";
import { t } from "../src/messages";

const at = (text: string, ms: number, speaker?: string, language?: string): TranscriptEntry =>
  ({ text, at: ms, ...(speaker ? { speaker } : {}), ...(language ? { language } : {}) });
const chars = (text: string): number => [...text].length;

const NO_INFO: OwnerContext = { speakers: false, mySpeaker: "auto", ownLanguage: null };
const BY_LETTER: OwnerContext = { speakers: true, mySpeaker: "A", ownLanguage: "de" };
const BY_LANGUAGE: OwnerContext = { speakers: true, mySpeaker: "auto", ownLanguage: "de" };

describe("who said it", () => {
  it("uses the speaker letter when the user named theirs", () => {
    expect(lineOwner(at("Привет", 0, "A", "ru"), BY_LETTER)).toBe("me");
    expect(lineOwner(at("Hallo", 0, "B", "de"), BY_LETTER)).toBe("other");
  });

  it("falls back to the language without a letter (or with automatic)", () => {
    expect(lineOwner(at("Hallo", 0, "B", "de"), BY_LANGUAGE)).toBe("me");
    expect(lineOwner(at("Привет", 0, "A", "ru"), BY_LANGUAGE)).toBe("other");
    expect(lineOwner(at("Hallo", 0, "A"), NO_INFO)).toBe("unknown");
  });

  it("knows a question or a real statement from a filler", () => {
    expect(callsForReply("Kommen Sie morgen?")).toBe(true);
    expect(callsForReply("Wie?")).toBe(true);
    expect(callsForReply("Das Paket kommt erst nächste Woche.")).toBe(true);
    expect(callsForReply("Ja, gut.")).toBe(false);
  });

  it("finds the foreign language: fixed setting, else the newest detected other language", () => {
    expect(foreignLanguage("ru", "de", [])).toBe("ru");
    expect(foreignLanguage("auto", "de", [at("x", 0, "A", "uk"), at("y", 1, "B", "de")])).toBe("uk");
    expect(foreignLanguage("auto", "de", [at("y", 1, "B", "de")])).toBeNull();
    expect(foreignLanguage("de", "de", [])).toBeNull();
  });
});

describe("reply prompt", () => {
  it("asks for ONE short sentence in the conversation language, '-' otherwise", () => {
    const de = replyPrompt("de", { language: "ru", gloss: "de" });
    expect(de).toContain("GENAU EINEN");
    expect(de).toContain(`höchstens ${REPLY_MAX_WORDS} Wörter, auf Russisch`);
    expect(de).toContain("in Klammern eine sehr kurze Übersetzung auf Deutsch");
    expect(de.endsWith("antworte genau -")).toBe(true);
    const en = replyPrompt("en", { language: "en" });
    expect(en).toContain("in English");
    expect(en).not.toContain("brackets");
    expect(en.endsWith("answer exactly -")).toBe(true);
  });

  it("passes memory notes and switches thinking off", () => {
    const body = replyBody("qwen", { context: "Gegenüber: Wann?", language: { language: "de" }, locale: "de", notes: "- 13.10.2026 Huber: Rückruf ab 9" });
    expect(body["chat_template_kwargs"]).toEqual({ enable_thinking: false });
    const messages = body["messages"] as { role: string; content: string }[];
    expect(messages[0]!.content).toContain("Notizen des Nutzers");
    expect(messages[1]!.content).toContain("Notizen des Nutzers:\n- 13.10.2026");
    expect(messages[1]!.content).toContain("Gespräch:\nGegenüber: Wann?");
    const plain = replyBody("qwen", { context: "x", language: { language: "de" }, locale: "de" });
    expect((plain["messages"] as { content: string }[])[0]!.content).not.toContain("Notizen");
  });

  it("tags the user's and the other's lines from the last minute", () => {
    const log = [at("alt", 0, "B", "ru"), at("Привет! Как дела?", 70_000, "B", "ru"), at("Gut", 75_000, "A", "de")];
    expect(replyContext(log, BY_LETTER, 80_000, "de")).toBe("Gegenüber: Привет! Как дела?\nNutzer: Gut");
    expect(replyContext(log, NO_INFO, 80_000, "en")).toBe("B: Привет! Как дела?\nA: Gut");
  });
});

describe("reply answer", () => {
  it("'-' (and variants) means nothing", () => {
    for (const nothing of ["-", " - ", "—", "<think>hm</think>-", "", "-."]) expect(parseReply(nothing), nothing).toBeNull();
  });

  it("cleans labels, quotes and splits off the gloss", () => {
    expect(parseReply("Antwort: „Gern, morgen um zehn passt mir.“")).toEqual({ text: "Gern, morgen um zehn passt mir." });
    expect(parseReply("Да, конечно. (Ja, natürlich.)", true)).toEqual({ text: "Да, конечно.", gloss: "Ja, natürlich." });
    expect(parseReply("Да, конечно.\n(Ja, natürlich.)", true)).toEqual({ text: "Да, конечно.", gloss: "Ja, natürlich." });
    expect(parseReply("Да, конечно. (Ja, natürlich.)", false)).toEqual({ text: "Да, конечно." });
  });

  it(`refuses more than ${REPLY_MAX_WORDS} words`, () => {
    const long = Array.from({ length: REPLY_MAX_WORDS + 1 }, (_, i) => "Wort" + i).join(" ");
    expect(parseReply(long)).toBeNull();
    expect(parseReply(long.split(" ").slice(0, REPLY_MAX_WORDS).join(" "))).not.toBeNull();
  });

  it("asks the server and reads '-' as no suggestion", async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "-" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const result = await suggestReply({ url: "https://llm.example/v1", model: "qwen", fetchImpl }, { context: "Gegenüber: Wann?", language: { language: "de" }, locale: "de" });
    expect(result).toEqual({ ok: true, value: null });
    expect(sent["chat_template_kwargs"]).toEqual({ enable_thinking: false });
    expect(sent["model"]).toBe("qwen");
  });
});

describe("reply watcher", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup(options: { speaking?: () => boolean; answer?: ReplySuggestion | null } = {}) {
    const shown: string[] = [];
    let asked = 0;
    const watcher = createReplyWatcher({
      enabled: () => true,
      owner: (entry) => lineOwner(entry, BY_LETTER),
      userSpeaking: options.speaking ?? (() => false),
      suggest: async () => { asked++; return options.answer === undefined ? { text: "Gern." } : options.answer; },
      onSuggestion: (s) => { shown.push(s.text); },
      now: () => Date.now(),
    });
    return { watcher, shown, asked: () => asked };
  }

  it("suggests after the other's question, debounced, and at most once per 15 s", async () => {
    const { watcher, shown, asked } = setup();
    let log = [at("Kommen Sie morgen?", Date.now(), "B")];
    watcher.onFinal(log);
    await vi.advanceTimersByTimeAsync(500);
    expect(shown).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(shown).toEqual(["Gern."]);
    log = [...log, at("Und am Freitag?", Date.now(), "B")];
    watcher.onFinal(log);
    await vi.advanceTimersByTimeAsync(3000);
    expect(shown).toHaveLength(1);
    expect(asked()).toBe(1);
    await vi.advanceTimersByTimeAsync(REPLY_MIN_GAP_MS);
    log = [...log, at("Oder Montag?", Date.now(), "B")];
    watcher.onFinal(log);
    await vi.advanceTimersByTimeAsync(1500);
    expect(shown).toHaveLength(2);
  });

  it("never asks about the user's own line", async () => {
    const { watcher, asked } = setup();
    watcher.onFinal([at("Kommen Sie morgen?", Date.now(), "A")]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(asked()).toBe(0);
  });

  it("waits while the user speaks and gives up when the moment has passed", async () => {
    const { watcher, shown, asked } = setup({ speaking: () => true });
    watcher.onFinal([at("Kommen Sie morgen?", Date.now(), "B")]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(asked()).toBe(0);
    expect(shown).toEqual([]);
  });

  it("drops a late suggestion once the user has answered", async () => {
    let release: (value: ReplySuggestion) => void = () => undefined;
    const shown: string[] = [];
    const watcher = createReplyWatcher({
      enabled: () => true,
      owner: (entry) => lineOwner(entry, BY_LETTER),
      userSpeaking: () => false,
      suggest: () => new Promise((resolve) => { release = resolve; }),
      onSuggestion: (s) => { shown.push(s.text); },
    });
    const question = at("Kommen Sie morgen?", Date.now(), "B");
    watcher.onFinal([question]);
    await vi.advanceTimersByTimeAsync(1500);
    watcher.onFinal([question, at("Ja, um zehn.", Date.now(), "A")]);
    release({ text: "Gern." });
    await vi.advanceTimersByTimeAsync(10);
    expect(shown).toEqual([]);
  });

  it("shows nothing for a '-' answer and does not count it against the 15 s", async () => {
    const { watcher, shown, asked } = setup({ answer: null });
    watcher.onFinal([at("Das Wetter ist heute schön.", Date.now(), "B")]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(asked()).toBe(1);
    expect(shown).toEqual([]);
  });
});

describe("popup priority", () => {
  const p = (name: string) => ({ name });
  it("word finder > reply suggestion > explanation, one at a time", () => {
    let slot: PopupSlot<{ name: string }> = emptySlot();
    slot = offerPopup(slot, "info", p("info"), 15_000, 0).slot;
    expect(visiblePopup(slot, 1)?.kind).toBe("info");
    const reply = offerPopup(slot, "reply", p("reply"), 12_000, 100);
    expect(reply.shown).toBe(true);
    slot = reply.slot;
    const info = offerPopup(slot, "info", p("info2"), 15_000, 200);
    expect(info.shown).toBe(false);
    slot = info.slot;
    slot = offerPopup(slot, "word", p("word"), 15_000, 300).slot;
    expect(visiblePopup(slot, 400)?.popup.name).toBe("word");
    const late = offerPopup(slot, "reply", p("reply2"), 12_000, 500);
    expect(late.shown).toBe(false);
    slot = late.slot;
    // Closing the word popup shows the best waiting one: the reply, then the explanation.
    slot = closePopup(slot, 1000);
    expect(visiblePopup(slot, 1000)?.popup.name).toBe("reply2");
    slot = closePopup(slot, 2000);
    expect(visiblePopup(slot, 2000)?.popup.name).toBe("info2");
  });

  it("drops a waiting reply suggestion that went stale", () => {
    let slot: PopupSlot<{ name: string }> = offerPopup(emptySlot<{ name: string }>(), "word", p("word"), 15_000, 0).slot;
    slot = offerPopup(slot, "reply", p("reply"), 12_000, 0).slot;
    slot = advancePopups(slot, QUEUE_MAX_MS.reply + 1);
    slot = closePopup(slot, QUEUE_MAX_MS.reply + 1);
    expect(visiblePopup(slot, QUEUE_MAX_MS.reply + 1)).toBeNull();
  });

  it("an expired popup makes room, and a dropped explanation disappears", () => {
    let slot: PopupSlot<{ name: string }> = offerPopup(emptySlot<{ name: string }>(), "reply", p("reply"), 1000, 0).slot;
    slot = offerPopup(slot, "info", p("info"), 15_000, 10).slot;
    slot = advancePopups(slot, 1001);
    expect(visiblePopup(slot, 1001)?.kind).toBe("info");
    slot = dropKind(slot, "info", 1002);
    expect(visiblePopup(slot, 1002)).toBeNull();
  });
});

describe("own sentences", () => {
  const ctx: OwnContext = { speakers: true, mySpeaker: "A", ownLanguage: "de", foreign: "ru" };
  const auto: OwnContext = { ...ctx, mySpeaker: "auto" };
  const off: OwnContext = { ...ctx, speakers: false, mySpeaker: "auto" };

  it("picks the user's lines by letter, else by the user's language", () => {
    expect(isOwnLine(at("Wie geht es?", 0, "A", "de"), ctx)).toBe(true);
    expect(isOwnLine(at("Wie geht es?", 0, "B", "de"), ctx)).toBe(false);
    expect(isOwnLine(at("Wie geht es?", 0, "B", "de"), auto)).toBe(true);
    expect(isOwnLine(at("Wie geht es?", 0, undefined, "de"), off)).toBe(true);
    expect(isOwnLine(at("Как дела?", 0, undefined, "ru"), off)).toBe(false);
  });

  it("never translates a line that is already in the foreign language, or without one", () => {
    expect(isOwnLine(at("Как дела?", 0, "A", "ru"), ctx)).toBe(false);
    expect(isOwnLine(at("Wie geht es?", 0, "A", "de"), { ...ctx, foreign: null })).toBe(false);
  });

  it("finds 'my last sentence' on demand: own language first, then my letter", () => {
    const log = [at("Ich nehme zwei.", 10_000, "B", "de"), at("Хорошо.", 20_000, "A", "ru")];
    expect(lastOwnLine(log, ctx, 30_000)?.text).toBe("Ich nehme zwei.");
    expect(lastOwnLine([at("Хорошо.", 20_000, "A", "ru")], ctx, 30_000)).toBeNull();
    expect(lastOwnLine([at("Ja", 20_000, "A")], ctx, 30_000)?.text).toBe("Ja");
    expect(lastOwnLine(log, ctx, 200_000)).toBeNull();
  });

  it("translates own language → foreign language", () => {
    expect(ownTranslationRequest("Wie geht es?", ctx)).toEqual({ text: "Wie geht es?", from: "de", to: "ru" });
    expect(ownTranslationRequest("x", { ...ctx, foreign: "de" })).toBeNull();
  });

  it("shows '→ …' in the captions, prominently first", () => {
    let buffer = applyTranscript(createBuffer(), { text: "Wie geht es?", final: true, speaker: "A" }, 0);
    buffer = applyTranslation(buffer, "Wie geht es?", "→ Как дела?");
    const view = buildView(buffer, { mode: "conversation", listening: true, status: "ready", translating: true, offset: 0, mock: false, locale: "de", speakers: true });
    expect(view.body[0]).toBe("A: → Как дела?");
  });
});

describe("settings and stored conversation (0.5.0)", () => {
  it("reply suggestions on and own sentences off by default", () => {
    expect(EMPTY_DATA.replySuggestions).toBe(true);
    expect(EMPTY_DATA.translateOwn).toBe(false);
    expect(parseData("{}")).toMatchObject({ replySuggestions: true, translateOwn: false });
    expect(parseData('{"replySuggestions":false,"translateOwn":true}')).toMatchObject({ replySuggestions: false, translateOwn: true });
  });

  it("keeps own translations and reply ideas with the transcript", () => {
    let log = [at("Kommen Sie?", 5, "B"), at("Ja", 6, "A")];
    log = annotateEntry(log, "Kommen Sie?", { reply: "Gern." }, 5);
    log = annotateEntry(log, "Ja", { own: "Да" });
    const kept = parseConversation(JSON.stringify({ log, summary: null }));
    expect(kept?.log[0]?.reply).toBe("Gern.");
    expect(kept?.log[1]?.own).toBe("Да");
  });
});

describe("popups: labels, header", () => {
  const base: ViewOptions = { mode: "conversation", listening: true, status: "ready", translating: true, offset: 0, mock: false, locale: "de" };

  for (const locale of locales) {
    it(`keeps the header within ${GLASS_COLS} characters, whatever is going on (${locale})`, () => {
      for (const status of ["ready", "connecting", "reconnecting", "error"] as const) {
        for (const modeLabel of [t(locale, "g.mode.translate"), t(locale, "g.mode.learn"), t(locale, "g.mode.client")]) {
          for (let mask = 0; mask < 8; mask++) {
            const header = liveHeader({
              locale, status, modeLabel, mock: Boolean(mask & 1), history: Boolean(mask & 2), armedStop: Boolean(mask & 4),
              translating: true, translateError: "a very long raw error message from somewhere deep in the network stack",
            });
            expect(chars(header), header).toBeLessThanOrEqual(GLASS_COLS);
            // The mode and the microphone's "●" always stay.
            expect(header.startsWith(modeLabel + " · "), header).toBe(true);
            expect(header, header).toContain("●");
          }
        }
      }
    });

    it(`labels every popup by its kind (${locale})`, () => {
      const info = popupRows({ term: "JAZ", info: "Jahresarbeitszahl" }, locale);
      expect(info[0]).toBe(t(locale, "g.lab.info") + " JAZ");
      expect(popupRows({ term: "", info: "", kind: "reply", lines: ["Да, конечно.", "(Ja, natürlich.)"] }, locale)[0])
        .toBe(t(locale, "g.lab.reply") + " Да, конечно.");
      expect(popupRows({ term: "", info: "", kind: "word", lines: ["Angebot"] }, locale)[0]).toBe(t(locale, "g.lab.word") + " Angebot");
      expect(popupRows({ term: "", info: "", kind: "say", lines: ["Как дела?"] }, locale)[0]).toBe("→ Как дела?");
      expect(popupRows({ term: "", info: "", kind: "say", lines: ["übersetze …"], plain: true }, locale)[0]).toBe("übersetze …");
    });

    it(`fits a 12-word reply with its gloss on the glasses (${locale})`, () => {
      const reply = "Konstantinopolitanische Dudelsackpfeifenmacher reparieren außergewöhnlich komplizierte Instrumente nur nach vorheriger telefonischer Terminvereinbarung bitte";
      const lines = [reply, "(" + "Übersetzung ".repeat(6).trim() + ")"];
      const buffer = applyTranscript(createBuffer(), { text: "Können Sie das reparieren?", final: true, speaker: "B" }, 0);
      const view = buildView(buffer, { ...base, locale, popup: { term: "", info: "", kind: "reply", lines } });
      expect(view.body.length).toBeLessThanOrEqual(7);
      for (const row of view.body) expect(displayWidth(row), row).toBeLessThanOrEqual(POPUP_WIDTH);
      expect(view.body[0]!.startsWith(t(locale, "g.lab.reply"))).toBe(true);
    });

  }

  it("marks own translations, reply ideas and every popup kind in the phone transcript", () => {
    const html = conversationInner({
      log: [{ text: "Kommen Sie?", at: 0, speaker: "B", reply: "Да, приду." }, { text: "Ja", at: 1, speaker: "A", own: "Да" }],
      pending: null,
      summary: null,
      insights: [{ term: "JAZ", info: "Jahresarbeitszahl", kind: "info" }, { term: "", info: "Angebot · Offerte", kind: "word" }],
      canSummarize: true,
    }, "de");
    expect(html).toContain('class="reply"><b>Antwort:</b> Да, приду.');
    expect(html).toContain('class="own"><b>→</b> Да <em>zum Vorlesen</em>');
    expect(html).toContain("<b>Info: JAZ</b>");
    expect(html).toContain("<b>Wort:</b> Angebot · Offerte");
  });
});

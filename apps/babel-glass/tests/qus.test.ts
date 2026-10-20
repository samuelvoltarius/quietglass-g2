import { describe, expect, it } from "vitest";
import {
  cockpitHint, durationWord, languageValue, modelKey, percentages, talkCockpitModel, talkStats, type TalkCockpitModel,
} from "../src/cockpit/model";
import { cellBoxes, composeCockpit } from "../src/cockpit/compose";
import { createFrame, frameKey, tiles, type Frame } from "../src/screen/frame";
import { createTileSender, tileSlots } from "../src/screen/sender";
import { pixelBackend } from "../src/screen/text";
import { guardedTileSend } from "../src/glasses/render";
import { GLASS_COLS } from "../src/glasses/view";
import { messages } from "../src/messages";
import { nowInner, type ConversationState } from "../src/ui/phone";
import type { TranscriptEntry } from "../src/companion/transcript";

// QUS v1: the pure parts of the summary cockpit - stats, cells, bars, headline, hint, tile diff - and the Jetzt tab.
const T0 = new Date(2026, 9, 17, 13, 51).getTime();
const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const backend = pixelBackend();

const line = (minute: number, text: string, speaker?: string, language = "de"): TranscriptEntry => ({
  text, at: T0 + minute * 60_000, ...(language ? { language } : {}), ...(speaker ? { speaker } : {}),
});
const talk: TranscriptEntry[] = [
  line(0, "Guten Tag, wie geht es Ihnen heute?", "A"),
  line(3, "Gut danke, und Ihnen?", "B"),
  line(7, "Sehr gut. Was kostet das Angebot", "A"),
  line(12, "Das Angebot kostet vierhundert Euro, ist das in Ordnung für Sie?", "B"),
];
const model = (log: readonly TranscriptEntry[] = talk, locale: "de" | "en" = "de", now = NOW): TalkCockpitModel =>
  talkCockpitModel({ log, locale, now, translating: true, sourceLanguage: "auto", targetLanguage: "en" })!;

describe("summary stats", () => {
  it("needs two lines with words, otherwise there is no cockpit", () => {
    expect(talkStats([])).toBeNull();
    expect(talkStats([line(0, "Hallo")])).toBeNull();
    expect(talkStats([line(0, " "), line(1, "")])).toBeNull();
    expect(talkCockpitModel({ log: [line(0, "Hallo")], locale: "de", now: NOW, translating: false, sourceLanguage: "de", targetLanguage: "en" })).toBeNull();
  });

  it("counts duration, words, questions and the share of every speaker", () => {
    const stats = talkStats(talk)!;
    expect(stats.durationMs).toBe(12 * 60_000);
    expect(stats.words).toBe(7 + 4 + 6 + 11);
    expect(stats.questions).toBe(3);
    expect(stats.shares.map((share) => [share.speaker, share.words])).toEqual([["B", 15], ["A", 13]]);
    expect(stats.shares.reduce((sum, share) => sum + share.percent, 0)).toBe(100);
    expect(stats.language).toBe("de");
  });

  it("percentages always add up to 100", () => {
    expect(percentages([1, 1, 1])).toEqual([34, 33, 33]);
    expect(percentages([14, 12]).reduce((a, b) => a + b, 0)).toBe(100);
    expect(percentages([0, 0])).toEqual([0, 0]);
  });

  it("writes the duration short, the same in both languages", () => {
    expect(durationWord(45_000)).toBe("45 S");
    expect(durationWord(12 * 60_000)).toBe("12 MIN");
    expect(durationWord(65 * 60_000)).toBe("1:05 H");
    expect(durationWord(0)).toBe("1 S");
  });

  it("the language cell shows the pair while translating, else what was spoken", () => {
    const stats = talkStats(talk)!;
    expect(languageValue(stats, { translating: true, sourceLanguage: "auto", targetLanguage: "en" })).toBe("DE→EN");
    expect(languageValue(stats, { translating: false, sourceLanguage: "auto", targetLanguage: "en" })).toBe("DE");
    const unknown = talkStats([line(0, "a b", undefined, ""), line(1, "c d", undefined, "")])!;
    expect(languageValue(unknown, { translating: false, sourceLanguage: "auto", targetLanguage: "en" })).toBe("–");
    expect(languageValue(unknown, { translating: false, sourceLanguage: "fr", targetLanguage: "en" })).toBe("FR");
  });
});

describe("summary cockpit model", () => {
  it("one big headline, four cells, a bar per speaker, the time span as caption", () => {
    const m = model();
    expect(m.headline).toEqual(["12 MIN"]);
    expect(m.cells.map((cell) => cell.label)).toEqual(["SPRECHER", "WÖRTER", "FRAGEN", "SPRACHE"]);
    expect(m.cells.map((cell) => cell.value)).toEqual(["2", "28", "3", "DE→EN"]);
    expect(m.bars.map((bar) => bar.label)).toEqual(["B", "A"]);
    expect(m.bars.map((bar) => bar.text)).toEqual(["54%", "46%"]);
    expect(m.caption).toBe("13:51 – 14:03");
    expect(m.title).toBe("GESPRÄCH");
    expect(m.clock).toBe("14:05");
    expect(model(talk, "en").cells.map((cell) => cell.label)).toEqual(["SPEAKERS", "WORDS", "QUESTIONS", "LANGUAGE"]);
  });

  it("the user's own voice is named Ich / Me, at most four bars", () => {
    const own = [line(0, "ich sage etwas hier", "ME"), line(1, "du sagst etwas anderes", "A")];
    expect(model(own).bars.map((bar) => bar.label)).toEqual(["Ich", "A"]);
    expect(model(own, "en").bars[0]!.label).toBe("Me");
    const many = ["A", "B", "C", "D", "E"].map((speaker, index) => line(index, "wort wort", speaker));
    expect(model(many).bars).toHaveLength(4);
    expect(model(many).cells[0]!.value).toBe("5");
  });

  it("without speaker labels the left half is one full bar and the speaker cell says a dash", () => {
    const plain = [line(0, "eins zwei drei"), line(2, "vier fünf")];
    const m = model(plain);
    expect(m.bars).toEqual([{ label: "ALLE", value: 100, text: "100%" }]);
    expect(m.cells[0]!.value).toBe("–");
  });

  it("the hint is one footer line that fits the row, in both languages", () => {
    expect(cockpitHint("de")).toBe("Tippen = weiter · Wischen = Text · 2× = Ende");
    expect(cockpitHint("en")).toBe("Tap = go on · Swipe = text · 2× = exit");
    for (const locale of ["de", "en"] as const) expect([...cockpitHint(locale)].length).toBeLessThanOrEqual(GLASS_COLS);
    expect(model().hint).toBe(cockpitHint("de"));
  });

  it("every glasses text of the cockpit has both languages and stays short", () => {
    for (const key of ["g.c.title", "g.c.speakers", "g.c.words", "g.c.questions", "g.c.language", "g.c.all", "g.a.text"]) {
      expect(messages.de[key], key).toBeTruthy();
      expect(messages.en[key], key).toBeTruthy();
      expect([...messages.en[key]!].length, key).toBeLessThanOrEqual(10);
    }
  });
});

describe("tile diff", () => {
  const frameOf = (log: readonly TranscriptEntry[] = talk, now = NOW): Frame => composeCockpit(model(log, "de", now), backend);
  const keys = (frame: Frame): string[] => tiles(frame).map(frameKey);
  const changed = (a: string[], b: string[]): number[] => a.map((key, index) => (key === b[index] ? -1 : index)).filter((index) => index >= 0);

  it("an unchanged state draws the same frame, tile for tile", () => {
    expect(keys(frameOf())).toEqual(keys(frameOf()));
    expect(modelKey(model())).toBe(modelKey(model()));
    expect(frameOf().pixels.some((level) => level > 0)).toBe(true);
    expect(createFrame().pixels.some((level) => level > 0)).toBe(false);
  });

  it("the clock alone changes only the top right tile", () => {
    expect(changed(keys(frameOf()), keys(frameOf(talk, NOW + 60_000)))).toEqual([1]);
  });

  it("one question less changes only the right half, the bars on the left stay", () => {
    const more = [...talk.slice(0, 3), line(12, "Das Angebot kostet vierhundert Euro, ist das in Ordnung für Sie.", "B")];
    const diff = changed(keys(frameOf()), keys(frameOf(more)));
    expect(diff.length).toBeGreaterThan(0);
    expect(diff.every((index) => index === 1 || index === 3)).toBe(true);
  });

  it("the sender sends all four tiles once, nothing for an identical frame, then only what changed; never while not allowed", async () => {
    const sent: string[] = [];
    const sender = createTileSender(tileSlots(21, "t"), async (slot) => { sent.push(slot.name); return true; }, () => new Uint8Array(1));
    await sender.push(frameOf());
    expect(sent).toEqual(["t-nw", "t-ne", "t-sw", "t-se"]);
    await sender.push(frameOf());
    expect(sent).toHaveLength(4);
    await sender.push(frameOf(talk, NOW + 60_000));
    expect(sent.slice(4)).toEqual(["t-ne"]);
    sender.reset();
    await sender.push(frameOf(talk, NOW + 60_000));
    expect(sent).toHaveLength(9);

    let calls = 0;
    const bridge = { updateImageRawData: async () => { calls += 1; return 0; } } as never;
    const blocked = guardedTileSend(bridge, () => false);
    expect(await blocked(tileSlots(21, "t")[0], new Uint8Array(1))).toBe(false);
    expect(calls).toBe(0);
  });

  it("lays four cells out in rows of three inside the right half", () => {
    const boxes = cellBoxes(model().cells);
    expect(boxes.map((box) => [box.x > 288, box.y])).toEqual([[true, 118], [true, 118], [true, 118], [true, 174]]);
    expect(boxes.every((box) => box.x + box.width <= 576)).toBe(true);
  });
});

describe("Jetzt tab, Rain look", () => {
  const state = (over: Partial<ConversationState> = {}): ConversationState => ({
    log: [], pending: null, summary: null, insights: [], canSummarize: false, ...over,
  });

  it("banner, one hero value (the mode), 2 x 2 figures, the modes and a strip of the last words", () => {
    const words = ["offer", "deal", "price"].map((word, index) => ({ word, meaning: "Angebot", alternatives: [], at: index }));
    const html = nowInner(state({
      talkMode: "client", log: talk, words,
      overview: { data: { sttUrl: "wss://s.example" } as never, listening: true, sttStatus: "ready", memory: "ok" },
    }), "de");
    expect(html).toContain('class="banner tone-ok"');
    expect(html).toContain('<strong class="word">Gespräch</strong>');
    expect(html.match(/<b>\d+<\/b>/g)).toEqual(["<b>4</b>", "<b>28</b>", "<b>3</b>", "<b>3</b>"]);
    expect(html.match(/data-talk-mode=/g)).toHaveLength(3);
    expect(html).toContain('class="strip"');
    expect(html.match(/class="host"/g)).toHaveLength(3);
  });

  it("no words yet: no strip", () => {
    expect(nowInner(state({ talkMode: "translate" }), "en")).not.toContain("strip");
  });
});

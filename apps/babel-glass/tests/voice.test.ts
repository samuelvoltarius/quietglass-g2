import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampPersons, createVoiceEnrollment, nextPersons, othersFor, parseVoiceReply, voiceCommand, voiceStartFrame,
  OWNER_SPEAKER, PERSONS_DEFAULT,
} from "../src/stt/voice";
import { createWebSocketStt, parseTranscript } from "../src/stt/provider";
import { createReplyWatcher, lineOwner, replyContext, type OwnerContext } from "../src/companion/replies";
import { lastOwnLine, type OwnContext } from "../src/companion/own";
import { resolveSpeaker } from "../src/companion/wordfinder";
import { speakerLine, type TranscriptEntry } from "../src/companion/transcript";
import { READ_KEYS, voiceSheetCancels, voiceSheetRows, type VoiceSheet } from "../src/companion/myvoice";
import { BODY_ROWS, buildView, GLASS_COLS, speakerPrefix, type ViewOptions } from "../src/glasses/view";
import { applyTranscript, createBuffer } from "../src/captions/buffer";
import { EMPTY_DATA, parseData } from "../src/storage/persist";
import { conversationInner } from "../src/ui/phone";
import { locales } from "../src/i18n";
import { messages, t } from "../src/messages";

const at = (text: string, ms: number, speaker?: string, language?: string): TranscriptEntry =>
  ({ text, at: ms, ...(speaker ? { speaker } : {}), ...(language ? { language } : {}) });
const chars = (text: string): number => [...text].length;

/** A scripted server socket: opens, then lets the test answer. */
class Sock {
  static last: Sock | null = null;
  readyState = 0;
  sent: (string | Uint8Array)[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(public url: string) { Sock.last = this; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 1); }
  send(data: string | Uint8Array): void { this.sent.push(data); }
  reply(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
  close(code = 1000): void { if (this.closed) return; this.closed = true; this.readyState = 3; this.onclose?.({ code }); }
  frames(): Record<string, unknown>[] { return this.sent.filter((m): m is string => typeof m === "string").map((m) => JSON.parse(m) as Record<string, unknown>); }
}
const WS = Sock as unknown as typeof WebSocket;

describe("0.8.0 people count", () => {
  it("cycles 2 -> 3 -> 4 -> 5 -> 2 and clamps anything else", () => {
    expect([2, 3, 4, 5].map(nextPersons)).toEqual([3, 4, 5, 2]);
    expect(nextPersons(9)).toBe(2);
    expect(clampPersons(4)).toBe(4);
    for (const bad of [1, 6, 2.5, "3", null, undefined]) expect(clampPersons(bad)).toBe(PERSONS_DEFAULT);
  });

  it("the others are everyone minus the user once the voice is known, at least one", () => {
    expect(othersFor(2, true)).toBe(1);
    expect(othersFor(2, false)).toBe(2);
    expect(othersFor(5, true)).toBe(4);
    expect(othersFor(99, false)).toBe(PERSONS_DEFAULT);
  });

  it("is stored with the settings: default 2, old settings load unchanged, nonsense falls back", () => {
    expect(EMPTY_DATA.persons).toBe(2);
    expect(EMPTY_DATA.voiceEnrolled).toBe(false);
    const old = parseData(JSON.stringify({ sttUrl: "wss://s.example" }));
    expect(old.persons).toBe(2);
    expect(old.voiceEnrolled).toBe(false);
    const set = parseData(JSON.stringify({ persons: 4, voiceEnrolled: true }));
    expect(set.persons).toBe(4);
    expect(set.voiceEnrolled).toBe(true);
    expect(parseData(JSON.stringify({ persons: 7, voiceEnrolled: "yes" }))).toMatchObject({ persons: 2, voiceEnrolled: false });
  });

  it("goes into the recogniser's start frame", async () => {
    const stt = createWebSocketStt({ url: "wss://s.example", language: "de", stream: true, persons: 3, speakers: 2, onTranscript: () => undefined, WS });
    vi.useFakeTimers();
    try {
      const started = stt.start();
      await vi.advanceTimersByTimeAsync(5);
      await started;
      expect(Sock.last!.frames()[0]).toMatchObject({ type: "start", stream: true, persons: 3, speakers: 2 });
      const stopped = stt.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      await stopped;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("0.8.0 speaker ME", () => {
  it("the recogniser keeps ME and single letters, drops anything else", () => {
    expect(parseTranscript(JSON.stringify({ text: "x", final: true, speaker: "ME" }))?.speaker).toBe("ME");
    expect(parseTranscript(JSON.stringify({ text: "x", final: true, speaker: "B" }))?.speaker).toBe("B");
    for (const bad of ["MX", "AB", "me", "", 3]) expect(parseTranscript(JSON.stringify({ text: "x", final: true, speaker: bad }))?.speaker).toBeUndefined();
  });

  const ctx = (over: Partial<OwnerContext> = {}): OwnerContext => ({ speakers: true, mySpeaker: "auto", ownLanguage: null, ...over });

  it("ME is always the user; with an enrolled voice every letter is someone else", () => {
    expect(lineOwner(at("Hallo", 0, OWNER_SPEAKER), ctx())).toBe("me");
    expect(lineOwner(at("Hallo", 0, OWNER_SPEAKER, "ru"), ctx({ mySpeaker: "A", ownLanguage: "de" }))).toBe("me");
    expect(lineOwner(at("Hallo", 0, "A"), ctx({ voiceEnrolled: true, mySpeaker: "A" }))).toBe("other");
    expect(lineOwner(at("Hallo", 0, "A", "de"), ctx({ voiceEnrolled: true, ownLanguage: "de" }))).toBe("other");
    // Without an enrolled voice nothing changes.
    expect(lineOwner(at("Hallo", 0, "A"), ctx({ mySpeaker: "A" }))).toBe("me");
    expect(lineOwner(at("Hallo", 0, "A"), ctx())).toBe("unknown");
  });

  it("the reply prompt calls ME lines the user's", () => {
    const context = replyContext([at("Was kostet das?", 1000, "A"), at("Moment, ich schaue.", 2000, OWNER_SPEAKER)], ctx({ voiceEnrolled: true }), 3000, "de");
    expect(context).toBe("Gegenüber: Was kostet das?\nNutzer: Moment, ich schaue.");
  });

  describe("reply watcher", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    function setup() {
      let asked = 0;
      const watcher = createReplyWatcher({
        enabled: () => true,
        owner: (entry) => lineOwner(entry, ctx({ voiceEnrolled: true })),
        userSpeaking: () => false,
        suggest: async () => { asked++; return { text: "Gern." }; },
        onSuggestion: () => undefined,
        now: () => Date.now(),
      });
      return { watcher, asked: () => asked };
    }

    it("never reacts to the user's own voice (ME), even to a question", async () => {
      const { watcher, asked } = setup();
      watcher.onFinal([at("Kommen Sie morgen vorbei?", Date.now(), OWNER_SPEAKER)]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(asked()).toBe(0);
    });

    it("reacts to the other person's letter, and the user's ME line cancels a waiting one", async () => {
      const { watcher, asked } = setup();
      const question = at("Kommen Sie morgen vorbei?", Date.now(), "A");
      watcher.onFinal([question]);
      await vi.advanceTimersByTimeAsync(300);
      watcher.onFinal([question, at("Ja, um zehn.", Date.now(), OWNER_SPEAKER)]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(asked()).toBe(0);
      watcher.onFinal([at("Und der Preis, wie viel?", Date.now(), "A")]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(asked()).toBe(1);
    });
  });

  it("word finder and 'my last sentence' prefer the ME lines", () => {
    const log = [at("Hallo", 1000, "A"), at("Guten Tag", 2000, OWNER_SPEAKER, "de"), at("Wie geht's?", 3000, "B")];
    expect(resolveSpeaker(log, "auto")).toBe(OWNER_SPEAKER);
    expect(resolveSpeaker(log, "B")).toBe(OWNER_SPEAKER);
    expect(resolveSpeaker([at("x", 1, "A")], "auto")).toBe("A");
    const own: OwnContext = { speakers: true, mySpeaker: "auto", ownLanguage: "de", foreign: "ru", voiceEnrolled: true };
    const ru = [at("Привет", 1000, "A", "ru"), at("Ich bin da", 2000, OWNER_SPEAKER, "auto"), at("Как дела?", 3000, "A", "ru")];
    expect(lastOwnLine(ru, own, 3500)?.text).toBe("Ich bin da");
  });

  it("is shown as 'Ich:' / 'Me:' on the glasses and the phone, and named for the language model", () => {
    expect(speakerPrefix("ME", "de")).toBe("Ich: ");
    expect(speakerPrefix("ME", "en")).toBe("Me: ");
    expect(speakerPrefix("B", "de")).toBe("B: ");
    expect(speakerLine(at("Hallo", 0, "ME"))).toBe("Ich (Nutzer): Hallo");
    expect(speakerLine(at("Hallo", 0, "A"))).toBe("A: Hallo");
    let buffer = createBuffer();
    buffer = applyTranscript(buffer, { text: "Was kostet das?", final: true, speaker: "A" }, 1000);
    buffer = applyTranscript(buffer, { text: "Ich schaue nach.", final: true, speaker: "ME" }, 2000);
    const options: ViewOptions = { mode: "conversation", listening: true, status: "ready", translating: false, offset: 0, mock: false, locale: "de", speakers: true };
    const body = buildView(buffer, options).body.join("\n");
    expect(body).toContain("A: Was kostet das?");
    expect(body).toContain("Ich: Ich schaue nach.");
    const html = conversationInner({ log: [at("Hallo", 0, "ME"), at("Servus", 1, "A")], pending: null, summary: null, insights: [], canSummarize: false }, "de");
    expect(html).toContain('<b class="spk spk-me">Ich</b>');
    expect(html).toContain('<b class="spk spk-0">A</b>');
  });
});

describe("0.8.0 voice protocol", () => {
  beforeEach(() => { vi.useFakeTimers(); Sock.last = null; });
  afterEach(() => { vi.useRealTimers(); });

  it("reads voice replies and ignores captions", () => {
    expect(parseVoiceReply(JSON.stringify({ type: "voice", action: "enroll", ok: true, seconds: 12.3, quality: 0.81, segments: 5 })))
      .toEqual({ action: "enroll", ok: true, seconds: 12.3, quality: 0.81 });
    expect(parseVoiceReply(JSON.stringify({ type: "voice", action: "enroll", state: "listening" }))).toEqual({ action: "enroll", ok: false, state: "listening" });
    expect(parseVoiceReply(JSON.stringify({ type: "voice", action: "enroll", ok: false, error: "weird" }))?.error).toBe("failed");
    expect(parseVoiceReply(JSON.stringify({ type: "voice", action: "delete", ok: true, existed: false }))).toEqual({ action: "delete", ok: true, existed: false });
    expect(parseVoiceReply(JSON.stringify({ text: "hallo", final: true }))).toBeNull();
    expect(parseVoiceReply(JSON.stringify({ type: "voice", action: "steal" }))).toBeNull();
    expect(parseVoiceReply("{nope")).toBeNull();
    expect(parseVoiceReply(42)).toBeNull();
  });

  it("start frames carry the token, never anything else of the user", () => {
    expect(JSON.parse(voiceStartFrame("enroll", "tok"))).toEqual({ type: "start", voice: "enroll", profile: "owner", sampleRate: 16000, encoding: "s16le", token: "tok" });
    expect(JSON.parse(voiceStartFrame("delete"))).not.toHaveProperty("token");
  });

  it("enrollment: start, ack, audio only after the ack, stop, result; then closed", async () => {
    const job = createVoiceEnrollment({ url: "wss://s.example", token: "tok", WS });
    job.send(new Uint8Array([1, 2]));                   // before the ack: dropped
    await vi.advanceTimersByTimeAsync(5);
    const sock = Sock.last!;
    expect(sock.frames()[0]).toMatchObject({ voice: "enroll", token: "tok" });
    sock.reply({ text: "caption from an old server", final: true });
    sock.reply({ type: "voice", action: "enroll", state: "listening" });
    await expect(job.ready).resolves.toBe(true);
    job.send(new Uint8Array([3, 4]));
    expect(sock.sent.filter((m) => typeof m !== "string")).toHaveLength(1);
    const result = job.finish();
    expect(sock.frames().at(-1)).toEqual({ type: "stop" });
    job.send(new Uint8Array([5, 6]));                   // after the stop: dropped
    expect(sock.sent.filter((m) => typeof m !== "string")).toHaveLength(1);
    sock.reply({ type: "voice", action: "enroll", ok: true, seconds: 13, quality: 0.8 });
    await expect(result).resolves.toMatchObject({ ok: true, seconds: 13 });
    expect(sock.closed).toBe(true);
  });

  it("an older server (no ack) and a refused token are told apart", async () => {
    const old = createVoiceEnrollment({ url: "wss://s.example", WS, ackMs: 1000 });
    await vi.advanceTimersByTimeAsync(1100);
    await expect(old.ready).resolves.toBe(false);
    await expect(old.finish()).resolves.toMatchObject({ ok: false, error: "unsupported" });
    const refused = createVoiceEnrollment({ url: "wss://s.example", WS });
    await vi.advanceTimersByTimeAsync(5);
    Sock.last!.close(1008);
    await expect(refused.ready).resolves.toBe(false);
    await expect(refused.finish()).resolves.toMatchObject({ error: "unauthorized" });
  });

  it("a lost connection or a silent server end in an error, never a hang", async () => {
    const lost = createVoiceEnrollment({ url: "wss://s.example", WS });
    await vi.advanceTimersByTimeAsync(5);
    Sock.last!.reply({ type: "voice", action: "enroll", state: "listening" });
    Sock.last!.close();
    await expect(lost.finish()).resolves.toMatchObject({ error: "network" });
    const silent = createVoiceEnrollment({ url: "wss://s.example", WS, resultMs: 2000 });
    await vi.advanceTimersByTimeAsync(5);
    Sock.last!.reply({ type: "voice", action: "enroll", state: "listening" });
    const result = silent.finish();
    await vi.advanceTimersByTimeAsync(2100);
    await expect(result).resolves.toMatchObject({ error: "timeout" });
  });

  it("cancel closes without stop: the server stores nothing", async () => {
    const job = createVoiceEnrollment({ url: "wss://s.example", WS });
    await vi.advanceTimersByTimeAsync(5);
    const sock = Sock.last!;
    sock.reply({ type: "voice", action: "enroll", state: "listening" });
    job.cancel();
    expect(sock.closed).toBe(true);
    expect(sock.frames().some((f) => f["type"] === "stop")).toBe(false);
  });

  it("delete and status run on a short connection of their own", async () => {
    const deleting = voiceCommand({ url: "wss://s.example", token: "tok", WS, action: "delete" });
    await vi.advanceTimersByTimeAsync(5);
    expect(Sock.last!.frames()[0]).toMatchObject({ voice: "delete", token: "tok" });
    Sock.last!.reply({ type: "voice", action: "delete", ok: true, existed: true });
    await expect(deleting).resolves.toEqual({ action: "delete", ok: true, existed: true });
    expect(Sock.last!.closed).toBe(true);
    const status = voiceCommand({ url: "wss://s.example", WS, action: "status", timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1100);
    await expect(status).resolves.toMatchObject({ ok: false, error: "unsupported" });
  });
});

describe("0.8.0 Meine Stimme sheet", () => {
  const sheets: VoiceSheet[] = [
    { kind: "connecting" }, { kind: "saving" }, { kind: "deleting" }, { kind: "noServer" }, { kind: "micDenied" },
    { kind: "reading", until: 16_000 },
    { kind: "result", reply: { action: "enroll", ok: true, seconds: 14.2, quality: 0.834 } },
    { kind: "result", reply: { action: "delete", ok: true, existed: false } },
    ...(["too_short", "inconsistent", "no_model", "unsupported", "unauthorized", "network", "timeout", "failed", "bad_profile"] as const)
      .map((error): VoiceSheet => ({ kind: "result", reply: { action: "enroll", ok: false, error } })),
  ];

  it("every step fits one page of the glasses (end row included) in both languages", () => {
    for (const locale of locales) {
      for (const sheet of sheets) {
        const rows = voiceSheetRows(sheet, locale, 0);
        expect(rows.length + 1, `${locale} ${sheet.kind}`).toBeLessThanOrEqual(BODY_ROWS);
        for (const row of rows) {
          expect(chars(row), `${locale} ${row}`).toBeLessThanOrEqual(GLASS_COLS);
          expect(row, `${locale} ${sheet.kind}`).not.toMatch(/^g\.|\{\w+\}/);
        }
      }
    }
  });

  it("reading shows the countdown and the five lines to read", () => {
    expect(voiceSheetRows({ kind: "reading", until: 16_000 }, "de", 4_100)).toEqual([
      "Lies laut vor · noch 12 s", ...READ_KEYS.map((key) => t("de", key)),
    ]);
    expect(voiceSheetRows({ kind: "result", reply: { action: "enroll", ok: true, seconds: 14.2, quality: 0.834 } }, "de", 0)[1])
      .toBe("14 s Stimme · Qualität 83 %");
  });

  it("a tap cancels only while connecting or reading", () => {
    expect(voiceSheetCancels({ kind: "reading", until: 0 })).toBe(true);
    expect(voiceSheetCancels({ kind: "connecting" })).toBe(true);
    expect(voiceSheetCancels({ kind: "saving" })).toBe(false);
    expect(voiceSheetCancels(null)).toBe(false);
  });

  it("the side-menu labels fit the SDK's 32 bytes", () => {
    const bytes = (text: string): number => new TextEncoder().encode(text).length;
    for (const locale of locales) {
      for (const key of ["g.m.voice", "g.m.voiceDelete"]) expect(bytes(messages[locale]![key]!)).toBeLessThanOrEqual(32);
      expect(bytes(t(locale, "g.m.persons", { n: 5 }))).toBeLessThanOrEqual(32);
    }
  });
});

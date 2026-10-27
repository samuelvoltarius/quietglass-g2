import { describe, expect, it } from "vitest";
import {
  createRoleTracker, decideRole, MIN_VOICED_FRAMES, normalizeRole, pcmRms, segmentLog, type SpeakerRole,
} from "../src/stt/role";
import { lineWho, profileVerdict, rolesOn, wordGate } from "../src/companion/roles";
import { stuckReason, wordContext, type StuckInput } from "../src/companion/wordfinder";
import { lineOwner } from "../src/companion/replies";
import type { TranscriptEntry } from "../src/companion/transcript";
import { EMPTY_DATA, parseData } from "../src/storage/persist";
import { applyTranscript, createBuffer } from "../src/captions/buffer";
import { buildView, type ViewOptions } from "../src/glasses/view";
import { conversationInner } from "../src/ui/phone";
import { VERSION } from "../src/version";

/** One 20 ms frame of s16le at a constant amplitude (0 = silence). */
const frame = (amplitude: number): Uint8Array => {
  const out = new Uint8Array(640);
  for (let i = 0; i < 320; i++) { out[2 * i] = amplitude & 0xff; out[2 * i + 1] = (amplitude >> 8) & 0xff; }
  return out;
};
const LOUD = frame(3000);
const QUIET = frame(0);

const feed = (tracker: ReturnType<typeof createRoleTracker>, role: SpeakerRole, n: number, pcm = LOUD, direction: number | null = null): void => {
  for (let i = 0; i < n; i++) tracker.add({ role, direction, source: "glasses", pcm });
};

describe("speaker role: frames -> segment", () => {
  it("normalizes the SDK value; anything else (old host, phone mic) is unknown", () => {
    expect(normalizeRole("self")).toBe("self");
    expect(normalizeRole("OTHER")).toBe("other");
    expect(normalizeRole("unknown")).toBe("unknown");
    expect(normalizeRole(undefined)).toBe("unknown");
    expect(normalizeRole(2)).toBe("unknown");
  });

  it("decides a role at >= 60 % of the frames, else unknown", () => {
    expect(decideRole({ self: 6, other: 4, unknown: 0 })).toBe("self");
    expect(decideRole({ self: 2, other: 7, unknown: 1 })).toBe("other");
    expect(decideRole({ self: 5, other: 5, unknown: 0 })).toBe("unknown");
    expect(decideRole({ self: 5, other: 0, unknown: 5 })).toBe("unknown");
    expect(decideRole({ self: 0, other: 0, unknown: 0 })).toBe("unknown");
  });

  it("measures the energy of s16le frames (negative samples included)", () => {
    expect(pcmRms(QUIET)).toBe(0);
    expect(Math.round(pcmRms(LOUD))).toBe(3000);
    expect(Math.round(pcmRms(frame(-3000 & 0xffff)))).toBe(3000);
  });

  it("silence classified unknown does not outvote the voiced frames", () => {
    const tracker = createRoleTracker();
    feed(tracker, "unknown", 30, QUIET);
    feed(tracker, "self", 8);
    feed(tracker, "other", 2);
    const segment = tracker.take();
    expect(segment.role).toBe("self");
    expect(segment.frames).toBe(40);
    expect(segment.voiced).toBe(10);
    expect(segment.shares.unknown).toBeCloseTo(0.75);
    expect(segment.decidedOn.self).toBeCloseTo(0.8);
  });

  it("with too few voiced frames all frames decide", () => {
    const tracker = createRoleTracker();
    feed(tracker, "other", MIN_VOICED_FRAMES - 1);
    feed(tracker, "unknown", 10, QUIET);
    expect(tracker.take().role).toBe("unknown");
    feed(tracker, "other", 9, QUIET);
    feed(tracker, "unknown", 1, QUIET);
    expect(tracker.take().role).toBe("other");
  });

  it("take() starts a new segment, peek() does not; reset() also forgets that the glasses classify", () => {
    const tracker = createRoleTracker();
    expect(tracker.seenKnown).toBe(false);
    feed(tracker, "self", 5);
    expect(tracker.peek().role).toBe("self");
    expect(tracker.peek().frames).toBe(5);
    expect(tracker.take().frames).toBe(5);
    expect(tracker.take().frames).toBe(0);
    expect(tracker.seenKnown).toBe(true);
    tracker.reset();
    expect(tracker.seenKnown).toBe(false);
    feed(tracker, "unknown", 5);
    expect(tracker.seenKnown).toBe(false);
  });

  it("keeps the distinct direction tags (at most 8) and counts frames that carried one", () => {
    const tracker = createRoleTracker();
    feed(tracker, "self", 2, LOUD, 12);
    feed(tracker, "self", 2, LOUD, -40);
    feed(tracker, "self", 1, LOUD, null);
    for (let d = 0; d < 20; d++) tracker.add({ role: "other", direction: d, pcm: LOUD });
    const segment = tracker.take();
    expect(segment.directions.slice(0, 2)).toEqual([12, -40]);
    expect(segment.directions).toHaveLength(8);
    expect(segment.withDirection).toBe(24);
    expect(segment.source).toBe("glasses");
  });

  it("the step log has shares, role, directions and the profile verdict - never text or audio", () => {
    const tracker = createRoleTracker();
    feed(tracker, "self", 6, LOUD, 7);
    feed(tracker, "other", 4, LOUD, 7);
    const fields = segmentLog(tracker.take(), { profile: "other", used: true, mode: "client" });
    expect(fields).toMatchObject({ fr: 10, vo: 10, s: 60, o: 40, u: 0, role: "self", dir: "7", dirN: 10, src: "glasses", prof: "other", agree: false, used: true, mode: "client" });
    expect(Object.values(fields).every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))).toBe(true);
    expect(JSON.stringify(fields).length).toBeLessThan(300);
    // No profile: no verdict fields; a "none" verdict or an unknown role is no disagreement.
    expect(segmentLog(tracker.take(), { used: false, mode: "translate" })).not.toHaveProperty("prof");
    feed(tracker, "self", 6);
    expect(segmentLog(tracker.take(), { profile: "none", used: true, mode: "learn" })["agree"]).toBeNull();
    feed(tracker, "self", 6);
    expect(segmentLog(tracker.take(), { profile: "self", used: true, mode: "learn" })["agree"]).toBe(true);
  });
});

describe("speaker role: marks and gates", () => {
  const me = { speakers: true, roles: true, profile: false };

  it("the switch is on by default and only an explicit false turns it off (stored only then)", () => {
    expect(rolesOn(EMPTY_DATA)).toBe(true);
    expect(rolesOn(parseData("{}"))).toBe(true);
    expect(rolesOn(parseData('{"speakerRole":false}'))).toBe(false);
    expect(parseData('{"speakerRole":true}')).not.toHaveProperty("speakerRole");
  });

  it("marks me / them by the glasses' role; unknown keeps the letter or nothing", () => {
    expect(lineWho({ role: "self" }, me)).toEqual({ kind: "me" });
    expect(lineWho({ role: "other", speaker: "B" }, me)).toEqual({ kind: "them" });
    expect(lineWho({ role: "unknown", speaker: "B" }, me)).toEqual({ kind: "letter", letter: "B" });
    expect(lineWho({ role: "unknown" }, me)).toBeNull();
    expect(lineWho({}, me)).toBeNull();
  });

  it("the voice profile wins over the glasses' role", () => {
    const profile = { ...me, profile: true };
    expect(lineWho({ speaker: "ME", role: "other" }, profile)).toEqual({ kind: "me" });
    expect(lineWho({ speaker: "A", role: "self" }, profile)).toEqual({ kind: "them" });
    // No speaker label on the line: the role decides.
    expect(lineWho({ role: "self" }, profile)).toEqual({ kind: "me" });
    expect(profileVerdict("ME", true)).toBe("self");
    expect(profileVerdict("A", true)).toBe("other");
    expect(profileVerdict(undefined, true)).toBe("none");
    expect(profileVerdict("ME", false)).toBeNull();
  });

  it("with the role marks off it is exactly the old speaker label", () => {
    const off = { speakers: true, roles: false, profile: false };
    expect(lineWho({ role: "self", speaker: "A" }, off)).toEqual({ kind: "letter", letter: "A" });
    expect(lineWho({ role: "self" }, off)).toBeNull();
    expect(lineWho({ speaker: "ME" }, off)).toEqual({ kind: "me" });
    expect(lineWho({ speaker: "A" }, { ...off, speakers: false })).toBeNull();
  });

  it("word finder gate: profile first; the role only when switched on and the glasses classify at all", () => {
    expect(wordGate({ profile: true, rolesOn: true, seenKnown: true })).toEqual({ profile: true, role: false });
    expect(wordGate({ profile: false, rolesOn: true, seenKnown: true })).toEqual({ profile: false, role: true });
    expect(wordGate({ profile: false, rolesOn: false, seenKnown: true })).toEqual({ profile: false, role: false });
    expect(wordGate({ profile: false, rolesOn: true, seenKnown: false })).toEqual({ profile: false, role: false });
  });

  it("reply ideas / own sentences: the role names the owner, the profile still wins, unknown falls back", () => {
    const ctx = { speakers: true, mySpeaker: "auto" as const, ownLanguage: "de", roles: true };
    expect(lineOwner({ role: "self", language: "en" }, ctx)).toBe("me");
    expect(lineOwner({ role: "other", language: "de" }, ctx)).toBe("other");
    expect(lineOwner({ role: "unknown", language: "de" }, ctx)).toBe("me");
    expect(lineOwner({ role: "self", language: "en" }, { ...ctx, roles: false })).toBe("other");
    expect(lineOwner({ role: "self", speaker: "A" }, { ...ctx, voiceEnrolled: true })).toBe("other");
  });
});

describe("speaker role: word finder only on MY lines (no voice profile)", () => {
  const NOW = 100_000;
  const line = (text: string, role?: SpeakerRole): TranscriptEntry => ({ text, at: NOW - 5_000, ...(role ? { role } : {}) });
  const input = (over: Partial<StuckInput> = {}): StuckInput => ({
    now: NOW, log: [line("We could meet at the", "self")], pending: null, lastTextAt: NOW - 3_000,
    speaker: null, language: "en", lastAutoAt: 0, lastText: null, busy: false, popupOpen: false, popupClosedAt: 0,
    roleGate: true, ...over,
  });

  it("helps on my final line", () => {
    expect(stuckReason(input())).toEqual({ reason: "unfinished", text: "We could meet at the" });
  });

  it("never on the other person's or an unclassified final line", () => {
    expect(stuckReason(input({ log: [line("We could meet at the", "other")] }))).toBeNull();
    expect(stuckReason(input({ log: [line("We could meet at the", "unknown")] }))).toBeNull();
    expect(stuckReason(input({ log: [line("We could meet at the")] }))).toBeNull();
  });

  it("a provisional line counts only while its frames are mine", () => {
    const pending = { pending: "I would like to order a", log: [line("Hello.", "other")] };
    expect(stuckReason(input({ ...pending, pendingRole: "self" }))?.text).toBe("I would like to order a");
    expect(stuckReason(input({ ...pending, pendingRole: "other" }))).toBeNull();
    expect(stuckReason(input({ ...pending, pendingRole: "unknown" }))).toBeNull();
  });

  it("without the gate the older behaviour stays (any line helps with speakers off)", () => {
    expect(stuckReason(input({ roleGate: false, log: [line("We could meet at the", "other")] }))?.text).toBe("We could meet at the");
  });

  it("the voice profile wins: a ME line helps although the glasses said other, an own-role letter line does not", () => {
    const profile = { voiceProfile: true, speaker: "ME", roleGate: false };
    expect(stuckReason(input({ ...profile, log: [{ ...line("We could meet at the", "other"), speaker: "ME" }] }))?.text).toBe("We could meet at the");
    expect(stuckReason(input({ ...profile, log: [{ ...line("We could meet at the", "self"), speaker: "A" }] }))).toBeNull();
  });

  it("the context prefers my lines", () => {
    const log = [line("Where are you from?", "other"), line("I am from the", "self")];
    expect(wordContext(log, { now: NOW, speaker: null, selfRole: true })).toBe("I am from the");
    expect(wordContext(log, { now: NOW, speaker: null })).toBe("Where are you from?\nI am from the");
  });
});

describe("speaker role: what the glasses and the phone show", () => {
  const base: ViewOptions = { mode: "conversation", listening: true, status: "ready", translating: false, offset: 0, mock: false, locale: "de", speakers: true };
  const buffer = (): ReturnType<typeof createBuffer> => {
    let b = createBuffer();
    b = applyTranscript(b, { text: "Wie geht es dir?", final: true, speaker: "A" }, 1, {}, "other");
    b = applyTranscript(b, { text: "Gut, danke.", final: true, speaker: "B" }, 2, {}, "self");
    b = applyTranscript(b, { text: "Schön.", final: true }, 3, {}, "unknown");
    return b;
  };

  it("Gespräch with the switch on: short \"Ich:\" / \"Ggü:\" in front, unknown keeps its line", () => {
    const body = buildView(buffer(), { ...base, roles: true }).body.join("\n");
    expect(body).toContain("Ggü: Wie geht es dir?");
    expect(body).toContain("Ich: Gut, danke.");
    expect(body).toMatch(/^Schön\.$/m);
    const en = buildView(buffer(), { ...base, roles: true, locale: "en" }).body.join("\n");
    expect(en).toContain("Them: Wie geht es dir?");
    expect(en).toContain("Me: Gut, danke.");
  });

  it("without the marks (other modes, switch off) the letters stay as before", () => {
    const body = buildView(buffer(), base).body.join("\n");
    expect(body).toContain("A: Wie geht es dir?");
    expect(body).toContain("B: Gut, danke.");
  });

  it("the phone transcript says Ich / Gegenüber", () => {
    const log: TranscriptEntry[] = [
      { text: "Wie geht es dir?", at: 1, speaker: "A", role: "other" },
      { text: "Gut, danke.", at: 2, role: "self" },
    ];
    const html = conversationInner({ log, pending: null, summary: null, insights: [], canSummarize: false, roles: true }, "de");
    expect(html).toContain('<b class="spk spk-them">Gegenüber</b>');
    expect(html).toContain('<b class="spk spk-me">Ich</b>');
    const plain = conversationInner({ log, pending: null, summary: null, insights: [], canSummarize: false }, "de");
    expect(plain).not.toContain("Gegenüber");
    expect(plain).toContain('<b class="spk spk-0">A</b>');
  });
});

describe("version", () => {
  it("is the same in app.json, package.json, the lock file and src/version.ts", async () => {
    // tsconfig carries no node types: reach fs structurally (as tests/preview.test.ts does).
    const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as unknown as { readFileSync(path: URL, encoding: string): string };
    const read = (name: string): Record<string, unknown> => JSON.parse(fs.readFileSync(new URL("../" + name, import.meta.url), "utf8")) as Record<string, unknown>;
    const lock = read("package-lock.json");
    expect(read("app.json")["version"]).toBe(VERSION);
    expect(read("package.json")["version"]).toBe(VERSION);
    expect(lock["version"]).toBe(VERSION);
    expect((lock["packages"] as Record<string, Record<string, unknown>>)[""]?.["version"]).toBe(VERSION);
  });
});

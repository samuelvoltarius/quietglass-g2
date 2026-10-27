import { chatCompletionsUrl } from "../translate/provider";
import { streamChat } from "../llm/stream";
import { AUTO, primaryCode, sameLanguage } from "../text/languages";
import type { Locale } from "../i18n";
import { t } from "../messages";
import type { Result } from "./llm";
import type { TranscriptEntry } from "./transcript";
import type { SpeakerChoice } from "./wordfinder";
import { OWNER_SPEAKER } from "../stt/voice";

/**
 * Antwort-Vorschläge (0.5.0): when the OTHER person finishes a question or a
 * statement that calls for a reply, the language model proposes ONE short
 * sentence the user could say — in the conversation language, so it can be
 * read out. Strict: the model answers exactly "-" when no reply is needed,
 * and nothing is shown.
 */

/** Transcript the model sees: the last minute. */
export const REPLY_WINDOW_MS = 60_000;
/** At most one shown suggestion per this gap. */
export const REPLY_MIN_GAP_MS = 15_000;
/** Between two requests (a "-" answer does not block the next 15 s). */
export const REPLY_REQUEST_GAP_MS = 4_000;
/** A burst of final lines (one sentence split in two) becomes one request. */
export const REPLY_DEBOUNCE_MS = 1_200;
/** Waiting for the user to stop talking ends after this long: the moment has passed. */
export const REPLY_STALE_MS = 6_000;
export const REPLY_MAX_WORDS = 12;
export const REPLY_MAX_TOKENS = 64;
export const REPLY_TIMEOUT_MS = 8_000;

export interface ReplySuggestion {
  /** The sentence to say, in the conversation language. */
  readonly text: string;
  /** A short gloss in the user's own language, when the conversation is foreign. */
  readonly gloss?: string;
}

/** Who said a line, as far as the app can tell. */
export type LineOwner = "me" | "other" | "unknown";

export interface OwnerContext {
  /** Speaker letters are on. */
  readonly speakers: boolean;
  /** "Ich bin Sprecher" — "auto" says nothing about who is who. */
  readonly mySpeaker: SpeakerChoice;
  /** The user's own language (the translation target), when translating; null otherwise. */
  readonly ownLanguage: string | null;
  /** 0.8.0: the server knows the user's voice: the user's lines come as "ME", letters are the others. */
  readonly voiceEnrolled?: boolean;
  /** 1.1.1: use the glasses' speaker role (switch "Sprecher erkennen (Brille)"); the profile still wins. */
  readonly roles?: boolean;
}

/**
 * 0.8.0: "ME" (the server knows the user's voice) is always the user, and with
 * an enrolled voice every letter is someone else. Otherwise the speaker letter
 * wins when the user named theirs; otherwise the detected language (own
 * language = the user, any other = the other person).
 */
export function lineOwner(entry: Pick<TranscriptEntry, "speaker" | "language" | "role">, ctx: OwnerContext): LineOwner {
  if (entry.speaker === OWNER_SPEAKER) return "me";
  if (ctx.voiceEnrolled && ctx.speakers && entry.speaker) return "other";
  // 1.1.1: the glasses' role, when it names one; "unknown" falls through to the older guesses.
  if (ctx.roles && entry.role === "self") return "me";
  if (ctx.roles && entry.role === "other") return "other";
  if (ctx.speakers && ctx.mySpeaker !== "auto" && entry.speaker) return entry.speaker === ctx.mySpeaker ? "me" : "other";
  if (ctx.ownLanguage && entry.language && entry.language !== AUTO) {
    return sameLanguage(entry.language, ctx.ownLanguage) ? "me" : "other";
  }
  return "unknown";
}

/** A question, or at least a real statement (not "ok", "ja", "mhm"). */
export function callsForReply(text: string): boolean {
  const trimmed = text.trim();
  if (/[?？]\s*$/.test(trimmed)) return true;
  return trimmed.split(/\s+/).filter(Boolean).length >= 4;
}

/**
 * The foreign language of the conversation: the configured spoken language
 * when it is fixed and differs from the target, else the newest line detected
 * in another language than the target. null = not known (yet).
 */
export function foreignLanguage(source: string, target: string, log: readonly TranscriptEntry[]): string | null {
  if (source && source !== AUTO && !sameLanguage(source, target)) return primaryCode(source).toLowerCase();
  for (let i = log.length - 1; i >= 0; i--) {
    const language = log[i]?.language;
    if (language && language !== AUTO && !sameLanguage(language, target)) return primaryCode(language).toLowerCase();
  }
  return null;
}

/** "Russisch" / "Russian" (the phone's language names), falling back to the code. */
export function languageLabel(code: string, locale: Locale): string {
  const key = "l." + primaryCode(code).toLowerCase();
  const name = t(locale, key);
  return name === key ? code : name;
}

export interface ReplyLanguage {
  /** Language of the suggestion (BCP-47 primary). */
  readonly language: string;
  /** Gloss in this language (the user's own), only for a foreign conversation. */
  readonly gloss?: string;
}

/** The last minute as role-tagged lines: the model must know which lines are the user's. */
export function replyContext(
  log: readonly TranscriptEntry[],
  ctx: OwnerContext,
  now: number,
  locale: Locale,
  windowMs = REPLY_WINDOW_MS,
): string {
  let recent = log.filter((entry) => entry.at >= now - windowMs);
  if (recent.length === 0) recent = log.slice(-4);
  const de = locale === "de";
  return recent.map((entry) => {
    const owner = lineOwner(entry, ctx);
    const who = owner === "me" ? (de ? "Nutzer" : "User")
      : owner === "other" ? (de ? "Gegenüber" : "Other")
      : entry.speaker ?? "?";
    return who + ": " + entry.text;
  }).join("\n");
}

export function replyPrompt(locale: Locale, language: ReplyLanguage, withNotes = false): string {
  const lang = languageLabel(language.language, locale);
  const gloss = language.gloss && !sameLanguage(language.gloss, language.language) ? languageLabel(language.gloss, locale) : null;
  if (locale === "de") {
    return [
      "Du hilfst jemandem live in einem Gespräch (Mitschrift per Spracherkennung, kann Hörfehler enthalten).",
      "„Nutzer:“ sind seine Zeilen, „Gegenüber:“ die der anderen Person; ein Buchstabe heißt: unbekannt.",
      "Prüfe die LETZTE Zeile: Stellt das Gegenüber eine Frage, bittet um etwas oder sagt etwas, worauf der Nutzer jetzt antworten sollte?",
      `Dann schlage GENAU EINEN kurzen, natürlichen Satz vor, den der Nutzer sagen kann: höchstens ${REPLY_MAX_WORDS} Wörter, auf ${lang}, ohne Anführungszeichen, ohne Erklärung.`,
      gloss ? `Dahinter in Klammern eine sehr kurze Übersetzung auf ${gloss}.` : "",
      "Erfinde keine Zusagen, Termine, Preise oder Fakten, die der Nutzer nicht kennt – dann lieber eine kurze Rückfrage.",
      withNotes ? "„Notizen des Nutzers“ nur verwenden, wenn sie konkret passen." : "",
      "Braucht es keine Antwort oder stammt die letzte Zeile vom Nutzer selbst, antworte genau -",
    ].filter(Boolean).join(" ");
  }
  return [
    "You help someone live during a conversation (speech-recognition transcript, may contain errors).",
    "\"User:\" lines are theirs, \"Other:\" lines the other person's; a letter means unknown.",
    "Look at the LAST line: does the other person ask a question, ask for something or say something the user should reply to now?",
    `Then suggest EXACTLY ONE short, natural sentence the user can say: at most ${REPLY_MAX_WORDS} words, in ${lang}, no quotes, no explanation.`,
    gloss ? `After it, in brackets, a very short translation into ${gloss}.` : "",
    "Do not invent commitments, dates, prices or facts the user cannot know – ask a short question back instead.",
    withNotes ? "Use the \"Notizen des Nutzers\" (the user's notes) only when they fit concretely." : "",
    "If no reply is needed or the last line is the user's own, answer exactly -",
  ].filter(Boolean).join(" ");
}

const LABEL = /^(?:vorschlag|antwort|antwort-idee|suggestion|reply|answer|sag|say)\s*:\s*/i;
const QUOTES = /^[\s"'„“”‚‘’«»]+|[\s"'„“”‚‘’«»]+$/g;

function words(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/**
 * Reads the model's answer. null = "-", nothing usable, or longer than
 * REPLY_MAX_WORDS (a long speech is no suggestion one can read out).
 */
export function parseReply(content: string, withGloss = false): ReplySuggestion | null {
  const text = content.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```[a-z]*/gi, "").trim();
  if (!text || /^[-–—]+\.?$/.test(text)) return null;
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  let main = (lines[0] ?? "").replace(/^\s*(?:[-•*]\s+|\d+[.)]\s*)/, "").replace(LABEL, "").trim();
  if (!main || /^[-–—]+\.?$/.test(main)) return null;
  let gloss = "";
  const bracket = main.match(/^(.*?)\s*[(\[]([^()\[\]]+)[)\]]\s*$/);
  if (bracket && bracket[1]!.trim()) {
    main = bracket[1]!.trim();
    gloss = bracket[2]!.trim();
  } else if (lines[1] && /^[(\[].*[)\]]$/.test(lines[1])) {
    gloss = lines[1].slice(1, -1).trim();
  }
  main = main.replace(QUOTES, "").trim();
  gloss = gloss.replace(QUOTES, "").trim();
  if (!main || words(main) === 0 || words(main) > REPLY_MAX_WORDS || [...main].length > 110) return null;
  const keepGloss = withGloss && gloss && words(gloss) <= 16 && [...gloss].length <= 90 && gloss.toLowerCase() !== main.toLowerCase();
  return keepGloss ? { text: main, gloss } : { text: main };
}

export interface ReplyRequest {
  readonly context: string;
  readonly language: ReplyLanguage;
  readonly locale: Locale;
  /** Memory hits ("Notizen des Nutzers"), already formatted; "" = none. */
  readonly notes?: string;
}

export interface ReplyConfig {
  readonly url: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** The request body for the language model (kept separate so tests can read it). */
export function replyBody(model: string, request: ReplyRequest): Record<string, unknown> {
  const notes = request.notes?.trim() ?? "";
  const user = notes
    ? "Notizen des Nutzers:\n" + notes + "\n\n" + (request.locale === "de" ? "Gespräch:\n" : "Conversation:\n") + request.context
    : request.context;
  return {
    model,
    temperature: 0.3,
    max_tokens: REPLY_MAX_TOKENS,
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      { role: "system", content: replyPrompt(request.locale, request.language, Boolean(notes)) },
      { role: "user", content: user },
    ],
  };
}

/** Asks the language model; ok(null) = no reply needed. */
export async function suggestReply(config: ReplyConfig, request: ReplyRequest): Promise<Result<ReplySuggestion | null>> {
  if (!request.context.trim()) return { ok: true, value: null };
  const wait = config.timeoutMs ?? REPLY_TIMEOUT_MS;
  const reply = await streamChat({
    endpoint: chatCompletionsUrl(config.url),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    body: replyBody(config.model, request),
    firstTokenMs: wait,
    idleMs: wait,
    totalMs: wait,
  });
  if (!reply.ok) return reply;
  return { ok: true, value: parseReply(reply.text, Boolean(request.language.gloss)) };
}

/** 0.6.3: per-mode reply timing; a missing field keeps the watcher's own value. */
export interface ReplyTiming {
  readonly debounceMs?: number;
  readonly minGapMs?: number;
  readonly requestGapMs?: number;
}

export interface ReplyWatcherOptions {
  /** Setting on, listening, a model there. */
  readonly enabled: () => boolean;
  readonly owner: (entry: TranscriptEntry) => LineOwner;
  /** Someone who may be the user is talking right now (a provisional line). */
  readonly userSpeaking: () => boolean;
  /** Asks the model about the conversation ending with the trigger line. */
  readonly suggest: (log: readonly TranscriptEntry[]) => Promise<ReplySuggestion | null>;
  readonly onSuggestion: (suggestion: ReplySuggestion, trigger: TranscriptEntry) => void;
  readonly now?: () => number;
  readonly debounceMs?: number;
  readonly minGapMs?: number;
  readonly requestGapMs?: number;
  readonly staleMs?: number;
  /** 0.6.3: read on every decision, so a mode switch takes effect at once (client mode is faster). */
  readonly timing?: () => ReplyTiming | undefined;
}

export interface ReplyWatcher {
  onFinal(log: readonly TranscriptEntry[]): void;
  reset(): void;
  stop(): void;
}

/**
 * Decides when to ask: after a final line of the other person that calls for
 * a reply, debounced, one request at a time, never while the user talks, at
 * most one shown suggestion per REPLY_MIN_GAP_MS, and a late answer is dropped
 * once the user has already said something.
 */
export function createReplyWatcher(options: ReplyWatcherOptions): ReplyWatcher {
  const now = options.now ?? Date.now;
  const baseDebounce = options.debounceMs ?? REPLY_DEBOUNCE_MS;
  const baseMinGap = options.minGapMs ?? REPLY_MIN_GAP_MS;
  const baseRequestGap = options.requestGapMs ?? REPLY_REQUEST_GAP_MS;
  const timing = (): ReplyTiming => options.timing?.() ?? {};
  const debounceNow = (): number => timing().debounceMs ?? baseDebounce;
  const staleMs = options.staleMs ?? REPLY_STALE_MS;
  let latest: readonly TranscriptEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let stopped = false;
  let lastShown = -Infinity;
  let lastRequest = -Infinity;
  /** The trigger line already asked about (its time), so it is not asked twice. */
  let askedAt = -1;

  const schedule = (ms: number): void => {
    clearTimeout(timer);
    timer = setTimeout(() => { void fire(); }, ms);
  };

  const fire = async (): Promise<void> => {
    timer = undefined;
    if (stopped || busy || !options.enabled()) return;
    const log = latest;
    const trigger = log[log.length - 1];
    if (!trigger || trigger.at === askedAt) return;
    if (options.owner(trigger) === "me" || !callsForReply(trigger.text)) return;
    const t0 = now();
    const debounce = debounceNow();
    const minGap = timing().minGapMs ?? baseMinGap;
    const requestGap = timing().requestGapMs ?? baseRequestGap;
    if (t0 - trigger.at > staleMs + debounce) return;
    if (t0 - lastShown < minGap) return;
    if (t0 - lastRequest < requestGap) { schedule(requestGap - (t0 - lastRequest)); return; }
    if (options.userSpeaking()) { schedule(700); return; }
    askedAt = trigger.at;
    busy = true;
    lastRequest = t0;
    const suggestion = await options.suggest(log).catch(() => null);
    busy = false;
    if (stopped || !suggestion || !options.enabled()) return;
    // The user already answered (or is answering): the suggestion is too late.
    const index = latest.indexOf(trigger);
    const newer = index >= 0 ? latest.slice(index + 1) : [];
    if (newer.some((entry) => options.owner(entry) === "me") || options.userSpeaking()) return;
    if (newer.length > 0) { schedule(debounce); return; }
    lastShown = now();
    options.onSuggestion(suggestion, trigger);
  };

  return {
    onFinal(log) {
      latest = log;
      stopped = false;
      const last = log[log.length - 1];
      if (!last) return;
      // The user speaks: a waiting suggestion is cancelled.
      if (options.owner(last) === "me") { clearTimeout(timer); timer = undefined; return; }
      if (!busy) schedule(debounceNow());
    },
    reset() { latest = []; askedAt = -1; lastShown = -Infinity; lastRequest = -Infinity; clearTimeout(timer); timer = undefined; },
    stop() { stopped = true; clearTimeout(timer); timer = undefined; },
  };
}

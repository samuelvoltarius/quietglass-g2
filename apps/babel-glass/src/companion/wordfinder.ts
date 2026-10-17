import { chatCompletionsUrl } from "../translate/provider";
import { streamChat } from "../llm/stream";
import { AUTO, languageName } from "../text/languages";
import type { Result } from "./llm";
import { speakerLine, type TranscriptEntry } from "./transcript";
import { OWNER_SPEAKER } from "../stt/voice";

/**
 * Wortfinder (0.4.0): the user is talking and cannot find a word. A hold
 * during captions sends the last ~20 s of the transcript to the language
 * model, which guesses the word and 2–3 alternatives. The answer pops up on
 * the glasses in one line (plus, with a translation target, the word in that
 * language). Fast on purpose: few tokens, low temperature, no thinking, 8 s.
 *
 * 0.9.0: a hold never reaches the app on the real glasses, so the lookup also
 * starts by itself when the user is stuck (`stuckReason`), and a German user
 * who speaks English gets the English word plus its German meaning.
 */

/** "Ich bin Sprecher": auto = whoever spoke last before the hold. */
export type SpeakerChoice = "auto" | "A" | "B";

export const WORD_WINDOW_MS = 20_000;
export const WORD_MAX_TOKENS = 40;
export const WORD_TIMEOUT_MS = 8_000;
/** One popup line on the glasses. */
export const WORD_LINE_CHARS = 40;
/** The guessed word plus at most three alternatives. */
export const WORD_MAX = 4;

export interface WordResult {
  /** The likely word first, then the alternatives. */
  readonly words: readonly string[];
  /** The first word in the translation target, when asked for (0.9.0: in the learner case its German meaning). */
  readonly translation?: string;
  /** 0.9.0: answered with the learner prompt (German speaker, English conversation). */
  readonly learner?: boolean;
}

export interface WordRequest {
  /** Transcript lines, oldest first ("A: …"). */
  readonly context: string;
  /** Conversation language (BCP-47); "de" when unknown. */
  readonly language: string;
  /** Translation target, if the user translates into another language. */
  readonly target?: string;
  /** 0.9.0: force or forbid the learner prompt; absent = decided by `isLearnerCase`. */
  readonly learner?: boolean;
}

/**
 * The user's speaker letter: "ME" once the server recognised the user's voice
 * (0.8.0), else the setting, or with "auto" the newest speaker in the log.
 */
export function resolveSpeaker(log: readonly TranscriptEntry[], choice: SpeakerChoice): string | null {
  if (log.some((entry) => entry.speaker === OWNER_SPEAKER)) return OWNER_SPEAKER;
  if (choice !== "auto") return choice;
  for (let i = log.length - 1; i >= 0; i--) {
    const speaker = log[i]?.speaker;
    if (speaker) return speaker;
  }
  return null;
}

export interface WordContextOptions {
  readonly now: number;
  /** Prefer this speaker's lines (null = everyone). */
  readonly speaker: string | null;
  /** The provisional line the recogniser is still writing (often the sentence with the gap). */
  readonly pending?: string | null;
  readonly windowMs?: number;
}

/**
 * The last ~20 s of the conversation as plain lines. With a known speaker
 * only that speaker's lines are used (when there are any); with nothing in the
 * window the last three lines stand in. The provisional line goes last.
 */
export function wordContext(log: readonly TranscriptEntry[], options: WordContextOptions): string {
  const windowMs = options.windowMs ?? WORD_WINDOW_MS;
  let recent = log.filter((entry) => entry.at >= options.now - windowMs);
  if (recent.length === 0) recent = log.slice(-3);
  if (options.speaker) {
    const own = recent.filter((entry) => entry.speaker === options.speaker);
    if (own.length) recent = own;
  }
  const lines = recent.map(speakerLine);
  const pending = options.pending?.trim();
  if (pending) lines.push(pending + " …");
  return lines.join("\n");
}

/** The conversation language: the configured one, else what the recogniser detected last, else German. */
export function conversationLanguage(log: readonly TranscriptEntry[], configured: string): string {
  if (configured && configured !== AUTO) return configured.split("-")[0]!.toLowerCase();
  for (let i = log.length - 1; i >= 0; i--) {
    const language = log[i]?.language;
    if (language) return language.split("-")[0]!.toLowerCase();
  }
  return "de";
}

/**
 * 0.9.0: the learner case. The user is a German native who talks ENGLISH and
 * gets stuck: the conversation language is English, or what he said so far is
 * mostly English although the setting says otherwise.
 */
export function isLearnerCase(language: string, context: string): boolean {
  if (language === "en") return true;
  const words = context.toLowerCase().match(/[a-zäöüß']+/g) ?? [];
  if (words.length < 4) return false;
  const english = words.filter((w) => ENGLISH_WORDS.has(w)).length;
  const german = words.filter((w) => GERMAN_WORDS.has(w) || /[äöüß]/.test(w)).length;
  return english >= 2 && english > german * 2;
}

export function wordFinderPrompt(language: string, target?: string, learner = false): string {
  if (learner) {
    return [
      "The speaker is a German native speaker talking English and is stuck for a word.",
      "Give the English word he most likely needs and 2–3 English alternatives, only the words, separated by ' · '.",
      "If he said a German word, the first English word must be its translation.",
      "On a second line only the German meaning of the first word.",
      "No sentences, no explanation, no numbers.",
    ].join(" ");
  }
  const withTarget = target && target.split("-")[0] !== language ? target : undefined;
  if (language === "de") {
    return [
      "Der Sprecher sucht ein Wort. Gib das wahrscheinlich gesuchte Wort und 2–3 Ausweichwörter, nur die Wörter, durch ' · ' getrennt.",
      "Auf Deutsch, keine Sätze, keine Erklärung, keine Nummern.",
      withTarget ? `In einer zweiten Zeile nur das erste Wort auf ${languageName(withTarget)}.` : "",
    ].join(" ").trim();
  }
  const name = languageName(language);
  return [
    "The speaker is searching for a word. Give the most likely word and 2–3 alternatives, only the words, separated by ' · '.",
    `In ${name}, no sentences, no explanation, no numbers.`,
    withTarget ? `On a second line only the first word in ${languageName(withTarget)}.` : "",
  ].join(" ").trim();
}

/** Cleans one word as models like to write it: "1. „Angebot“," → "Angebot". */
function cleanWord(raw: string): string {
  return raw
    .replace(/^\s*(?:[-•*]|\d+[.)])\s*/, "")
    .replace(/^[\s"'„“”‚‘’«»(]+|[\s"'„“”‚‘’«».,;:!?)]+$/g, "")
    .trim();
}

/** Reads the model's answer; null when it holds no usable word. */
export function parseWords(content: string, withTranslation = false): WordResult | null {
  const text = content.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```[a-z]*/gi, "");
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const first = lines[0];
  if (!first) return null;
  // A sentence instead of a word list ("Tut mir leid, das weiß ich nicht.") is no answer.
  if (!/[·•|]/.test(first) && first.split(/\s+/).length > 5) return null;
  const words: string[] = [];
  for (const part of first.split(/\s*(?:·|•|\||;|,|\/| - )\s*/)) {
    const word = cleanWord(part);
    // A whole sentence is no word (models sometimes apologise instead).
    if (!word || word === "-" || word.split(/\s+/).length > 3 || [...word].length > 30) continue;
    if (!words.some((w) => w.toLowerCase() === word.toLowerCase())) words.push(word);
    if (words.length >= WORD_MAX) break;
  }
  if (words.length === 0) return null;
  const second = withTranslation && lines[1] ? cleanWord(lines[1].split(/\s*(?:·|,|;)\s*/)[0] ?? "") : "";
  const translation = second && [...second].length <= 30 && second.toLowerCase() !== words[0]!.toLowerCase() ? second : "";
  return translation ? { words, translation } : { words };
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}

/**
 * The popup lines: as many words as fit one line of `width` characters
 * (the first one always, cut if it must), then "→ translation" if there is one
 * (0.9.0: "→ DE: meaning" in the learner case, with `translationLabel` "DE:").
 */
export function wordPopupLines(result: WordResult, width = WORD_LINE_CHARS, translationLabel = ""): string[] {
  let line = "";
  for (const word of result.words) {
    const next = line ? line + " · " + word : word;
    if ([...next].length > width) {
      if (!line) line = clip(word, width);
      break;
    }
    line = next;
  }
  const out = [line];
  if (result.translation) out.push(clip("→ " + (translationLabel ? translationLabel + " " : "") + result.translation, width));
  return out;
}

export interface WordFinderConfig {
  readonly url: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Asks the language model; `timed out` / `empty response` etc. as errors. */
export async function findWord(config: WordFinderConfig, request: WordRequest): Promise<Result<WordResult>> {
  if (!request.context.trim()) return { ok: false, error: "empty" };
  const wait = config.timeoutMs ?? WORD_TIMEOUT_MS;
  const learner = request.learner ?? isLearnerCase(request.language, request.context);
  const withTranslation = learner || Boolean(request.target && request.target.split("-")[0] !== request.language);
  const reply = await streamChat({
    endpoint: chatCompletionsUrl(config.url),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    body: {
      model: config.model,
      temperature: 0.1,
      max_tokens: WORD_MAX_TOKENS,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        { role: "system", content: wordFinderPrompt(request.language, request.target, learner) },
        { role: "user", content: request.context },
      ],
    },
    firstTokenMs: wait,
    idleMs: wait,
    totalMs: wait,
  });
  if (!reply.ok) return reply;
  const words = parseWords(reply.text, withTranslation);
  return words ? { ok: true, value: learner ? { ...words, learner: true } : words } : { ok: false, error: "empty response" };
}

// ---- Automatic trigger (0.9.0): the user is stuck ----

/** At most one automatic lookup in this time. */
export const AUTO_MIN_GAP_MS = 8_000;
/** An unfinished sentence counts as "stuck" after this much silence from the recogniser. */
export const STUCK_QUIET_MS = 2_500;
/** A hesitation or a German word needs a short pause too, so the sentence can go on. */
export const HESITATION_QUIET_MS = 1_000;
/** No automatic lookup this soon after a popup closed. */
export const AUTO_AFTER_POPUP_MS = 2_000;

export type StuckReason = "unfinished" | "hesitation" | "german";

export interface StuckInput {
  readonly now: number;
  readonly log: readonly TranscriptEntry[];
  /** The provisional line the recogniser is still writing, if any. */
  readonly pending: string | null;
  /** When the recogniser last delivered any text (partial or final); 0 = never. */
  readonly lastTextAt: number;
  /** The user's speaker letter; null = speakers are off, all speech is the user's. */
  readonly speaker: string | null;
  /** Conversation language (primary code). */
  readonly language: string;
  /** Start of the last automatic lookup; 0 = none yet. */
  readonly lastAutoAt: number;
  /** Text of the last lookup, so the same text is never asked twice. */
  readonly lastText: string | null;
  /**
   * 1.0.0: the user's voice is known (enrolled on the server). The check also holds when the log
   * already holds "ME" lines. Then only the user's own FINAL lines can make him "stuck".
   */
  readonly voiceProfile?: boolean;
  /** A lookup is running. */
  readonly busy: boolean;
  /** A popup is on the glasses now. */
  readonly popupOpen: boolean;
  /** When the last popup closed; 0 = none yet. */
  readonly popupClosedAt: number;
}

const HESITATIONS = [
  "ähm", "äh", "öhm", "öh", "ehm", "hm", "hmm", "mhm", "uh", "um", "uhm", "erm",
  "wie sagt man", "how do you say", "what's the word", "what is the word",
];
const GERMAN_WORDS = new Set(["und", "der", "die", "das", "ist", "nicht", "wie", "ich"]);
const ENGLISH_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "and", "to", "of", "in", "it", "that", "for", "with", "on", "this",
  "i", "you", "we", "my", "have", "be", "but", "so", "not", "what", "do", "can", "will", "would", "about", "think",
]);

function tidy(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** True when the text ends in a hesitation: "ähm", "äh …", "how do you say". */
export function endsWithHesitation(text: string): boolean {
  const tail = tidy(text).toLowerCase().replace(/[\s.,;:!?…"'„“”–-]+$/g, "");
  return HESITATIONS.some((h) => tail === h || tail.endsWith(" " + h) || tail.endsWith("," + h));
}

/** A German word in an otherwise English line: an umlaut/ß word or one of a few function words. */
export function hasGermanWord(text: string): boolean {
  const words = text.toLowerCase().match(/[a-zäöüß']+/g) ?? [];
  if (words.length < 3) return false;
  const german = words.filter((w) => GERMAN_WORDS.has(w) || /[äöüß]/.test(w)).length;
  // "The rest is English": German-looking words are the exception, not the sentence.
  return german >= 1 && german <= 2 && words.length - german >= german * 2;
}

/**
 * Why the user seems to be stuck right now, or null. Pure: main.ts only feeds
 * it the clock and the state. The newest text must be the user's; a provisional
 * line carries no speaker yet, so it counts as the user's when the last final
 * line was (or when speakers are off). 1.0.0: with a voice profile that guess is
 * dropped — only a final "ME" line counts, a pending line never does.
 */
export function stuckReason(input: StuckInput): { reason: StuckReason; text: string } | null {
  const { now } = input;
  if (input.busy || input.popupOpen || !input.lastTextAt) return null;
  if (input.lastAutoAt && now - input.lastAutoAt < AUTO_MIN_GAP_MS) return null;
  if (input.popupClosedAt && now - input.popupClosedAt < AUTO_AFTER_POPUP_MS) return null;

  const last = input.log[input.log.length - 1];
  const pending = input.pending ? tidy(input.pending) : "";
  let text = "";
  if (input.voiceProfile || input.log.some((entry) => entry.speaker === OWNER_SPEAKER)) {
    // With a voice profile the provisional line has no speaker yet and could be anybody:
    // only a final line that the server attributed to the user counts. A provisional line means somebody
    // is talking right now and the newest text is not (yet) known to be the user's: wait for its final.
    if (pending || last?.speaker !== OWNER_SPEAKER) return null;
    text = tidy(last.text);
  } else if (pending || last) {
    if (input.speaker && last?.speaker !== input.speaker) return null;
    text = pending || tidy(last?.text ?? "");
  }
  if (!text) return null;
  if (input.lastText !== null && tidy(input.lastText) === text) return null;

  const quiet = now - input.lastTextAt;
  if (quiet >= HESITATION_QUIET_MS) {
    if (endsWithHesitation(text)) return { reason: "hesitation", text };
    if (input.language === "en" && hasGermanWord(text)) return { reason: "german", text };
  }
  if (quiet >= STUCK_QUIET_MS && !/[.?!…]["')»”]*$/.test(text)) return { reason: "unfinished", text };
  return null;
}

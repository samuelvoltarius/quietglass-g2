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
  /** The first word in the translation target, when asked for. */
  readonly translation?: string;
}

export interface WordRequest {
  /** Transcript lines, oldest first ("A: …"). */
  readonly context: string;
  /** Conversation language (BCP-47); "de" when unknown. */
  readonly language: string;
  /** Translation target, if the user translates into another language. */
  readonly target?: string;
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

export function wordFinderPrompt(language: string, target?: string): string {
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
 * (the first one always, cut if it must), then "→ translation" if there is one.
 */
export function wordPopupLines(result: WordResult, width = WORD_LINE_CHARS): string[] {
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
  if (result.translation) out.push(clip("→ " + result.translation, width));
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
  const withTranslation = Boolean(request.target && request.target.split("-")[0] !== request.language);
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
        { role: "system", content: wordFinderPrompt(request.language, request.target) },
        { role: "user", content: request.context },
      ],
    },
    firstTokenMs: wait,
    idleMs: wait,
    totalMs: wait,
  });
  if (!reply.ok) return reply;
  const words = parseWords(reply.text, withTranslation);
  return words ? { ok: true, value: words } : { ok: false, error: "empty response" };
}

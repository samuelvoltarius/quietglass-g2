import { AUTO, languageName } from "../text/languages";

/**
 * Translation providers.
 *
 * Kept separate from speech recognition on purpose: people mix and match. A
 * self-hosted LibreTranslate behind a local Whisper is a common pairing, and
 * neither should force the other.
 *
 * Two real backends exist:
 * - LibreTranslate-compatible `/translate` (LibreTranslate itself, or the
 *   NLLB-200 example server in examples/translate-server.py),
 * - OpenAI-compatible `/v1/chat/completions` (vLLM, Ollama, LM Studio,
 *   llama.cpp server) — the route for language pairs Argos/LibreTranslate
 *   does not have, notably Belarusian.
 */

export interface TranslationRequest {
  readonly text: string;
  /** BCP-47 or "auto". */
  readonly from: string;
  readonly to: string;
}

export interface TranslationResult {
  readonly text: string;
  readonly error: string | null;
}

export interface TranslationProvider {
  readonly name: string;
  /**
   * True when "auto" is a poor source language for this backend, so the
   * caller should pass the recogniser's detected language instead.
   */
  readonly needsConcreteSource?: boolean;
  translate(request: TranslationRequest): Promise<TranslationResult>;
}

export interface HttpTranslateConfig {
  /** Endpoint accepting the LibreTranslate-compatible JSON body. */
  readonly url: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * LibreTranslate-compatible HTTP translator.
 *
 * Chosen because LibreTranslate is the realistic self-hosted option and
 * several other services accept the same body shape.
 */
export function createHttpTranslator(config: HttpTranslateConfig): TranslationProvider {
  const doFetch = config.fetchImpl ?? fetch;

  return {
    name: "http",
    async translate({ text, from, to }): Promise<TranslationResult> {
      if (!text.trim()) return { text: "", error: null };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 6000);

      try {
        const response = await doFetch(config.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            q: text,
            source: from,
            target: to,
            format: "text",
            ...(config.apiKey ? { api_key: config.apiKey } : {}),
          }),
        });

        if (!response.ok) return { text: "", error: "HTTP " + response.status };

        const value = await readJson(response);
        const translated = value === null ? null : readTranslated(value);
        return translated === null
          ? { text: "", error: "unreadable response" }
          : { text: translated, error: null };
      } catch (error) {
        return { text: "", error: describeError(error) };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/** Parses a JSON object body; null for anything else. Network errors propagate. */
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  const raw = await response.text();
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readTranslated(value: Record<string, unknown>): string | null {
  if (typeof value["translatedText"] === "string") return value["translatedText"];
  if (typeof value["translation"] === "string") return value["translation"];
  if (typeof value["text"] === "string") return value["text"];
  return null;
}

export interface OpenAiTranslateConfig {
  /**
   * Base URL of an OpenAI-compatible server (`http://host:11434/v1`) or the
   * full `/chat/completions` endpoint.
   */
  readonly url: string;
  /** Model name exactly as the server knows it, e.g. `qwen2.5:7b-instruct`. */
  readonly model: string;
  /** Optional bearer token; most self-hosted servers need none. */
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly temperature?: number;
  readonly fetchImpl?: typeof fetch;
}

/** Resolves a base URL to its chat-completions endpoint. */
export function chatCompletionsUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return trimmed + "/chat/completions";
}

/** The system prompt. Strict, because the output goes straight to the display. */
export function translationPrompt(from: string, to: string): string {
  const target = languageName(to);
  const source = from === AUTO
    ? "whatever language it is written in"
    : languageName(from) + " (" + from + ")";
  return [
    `You are a translation engine. Translate the user's text from ${source} to ${target} (${to}).`,
    `Output only the ${target} translation.`,
    "No quotes, no notes, no explanations, no transliteration, no preamble.",
  ].join(" ");
}

/**
 * Translator for any OpenAI-compatible chat-completions server.
 *
 * Self-hosted LLMs handle pairs that classic MT packages lack — Belarusian
 * in particular — and can run on the same machine as Whisper.
 */
export function createOpenAiTranslator(config: OpenAiTranslateConfig): TranslationProvider {
  const doFetch = config.fetchImpl ?? fetch;
  const endpoint = chatCompletionsUrl(config.url);

  return {
    name: "openai",
    needsConcreteSource: true,
    async translate({ text, from, to }): Promise<TranslationResult> {
      if (!text.trim()) return { text: "", error: null };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 15_000);

      try {
        const response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.apiKey ? { Authorization: "Bearer " + config.apiKey } : {}),
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: config.model,
            temperature: config.temperature ?? 0.1,
            stream: false,
            messages: [
              { role: "system", content: translationPrompt(from, to) },
              { role: "user", content: text },
            ],
          }),
        });

        if (!response.ok) return { text: "", error: "HTTP " + response.status };

        const value = await readJson(response);
        const content = value === null ? null : readChatContent(value);
        if (content === null) return { text: "", error: "unreadable response" };

        const cleaned = cleanLlmOutput(content, text);
        return cleaned ? { text: cleaned, error: null } : { text: "", error: "empty response" };
      } catch (error) {
        return { text: "", error: describeError(error) };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function readChatContent(value: Record<string, unknown>): string | null {
  const choices = value["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first: unknown = choices[0];
  if (!first || typeof first !== "object") return null;
  const record = first as Record<string, unknown>;
  const message = record["message"];
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>)["content"];
    if (typeof content === "string") return content;
  }
  // Legacy completions shape, still returned by some servers.
  return typeof record["text"] === "string" ? record["text"] : null;
}

/** "Here is the translation:", "Translation:", "Übersetzung:", "German:" … */
const PREAMBLE = new RegExp(
  "^(?:" + [
    "(?:sure[,!.]?\\s*)?here(?: is|'s) (?:the |your |a )?(?:\\w+ )?translation(?: [^:\\n]{0,40})?",
    "(?:\\w+ )?translation(?: \\(\\w+\\))?",
    "(?:deutsche )?übersetzung",
    "german|deutsch|english",
  ].join("|") + ")\\s*:\\s*",
  "i",
);

const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["\"", "\""], ["'", "'"], ["„", "“"], ["“", "”"],
  ["«", "»"], ["»", "«"], ["‚", "‘"], ["‘", "’"],
];

const OPENING_QUOTE = /^["'„“«»‚‘]/;

/**
 * Removes what chat models wrap around a translation: reasoning blocks,
 * code fences, "Here is the translation:" preambles and enclosing quotes.
 * Quotes are kept when the source text was itself quoted.
 */
export function cleanLlmOutput(output: string, source = ""): string {
  let text = output.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  text = text.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
  text = text.replace(PREAMBLE, "").trim();

  if (!OPENING_QUOTE.test(source.trim())) {
    for (const [open, close] of QUOTE_PAIRS) {
      if (text.length > 2 && text.startsWith(open) && text.endsWith(close)) {
        text = text.slice(open.length, text.length - close.length).trim();
        break;
      }
    }
  }
  return text.normalize("NFC");
}

export function describeError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "timed out";
  if (error instanceof Error && error.name === "AbortError") return "timed out";
  if (error instanceof TypeError) return "unreachable";
  if (error instanceof Error && error.message) return error.message.slice(0, 50);
  return "failed";
}

/** Passes text through unchanged. Used when translation is switched off. */
export function createPassthroughTranslator(): TranslationProvider {
  return {
    name: "none",
    async translate({ text }) { return { text, error: null }; },
  };
}

/** Mock translator for the simulator; clearly labelled wherever it appears. */
export function createMockTranslator(): TranslationProvider {
  return {
    name: "mock",
    async translate({ text, to }) {
      return { text: "[" + to + "] " + text, error: null };
    },
  };
}

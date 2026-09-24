/**
 * Translation providers.
 *
 * Kept separate from speech recognition on purpose: people mix and match. A
 * self-hosted LibreTranslate behind a local Whisper is a common pairing, and
 * neither should force the other.
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

        const value = await response.json() as Record<string, unknown>;
        const translated = readTranslated(value);
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

function readTranslated(value: Record<string, unknown>): string | null {
  if (typeof value["translatedText"] === "string") return value["translatedText"];
  if (typeof value["translation"] === "string") return value["translation"];
  if (typeof value["text"] === "string") return value["text"];
  return null;
}

export function describeError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "timed out";
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

/**
 * Streamed chat completions for the OpenAI-compatible language model
 * (translation, summary, explanations).
 *
 * The request asks for `stream: true` so the glasses can show text while it is
 * still being written. Everything else is a fallback:
 * - a server (or proxy) that answers with plain JSON is read as before,
 * - a stream that breaks or reports an error before the first token, or a
 *   server that refuses `stream` (HTTP 400/415/422/501), gets one ordinary
 *   `stream: false` request within the remaining time.
 * Reasoning (`reasoning_content`, `reasoning`, `<think>` blocks) is never shown.
 */

/**
 * 0.7.0: headers every language-model request of the current session carries:
 * `X-Babel-Customer: <id>` once a customer was picked on the start screen
 * (the proxy then uses that customer's Shoot Day context), "-" for "Ohne Kunde".
 */
let sessionHeaders: Record<string, string> = {};
export function setSessionCustomer(id: string | null): void {
  sessionHeaders = id === null ? {} : { "X-Babel-Customer": id };
}

export interface ChatCallOptions {
  /** The full `/chat/completions` endpoint. */
  readonly endpoint: string;
  /** Request body without `stream`; it is set here. */
  readonly body: Readonly<Record<string, unknown>>;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  /** Called with the whole visible text so far (thinking removed) whenever it grew. */
  readonly onText?: (visible: string) => void;
  /** Until the response and the first token (prompt processing can take a while). */
  readonly firstTokenMs: number;
  /** Longest silence between two chunks once text is flowing. */
  readonly idleMs: number;
  /** Hard cap for the whole call, fallback included. */
  readonly totalMs: number;
  /** Clock for the cap; tests may replace it. */
  readonly now?: () => number;
}

export type ChatResult =
  | { readonly ok: true; readonly text: string; readonly streamed: boolean }
  | { readonly ok: false; readonly error: string };

// ---------------------------------------------------------------- SSE parsing

export interface SseParser {
  /** Feeds decoded text; events may be split anywhere, even inside "\r\n". */
  push(chunk: string): void;
  /** End of input: dispatches a last event that had no blank line after it. */
  end(): void;
}

/**
 * Server-sent events, as far as chat completions use them: `data:` fields
 * (several in one event are joined with "\n"), comments (`:`) and other fields
 * ignored, an event ends at a blank line. Any line ending (\n, \r\n, \r).
 */
export function createSseParser(onData: (data: string) => void): SseParser {
  let buffer = "";
  let data: string[] = [];

  const dispatch = (): void => {
    if (data.length === 0) return;
    const joined = data.join("\n");
    data = [];
    onData(joined);
  };

  const line = (text: string): void => {
    if (text === "") { dispatch(); return; }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
  };

  return {
    push(chunk) {
      buffer += chunk;
      for (;;) {
        const cr = buffer.indexOf("\r");
        const lf = buffer.indexOf("\n");
        if (cr < 0 && lf < 0) return;
        const at = cr < 0 ? lf : lf < 0 ? cr : Math.min(cr, lf);
        if (buffer[at] === "\r") {
          // "\r" at the very end may be the first half of "\r\n": wait.
          if (at === buffer.length - 1) return;
          line(buffer.slice(0, at));
          buffer = buffer.slice(at + (buffer[at + 1] === "\n" ? 2 : 1));
        } else {
          line(buffer.slice(0, at));
          buffer = buffer.slice(at + 1);
        }
      }
    },
    end() {
      if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1);
      if (buffer !== "") line(buffer);
      buffer = "";
      dispatch();
    },
  };
}

// ------------------------------------------------------------ chunk contents

export interface ChunkInfo {
  /** New answer text in this chunk ("" for none). Reasoning is never included. */
  readonly delta: string;
  /** The server reported an error inside the stream. */
  readonly error: string | null;
  /** A finish_reason was set: the answer is complete. */
  readonly finished: boolean;
}

/** Reads one parsed stream chunk (or a whole non-stream answer). */
export function readChunk(value: unknown): ChunkInfo {
  if (!value || typeof value !== "object") return { delta: "", error: null, finished: false };
  const record = value as Record<string, unknown>;
  const err = record["error"];
  if (err) {
    const message = typeof err === "string" ? err
      : typeof err === "object" && typeof (err as Record<string, unknown>)["message"] === "string"
        ? (err as Record<string, unknown>)["message"] as string
        : "stream error";
    return { delta: "", error: message.slice(0, 50), finished: false };
  }
  const choices = record["choices"];
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  if (!first || typeof first !== "object") return { delta: "", error: null, finished: false };
  const choice = first as Record<string, unknown>;
  const finished = typeof choice["finish_reason"] === "string" && choice["finish_reason"] !== "";
  // Only `content` counts; `reasoning_content` / `reasoning` are the model thinking aloud.
  const delta = choice["delta"];
  if (delta && typeof delta === "object") {
    const content = (delta as Record<string, unknown>)["content"];
    return { delta: typeof content === "string" ? content : "", error: null, finished };
  }
  const message = choice["message"];
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>)["content"];
    return { delta: typeof content === "string" ? content : "", error: null, finished };
  }
  // Legacy completions shape.
  return { delta: typeof choice["text"] === "string" ? choice["text"] : "", error: null, finished };
}

/**
 * The answer without reasoning, also while it is still arriving: closed
 * `<think>…</think>` blocks go, an unclosed `<think>` hides everything after
 * it, a lone `</think>` (opening tag in the prompt) hides everything before it,
 * and a half-received tag at the end ("<thi") is held back.
 */
export function visibleText(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const close = text.search(/<\/think>/i);
  if (close >= 0) text = text.slice(close + "</think>".length);
  const open = text.search(/<think>/i);
  if (open >= 0) text = text.slice(0, open);
  const tail = /<\/?[a-z]*$/i.exec(text);
  if (tail) {
    const tag = tail[0].toLowerCase();
    if ("<think>".startsWith(tag) || "</think>".startsWith(tag)) text = text.slice(0, tail.index);
  }
  return text;
}

// ------------------------------------------------------------------ the call

const RETRY_STATUSES = new Set([400, 415, 422, 501]);

type Attempt = { readonly result: ChatResult; readonly retry: boolean };

/**
 * One chat completion, streamed when the server can. Never throws.
 */
export async function streamChat(options: ChatCallOptions): Promise<ChatResult> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.totalMs;
  const first = await attempt(options, true, deadline, now);
  if (!first.retry) return first.result;
  const left = deadline - now();
  if (left <= 0) return { ok: false, error: "timed out" };
  return (await attempt(options, false, deadline, now)).result;
}

async function attempt(
  options: ChatCallOptions,
  stream: boolean,
  deadline: number,
  now: () => number,
): Promise<Attempt> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  /** (Re)starts the watchdog, never beyond the overall deadline. */
  const arm = (ms: number): void => {
    clearTimeout(timer);
    const wait = Math.max(0, Math.min(ms, deadline - now()));
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, wait);
  };
  const fail = (error: string, retry = false): Attempt => ({ result: { ok: false, error }, retry });

  arm(stream ? options.firstTokenMs : deadline - now());
  try {
    let response: Response;
    try {
      response = await doFetch(options.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(options.apiKey ? { Authorization: "Bearer " + options.apiKey } : {}),
          ...sessionHeaders,
        },
        signal: controller.signal,
        body: JSON.stringify({ ...options.body, stream }),
      });
    } catch (error) {
      return fail(timedOut ? "timed out" : describeFetchError(error));
    }

    if (!response.ok) {
      return fail("HTTP " + response.status, stream && RETRY_STATUSES.has(response.status));
    }

    const type = (response.headers?.get?.("content-type") ?? "").toLowerCase();
    if (!stream || !type.includes("text/event-stream")) {
      // Plain JSON (a server or proxy that does not stream), or a fallback request.
      let raw: string;
      try { raw = await response.text(); } catch (error) { return fail(timedOut ? "timed out" : describeFetchError(error)); }
      const result = parseWhole(raw);
      if (result.ok && result.text) options.onText?.(visibleText(result.text));
      return { result, retry: false };
    }

    return await readStream(response, options, arm, () => timedOut);
  } finally {
    clearTimeout(timer);
  }
}

/** A complete body: JSON answer, or a whole SSE stream delivered at once. */
function parseWhole(raw: string): ChatResult {
  const trimmed = raw.trim();
  if (trimmed.startsWith("data:")) {
    let text = "";
    let error: string | null = null;
    const parser = createSseParser((data) => {
      for (const value of parseEventData(data)) {
        const chunk = readChunk(value);
        if (chunk.error) error = chunk.error;
        text += chunk.delta;
      }
    });
    parser.push(raw);
    parser.end();
    if (!text && error) return { ok: false, error };
    return { ok: true, text, streamed: false };
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { ok: false, error: "unreadable response" }; }
  if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>)["choices"])) {
    const chunk = readChunk(value);
    return { ok: false, error: chunk.error ?? "unreadable response" };
  }
  const choices = (value as Record<string, unknown>)["choices"] as unknown[];
  const first = choices[0];
  if (!first || typeof first !== "object") return { ok: false, error: "unreadable response" };
  const choice = first as Record<string, unknown>;
  const message = choice["message"];
  if (message && typeof message === "object" && typeof (message as Record<string, unknown>)["content"] === "string") {
    return { ok: true, text: (message as Record<string, unknown>)["content"] as string, streamed: false };
  }
  if (typeof choice["text"] === "string") return { ok: true, text: choice["text"], streamed: false };
  return { ok: false, error: "unreadable response" };
}

/**
 * The JSON values of one event: normally one; several when a server forgot
 * the blank lines between events (one JSON per line). "[DONE]" is skipped.
 */
export function parseEventData(data: string): unknown[] {
  const trimmed = data.trim();
  if (trimmed === "" || trimmed === "[DONE]") return [];
  try { return [JSON.parse(trimmed)]; } catch { /* maybe several */ }
  const values: unknown[] = [];
  for (const part of trimmed.split("\n")) {
    const piece = part.trim();
    if (!piece || piece === "[DONE]") continue;
    try { values.push(JSON.parse(piece)); } catch { /* a broken chunk is skipped */ }
  }
  return values;
}

async function readStream(
  response: Response,
  options: ChatCallOptions,
  arm: (ms: number) => void,
  timedOut: () => boolean,
): Promise<Attempt> {
  let raw = "";
  let shown = "";
  let gotToken = false;
  let done = false;
  let streamError: string | null = null;

  const parser = createSseParser((data) => {
    if (data.trim() === "[DONE]") { done = true; return; }
    for (const value of parseEventData(data)) {
      const chunk = readChunk(value);
      if (chunk.error) streamError = chunk.error;
      if (chunk.finished) done = true;
      if (!chunk.delta) continue;
      raw += chunk.delta;
      if (!gotToken) gotToken = true;
      arm(options.idleMs);
      const visible = visibleText(raw);
      if (visible !== shown) {
        shown = visible;
        options.onText?.(visible);
      }
    }
  });

  const reader = response.body?.getReader?.();
  if (!reader) {
    // No readable stream in this WebView: the whole body at once still works.
    let body: string;
    try { body = await response.text(); } catch (error) {
      return { result: { ok: false, error: timedOut() ? "timed out" : describeFetchError(error) }, retry: false };
    }
    parser.push(body);
    parser.end();
  } else {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        if (value) parser.push(decoder.decode(value, { stream: true }));
        if (done) break;
      }
      parser.push(decoder.decode());
      parser.end();
    } catch (error) {
      if (!gotToken) {
        // Broke before the first token: one ordinary request, unless time is up.
        return timedOut()
          ? { result: { ok: false, error: "timed out" }, retry: false }
          : { result: { ok: false, error: describeFetchError(error) }, retry: true };
      }
      return { result: { ok: false, error: timedOut() ? "timed out" : "interrupted" }, retry: false };
    } finally {
      if (done) void reader.cancel().catch(() => undefined);
    }
  }

  if (!gotToken && streamError) return { result: { ok: false, error: streamError }, retry: true };
  if (!gotToken && !done) return { result: { ok: false, error: "empty stream" }, retry: true };
  if (gotToken && streamError && !done) return { result: { ok: false, error: streamError }, retry: false };
  return { result: { ok: true, text: raw, streamed: true }, retry: false };
}

function describeFetchError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "timed out";
  if (error instanceof Error && error.name === "AbortError") return "timed out";
  if (error instanceof TypeError) return "unreachable";
  if (error instanceof Error && error.message) return error.message.slice(0, 50);
  return "failed";
}

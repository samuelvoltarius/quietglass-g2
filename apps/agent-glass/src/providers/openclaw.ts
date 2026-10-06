import { asRecord, asString, parseEvent, type AgentEvent, type HistoryEntry, type Session } from "../terminal/types";
import type { AgentBackend } from "./backend";

interface OpenClawOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const SESSION_ID = "openclaw-main";

/** Adapter for the existing OpenClaw OpenAI-compatible gateway. */
export class OpenClawBackend implements AgentBackend {
  readonly kind = "openclaw" as const;
  readonly capabilities = { decisions: false, sessions: false, createSession: false } as const;
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #history: HistoryEntry[] = [];
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  #controller: AbortController | null = null;

  constructor(options: OpenClawOptions) {
    this.#base = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? 90000;
  }

  async sessions(): Promise<readonly Session[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.#timeoutMs, 10000));
    const response = await this.#fetch(`${this.#base}/healthz`, {
      headers: this.#headers(), signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (response.status === 401 || response.status === 403) throw new Error("OpenClaw token rejected");
    if (!response.ok) throw new Error(`OpenClaw health HTTP ${response.status}`);
    return [{
      id: SESSION_ID, title: "OpenClaw", cwd: "OpenClaw gateway", provider: "openclaw",
      status: "idle", timestamp: new Date(),
    }];
  }

  history(_sessionId: string): Promise<readonly HistoryEntry[]> { return Promise.resolve([...this.#history]); }
  controllable(): Promise<boolean> { return Promise.resolve(true); }
  subscribe(_sessionId: string, onEvent: (event: AgentEvent) => void, _onError: (message: string) => void): () => void {
    this.#listeners.add(onEvent);
    return () => this.#listeners.delete(onEvent);
  }

  async prompt(_sessionId: string, text: string): Promise<void> {
    // Why a request ended early decides what the user is told: their own
    // interrupt is not an error, a newer prompt silently replaces this one,
    // and only the timer is reported as a timeout.
    this.#controller?.abort("superseded");
    const controller = new AbortController();
    this.#controller = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort("timeout"); }, this.#timeoutMs);
    this.#history.push({ role: "user", text });
    this.#emit(parseEvent({ type: "user_prompt", text }));
    try {
      const response = await this.#fetch(`${this.#base}/v1/chat/completions`, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify({
          model: "openclaw",
          messages: this.#history.map(({ role, text: content }) => ({ role, content })),
        }),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) throw new Error("OpenClaw token rejected");
      if (!response.ok) throw new Error(`OpenClaw HTTP ${response.status}`);
      const content = parseCompletionBody(await response.text());
      if (!content) throw new Error("OpenClaw returned an empty answer");
      if (this.#controller !== controller) return;
      this.#history.push({ role: "assistant", text: content });
      this.#emit(parseEvent({ type: "text", text: content }));
      this.#emit(parseEvent({ type: "result" }));
    } catch (error) {
      if (controller.signal.aborted && !timedOut) {
        // Interrupted by the user, replaced by a newer prompt, or the backend
        // was disposed: nothing went wrong. Only the request that is still
        // current reports the end of its turn.
        if (this.#controller === controller) this.#emit(parseEvent({ type: "result" }));
        return;
      }
      const failure = timedOut ? new Error("OpenClaw timed out") : error;
      this.#emit(parseEvent({ type: "error", message: failure instanceof Error ? failure.message : String(failure) }));
      throw failure;
    } finally {
      clearTimeout(timer);
      if (this.#controller === controller) this.#controller = null;
    }
  }

  async interrupt(): Promise<void> { this.#controller?.abort("interrupt"); }
  async decide(): Promise<void> { throw new Error("OpenClaw does not expose permission decisions"); }
  dispose(): void {
    this.#listeners.clear();
    this.#controller?.abort("disposed");
    this.#controller = null;
  }

  #headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" };
  }
  #emit(event: AgentEvent): void { for (const listener of this.#listeners) listener(event); }
}

/**
 * Reads the answer out of a chat-completions body.
 *
 * The request does not ask for streaming, but a gateway or proxy may still
 * answer as server-sent events. Both shapes are accepted: a JSON object, or
 * `data:` lines whose deltas are joined, stopping at `[DONE]` and skipping
 * comments, blank lines and lines that are not valid JSON.
 */
export function parseCompletionBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  if (!/^(?:data|event|id|retry)\s*:|^:/.test(trimmed)) {
    try { return messageContent(asRecord(JSON.parse(trimmed))); } catch { return ""; }
  }
  let answer = "";
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === "[DONE]") break;
    try {
      const choice = asRecord(firstChoice(asRecord(JSON.parse(data))));
      answer += asString(asRecord(choice["delta"])["content"])
        ?? asString(asRecord(choice["message"])["content"]) ?? "";
    } catch { /* One malformed line must not lose the rest of the answer. */ }
  }
  return answer;
}

function firstChoice(payload: Record<string, unknown>): unknown {
  return Array.isArray(payload["choices"]) ? payload["choices"][0] : undefined;
}

function messageContent(payload: Record<string, unknown>): string {
  return asString(asRecord(asRecord(firstChoice(payload))["message"])["content"]) ?? "";
}

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
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
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
      const payload = asRecord(await response.json());
      const choices = Array.isArray(payload["choices"]) ? payload["choices"] : [];
      const first = asRecord(choices[0]);
      const content = asString(asRecord(first["message"])["content"]);
      if (!content) throw new Error("OpenClaw returned an empty answer");
      this.#history.push({ role: "assistant", text: content });
      this.#emit(parseEvent({ type: "text", text: content }));
      this.#emit(parseEvent({ type: "result" }));
    } catch (error) {
      if (controller.signal.aborted) this.#emit(parseEvent({ type: "result" }));
      else this.#emit(parseEvent({ type: "error", message: error instanceof Error ? error.message : String(error) }));
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.#controller === controller) this.#controller = null;
    }
  }

  async interrupt(): Promise<void> { this.#controller?.abort(); }
  async decide(): Promise<void> { throw new Error("OpenClaw does not expose permission decisions"); }
  dispose(): void { this.#controller?.abort(); this.#listeners.clear(); }

  #headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" };
  }
  #emit(event: AgentEvent): void { for (const listener of this.#listeners) listener(event); }
}

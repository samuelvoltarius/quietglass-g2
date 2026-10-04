import type { HistoryEntry, Session } from "./types";
import { asRecord, asString, parseEvent, type AgentEvent } from "./types";

/**
 * Talking to Even Terminal.
 *
 * Even Terminal is Even Realities' own CLI: it runs on your computer, holds a
 * Claude Code or Codex session, and exposes it over plain HTTP with a bearer
 * token. This client is the glasses end of that.
 *
 * Two things worth knowing before debugging this:
 *
 *   - **Everything lives under `/api`.** A request to `/info` returns 404 and
 *     looks exactly like a dead server; it is `/api/info`. That cost a round
 *     of confused probing.
 *   - **Cross-origin requests are refused unless the server was started with
 *     `--allow-cors`.** The glasses app is served from the Vite port and the
 *     terminal from 3456, so they are different origins and this is not
 *     optional. Without it the symptom is again a server that looks dead.
 */

export interface ClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class TerminalClient {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ClientOptions) {
    this.#base = options.baseUrl.replace(/\/+$/, "") + "/api";
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? 10000;
  }

  get streamBase(): string { return this.#base; }
  get token(): string { return this.#token; }

  async #request(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(this.#base + path, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error("Token rejected");
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async info(): Promise<{ model: string; provider: string }> {
    const raw = asRecord(await this.#request("/info"));
    return {
      model: asString(raw["model"]) ?? "?",
      provider: asString(raw["provider"]) ?? "?",
    };
  }

  /**
   * Whether the server can actually drive this session.
   *
   * `/api/status` is the honest test: it answers 404 for a session Even
   * Terminal merely read off disk, and that is exactly the set of sessions
   * where prompting and answering permissions would fail too.
   */
  async controllable(sessionId: string): Promise<boolean> {
    try {
      await this.#request(`/status?sessionId=${encodeURIComponent(sessionId)}`);
      return true;
    } catch {
      return false;
    }
  }

  async sessions(): Promise<readonly Session[]> {
    const raw = asRecord(await this.#request("/sessions"));
    const list = Array.isArray(raw["sessions"]) ? raw["sessions"] : [];
    return list.flatMap((entry): Session[] => {
      const record = asRecord(entry);
      const id = asString(record["id"]);
      if (!id) return [];
      const stamp = asString(record["timestamp"]);
      return [{
        id,
        title: asString(record["title"]) ?? "(untitled)",
        cwd: asString(record["cwd"]) ?? "",
        provider: asString(record["provider"]) ?? "",
        status: asString(record["status"]) ?? "",
        timestamp: stamp ? new Date(stamp) : new Date(0),
      }];
    });
  }

  async history(sessionId: string): Promise<readonly HistoryEntry[]> {
    const raw = asRecord(await this.#request(`/sessions/${encodeURIComponent(sessionId)}/history`));
    const list = Array.isArray(raw["messages"]) ? raw["messages"]
      : Array.isArray(raw["history"]) ? raw["history"] : [];
    return list.flatMap((entry): HistoryEntry[] => {
      const record = asRecord(entry);
      const text = asString(record["text"]) ?? asString(record["content"]);
      const role = asString(record["role"]);
      if (!text || !role) return [];
      const known = role === "user" || role === "assistant" ? role : "system";
      return [{ role: known, text }];
    });
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    await this.#request("/prompt", {
      method: "POST",
      body: JSON.stringify({ sessionId, text }),
    });
  }

  /**
   * Answers a pending permission request.
   *
   * The server defaults an unrecognised decision to "deny", which is the right
   * way round: a garbled message must never be read as consent.
   */
  async decide(sessionId: string, decision: "allow" | "deny"): Promise<void> {
    await this.#request("/permission-response", {
      method: "POST",
      body: JSON.stringify({ sessionId, decision }),
    });
  }

  async answer(sessionId: string, answer: string): Promise<void> {
    await this.#request("/question-response", {
      method: "POST",
      body: JSON.stringify({ sessionId, answer }),
    });
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.#request("/interrupt", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    });
  }
}

/**
 * Subscribes to the live stream and returns a function that stops it.
 *
 * `EventSource` cannot carry an Authorization header, so the token goes in the
 * query string here. That is normally something to avoid — but the alternative
 * is hand-rolling a streaming fetch parser, and this URL never leaves the
 * device: it is built in the WebView and passed straight to the browser.
 */
export function subscribe(
  client: TerminalClient,
  sessionId: string,
  onEvent: (event: AgentEvent) => void,
  onError: (message: string) => void,
): () => void {
  const url = `${client.streamBase}/events`
    + `?sessionId=${encodeURIComponent(sessionId)}`
    + `&token=${encodeURIComponent(client.token)}`;

  const source = new EventSource(url);

  source.onmessage = (message: MessageEvent<string>): void => {
    // The server sends ":ok" as an SSE comment to open the stream; comments
    // never reach onmessage, but an empty data line can, and JSON.parse would
    // throw on it.
    if (!message.data || !message.data.trim()) return;
    try {
      onEvent(parseEvent(JSON.parse(message.data)));
    } catch {
      // A single malformed frame must not tear down a long-running stream.
    }
  };

  source.onerror = (): void => {
    // EventSource reconnects by itself; this only surfaces the gap so the
    // display can stop pretending it is current.
    onError("Connection interrupted");
  };

  return () => source.close();
}

export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Token/.test(message)) return "Token rejected";
  if (/aborted|timeout/i.test(message)) return "Timed out";
  if (/fetch|network|failed/i.test(message)) return "Even Terminal unreachable";
  return message.slice(0, 60);
}

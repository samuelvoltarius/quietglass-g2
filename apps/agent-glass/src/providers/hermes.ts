import { asRecord, asString, parseEvent, type AgentEvent, type HistoryEntry, type Session } from "../terminal/types";
import type { AgentBackend } from "./backend";

interface HermesOptions {
  readonly url: string;
  readonly token: string;
  readonly WebSocketImpl?: typeof WebSocket;
  readonly timeoutMs?: number;
}

interface PendingWaiter {
  readonly match: (message: Record<string, unknown>) => boolean;
  readonly resolve: (message: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Client for the existing hermes-evenhub-bridge wire protocol. */
export class HermesBackend implements AgentBackend {
  readonly kind = "hermes" as const;
  readonly capabilities = { decisions: false, sessions: true, createSession: true } as const;
  readonly #url: string;
  readonly #token: string;
  readonly #WS: typeof WebSocket;
  readonly #timeoutMs: number;
  #socket: WebSocket | null = null;
  #connecting: Promise<void> | null = null;
  #waiters = new Set<PendingWaiter>();
  #listeners = new Set<(event: AgentEvent) => void>();
  #errors = new Set<(message: string) => void>();
  #activeSession = "";

  constructor(options: HermesOptions) {
    this.#url = options.url;
    this.#token = options.token;
    this.#WS = options.WebSocketImpl ?? globalThis.WebSocket;
    this.#timeoutMs = options.timeoutMs ?? 10000;
  }

  async sessions(): Promise<readonly Session[]> {
    await this.#ensureConnected();
    const waiting = this.#wait((item) => item["t"] === "sessions");
    this.#socket?.send(JSON.stringify({ t: "sessions.list" }));
    const message = await waiting;
    const items = Array.isArray(message["items"]) ? message["items"] : [];
    return items.flatMap((item): Session[] => {
      const value = asRecord(item);
      const id = asString(value["id"]);
      if (!id) return [];
      const updated = typeof value["updated"] === "number" ? value["updated"] : 0;
      return [{
        id,
        title: asString(value["title"]) ?? "Hermes session",
        cwd: "Hermes gateway",
        provider: "hermes",
        status: id === asString(message["active"]) ? "active" : "idle",
        timestamp: new Date(updated * 1000),
      }];
    });
  }

  async history(sessionId: string): Promise<readonly HistoryEntry[]> {
    this.#activeSession = sessionId;
    await this.#ensureConnected();
    const waiting = this.#wait((item) => item["t"] === "history" && item["id"] === sessionId);
    this.#socket?.send(JSON.stringify({ t: "sessions.switch", id: sessionId }));
    const message = await waiting;
    const items = Array.isArray(message["items"]) ? message["items"] : [];
    return items.flatMap((item): HistoryEntry[] => {
      const value = asRecord(item);
      const kind = asString(value["kind"]);
      const text = asString(value["text"]);
      if (!text || (kind !== "user" && kind !== "assistant")) return [];
      return [{ role: kind, text }];
    });
  }

  async controllable(): Promise<boolean> {
    await this.#ensureConnected();
    return true;
  }

  subscribe(_sessionId: string, onEvent: (event: AgentEvent) => void, onError: (message: string) => void): () => void {
    this.#listeners.add(onEvent);
    this.#errors.add(onError);
    void this.#ensureConnected().catch((error) => onError(String(error)));
    return () => { this.#listeners.delete(onEvent); this.#errors.delete(onError); };
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    if (sessionId !== this.#activeSession) {
      await this.#send({ t: "sessions.switch", id: sessionId });
      this.#activeSession = sessionId;
    }
    this.#emit(parseEvent({ type: "user_prompt", text }));
    await this.#send({ t: "text", text });
  }

  async interrupt(): Promise<void> { await this.#send({ t: "stop" }); }

  async decide(): Promise<void> {
    throw new Error("Hermes bridge does not expose external permission decisions");
  }

  async createSession(title = "Agent Glass"): Promise<Session> {
    await this.#ensureConnected();
    const waiting = this.#wait((item) => item["t"] === "active" && Boolean(asString(item["id"])));
    this.#socket?.send(JSON.stringify({ t: "sessions.new", title }));
    const active = await waiting;
    const id = asString(active["id"]);
    if (!id) throw new Error("Hermes bridge returned no session id");
    this.#activeSession = id;
    return { id, title, cwd: "Hermes gateway", provider: "hermes", status: "active", timestamp: new Date() };
  }

  dispose(): void {
    this.#socket?.close();
    this.#socket = null;
    this.#connecting = null;
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Hermes bridge closed"));
    }
    this.#waiters.clear();
    this.#listeners.clear();
    this.#errors.clear();
  }

  async #send(message: Record<string, unknown>): Promise<void> {
    await this.#ensureConnected();
    this.#socket?.send(JSON.stringify(message));
  }

  #wait(match: PendingWaiter["match"]): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const waiter: PendingWaiter = {
        match, resolve, reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error("Hermes bridge timed out"));
        }, this.#timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  #ensureConnected(): Promise<void> {
    if (this.#socket?.readyState === 1) return Promise.resolve();
    if (this.#connecting) return this.#connecting;
    if (!this.#WS) return Promise.reject(new Error("WebSocket unavailable"));
    this.#connecting = new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = new this.#WS(this.#url);
      this.#socket = socket;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; socket.close(); reject(new Error("Hermes bridge timed out")); }
      }, this.#timeoutMs);
      socket.onopen = () => socket.send(JSON.stringify({ t: "hello", token: this.#token, device: "g2-agent-glass" }));
      socket.onmessage = (event) => {
        try {
          const message = asRecord(JSON.parse(String(event.data)));
          this.#receive(message);
          if (!settled && message["t"] === "hello.ok") {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        } catch { /* Ignore one malformed bridge frame. */ }
      };
      socket.onerror = () => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error("Hermes bridge websocket error")); }
      };
      socket.onclose = (event) => {
        this.#socket = null;
        this.#connecting = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(event.code === 1008 ? "Hermes bridge token rejected" : "Hermes bridge closed"));
        }
        for (const notify of this.#errors) notify("Hermes bridge connection interrupted");
      };
    }).finally(() => { this.#connecting = null; });
    return this.#connecting!;
  }

  #receive(message: Record<string, unknown>): void {
    for (const waiter of [...this.#waiters]) {
      if (!waiter.match(message)) continue;
      this.#waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
    const type = asString(message["t"]);
    if (type === "assistant.delta") this.#emit(parseEvent({ type: "text_delta", text: asString(message["text"]) ?? "" }));
    else if (type === "assistant") this.#emit(parseEvent({ type: "text", text: asString(message["text"]) ?? "" }));
    else if (type === "tool.start") this.#emit(parseEvent({ type: "tool_start", tool: asString(message["name"]) ?? "Tool", text: asString(message["label"]) ?? "" }));
    else if (type === "tool.end") this.#emit(parseEvent({ type: "tool_end", tool: asString(message["name"]) ?? "Tool" }));
    else if (type === "turn.done") this.#emit(parseEvent({ type: "result" }));
    else if (type === "error") this.#emit(parseEvent({ type: "error", message: asString(message["msg"]) ?? "Hermes error" }));
  }

  #emit(event: AgentEvent): void { for (const listener of this.#listeners) listener(event); }
}

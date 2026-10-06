import { describe, expect, it } from "vitest";
import { HermesBackend } from "../src/providers/hermes";
import { OpenClawBackend } from "../src/providers/openclaw";
import type { AgentEvent } from "../src/terminal/types";

class FakeHermesSocket {
  static last: FakeHermesSocket | null = null;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeHermesSocket.last = this;
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as Record<string, unknown>;
    this.sent.push(message);
    if (message.t === "hello") this.emit({ t: "hello.ok", caps: {}, active: "h1" });
    if (message.t === "sessions.list") {
      this.emit({ t: "sessions", active: "h1", items: [{ id: "h1", title: "Hermes work", updated: 10 }] });
    }
    if (message.t === "sessions.switch") {
      this.emit({ t: "active", id: message.id });
      this.emit({ t: "history", id: message.id, ok: true, items: [
        { kind: "user", text: "Fix it" }, { kind: "assistant", text: "Working on it." },
      ] });
    }
    if (message.t === "sessions.new") this.emit({ t: "active", id: "new-h" });
    if (message.t === "text") {
      this.emit({ t: "assistant.delta", text: "Done. " });
      this.emit({ t: "tool.start", name: "browser", label: "Checking" });
      this.emit({ t: "tool.end", name: "browser", ok: true });
      this.emit({ t: "turn.done" });
    }
  }

  close(): void { this.readyState = 3; this.onclose?.({ code: 1000, reason: "closed" }); }
  emit(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

describe("Hermes EvenHub bridge adapter", () => {
  it("uses the existing session and history protocol", async () => {
    const backend = new HermesBackend({
      url: "ws://127.0.0.1:8765", token: "bridge-token",
      WebSocketImpl: FakeHermesSocket as unknown as typeof WebSocket,
    });
    const sessions = await backend.sessions();
    expect(sessions[0]).toMatchObject({ id: "h1", provider: "hermes", title: "Hermes work" });
    expect(await backend.history("h1")).toEqual([
      { role: "user", text: "Fix it" }, { role: "assistant", text: "Working on it." },
    ]);
    expect(FakeHermesSocket.last?.sent[0]).toMatchObject({ t: "hello", token: "bridge-token" });
    backend.dispose();
  });

  it("maps streaming replies, tools and completion into Agent Glass events", async () => {
    const backend = new HermesBackend({
      url: "ws://127.0.0.1:8765", token: "x",
      WebSocketImpl: FakeHermesSocket as unknown as typeof WebSocket,
    });
    const events: AgentEvent[] = [];
    const stop = backend.subscribe("h1", (event) => events.push(event), () => undefined);
    await backend.prompt("h1", "Run the check");
    expect(events.map((event) => event.kind)).toEqual([
      "user_prompt", "text_delta", "tool_start", "tool_end", "result",
    ]);
    expect(events.find((event) => event.kind === "tool_start")?.tool).toBe("browser");
    stop();
    backend.dispose();
  });

  it("creates a real Hermes session through the bridge", async () => {
    const backend = new HermesBackend({
      url: "ws://127.0.0.1:8765", token: "x",
      WebSocketImpl: FakeHermesSocket as unknown as typeof WebSocket,
    });
    await expect(backend.createSession("Glasses task")).resolves.toMatchObject({
      id: "new-h", title: "Glasses task", provider: "hermes",
    });
    backend.dispose();
  });
});

describe("OpenClaw gateway adapter", () => {
  it("checks health and sends the proven OpenAI-compatible request shape", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      requests.push(init ? { url, init } : { url });
      if (url.endsWith("/healthz")) return Response.json({ ok: true });
      return Response.json({
        model: "qwen2.5:7b",
        choices: [{ message: { role: "assistant", content: "Gateway answer." } }],
      });
    };
    const backend = new OpenClawBackend({
      baseUrl: "http://127.0.0.1:18789/", token: "gateway-token", fetchImpl,
    });
    expect((await backend.sessions())[0]).toMatchObject({ id: "openclaw-main", provider: "openclaw" });

    const events: AgentEvent[] = [];
    backend.subscribe("openclaw-main", (event) => events.push(event), () => undefined);
    await backend.prompt("openclaw-main", "Hello");

    const completion = requests.find((request) => request.url.endsWith("/v1/chat/completions"));
    const body = JSON.parse(String(completion?.init?.body)) as Record<string, unknown>;
    expect(completion?.init?.headers).toMatchObject({ Authorization: "Bearer gateway-token" });
    expect(body).toMatchObject({ model: "openclaw" });
    expect(events.map((event) => event.kind)).toEqual(["user_prompt", "text", "result"]);
    expect((await backend.history("openclaw-main")).at(-1)).toEqual({
      role: "assistant", text: "Gateway answer.",
    });
  });
});

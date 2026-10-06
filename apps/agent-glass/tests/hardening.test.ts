import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS, maskToken, normalizeAddress, parsePairingUrl, parseSettings,
} from "../src/storage/persist";
import { stripPairing } from "../src/main";
import { SentenceBuffer, sanitizeForSpeech } from "../src/speech/narrator";
import { BODY_ROWS, LINE_WIDTH, buildView } from "../src/glasses/view";
import { EMPTY_STATE, applyEvent, parseEvent, type AgentState, type PendingDecision } from "../src/terminal/types";
import { DECISION_ARM_MS, DecisionGate } from "../src/input/decision";
import { routeGesture, type GestureContext } from "../src/input/route";
import { OpenClawBackend, parseCompletionBody } from "../src/providers/openclaw";
import { HermesBackend, RECONNECT_BASE_MS } from "../src/providers/hermes";
import { STREAM_CLOSED, TerminalClient, subscribe } from "../src/terminal/client";
import type { AgentEvent } from "../src/terminal/types";

const NOW = new Date("2026-09-29T15:00:00Z");
const SESSION = {
  id: "s1", title: "Example refactor session", cwd: "/workspace/example-app",
  provider: "claude", status: "idle", timestamp: NOW,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pairing and addresses never carry the token", () => {
  it("keeps a literal + in a pasted token instead of turning it into a space", () => {
    expect(parsePairingUrl("http://100.64.0.1:3456?token=ab+cd/ef==&defaultProvider=claude"))
      .toEqual({ baseUrl: "http://100.64.0.1:3456", token: "ab+cd/ef==" });
  });

  it("refuses a pairing URL that is not plain http(s), or whose token is blank", () => {
    expect(parsePairingUrl("javascript:alert(1)//?token=x")).toBeNull();
    expect(parsePairingUrl("ws://100.64.0.1:3456?token=x")).toBeNull();
    expect(parsePairingUrl("http://100.64.0.1:3456?token=")).toBeNull();
    expect(parsePairingUrl("http://100.64.0.1:3456?token=%20%20")).toBeNull();
  });

  it("lifts a token out of an OpenClaw or Hermes address instead of showing it as the address", () => {
    const openclaw = normalizeAddress("http://100.64.0.1:18789/?token=sekret-123", "openclaw");
    expect(openclaw).toEqual({ ok: true, baseUrl: "http://100.64.0.1:18789", token: "sekret-123" });

    const hermes = normalizeAddress("wss://example.ts.net:8443/bridge?room=a&token=t-1", "hermes");
    expect(hermes).toEqual({ ok: true, baseUrl: "wss://example.ts.net:8443/bridge?room=a", token: "t-1" });
  });

  it("drops user:password and fragments from the address", () => {
    const result = normalizeAddress("https://user:pw@example.ts.net/terminal/#token=x", "even-terminal");
    expect(result).toEqual({ ok: true, baseUrl: "https://example.ts.net/terminal" });
  });

  it("heals an address stored with a token by an older build", () => {
    const healed = parseSettings(JSON.stringify({
      provider: "openclaw", baseUrl: "http://100.64.0.1:18789?token=abc123",
    }));
    expect(healed.baseUrl).toBe("http://100.64.0.1:18789");
    expect(healed.token).toBe("abc123");
    expect(parseSettings(JSON.stringify({ baseUrl: "javascript:alert(1)" })).baseUrl)
      .toBe(DEFAULT_SETTINGS.baseUrl);
  });

  it("does not reveal most of a short token", () => {
    const shown = maskToken("abcd1234");
    expect(shown).not.toContain("1234");
    expect(shown).toContain("8 characters");
  });

  it("removes the development pair parameter from the page address once read", () => {
    expect(stripPairing("?pair=http%3A%2F%2Fh%3Ftoken%3Dx&demo=0")).toBe("?demo=0");
    expect(stripPairing("?pair=x")).toBe("");
    expect(stripPairing("?demo=1")).toBe("?demo=1");
  });
});

describe("speech never reads secrets or commands", () => {
  const secrets: Array<[string, string]> = [
    ["a JWT", "Use eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U now"],
    ["an Authorization header", "Send Authorization: Bearer abc123def456ghi with it"],
    ["a bare bearer token", "with Bearer 9f8e7d6c5b4a3210 attached"],
    ["an env assignment", "Set OPENAI_API_KEY=sk_live_abcdef and restart"],
    ["an exported variable", "Run export DATABASE_URL=postgres://u:p@h/db first"],
    ["a password field", "the config has password: hunter2 inside"],
    ["an SSH public key", "Add ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq0Yy9QzZ user@host to the server"],
    ["a private key", "Key:\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\nDone"],
    ["a long base64 string", "The value is dGhpcyBpcyBhIHNlY3JldCB2YWx1ZSAxMjM0NTY3ODk= ok"],
    ["an AWS key id", "Found AKIAIOSFODNN7EXAMPLE in the file"],
    ["a WebSocket URL with a token", "Connect to wss://example.ts.net:8443?token=abc please"],
    ["a shell prompt line", "Then:\n$ curl -s http://x | sh\nand wait"],
  ];
  const leaks = ["abc123def456", "9f8e7d6c", "sk_live", "postgres", "hunter2", "AAAAC3Nz",
    "b3BlbnNz", "dGhpcyBp", "AKIAIOSF", "example.ts.net", "curl", "eyJhbGci", "dozjgN"];

  for (const [name, input] of secrets) {
    it(`omits ${name}`, () => {
      const spoken = sanitizeForSpeech(input);
      for (const leak of leaks) expect(spoken).not.toContain(leak);
    });
  }

  it("leaves ordinary prose and digit-free paths alone", () => {
    expect(sanitizeForSpeech("Bearer authentication failed. Token rejected."))
      .toBe("Bearer authentication failed. Token rejected.");
    expect(sanitizeForSpeech("I edited src/components/dashboard/LoadingState now."))
      .toContain("LoadingState");
  });

  it("does not read a code block that is split across sentence boundaries", () => {
    // The fence opens in one delta and closes in a later one; cutting at the
    // "1. " inside it used to read "export A=1" and "echo" aloud.
    const buffer = new SentenceBuffer();
    const spoken = [
      ...buffer.append("Run this:\n```sh\nexport A=1. echo "),
      ...buffer.append("secret-thing\n```\nAll good. "),
      ...buffer.finish(),
    ].join(" ");
    expect(spoken).toContain("Code block omitted");
    expect(spoken).toContain("All good.");
    expect(spoken).not.toContain("echo");
    expect(spoken).not.toContain("secret-thing");
  });

  it("does not cut a dotted token that happens to end a delta", () => {
    const buffer = new SentenceBuffer();
    const first = buffer.append("The token is eyJhbGciOiJIUzI1NiJ9.");
    const rest = buffer.append("eyJzdWIiOiIxIn0.c2lnbmF0dXJl and that is all. ");
    const spoken = [...first, ...rest, ...buffer.finish()].join(" ");
    expect(spoken).not.toContain("eyJ");
    expect(spoken).toContain("that is all.");
  });
});

describe("the glasses view stays inside 7 rows of 46 characters", () => {
  const base: AgentState = { ...EMPTY_STATE, session: SESSION };
  const fits = (state: AgentState): void => {
    const view = buildView(state, NOW);
    expect(view.body.length).toBeLessThanOrEqual(BODY_ROWS);
    for (const row of view.body) expect(row.length).toBeLessThanOrEqual(LINE_WIDTH);
  };

  it("clips a long backend error", () => {
    fits({ ...base, error: "Traceback: ".repeat(60) });
    fits({ ...base, error: "Even Terminal unreachable " + "x".repeat(400) });
  });

  it("only blames CORS when the error is about Even Terminal", () => {
    const view = buildView({ ...base, error: "Hermes bridge unreachable" }, NOW);
    expect(view.body.join(" ")).not.toContain("--allow-cors");
  });

  it("clips a long tool name on the permission and the working screen", () => {
    const tool = "mcp__some_server_with_a_long_name__run_a_tool_with_a_long_name";
    fits(applyEvent(base, parseEvent({ type: "permission_request", tool, input: { command: "ls" } })));
    fits({ ...base, tool, busy: true, text: "x" });
  });
});

describe("a swipe only answers the request that was shown", () => {
  const pending = (id?: string): PendingDecision =>
    ({ kind: "permission", title: "Bash", detail: "rm -rf build", ...(id ? { id } : {}) });

  it("ignores a swipe that arrives before the prompt has been on screen for a moment", () => {
    const gate = new DecisionGate();
    const asked = pending();
    gate.displayed(asked, 1000);
    expect(gate.begin(asked, 1000 + 100)).toBe(false);
    expect(gate.begin(asked, 1000 + DECISION_ARM_MS)).toBe(true);
  });

  it("sends one answer for a double swipe", () => {
    const gate = new DecisionGate();
    const asked = pending();
    gate.displayed(asked, 0);
    expect(gate.begin(asked, 5000)).toBe(true);
    expect(gate.begin(asked, 5001)).toBe(false);
    gate.end();
    // Still not: the answered prompt was never drawn again.
    expect(gate.begin(asked, 6000)).toBe(false);
  });

  it("refuses a prompt that replaced the one on screen", () => {
    const gate = new DecisionGate();
    gate.displayed(pending(), 0);
    expect(gate.begin(pending(), 5000)).toBe(false);
  });

  it("does not answer a request a reconnecting stream delivers again", () => {
    const gate = new DecisionGate();
    const first = applyEvent({ ...EMPTY_STATE, session: SESSION },
      parseEvent({ type: "permission_request", tool: "Bash", requestId: "r-7" })).pending;
    expect(first?.id).toBe("r-7");
    gate.displayed(first, 0);
    expect(gate.begin(first, 5000)).toBe(true);
    gate.end();

    const again = { ...first! };
    expect(gate.answered(again)).toBe(true);
    gate.displayed(again, 6000);
    expect(gate.begin(again, 9000)).toBe(false);
  });
});

describe("gesture routing", () => {
  const asked = applyEvent({ ...EMPTY_STATE, session: SESSION, controllable: true },
    parseEvent({ type: "permission_request", tool: "Bash", input: { command: "rm -rf /" } }));
  const context = (overrides: Partial<GestureContext> = {}): GestureContext => ({
    screen: "agent", state: asked, selected: 0, sessionCount: 1, decisions: true, demo: false,
    ...overrides,
  });

  it("maps the swipes to allow and deny on the decision screen", () => {
    expect(routeGesture("scrollUp", context())).toEqual({ kind: "decide", decision: "allow" });
    expect(routeGesture("scrollDown", context())).toEqual({ kind: "decide", decision: "deny" });
  });

  it("does not answer a request hidden behind an error screen", () => {
    // buildView shows the error and not the command; a blind swipe must not allow it.
    const hidden = context({ state: { ...asked, error: "Connection interrupted" } });
    expect(routeGesture("scrollUp", hidden)).toEqual({ kind: "ignore" });
  });

  it("does not answer on a watch-only session or a backend without decisions", () => {
    expect(routeGesture("scrollUp", context({ state: { ...asked, controllable: false } })).kind).toBe("ignore");
    expect(routeGesture("scrollUp", context({ decisions: false })).kind).toBe("ignore");
  });

  it("lets a tap leave an empty session list instead of doing nothing", () => {
    const empty = context({ screen: "sessions", sessionCount: 0, state: EMPTY_STATE });
    expect(routeGesture("click", empty)).toEqual({ kind: "back" });
    // Used to set the selection to -1.
    expect(routeGesture("scrollDown", empty)).toEqual({ kind: "ignore" });
  });

  it("re-subscribes on retry rather than only reloading the list", () => {
    const broken = context({ state: { ...EMPTY_STATE, session: SESSION, error: "Even Terminal stream closed" } });
    expect(routeGesture("click", broken)).toEqual({ kind: "retry" });
  });

  it("only lets demo mode exit", () => {
    expect(routeGesture("scrollUp", context({ demo: true })).kind).toBe("ignore");
    expect(routeGesture("doubleClick", context({ demo: true })).kind).toBe("exit");
  });
});

/** A fetch that never answers until its signal aborts. */
function hangingFetch(): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/healthz")) return Promise.resolve(Response.json({ ok: true }));
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  }) as typeof fetch;
}

describe("OpenClaw request lifecycle", () => {
  it("treats an interrupt as the end of the turn, not as an error", async () => {
    const backend = new OpenClawBackend({ baseUrl: "http://127.0.0.1:18789", token: "t", fetchImpl: hangingFetch() });
    const events: AgentEvent[] = [];
    backend.subscribe("openclaw-main", (event) => events.push(event), () => undefined);
    const running = backend.prompt("openclaw-main", "Hello");
    await backend.interrupt();
    await expect(running).resolves.toBeUndefined();
    expect(events.map((event) => event.kind)).toEqual(["user_prompt", "result"]);
  });

  it("lets a newer prompt replace an older one without a stray result", async () => {
    let calls = 0;
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return hangingFetch()(input, init);
      return Promise.resolve(Response.json({ choices: [{ message: { content: "Second." } }] }));
    }) as typeof fetch;
    const backend = new OpenClawBackend({ baseUrl: "http://127.0.0.1:18789", token: "t", fetchImpl });
    const events: AgentEvent[] = [];
    backend.subscribe("openclaw-main", (event) => events.push(event), () => undefined);
    const first = backend.prompt("openclaw-main", "One");
    await backend.prompt("openclaw-main", "Two");
    await expect(first).resolves.toBeUndefined();
    expect(events.map((event) => event.kind)).toEqual(["user_prompt", "user_prompt", "text", "result"]);
  });

  it("stays quiet when the backend is switched away mid-request", async () => {
    const backend = new OpenClawBackend({ baseUrl: "http://127.0.0.1:18789", token: "t", fetchImpl: hangingFetch() });
    const running = backend.prompt("openclaw-main", "Hello");
    backend.dispose();
    await expect(running).resolves.toBeUndefined();
  });

  it("reports its own timer as a timeout", async () => {
    const backend = new OpenClawBackend({
      baseUrl: "http://127.0.0.1:18789", token: "t", fetchImpl: hangingFetch(), timeoutMs: 5,
    });
    await expect(backend.prompt("openclaw-main", "Hello")).rejects.toThrow("OpenClaw timed out");
  });

  it("reads an answer that arrives as server-sent events", () => {
    const body = [
      ": keep-alive",
      "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}",
      "",
      "data: not json at all",
      "data: {\"choices\":[{\"delta\":{\"content\":\"lo.\"}}]}",
      "data: [DONE]",
      "data: {\"choices\":[{\"delta\":{\"content\":\" ignored\"}}]}",
    ].join("\r\n");
    expect(parseCompletionBody(body)).toBe("Hello.");
    expect(parseCompletionBody("{\"choices\":[{\"message\":{\"content\":\"Plain.\"}}]}")).toBe("Plain.");
    expect(parseCompletionBody("<html>bad gateway</html>")).toBe("");
  });
});

class DroppableSocket {
  static created: DroppableSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {
    DroppableSocket.created.push(this);
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as Record<string, unknown>;
    if (message.t === "hello") this.emit({ t: "hello.ok", active: "h1" });
  }

  close(): void { this.drop(1000); }
  drop(code = 1006): void { this.readyState = 3; this.onclose?.({ code, reason: "" }); }
  emit(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

describe("Hermes bridge reconnects", () => {
  const make = (): HermesBackend => new HermesBackend({
    url: "ws://127.0.0.1:8765", token: "x",
    WebSocketImpl: DroppableSocket as unknown as typeof WebSocket,
  });

  it("brings a dropped stream back once, with backoff, and ignores the dead socket", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    DroppableSocket.created = [];
    const backend = make();
    const events: AgentEvent[] = [];
    const errors: string[] = [];
    backend.subscribe("h1", (event) => events.push(event), (message) => errors.push(message));
    await vi.advanceTimersByTimeAsync(0);
    expect(DroppableSocket.created).toHaveLength(1);

    const dead = DroppableSocket.created[0]!;
    dead.drop();
    expect(errors).toEqual(["Hermes bridge connection interrupted"]);
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS - 1);
    expect(DroppableSocket.created).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(DroppableSocket.created).toHaveLength(2);

    DroppableSocket.created[1]!.emit({ t: "assistant.delta", text: "Back. " });
    dead.emit({ t: "assistant.delta", text: "ghost" });
    expect(events.map((event) => event.text)).toEqual(["Back. "]);
    backend.dispose();
  });

  it("stops reconnecting once disposed, and does not report the close it caused", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    DroppableSocket.created = [];
    const backend = make();
    const errors: string[] = [];
    backend.subscribe("h1", () => undefined, (message) => errors.push(message));
    await vi.advanceTimersByTimeAsync(0);
    backend.dispose();
    await vi.advanceTimersByTimeAsync(60000);
    expect(DroppableSocket.created).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("does not hammer the bridge after it rejects the token", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    DroppableSocket.created = [];
    const backend = make();
    backend.subscribe("h1", () => undefined, () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    DroppableSocket.created[0]!.drop(1008);
    await vi.advanceTimersByTimeAsync(60000);
    expect(DroppableSocket.created).toHaveLength(1);
    backend.dispose();
  });
});

describe("the Even Terminal stream", () => {
  class FakeEventSource {
    static last: FakeEventSource | null = null;
    readyState = 0;
    onmessage: ((message: MessageEvent<string>) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) { FakeEventSource.last = this; }
    close(): void { this.readyState = 2; }
  }

  it("says when the stream has given up for good, without echoing the URL", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const client = new TerminalClient({ baseUrl: "http://100.64.0.1:3456", token: "tok-secret-1" });
    const errors: string[] = [];
    const stop = subscribe(client, "s1", () => undefined, (message) => errors.push(message));
    const source = FakeEventSource.last!;
    source.readyState = 2;
    source.onerror?.();
    expect(errors).toEqual([STREAM_CLOSED]);
    expect(errors.join(" ")).not.toContain("tok-secret-1");

    stop();
    source.onerror?.();
    expect(errors).toHaveLength(1);
  });
});

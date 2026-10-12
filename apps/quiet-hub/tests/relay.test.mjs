import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeArgs, codexArgs, createRelay, parseArgs, parseCompletionBody, validateConfig, createOpenClawRunner,
} from "../examples/quiet-hub-relay.mjs";
import { handleMessage, summarize } from "../examples/quiet-hub-approve-mcp.mjs";
import { fakeChild, startHub, sleep, until, TOKEN } from "./helpers.mjs";

const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

async function setup(agents, spawnImpl) {
  const h = await startHub({ approvalTimeoutMs: 3000 });
  const mcpDir = mkdtempSync(join(tmpdir(), "relay-mcp-"));
  const relay = createRelay({
    hub: h.url, token: TOKEN, config: validateConfig({ machine: "win", agents }), spawnImpl, mcpDir,
    pollTimeoutMs: 2000, log: () => undefined,
  });
  const loop = relay.start();
  cleanup.push(async () => { relay.stop(); await loop; await h.close(); });
  await until(async () => (await h.api("/agents")).json.agents.every((a) => a.online) && (await h.api("/agents")).json.agents.length === agents.length);
  return { h, relay, mcpDir };
}

describe("config", () => {
  it("validates ids, kinds and modes and defaults sensibly", () => {
    const c = validateConfig({ machine: "my pc!", agents: [{ id: "c", kind: "claude" }, { id: "h", kind: "hermes" }] });
    expect(c.machine).toBe("my-pc-");
    expect(c.agents.map((a) => a.mode)).toEqual(["ask", "auto"]);
    expect(() => validateConfig({ agents: [{ id: "a b", kind: "claude" }] })).toThrow(/id invalid/);
    expect(() => validateConfig({ agents: [{ id: "a", kind: "nope" }] })).toThrow(/kind/);
    expect(() => validateConfig({ agents: [{ id: "a", kind: "claude", mode: "yolo" }] })).toThrow(/mode/);
    expect(() => validateConfig({ agents: [{ id: "a", kind: "claude" }, { id: "a", kind: "codex" }] })).toThrow(/duplicated/);
    expect(() => validateConfig({ agents: [] })).toThrow();
  });

  it("reads the token from env and never needs it on disk", () => {
    expect(parseArgs(["--hub", "https://h", "--config", "x.json"], { HUB_TOKEN: "t" })).toMatchObject({ hub: "https://h", token: "t", config: "x.json" });
  });
});

describe("command lines", () => {
  const ctx = { mcpConfigPath: () => "/tmp/mcp.json" };
  it("claude ask uses the permission-prompt tool, auto bypasses, resume is passed", () => {
    const ask = claudeArgs({ mode: "ask", id: "c" }, ctx, "sess-1");
    expect(ask).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--verbose", "--resume", "sess-1", "--permission-prompt-tool", "mcp__quiethub__approve", "--mcp-config", "/tmp/mcp.json"]));
    expect(ask).not.toContain("bypassPermissions");
    const auto = claudeArgs({ mode: "auto", id: "c" }, ctx, null);
    expect(auto).toEqual(expect.arrayContaining(["--permission-mode", "bypassPermissions"]));
    expect(auto).not.toContain("--permission-prompt-tool");
  });

  it("codex ask stays read-only, auto writes in the workspace, full is explicit", () => {
    expect(codexArgs({ mode: "ask", cwd: "C:\\w" })).toEqual(expect.arrayContaining(["exec", "--json", "-s", "read-only", "-C", "C:\\w", "-"]));
    expect(codexArgs({ mode: "auto" })).toEqual(expect.arrayContaining(["workspace-write"]));
    expect(codexArgs({ mode: "full" })).toContain("--dangerously-bypass-approvals-and-sandbox");
  });
});

describe("relay protocol with a mocked claude", () => {
  it("registers, runs the prompt headless, streams and completes — with events", async () => {
    const spawned = [];
    const spawnImpl = (bin, args, opts) => {
      const child = fakeChild();
      spawned.push({ bin, args, opts, child });
      setImmediate(() => {
        child.emitLines(
          { type: "system", subtype: "init", session_id: "s-9" },
          { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } },
          { type: "assistant", message: { content: [{ type: "text", text: "OK" }] } },
          { type: "result", subtype: "success", is_error: false, result: "OK", session_id: "s-9" },
        );
        child.exit(0);
      });
      return child;
    };
    const { h } = await setup([{ id: "claude-win", kind: "claude", cwd: "C:\\work", mode: "ask" }], spawnImpl);
    await h.api("/agent/ask", { agentId: "claude-win", question: "Antworte nur mit OK", wait: false });
    await until(async () => (await h.api("/agents")).json.agents[0].answer === "OK" && !(await h.api("/agents")).json.agents[0].busy);

    expect(spawned[0].bin).toBe("claude");
    expect(spawned[0].opts.cwd).toBe("C:\\work");
    expect(spawned[0].child.stdinData).toContain("Antworte nur mit OK");
    // the token reaches only the child's environment, never its argument list
    expect(spawned[0].args.join(" ")).not.toContain(TOKEN);
    expect(spawned[0].opts.env.QUIET_HUB_TOKEN).toBe(TOKEN);
    const events = (await h.api("/report")).json.inbox.events;
    expect(events[0]).toMatchObject({ provider: "claude-win", status: "done" });
  });

  it("the MCP config written for Claude holds no secret", async () => {
    const spawnImpl = () => { const c = fakeChild(); setImmediate(() => { c.emitLines({ type: "result", result: "ok" }); c.exit(0); }); return c; };
    const { h, mcpDir } = await setup([{ id: "c", kind: "claude", mode: "ask" }], spawnImpl);
    await h.api("/agent/ask", { agentId: "c", question: "q", wait: false });
    await until(async () => (await h.api("/agents")).json.agents[0].answer === "ok");
    const text = readFileSync(join(mcpDir, "quiethub-mcp-c.json"), "utf8");
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("${QUIET_HUB_TOKEN}");
  });

  it("second session turn resumes the first one", async () => {
    const argsSeen = [];
    const spawnImpl = (bin, args) => {
      argsSeen.push(args);
      const child = fakeChild();
      setImmediate(() => { child.emitLines({ type: "result", is_error: false, result: "ok", session_id: "keep-me" }); child.exit(0); });
      return child;
    };
    const { h } = await setup([{ id: "c", kind: "claude", mode: "auto" }], spawnImpl);
    await h.api("/agent/ask", { agentId: "c", question: "eins", wait: false });
    await until(async () => !(await h.api("/agents")).json.agents[0].busy && argsSeen.length === 1);
    await h.api("/agent/ask", { agentId: "c", question: "zwei", wait: false });
    await until(async () => argsSeen.length === 2);
    expect(argsSeen[1]).toEqual(expect.arrayContaining(["--resume", "keep-me"]));
  });

  it("cancel kills the child and the agent is free again", async () => {
    let child;
    const spawnImpl = (bin) => { const c = fakeChild(); if (bin !== "taskkill") child = c; return c; };
    const { h } = await setup([{ id: "c", kind: "claude", mode: "auto" }], spawnImpl);
    await h.api("/agent/ask", { agentId: "c", question: "lang", wait: false });
    await until(async () => child !== undefined);
    await h.api("/agent/cancel", { agentId: "c" });
    await until(async () => child.killed);
    expect((await h.api("/agents")).json.agents[0].busy).toBe(false);
    // a cancelled run raises no completion event
    expect((await h.api("/report")).json.inbox.events.filter((e) => e.provider === "c")).toEqual([]);
  });

  it("a failing CLI is reported as an error event, not silence", async () => {
    const spawnImpl = () => {
      const child = fakeChild();
      setImmediate(() => { child.stderr.write("boom: not logged in"); child.exit(1); });
      return child;
    };
    const { h } = await setup([{ id: "x", kind: "codex", mode: "ask", engine: "exec" }], spawnImpl);
    await h.api("/agent/ask", { agentId: "x", question: "q", wait: false });
    await until(async () => (await h.api("/report")).json.inbox.events[0]?.status === "error");
    expect((await h.api("/agents")).json.agents[0].answer).toContain("boom");
  });

  it("caps huge output", async () => {
    const spawnImpl = () => {
      const child = fakeChild();
      setImmediate(() => { child.emitLines({ type: "result", is_error: false, result: "y".repeat(100_000) }); child.exit(0); });
      return child;
    };
    const { h } = await setup([{ id: "c", kind: "claude", mode: "auto" }], spawnImpl);
    await h.api("/agent/ask", { agentId: "c", question: "viel", wait: false });
    await until(async () => (await h.api("/agents")).json.agents[0].answer?.length > 100);
    expect((await h.api("/agents")).json.agents[0].answer.length).toBeLessThanOrEqual(4000);
  });

  it("codex output is parsed from JSONL events", async () => {
    const spawnImpl = () => {
      const child = fakeChild();
      setImmediate(() => {
        child.emitLines({ type: "thread.started", thread_id: "t" }, { type: "item.completed", item: { type: "agent_message", text: "Fertig mit Codex" } });
        child.exit(0);
      });
      return child;
    };
    const { h } = await setup([{ id: "codex-win", kind: "codex", mode: "ask", engine: "exec" }], spawnImpl);
    await h.api("/agent/ask", { agentId: "codex-win", question: "tu was", wait: false });
    await until(async () => (await h.api("/agents")).json.agents[0].answer === "Fertig mit Codex");
  });

  it("hermes: uses chat -q -Q and drops the session_id line", async () => {
    let seen;
    const spawnImpl = (bin, args) => {
      const c = fakeChild();
      if (bin !== "taskkill") seen = args;
      setImmediate(() => { c.emitLines("session_id: 20261012_202604_006825", "OK"); c.exit(0); });
      return c;
    };
    const { h } = await setup([{ id: "hermes-spark", kind: "hermes", bin: "hermes" }], spawnImpl);
    await h.api("/agent/ask", { agentId: "hermes-spark", question: "Antworte nur mit OK", wait: false });
    await until(async () => (await h.api("/agents")).json.agents[0].answer === "OK");
    expect(seen.slice(0, 2)).toEqual(["chat", "-q"]);
    expect(seen).toContain("-Q");
    expect(seen).toEqual(expect.arrayContaining(["--format", "stream-json"]));
  });

  it("hermes stream-json: tool steps become activity, text streams, result and session id are kept", async () => {
    const lines = [
      { type: "system", subtype: "init", session_id: "S1" },
      { type: "tool_use", name: "terminal", input: { command: "ls /etc | wc -l" } },
      { type: "tool_result", name: "terminal", output: "{}" },
      { type: "text", text: "\n\nIn /etc " },
      { type: "text", text: "liegen 12 Dateien." },
      { type: "result", session_id: "S1", text: "In /etc liegen 12 Dateien." },
    ];
    const activities = [];
    const spawnImpl = (bin) => {
      const c = fakeChild();
      if (bin !== "taskkill") setImmediate(() => { c.emitLines(...lines.map((l) => JSON.stringify(l))); c.exit(0); });
      return c;
    };
    const { h } = await setup([{ id: "hermes-spark", kind: "hermes", bin: "hermes" }], spawnImpl);
    await h.api("/agent/ask", { agentId: "hermes-spark", question: "Zähl", wait: false });
    await until(async () => {
      const a = (await h.api("/agents")).json.agents[0];
      if (a.activity) activities.push(a.activity);
      return a.answer === "In /etc liegen 12 Dateien." && a.busy === false;
    });
    // One alert per answer (the relay's own "Antwort fertig" is folded in), carrying the answer and its session.
    await until(async () => (await h.api("/report")).json.inbox.events.length > 0);
    const events = (await h.api("/report")).json.inbox.events;
    expect(events.filter((e) => e.agentId === "hermes-spark")).toHaveLength(1);
    expect(events[0]).toMatchObject({ title: "Zähl", detail: "In /etc liegen 12 Dateien.", agentId: "hermes-spark", sessionId: "S1" });
  });

  it("codex app-server: approval request becomes a glasses card, accept/decline is returned", async () => {
    const received = [];
    let child;
    const spawnImpl = (bin, args) => {
      const c = fakeChild();
      if (bin === "taskkill") return c;
      child = c;
      expect(args[0]).toBe("app-server");
      let buf = "";
      c.stdin.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          const m = JSON.parse(line);
          received.push(m);
          if (m.method === "initialize") c.emitLines({ id: m.id, result: {} });
          else if (m.method === "thread/start") c.emitLines({ id: m.id, result: { thread: { id: "th-1" } } });
          else if (m.method === "turn/start") {
            c.emitLines({ id: m.id, result: { turn: { id: "tu-1" } } });
            c.emitLines({ id: 900, method: "item/commandExecution/requestApproval", params: { command: "rm -rf dist" } });
          } else if (m.id === 900) {
            c.emitLines({ method: "item/agentMessage/delta", params: { delta: m.result.decision === "accept" ? "gelöscht" : "abgelehnt" } });
            c.emitLines({ method: "turn/completed", params: { turn: { status: "completed" } } });
          }
        }
      });
      return c;
    };
    const { h } = await setup([{ id: "codex-win", kind: "codex", mode: "ask", cwd: "C:\\w" }], spawnImpl);
    await h.api("/agent/ask", { agentId: "codex-win", question: "räum auf", wait: false });
    const card = await until(async () => (await h.api("/report")).json.approvals[0]);
    expect(card).toMatchObject({ agentId: "codex-win", title: "Bash: rm -rf dist" });
    await h.api("/agent/approve", { cardId: card.id, decision: "deny" });
    await until(async () => (await h.api("/agents")).json.agents[0].answer === "abgelehnt");
    const start = received.find((m) => m.method === "thread/start");
    expect(start.params).toMatchObject({ cwd: "C:\\w", approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(child).toBeDefined();
    expect((await h.api("/report")).json.inbox.events.some((e) => e.provider === "codex-win" && e.status === "done")).toBe(true);
  });

  it("reconnects after the daemon forgot the relay (restart)", async () => {
    const { h, relay } = await setup([{ id: "c", kind: "claude", mode: "auto" }], () => fakeChild());
    // simulate a daemon restart: forget everything
    h.hub.agents.clear();
    h.hub.relays.clear();
    expect((await h.api("/agents")).json.agents).toEqual([]);
    // the next poll cycle gets 404 and re-registers
    await until(async () => (await h.api("/agents")).json.agents.length === 1, 6000);
    expect(relay.relayId).toBe("win");
  });
});

describe("approval end to end: Claude asks, the glasses answer", () => {
  it("the real MCP server process turns a tool call into a card and returns the verdict", async () => {
    const { h } = await setup([{ id: "claude-win", kind: "claude", mode: "ask" }], () => fakeChild());
    const script = new URL("../examples/quiet-hub-approve-mcp.mjs", import.meta.url);
    const child = spawn(process.execPath, [fileURLToPath(script)], {
      env: { ...process.env, QUIET_HUB_URL: h.url, QUIET_HUB_TOKEN: TOKEN, QUIET_HUB_AGENT: "claude-win" },
    });
    cleanup.push(async () => { child.kill(); });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}
`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Bash", input: { command: "git push" }, tool_use_id: "t1" } } });
    const card = await until(async () => (await h.api("/report")).json.approvals[0]);
    expect(card.title).toBe("Bash: git push");
    await h.api("/agent/approve", { cardId: card.id, decision: "allow" });
    await until(async () => output.includes('"id":2'));
    const reply = output.trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.id === 2);
    expect(JSON.parse(reply.result.content[0].text)).toEqual({ behavior: "allow", updatedInput: { command: "git push" } });

    // and a denial, plus the timeout default
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Write", input: { file_path: "a.txt" } } } });
    const card2 = await until(async () => (await h.api("/report")).json.approvals[0]);
    await h.api("/agent/approve", { cardId: card2.id, decision: "deny" });
    await until(async () => output.includes('"id":3'));
    const denied = output.trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.id === 3);
    expect(JSON.parse(denied.result.content[0].text).behavior).toBe("deny");

    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Bash", input: { command: "ls" } } } });
    await until(async () => output.includes('"id":4'), 6000); // hub timeout is 3 s in this test
    const timedOut = output.trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.id === 4);
    expect(JSON.parse(timedOut.result.content[0].text).behavior).toBe("deny");
  });
});

describe("approve MCP server", () => {
  it("speaks MCP: initialize, tools/list and a safe default of deny without a hub", async () => {
    const out = [];
    await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, (m) => out.push(m));
    expect(out[0].result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} } });
    await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, (m) => out.push(m));
    expect(out[1].result.tools[0].name).toBe("approve");
    await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Bash", input: { command: "ls" } } } }, (m) => out.push(m));
    expect(JSON.parse(out[2].result.content[0].text)).toMatchObject({ behavior: "deny" });
    await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, (m) => out.push(m));
    expect(out).toHaveLength(3);
  });

  it("summarizes command, file and path for the card title", () => {
    expect(summarize("Bash", { command: "npm   test\n--ci" })).toEqual({ tool: "Bash", summary: "npm test --ci" });
    expect(summarize("Edit", { file_path: "src/a.ts" }).summary).toBe("src/a.ts");
    expect(summarize("Write", { path: "x".repeat(500) }).summary.length).toBe(140);
  });
});

describe("OpenClaw gateway", () => {
  it("posts chat completions with a bearer token and keeps the history", async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: `a${seen.length}` } }] }), { status: 200 });
    };
    const run = createOpenClawRunner({ url: "http://claw:18789/", token: "tok", mode: "auto" }, { fetch: fetchImpl });
    expect((await run({ prompt: "eins" }, () => undefined)).text).toBe("a1");
    await run({ prompt: "zwei" }, () => undefined);
    expect(seen[0].url).toBe("http://claw:18789/v1/chat/completions");
    expect(seen[0].headers.Authorization).toBe("Bearer tok");
    expect(seen[1].body.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("explains a rejected token and parses SSE answers", async () => {
    const run = createOpenClawRunner({ url: "http://c", token: "bad" }, { fetch: async () => new Response("", { status: 401 }) });
    expect(await run({ prompt: "x" }, () => undefined)).toMatchObject({ status: "error", error: "OpenClaw token rejected" });
    expect(parseCompletionBody('data: {"choices":[{"delta":{"content":"Hal"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n')).toBe("Hallo");
  });
});

describe("token hygiene", () => {
  it("the relay source never prints the token", () => {
    const src = readFileSync(new URL("../examples/quiet-hub-relay.mjs", import.meta.url), "utf8");
    expect(src).not.toMatch(/log\([^)]*token/i);
    expect(src).not.toMatch(/console\.(log|error)\([^)]*\.token/);
  });
});

void sleep;

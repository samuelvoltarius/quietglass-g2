#!/usr/bin/env node
/**
 * Quiet Hub agent relay — connects the agents of THIS machine to the hub.
 *
 * The relay only ever connects OUTWARD to the daemon (HTTPS long-poll, bearer
 * token), so a Windows PC behind NAT needs no open port. It registers the
 * agents named in relay.json, receives prompts, runs the local CLI headless
 * and streams the answer back. Permission questions of Claude Code travel to
 * the glasses through quiet-hub-approve-mcp.mjs (same folder).
 *
 *   node quiet-hub-relay.mjs --hub https://pi5.example.ts.net --config relay.json
 *   HUB_TOKEN=... node quiet-hub-relay.mjs --hub http://127.0.0.1:8787
 *
 * Token: env HUB_TOKEN (preferred), --token-file <path>, or --token <value>.
 * The token is never printed and never written to disk by the relay.
 *
 * relay.json:
 *   { "machine": "windows-pc",
 *     "agents": [
 *       { "id": "claude-win", "kind": "claude", "cwd": "F:\\work", "mode": "ask" },
 *       { "id": "codex-win",  "kind": "codex",  "cwd": "F:\\work", "mode": "ask" },
 *       { "id": "hermes-spark", "kind": "hermes", "bin": "hermes" },
 *       { "id": "claw", "kind": "openclaw", "url": "http://127.0.0.1:18789", "tokenEnv": "OPENCLAW_TOKEN" } ] }
 *
 * Dependency-free: Node 22+ (global fetch / WebSocket).
 */
import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_TEXT = 20_000; // hard cap of accumulated output per answer
export const SEND_TEXT = 4_000; // tail that is sent to the hub
export const DEFAULT_TIMEOUT_MS = 600_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const BRIEF_DE = "\n\n(Antworte knapp auf Deutsch, höchstens etwa 280 Zeichen, ohne Markdown.)";

const clip = (text, max) => (text.length > max ? text.slice(text.length - max) : text);
const oneLine = (text, max = 120) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

// ---------------------------------------------------------------- config

export const KINDS = ["claude", "codex", "hermes", "openclaw"];
export const MODES = ["ask", "auto", "plan", "readonly", "full"];

export function validateConfig(raw) {
  const machine = String(raw?.machine || hostname()).replace(/[^\w.-]/g, "-").slice(0, 40);
  if (!Array.isArray(raw?.agents) || raw.agents.length === 0) throw new Error("relay.json: agents[] is empty");
  const seen = new Set();
  const agents = raw.agents.map((a) => {
    if (!a || typeof a.id !== "string" || !/^[\w.-]{1,40}$/.test(a.id)) throw new Error(`agent id invalid: ${a?.id}`);
    if (seen.has(a.id)) throw new Error(`agent id duplicated: ${a.id}`);
    seen.add(a.id);
    if (!KINDS.includes(a.kind)) throw new Error(`agent ${a.id}: kind must be one of ${KINDS.join(", ")}`);
    const mode = a.mode ?? (a.kind === "claude" || a.kind === "codex" ? "ask" : "auto");
    if (!MODES.includes(mode)) throw new Error(`agent ${a.id}: mode must be one of ${MODES.join(", ")}`);
    return { ...a, mode, brief: a.brief !== false };
  });
  return { machine, agents };
}

export function loadConfig(path) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    throw new Error(`${path}: not valid JSON (${error.message}). On Windows write paths as "C:/work" or "C:\\work".`);
  }
  return validateConfig(raw);
}

// ------------------------------------------------------------ child process

function killTree(child, spawnImpl) {
  try {
    if (process.platform === "win32" && child.pid) {
      spawnImpl("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      child.kill();
    } else {
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 3000).unref?.();
    }
  } catch { /* already gone */ }
}

/**
 * Runs one child process. `onLine` gets stdout line by line. Resolves with
 * {code, stderr, timedOut, cancelled}. Output beyond the caps is dropped.
 */
export function runProcess({ spawn, bin, args, cwd, env, stdin, onLine, timeoutMs, signal }) {
  return new Promise((resolve) => {
    let child;
    const useShell = /\.(cmd|bat)$/i.test(bin);
    try {
      child = spawn(bin, args, { cwd, env, shell: useShell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: -1, stderr: String(error?.message ?? error), timedOut: false, cancelled: false });
      return;
    }
    let stderr = "";
    let buffer = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (buffer !== "") { try { onLine(buffer); } catch { /* ignore */ } }
      resolve({ code, stderr: stderr.slice(-1500), timedOut, cancelled });
    };
    const timer = setTimeout(() => { timedOut = true; killTree(child, spawn); }, timeoutMs ?? DEFAULT_TIMEOUT_MS);
    signal?.addEventListener("abort", () => { cancelled = true; killTree(child, spawn); }, { once: true });
    child.on("error", (error) => { stderr += String(error?.message ?? error); finish(-1); });
    child.on("close", (code) => finish(code ?? -1));
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 4_000_000) buffer = buffer.slice(-1_000_000);
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        try { onLine(line); } catch { /* one bad line must not stop the run */ }
      }
    });
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", (chunk) => { stderr = clip(stderr + chunk, 3000); });
    child.stdin?.on?.("error", () => undefined);
    if (stdin !== undefined) child.stdin?.end(stdin); else child.stdin?.end();
  });
}

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (!("QUIET_HUB_TOKEN" in extra)) { delete env.QUIET_HUB_TOKEN; delete env.HUB_TOKEN; }
  return env;
}

// ------------------------------------------------------------------ runners
// A runner is async (job, emit) => {status:"done"|"error"|"cancelled", text, error?}
// `emit({text, activity})` reports progress; `job.signal` cancels.

function finalStatus(res, text, fallbackError) {
  if (res.cancelled) return { status: "cancelled", text };
  if (res.timedOut) return { status: "error", text, error: "timeout" };
  if (res.code !== 0 && text.trim() === "") return { status: "error", text, error: oneLine(res.stderr || fallbackError || `exit ${res.code}`, 200) };
  return { status: "done", text: text.trim() === "" ? "(keine Antwort)" : text };
}

export function claudeArgs(agent, ctx, sessionId) {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (agent.model) args.push("--model", agent.model);
  if (sessionId) args.push("--resume", sessionId);
  if (agent.mode === "auto" || agent.mode === "full") {
    args.push("--permission-mode", "bypassPermissions");
  } else if (agent.mode === "plan" || agent.mode === "readonly") {
    args.push("--permission-mode", "plan");
  } else {
    args.push("--mcp-config", ctx.mcpConfigPath(agent), "--permission-prompt-tool", "mcp__quiethub__approve");
  }
  if (Array.isArray(agent.args)) args.push(...agent.args.map(String));
  return args;
}

export function createClaudeRunner(agent, ctx) {
  let sessionId = null;
  return async (job, emit) => {
    let text = "";
    let finalText = "";
    let isError = false;
    const env = childEnv(agent.mode === "ask"
      ? { QUIET_HUB_URL: ctx.hub, QUIET_HUB_TOKEN: ctx.token, QUIET_HUB_AGENT: agent.id }
      : {});
    const res = await runProcess({
      spawn: ctx.spawn, bin: agent.bin ?? "claude", args: claudeArgs(agent, ctx, sessionId),
      cwd: agent.cwd, env, stdin: job.prompt, timeoutMs: agent.timeoutMs, signal: job.signal,
      onLine: (line) => {
        if (!line.startsWith("{")) return;
        const obj = JSON.parse(line);
        if (obj.session_id && typeof obj.session_id === "string") sessionId = obj.session_id;
        if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
          const parts = obj.message.content;
          const t = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
          if (t) { text = clip(t, MAX_TEXT); emit({ text, activity: "" }); }
          const tool = parts.find((p) => p.type === "tool_use");
          if (tool) {
            const i = tool.input ?? {};
            emit({ text, activity: oneLine(`${tool.name}: ${i.command ?? i.file_path ?? i.path ?? i.pattern ?? ""}`, 80) });
          }
        } else if (obj.type === "result") {
          finalText = typeof obj.result === "string" ? clip(obj.result, MAX_TEXT) : "";
          isError = obj.is_error === true;
        }
      },
    });
    const out = finalText || text;
    const status = finalStatus(res, out, "claude failed");
    if (status.status === "done" && isError) return { status: "error", text: out, error: oneLine(out, 200) };
    return status;
  };
}

export function codexArgs(agent) {
  const args = ["exec", "--json", "--skip-git-repo-check"];
  if (agent.cwd) args.push("-C", agent.cwd);
  if (agent.model) args.push("-m", agent.model);
  // `codex exec` cannot ask interactively: "ask" therefore stays read-only.
  if (agent.mode === "full") args.push("--dangerously-bypass-approvals-and-sandbox");
  else if (agent.mode === "auto") args.push("-s", "workspace-write");
  else args.push("-s", "read-only");
  if (Array.isArray(agent.args)) args.push(...agent.args.map(String));
  args.push("-");
  return args;
}

export function createCodexExecRunner(agent, ctx) {
  return async (job, emit) => {
    let text = "";
    const raw = [];
    const res = await runProcess({
      spawn: ctx.spawn, bin: agent.bin ?? "codex", args: codexArgs(agent), cwd: agent.cwd,
      env: childEnv(), stdin: job.prompt, timeoutMs: agent.timeoutMs, signal: job.signal,
      onLine: (line) => {
        if (line.startsWith("{")) {
          let obj;
          try { obj = JSON.parse(line); } catch { return; }
          const item = obj.item ?? obj.msg ?? {};
          const kind = item.type ?? obj.type;
          if ((kind === "agent_message" || kind === "message") && typeof (item.text ?? item.message) === "string") {
            text = clip(String(item.text ?? item.message), MAX_TEXT);
            emit({ text, activity: "" });
          } else if (kind === "command_execution" || kind === "exec_command_begin") {
            const cmd = Array.isArray(item.command) ? item.command.join(" ") : item.command;
            emit({ text, activity: oneLine(`exec: ${cmd ?? ""}`, 80) });
          } else if (kind === "file_change" || kind === "patch_apply_begin") {
            emit({ text, activity: "patch" });
          }
        } else if (line.trim() !== "") {
          raw.push(line);
        }
      },
    });
    return finalStatus(res, text || raw.join("\n").slice(-MAX_TEXT), "codex failed");
  };
}

/**
 * Codex through `codex app-server` (JSON-RPC over stdin/stdout, no PTY).
 * Unlike `codex exec` it can ASK: approval requests of the agent are forwarded
 * to the daemon and decided on the glasses.
 *
 * Codex app-server protocol handling adapted from sunasaji/terminal-mode-console
 * (MIT, (c) 2026 S.Suna): initialize, thread/start|resume, turn/start,
 * item/agentMessage/delta, the three requestApproval requests, turn/completed.
 * See NOTICE.md in this app for the full attribution.
 */
export const CODEX_POLICY = {
  ask: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  auto: { approvalPolicy: "never", sandbox: "workspace-write" },
  readonly: { approvalPolicy: "never", sandbox: "read-only" },
  plan: { approvalPolicy: "never", sandbox: "read-only" },
  full: { approvalPolicy: "never", sandbox: "danger-full-access" },
};

export function createCodexRunner(agent, ctx) {
  if (agent.engine === "exec") return createCodexExecRunner(agent, ctx);
  let threadId = null;
  const policy = CODEX_POLICY[agent.mode] ?? CODEX_POLICY.ask;
  return (job, emit) => new Promise((resolve) => {
    let full = "";
    let nextId = 1;
    let buffer = "";
    let turnId = null;
    let settled = false;
    let child;
    const pending = new Map();
    const bin = agent.bin ?? "codex";
    try {
      child = ctx.spawn(bin, ["app-server", ...(Array.isArray(agent.args) ? agent.args.map(String) : [])], {
        cwd: agent.cwd, env: childEnv(), shell: /\.(cmd|bat)$/i.test(bin), windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ status: "error", text: "", error: oneLine(error?.message ?? error, 200) });
      return;
    }
    let stderr = "";
    const write = (message) => { try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* closed */ } };
    const request = (method, params = {}) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      write({ id, method, params });
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const p of pending.values()) p.rej(new Error("closed"));
      pending.clear();
      killTree(child, ctx.spawn);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: "error", text: full, error: "timeout" }), agent.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    job.signal?.addEventListener("abort", () => {
      if (threadId && turnId) write({ id: nextId++, method: "turn/interrupt", params: { threadId, turnId } });
      setTimeout(() => finish({ status: "cancelled", text: full }), 200);
    }, { once: true });

    async function askGlasses(tool, summary) {
      try {
        const res = await ctx.fetch(`${ctx.hub}/relay/permission`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ agentId: agent.id, tool, summary: oneLine(summary, 140) }),
          signal: AbortSignal.timeout(agent.approvalTimeoutMs ?? 130_000),
        });
        if (!res.ok) return "deny";
        return (await res.json()).decision === "allow" ? "allow" : "deny";
      } catch { return "deny"; }
    }

    async function onServerRequest(msg) {
      const p = msg.params ?? {};
      if (msg.method === "item/commandExecution/requestApproval" || msg.method === "item/fileChange/requestApproval") {
        const command = msg.method.includes("commandExecution");
        const detail = String(p.command ?? p.reason ?? p.grantRoot ?? "");
        const verdict = await askGlasses(command ? "Bash" : "apply_patch", detail || (command ? "command" : "file change"));
        write({ id: msg.id, result: { decision: verdict === "allow" ? "accept" : "decline" } });
      } else if (msg.method === "item/permissions/requestApproval") {
        const verdict = await askGlasses("permissions", String(p.reason ?? "additional permissions"));
        write({ id: msg.id, result: { permissions: verdict === "allow" ? (p.permissions ?? {}) : {}, scope: "turn" } });
      } else {
        write({ id: msg.id, error: { code: -32601, message: `unsupported request: ${msg.method}` } });
      }
    }

    function onNotification(method, p) {
      const item = p.item ?? {};
      if (method === "item/agentMessage/delta") {
        full = clip(full + String(p.delta ?? ""), MAX_TEXT);
        emit({ text: full, activity: "" });
      } else if (method === "item/started") {
        const name = item.type === "commandExecution" ? `exec: ${item.command ?? ""}` : item.type === "fileChange" ? "apply_patch" : item.type === "mcpToolCall" ? `${item.server ?? "mcp"}.${item.tool ?? "tool"}` : "";
        if (name) emit({ text: full, activity: oneLine(name, 80) });
      } else if (method === "turn/completed") {
        const turn = p.turn ?? {};
        if (turn.status === "failed") finish({ status: "error", text: full, error: oneLine(turn.error?.message ?? "turn failed", 200) });
        else finish({ status: "done", text: full.trim() === "" ? "(keine Antwort)" : full });
      }
    }

    child.on("error", (error) => finish({ status: "error", text: full, error: oneLine(error?.message ?? error, 200) }));
    child.on("close", (code) => finish(full !== "" && code === 0 ? { status: "done", text: full } : { status: "error", text: full, error: oneLine(stderr || `codex exited (${code})`, 200) }));
    child.stderr?.on?.("data", (d) => { stderr = clip(stderr + d, 1500); });
    child.stdin?.on?.("error", () => undefined);
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line.startsWith("{")) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && !msg.method) {
          const p = pending.get(msg.id);
          if (p) { pending.delete(msg.id); if (msg.error) p.rej(new Error(msg.error.message ?? "rpc error")); else p.res(msg.result); }
        } else if (msg.id !== undefined && msg.method) {
          void onServerRequest(msg);
        } else if (msg.method) {
          onNotification(msg.method, msg.params ?? {});
        }
      }
    });

    (async () => {
      try {
        await request("initialize", { clientInfo: { name: "quiet-hub-relay", title: "Quiet Hub relay", version: "0.3.0" }, capabilities: { experimentalApi: true } });
        write({ method: "initialized", params: {} });
        let started = null;
        if (threadId) started = await request("thread/resume", { threadId }).catch(() => null);
        if (!started) {
          started = await request("thread/start", { cwd: agent.cwd, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox, serviceName: "quiet-hub" });
          threadId = String(started?.thread?.id ?? "");
        }
        const turn = await request("turn/start", { threadId, input: [{ type: "text", text: job.prompt }], ...(agent.model ? { model: agent.model } : {}) });
        turnId = String(turn?.turn?.id ?? "") || null;
      } catch (error) {
        finish({ status: "error", text: full, error: oneLine(error?.message ?? error, 200) });
      }
    })();
  });
}

export function createHermesRunner(agent, ctx) {
  if (agent.url) return createHermesBridgeRunner(agent, ctx);
  return async (job, emit) => {
    let out = "";
    const res = await runProcess({
      spawn: ctx.spawn, bin: agent.bin ?? "hermes", args: ["chat", "-q", job.prompt, "-Q", ...(agent.format ? ["--format", String(agent.format)] : [])],
      cwd: agent.cwd, env: childEnv(), timeoutMs: agent.timeoutMs, signal: job.signal,
      onLine: (line) => {
        // -Q still prints a "session_id: ..." line on some Hermes versions.
        if (/^session_id:\s*\S+\s*$/.test(line)) return;
        out = clip(`${out}${out ? "\n" : ""}${line}`, MAX_TEXT);
        emit({ text: out, activity: "" });
      },
    });
    return finalStatus(res, out, "hermes failed");
  };
}

/** Hermes evenhub-bridge wire protocol: {t:"hello"} → {t:"text"} → assistant.delta … turn.done. */
export function createHermesBridgeRunner(agent, ctx) {
  const token = agent.token ?? (agent.tokenEnv ? process.env[agent.tokenEnv] : "") ?? "";
  return (job, emit) => new Promise((resolve) => {
    const WS = ctx.WebSocket ?? globalThis.WebSocket;
    if (!WS) { resolve({ status: "error", text: "", error: "WebSocket unavailable" }); return; }
    let text = "";
    let settled = false;
    const socket = new WS(agent.url);
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* closed */ }
      resolve(result);
    };
    const timer = setTimeout(() => done({ status: "error", text, error: "timeout" }), agent.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    job.signal?.addEventListener("abort", () => {
      try { socket.send(JSON.stringify({ t: "stop" })); } catch { /* ignore */ }
      done({ status: "cancelled", text });
    }, { once: true });
    socket.onopen = () => socket.send(JSON.stringify({ t: "hello", token, device: "quiet-hub-relay" }));
    socket.onerror = () => done({ status: "error", text, error: "bridge websocket error" });
    socket.onclose = (event) => done(text !== "" ? { status: "done", text } : { status: "error", text, error: event?.code === 1008 ? "token rejected" : "bridge closed" });
    socket.onmessage = (event) => {
      let m;
      try { m = JSON.parse(String(event.data)); } catch { return; }
      if (m.t === "hello.ok") socket.send(JSON.stringify({ t: "text", text: job.prompt }));
      else if (m.t === "assistant.delta") { text = clip(text + String(m.text ?? ""), MAX_TEXT); emit({ text, activity: "" }); }
      else if (m.t === "assistant" && typeof m.text === "string") { text = clip(m.text, MAX_TEXT); emit({ text, activity: "" }); }
      else if (m.t === "tool.start") emit({ text, activity: oneLine(`${m.name ?? "tool"} ${m.label ?? ""}`, 80) });
      else if (m.t === "turn.done") done({ status: "done", text: text || "(keine Antwort)" });
      else if (m.t === "error") done({ status: "error", text, error: oneLine(m.msg ?? "Hermes error", 200) });
    };
  });
}

/** Reads a chat-completions body (JSON or SSE) — ported from agent-glass. */
export function parseCompletionBody(body) {
  const trimmed = String(body).trim();
  if (!trimmed) return "";
  if (!/^(?:data|event|id|retry)\s*:|^:/.test(trimmed)) {
    try { return JSON.parse(trimmed)?.choices?.[0]?.message?.content ?? ""; } catch { return ""; }
  }
  let answer = "";
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === "[DONE]") break;
    try {
      const choice = JSON.parse(data)?.choices?.[0] ?? {};
      answer += choice.delta?.content ?? choice.message?.content ?? "";
    } catch { /* one bad line must not lose the answer */ }
  }
  return answer;
}

export function createOpenClawRunner(agent, ctx) {
  const history = [];
  const token = agent.token ?? (agent.tokenEnv ? process.env[agent.tokenEnv] : "") ?? "";
  const base = String(agent.url ?? "").replace(/\/+$/, "");
  return async (job, emit) => {
    history.push({ role: "user", content: job.prompt });
    while (history.length > 20) history.shift();
    const controller = new AbortController();
    job.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    const timer = setTimeout(() => controller.abort("timeout"), agent.timeoutMs ?? 90_000);
    try {
      const res = await ctx.fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: agent.model ?? "openclaw", messages: history }),
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) return { status: "error", text: "", error: "OpenClaw token rejected" };
      if (!res.ok) return { status: "error", text: "", error: `OpenClaw HTTP ${res.status}` };
      const content = clip(parseCompletionBody(await res.text()), MAX_TEXT);
      if (!content) return { status: "error", text: "", error: "OpenClaw returned an empty answer" };
      history.push({ role: "assistant", content });
      emit({ text: content, activity: "" });
      return { status: "done", text: content };
    } catch (error) {
      if (job.signal?.aborted) return { status: "cancelled", text: "" };
      return { status: "error", text: "", error: controller.signal.aborted ? "timeout" : oneLine(error?.message ?? error, 200) };
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createRunner(agent, ctx) {
  switch (agent.kind) {
    case "claude": return createClaudeRunner(agent, ctx);
    case "codex": return createCodexRunner(agent, ctx);
    case "hermes": return createHermesRunner(agent, ctx);
    default: return createOpenClawRunner(agent, ctx);
  }
}

// -------------------------------------------------------------------- relay

export function createRelay(options) {
  const hub = String(options.hub ?? "").replace(/\/+$/, "");
  const token = options.token ?? "";
  const config = options.config;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const log = options.log ?? ((...a) => console.log("[relay]", ...a));
  const approveScript = options.approveScript ?? join(HERE, "quiet-hub-approve-mcp.mjs");
  const mcpDir = options.mcpDir ?? tmpdir();
  const pollMs = options.pollTimeoutMs ?? 40_000;
  const ctx = {
    hub, token, fetch: fetchImpl, spawn: options.spawnImpl ?? nodeSpawn, WebSocket: options.WebSocket,
    /** MCP config WITHOUT secrets: the token reaches the MCP child via ${VAR} expansion. */
    mcpConfigPath(agent) {
      const path = join(mcpDir, `quiethub-mcp-${agent.id}.json`);
      const body = { mcpServers: { quiethub: {
        command: process.execPath,
        args: [approveScript],
        env: { QUIET_HUB_URL: "${QUIET_HUB_URL}", QUIET_HUB_TOKEN: "${QUIET_HUB_TOKEN}", QUIET_HUB_AGENT: "${QUIET_HUB_AGENT}" },
      } } };
      writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
      return path;
    },
  };
  const runners = new Map(config.agents.map((a) => [a.id, createRunner(a, ctx)]));
  const agentCfg = new Map(config.agents.map((a) => [a.id, a]));
  const running = new Map(); // agentId -> AbortController
  const stop = new AbortController();
  let relayId = null;

  const call = async (path, body, init = {}) => fetchImpl(`${hub}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });

  async function register() {
    const res = await call("/relay/register", {
      machine: config.machine,
      agents: config.agents.map((a) => ({ id: a.id, kind: a.kind, mode: a.mode, label: a.label ?? a.id })),
    });
    if (res.status === 401) throw Object.assign(new Error("hub rejected the token"), { fatal: true });
    if (!res.ok) throw new Error(`register HTTP ${res.status}`);
    relayId = (await res.json()).relayId;
    log(`registered ${config.agents.length} agent(s) as machine "${config.machine}"`);
  }

  async function runJob(command) {
    const agent = agentCfg.get(command.agentId);
    const runner = runners.get(command.agentId);
    const post = (payload) => call("/relay/result", { jobId: command.jobId, ...payload }).catch(() => undefined);
    if (!agent || !runner) { await post({ status: "error", error: "unknown agent" }); return; }
    if (running.has(agent.id)) { await post({ status: "error", error: "agent busy" }); return; }
    const controller = new AbortController();
    running.set(agent.id, controller);
    const prompt = agent.brief && !command.raw ? `${command.prompt}${BRIEF_DE}` : command.prompt;

    let latest = { text: "", activity: "" };
    let lastSent = 0;
    let timer = null;
    const flush = () => {
      timer = null;
      lastSent = Date.now();
      void post({ status: "running", text: clip(latest.text, SEND_TEXT), activity: latest.activity });
    };
    const emit = (update) => {
      latest = update;
      const wait = 800 - (Date.now() - lastSent);
      if (wait <= 0) { if (timer) clearTimeout(timer); flush(); }
      else if (!timer) timer = setTimeout(flush, wait);
    };
    let result;
    try {
      result = await runner({ prompt, signal: controller.signal }, emit);
    } catch (error) {
      result = { status: "error", text: latest.text, error: oneLine(error?.message ?? error, 200) };
    }
    if (timer) clearTimeout(timer);
    running.delete(agent.id);
    await post({ status: result.status, text: clip(result.text ?? "", SEND_TEXT), error: result.error ?? null, activity: "" });
    if (result.status !== "cancelled") {
      await call("/events", {
        provider: agent.id,
        status: result.status === "done" ? "done" : "error",
        title: result.status === "done" ? "Antwort fertig" : `Fehler: ${result.error ?? "?"}`.slice(0, 120),
        detail: oneLine(command.prompt, 100),
      }).catch(() => undefined);
    }
  }

  function dispatch(command) {
    if (command.type === "ask") void runJob(command);
    else if (command.type === "cancel") running.get(command.agentId)?.abort();
  }

  async function loop() {
    let failures = 0;
    while (!stop.signal.aborted) {
      try {
        if (relayId === null) await register();
        const res = await call(`/relay/poll?relay=${encodeURIComponent(relayId)}`, undefined, { signal: AbortSignal.timeout(pollMs) });
        if (res.status === 404) { relayId = null; continue; }
        if (res.status === 401) throw Object.assign(new Error("hub rejected the token"), { fatal: true });
        if (!res.ok) throw new Error(`poll HTTP ${res.status}`);
        failures = 0;
        const { commands } = await res.json();
        for (const command of commands ?? []) dispatch(command);
      } catch (error) {
        if (stop.signal.aborted) break;
        if (error?.name === "TimeoutError") continue; // a quiet long-poll window
        if (error?.fatal) { log(`stopping: ${error.message}`); break; }
        failures += 1;
        relayId = null;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
        log(`hub unreachable (${oneLine(error?.message ?? error, 80)}), retry in ${Math.round(delay / 1000)}s`);
        await sleep(delay, stop.signal);
      }
    }
  }

  return {
    start: () => loop(),
    stop: () => { stop.abort(); for (const c of running.values()) c.abort(); },
    running,
    get relayId() { return relayId; },
  };
}

// ---------------------------------------------------------------------- CLI

export function parseArgs(argv, env = process.env) {
  const out = { hub: env.QUIET_HUB_URL ?? env.HUB_URL ?? "", token: env.HUB_TOKEN ?? "", config: env.QUIET_HUB_RELAY_CONFIG ?? "relay.json" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--hub") out.hub = argv[++i] ?? "";
    else if (a === "--token") out.token = argv[++i] ?? "";
    else if (a === "--token-file") out.token = readFileSync(argv[++i] ?? "", "utf8").trim();
    else if (a === "--config") out.config = argv[++i] ?? "";
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.hub || !args.token) {
    console.error("usage: node quiet-hub-relay.mjs --hub <url> [--config relay.json]  (token via env HUB_TOKEN or --token-file)");
    process.exit(2);
  }
  if (!existsSync(args.config)) { console.error(`config not found: ${args.config}`); process.exit(2); }
  const relay = createRelay({ hub: args.hub, token: args.token, config: loadConfig(args.config) });
  process.on("SIGINT", () => { relay.stop(); setTimeout(() => process.exit(0), 300); });
  process.on("SIGTERM", () => { relay.stop(); setTimeout(() => process.exit(0), 300); });
  console.log(`[relay] connecting to ${args.hub}`);
  relay.start().then(() => process.exit(0));
}

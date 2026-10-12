/**
 * Quiet Hub agent controllers — shared by the relay (other machines) and the
 * daemon (its own local Hermes).
 *
 * A controller gives ONE agent real session control:
 *
 *   run(job, emit)        job = {prompt, sessionId, fresh, signal} → {status, text, error?, sessionId, transport}
 *   sessions()            → {items:[{id,title,when,updated}], active, transport, supported}
 *   newSession(title)     → {id|null, title}      (id null = created by the first prompt)
 *   select(id)            → {lastUser, lastAssistant}
 *   transport()           → "bridge" | "cli" | "app-server" | "exec" | "http"
 *
 * Stopping is real: Hermes bridge gets {t:"stop"}, Codex gets turn/interrupt,
 * every CLI child is killed as a whole process tree (taskkill /T /F on Windows,
 * the process group on POSIX).
 *
 * Hermes bridge protocol client ported from apps/agent-glass/src/providers/hermes.ts
 * (hello/token, sessions.list/new/switch, text, stop, assistant.delta, tool.*,
 * turn.done, reconnect with exponential backoff). Dependency-free: Node 22+.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MAX_TEXT = 20_000; // hard cap of accumulated output per answer
export const DEFAULT_TIMEOUT_MS = 600_000;
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 30_000;
export const BRIDGE_TIMEOUT_MS = 6_000;
export const STOP_GRACE_MS = 3_000;
export const SESSION_LIMIT = 8;

export const clip = (text, max) => (text.length > max ? text.slice(text.length - max) : text);
export const oneLine = (text, max = 120) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
export const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

/** "5m", "2h", "3d" from a unix timestamp in seconds. */
export function whenShort(updatedSeconds, nowMs = Date.now()) {
  if (!Number.isFinite(updatedSeconds) || updatedSeconds <= 0) return "";
  const s = Math.max(0, Math.round(nowMs / 1000 - updatedSeconds));
  if (s < 90) return "jetzt";
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129_600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

// ------------------------------------------------------------ child process

/**
 * Kills a child AND everything it started. Windows: taskkill /T /F /PID.
 * POSIX: the children are spawned detached (own process group), so the whole
 * group is signalled; SIGKILL follows if it lingers. `platform` and `kill`
 * are injectable for tests.
 */
export function killTree(child, spawnImpl, options = {}) {
  const platform = options.platform ?? process.platform;
  const killProcess = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const pid = child?.pid;
  try {
    if (platform === "win32") {
      if (pid) spawnImpl("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
      try { child.kill?.(); } catch { /* gone */ }
      return;
    }
    if (pid) {
      try { killProcess(-pid, "SIGTERM"); } catch { try { child.kill?.("SIGTERM"); } catch { /* gone */ } }
      const timer = setTimeout(() => {
        try { killProcess(-pid, "SIGKILL"); } catch { try { child.kill?.("SIGKILL"); } catch { /* gone */ } }
      }, options.graceMs ?? 3000);
      timer.unref?.();
    } else {
      child.kill?.("SIGTERM");
    }
  } catch { /* already gone */ }
}

const spawnOptions = (extra) => ({ windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], ...extra });

/**
 * Runs one child process. `onLine` gets stdout line by line. Resolves with
 * {code, stderr, timedOut, cancelled}. Output beyond the caps is dropped.
 */
export function runProcess({ spawn, bin, args, cwd, env, stdin, onLine, timeoutMs, signal, killOptions }) {
  return new Promise((resolve) => {
    let child;
    const useShell = /\.(cmd|bat)$/i.test(bin);
    try {
      child = spawn(bin, args, spawnOptions({ cwd, env, shell: useShell }));
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
    const timer = setTimeout(() => { timedOut = true; killTree(child, spawn, killOptions); }, timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = () => { cancelled = true; killTree(child, spawn, killOptions); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
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

export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (!("QUIET_HUB_TOKEN" in extra)) { delete env.QUIET_HUB_TOKEN; delete env.HUB_TOKEN; }
  return env;
}

function finalStatus(res, text, fallbackError) {
  if (res.cancelled) return { status: "cancelled", text };
  if (res.timedOut) return { status: "error", text, error: "timeout" };
  if (res.code !== 0 && text.trim() === "") return { status: "error", text, error: oneLine(res.stderr || fallbackError || `exit ${res.code}`, 200) };
  return { status: "done", text: text.trim() === "" ? "(keine Antwort)" : text };
}

// ------------------------------------------------------------ Hermes bridge

/** Reads NAME=value from env files; quotes stripped. Never logs the value. */
export function readEnvValue(name, files, readFile = (p) => readFileSync(p, "utf8")) {
  for (const file of files) {
    let raw;
    try { raw = readFile(file); } catch { continue; }
    for (const line of String(raw).split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || m[1] !== name) continue;
      let value = m[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (value !== "") return value;
    }
  }
  return "";
}

/** Token from config, environment, then ~/.hermes/.env (or root's). */
export function resolveBridgeToken(bridge, ctx = {}) {
  if (typeof bridge.token === "string" && bridge.token !== "") return bridge.token;
  const name = bridge.tokenEnv ?? "EVENHUB_BRIDGE_TOKEN";
  const env = ctx.env ?? process.env;
  if (env[name]) return env[name];
  const home = ctx.home ?? homedir();
  const files = bridge.envFile ? [bridge.envFile] : [join(home, ".hermes", ".env"), "/root/.hermes/.env"];
  return readEnvValue(name, files, ctx.readFile);
}

/**
 * Persistent client of the hermes-evenhub-bridge. `connect()` is idempotent;
 * with `keepAlive` a dropped link is re-established with exponential backoff.
 */
export function createBridgeClient(options) {
  const WS = options.WebSocket ?? globalThis.WebSocket;
  const timeoutMs = options.timeoutMs ?? BRIDGE_TIMEOUT_MS;
  const device = options.device ?? "quiet-hub-relay";
  let socket = null;
  let connecting = null;
  let disposed = false;
  let attempts = 0;
  let reconnectTimer = null;
  let active = "";
  const waiters = new Set();
  const listeners = new Set();

  const send = (message) => {
    if (!socket || socket.readyState !== 1) throw new Error("bridge not connected");
    socket.send(JSON.stringify(message));
  };

  function wait(match, ms = timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, reject, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error("bridge timed out")); }, ms) };
      waiters.add(waiter);
    });
  }

  function receive(message) {
    for (const waiter of [...waiters]) {
      if (!waiter.match(message)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
    if (message.t === "hello.ok") active = typeof message.active === "string" ? message.active : active;
    else if (message.t === "active" && typeof message.id === "string" && message.id) active = message.id;
    for (const listener of [...listeners]) { try { listener(message); } catch { /* one listener must not break the rest */ } }
  }

  function failAll(reason) {
    for (const waiter of [...waiters]) { clearTimeout(waiter.timer); waiter.reject(new Error(reason)); }
    waiters.clear();
  }

  function scheduleReconnect() {
    if (disposed || !options.keepAlive || reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempts);
    attempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch(() => undefined); // a failed attempt closes its socket, and that schedules the next
    }, delay);
    reconnectTimer.unref?.();
  }

  function connect() {
    if (disposed) return Promise.reject(new Error("bridge closed"));
    if (socket?.readyState === 1) return Promise.resolve();
    if (connecting) return connecting;
    if (!WS) return Promise.reject(new Error("WebSocket unavailable"));
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const token = options.getToken();
    if (!token) return Promise.reject(new Error("bridge token missing"));
    const attempt = new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try { ws = new WS(options.url); } catch (error) { reject(error); return; }
      socket = ws;
      const current = () => socket === ws;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; try { ws.close(); } catch { /* closed */ } reject(new Error("bridge timed out")); }
      }, timeoutMs);
      ws.onopen = () => ws.send(JSON.stringify({ t: "hello", token, device }));
      ws.onmessage = (event) => {
        if (!current()) return;
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (!message || typeof message !== "object") return;
        receive(message);
        if (!settled && message.t === "hello.ok") { settled = true; clearTimeout(timer); attempts = 0; resolve(); }
      };
      ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error("bridge websocket error")); } };
      ws.onclose = (event) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error(event?.code === 1008 ? "bridge token rejected" : "bridge closed")); }
        if (!current()) return;
        socket = null;
        failAll("bridge connection interrupted");
        receive({ t: "_closed", code: event?.code });
        // A rejected token will be rejected again; do not hammer the bridge.
        if (event?.code !== 1008) scheduleReconnect();
      };
    }).finally(() => { if (connecting === attempt) connecting = null; });
    connecting = attempt;
    return attempt;
  }

  return {
    connect,
    get active() { return active; },
    get connected() { return socket?.readyState === 1; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async listSessions() {
      await connect();
      const waiting = wait((m) => m.t === "sessions");
      send({ t: "sessions.list" });
      const message = await waiting;
      const items = (Array.isArray(message.items) ? message.items : []).flatMap((item) => {
        if (!item || typeof item.id !== "string" || item.id === "") return [];
        const updated = typeof item.updated === "number" ? item.updated : 0;
        return [{ id: item.id, title: oneLine(item.title || "", 60) || "Hermes", updated, when: whenShort(updated) }];
      });
      return { items, active: typeof message.active === "string" ? message.active : active };
    },
    async newSession(title) {
      await connect();
      const waiting = wait((m) => m.t === "active" && typeof m.id === "string" && m.id !== "");
      send({ t: "sessions.new", title: title ?? "Quiet Hub" });
      const message = await waiting;
      return { id: message.id };
    },
    async switchSession(id) {
      await connect();
      const waiting = wait((m) => m.t === "history" && m.id === id);
      send({ t: "sessions.switch", id });
      const message = await waiting;
      active = id;
      const items = Array.isArray(message.items) ? message.items : [];
      return items.flatMap((item) => (item && typeof item.text === "string" && (item.kind === "user" || item.kind === "assistant") ? [{ role: item.kind, text: item.text }] : []));
    },
    sendText(text) { send({ t: "text", text }); },
    stop() { send({ t: "stop" }); },
    dispose() {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const ws = socket;
      socket = null;
      connecting = null;
      if (ws) { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; try { ws.close(); } catch { /* closed */ } }
      failAll("bridge closed");
      listeners.clear();
    },
  };
}

// ------------------------------------------------------------ Hermes

/** Parses `hermes sessions list` (Title / Workspace / Last Active / ID columns). */
export function parseHermesSessions(stdout) {
  const items = [];
  for (const raw of String(stdout).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || /^Title\s+Workspace/i.test(line) || /^[─\-=]{5,}/.test(line)) continue;
    const parts = line.split(/\s{2,}/);
    if (parts.length < 3) continue;
    const id = parts[parts.length - 1] ?? "";
    const ago = parts[parts.length - 2] ?? "";
    if (!/^[\w.:-]{6,}$/.test(id) || !/(ago|now|yesterday|\d)/i.test(ago)) continue;
    const title = parts[0] === "—" || parts[0] === "-" || parts.length < 4 ? "" : parts[0];
    items.push({ id, title: oneLine(title, 60) || "(ohne Titel)", updated: 0, when: ago.replace(/\s*ago$/i, "").replace(/\s+/g, "") });
  }
  return items;
}

export function createHermesController(agent, ctx) {
  const bridgeConfig = agent.bridge ?? (agent.url ? { url: agent.url, tokenEnv: agent.tokenEnv, token: agent.token } : null);
  const bridge = bridgeConfig?.url
    ? createBridgeClient({
      url: bridgeConfig.url,
      device: bridgeConfig.device ?? `quiet-hub-${agent.id}`,
      WebSocket: ctx.WebSocket,
      keepAlive: bridgeConfig.keepAlive !== false,
      timeoutMs: bridgeConfig.timeoutMs,
      getToken: () => resolveBridgeToken(bridgeConfig, ctx),
    })
    : null;
  let transport = bridge ? "bridge" : "cli";
  let cliSession = null;

  /** True when the bridge answers; otherwise the CLI takes over. */
  async function bridgeUp() {
    if (!bridge) return false;
    try { await bridge.connect(); transport = "bridge"; return true; } catch { transport = "cli"; return false; }
  }

  const hermesBin = agent.bin ?? "hermes";
  const runCli = (args, extra = {}) => {
    let out = "";
    return runProcess({
      spawn: ctx.spawn, bin: hermesBin, args, cwd: agent.cwd, env: childEnv(), timeoutMs: extra.timeoutMs ?? agent.timeoutMs, signal: extra.signal, killOptions: ctx.killOptions,
      onLine: (line) => { out += `${line}\n`; extra.onLine?.(line); },
    }).then((res) => ({ ...res, out }));
  };

  async function cliSessions() {
    const res = await runCli(["sessions", "list", "--limit", String(SESSION_LIMIT)], { timeoutMs: 20_000 });
    if (res.code !== 0 && res.out.trim() === "") throw new Error(oneLine(res.stderr || "hermes sessions failed", 120));
    return parseHermesSessions(res.out).slice(0, SESSION_LIMIT);
  }

  async function runBridge(job, emit) {
    if (job.fresh) await bridge.newSession(job.title);
    else if (job.sessionId && job.sessionId !== bridge.active) await bridge.switchSession(job.sessionId);
    return new Promise((resolve) => {
      let text = "";
      let settled = false;
      let stopping = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve({ ...result, sessionId: bridge.active || null, transport: "bridge" });
      };
      const timer = setTimeout(() => finish({ status: "error", text, error: "timeout" }), agent.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const unsubscribe = bridge.subscribe((m) => {
        if (m.t === "assistant.delta") { text = clip(text + String(m.text ?? ""), MAX_TEXT); emit({ text, activity: "" }); }
        else if (m.t === "assistant" && typeof m.text === "string") { text = clip(m.text, MAX_TEXT); emit({ text, activity: "" }); }
        else if (m.t === "tool.start") emit({ text, activity: oneLine(`${m.name ?? "tool"} ${m.label ?? ""}`, 80) });
        else if (m.t === "tool.end") emit({ text, activity: "" });
        else if (m.t === "turn.done") finish(stopping ? { status: "cancelled", text } : { status: "done", text: text || "(keine Antwort)" });
        else if (m.t === "error") finish(stopping ? { status: "cancelled", text } : { status: "error", text, error: oneLine(m.msg ?? "Hermes error", 200) });
        else if (m.t === "_closed") finish(stopping ? { status: "cancelled", text } : text !== "" ? { status: "done", text } : { status: "error", text, error: m.code === 1008 ? "token rejected" : "bridge closed" });
      });
      const onAbort = () => {
        stopping = true;
        try { bridge.stop(); } catch { /* link already gone */ }
        // The bridge confirms with turn.done; do not wait forever for a dead link.
        setTimeout(() => finish({ status: "cancelled", text }), STOP_GRACE_MS).unref?.();
      };
      if (job.signal?.aborted) onAbort(); else job.signal?.addEventListener("abort", onAbort, { once: true });
      try { bridge.sendText(job.prompt); } catch (error) { finish({ status: "error", text, error: oneLine(error?.message ?? error, 200) }); }
    });
  }

  async function runCliChat(job, emit) {
    let out = "";
    let captured = null;
    const resume = job.fresh ? null : (job.sessionId ?? cliSession);
    const args = ["chat", "-q", job.prompt, "-Q", ...(agent.format ? ["--format", String(agent.format)] : []), ...(resume ? ["--resume", resume] : [])];
    const res = await runCli(args, {
      signal: job.signal,
      onLine: (line) => {
        // -Q prints a "session_id: ..." line on some Hermes versions: keep the id, hide the line.
        const m = /^session_id:\s*(\S+)\s*$/.exec(line);
        if (m) { captured = m[1]; return; }
        out = clip(`${out}${out ? "\n" : ""}${line}`, MAX_TEXT);
        emit({ text: out, activity: "" });
      },
    });
    if (!captured && !resume && !res.cancelled) {
      // The CLI did not tell: the newest session in the store is the one just created.
      captured = (await cliSessions().catch(() => []))[0]?.id ?? null;
    }
    cliSession = captured ?? resume ?? cliSession;
    return { ...finalStatus(res, out, "hermes failed"), sessionId: cliSession, transport: "cli" };
  }

  return {
    kind: "hermes",
    transport: () => transport,
    async run(job, emit) {
      if (await bridgeUp()) {
        try { return await runBridge(job, emit); } catch (error) {
          // Failed BEFORE the prompt left (connect/switch): the CLI still answers.
          if (job.signal?.aborted) return { status: "cancelled", text: "", transport: "bridge" };
          transport = "cli";
          emit({ text: "", activity: `Bridge: ${oneLine(error?.message ?? error, 50)}` });
        }
      }
      return runCliChat(job, emit);
    },
    async sessions() {
      if (await bridgeUp()) {
        try {
          const { items, active } = await bridge.listSessions();
          return { items: items.slice(0, SESSION_LIMIT), active, transport: "bridge", supported: true };
        } catch { transport = "cli"; }
      }
      return { items: await cliSessions(), active: cliSession ?? "", transport: "cli", supported: true };
    },
    async newSession(title) {
      if (await bridgeUp()) {
        try { const { id } = await bridge.newSession(title); return { id, title: title ?? "" }; } catch { transport = "cli"; }
      }
      cliSession = null;
      return { id: null, title: title ?? "" };
    },
    async select(id) {
      if (await bridgeUp()) {
        try {
          const history = await bridge.switchSession(id);
          return exchange(history.map((h) => ({ role: h.role, text: h.text })));
        } catch { transport = "cli"; }
      }
      cliSession = id;
      return { lastUser: null, lastAssistant: null };
    },
    close() { bridge?.dispose(); },
  };
}

function exchange(history) {
  const last = (role) => [...history].reverse().find((h) => h.role === role)?.text ?? null;
  return { lastUser: last("user"), lastAssistant: last("assistant") };
}

// ------------------------------------------------------------ Claude

export function claudeArgs(agent, ctx, sessionId, useContinue = false) {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (agent.model) args.push("--model", agent.model);
  if (sessionId) args.push("--resume", sessionId);
  else if (useContinue) args.push("--continue");
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

/** Claude Code keeps one folder per working directory: every non-alphanumeric becomes "-". */
export const claudeProjectDir = (cwd, configDir) => join(configDir, "projects", String(cwd).replace(/[^A-Za-z0-9]/g, "-"));

function readHead(file, bytes) {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, 0);
    return buffer.toString("utf8");
  } finally { closeSync(fd); }
}

function readTail(file, bytes) {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally { closeSync(fd); }
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
  return "";
}

const isNoise = (text) => text.trim() === "" || /^<(command-|local-command|system-reminder)/.test(text.trim()) || text.startsWith("Caveat:");

export function listClaudeSessions(cwd, configDir, limit = SESSION_LIMIT) {
  const dir = claudeProjectDir(cwd, configDir);
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }));
  } catch { return []; }
  files.sort((a, b) => b.t - a.t);
  return files.slice(0, limit).map(({ f, t }) => {
    let title = "";
    try {
      for (const line of readHead(join(dir, f), 200_000).split("\n")) {
        if (!line.startsWith("{")) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (typeof obj.aiTitle === "string" && obj.aiTitle) { title = obj.aiTitle; break; }
        if (obj.type === "summary" && typeof obj.summary === "string") { title = obj.summary; break; }
        if (!title && obj.type === "user" && !obj.isMeta) {
          const text = messageText(obj.message);
          if (!isNoise(text)) title = text;
        }
      }
    } catch { /* unreadable file: listed without a title */ }
    return { id: f.replace(/\.jsonl$/, ""), title: oneLine(title, 60) || "(ohne Titel)", updated: Math.round(t / 1000), when: whenShort(t / 1000) };
  });
}

export function claudeLastExchange(cwd, configDir, id) {
  try {
    const tail = readTail(join(claudeProjectDir(cwd, configDir), `${id}.jsonl`), 300_000);
    const history = [];
    for (const line of tail.split("\n")) {
      if (!line.startsWith("{")) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type !== "user" && obj.type !== "assistant") continue;
      const text = messageText(obj.message);
      if (!isNoise(text)) history.push({ role: obj.type, text });
    }
    return exchange(history);
  } catch { return { lastUser: null, lastAssistant: null }; }
}

export function createClaudeController(agent, ctx) {
  let current = null;
  const configDir = ctx.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(ctx.home ?? homedir(), ".claude");
  const cwd = agent.cwd ?? process.cwd();
  return {
    kind: "claude",
    transport: () => "cli",
    async run(job, emit) {
      const sessionId = job.fresh ? null : (job.sessionId ?? current);
      const useContinue = !sessionId && !job.fresh && agent.continue === true;
      let seen = null;
      let text = "";
      let finalText = "";
      let isError = false;
      const env = childEnv(agent.mode === "ask"
        ? { QUIET_HUB_URL: ctx.hub, QUIET_HUB_TOKEN: ctx.token, QUIET_HUB_AGENT: agent.id }
        : {});
      const res = await runProcess({
        spawn: ctx.spawn, bin: agent.bin ?? "claude", args: claudeArgs(agent, ctx, sessionId, useContinue),
        cwd: agent.cwd, env, stdin: job.prompt, timeoutMs: agent.timeoutMs, signal: job.signal, killOptions: ctx.killOptions,
        onLine: (line) => {
          if (!line.startsWith("{")) return;
          const obj = JSON.parse(line);
          if (obj.session_id && typeof obj.session_id === "string") seen = obj.session_id;
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
      // Even a stopped run keeps its id: the next prompt resumes right there.
      if (seen) current = seen;
      const out = finalText || text;
      const status = finalStatus(res, out, "claude failed");
      const base = { sessionId: seen ?? sessionId ?? current, transport: "cli" };
      if (status.status === "done" && isError) return { status: "error", text: out, error: oneLine(out, 200), ...base };
      return { ...status, ...base };
    },
    async sessions() {
      return { items: listClaudeSessions(cwd, configDir), active: current ?? "", transport: "cli", supported: true };
    },
    async newSession() { current = null; return { id: null, title: "" }; },
    async select(id) { current = id; return claudeLastExchange(cwd, configDir, id); },
    close() {},
  };
}

// ------------------------------------------------------------ Codex

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
      env: childEnv(), stdin: job.prompt, timeoutMs: agent.timeoutMs, signal: job.signal, killOptions: ctx.killOptions,
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
 * to the daemon and decided on the glasses. thread/start opens a new session,
 * thread/resume continues a chosen one, thread/list lists them.
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

function spawnAppServer(agent, ctx) {
  const bin = agent.bin ?? "codex";
  return ctx.spawn(bin, ["app-server", ...(Array.isArray(agent.args) ? agent.args.map(String) : [])], spawnOptions({
    cwd: agent.cwd, env: childEnv(), shell: /\.(cmd|bat)$/i.test(bin),
  }));
}

/** One short-lived app-server call (used for thread/list). */
async function codexRpc(agent, ctx, method, params, timeoutMs = 20_000) {
  let child;
  try { child = spawnAppServer(agent, ctx); } catch (error) { throw new Error(oneLine(error?.message ?? error, 120)); }
  return new Promise((resolve, reject) => {
    let buffer = "";
    let nextId = 1;
    let settled = false;
    const pending = new Map();
    const write = (message) => { try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* closed */ } };
    const request = (m, p = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); write({ id, method: m, params: p }); });
    const end = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child, ctx.spawn, ctx.killOptions);
      fn(value);
    };
    const timer = setTimeout(() => end(reject, new Error("codex timed out")), timeoutMs);
    child.on("error", (e) => end(reject, new Error(oneLine(e?.message ?? e, 120))));
    child.on("close", () => end(reject, new Error("codex exited")));
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
        }
      }
    });
    (async () => {
      try {
        await request("initialize", { clientInfo: { name: "quiet-hub-relay", title: "Quiet Hub relay", version: "0.4.0" }, capabilities: { experimentalApi: true } });
        write({ method: "initialized", params: {} });
        end(resolve, await request(method, params));
      } catch (error) { end(reject, error); }
    })();
  });
}

export function parseCodexThreads(result) {
  const list = result?.data ?? result?.threads ?? result?.items ?? [];
  if (!Array.isArray(list)) return [];
  return list.flatMap((t) => {
    const id = typeof t?.id === "string" ? t.id : "";
    if (!id) return [];
    const updated = Number(t.updatedAt ?? t.updated_at ?? t.createdAt ?? 0);
    return [{ id, title: oneLine(t.name ?? t.preview ?? t.title ?? "", 60) || "(ohne Titel)", updated, when: whenShort(updated) }];
  });
}

export function createCodexController(agent, ctx) {
  if (agent.engine === "exec") {
    const runner = createCodexExecRunner(agent, ctx);
    return {
      kind: "codex",
      transport: () => "exec",
      run: runner,
      async sessions() { return { items: [], active: "", transport: "exec", supported: false }; },
      async newSession() { return { id: null, title: "" }; },
      async select() { return { lastUser: null, lastAssistant: null }; },
      close() {},
    };
  }
  let threadId = null;
  const policy = CODEX_POLICY[agent.mode] ?? CODEX_POLICY.ask;

  const run = (job, emit) => new Promise((resolve) => {
    let full = "";
    let nextId = 1;
    let buffer = "";
    let turnId = null;
    let settled = false;
    let child;
    const pending = new Map();
    try { child = spawnAppServer(agent, ctx); } catch (error) {
      resolve({ status: "error", text: "", error: oneLine(error?.message ?? error, 200), transport: "app-server" });
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
      killTree(child, ctx.spawn, ctx.killOptions);
      resolve({ ...result, sessionId: threadId, transport: "app-server" });
    };
    const timer = setTimeout(() => finish({ status: "error", text: full, error: "timeout" }), agent.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = () => {
      // Ask Codex to stop the turn, then end the whole process tree.
      if (threadId && turnId) write({ id: nextId++, method: "turn/interrupt", params: { threadId, turnId } });
      setTimeout(() => finish({ status: "cancelled", text: full }), 200);
    };
    if (job.signal?.aborted) onAbort(); else job.signal?.addEventListener("abort", onAbort, { once: true });

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
        await request("initialize", { clientInfo: { name: "quiet-hub-relay", title: "Quiet Hub relay", version: "0.4.0" }, capabilities: { experimentalApi: true } });
        write({ method: "initialized", params: {} });
        const wanted = job.fresh ? null : (job.sessionId ?? threadId);
        let started = null;
        if (wanted) {
          started = await request("thread/resume", { threadId: wanted }).catch(() => null);
          if (started) threadId = wanted;
        }
        if (!started) {
          started = await request("thread/start", { cwd: agent.cwd, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox, serviceName: "quiet-hub" });
          threadId = String(started?.thread?.id ?? "");
        }
        const turn = await request("turn/start", { threadId, input: [{ type: "text", text: job.prompt }], ...(agent.model ? { model: agent.model } : {}) });
        turnId = String(turn?.turn?.id ?? "") || null;
        // A stop that arrived before the turn existed still has to interrupt it.
        if (job.signal?.aborted && turnId) write({ id: nextId++, method: "turn/interrupt", params: { threadId, turnId } });
      } catch (error) {
        finish({ status: "error", text: full, error: oneLine(error?.message ?? error, 200) });
      }
    })();
  });

  return {
    kind: "codex",
    transport: () => "app-server",
    run,
    async sessions() {
      const result = await codexRpc(agent, ctx, "thread/list", { limit: SESSION_LIMIT });
      return { items: parseCodexThreads(result).slice(0, SESSION_LIMIT), active: threadId ?? "", transport: "app-server", supported: true };
    },
    async newSession() { threadId = null; return { id: null, title: "" }; },
    async select(id) { threadId = id; return { lastUser: null, lastAssistant: null }; },
    close() {},
  };
}

// ------------------------------------------------------------ OpenClaw

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
  let history = [];
  const token = agent.token ?? (agent.tokenEnv ? process.env[agent.tokenEnv] : "") ?? "";
  const base = String(agent.url ?? "").replace(/\/+$/, "");
  const runner = async (job, emit) => {
    if (job.fresh) history = [];
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
  return runner;
}

function createOpenClawController(agent, ctx) {
  const runner = createOpenClawRunner(agent, ctx);
  return {
    kind: "openclaw",
    transport: () => "http",
    run: (job, emit) => runner(job, emit).then((r) => ({ ...r, transport: "http" })),
    async sessions() { return { items: [], active: "", transport: "http", supported: false }; },
    async newSession() { return { id: null, title: "" }; },
    async select() { return { lastUser: null, lastAssistant: null }; },
    close() {},
  };
}

export function createController(agent, ctx) {
  switch (agent.kind) {
    case "claude": return createClaudeController(agent, ctx);
    case "codex": return createCodexController(agent, ctx);
    case "hermes": return createHermesController(agent, ctx);
    default: return createOpenClawController(agent, ctx);
  }
}

export { nodeSpawn };

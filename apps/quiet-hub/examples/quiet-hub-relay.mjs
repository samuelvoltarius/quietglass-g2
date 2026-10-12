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
 * Besides prompts the daemon sends session commands: list the sessions of an
 * agent, start a new one, select one, and a real stop (Hermes bridge "stop",
 * Codex turn/interrupt, process-tree kill for CLIs). The agent logic lives in
 * quiet-hub-agents.mjs (same folder).
 *
 *   node quiet-hub-relay.mjs --hub https://pi5.example.ts.net --config relay.json
 *   HUB_TOKEN=... node quiet-hub-relay.mjs --hub http://127.0.0.1:8787
 *
 * Token: env HUB_TOKEN (preferred), --token-file <path>, or --token <value>.
 * Not needed for an https hub behind `tailscale serve` that allows this machine's Tailscale login.
 * The token is never printed and never written to disk by the relay.
 *
 * relay.json:
 *   { "machine": "windows-pc",
 *     "agents": [
 *       { "id": "claude-win", "kind": "claude", "cwd": "F:\\work", "mode": "ask" },
 *       { "id": "codex-win",  "kind": "codex",  "cwd": "F:\\work", "mode": "ask" },
 *       { "id": "hermes-spark", "kind": "hermes", "bin": "hermes",
 *         "bridge": { "url": "ws://127.0.0.1:8765", "tokenEnv": "EVENHUB_BRIDGE_TOKEN" } },
 *       { "id": "claw", "kind": "openclaw", "url": "http://127.0.0.1:18789", "tokenEnv": "OPENCLAW_TOKEN" } ] }
 *
 * Hermes "bridge" = the hermes-evenhub-bridge plugin (WebSocket). Its token is
 * read at runtime from the environment or ~/.hermes/.env and never stored here.
 * Without a bridge (or when it is down) the relay falls back to `hermes chat -q`.
 *
 * Dependency-free: Node 22+ (global fetch / WebSocket).
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createController, clip, oneLine, sleep, nodeSpawn } from "./quiet-hub-agents.mjs";

// Everything that used to live here is still importable from this file.
export * from "./quiet-hub-agents.mjs";
export const SEND_TEXT = 4_000; // tail that is sent to the hub
const HERE = dirname(fileURLToPath(import.meta.url));
const BRIEF_DE = "\n\n(Antworte knapp auf Deutsch, ohne Markdown.)";

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
    if (a.bridge !== undefined && (a.kind !== "hermes" || typeof a.bridge?.url !== "string" || !/^wss?:\/\//.test(a.bridge.url))) {
      throw new Error(`agent ${a.id}: bridge.url (ws://…) is only valid for kind hermes`);
    }
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

/** Back-compat name: a runner is the run() of a controller. */
export function createRunner(agent, ctx) {
  return createController(agent, ctx).run;
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
    env: options.env, home: options.home, claudeDir: options.claudeDir, killOptions: options.killOptions,
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
  const controllers = new Map(config.agents.map((a) => [a.id, createController(a, ctx)]));
  const agentCfg = new Map(config.agents.map((a) => [a.id, a]));
  const running = new Map(); // agentId -> {controller: AbortController, done: Promise}
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
      agents: config.agents.map((a) => ({
        id: a.id, kind: a.kind, mode: a.mode, label: a.label ?? a.id,
        transport: controllers.get(a.id)?.transport() ?? "", sessions: true,
      })),
    });
    if (res.status === 401) throw Object.assign(new Error("hub rejected the token"), { fatal: true });
    if (!res.ok) throw new Error(`register HTTP ${res.status}`);
    relayId = (await res.json()).relayId;
    log(`registered ${config.agents.length} agent(s) as machine "${config.machine}"`);
  }

  async function runJob(command) {
    const agent = agentCfg.get(command.agentId);
    const controller = controllers.get(command.agentId);
    const post = (payload) => call("/relay/result", { jobId: command.jobId, ...payload }).catch(() => undefined);
    if (!agent || !controller) { await post({ status: "error", error: "unknown agent" }); return; }
    // A stop just issued may still be tearing the old process down: give it a moment.
    const previous = running.get(agent.id);
    if (previous) await Promise.race([previous.done, sleep(5000)]);
    if (running.has(agent.id)) { await post({ status: "error", error: "agent busy" }); return; }
    const abort = new AbortController();
    let release;
    running.set(agent.id, { abort, done: new Promise((resolve) => { release = resolve; }) });
    const prompt = agent.brief && !command.raw ? `${command.prompt}${BRIEF_DE}` : command.prompt;

    let latest = { text: "", activity: "" };
    let lastSent = 0;
    let timer = null;
    const flush = () => {
      timer = null;
      lastSent = Date.now();
      void post({ status: "running", text: clip(latest.text, SEND_TEXT), activity: latest.activity, transport: controller.transport() });
    };
    const emit = (update) => {
      latest = update;
      const wait = 800 - (Date.now() - lastSent);
      if (wait <= 0) { if (timer) clearTimeout(timer); flush(); }
      else if (!timer) timer = setTimeout(flush, wait);
    };
    let result;
    try {
      result = await controller.run({
        prompt, sessionId: command.sessionId ?? null, fresh: command.fresh === true, title: oneLine(command.prompt, 40), signal: abort.signal,
      }, emit);
    } catch (error) {
      result = { status: "error", text: latest.text, error: oneLine(error?.message ?? error, 200) };
    }
    if (timer) clearTimeout(timer);
    running.delete(agent.id);
    release();
    await post({
      status: result.status, text: clip(result.text ?? "", SEND_TEXT), error: result.error ?? null, activity: "",
      sessionId: result.sessionId ?? null, transport: result.transport ?? controller.transport(),
    });
    if (result.status !== "cancelled") {
      await call("/events", {
        provider: agent.id,
        status: result.status === "done" ? "done" : "error",
        title: result.status === "done" ? "Antwort fertig" : `Fehler: ${result.error ?? "?"}`.slice(0, 120),
        detail: oneLine(command.prompt, 100),
      }).catch(() => undefined);
    }
  }

  /** Session commands answer through POST /relay/reply, keyed by the daemon's reqId. */
  async function runSessionCommand(command) {
    const controller = controllers.get(command.agentId);
    const reply = (payload) => call("/relay/reply", { reqId: command.reqId, ...payload }).catch(() => undefined);
    if (!controller) { await reply({ ok: false, error: "unknown agent" }); return; }
    try {
      let data;
      if (command.type === "sessions") data = await controller.sessions();
      else if (command.type === "session.new") data = await controller.newSession(command.title);
      else data = await controller.select(String(command.sessionId ?? ""));
      await reply({ ok: true, data: { ...data, transport: controller.transport() } });
    } catch (error) {
      await reply({ ok: false, error: oneLine(error?.message ?? error, 160) });
    }
  }

  function dispatch(command) {
    if (command.type === "ask") void runJob(command);
    else if (command.type === "cancel") running.get(command.agentId)?.abort.abort();
    else if (command.type === "sessions" || command.type === "session.new" || command.type === "session.select") void runSessionCommand(command);
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
    stop: () => { stop.abort(); for (const r of running.values()) r.abort.abort(); for (const c of controllers.values()) c.close(); },
    running,
    controllers,
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
  // Through `tailscale serve` (https) the hub knows us by our Tailscale login; a token is only needed on plain http.
  if (!args.hub || (!args.token && !args.hub.startsWith("https://"))) {
    console.error("usage: node quiet-hub-relay.mjs --hub <url> [--config relay.json]  (token via env HUB_TOKEN or --token-file; optional for an https hub behind tailscale serve)");
    process.exit(2);
  }
  if (!existsSync(args.config)) { console.error(`config not found: ${args.config}`); process.exit(2); }
  const relay = createRelay({ hub: args.hub, token: args.token, config: loadConfig(args.config) });
  process.on("SIGINT", () => { relay.stop(); setTimeout(() => process.exit(0), 300); });
  process.on("SIGTERM", () => { relay.stop(); setTimeout(() => process.exit(0), 300); });
  console.log(`[relay] connecting to ${args.hub}`);
  relay.start().then(() => process.exit(0));
}

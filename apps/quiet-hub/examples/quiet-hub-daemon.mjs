#!/usr/bin/env node
/**
 * Quiet Hub daemon — one process, many agents, home and printer.
 *
 * The glasses talk to this daemon and nothing else; every token lives here.
 *
 *  - Agents: the daemon's own Hermes (`hermes chat -q`, id hermes-pi5 by
 *    default) plus any number of agents on other machines. Those connect
 *    OUTWARD with quiet-hub-relay.mjs (HTTPS long-poll), register their agents
 *    and receive prompts. Permission questions of Claude Code become cards.
 *  - Home Assistant (HA_URL + HA_TOKEN + HA_DEVICES) or a labelled DEMO.
 *  - Moonraker (MOONRAKER_URL) or a labelled DEMO.
 *
 *   node quiet-hub-daemon.mjs        # listens on :8787 (PORT env to change)
 *
 * Env (see .env-hub.example): PORT, HOST, HUB_TOKEN, HERMES_BIN, LOCAL_AGENT_ID,
 * ASK_TIMEOUT_MS, APPROVAL_TIMEOUT_MS, WHISPER_URL, VLLM_URL, HA_URL, HA_TOKEN,
 * HA_DEVICES, MOONRAKER_URL, QUIET_HUB_STATE_FILE, HUB_TAILSCALE_USERS.
 */
import { createServer } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHomeAssistant, createMoonraker, parseDevices } from "./quiet-hub-adapters.mjs";
import { createController, nodeSpawn } from "./quiet-hub-agents.mjs";

const QUESTIONS = ["Was steht heute an?", "Wie läuft das Projekt?", "Fass den Tag zusammen"];
const MAX_AUDIO = 12 * 1024 * 1024;
const RELAY_STALE_MS = 45_000;
const POLL_HOLD_MS = 25_000;
const RPC_TIMEOUT_MS = 45_000; // a CLI that updates itself on start (seen on one Hermes host) needs ~30 s

const digest = (text) => createHash("sha256").update(text).digest();
const clipTail = (text, max) => (text.length > max ? text.slice(text.length - max) : text);

export function createHub(options = {}) {
  const env = options.env ?? process.env;
  const cfg = {
    token: options.token ?? env.HUB_TOKEN ?? "",
    // Tailscale logins (comma list) that need no token when `tailscale serve` proxies the request.
    tailscaleUsers: String(options.tailscaleUsers ?? env.HUB_TAILSCALE_USERS ?? "").split(",").map((u) => u.trim().toLowerCase()).filter(Boolean),
    hermesBin: options.hermesBin ?? env.HERMES_BIN ?? "hermes",
    // Optional hermes-evenhub-bridge for the daemon's own Hermes (token read at runtime, never stored).
    bridgeUrl: options.bridgeUrl ?? env.HERMES_BRIDGE_URL ?? "",
    hermesFormat: options.hermesFormat ?? env.HERMES_FORMAT ?? "stream-json",
    bridgeTokenEnv: options.bridgeTokenEnv ?? env.HERMES_BRIDGE_TOKEN_ENV ?? "EVENHUB_BRIDGE_TOKEN",
    localAgentId: options.localAgentId ?? env.LOCAL_AGENT_ID ?? "hermes-pi5",
    localAgent: options.localAgent ?? env.LOCAL_AGENT !== "off",
    askTimeoutMs: Number(options.askTimeoutMs ?? env.ASK_TIMEOUT_MS ?? 300_000),
    approvalTimeoutMs: Number(options.approvalTimeoutMs ?? env.APPROVAL_TIMEOUT_MS ?? 120_000),
    stateFile: options.stateFile ?? env.QUIET_HUB_STATE_FILE ?? join(homedir(), ".local", "state", "quiet-hub", "state.json"),
    whisperUrl: options.whisperUrl ?? env.WHISPER_URL ?? "http://127.0.0.1:8017/v1/audio/transcriptions",
    whisperModel: options.whisperModel ?? env.WHISPER_MODEL ?? "whisper-1",
    whisperLang: options.whisperLang ?? env.WHISPER_LANG ?? "de",
    vllmUrl: options.vllmUrl ?? env.VLLM_URL ?? "http://127.0.0.1:8000/v1",
    vllmModel: options.vllmModel ?? env.VLLM_MODEL ?? "qwen",
    suggestTimeoutMs: Number(options.suggestTimeoutMs ?? env.SUGGEST_TIMEOUT_MS ?? 30000),
    suggestions: options.suggestions ?? (env.VLLM_URL !== "off"),
    lang: options.lang ?? env.HUB_LANG ?? "de",
  };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const log = options.log ?? ((...args) => console.log("[daemon]", ...args));
  const now = options.now ?? (() => Date.now());

  // ------------------------------------------------------------- events
  const loadEvents = () => {
    try {
      const parsed = JSON.parse(readFileSync(cfg.stateFile, "utf8"));
      return {
        events: Array.isArray(parsed.events) ? parsed.events.slice(0, 50) : [],
        sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
      };
    } catch { return { events: [], sessions: {} }; }
  };
  const state = loadEvents();
  const saveEvents = () => {
    try {
      mkdirSync(dirname(cfg.stateFile), { recursive: true });
      const temporary = `${cfg.stateFile}.tmp`;
      writeFileSync(temporary, JSON.stringify({ events: state.events, sessions: state.sessions }, null, 2), { mode: 0o600 });
      renameSync(temporary, cfg.stateFile);
    } catch (error) {
      console.error("[daemon] state save failed:", String(error).slice(0, 200));
    }
  };
  function addEvent(provider, status, title, detail = null) {
    const event = {
      id: `${now()}-${randomUUID().slice(0, 8)}`,
      provider: String(provider).slice(0, 32),
      status,
      title: String(title).slice(0, 180),
      detail: detail == null || detail === "" ? null : String(detail).slice(0, 300),
      createdAt: new Date(now()).toISOString(),
      read: false,
    };
    state.events = [event, ...state.events].slice(0, 50);
    saveEvents();
    // Only things that need the user go to the phone; answers are on the glasses already.
    if (status === "waiting") void notifyPhone(`${event.provider}: wartet`, event.title);
    return event;
  }

  // ------------------------------------------------------------- registry
  /** agentId -> agent record. relayId === null means "runs inside the daemon". */
  const agents = new Map();
  const relays = new Map();
  const jobs = new Map();
  const approvals = new Map();
  const rpcs = new Map();
  const setSession = (agent, session) => {
    agent.session = session;
    if (session) state.sessions[agent.id] = session; else delete state.sessions[agent.id];
    saveEvents();
  };

  function upsertAgent(spec, relayId, machine) {
    const old = agents.get(spec.id);
    agents.set(spec.id, {
      id: spec.id,
      label: String(spec.label ?? spec.id).slice(0, 32),
      kind: String(spec.kind ?? "other").slice(0, 16),
      machine: String(machine ?? "").slice(0, 40),
      mode: String(spec.mode ?? "auto").slice(0, 12),
      relayId,
      answer: old?.answer ?? null,
      lastQuestion: old?.lastQuestion ?? null,
      suggestions: old?.suggestions ?? [],
      busy: false,
      activity: "",
      error: null,
      jobId: null,
      transport: String(spec.transport ?? old?.transport ?? "").slice(0, 16),
      sessionsSupported: spec.sessions !== false,
      session: old?.session ?? state.sessions[spec.id] ?? null,
      stopped: false,
      stopConfirmed: false,
      abort: null,
    });
  }
  // The daemon's own Hermes: bridge when configured, `hermes chat -q` otherwise.
  const localController = cfg.localAgent
    ? createController({
      id: cfg.localAgentId, kind: "hermes", bin: cfg.hermesBin, format: cfg.hermesFormat, mode: "auto", brief: false,
      bridge: cfg.bridgeUrl ? { url: cfg.bridgeUrl, tokenEnv: cfg.bridgeTokenEnv } : undefined,
    }, { spawn: spawnImpl, WebSocket: options.WebSocket, fetch: fetchImpl, env, home: options.home, killOptions: options.killOptions })
    : null;
  if (cfg.localAgent) upsertAgent({ id: cfg.localAgentId, kind: "hermes", mode: "auto", transport: localController.transport() }, null, "hub");

  const isOnline = (agent) => {
    if (agent.relayId === null) return true;
    const relay = relays.get(agent.relayId);
    return relay !== undefined && (relay.waiter !== null || now() - relay.lastSeen < RELAY_STALE_MS);
  };

  const defaultAgentId = () => (agents.has(cfg.localAgentId) ? cfg.localAgentId : ([...agents.keys()][0] ?? null));

  // ------------------------------------------------------------- Home / printer
  const haConfigured = (env.HA_URL ?? options.haUrl) && (env.HA_TOKEN ?? options.haToken);
  const ha = haConfigured
    ? createHomeAssistant({
      url: options.haUrl ?? env.HA_URL, token: options.haToken ?? env.HA_TOKEN,
      devices: options.haDevices ?? parseDevices(env.HA_DEVICES), fetchImpl, lang: cfg.lang,
    })
    : null;
  if (ha && parseDevices(env.HA_DEVICES).length === 0 && !options.haDevices) log("HA_URL set but HA_DEVICES is empty: no devices are exposed");
  const demoDevices = [
    { id: "light_office", label: "DEMO · Büro Licht", kind: "switch", state: "an", on: true, writable: true },
    { id: "light_living", label: "DEMO · Wohnzimmer Licht", kind: "switch", state: "aus", on: false, writable: true },
    { id: "plug_printer", label: "DEMO · Steckdose Drucker", kind: "switch", state: "an", on: true, writable: true },
  ];
  let homeDemo = demoDevices;

  const moonUrl = options.moonrakerUrl ?? env.MOONRAKER_URL;
  const moon = moonUrl ? createMoonraker({ url: moonUrl, fetchImpl }) : null;
  let printerDemo = { job: "DEMO esp32_gehaeuse.stl", state: "printing", layer: 148, layers: 205, progress: 72, etaMin: 41, nozzleC: 210, bedC: 60, selected: 0, demo: true };

  // ------------------------------------------------------------- phone mirror (optional)
  // Waiting events (approvals) and a finished print are also sent to Home
  // Assistant's notify service, so the phone notification can be mirrored to the
  // glasses. HA_NOTIFY_SERVICE=notify.mobile_app_x pins it; otherwise the first
  // notify.mobile_app_* service is found read-only via GET /api/services.
  // HA_NOTIFY=off disables it; without a service nothing is sent.
  const notifyMode = String(options.haNotify ?? env.HA_NOTIFY ?? "auto");
  let notifyService = options.haNotifyService ?? env.HA_NOTIFY_SERVICE ?? null;
  let notifyDetected = notifyService !== null && notifyService !== "";
  let lastNotify = { key: "", at: 0 };
  async function notifyPhone(title, message) {
    if (!ha || notifyMode === "off") return false;
    try {
      if (!notifyDetected) {
        notifyService = await ha.findNotifyService();
        notifyDetected = true;
        log("phone notify service:", notifyService ?? "none (mirroring off)");
      }
      if (!notifyService) return false;
      const key = `${title}|${message}`;
      if (lastNotify.key === key && now() - lastNotify.at < 5000) return false;
      lastNotify = { key, at: now() };
      return await ha.notify(notifyService, title, message);
    } catch (error) {
      log("phone notify failed:", String(error?.message ?? error).slice(0, 100));
      return false;
    }
  }
  let lastPrinterState = null;
  function watchPrinter() {
    if (!moon) return;
    const current = moon.printer();
    const was = lastPrinterState;
    lastPrinterState = current.state;
    if (current.offline) return;
    if (was === "printing" && current.state === "ready") void notifyPhone("Quiet Hub", "Druck fertig");
  }

  const timers = [];
  function startBackground() {
    if (ha) { void ha.refresh(); timers.push(setInterval(() => void ha.refresh(), 10_000)); }
    if (moon) { void moon.refresh().then(watchPrinter); timers.push(setInterval(() => void moon.refresh().then(watchPrinter), options.moonPollMs ?? 5_000)); }
    timers.push(setInterval(sweep, 10_000));
    for (const t of timers) t.unref?.();
  }

  // ------------------------------------------------------------- jobs
  function finishJob(job, status, text, error) {
    if (job.done) return;
    job.done = true;
    job.status = status;
    const agent = agents.get(job.agentId);
    if (agent && agent.jobId === job.id) {
      agent.busy = false;
      agent.activity = "";
      agent.jobId = null;
      agent.error = status === "error" ? String(error ?? "error").slice(0, 160) : null;
      // A stop keeps what the agent had said so far; the glasses show "gestoppt" next to it.
      const finalText = status === "cancelled" ? (agent.answer ?? "") : (status === "error" && !text ? `Fehler: ${agent.error}` : text);
      if (status === "cancelled") agent.stopped = true;
      agent.answer = clipTail(finalText ?? "", 4000);
      if (status === "done" && cfg.suggestions) {
        const question = job.question;
        agent.suggestions = [];
        agent.suggesting = true;
        void suggestFor(question, agent.answer).then((list) => {
          if (agent.jobId === null && agent.lastQuestion === question) { agent.suggestions = list; agent.suggesting = false; }
        });
      } else {
        agent.suggestions = [];
        agent.suggesting = false;
      }
    }
    job.waiters.forEach((resolve) => resolve({ status, text: agent?.answer ?? text ?? "" }));
    job.waiters.length = 0;
    setTimeout(() => jobs.delete(job.id), 60_000).unref?.();
  }

  function sweep() {
    const t = now();
    for (const job of jobs.values()) {
      if (job.done) continue;
      const agent = agents.get(job.agentId);
      if (agent && agent.relayId !== null && !isOnline(agent)) finishJob(job, "error", "", "relay offline");
      else if (t - job.startedAt > cfg.askTimeoutMs * 2) finishJob(job, "error", "", "timeout");
    }
    for (const card of approvals.values()) {
      if (t >= card.expiresAt) settleApproval(card.id, "deny");
    }
  }

  function enqueue(relay, command) {
    relay.queue.push(command);
    if (relay.waiter) {
      const { res, timer } = relay.waiter;
      clearTimeout(timer);
      relay.waiter = null;
      const commands = relay.queue.splice(0);
      sendJson(res, 200, { commands });
    }
  }

  /** Starts a question; returns {job} or {error,status}. */
  function startAsk(agentId, question, opts = {}) {
    const id = agentId || defaultAgentId();
    const agent = id ? agents.get(id) : undefined;
    if (!agent) return { status: 404, error: "unknown agent" };
    if (!isOnline(agent)) return { status: 503, error: "agent offline" };
    if (agent.busy) return { status: 409, error: "agent busy" };
    const job = { id: randomUUID(), agentId: agent.id, question, status: "running", done: false, waiters: [], startedAt: now() };
    jobs.set(job.id, job);
    agent.busy = true;
    agent.busySince = job.startedAt;
    agent.jobId = job.id;
    agent.answer = "";
    agent.activity = "";
    agent.error = null;
    agent.suggestions = [];
    agent.suggesting = false;
    agent.lastQuestion = question;
    agent.stopped = false;
    agent.stopConfirmed = false;
    if (typeof opts.sessionId === "string" && opts.sessionId !== "" && opts.sessionId !== agent.session?.id) {
      setSession(agent, { id: opts.sessionId, title: "", fresh: false });
    }
    job.sessionId = agent.session?.id ?? null;
    job.fresh = opts.fresh === true || (agent.session !== null && agent.session.id === null && agent.session.fresh === true);
    if (job.fresh) setSession(agent, { id: null, title: question.slice(0, 40), fresh: true });
    if (agent.relayId === null) {
      runLocal(job, agent);
    } else {
      const relay = relays.get(agent.relayId);
      enqueue(relay, { type: "ask", jobId: job.id, agentId: agent.id, prompt: question, sessionId: job.sessionId, fresh: job.fresh });
    }
    return { job };
  }

  /** Remembers which session an answer belongs to (a new session learns its id here). */
  function noteResult(agent, result) {
    if (typeof result.transport === "string" && result.transport !== "") agent.transport = result.transport.slice(0, 16);
    if (typeof result.sessionId === "string" && result.sessionId !== "") {
      const title = agent.session?.id === result.sessionId || agent.session?.id === null ? (agent.session?.title ?? "") : "";
      setSession(agent, { id: result.sessionId, title: title || String(agent.lastQuestion ?? "").slice(0, 40), fresh: false });
    }
  }

  function runLocal(job, agent) {
    // Keep glasses answers short: three wrapped rows at most.
    const prompt = `${job.question}\n\n(Antworte auf Deutsch in einem kurzen Satz von höchstens 110 Zeichen. Schreibe keine Zeichenzahl und keine Meta-Kommentare in die Antwort.)`;
    const abort = new AbortController();
    agent.abort = abort;
    const emit = (update) => {
      if (job.done) return;
      agent.answer = clipTail(String(update.text ?? ""), 4000);
      agent.activity = String(update.activity ?? "").slice(0, 80);
    };
    localController.run({ prompt, sessionId: job.sessionId, fresh: job.fresh, title: job.question.slice(0, 40), signal: abort.signal }, emit)
      .catch((error) => ({ status: "error", text: "", error: String(error?.message ?? error) }))
      .then((result) => {
        agent.abort = null;
        noteResult(agent, result);
        if (job.done) { if (result.status === "cancelled") agent.stopConfirmed = true; return; }
        if (result.status === "cancelled") { agent.stopConfirmed = true; finishJob(job, "cancelled", result.text ?? ""); return; }
        const out = String(result.text ?? "").trim();
        if (result.status === "error" && out === "") {
          console.error("[daemon] hermes failed:", String(result.error ?? "").slice(0, 400));
          addEvent(agent.id, "error", "Keine Antwort vom Assistenten", job.question);
          finishJob(job, "error", "", "Keine Antwort vom Assistenten.");
          return;
        }
        addEvent(agent.id, "done", "Antwort fertig", job.question);
        finishJob(job, "done", out === "" ? "Keine Antwort." : out);
      });
  }

  function waitFor(job, ms) {
    return new Promise((resolve) => {
      if (job.done) { resolve({ status: job.status, text: agents.get(job.agentId)?.answer ?? "" }); return; }
      const timer = setTimeout(() => resolve({ status: "running", text: "" }), ms);
      timer.unref?.();
      job.waiters.push((value) => { clearTimeout(timer); resolve(value); });
    });
  }

  /** Real stop: the relay interrupts the agent (bridge stop / turn interrupt / process-tree kill). */
  function cancelAgent(agentId) {
    const agent = agents.get(agentId);
    if (!agent) return { status: 404, error: "unknown agent" };
    if (!agent.busy) return { status: 200, ok: true, note: "nothing running" };
    const job = jobs.get(agent.jobId);
    if (job) job.cancelRequested = true;
    if (agent.relayId === null) {
      agent.abort?.abort();
    } else {
      const relay = relays.get(agent.relayId);
      if (relay) enqueue(relay, { type: "cancel", agentId: agent.id, jobId: agent.jobId });
    }
    if (job) finishJob(job, "cancelled", "");
    return { status: 200, ok: true, stopped: true };
  }

  /** Asks the machine that runs the agent (relay or this daemon) something about its sessions. */
  function rpc(agent, command) {
    if (agent.relayId === null) {
      const call = command.type === "sessions" ? localController.sessions()
        : command.type === "session.new" ? localController.newSession(command.title)
          : localController.select(String(command.sessionId ?? ""));
      return call
        .then((data) => ({ ok: true, data: { ...data, transport: localController.transport() } }))
        .catch((error) => ({ ok: false, status: 502, error: String(error?.message ?? error).slice(0, 160) }));
    }
    const relay = relays.get(agent.relayId);
    if (!relay || !isOnline(agent)) return Promise.resolve({ ok: false, status: 503, error: "agent offline" });
    const reqId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { rpcs.delete(reqId); resolve({ ok: false, status: 504, error: "relay did not answer" }); }, options.rpcTimeoutMs ?? RPC_TIMEOUT_MS);
      timer.unref?.();
      rpcs.set(reqId, { resolve, timer });
      enqueue(relay, { ...command, reqId, agentId: agent.id });
    });
  }

  // ------------------------------------------------------------- approvals
  function createApproval(agentId, tool, summary) {
    const card = {
      id: randomUUID().slice(0, 12),
      agentId,
      title: `${tool}${summary ? `: ${summary}` : ""}`.slice(0, 160),
      detail: summary ? summary.slice(0, 300) : null,
      tool,
      createdAt: new Date(now()).toISOString(),
      expiresAt: now() + cfg.approvalTimeoutMs,
      resolve: null,
    };
    const promise = new Promise((resolve) => { card.resolve = resolve; });
    approvals.set(card.id, card);
    addEvent(agentId, "waiting", `Freigabe: ${card.title}`.slice(0, 180), null);
    const timer = setTimeout(() => settleApproval(card.id, "deny"), cfg.approvalTimeoutMs);
    timer.unref?.();
    card.timer = timer;
    card.suggestions = [];
    if (cfg.suggestions) {
      void suggestions("card", card.title, "").then((list) => { if (approvals.has(card.id)) card.suggestions = list; });
    }
    return { card, promise };
  }

  function settleApproval(cardId, decision) {
    const card = approvals.get(cardId);
    if (!card) return false;
    approvals.delete(cardId);
    clearTimeout(card.timer);
    card.resolve(decision === "allow" ? "allow" : "deny");
    return true;
  }

  // ------------------------------------------------------------- speech / AI helpers
  /**
   * Follow-up options for the glasses. ALWAYS from the Spark vLLM, for every
   * agent kind and for permission cards; never from the agent itself and never
   * a canned fallback: if vLLM fails or is slow, there are no suggestions.
   */
  async function suggestions(kind, subject, answer) {
    const started = now();
    const de = cfg.lang !== "en";
    const text = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
    const prompt = kind === "card"
      ? (de
        ? `Ein Agent bittet um Freigabe: "${text(subject, 300)}"\nNenne 3 sehr kurze Antwortoptionen des Nutzers (je höchstens 32 Zeichen, Deutsch). Nur ein JSON-Array von Strings, sonst nichts.`
        : `An agent asks for permission: "${text(subject, 300)}"\nGive 3 very short reply options for the user (each at most 32 characters, English). Only a JSON array of strings, nothing else.`)
      : (de
        ? `Du schlägst Antworten vor, die der Nutzer per Datenbrille mit einem Tipp an seinen KI-Agenten zurückschickt.\nNutzer: "${text(subject, 300)}"\nAgent: "${text(answer, 1200)}"\nGib 3 verschiedene, konkrete nächste Nachrichten des Nutzers an den Agenten, die das Gespräch sinnvoll weiterführen: z. B. den Vorschlag des Agenten umsetzen lassen, gezielt zu einem genannten Detail nachhaken, oder eine passende nächste Aufgabe. Bezieh dich auf konkrete Inhalte der Antwort. Keine Floskeln wie "Danke", "Ok", "Erzähl mehr", keine Wiederholung der Frage. Du-Form, Deutsch, je höchstens 28 Zeichen. Nur ein JSON-Array von 3 Strings.`
        : `You suggest replies the user sends back to their AI agent with one tap on smart glasses.\nUser: "${text(subject, 300)}"\nAgent: "${text(answer, 1200)}"\nGive 3 different, concrete next messages from the user that move the conversation forward: e.g. have the agent carry out what it proposed, dig into a specific detail it mentioned, or a fitting next task. Refer to concrete content of the answer. No filler like "Thanks", "Ok", "Tell me more", don't repeat the question. English, each at most 28 characters. Only a JSON array of 3 strings.`);
    try {
      const res = await fetchImpl(`${cfg.vllmUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(cfg.suggestTimeoutMs),
        body: JSON.stringify({
          model: cfg.vllmModel,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.5,
          chat_template_kwargs: { enable_thinking: false },
          max_tokens: 120,
        }),
      });
      if (!res.ok) throw new Error(`vllm http ${res.status}`);
      const data = await res.json();
      const raw = String(data.choices?.[0]?.message?.content ?? "");
      const start = raw.indexOf("[");
      const end = raw.lastIndexOf("]");
      if (start < 0 || end <= start) throw new Error("vllm returned no JSON array");
      const list = JSON.parse(raw.slice(start, end + 1));
      const clean = (Array.isArray(list) ? list : []).map((item) => String(item).trim()).filter((item) => item !== "" && Buffer.byteLength(item) <= 32).slice(0, 3);
      log(`suggestions (${kind}): vLLM ${cfg.vllmModel} ok, ${clean.length} in ${now() - started} ms`);
      return clean;
    } catch (error) {
      log(`suggestions (${kind}): vLLM failed (${String(error?.message ?? error).slice(0, 100)}), showing none`);
      return [];
    }
  }
  const suggestFor = (question, answer) => suggestions("answer", question, answer);

  /** Self-hosted Whisper (OpenAI-compatible). Audio goes nowhere else. */
  async function transcribe(bytes, mime) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime || "audio/wav" }), mime?.includes("wav") || !mime ? "voice.wav" : "voice-note");
    form.append("model", cfg.whisperModel);
    form.append("language", cfg.whisperLang);
    const res = await fetchImpl(cfg.whisperUrl, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`whisper http ${res.status}`);
    const data = await res.json();
    return String(data.text ?? "").trim();
  }

  // ------------------------------------------------------------- report
  const agentInfo = (agent) => ({
    id: agent.id, label: agent.label, kind: agent.kind, machine: agent.machine, mode: agent.mode,
    online: isOnline(agent), busy: agent.busy, busySince: agent.busy ? agent.busySince ?? null : null, activity: agent.activity, error: agent.error,
    answer: agent.answer, lastQuestion: agent.lastQuestion, suggestions: agent.suggestions, suggesting: agent.suggesting === true,
    transport: agent.transport, sessionsSupported: agent.sessionsSupported,
    session: agent.session ? { id: agent.session.id, title: agent.session.title } : null,
    stopped: agent.stopped, stopConfirmed: agent.stopConfirmed,
  });

  function report() {
    const list = [...agents.values()].map(agentInfo);
    const main = agents.get(defaultAgentId() ?? "");
    return {
      connection: "connected",
      agent: {
        provider: main?.label ?? "Agent",
        questions: QUESTIONS,
        selected: 0,
        answer: main?.answer ?? null,
        lastQuestion: main?.lastQuestion ?? null,
        busy: main?.busy ?? false,
        suggestions: main?.suggestions ?? [],
      },
      agents: list,
      approvals: [...approvals.values()].map(({ id, agentId, title, detail, tool, createdAt, expiresAt, suggestions: options_ }) => ({ id, agentId, title, detail, tool, createdAt, expiresAt, suggestions: options_ ?? [] })),
      home: { selected: 0, devices: ha ? ha.devices() : homeDemo, demo: !ha },
      printer: moon ? moon.printer() : printerDemo,
      inbox: { events: state.events, selected: 0 },
    };
  }

  // ------------------------------------------------------------- HTTP
  function sendJson(res, status, body) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Private-Network": "true",
      "Access-Control-Max-Age": "600",
    };
    // A 204 (CORS preflight answer) must carry no body and no Content-Length:
    // WebKit rejects the malformed preflight and the real request never follows.
    if (status === 204) { res.writeHead(204, cors); res.end(); return; }
    const data = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
      ...cors,
    });
    res.end(data);
  }

  function readRaw(req, limit) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) { resolve(null); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", () => resolve(null));
    });
  }
  async function readJson(req, limit = 24 * 1024 * 1024) {
    const raw = await readRaw(req, limit);
    if (raw === null) return {};
    try { return JSON.parse(raw.toString("utf8") || "{}"); } catch { return {}; }
  }

  // `tailscale serve` connects from loopback and sets Tailscale-User-Login to the
  // authenticated tailnet user; a LAN client cannot reach us via loopback to spoof it.
  const tailscaleUser = (req) => {
    const peer = String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
    if (peer !== "127.0.0.1" && peer !== "::1") return "";
    const login = String(req.headers["tailscale-user-login"] ?? "").trim().toLowerCase();
    return cfg.tailscaleUsers.includes(login) ? login : "";
  };
  const authorized = (req) => {
    if (cfg.token === "") return true;
    if (tailscaleUser(req) !== "") return true;
    return timingSafeEqual(digest(req.headers.authorization ?? ""), digest(`Bearer ${cfg.token}`));
  };

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const post = req.method === "POST";
    if (req.method === "OPTIONS") { sendJson(res, 204, {}); return; }
    if (!authorized(req)) { sendJson(res, 401, { error: "unauthorized" }); return; }

    if (req.method === "GET" && path === "/report") { sendJson(res, 200, report()); return; }
    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, { ok: true, events: state.events.length, agents: agents.size, busy: [...agents.values()].some((a) => a.busy) });
      return;
    }
    if (req.method === "GET" && path === "/agents") { sendJson(res, 200, { agents: [...agents.values()].map(agentInfo) }); return; }

    // ---- completion hook (Hermes, Claude, Codex, OpenClaw)
    if (post && path === "/events") {
      const { provider, status, title, detail } = await readJson(req);
      if (typeof provider !== "string" || provider.trim() === "" || typeof title !== "string" || title.trim() === "" ||
          typeof status !== "string" || !["done", "waiting", "error"].includes(status)) {
        sendJson(res, 400, { error: "provider, title and status (done|waiting|error) required" });
        return;
      }
      const event = addEvent(provider.trim(), status, title.trim(), typeof detail === "string" ? detail.trim() : null);
      log("event:", event.provider, event.status, event.title);
      sendJson(res, 201, { event });
      return;
    }
    if (post && path === "/events/read") {
      const { id } = await readJson(req);
      if (typeof id !== "string" || id === "") { sendJson(res, 400, { error: "id required" }); return; }
      state.events = state.events.map((event) => (event.id === id ? { ...event, read: true } : event));
      saveEvents();
      sendJson(res, 200, { ok: true });
      return;
    }

    // ---- agents
    if (post && path === "/agent/ask") {
      const body = await readJson(req);
      const question = typeof body.question === "string" ? body.question.trim() : "";
      if (question === "") { sendJson(res, 400, { error: "question required" }); return; }
      const started = startAsk(typeof body.agentId === "string" ? body.agentId : "", question, {
        sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined, fresh: body.new === true,
      });
      if (!started.job) { sendJson(res, started.status, { error: started.error }); return; }
      log("ask:", started.job.agentId, question.slice(0, 80));
      if (body.wait === false) { sendJson(res, 202, { accepted: true, jobId: started.job.id, agentId: started.job.agentId }); return; }
      const outcome = await waitFor(started.job, cfg.askTimeoutMs);
      const agent = agents.get(started.job.agentId);
      sendJson(res, 200, { answer: outcome.text, status: outcome.status, suggestions: agent?.suggestions ?? [] });
      return;
    }

    if (post && path === "/agent/voice") {
      const type = String(req.headers["content-type"] ?? "");
      let bytes;
      let mime = "audio/wav";
      let body = {};
      if (type.startsWith("audio/") || type.startsWith("application/octet-stream")) {
        bytes = await readRaw(req, MAX_AUDIO);
        mime = type.split(";")[0] || "audio/wav";
      } else {
        body = await readJson(req);
        if (typeof body.audio === "string" && body.audio !== "") {
          bytes = Buffer.from(body.audio, "base64");
          mime = typeof body.mime === "string" && body.mime !== "" ? body.mime : "audio/wav";
        }
      }
      if (!bytes || bytes.length < 45) { sendJson(res, 400, { error: "audio required" }); return; }
      const agentId = url.searchParams.get("agentId") ?? (typeof body.agentId === "string" ? body.agentId : "");
      const target = agentId || defaultAgentId() || "";
      const agent = agents.get(target);
      if (!agent) { sendJson(res, 404, { error: "unknown agent" }); return; }
      if (!isOnline(agent)) { sendJson(res, 503, { error: "agent offline" }); return; }
      log("voice note:", bytes.length, "bytes ->", target);
      let question;
      try {
        question = await transcribe(bytes, mime);
      } catch (error) {
        console.error("[daemon] whisper failed:", String(error).slice(0, 200));
        sendJson(res, 502, { error: "transcription failed" });
        return;
      }
      if (question === "") { sendJson(res, 422, { error: "nichts verstanden" }); return; }
      log("heard:", question.slice(0, 80));
      // ask=0: transcribe only, the glasses show "heard: ..." and the wearer confirms before it is sent.
      if (url.searchParams.get("ask") === "0" || body.ask === false) {
        sendJson(res, 200, { question, asked: false, agentId: target });
        return;
      }
      const started = startAsk(target, question);
      if (!started.job) { sendJson(res, started.status, { error: started.error, question }); return; }
      const wait = url.searchParams.get("wait") !== "0" && body.wait !== false && url.searchParams.get("wait") !== "false";
      if (!wait) { sendJson(res, 202, { question, accepted: true, jobId: started.job.id, agentId: target }); return; }
      const outcome = await waitFor(started.job, cfg.askTimeoutMs);
      sendJson(res, 200, { question, answer: outcome.text, status: outcome.status, suggestions: agents.get(target)?.suggestions ?? [] });
      return;
    }

    if (post && path === "/agent/approve") {
      const { cardId, decision } = await readJson(req);
      if (typeof cardId !== "string" || (decision !== "allow" && decision !== "deny")) {
        sendJson(res, 400, { error: "cardId and decision (allow|deny) required" });
        return;
      }
      if (!settleApproval(cardId, decision)) { sendJson(res, 404, { error: "unknown or expired card" }); return; }
      log("approval", cardId, decision);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (post && path === "/agent/cancel") {
      const { agentId } = await readJson(req);
      const outcome = cancelAgent(typeof agentId === "string" ? agentId : defaultAgentId() ?? "");
      sendJson(res, outcome.status, outcome.error ? { error: outcome.error } : { ok: true, stopped: outcome.stopped === true });
      return;
    }

    // ---- sessions
    if (req.method === "GET" && path === "/agent/sessions") {
      const agent = agents.get(url.searchParams.get("agentId") ?? defaultAgentId() ?? "");
      if (!agent) { sendJson(res, 404, { error: "unknown agent" }); return; }
      if (!isOnline(agent)) { sendJson(res, 503, { error: "agent offline" }); return; }
      const out = await rpc(agent, { type: "sessions" });
      if (!out.ok) { sendJson(res, out.status ?? 502, { error: out.error }); return; }
      const data = out.data ?? {};
      if (typeof data.transport === "string") agent.transport = data.transport.slice(0, 16);
      const current = agent.session?.id ?? (typeof data.active === "string" && data.active !== "" ? data.active : null);
      const sessions = (Array.isArray(data.items) ? data.items : []).slice(0, 12).map((item) => ({
        id: String(item.id), title: String(item.title ?? "").slice(0, 60), when: String(item.when ?? "").slice(0, 8), updated: Number(item.updated ?? 0), current: item.id === current,
      }));
      sendJson(res, 200, {
        agentId: agent.id, supported: data.supported !== false, transport: agent.transport,
        current: agent.session ? { id: agent.session.id, title: agent.session.title } : null, sessions,
      });
      return;
    }

    if (post && (path === "/agent/session/new" || path === "/agent/session/select")) {
      const body = await readJson(req);
      const agent = agents.get(typeof body.agentId === "string" && body.agentId !== "" ? body.agentId : defaultAgentId() ?? "");
      if (!agent) { sendJson(res, 404, { error: "unknown agent" }); return; }
      if (!isOnline(agent)) { sendJson(res, 503, { error: "agent offline" }); return; }
      if (agent.busy) { sendJson(res, 409, { error: "agent busy" }); return; }
      const isNew = path.endsWith("/new");
      if (!isNew && (typeof body.sessionId !== "string" || body.sessionId === "")) { sendJson(res, 400, { error: "sessionId required" }); return; }
      const out = await rpc(agent, isNew ? { type: "session.new", title: typeof body.title === "string" ? body.title.slice(0, 60) : undefined } : { type: "session.select", sessionId: body.sessionId });
      if (!out.ok) { sendJson(res, out.status ?? 502, { error: out.error }); return; }
      const data = out.data ?? {};
      if (typeof data.transport === "string") agent.transport = data.transport.slice(0, 16);
      agent.stopped = false;
      agent.stopConfirmed = false;
      agent.error = null;
      agent.activity = "";
      agent.suggestions = [];
      agent.suggesting = false;
      if (isNew) {
        const id = typeof data.id === "string" && data.id !== "" ? data.id : null;
        setSession(agent, { id, title: "", fresh: id === null });
        agent.answer = null;
        agent.lastQuestion = null;
      } else {
        setSession(agent, { id: body.sessionId, title: typeof body.title === "string" ? body.title.slice(0, 60) : "", fresh: false });
        agent.answer = typeof data.lastAssistant === "string" ? clipTail(data.lastAssistant, 4000) : null;
        agent.lastQuestion = typeof data.lastUser === "string" ? data.lastUser.slice(0, 200) : null;
      }
      log(isNew ? "session new:" : "session select:", agent.id);
      sendJson(res, 200, { ok: true, session: { id: agent.session.id, title: agent.session.title }, transport: agent.transport });
      return;
    }

    // ---- relay protocol (outbound from other machines)
    if (post && path === "/relay/register") {
      const { machine, agents: specs } = await readJson(req);
      const name = String(machine ?? "").replace(/[^\w.-]/g, "-").slice(0, 40);
      if (name === "" || !Array.isArray(specs) || specs.length === 0 || specs.length > 32) {
        sendJson(res, 400, { error: "machine and agents[] required" });
        return;
      }
      const clean = specs.filter((s) => s && typeof s.id === "string" && /^[\w.-]{1,40}$/.test(s.id));
      const taken = clean.find((s) => agents.get(s.id) && agents.get(s.id).relayId !== name);
      if (taken) { sendJson(res, 409, { error: `agent id already used by another machine: ${taken.id}` }); return; }
      const previous = relays.get(name);
      if (previous?.waiter) { clearTimeout(previous.waiter.timer); sendJson(previous.waiter.res, 200, { commands: [] }); }
      for (const [id, agent] of agents) if (agent.relayId === name && !clean.some((s) => s.id === id)) agents.delete(id);
      relays.set(name, { id: name, machine: name, queue: [], waiter: null, lastSeen: now() });
      for (const spec of clean) upsertAgent(spec, name, name);
      log(`relay "${name}" registered: ${clean.map((s) => s.id).join(", ")}`);
      sendJson(res, 200, { relayId: name });
      return;
    }

    if (req.method === "GET" && path === "/relay/poll") {
      const relay = relays.get(url.searchParams.get("relay") ?? "");
      if (!relay) { sendJson(res, 404, { error: "unknown relay" }); return; }
      relay.lastSeen = now();
      if (relay.waiter) { clearTimeout(relay.waiter.timer); sendJson(relay.waiter.res, 200, { commands: [] }); relay.waiter = null; }
      if (relay.queue.length > 0) { sendJson(res, 200, { commands: relay.queue.splice(0) }); return; }
      const timer = setTimeout(() => {
        relay.waiter = null;
        relay.lastSeen = now();
        sendJson(res, 200, { commands: [] });
      }, options.pollHoldMs ?? POLL_HOLD_MS);
      relay.waiter = { res, timer };
      res.on("close", () => {
        if (relay.waiter?.res === res) { clearTimeout(timer); relay.waiter = null; relay.lastSeen = now(); }
      });
      return;
    }

    if (post && path === "/relay/result") {
      const { jobId, status, text, activity, error, sessionId, transport } = await readJson(req);
      const job = jobs.get(jobId);
      if (!job) { sendJson(res, 404, { error: "unknown job" }); return; }
      const agent = agents.get(job.agentId);
      if (agent && status !== "running") noteResult(agent, { sessionId, transport });
      else if (agent && typeof transport === "string") agent.transport = transport.slice(0, 16);
      if (agent && status === "cancelled" && job.cancelRequested) agent.stopConfirmed = true;
      const body = typeof text === "string" ? clipTail(text, 4000) : "";
      if (status === "running") {
        if (agent && !job.done) { agent.answer = body; agent.activity = typeof activity === "string" ? activity.slice(0, 80) : ""; }
      } else if (status === "done" || status === "error" || status === "cancelled") {
        finishJob(job, status, body, typeof error === "string" ? error : null);
      } else {
        sendJson(res, 400, { error: "bad status" });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (post && path === "/relay/reply") {
      const { reqId, ok, data, error } = await readJson(req);
      const pending = rpcs.get(reqId);
      if (!pending) { sendJson(res, 404, { error: "unknown request" }); return; }
      rpcs.delete(reqId);
      clearTimeout(pending.timer);
      pending.resolve(ok === true ? { ok: true, data } : { ok: false, status: 502, error: typeof error === "string" ? error.slice(0, 160) : "failed" });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (post && path === "/relay/permission") {
      const { agentId, tool, summary } = await readJson(req);
      if (typeof agentId !== "string" || !agents.has(agentId)) { sendJson(res, 404, { error: "unknown agent" }); return; }
      const { card, promise } = createApproval(agentId, String(tool ?? "tool").slice(0, 40), String(summary ?? "").slice(0, 200));
      res.on("close", () => { if (!res.writableEnded) settleApproval(card.id, "deny"); });
      const decision = await promise;
      sendJson(res, 200, { decision });
      return;
    }

    // ---- home / printer
    if (post && path === "/home/toggle") {
      const { device } = await readJson(req);
      if (ha) {
        const outcome = await ha.toggle(String(device ?? ""));
        sendJson(res, outcome.status, outcome.ok ? { ok: true } : { error: outcome.error });
        return;
      }
      homeDemo = homeDemo.map((d) => (d.id === device ? { ...d, on: !d.on, state: !d.on ? "an" : "aus" } : d));
      sendJson(res, 200, { ok: true, demo: true });
      return;
    }

    if (post && path === "/printer") {
      const { action } = await readJson(req);
      if (moon) {
        const outcome = await moon.control(String(action ?? ""));
        sendJson(res, outcome.status, outcome.ok ? { ok: true } : { error: outcome.error });
        return;
      }
      printerDemo = {
        ...printerDemo,
        state: action === "cancel" ? "ready" : action === "pause" ? "paused" : "printing",
        job: action === "cancel" ? null : printerDemo.job,
      };
      sendJson(res, 200, { ok: true, demo: true });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }

  // One access line per request (no tokens, no query string): tells whether the
  // phone/glasses reach the hub at all. Relay long-polls are heartbeats - skipped.
  const accessLog = options.accessLog ?? ((line) => console.log(`[access] ${line}`));
  const quietPath = (path) => path === "/relay/poll" || path === "/relay/register";
  const clientIp = (req) => {
    const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    return (forwarded || req.socket?.remoteAddress || "-").replace(/^::ffff:/, "");
  };
  const server = createServer((req, res) => {
    const started = Date.now();
    const path = (req.url ?? "/").split("?")[0].slice(0, 120);
    if (accessLog && !quietPath(path)) {
      res.on("finish", () => {
        // Auth shape only (scheme + token length), never the value: tells a missing
        // or mangled header apart from a wrong token when a client gets 401.
        const auth = String(req.headers.authorization ?? "");
        let authShape = auth === "" ? "auth=none" : `auth=len${Math.max(0, auth.length - auth.indexOf(" ") - 1)}`;
        if (auth === "" && tailscaleUser(req) !== "") authShape = "auth=tailscale";
        // On 401 add a short one-way fingerprint so a stale or mixed-up token can be identified.
        if (res.statusCode === 401 && auth !== "") authShape += ` fp=${digest(auth.slice(auth.indexOf(" ") + 1)).toString("hex").slice(0, 8)}`;
        accessLog(`${new Date(started).toISOString()} ${clientIp(req)} ${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms ${authShape}`);
      });
    }
    handle(req, res).catch((error) => {
      console.error("[daemon] handler error:", String(error).slice(0, 200));
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
  });

  return {
    server,
    state,
    agents,
    relays,
    approvals,
    report,
    listen(port, host) {
      startBackground();
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    close() {
      for (const t of timers) clearInterval(t);
      localController?.close();
      for (const pending of rpcs.values()) clearTimeout(pending.timer);
      for (const relay of relays.values()) if (relay.waiter) clearTimeout(relay.waiter.timer);
      for (const card of approvals.values()) clearTimeout(card.timer);
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
    describe: () => ({ whisper: cfg.whisperUrl, ha: ha !== null, moonraker: moon !== null, localAgent: cfg.localAgent ? cfg.localAgentId : null, auth: cfg.token !== "" }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8787);
  // 0.0.0.0 so the phone (LAN or Tailscale) can reach the daemon; HOST=127.0.0.1 keeps it local.
  const host = process.env.HOST ?? "0.0.0.0";
  const hub = createHub();
  hub.listen(port, host).then(() => {
    const d = hub.describe();
    console.log(`[daemon] Quiet Hub daemon on http://${host}:${port} (local agent: ${d.localAgent ?? "off"}, whisper: ${d.whisper}, home: ${d.ha ? "Home Assistant" : "DEMO"}, printer: ${d.moonraker ? "Moonraker" : "DEMO"}, auth: ${d.auth ? "bearer" : "none"})`);
  });
}

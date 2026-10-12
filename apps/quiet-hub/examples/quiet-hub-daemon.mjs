#!/usr/bin/env node
/**
 * Quiet Hub daemon — one process, three adapters.
 *
 * The glasses see four endpoints and nothing else; every token lives here.
 * The agent adapter is REAL: a question on the glasses runs `hermes chat -q`
 * against the same Hermes installation the user chats with — same profile,
 * same memory, same assistant. Voice notes take the same path after a stop
 * at the self-hosted Whisper server.
 *
 *   node quiet-hub-daemon.mjs        # listens on :8787 (PORT env to change)
 *
 * Env:
 *   PORT        listen port (default 8787)
 *   HERMES_BIN  hermes executable (default "hermes" from PATH)
 *   ASK_TIMEOUT_MS    hard cap per question (default 300000)
 *   WHISPER_URL       OpenAI-compatible transcriptions endpoint
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PORT = Number(process.env.PORT ?? 8787);
// Listen address. 0.0.0.0 so the phone (LAN or Tailscale) can reach the
// daemon; set HOST=127.0.0.1 to keep it on this machine only.
const HOST = process.env.HOST ?? "0.0.0.0";
// Optional shared secret: when set, every request needs `Authorization: Bearer …`.
const HUB_TOKEN = process.env.HUB_TOKEN ?? "";
const HERMES_BIN = process.env.HERMES_BIN ?? "hermes";
const ASK_TIMEOUT_MS = Number(process.env.ASK_TIMEOUT_MS ?? 300_000);
const STATE_FILE = process.env.QUIET_HUB_STATE_FILE ?? join(homedir(), ".local", "state", "quiet-hub", "state.json");
const WHISPER_URL =
  process.env.WHISPER_URL ?? "http://100.86.70.71:8015/v1/audio/transcriptions";

// ---- state: the hub snapshot. HA/Moonraker adapters replace these. ----
const state = {
  answer: /** @type {string|null} */ (null),
  lastQuestion: /** @type {string|null} */ (null),
  busy: false,
  events: loadEvents(),
  // Follow-up suggestions of the last answer; shown as tappable list.
  suggestions: /** @type {string[]} */ ([]),
  home: {
    selected: 0,
    devices: [
      { id: "light_office", label: "Büro · Licht", kind: "switch", state: "an", on: true, writable: true },
      { id: "light_living", label: "Wohnzimmer · Licht", kind: "switch", state: "aus", on: false, writable: true },
      { id: "heat_kitchen", label: "Heizung · Küche", kind: "climate", state: "21,5°", on: true, writable: true },
      { id: "shade_office", label: "Jalousie · Büro", kind: "cover", state: "offen", on: false, writable: true },
      { id: "plug_printer", label: "Steckdose · Drucker", kind: "switch", state: "an", on: true, writable: true },
    ],
  },
  printer: {
    job: "esp32_gehaeuse.stl",
    state: "printing",
    layer: 148,
    layers: 205,
    etaMin: 41,
    nozzleC: 210,
    bedC: 60,
    selected: 0,
  },
};

function loadEvents() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return Array.isArray(parsed.events) ? parsed.events.slice(0, 50) : [];
  } catch {
    return [];
  }
}

function saveEvents() {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    const temporary = `${STATE_FILE}.tmp`;
    writeFileSync(temporary, JSON.stringify({ events: state.events }, null, 2), { mode: 0o600 });
    renameSync(temporary, STATE_FILE);
  } catch (error) {
    console.error("[daemon] state save failed:", String(error).slice(0, 200));
  }
}

function addEvent(provider, status, title, detail = null) {
  const event = {
    id: `${Date.now()}-${randomUUID().slice(0, 8)}`,
    provider: String(provider).slice(0, 32),
    status,
    title: String(title).slice(0, 180),
    detail: detail == null || detail === "" ? null : String(detail).slice(0, 300),
    createdAt: new Date().toISOString(),
    read: false,
  };
  state.events = [event, ...state.events].slice(0, 50);
  saveEvents();
  return event;
}

const QUESTIONS = ["Was steht heute an?", "Wie läuft das Projekt?", "Fass den Tag zusammen"];

function report() {
  return {
    connection: "connected",
    agent: {
      provider: "Hermes",
      questions: QUESTIONS,
      selected: 0,
      answer: state.answer,
      lastQuestion: state.lastQuestion,
      busy: state.busy,
      suggestions: state.suggestions,
    },
    home: state.home,
    printer: state.printer,
    inbox: { events: state.events, selected: 0 },
  };
}

/**
 * The assistant may answer as {"reply": "...", "suggestions": ["...", ...]}.
 * Parse tolerantly: plain text stays the reply, suggestions then stay empty.
 */
const VLLM_URL = process.env.VLLM_URL ?? "http://100.86.70.71:8000/v1";
const VLLM_MODEL = process.env.VLLM_MODEL ?? "qwen";

/**
 * Follow-up suggestions come from the LOCAL vLLM (qwen) — the main model
 * only ever writes the answer. Cheap tokens, fast, and offline-capable.
 */
async function suggestFor(question, answer) {
  try {
    const res = await fetch(`${VLLM_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: VLLM_MODEL,
        messages: [{
          role: "user",
          content: `Frage: "${question}"\nAntwort: "${answer}"\nNenne 3 sehr kurze Folgefragen darauf (je max 24 Zeichen, Deutsch). Nur ein JSON-Array von Strings, sonst nichts.`,
        }],
        temperature: 0.7,
        // qwen3 is a reasoning model — without this the thinking eats all
        // max_tokens and content stays null.
        chat_template_kwargs: { enable_thinking: false },
        max_tokens: 400,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const text = String(data.choices?.[0]?.message?.content ?? "");
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start < 0 || end <= start) return [];
    const list = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(list) ? list.map((s) => String(s).trim()).filter(Boolean).slice(0, 4) : [];
  } catch (error) {
    console.error("[daemon] suggestions failed:", String(error).slice(0, 200));
    return [];
  }
}

function parseAgentEnvelope(out) {
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(out.slice(start, end + 1));
      const reply = String(parsed.reply ?? parsed.answer ?? "").trim();
      const list = Array.isArray(parsed.suggestions)
        ? parsed.suggestions.map((s) => String(s).trim()).filter((s) => s !== "").slice(0, 4)
        : [];
      if (reply !== "") {
        state.suggestions = list;
        return reply;
      }
    } catch { /* fall through to plain text */ }
  }
  state.suggestions = [];
  return out;
}

/** Ask the real assistant. Same install, same memory as the chat. */
function askHermes(question) {
  return new Promise((resolve) => {
    // Keep glasses answers short: three wrapped rows at most (138 chars).
    const prompt = `${question}\n\n(Antworte auf Deutsch in einem kurzen Satz von höchstens 110 Zeichen. Schreibe keine Zeichenzahl und keine Meta-Kommentare in die Antwort.)`;
    execFile(
      HERMES_BIN,
      ["chat", "-q", prompt, "-Q", "--format", "text"],
      { timeout: ASK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const out = String(stdout ?? "").trim();
        if (error && out === "") {
          console.error("[daemon] hermes failed:", String(stderr || error).slice(0, 400));
          resolve("Keine Antwort vom Assistenten.");
          return;
        }
        resolve(out === "" ? "Keine Antwort." : out);
      },
    );
  });
}

/** Self-hosted Whisper (OpenAI-compatible). Audio goes nowhere else. */
async function transcribe(base64Audio, mime) {
  const bytes = Buffer.from(base64Audio, "base64");
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime || "audio/mpeg" }), "voice-note");
  form.append("model", "whisper-1");
  form.append("language", "de");
  const res = await fetch(WHISPER_URL, { method: "POST", body: form });
  if (!res.ok) throw new Error(`whisper http ${res.status}`);
  const data = await res.json();
  return String(data.text ?? "").trim();
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
    // The app is served from another origin (vite / simulator webview).
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); }
    });
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (req.method === "OPTIONS") { json(res, 204, {}); return; }

  if (HUB_TOKEN !== "") {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${HUB_TOKEN}`) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/report") {
    json(res, 200, report());
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true, events: state.events.length, busy: state.busy });
    return;
  }

  // Completion hook for Hermes, Claude, Codex and OpenClaw. Keep this generic:
  // every runner only needs one authenticated HTTP POST when it finishes or
  // needs user input.
  if (req.method === "POST" && url.pathname === "/events") {
    const { provider, status, title, detail } = await readBody(req);
    const allowed = new Set(["done", "waiting", "error"]);
    if (typeof provider !== "string" || provider.trim() === "" ||
        typeof title !== "string" || title.trim() === "" ||
        typeof status !== "string" || !allowed.has(status)) {
      json(res, 400, { error: "provider, title and status (done|waiting|error) required" });
      return;
    }
    const event = addEvent(provider.trim(), status, title.trim(), typeof detail === "string" ? detail.trim() : null);
    console.log("[daemon] event:", event.provider, event.status, event.title);
    json(res, 201, { event });
    return;
  }

  if (req.method === "POST" && url.pathname === "/events/read") {
    const { id } = await readBody(req);
    if (typeof id !== "string" || id === "") {
      json(res, 400, { error: "id required" });
      return;
    }
    state.events = state.events.map((event) => event.id === id ? { ...event, read: true } : event);
    saveEvents();
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent/ask") {
    const { question } = await readBody(req);
    if (typeof question !== "string" || question.trim() === "") {
      json(res, 400, { error: "question required" });
      return;
    }
    console.log("[daemon] ask:", question);
    state.busy = true;
    let answer;
    try {
      answer = await askHermes(question.trim());
    } finally {
      state.busy = false;
    }
    console.log("[daemon] answer:", answer.slice(0, 120));
    state.lastQuestion = question.trim();
    state.answer = answer;
    state.suggestions = await suggestFor(question.trim(), answer);
    addEvent("Hermes", "done", "Antwort fertig", question.trim());
    json(res, 200, { answer, suggestions: state.suggestions });
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent/voice") {
    const { audio, mime } = await readBody(req);
    if (typeof audio !== "string" || audio === "") {
      json(res, 400, { error: "audio (base64) required" });
      return;
    }
    console.log("[daemon] voice note:", Math.round((audio.length * 3) / 4), "bytes");
    let question;
    try {
      question = await transcribe(audio, typeof mime === "string" ? mime : "");
    } catch (error) {
      console.error("[daemon] whisper failed:", String(error).slice(0, 200));
      json(res, 502, { error: "transcription failed" });
      return;
    }
    if (question === "") {
      json(res, 422, { error: "nichts verstanden" });
      return;
    }
    console.log("[daemon] heard:", question);
    state.busy = true;
    let answer;
    try {
      answer = await askHermes(question);
    } finally {
      state.busy = false;
    }
    console.log("[daemon] answer:", answer.slice(0, 120));
    state.lastQuestion = question;
    state.answer = answer;
    state.suggestions = await suggestFor(question, answer);
    addEvent("Hermes", "done", "Sprachantwort fertig", question);
    json(res, 200, { question, answer, suggestions: state.suggestions });
    return;
  }

  if (req.method === "POST" && url.pathname === "/home/toggle") {
    const { device } = await readBody(req);
    state.home.devices = state.home.devices.map((d) =>
      d.id === device ? { ...d, on: !d.on, state: !d.on ? "an" : "aus" } : d,
    );
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/printer") {
    const { action } = await readBody(req);
    state.printer = {
      ...state.printer,
      state: action === "cancel" ? "ready" : action === "pause" ? "paused" : "printing",
      job: action === "cancel" ? null : state.printer.job,
    };
    json(res, 200, { ok: true });
    return;
  }

  json(res, 404, { error: "not found" });
}).listen(PORT, HOST, () => {
  console.log(`[daemon] Quiet Hub daemon on http://${HOST}:${PORT} (agent: ${HERMES_BIN}, whisper: ${WHISPER_URL}${HUB_TOKEN ? ", auth: bearer" : ""})`);
});

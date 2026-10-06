#!/usr/bin/env node
/**
 * Shoot Day reference server: stores projects (shot list, takes, script,
 * schedule, packing list), serves the web terminal for editing them, and
 * proxies speech to a Whisper-compatible recogniser you run yourself.
 *
 *   node shoot-day-server.mjs                       # http://127.0.0.1:8899/
 *   PORT=9000 TOKEN=secret node shoot-day-server.mjs
 *   WHISPER_URL=http://127.0.0.1:8017/v1/audio/transcriptions node shoot-day-server.mjs
 *
 * Environment
 *   PORT          port (default 8899)
 *   HOST          address to bind (default 127.0.0.1 — this machine only)
 *   TOKEN         bearer token required on every /api request (recommended,
 *                 required in practice once HOST is not loopback)
 *   DATA_FILE     where projects are stored (default ./shoot-day-data.json)
 *   WHISPER_URL   OpenAI-compatible /v1/audio/transcriptions endpoint; without
 *                 it, voice commands are switched off
 *   WHISPER_MODEL model name sent to it (default whisper-1)
 *   PRESET_LANG   language of the packing-list template: de or en (default en)
 *
 * The glasses app runs inside the Even app over https, so the phone can only
 * reach this server over https as well — put it behind `tailscale serve`, a
 * reverse proxy with a certificate, or similar.
 *
 * Dependency-free: Node 18+ only.
 */
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env["PORT"] ?? 8899);
const HOST = process.env["HOST"] ?? "127.0.0.1";
const TOKEN = process.env["TOKEN"] ?? "";
const DATA_FILE = resolve(process.env["DATA_FILE"] ?? "shoot-day-data.json");
const WHISPER_URL = process.env["WHISPER_URL"] ?? "";
const WHISPER_MODEL = process.env["WHISPER_MODEL"] ?? "whisper-1";
const WHISPER_TIMEOUT_MS = Number(process.env["WHISPER_TIMEOUT_MS"] ?? 30000);
const PRESET_LANG = process.env["PRESET_LANG"] === "de" ? "de" : "en";

const MAX_JSON = 256 * 1024;          // a whole project with a long script
const MAX_AUDIO = 2 * 1024 * 1024;    // ~60 s of 16 kHz mono PCM
const TEXT = 200;

// ---------------------------------------------------------------------------
// Packing-list template. Generic on purpose — rename, add and remove items in
// the web terminal; each project keeps its own copy.
// ---------------------------------------------------------------------------
const PRESETS = {
  de: [
    ["Kamera", ["Kamera A", "Kamera B", "Objektiv Weitwinkel", "Objektiv Tele", "Polfilter", "ND-Filter"]],
    ["Halterung", ["Gimbal", "Videostativ", "Bohnensack"]],
    ["Licht", ["LED-Panel", "Aufsteckleuchte", "Reflektor"]],
    ["Ton", ["Tonrecorder", "Richtmikrofon", "Funkstrecke", "XLR-Kabel", "Kopfhörer", "Klappe"]],
    ["Strom", ["Akkus Kamera", "Akkus Licht", "Ladegeräte", "Verlängerungskabel"]],
    ["Speicher", ["Speicherkarten", "Kartenleser", "Backup-SSD"]],
    ["Sonstiges", ["Gaffa", "Putztuch", "Regenschutz", "Wasser"]],
  ],
  en: [
    ["Camera", ["Camera A", "Camera B", "Wide lens", "Tele lens", "Polariser", "ND filter"]],
    ["Support", ["Gimbal", "Tripod", "Bean bag"]],
    ["Light", ["LED panel", "On-camera light", "Reflector"]],
    ["Sound", ["Audio recorder", "Shotgun microphone", "Wireless kit", "XLR cable", "Headphones", "Slate"]],
    ["Power", ["Camera batteries", "Light batteries", "Chargers", "Extension cable"]],
    ["Storage", ["Memory cards", "Card reader", "Backup SSD"]],
    ["Other", ["Gaffer tape", "Lens cloth", "Rain cover", "Water"]],
  ],
};
const presetItems = () =>
  PRESETS[PRESET_LANG].flatMap(([group, names]) => names.map((name) => ({ group, name, need: false, packed: false })));

// ---------------------------------------------------------------------------
// State: { active, projects: { [name]: { name, scenes, takes, prompter, dispo, equipment } } }
// Everything about a shoot belongs to its project, so switching projects never
// leaves last week's script or packing list on the glasses.
// ---------------------------------------------------------------------------
let state = { active: "", projects: Object.create(null) };

const str = (value, max = TEXT) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "").slice(0, max);
const emptyDispo = () => ({ date: "", call: "", location: "", contact: "", notes: "", schedule: [] });

function cleanScenes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200).map((scene) => ({
    scene: str(scene?.scene, 20).trim(),
    shots: Array.isArray(scene?.shots)
      ? scene.shots.slice(0, 100).map((s) => ({ shot: str(s?.shot, 20).trim(), desc: str(s?.desc), size: str(s?.size, 20) }))
      : [],
  })).filter((scene) => scene.scene);
}

function cleanProject(name, raw = {}) {
  return {
    name,
    scenes: cleanScenes(raw.scenes),
    takes: Array.isArray(raw.takes) ? raw.takes.slice(-5000) : [],
    prompter: str(raw.prompter, 50000),
    dispo: raw.dispo && typeof raw.dispo === "object" ? cleanDispo(raw.dispo) : emptyDispo(),
    equipment: Array.isArray(raw.equipment) && raw.equipment.length ? cleanItems(raw.equipment) : presetItems(),
  };
}

function cleanDispo(b) {
  return {
    date: str(b.date, 40), call: str(b.call, 20), location: str(b.location), contact: str(b.contact), notes: str(b.notes, 1000),
    schedule: Array.isArray(b.schedule) ? b.schedule.slice(0, 200).map((row) => ({ time: str(row?.time, 20), what: str(row?.what) })) : [],
  };
}

function cleanItems(items) {
  return items.slice(0, 500).map((x) => ({
    group: str(x?.group, 40) || "Other", name: str(x?.name, 80).trim(), need: x?.need === true, packed: x?.packed === true,
  })).filter((x) => x.name);
}

function seed() {
  const name = PRESET_LANG === "de" ? "Beispiel-Dreh" : "Example shoot";
  const de = PRESET_LANG === "de";
  state.projects[name] = cleanProject(name, {
    scenes: [
      { scene: "1", shots: [{ shot: "A", desc: de ? "Totale: Ankunft" : "Wide: arrival", size: "WS" }, { shot: "B", desc: de ? "Nah: Gesicht" : "Close: face", size: "CU" }] },
      { scene: "2", shots: [{ shot: "A", desc: de ? "Dialog, Zweier" : "Dialogue, two-shot", size: "MS" }, { shot: "B", desc: de ? "Über die Schulter" : "Over the shoulder", size: "MCU" }] },
    ],
  });
  state.active = name;
}

async function load() {
  try {
    if (existsSync(DATA_FILE)) {
      const raw = JSON.parse(await readFile(DATA_FILE, "utf8"));
      for (const [name, project] of Object.entries(raw?.projects ?? {})) {
        const clean = str(name, 80).trim();
        if (clean) state.projects[clean] = cleanProject(clean, project);
      }
      state.active = str(raw?.active, 80);
    }
  } catch (error) {
    console.error("could not read " + DATA_FILE + ": " + error.message + " — starting empty");
  }
  if (Object.keys(state.projects).length === 0) seed();
  if (!state.projects[state.active]) state.active = Object.keys(state.projects)[0] ?? "";
  await persist();
}

/** Write to a temporary file first, so a crash mid-write never truncates the data. */
let writing = Promise.resolve();
function persist() {
  writing = writing.then(async () => {
    await mkdir(dirname(DATA_FILE), { recursive: true });
    const temporary = DATA_FILE + ".tmp";
    await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
    await rename(temporary, DATA_FILE);
  }).catch((error) => console.error("could not save: " + error.message));
  return writing;
}

const active = () => state.projects[state.active] ?? null;
const flatShots = (p) => (p?.scenes ?? []).flatMap((sc) => sc.shots.map((sh) => ({ scene: sc.scene, shot: sh.shot, desc: sh.desc, size: sh.size })));

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function send(response, status, body, type = "application/json; charset=utf-8") {
  response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...CORS });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}

const digest = (text) => createHash("sha256").update(text).digest();
/** Constant-time check, so response timing does not leak the TOKEN. */
function authorised(request) {
  if (!TOKEN) return true;
  return timingSafeEqual(digest(request.headers["authorization"] ?? ""), digest("Bearer " + TOKEN));
}

const TOO_LARGE = Symbol("too large");
/** Reads the body up to `limit` bytes; anything larger resolves TOO_LARGE instead of hanging. */
function readBody(request, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    request.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) { finish(TOO_LARGE); request.removeAllListeners("data"); request.resume(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => finish(Buffer.concat(chunks)));
    request.on("error", () => finish(null));
  });
}

async function readJson(request) {
  const raw = await readBody(request, MAX_JSON);
  if (raw === TOO_LARGE || raw === null) return raw;
  try { return raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { return null; }
}

async function transcribe(wav, language) {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "clip.wav");
  form.append("model", WHISPER_MODEL);
  if (language === "de" || language === "en") form.append("language", language);
  const response = await fetch(WHISPER_URL, { method: "POST", body: form, signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS) });
  if (!response.ok) throw new Error("recogniser returned HTTP " + response.status);
  const text = await response.text();
  try { return str(JSON.parse(text).text, 500).trim(); } catch { return str(text, 500).trim(); }
}

async function api(request, response, url) {
  const path = url.pathname;
  const method = request.method;
  const p = active();
  const json = async () => {
    const body = await readJson(request);
    if (body === TOO_LARGE) { send(response, 413, { error: "request too large" }); return undefined; }
    if (body === null || typeof body !== "object") { send(response, 400, { error: "invalid JSON" }); return undefined; }
    return body;
  };
  const needProject = () => { if (!p) send(response, 409, { error: "no active project" }); return Boolean(p); };

  if (path === "/api/shotlist" && method === "GET") return send(response, 200, { project: p?.name ?? "", shots: flatShots(p) });

  if (path === "/api/state" && method === "GET") {
    return send(response, 200, {
      active: state.active,
      projects: Object.values(state.projects).map((x) => ({ name: x.name, scenes: x.scenes, takeCount: x.takes.length })),
    });
  }

  if (path === "/api/project" && method === "GET") return send(response, 200, p ? { name: p.name, scenes: p.scenes } : {});

  if (path === "/api/project" && method === "POST") {
    const b = await json(); if (!b) return;
    const name = str(b.name, 80).trim();
    if (!name) return send(response, 400, { error: "name missing" });
    const previous = state.projects[name];
    state.projects[name] = cleanProject(name, { ...previous, scenes: Array.isArray(b.scenes) ? b.scenes : previous?.scenes });
    state.active = name;
    await persist();
    return send(response, 200, { name, scenes: state.projects[name].scenes });
  }

  if (path === "/api/active" && method === "POST") {
    const b = await json(); if (!b) return;
    const name = str(b.name, 80);
    if (!state.projects[name]) return send(response, 404, { error: "unknown project" });
    state.active = name;
    await persist();
    return send(response, 200, { active: name });
  }

  if (path === "/api/take" && method === "POST") {
    const b = await json(); if (!b) return;
    if (!needProject()) return;
    const scene = str(b.scene, 20);
    const shot = str(b.shot, 20);
    if (!scene && !shot) return send(response, 400, { error: "scene or shot missing" });
    const n = p.takes.filter((t) => t.scene === scene && t.shot === shot).length + 1;
    const take = { scene, shot, n, status: b.status === "NG" ? "NG" : "OK", note: str(b.note, 80), ts: Date.now() };
    p.takes.push(take);
    await persist();
    return send(response, 200, take);
  }

  if (path === "/api/take/note" && method === "POST") {
    const b = await json(); if (!b) return;
    if (!needProject()) return;
    const take = p.takes.find((t) => t.scene === str(b.scene, 20) && t.shot === str(b.shot, 20) && t.n === Number(b.n));
    if (!take) return send(response, 404, { error: "unknown take" });
    take.note = str(b.note, 80);
    await persist();
    return send(response, 200, take);
  }

  if (path === "/api/takes" && method === "GET") {
    const takes = p?.takes ?? [];
    // The glasses ask for everything (to count per shot); the web terminal shows the latest 100.
    return send(response, 200, { takes: url.searchParams.get("all") === "1" ? takes : takes.slice(-100).reverse() });
  }

  if (path === "/api/dispo" && method === "GET") return send(response, 200, p?.dispo ?? emptyDispo());
  if (path === "/api/dispo" && method === "POST") {
    const b = await json(); if (!b) return;
    if (!needProject()) return;
    p.dispo = cleanDispo(b);
    await persist();
    return send(response, 200, { ok: true });
  }

  if (path === "/api/prompter" && method === "GET") return send(response, 200, { project: p?.name ?? "", text: p?.prompter ?? "" });
  if (path === "/api/prompter" && method === "POST") {
    const b = await json(); if (!b) return;
    if (!needProject()) return;
    p.prompter = str(b.text, 50000);
    await persist();
    return send(response, 200, { ok: true, length: p.prompter.length });
  }

  if (path === "/api/equipment" && method === "GET") {
    const items = p?.equipment ?? presetItems();
    return send(response, 200, {
      project: p?.name ?? "", items,
      need: items.filter((i) => i.need).length,
      packed: items.filter((i) => i.need && i.packed).length,
    });
  }

  if (path === "/api/equipment" && method === "POST") {
    const b = await json(); if (!b) return;
    if (!needProject()) return;
    const find = (name) => p.equipment.find((x) => x.name === str(name, 80));
    // Single changes only, from the glasses and the web terminal alike: a tick
    // on one side must never overwrite what was changed on the other meanwhile.
    if (b.toggle?.name) {
      const item = find(b.toggle.name);
      if (!item) return send(response, 404, { error: "unknown item" });
      item.packed = typeof b.toggle.packed === "boolean" ? b.toggle.packed : !item.packed;
      await persist();
      return send(response, 200, {
        ok: true, name: item.name, packed: item.packed,
        need: p.equipment.filter((i) => i.need).length,
        packedCount: p.equipment.filter((i) => i.need && i.packed).length,
      });
    }
    if (b.setneed?.name) {
      const item = find(b.setneed.name);
      if (!item) return send(response, 404, { error: "unknown item" });
      item.need = b.setneed.need === true;
      if (!item.need) item.packed = false;     // what does not come along cannot be packed
      await persist();
      return send(response, 200, { ok: true, name: item.name, need: item.need });
    }
    if (b.add?.name) {
      const name = str(b.add.name, 80).trim();
      if (!name) return send(response, 400, { error: "name missing" });
      if (find(name)) return send(response, 409, { error: "already exists" });
      if (p.equipment.length >= 500) return send(response, 409, { error: "list is full" });
      p.equipment.push({ group: str(b.add.group, 40) || "Other", name, need: b.add.need !== false, packed: false });
      await persist();
      return send(response, 200, { ok: true, name });
    }
    if (b.remove?.name) {
      const before = p.equipment.length;
      p.equipment = p.equipment.filter((x) => x.name !== str(b.remove.name, 80));
      if (p.equipment.length === before) return send(response, 404, { error: "unknown item" });
      await persist();
      return send(response, 200, { ok: true });
    }
    if (b.reset === true) {
      p.equipment = presetItems();
      await persist();
      return send(response, 200, { ok: true, reset: true });
    }
    return send(response, 400, { error: "nothing to do" });
  }

  if (path === "/api/stt" && method === "POST") {
    if (!WHISPER_URL) return send(response, 503, { error: "speech recognition is not configured (WHISPER_URL)" });
    const wav = await readBody(request, MAX_AUDIO);
    if (wav === TOO_LARGE) return send(response, 413, { error: "recording too long" });
    if (!wav || wav.length <= 44) return send(response, 400, { error: "empty recording" });
    try {
      return send(response, 200, { text: await transcribe(wav, url.searchParams.get("lang") ?? "") });
    } catch (error) {
      console.error("recogniser: " + error.message);
      return send(response, 502, { error: "recogniser unavailable" });
    }
  }

  return send(response, 404, { error: "not found" });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "OPTIONS") { send(response, 204, ""); return; }
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFile(join(HERE, "shoot-day-terminal.html"), "utf8");
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(html);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (!authorised(request)) { send(response, 401, { error: "unauthorized" }); return; }
      await api(request, response, url);
      return;
    }
    send(response, 404, { error: "not found" });
  } catch (error) {
    console.error("request failed: " + error.message);
    if (!response.headersSent) send(response, 500, { error: "internal error" });
  }
});

const loopback = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";
if (!loopback && !TOKEN) {
  console.error("Refusing to listen on " + HOST + " without a TOKEN: anyone on that network could read and change your projects.");
  console.error("Set TOKEN=<a long random string>, or bind to 127.0.0.1 and publish it with `tailscale serve`.");
  process.exit(1);
}

await load();
server.listen(PORT, HOST, () => {
  console.log("Shoot Day server on http://" + HOST + ":" + PORT + "/  (project: " + (state.active || "–") + ")");
  console.log("  data: " + DATA_FILE);
  console.log("  speech: " + (WHISPER_URL ? "on" : "off (set WHISPER_URL)"));
  if (!TOKEN) console.log("  No TOKEN set: anyone who can reach this port can read and change your projects.");
});

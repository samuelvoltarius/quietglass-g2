#!/usr/bin/env node
/**
 * Shoot Day reference server: stores customers and their projects (storyboards,
 * shot list, takes, ideas, script, schedule, packing list, files), serves the
 * web terminal for editing them, and proxies speech to a Whisper-compatible
 * recogniser you run yourself.
 *
 *   node shoot-day-server.mjs                       # http://127.0.0.1:8899/
 *   PORT=9000 TOKEN=secret node shoot-day-server.mjs
 *   WHISPER_URL=http://127.0.0.1:8017/v1/audio/transcriptions node shoot-day-server.mjs
 *
 * Environment
 *   PORT          port (default 8899)
 *   HOST          address to bind (default 127.0.0.1 — this machine only)
 *   SD_TAILSCALE_USERS  Tailscale logins (comma list) that need no token when
 *                 `tailscale serve` proxies the request (loopback only)
 *   TOKEN         bearer token required on every /api request (recommended,
 *                 required in practice once HOST is not loopback)
 *   DATA_FILE     where everything is stored (default ./shoot-day-data.json)
 *   SHOOT_FILES_DIR      uploaded PDFs/pictures (default: shoot-day-files next to DATA_FILE)
 *   SHOOT_MAX_UPLOAD_MB  largest upload in MB (default 20)
 *   SHOOT_LLM_URL  OpenAI-compatible language model (…/v1 or …/v1/chat/completions)
 *                 for "storyboard from PDF"; empty = manual entry only
 *   SHOOT_LLM_MODEL      model name sent to it (optional)
 *   SHOOT_LLM_TOKEN      bearer token for it (optional)
 *   SHOOT_BABEL_URL      babel-llm-proxy base URL; the customer card then shows
 *                 matching Babel memory entries (optional, server-side call)
 *   SHOOT_BABEL_TOKEN    bearer token for the Babel proxy (optional)
 *   WHISPER_URL   OpenAI-compatible /v1/audio/transcriptions endpoint; without
 *                 it, voice commands are switched off
 *   WHISPER_MODEL model name sent to it (default whisper-1)
 *   PRESET_LANG   language of templates and of "Ohne Zuordnung": de or en (default en)
 *   SHOOT_WD_URL  Work Dashboard base URL (its MCP endpoint is <url>/mcp); with
 *                 SHOOT_WD_TOKEN (agent token wd_…) every save is mirrored there
 *                 one-way, 10 s after the last change (shoot-day-wd.mjs). Empty = off
 *   SHOOT_WD_DEBOUNCE_MS  wait after the last save (default 10000)
 *   SHOOT_WD_STATUS_OPEN, SHOOT_WD_STATUS_DONE  task status names (default open / done, as the dashboard uses)
 *   SHOOT_GCAL_*  write project dates into Google Calendar (see shoot-day-gcal.mjs); off without them
 *   SHOOT_WD_POLL_MS  how often the dashboard tasks of a project are looked at for changes made
 *                 there (cheap fingerprint; a change → the project is understood again).
 *                 Default 900000 (15 min), 0 = off; only with the Work Dashboard sync on
 *   SHOOT_EMBED_URL   OpenAI-compatible embedding service (…/v1/embeddings) for the search over
 *                 all customers and projects (shoot-day-vectors.mjs); empty = off
 *   SHOOT_EMBED_MODEL  model name sent to it (optional, empty = not sent)
 *   SHOOT_EMBED_TOKEN  bearer token for it (optional)
 *   SHOOT_VECTORS_FILE  the vector index (default: shoot-day-vectors.json next to DATA_FILE)
 *   SHOOT_INBOX_MIN  how sure the local model must be (0..1, default 0.75) before a file from the
 *                 Work Dashboard inbox is assigned to a project on its own (shoot-day-inbox.mjs); the
 *                 inbox is looked at in the rhythm of SHOOT_WD_POLL_MS, only with the sync and SHOOT_LLM_URL on
 *   SHOOT_INBOX_START_MS  first look at the inbox after the start (default 30000)
 *
 * Data file: version 2 = { version, active, customers: {id: …}, projects: {id: …} }.
 * A version-1 file (projects by name, no customers) is copied to
 * DATA_FILE.bak-v1-<time> and then migrated: every project goes to the
 * customer "Ohne Zuordnung" / "Unassigned". Every write is atomic (temporary
 * file, fsync, rename).
 *
 * The glasses app runs inside the Even app over https, so the phone can only
 * reach this server over https as well — put it behind `tailscale serve`, a
 * reverse proxy with a certificate, or similar.
 *
 * Dependency-free: Node 18+ only (plus shoot-day-pdf.mjs next to this file).
 */
import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, rename, open, copyFile, unlink, rm } from "node:fs/promises";
import { existsSync, constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { cleanScenes as cleanBoardScenes, extractPdfText, proposeScenes } from "./shoot-day-pdf.mjs";
import { asId, createWdSync } from "./shoot-day-wd.mjs";
import { classifyFile } from "./shoot-day-inbox.mjs";
import { cleanPoints, extractTalkPoints, pointCount } from "./shoot-day-talkpoints.mjs";
import { TEMPLATE_IDS, isInternalTemplate, docContext, draftDocuments, findChrome, loadBrand, matchTemplate, printPdf, templateLabel, writePurpose } from "./shoot-day-docs.mjs";
import { HINT_ID, HINT_TITLE, analyseProject, fallbackAnalysis, materialHash, projectSources } from "./shoot-day-brain.mjs";
import { createVectorIndex } from "./shoot-day-vectors.mjs";
import { configFromEnv as gcalConfig, createSync as createGcalSync } from "./shoot-day-gcal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env["PORT"] ?? 8899);
const HOST = process.env["HOST"] ?? "127.0.0.1";
const TOKEN = process.env["TOKEN"] ?? "";
const DATA_FILE = resolve(process.env["DATA_FILE"] ?? "shoot-day-data.json");
const FILES_DIR = resolve(process.env["SHOOT_FILES_DIR"] || join(dirname(DATA_FILE), "shoot-day-files"));
const MAX_UPLOAD = Math.max(1, Number(process.env["SHOOT_MAX_UPLOAD_MB"] || 20)) * 1024 * 1024;
const LLM_URL = process.env["SHOOT_LLM_URL"] ?? "";
const LLM_MODEL = process.env["SHOOT_LLM_MODEL"] ?? "";
const LLM_TOKEN = process.env["SHOOT_LLM_TOKEN"] ?? "";
const LLM_TIMEOUT_MS = Number(process.env["SHOOT_LLM_TIMEOUT_MS"] || 180_000);
const BABEL_URL = process.env["SHOOT_BABEL_URL"] ?? "";
const BABEL_TOKEN = process.env["SHOOT_BABEL_TOKEN"] ?? "";
const WHISPER_URL = process.env["WHISPER_URL"] ?? "";
const WHISPER_MODEL = process.env["WHISPER_MODEL"] ?? "whisper-1";
const WHISPER_TIMEOUT_MS = Number(process.env["WHISPER_TIMEOUT_MS"] ?? 30000);
const PRESET_LANG = process.env["PRESET_LANG"] === "de" ? "de" : "en";
const WD_URL = (process.env["SHOOT_WD_URL"] ?? "").trim();
const WD_TOKEN = (process.env["SHOOT_WD_TOKEN"] ?? "").trim();
const BRAND_FILE = (process.env["SHOOT_BRAND_FILE"] ?? "").trim();
const BRAIN_DEBOUNCE_MS = Number(process.env["SHOOT_BRAIN_DEBOUNCE_MS"] || 120_000);   // after the last change to a project
const BRAIN_SWEEP_MS = Number(process.env["SHOOT_BRAIN_SWEEP_MS"] || 6 * 3600_000);    // look at every project now and then
const WD_POLL_MS = Number(process.env["SHOOT_WD_POLL_MS"] ?? 15 * 60_000);
const EMBED_URL = (process.env["SHOOT_EMBED_URL"] ?? "").trim();
const EMBED_MODEL = (process.env["SHOOT_EMBED_MODEL"] ?? "").trim();
const EMBED_TOKEN = (process.env["SHOOT_EMBED_TOKEN"] ?? "").trim();
const VECTORS_FILE = resolve(process.env["SHOOT_VECTORS_FILE"] || join(dirname(DATA_FILE), "shoot-day-vectors.json"));
const PDF_CHROME = findChrome((process.env["SHOOT_PDF_CHROME"] ?? "").trim());
const INBOX_MIN = (() => { const n = Number(process.env["SHOOT_INBOX_MIN"] || 0.75); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.75; })();
const INBOX_START_MS = Number(process.env["SHOOT_INBOX_START_MS"] || 30_000);
const INBOX_TRIES = 3;        // a failed look (download, model, move) is tried again this often
const INBOX_KEEP = 2000;      // remembered inbox items

const MAX_JSON = 256 * 1024;          // a whole project with a long script
const MAX_AUDIO = 2 * 1024 * 1024;    // ~60 s of 16 kHz mono PCM
const TEXT = 200;
const UNASSIGNED = "unassigned";
const ID = /^(?:[cpsif]_[0-9a-f]{12}|unassigned)$/;
const MAX_TALKS = 100;

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
// State. Customers own projects; everything about a shoot belongs to its
// project, so switching projects never leaves last week's script or packing
// list on the glasses. "active" is the project the glasses work on.
// ---------------------------------------------------------------------------
let state = { version: 2, active: "", customers: Object.create(null), projects: Object.create(null), wdGone: [], gcalIds: Object.create(null), inboxSeen: Object.create(null) };

const str = (value, max = TEXT) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "").slice(0, max);
const time = (value, fallback) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback);
const newId = (prefix) => prefix + "_" + randomBytes(6).toString("hex");
const validId = (value, prefix) => (typeof value === "string" && ID.test(value) && value.startsWith(prefix + "_") ? value : newId(prefix));
const emptyDispo = () => ({ date: "", call: "", location: "", contact: "", notes: "", schedule: [] });
const collator = new Intl.Collator(PRESET_LANG, { sensitivity: "base", numeric: true });

function cleanShotScenes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200).map((scene) => ({
    scene: str(scene?.scene, 20).trim(),
    shots: Array.isArray(scene?.shots)
      ? scene.shots.slice(0, 100).map((s) => ({ shot: str(s?.shot, 20).trim(), desc: str(s?.desc), size: str(s?.size, 20) }))
      : [],
  })).filter((scene) => scene.scene);
}

function cleanCustomer(raw, id, now = Date.now()) {
  return {
    id,
    name: str(raw?.name, 120).trim() || "?",
    company: str(raw?.company, 120).trim(),
    phone: str(raw?.phone, 60).trim(),
    email: str(raw?.email, 120).trim(),
    notes: str(raw?.notes, 5000),
    team: cleanTeam(raw?.team),
    created: time(raw?.created, now),
    updated: time(raw?.updated, now),
    ...wdOf(raw, ["wdId", "wdHash"]),
  };
}

/** Work Dashboard users who work on this customer ("Anna, Max" or ["Anna"]): they are put on the team of every task. */
function cleanTeam(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,;\n]/) : [];
  const seen = new Set();
  return list.map((name) => str(name, 60).trim()).filter((name) => name && !seen.has(name.toLowerCase()) && seen.add(name.toLowerCase())).slice(0, 10);
}

/**
 * Work Dashboard bookkeeping (ids over there + content hashes), written only by
 * the sync. Kept through load and edits, never taken from a request body, never
 * shown to clients.
 */
const WD_KEYS = ["wdId", "wdHash", "wdCustomer", "wdTasks", "wdHashes"];
function wdOf(raw, keys) {
  const out = {};
  for (const key of keys) {
    const value = raw?.[key];
    if ((typeof value === "string" && value.length <= 200) || (typeof value === "number" && Number.isFinite(value))) out[key] = value;
    else if ((key === "wdTasks" || key === "wdHashes") && value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = JSON.parse(JSON.stringify(value));
    }
  }
  return out;
}
function withoutWd(object) {
  const copy = { ...object };
  for (const key of WD_KEYS) delete copy[key];
  return copy;
}

/** Conversation records from Babel: {id, at, summary, cues:[{title, text, kind}]}; the newest MAX_TALKS. */
const CUE_KINDS = ["tipp", "begriff", "fakt", "achtung"];
function cleanTalk(raw, now = Date.now()) {
  const at = typeof raw?.at === "string" ? Date.parse(raw.at) : Number(raw?.at);
  return {
    id: typeof raw?.id === "string" && /^t_[0-9a-f]{12}$/.test(raw.id) ? raw.id : newId("t"),
    at: Number.isFinite(at) && at > 0 ? at : now,
    summary: str(raw?.summary, 8000).trim(),
    cues: Array.isArray(raw?.cues) ? raw.cues.slice(0, 30).map((c) => ({
      title: str(c?.title, 80).trim(), text: str(c?.text, 300).trim(), kind: CUE_KINDS.includes(c?.kind) ? c.kind : "tipp",
    })).filter((c) => c.title || c.text) : [],
    ...((typeof raw?.wdComment === "string" && raw.wdComment.length <= 200) || Number.isFinite(raw?.wdComment) ? { wdComment: raw.wdComment } : {}),
    ...((typeof raw?.wdPoints === "string" && raw.wdPoints.length <= 200) || Number.isFinite(raw?.wdPoints) ? { wdPoints: raw.wdPoints } : {}),
    ...(raw?.points && cleanPoints(raw.points) ? { points: cleanPoints(raw.points) } : {}),
    ...(typeof raw?.pointsError === "string" && raw.pointsError ? { pointsError: str(raw.pointsError, 40) } : {}),
  };
}
function cleanTalks(raw) {
  return Array.isArray(raw) ? raw.slice(-MAX_TALKS).map((t) => cleanTalk(t)).filter((t) => t.summary || t.cues.length) : [];
}

/** "#Licht, outdoor  Sommer" → ["licht", "outdoor", "sommer"]. */
function cleanTags(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,;\s]+/) : [];
  const out = [];
  for (const entry of list) {
    const tag = str(entry, 40).trim().replace(/^#+/, "").toLowerCase();
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= 20) break;
  }
  return out;
}

function cleanIdeas(raw, now = Date.now()) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 500).map((idea) => ({
    id: validId(idea?.id, "i"),
    text: str(idea?.text, 1000).trim(),
    tags: cleanTags(idea?.tags),
    done: idea?.done === true,
    created: time(idea?.created, now),
  })).filter((idea) => idea.text);
}

function cleanBoards(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).map((board) => ({
    id: validId(board?.id, "s"),
    title: str(board?.title, 200).trim(),
    source: str(board?.source, 200),
    scenes: cleanBoardScenes(board?.scenes),
    ...(Array.isArray(board?.previous) && board.previous.length ? { previous: cleanPrevious(board.previous) } : {}),
  }));
}

/** Earlier versions of a storyboard (replaced by a new PDF), newest first, the last 3. */
function cleanPrevious(raw) {
  return raw.slice(0, 3).map((old) => ({
    title: str(old?.title, 200).trim(), source: str(old?.source, 200), scenes: cleanBoardScenes(old?.scenes), replaced: time(old?.replaced, Date.now()),
  }));
}

/** Inbox items already looked at: {attachment id: {at, name, tries, result}} - never the file's content. */
function cleanInboxSeen(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const entries = Object.entries(raw).filter(([id, v]) => id.length <= 100 && v && typeof v === "object")
    .sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0)).slice(0, INBOX_KEEP);
  for (const [id, v] of entries) {
    let result = {};
    try { const text = JSON.stringify(v.result ?? {}); if (text.length <= 4000) result = JSON.parse(text); } catch { result = {}; }
    out[id] = { at: time(v.at, Date.now()), name: str(v.name, 200), tries: Math.max(0, Math.min(99, Number(v.tries) || 0)), result };
  }
  return out;
}

const FILE_TYPES = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg" };
function cleanFiles(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200).filter((f) => typeof f?.id === "string" && /^f_[0-9a-f]{12}$/.test(f.id) && FILE_TYPES[f?.type]).map((f) => ({
    id: f.id, name: safeName(f.name, f.type), type: f.type, size: Math.max(0, Number(f.size) || 0), uploaded: time(f.uploaded, Date.now()),
    ...(typeof f.sha === "string" && /^[0-9a-f]{64}$/.test(f.sha) ? { sha: f.sha } : {}),
  }));
}

function cleanProject(raw, id, customerId, now = Date.now()) {
  return {
    id,
    customerId,
    name: str(raw?.name, 120).trim() || "?",
    date: str(raw?.date, 40).trim(),
    place: str(raw?.place, 200).trim(),
    created: time(raw?.created, now),
    updated: time(raw?.updated, now),
    ...(typeof raw?.gcalEventId === "string" && raw.gcalEventId ? { gcalEventId: str(raw.gcalEventId, 200), gcalSig: str(raw.gcalSig, 64) } : {}),
    scenes: cleanShotScenes(raw?.scenes),
    takes: Array.isArray(raw?.takes) ? raw.takes.slice(-5000) : [],
    prompter: str(raw?.prompter, 50000),
    dispo: raw?.dispo && typeof raw.dispo === "object" ? cleanDispo(raw.dispo) : emptyDispo(),
    equipment: Array.isArray(raw?.equipment) && raw.equipment.length ? cleanItems(raw.equipment) : presetItems(),
    storyboards: cleanBoards(raw?.storyboards),
    ideas: cleanIdeas(raw?.ideas),
    files: cleanFiles(raw?.files),
    talks: cleanTalks(raw?.talks),
    drafts: cleanDrafts(raw?.drafts),
    ...cleanBrain(raw?.brain),
    ...wdOf(raw, WD_KEYS),
  };
}

/** The last project understanding (shoot-day-brain.mjs), written only by the server; kept as it is, up to a size. */
function cleanBrain(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  try {
    const text = JSON.stringify(raw);
    return text.length <= 400_000 ? { brain: JSON.parse(text) } : {};
  } catch { return {}; }
}

/** Paperwork drafts written from templates (shoot-day-docs.mjs): which template gave which project files. */
function cleanDrafts(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-100).filter((d) => TEMPLATE_IDS.includes(d?.template)).map((d) => ({
    template: d.template,
    files: (Array.isArray(d.files) ? d.files : []).filter((id) => typeof id === "string" && /^f_[0-9a-f]{12}$/.test(id)).slice(0, 5),
    at: time(d.at, Date.now()),
    ...(d.manual === true ? { manual: true } : {}),
  })).filter((d) => d.files.length);
}

function cleanDispo(b) {
  return {
    date: str(b.date, 40), call: str(b.call, 20), location: str(b.location), contact: str(b.contact), notes: str(b.notes, 1000),
    schedule: Array.isArray(b.schedule) ? b.schedule.slice(0, 200).map((row) => ({ time: str(row?.time, 20), what: str(row?.what) })) : [],
    ...geo(b.lat, b.lon),
  };
}

/** Optional coordinates of the shoot's place (for the glasses' light view); kept only when both are real. */
function geo(lat, lon) {
  if (lat === undefined || lon === undefined || lat === null || lon === null || lat === "" || lon === "") return {};
  const la = Number(lat); const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180 || (la === 0 && lo === 0)) return {};
  return { lat: Math.round(la * 1e5) / 1e5, lon: Math.round(lo * 1e5) / 1e5 };
}

function cleanItems(items) {
  return items.slice(0, 500).map((x) => ({
    group: str(x?.group, 40) || "Other", name: str(x?.name, 80).trim(), need: x?.need === true, packed: x?.packed === true,
  })).filter((x) => x.name);
}

/** A file name that is safe to show and to send back in a header; never used as a path. */
function safeName(raw, type) {
  let name = str(raw, 300);
  name = name.split(/[\\/]/).pop() ?? "";
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/\s+/g, " ").replace(/^[.\s]+/, "").trim();
  const ext = "." + (type === "jpg" ? (/\.jpe?g$/i.exec(name)?.[0].slice(1).toLowerCase() ?? "jpg") : type);
  const stem = name.replace(/\.[^.]*$/, "").slice(0, 110).trim();
  return (stem || (PRESET_LANG === "de" ? "Datei" : "file")) + ext;
}

const unassignedName = () => (PRESET_LANG === "de" ? "Ohne Zuordnung" : "Unassigned");
function ensureUnassigned() {
  if (!state.customers[UNASSIGNED]) state.customers[UNASSIGNED] = cleanCustomer({ name: unassignedName() }, UNASSIGNED);
  return state.customers[UNASSIGNED];
}

/** Version 1 (projects by name, no customers) or version 2 → version 2. */
function migrate(raw) {
  const next = { version: 2, active: "", customers: Object.create(null), projects: Object.create(null), wdGone: [], gcalIds: Object.create(null), inboxSeen: Object.create(null) };
  if (raw?.version === 2) {
    // project id -> Google event id; lets a deleted project's event be removed later
    for (const [id, eventId] of Object.entries(raw.gcalIds ?? {})) if (ID.test(id) && typeof eventId === "string" && eventId) next.gcalIds[id] = eventId.slice(0, 200);
    for (const [id, customer] of Object.entries(raw.customers ?? {})) if (ID.test(id)) next.customers[id] = cleanCustomer(customer, id);
    for (const [id, project] of Object.entries(raw.projects ?? {})) {
      if (!ID.test(id)) continue;
      let owner = str(project?.customerId, 40);
      if (!next.customers[owner]) {
        next.customers[UNASSIGNED] ??= cleanCustomer({ name: unassignedName() }, UNASSIGNED);
        owner = UNASSIGNED;
      }
      next.projects[id] = cleanProject(project, id, owner);
    }
    next.active = next.projects[raw.active] ? raw.active : "";
    next.wdGone = Array.isArray(raw.wdGone)
      ? raw.wdGone.filter((g) => (g?.kind === "project" || g?.kind === "customer") && (typeof g.wdId === "string" || Number.isFinite(g.wdId))).slice(-1000).map((g) => ({ kind: g.kind, wdId: g.wdId }))
      : [];
    next.inboxSeen = cleanInboxSeen(raw.inboxSeen);
    return next;
  }
  for (const [name, project] of Object.entries(raw?.projects ?? {})) {
    const clean = str(name, 120).trim();
    if (!clean) continue;
    next.customers[UNASSIGNED] ??= cleanCustomer({ name: unassignedName() }, UNASSIGNED);
    const id = newId("p");
    next.projects[id] = cleanProject({ ...project, name: clean }, id, UNASSIGNED);
    if (clean === str(raw?.active, 120)) next.active = id;
  }
  return next;
}

function seed() {
  const de = PRESET_LANG === "de";
  const customer = cleanCustomer({
    name: de ? "Beispielkunde" : "Example client", company: de ? "Muster GmbH" : "Sample Ltd",
    notes: de ? "Mag ruhige Bilder, keine schnellen Schnitte." : "Likes calm pictures, no fast cuts.",
  }, newId("c"));
  state.customers[customer.id] = customer;
  const id = newId("p");
  state.projects[id] = cleanProject({
    name: de ? "Beispiel-Dreh" : "Example shoot",
    scenes: [
      { scene: "1", shots: [{ shot: "A", desc: de ? "Totale: Ankunft" : "Wide: arrival", size: "WS" }, { shot: "B", desc: de ? "Nah: Gesicht" : "Close: face", size: "CU" }] },
      { scene: "2", shots: [{ shot: "A", desc: de ? "Dialog, Zweier" : "Dialogue, two-shot", size: "MS" }, { shot: "B", desc: de ? "Über die Schulter" : "Over the shoulder", size: "MCU" }] },
    ],
    storyboards: [{
      title: de ? "Beispiel-Reel" : "Example reel",
      scenes: [
        { n: 1, from: 0, to: 4, title: de ? "Ankunft" : "Arrival", content: de ? "Tür geht auf, Licht fällt herein." : "The door opens, light falls in.", camera: de ? "Totale, ruhig vom Stativ" : "Wide, steady on the tripod", overlay: de ? "Willkommen" : "Welcome", goal: de ? "Neugier wecken" : "Spark curiosity" },
        { n: 2, from: 4, to: 9, title: de ? "Hände bei der Arbeit" : "Hands at work", content: de ? "Nahaufnahme der Hände." : "Close-up of the hands.", camera: de ? "Nah, langsamer Schwenk" : "Close, slow pan", overlay: "", goal: de ? "Handwerk zeigen" : "Show the craft" },
      ],
    }],
    ideas: [{ text: de ? "Drohnenflug über den Hof bei Sonnenaufgang" : "Drone shot over the yard at sunrise", tags: ["drohne", "morgen"] }],
  }, id, customer.id);
  state.active = id;
}

async function load() {
  let raw = null;
  if (existsSync(DATA_FILE)) {
    try {
      raw = JSON.parse(await readFile(DATA_FILE, "utf8"));
    } catch (error) {
      // Never overwrite a file we could not read: put it aside first.
      const aside = DATA_FILE + ".broken-" + stamp();
      await rename(DATA_FILE, aside).catch(() => undefined);
      console.error("could not read " + DATA_FILE + ": " + error.message + " — moved to " + aside + ", starting empty");
    }
  }
  if (raw && raw.version !== 2 && Object.keys(raw.projects ?? {}).length > 0) {
    const backup = DATA_FILE + ".bak-v1-" + stamp();
    try {
      await copyFile(DATA_FILE, backup, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      console.error("could not back up " + DATA_FILE + " before migrating (" + error.message + ") — not starting");
      process.exit(1);
    }
    console.log("migrating data to version 2 (customers); backup: " + backup);
  }
  state = migrate(raw ?? {});
  if (Object.keys(state.projects).length === 0 && Object.keys(state.customers).length === 0) seed();
  if (!state.projects[state.active]) state.active = newestProject()?.id ?? "";
  await persist();
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

/** Temporary file, fsync, rename: a crash mid-write never truncates the data. Writes run one after another. */
let writing = Promise.resolve();
/** Saves, then lets the Google Calendar sync catch up (the caller's answer goes out meanwhile). */
function persist() {
  const saved = persistOnly();
  saved.then(() => gcal.request());
  return saved;
}
function persistOnly() {
  writing = writing.then(async () => {
    await mkdir(dirname(DATA_FILE), { recursive: true });
    const temporary = DATA_FILE + ".tmp-" + process.pid;
    const handle = await open(temporary, "w");
    try {
      await handle.writeFile(JSON.stringify(state, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, DATA_FILE);
  }).catch((error) => console.error("could not save: " + error.message));
  return writing;
}

const gcalCfg = gcalConfig();
const gcal = createGcalSync(gcalCfg, {
  projects: () => Object.values(state.projects).map((project) => ({ project, customer: state.customers[project.customerId] })),
  known: () => state.gcalIds,
  setKnown: (id, eventId) => { if (eventId) state.gcalIds[id] = eventId; else delete state.gcalIds[id]; },
  save: () => persistOnly(),
}, (message) => console.error(message));

const active = () => state.projects[state.active] ?? null;
const newestProject = () => Object.values(state.projects).sort((a, b) => b.updated - a.updated)[0] ?? null;
const flatShots = (p) => (p?.scenes ?? []).flatMap((sc) => sc.shots.map((sh) => ({ scene: sc.scene, shot: sh.shot, desc: sh.desc, size: sh.size })));
const projectsOf = (customerId) => Object.values(state.projects).filter((p) => p.customerId === customerId);
const touch = (project) => {
  project.updated = Date.now();
  const customer = state.customers[project.customerId];
  if (customer) customer.updated = Math.max(customer.updated, project.updated);
};

/** By name, "Ohne Zuordnung" last. */
function sortedCustomers() {
  return Object.values(state.customers).sort((a, b) =>
    (a.id === UNASSIGNED) - (b.id === UNASSIGNED) || collator.compare(a.name, b.name) || collator.compare(a.company, b.company));
}
/** Newest date first, undated after, then by name. */
function sortedProjects(list) {
  return [...list].sort((a, b) => (b.date || "").localeCompare(a.date || "") || collator.compare(a.name, b.name));
}

const customerView = (c) => ({ ...withoutWd(c), projectCount: projectsOf(c.id).length, unassigned: c.id === UNASSIGNED });
const projectSummary = (p) => ({
  id: p.id, customerId: p.customerId, name: p.name, date: p.date, place: p.place, created: p.created, updated: p.updated,
  sceneCount: p.storyboards.reduce((n, b) => n + b.scenes.length, 0), shotCount: flatShots(p).length,
  ideaCount: p.ideas.length, fileCount: p.files.length, takeCount: p.takes.length, active: p.id === state.active,
});
const projectView = (p) => {
  const { takes, ...rest } = withoutWd(p);
  return { ...rest, takeCount: takes.length, active: p.id === state.active, customer: state.customers[p.customerId]?.name ?? "" };
};

function ideasOf(projects, onlyOpen) {
  return projects.flatMap((p) => p.ideas.filter((idea) => !onlyOpen || !idea.done).map((idea) => ({
    ...idea, project: p.name, projectId: p.id, customer: state.customers[p.customerId]?.name ?? "", customerId: p.customerId,
  })));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-File-Name",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

function send(response, status, body, type = "application/json; charset=utf-8") {
  // A 204 carries no body and no content type (iOS drops the answer otherwise).
  if (status === 204) { response.writeHead(204, CORS); response.end(); return; }
  response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...CORS });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}

/**
 * `tailscale serve` connects from loopback and sets Tailscale-User-Login to the
 * signed-in tailnet user. A LAN client cannot reach a loopback-bound server, so
 * the header is only trusted from loopback and only for the logins in
 * SD_TAILSCALE_USERS (comma list). The TOKEN keeps working as the alternative.
 */
const TAILSCALE_USERS = String(process.env["SD_TAILSCALE_USERS"] ?? "").split(",").map((u) => u.trim().toLowerCase()).filter(Boolean);
function tailscaleUser(request) {
  const peer = String(request.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (peer !== "127.0.0.1" && peer !== "::1") return "";
  const login = String(request.headers["tailscale-user-login"] ?? "").trim().toLowerCase();
  return TAILSCALE_USERS.includes(login) ? login : "";
}

const digest = (text) => createHash("sha256").update(text).digest();
/** Constant-time check, so response timing does not leak the TOKEN. */
function authorised(request) {
  if (!TOKEN) return true;
  if (tailscaleUser(request) !== "") return true;
  return timingSafeEqual(digest(request.headers["authorization"] ?? ""), digest("Bearer " + TOKEN));
}

const TOO_LARGE = Symbol("too large");
/** Reads the body up to `limit` bytes; anything larger resolves TOO_LARGE instead of hanging. */
function readBody(request, limit) {
  return new Promise((resolve) => {
    if (Number(request.headers["content-length"] ?? 0) > limit) { request.resume(); resolve(TOO_LARGE); return; }
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

/** What the file really is, by its first bytes; null for anything but PDF, PNG and JPEG. */
function sniff(buffer) {
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buffer.length > 8 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) return "png";
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  return null;
}
const extensionType = (name) => {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return ext === "pdf" ? "pdf" : ext === "png" ? "png" : ext === "jpg" || ext === "jpeg" ? "jpg" : ext ? "other" : null;
};
// Paths are built from ids only (checked against ID), never from names.
const fileDir = (projectId) => join(FILES_DIR, projectId);
const filePath = (projectId, file) => join(fileDir(projectId), file.id + "." + file.type);

/** Babel's memory about this customer (babel-llm-proxy `/memory/search`); null when not configured. */
async function babelMemory(query) {
  if (!BABEL_URL) return null;
  const base = BABEL_URL.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "").replace(/\/v1$/, "").replace(/\/memory$/, "");
  try {
    const response = await fetch(base + "/memory/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(BABEL_TOKEN ? { Authorization: "Bearer " + BABEL_TOKEN } : {}) },
      body: JSON.stringify({ query: query.slice(0, 500), limit: 3 }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const reply = await response.json();
    const entries = Array.isArray(reply?.entries) ? reply.entries.slice(0, 3) : [];
    return { entries: entries.map((e) => ({ date: str(e?.date, 40), title: str(e?.title, 200), summary: str(e?.summary, 1000) })) };
  } catch (error) {
    console.error("babel memory: " + error.message);
    return { entries: [], error: true };
  }
}

async function api(request, response, url) {
  const path = url.pathname;
  const method = request.method;
  const parts = path.split("/").filter(Boolean).map((part) => { try { return decodeURIComponent(part); } catch { return ""; } });
  const json = async () => {
    const body = await readJson(request);
    if (body === TOO_LARGE) { send(response, 413, { error: "request too large" }); return undefined; }
    if (body === null || typeof body !== "object" || Array.isArray(body)) { send(response, 400, { error: "invalid JSON" }); return undefined; }
    return body;
  };
  // The legacy endpoints work on the active project, or on ?project=<id> (the web terminal).
  const wanted = url.searchParams.get("project");
  const p = wanted ? state.projects[wanted] ?? null : active();
  if (wanted && !p && parts[1] !== "customers" && parts[1] !== "projects") return send(response, 404, { error: "unknown project" });
  const needProject = () => { if (!p) send(response, 409, { error: "no active project" }); return Boolean(p); };

  // ---- customers -----------------------------------------------------------
  if (parts[1] === "customers") {
    const id = parts[2];
    if (!id) {
      if (method === "GET") {
        return send(response, 200, {
          customers: sortedCustomers().map(customerView),
          active: state.active,
          activeCustomer: active()?.customerId ?? "",
        });
      }
      if (method === "POST") {
        const b = await json(); if (!b) return;
        if (!str(b.name, 120).trim()) return send(response, 400, { error: "name missing" });
        if (Object.keys(state.customers).length >= 5000) return send(response, 409, { error: "too many customers" });
        const customer = cleanCustomer(withoutWd(b), newId("c"));
        state.customers[customer.id] = customer;
        await persist();
        wd.schedule({ customer: customer.id });
        return send(response, 200, customerView(customer));
      }
      return send(response, 405, { error: "method not allowed" });
    }
    const customer = state.customers[id];
    if (!customer) return send(response, 404, { error: "unknown customer" });
    if (parts[3] === "brief" && parts.length === 4 && method === "GET") {
      const projects = sortedProjects(projectsOf(id));
      const updated = Math.max(customer.updated, ...projects.map((x) => x.updated));
      const memory = id === UNASSIGNED ? null : await babelMemory([customer.name, customer.company].filter(Boolean).join(" "));
      return send(response, 200, {
        id, name: customer.name, company: customer.company, phone: customer.phone, email: customer.email, notes: customer.notes, updated,
        projects: projects.map((x) => ({ id: x.id, name: x.name, date: x.date })),
        ideas: ideasOf(projects, true).map((idea) => ({ text: idea.text, tags: idea.tags, project: idea.project })),
        ...(memory ? { memory: memory.entries, ...(memory.error ? { memoryError: true } : {}) } : {}),
      });
    }
    if (parts.length > 3) return send(response, 404, { error: "not found" });
    if (method === "GET") return send(response, 200, { customer: customerView(customer), projects: sortedProjects(projectsOf(id)).map(projectSummary) });
    if (method === "POST") {
      const b = await json(); if (!b) return;
      if (b.name !== undefined && !str(b.name, 120).trim()) return send(response, 400, { error: "name missing" });
      const next = cleanCustomer({ ...customer, ...withoutWd(b), wdId: customer.wdId, wdHash: customer.wdHash, created: customer.created, updated: Date.now() }, id);
      state.customers[id] = next;
      await persist();
      return send(response, 200, customerView(next));
    }
    if (method === "DELETE") {
      const owned = projectsOf(id);
      if (id === UNASSIGNED && owned.length > 0) return send(response, 409, { error: "move its projects first", projects: owned.length });
      const mode = url.searchParams.get("projects");
      if (owned.length > 0 && mode !== "move" && mode !== "delete") return send(response, 409, { error: "has projects", projects: owned.length });
      for (const project of owned) {
        if (mode === "move") { project.customerId = ensureUnassigned().id; continue; }
        wdForget("project", project);
        delete state.projects[project.id];
        await rm(fileDir(project.id), { recursive: true, force: true });
      }
      wdForget("customer", customer);
      delete state.customers[id];
      if (!state.projects[state.active]) state.active = newestProject()?.id ?? "";
      await persist();
      return send(response, 200, { ok: true, deleted: id, projects: owned.length, moved: mode === "move" });
    }
    return send(response, 405, { error: "method not allowed" });
  }

  // ---- projects --------------------------------------------------------------
  if (parts[1] === "projects") {
    const id = parts[2];
    if (!id) {
      if (method === "GET") return send(response, 200, { projects: sortedProjects(Object.values(state.projects)).map(projectSummary) });
      if (method === "POST") {
        const b = await json(); if (!b) return;
        if (!str(b.name, 120).trim()) return send(response, 400, { error: "name missing" });
        const owner = b.customerId ? str(b.customerId, 40) : ensureUnassigned().id;
        if (!state.customers[owner]) return send(response, 404, { error: "unknown customer" });
        if (Object.keys(state.projects).length >= 5000) return send(response, 409, { error: "too many projects" });
        const project = cleanProject({ name: b.name, date: b.date, place: b.place }, newId("p"), owner);
        state.projects[project.id] = project;
        touch(project);
        if (!state.active) state.active = project.id;
        await persist();
        wd.schedule(project.id);
        return send(response, 200, projectSummary(project));
      }
      return send(response, 405, { error: "method not allowed" });
    }
    const project = state.projects[id];
    if (!project) return send(response, 404, { error: "unknown project" });
    const sub = parts[3];

    if (!sub) {
      if (method === "GET") return send(response, 200, projectView(project));
      if (method === "POST") {
        const b = await json(); if (!b) return;
        if (b.name !== undefined) {
          const name = str(b.name, 120).trim();
          if (!name) return send(response, 400, { error: "name missing" });
          project.name = name;
        }
        if (b.customerId !== undefined && !state.customers[b.customerId]) return send(response, 404, { error: "unknown customer" });
        if (b.customerId !== undefined) project.customerId = b.customerId;
        if (b.date !== undefined) project.date = str(b.date, 40).trim();
        if (b.place !== undefined) project.place = str(b.place, 200).trim();
        touch(project);
        await persist();
        return send(response, 200, projectSummary(project));
      }
      if (method === "DELETE") {
        wdForget("project", project);
        delete state.projects[id];
        await rm(fileDir(id), { recursive: true, force: true });
        if (state.active === id) state.active = newestProject()?.id ?? "";
        await persist();
        return send(response, 200, { ok: true, deleted: id });
      }
      return send(response, 405, { error: "method not allowed" });
    }

    if (sub === "ideas" && method === "POST" && parts.length === 4) {
      const b = await json(); if (!b) return;
      project.ideas = cleanIdeas(b.ideas);
      touch(project);
      await persist();
      return send(response, 200, { ideas: project.ideas });
    }

    if (sub === "talks" && parts.length === 4) {
      if (method === "GET") return send(response, 200, { talks: (project.talks ?? []).map(({ wdComment, wdPoints, ...t }) => ({ ...t, synced: Boolean(wdComment) })) });
      if (method === "POST") {
        const b = await json(); if (!b) return;
        const talk = cleanTalk({ at: b.at, summary: b.summary, cues: b.cues });
        if (!talk.summary && talk.cues.length === 0) return send(response, 400, { error: "summary or cues missing" });
        project.talks = [...(project.talks ?? []), talk].slice(-MAX_TALKS);
        touch(project);
        await persist();
        queueTalkPoints(project.id, talk.id);
        return send(response, 200, { ok: true, id: talk.id, count: project.talks.length, points: LLM_URL ? "pending" : "off" });
      }
      return send(response, 405, { error: "method not allowed" });
    }

    // the project understanding: GET = the last one, POST = run now
    if (sub === "brain" && parts.length === 4) {
      if (method === "GET") { const { digests, ...rest } = project.brain ?? {}; return send(response, 200, rest); }
      if (method !== "POST") return send(response, 405, { error: "method not allowed" });
      const result = await (brainQueue = brainQueue.then(() => runBrain(id, { force: true })).catch((error) => ({ ok: false, error: error.message })));
      return send(response, result.ok ? 200 : 502, result);
    }

    // a paperwork draft on demand (always a fresh one)
    if (sub === "docs" && parts.length === 4) {
      if (method === "GET") return send(response, 200, { templates: TEMPLATE_IDS.map((t) => ({ id: t, label: templateLabel(t) })), drafts: project.drafts ?? [], pdf: Boolean(PDF_CHROME) });
      if (method !== "POST") return send(response, 405, { error: "method not allowed" });
      const b = await json(); if (!b) return;
      if (!TEMPLATE_IDS.includes(b.template)) return send(response, 400, { error: "unknown template", templates: TEMPLATE_IDS });
      if (!PDF_CHROME) return send(response, 503, { error: "no chrome for PDF printing (SHOOT_PDF_CHROME)" });
      try {
        // the date printed next to "Ort, Datum" (e.g. the day it is printed and signed)
        const docDate = /^\d{4}-\d{2}-\d{2}$/.test(str(b.date, 10)) ? str(b.date, 10) : "";
        // replace: a new version of the template's draft takes the old one's place (same tasks in the
        // dashboard, the old PDF stays as a file); otherwise a separate draft written by hand
        const replace = b.replace === true;
        const ids = await writeDrafts(id, b.template, {
          point: str(b.note, 300), reuse: false, docDate,
        });
        const p = state.projects[id];
        if (replace && p && ids.length) {
          const fresh = (p.drafts ?? []).find((d) => d.files.join() === ids.join());
          if (fresh) delete fresh.manual;
          p.drafts = (p.drafts ?? []).filter((d) => d === fresh || d.template !== b.template || d.manual);
          for (const u of p.brain?.analysis?.unterlagen ?? []) if (u.template === b.template) u.files = ids;
          for (const talk of p.talks ?? []) for (const point of talk.points?.needed ?? []) if (matchTemplate(point.text) === b.template) point.docs = ids;
          await persist();
          wd.schedule(id);
        }
        return send(response, 200, { files: (state.projects[id]?.files ?? []).filter((f) => ids.includes(f.id)) });
      } catch (error) {
        console.error("drafts: " + b.template + " failed (" + error.message + ")");
        return send(response, 502, { error: "draft failed" });
      }
    }

    // what the talks left open, again (e.g. for talks filed before this existed, or after a failure)
    if (sub === "talks" && parts.length === 5 && parts[4] === "points") {
      if (method !== "POST") return send(response, 405, { error: "method not allowed" });
      if (!LLM_URL) return send(response, 503, { error: "no language model (SHOOT_LLM_URL)" });
      const queued = (project.talks ?? []).filter((t) => !t.points).map((t) => t.id);
      for (const id of queued) queueTalkPoints(project.id, id);
      return send(response, 202, { queued: queued.length });
      return send(response, 405, { error: "method not allowed" });
    }

    if (sub === "storyboards") {
      const boardId = parts[4];
      if (!boardId && method === "POST") {
        const b = await json(); if (!b) return;
        const [board] = cleanBoards([b]);
        const index = project.storyboards.findIndex((x) => x.id === board.id);
        // the editor does not send the earlier versions: they stay
        if (index >= 0 && b.previous === undefined && project.storyboards[index].previous) board.previous = project.storyboards[index].previous;
        if (index >= 0) project.storyboards[index] = board;
        else if (project.storyboards.length >= 50) return send(response, 409, { error: "too many storyboards" });
        else project.storyboards.push(board);
        touch(project);
        await persist();
        return send(response, 200, board);
      }
      if (boardId && method === "DELETE" && parts.length === 5) {
        const before = project.storyboards.length;
        project.storyboards = project.storyboards.filter((x) => x.id !== boardId);
        if (project.storyboards.length === before) return send(response, 404, { error: "unknown storyboard" });
        touch(project);
        await persist();
        return send(response, 200, { ok: true });
      }
      return send(response, 404, { error: "not found" });
    }

    if (sub === "files") {
      const fileId = parts[4];
      if (!fileId && method === "POST") {
        if (project.files.length >= 200) { request.resume(); return send(response, 409, { error: "too many files" }); }
        let name = "";
        try { name = decodeURIComponent(String(request.headers["x-file-name"] ?? "")); } catch { name = ""; }
        const body = await readBody(request, MAX_UPLOAD);
        if (body === TOO_LARGE) return send(response, 413, { error: "file too large", maxMb: MAX_UPLOAD / 1024 / 1024 });
        if (!body || body.length === 0) return send(response, 400, { error: "empty file" });
        const type = sniff(body);
        const claimed = extensionType(name);
        if (!type || (claimed && claimed !== type)) return send(response, 415, { error: "only PDF, PNG or JPEG" });
        const file = { id: newId("f"), name: safeName(name, type), type, size: body.length, uploaded: Date.now(), sha: shaOf(body) };
        await mkdir(fileDir(id), { recursive: true });
        const temporary = filePath(id, file) + ".part";
        await writeFile(temporary, body);
        await rename(temporary, filePath(id, file));
        project.files.push(file);
        touch(project);
        await persist();
        return send(response, 200, file);
      }
      const file = project.files.find((f) => f.id === fileId);
      if (!file) return send(response, 404, { error: "unknown file" });
      if (parts.length === 5 && method === "GET") {
        let data;
        try { data = await readFile(filePath(id, file)); } catch { return send(response, 404, { error: "file missing on disk" }); }
        response.writeHead(200, {
          "Content-Type": FILE_TYPES[file.type],
          "Content-Length": data.length,
          "Content-Disposition": "inline; filename*=UTF-8''" + encodeURIComponent(file.name),
          "Content-Security-Policy": "sandbox",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
          ...CORS,
        });
        response.end(data);
        return;
      }
      if (parts.length === 5 && method === "DELETE") {
        project.files = project.files.filter((f) => f.id !== file.id);
        await unlink(filePath(id, file)).catch(() => undefined);
        touch(project);
        await persist();
        return send(response, 200, { ok: true });
      }
      if (parts[5] === "storyboard" && parts.length === 6 && method === "POST") {
        if (file.type !== "pdf") return send(response, 400, { error: "not a PDF" });
        let data;
        try { data = await readFile(filePath(id, file)); } catch { return send(response, 404, { error: "file missing on disk" }); }
        const extracted = extractPdfText(data);
        const base = { file: file.name, pages: extracted.pages, encrypted: extracted.encrypted, text: extracted.text.slice(0, 20_000) };
        if (!extracted.text.trim()) return send(response, 200, { ...base, extracted: false, scenes: [], llm: LLM_URL ? "skipped" : "off" });
        if (!LLM_URL) return send(response, 200, { ...base, extracted: true, scenes: [], llm: "off" });
        const lang = url.searchParams.get("lang") === "en" ? "en" : url.searchParams.get("lang") === "de" ? "de" : PRESET_LANG;
        const proposal = await proposeScenes(extracted.text, { url: LLM_URL, model: LLM_MODEL, token: LLM_TOKEN, lang, timeoutMs: LLM_TIMEOUT_MS });
        if (!proposal.ok) return send(response, 200, { ...base, extracted: true, scenes: [], llm: "failed", error: proposal.error });
        return send(response, 200, { ...base, extracted: true, scenes: proposal.scenes, llm: "ok" });
      }
      return send(response, 404, { error: "not found" });
    }
    return send(response, 404, { error: "not found" });
  }

  // ---- ideas, for Babel and other readers ----------------------------------
  if (path === "/api/ideas" && method === "GET") {
    const who = (url.searchParams.get("customer") ?? "").trim();
    let projects = Object.values(state.projects);
    if (who) {
      const lower = who.toLowerCase();
      const ids = new Set(Object.values(state.customers)
        .filter((c) => c.id === who || c.name.toLowerCase() === lower || (c.company !== "" && c.company.toLowerCase() === lower))
        .map((c) => c.id));
      projects = projects.filter((x) => ids.has(x.customerId));
    }
    return send(response, 200, { ideas: ideasOf(projects, url.searchParams.get("open") === "1") });
  }

  // ---- storyboard for the glasses (active project or ?project) -------------
  if (path === "/api/storyboard" && method === "GET") {
    return send(response, 200, { project: p?.name ?? "", projectId: p?.id ?? "", storyboards: p?.storyboards ?? [] });
  }
  if (path === "/api/storyboard/scene" && method === "POST") {
    const b = await json(); if (!b) return;
    if (!needProject()) return;
    const board = p.storyboards.find((x) => x.id === b.storyboard);
    const index = Number(b.index);
    const scene = Number.isInteger(index) ? board?.scenes[index] : undefined;
    if (!board || !scene) return send(response, 404, { error: "unknown scene" });
    scene.done = typeof b.done === "boolean" ? b.done : !scene.done;
    touch(p);
    await persist();
    return send(response, 200, { ok: true, done: scene.done });
  }

  // ---- the active project (glasses, MCP) — and ?project=<id> (web terminal) --
  if (path === "/api/shotlist" && method === "GET") {
    return send(response, 200, { project: p?.name ?? "", projectId: p?.id ?? "", customer: p ? state.customers[p.customerId]?.name ?? "" : "", shots: flatShots(p) });
  }

  if (path === "/api/state" && method === "GET") {
    return send(response, 200, {
      active: active()?.name ?? "",
      activeId: state.active,
      projects: sortedProjects(Object.values(state.projects)).map((x) => ({ id: x.id, name: x.name, customerId: x.customerId, scenes: x.scenes, takeCount: x.takes.length })),
    });
  }

  if (path === "/api/project" && method === "GET") return send(response, 200, p ? { id: p.id, name: p.name, scenes: p.scenes } : {});

  if (path === "/api/project" && method === "POST") {
    const b = await json(); if (!b) return;
    if (wanted) {
      p.scenes = cleanShotScenes(b.scenes);
      touch(p);
      await persist();
      return send(response, 200, { id: p.id, name: p.name, scenes: p.scenes });
    }
    // Legacy: by name; an unknown name becomes a new project without customer.
    const name = str(b.name, 120).trim();
    if (!name) return send(response, 400, { error: "name missing" });
    let project = Object.values(state.projects).find((x) => x.name === name);
    if (!project) {
      project = cleanProject({ name }, newId("p"), ensureUnassigned().id);
      state.projects[project.id] = project;
    }
    if (Array.isArray(b.scenes)) project.scenes = cleanShotScenes(b.scenes);
    touch(project);
    state.active = project.id;
    await persist();
    return send(response, 200, { id: project.id, name, scenes: project.scenes });
  }

  if (path === "/api/active" && method === "POST") {
    const b = await json(); if (!b) return;
    const project = b.id ? state.projects[str(b.id, 40)] : Object.values(state.projects).find((x) => x.name === str(b.name, 120));
    if (!project) return send(response, 404, { error: "unknown project" });
    state.active = project.id;
    await persist();
    return send(response, 200, { active: project.name, activeId: project.id, customerId: project.customerId });
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

  // Undo of the single-tap OK on the glasses: removes exactly one take (the
  // newest one matching scene + shot + n), nothing else.
  if (path === "/api/take/delete" && method === "POST") {
    const b = await json(); if (!b) return;
    if (!needProject()) return;
    const scene = str(b.scene, 20);
    const shot = str(b.shot, 20);
    const n = Number(b.n);
    const at = Number.isInteger(n) ? p.takes.findLastIndex((t) => t.scene === scene && t.shot === shot && t.n === n) : -1;
    if (at < 0) return send(response, 404, { error: "unknown take" });
    const [deleted] = p.takes.splice(at, 1);
    await persist();
    return send(response, 200, { ok: true, deleted });
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
    touch(p);
    await persist();
    return send(response, 200, { ok: true });
  }

  if (path === "/api/prompter" && method === "GET") return send(response, 200, { project: p?.name ?? "", text: p?.prompter ?? "" });
  if (path === "/api/prompter" && method === "POST") {
    const b = await json(); if (!b) return;
    if (!needProject()) return;
    p.prompter = str(b.text, 50000);
    touch(p);
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

  if (path === "/api/wd/status" && method === "GET") return send(response, 200, wd.status());
  if (path === "/api/wd/sync" && method === "POST") {
    request.resume();
    if (!wd.enabled) return send(response, 503, { ...wd.status(), error: "work dashboard sync is off (SHOOT_WD_URL, SHOOT_WD_TOKEN)" });
    const result = await wd.syncAll();
    return send(response, result.ok ? 200 : 502, { ...wd.status(), ok: result.ok, sent: result.sent });
  }

  // the Work Dashboard inbox (files sorted by the local model)
  if (path === "/api/inbox/status" && method === "GET") return send(response, 200, inboxView());
  if (path === "/api/inbox/retry") {
    if (method !== "POST") return send(response, 405, { error: "method not allowed" });
    const b = await json(); if (!b) return;
    if (!inboxOn()) return send(response, 503, { error: "inbox is off (SHOOT_WD_URL, SHOOT_WD_TOKEN, SHOOT_LLM_URL)" });
    const id = str(b.id, 100).trim();
    if (!id || !state.inboxSeen[id]) return send(response, 404, { error: "unknown inbox item" });
    delete state.inboxSeen[id];
    await persist();
    const again = Boolean(inboxRunning);
    void runInbox().then(() => (again ? runInbox() : undefined));
    return send(response, 202, { ok: true, queued: id });
  }

  if (path === "/api/gcal/status" && method === "GET") return send(response, 200, gcal.status());
  if (path === "/api/gcal/sync" && method === "POST") {
    if (!gcal.enabled()) return send(response, 409, { error: "Google Calendar is not configured", ...gcal.status() });
    const dated = Object.values(state.projects).filter((x) => x.date).length;
    send(response, 202, { ok: true, started: true, dated, ...gcal.status() });
    gcal.request();
    return;
  }

  // search over every customer and project (vector index, shoot-day-vectors.mjs)
  if (path === "/api/search" && method === "GET") {
    if (!vectors.enabled) return send(response, 503, { error: "search is off (SHOOT_EMBED_URL)" });
    const q = str(url.searchParams.get("q") ?? "", 500).trim();
    if (!q) return send(response, 400, { error: "q missing" });
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 8));
    const result = await vectors.query(q, { limit, projects: Object.keys(state.projects) });
    if (!result.ok) return send(response, 502, { error: "embedding failed", hits: [] });
    return send(response, 200, { hits: result.hits.map(hitView) });
  }
  // sections that fit what is being said (e.g. Babel live): {text, projectId?, scope?: "project"|"others"|"all", limit?, minScore?}
  if (path === "/api/context/related") {
    if (method !== "POST") return send(response, 405, { error: "method not allowed" });
    if (!vectors.enabled) { request.resume(); return send(response, 503, { error: "search is off (SHOOT_EMBED_URL)" }); }
    const b = await json(); if (!b) return;
    const text = str(b.text, 4000).trim();
    if (!text) return send(response, 400, { error: "text missing" });
    const projectId = str(b.projectId, 40);
    if (projectId && !state.projects[projectId]) return send(response, 404, { error: "unknown project" });
    const scope = projectId ? (["project", "others", "all"].includes(b.scope) ? b.scope : "project") : "all";
    const limit = Math.min(20, Math.max(1, Number(b.limit) || 5));
    const minScore = Number.isFinite(Number(b.minScore)) ? Number(b.minScore) : -Infinity;
    const result = await vectors.query(text, {
      limit, minScore,
      projects: scope === "project" ? [projectId] : Object.keys(state.projects),
      ...(scope === "others" ? { exceptProjects: [projectId] } : {}),
    });
    if (!result.ok) return send(response, 502, { error: "embedding failed", hits: [] });
    return send(response, 200, { hits: result.hits.map(hitView) });
  }

  if (path === "/api/config" && method === "GET") {
    return send(response, 200, { wd: wd.enabled, inbox: inboxOn(), gcal: gcal.enabled(), llm: Boolean(LLM_URL), babel: Boolean(BABEL_URL), speech: Boolean(WHISPER_URL), embed: vectors.enabled, maxUploadMb: MAX_UPLOAD / 1024 / 1024, lang: PRESET_LANG });
  }

  return send(response, 404, { error: "not found" });
}

// ---------------------------------------------------------------------------
// Work Dashboard (one-way mirror, shoot-day-wd.mjs). Off without URL + token.
// ---------------------------------------------------------------------------
const wd = createWdSync({
  url: WD_URL, token: WD_TOKEN, getState: () => state, persist,
  debounceMs: Number(process.env["SHOOT_WD_DEBOUNCE_MS"] || 10_000),
  statusOpen: process.env["SHOOT_WD_STATUS_OPEN"] || "open",
  statusDone: process.env["SHOOT_WD_STATUS_DONE"] || "done",
  // the PDF of a draft, for the dashboard attachment
  isInternal: isInternalTemplate,
  readDraft: async (projectId, file) => { try { return await readFile(filePath(projectId, file)); } catch { return null; } },
});

// ---------------------------------------------------------------------------
// Paperwork drafts (shoot-day-docs.mjs): PDF into the project's files.
// ---------------------------------------------------------------------------
let brandInfo = { brand: null, logoDataUri: "" };
if (BRAND_FILE) {
  try { brandInfo = await loadBrand(BRAND_FILE); } catch (error) { console.error("brand file: " + error.message); }
}

/**
 * Writes the documents of a template for a project as PDF files. With `reuse`, an
 * earlier draft of the same template whose files still exist is given back instead.
 * @returns {Promise<string[]>} ids of the project files
 */
async function writeDrafts(projectId, templateId, { point = "", summary = "", reuse = true, purpose: given = "", facts = {}, docDate = "", version = "" } = {}) {
  let project = state.projects[projectId];
  if (!project || !TEMPLATE_IDS.includes(templateId)) return [];
  if (reuse) {
    const earlier = [...(project.drafts ?? [])].reverse().find((d) => d.template === templateId && d.files.every((id) => project.files.some((f) => f.id === id)));
    if (earlier) return earlier.files;
  }
  const customer = state.customers[project.customerId];
  const purpose = given || (LLM_URL ? await writePurpose({ templateId, customer, project, point, summary }, { url: LLM_URL, model: LLM_MODEL, token: LLM_TOKEN, timeoutMs: LLM_TIMEOUT_MS }) : "");
  const documents = draftDocuments(templateId, docContext({ brand: brandInfo.brand, customer, project, purpose, facts, docDate }), { brand: brandInfo.brand, logoDataUri: brandInfo.logoDataUri });
  const made = [];
  for (const doc of documents) {
    const pdf = await printPdf(doc.html, { chrome: PDF_CHROME });
    project = state.projects[projectId];
    if (!project) return made.map((f) => f.id);
    if (project.files.length >= 200) break;
    // named after the customer, never after the project's internal working name
    const who = customer?.company || customer?.name || "";
    const file = { id: newId("f"), name: safeName("Entwurf – " + doc.name + (who ? " – " + who : "") + (version ? " – " + version : "") + ".pdf", "pdf"), type: "pdf", size: pdf.length, uploaded: Date.now() };
    await mkdir(fileDir(projectId), { recursive: true });
    await writeFile(filePath(projectId, file) + ".part", pdf);
    await rename(filePath(projectId, file) + ".part", filePath(projectId, file));
    project.files.push(file);
    made.push(file);
  }
  if (made.length) {
    (project.drafts ??= []).push({ template: templateId, files: made.map((f) => f.id), at: Date.now(), ...(reuse ? {} : { manual: true }) });
    touch(project);
    await persist();
    console.log("drafts: " + templateId + " → " + made.length + " PDF(s)");
  }
  return made.map((f) => f.id);
}

/** For every "needed" point of a talk that asks for paperwork: a draft (one per template and project). Never throws. */
async function draftsForTalk(projectId, talk) {
  if (!PDF_CHROME) return;
  for (const point of talk.points?.needed ?? []) {
    const templateId = matchTemplate(point.text);
    if (!templateId || point.docs?.length) continue;
    try {
      const ids = await writeDrafts(projectId, templateId, { point: point.text, summary: talk.summary });
      if (ids.length) point.docs = ids;
    } catch (error) {
      console.error("drafts: " + templateId + " failed (" + error.message + ")");
    }
  }
}

// ---------------------------------------------------------------------------
// Project understanding (shoot-day-brain.mjs): the local model reads everything,
// sees the connections, names the paperwork; Shoot Day writes the drafts.
// ---------------------------------------------------------------------------
const pdfTextCache = new Map();   // file id → extracted text
async function projectPdfs(project) {
  const own = new Set((project.drafts ?? []).flatMap((d) => d.files));
  const out = [];
  for (const file of project.files ?? []) {
    if (file.type !== "pdf" || own.has(file.id)) continue;
    if (!pdfTextCache.has(file.id)) {
      let text = "";
      try { text = extractPdfText(await readFile(filePath(project.id, file))).text ?? ""; } catch { text = ""; }
      pdfTextCache.set(file.id, text);
    }
    const text = pdfTextCache.get(file.id);
    if (text.trim()) out.push({ id: file.id, name: file.name, text });
  }
  return out;
}

/**
 * Everything a project has, as sources: its own material, the PDFs and – with the
 * Work Dashboard sync on – what people did on its tasks there (read back; a failure
 * there only leaves those out). null when the project is gone meanwhile.
 */
async function sourcesOf(project) {
  const pdfs = await projectPdfs(project);
  const dashboard = wd.enabled && project.wdId ? (await wd.readBack(project.id)) ?? [] : [];
  const now = state.projects[project.id];
  if (!now) return null;
  return projectSources(now, state.customers[now.customerId], pdfs, dashboard);
}

// ---------------------------------------------------------------------------
// Vector index (shoot-day-vectors.mjs): every project's material, searchable
// across all customers. Off without SHOOT_EMBED_URL.
// ---------------------------------------------------------------------------
const vectors = createVectorIndex({
  file: VECTORS_FILE, url: EMBED_URL, model: EMBED_MODEL, token: EMBED_TOKEN,
  log: (line) => console.error(line),
});
const HINT_MIN_SCORE = 0.55;
const HINT_MAX = 5;

/** One hit for the answer: names from the live state (a project may have moved to another customer). */
function hitView({ entry, score }) {
  const project = state.projects[entry.projectId];
  const customerId = project?.customerId ?? entry.customerId;
  return {
    projectId: entry.projectId, project: project?.name ?? "", customerId, customer: state.customers[customerId]?.name ?? "",
    sourceId: entry.sourceId, title: entry.title, snippet: entry.text.replace(/\s+/g, " ").trim().slice(0, 280), score: Math.round(score * 1000) / 1000,
  };
}

/** Brings a project's sections up to date (only new ones are embedded). Never throws. */
async function indexProject(project, sources = null) {
  if (!vectors.enabled || !project) return;
  try {
    const material = sources ?? await sourcesOf(project);
    if (!material || !state.projects[project.id]) return;
    await vectors.syncProject(project.id, state.projects[project.id].customerId, material, { alive: () => Boolean(state.projects[project.id]) });
  } catch (error) {
    console.error("vectors: " + error.message);
  }
}

/** Every project once (after the start), deleted ones dropped from the index. Never throws. */
async function indexAll() {
  if (!vectors.enabled) return;
  await vectors.retain(Object.keys(state.projects));
  for (const id of Object.keys(state.projects)) await indexProject(state.projects[id]);
  console.log("vectors: " + vectors.size() + " section(s) indexed");
}

/**
 * The sections of OTHER projects most like this one, as one extra source for the
 * analysis only ("frueher"): experience, never facts of this project, not in the
 * material hash. null when there is nothing close enough.
 */
function earlierProjects(projectId) {
  if (!vectors.enabled) return null;
  const hits = vectors.search(vectors.projectVector(projectId), {
    limit: HINT_MAX, minScore: HINT_MIN_SCORE, exceptProjects: [projectId], projects: Object.keys(state.projects),
  });
  if (!hits.length) return null;
  const text = hits.map((hit) => {
    const v = hitView(hit);
    return "- " + [v.customer, v.project, v.title].filter(Boolean).join(" · ") + ": " + v.snippet;
  }).join("\n");
  return { id: HINT_ID, title: HINT_TITLE, text };
}

const brainTimers = new Map();
let brainQueue = Promise.resolve();
/**
 * Looks at a project again after it has been quiet for a while. Never throws.
 * Projects without a customer are not understood, only indexed for the search.
 */
function scheduleBrain(projectId, delayMs = BRAIN_DEBOUNCE_MS) {
  const project = state.projects[projectId];
  if (!project) { if (vectors.enabled) void vectors.retain(Object.keys(state.projects)); return; }
  if (project.customerId === UNASSIGNED && !vectors.enabled) return;
  clearTimeout(brainTimers.get(projectId));
  brainTimers.set(projectId, setTimeout(() => {
    brainTimers.delete(projectId);
    const job = state.projects[projectId]?.customerId === UNASSIGNED ? () => indexProject(state.projects[projectId]) : () => runBrain(projectId);
    brainQueue = brainQueue.then(job).catch((error) => console.error("project understanding: " + error.message));
  }, delayMs));
}

/**
 * Changes made in the Work Dashboard: now and then one list_tasks per dashboard
 * project; a different fingerprint than last time → the project is understood again.
 * The first look only remembers. Off with the sync off or SHOOT_WD_POLL_MS=0. Never throws.
 */
const wdPrints = new Map();
let wdPolling = false;
async function pollDashboard() {
  if (!wd.enabled || wdPolling) return;
  wdPolling = true;
  try {
    for (const project of Object.values(state.projects)) {
      if (!project.wdId) continue;
      const print = await wd.fingerprint(project.id);
      if (!print) continue;
      const before = wdPrints.get(project.id);
      wdPrints.set(project.id, print);
      // files uploaded to its tasks (also on the first look: they may have come while the server was off)
      if (before !== print) await importTaskFiles(project.id);
      if (before !== undefined && before !== print) scheduleBrain(project.id);
    }
  } catch (error) {
    console.error("work dashboard: " + error.message);
  } finally {
    wdPolling = false;
  }
}

// ---------------------------------------------------------------------------
// Files from the Work Dashboard: the inbox, sorted by the local model
// (shoot-day-inbox.mjs), and files uploaded straight to a project's tasks.
// Nothing is ever deleted over there; failures only reach the log (never a
// file's content).
// ---------------------------------------------------------------------------
const inboxOn = () => wd.enabled && Boolean(LLM_URL);
const llmOptions = () => ({ url: LLM_URL, model: LLM_MODEL, token: LLM_TOKEN, timeoutMs: LLM_TIMEOUT_MS });
const shaOf = (buffer) => createHash("sha256").update(buffer).digest("hex");
const percent = (sure) => Math.round(Number(sure) * 100) + " %";
const noExt = (name) => String(name ?? "").replace(/\.(pdf|png|jpe?g)$/i, "").trim();
const nameKey = (name) => String(name ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const sameName = (a, b) => Boolean(a && b) && (nameKey(a) === nameKey(b) || nameKey(noExt(a)) === nameKey(noExt(b)));
const inboxStatus = { lastRun: 0, lastError: "" };
let inboxRunning = null;
let inboxTaskId = "";

/** SHA-256 of a project file: stored on newer files, read from disk once for older ones. */
async function fileSha(projectId, file) {
  if (file.sha) return file.sha;
  try { file.sha = shaOf(await readFile(filePath(projectId, file))); } catch { return ""; }
  return file.sha;
}

/**
 * Bytes from the dashboard → a project file, like an upload (type from the first bytes,
 * name from the dashboard). The same content twice → the file that is already there.
 * @returns {Promise<{ file: object, duplicate: boolean } | null>}
 */
async function importFile(projectId, bytes, type, name) {
  let project = state.projects[projectId];
  if (!project) return null;
  const sha = shaOf(bytes);
  for (const file of [...project.files]) if (await fileSha(projectId, file) === sha) return { file, duplicate: true };
  project = state.projects[projectId];
  if (!project || project.files.length >= 200) return null;
  const file = { id: newId("f"), name: safeName(name, type), type, size: bytes.length, uploaded: Date.now(), sha };
  await mkdir(fileDir(projectId), { recursive: true });
  await writeFile(filePath(projectId, file) + ".part", bytes);
  await rename(filePath(projectId, file) + ".part", filePath(projectId, file));
  project = state.projects[projectId];
  if (!project) return null;
  project.files.push(file);
  touch(project);
  return { file, duplicate: false };
}

/** Remembers that a dashboard attachment is in Shoot Day (p.wdTasks.imported: attachment id → file id, "" = not taken). */
function markImported(projectId, attachmentId, fileId) {
  const project = state.projects[projectId];
  if (!project || attachmentId === "" || attachmentId === undefined || attachmentId === null) return;
  project.wdTasks ??= { todo: {} };
  (project.wdTasks.imported ??= {})[String(attachmentId)] = fileId;
}

/**
 * A storyboard PDF → scenes (local model). It replaces the storyboard it is a new version
 * of (`replaces` = that one's title or source file; the old version is kept in
 * board.previous, the last 3), otherwise it is added. Never throws.
 * @returns {Promise<{ title: string, replaced: string } | null>}
 */
async function applyStoryboard(projectId, file, text, replaces) {
  if (!LLM_URL || !String(text ?? "").trim()) return null;
  try {
    const proposal = await proposeScenes(text, { ...llmOptions(), lang: PRESET_LANG });
    if (!proposal.ok || !proposal.scenes.length) { console.error("inbox: no scenes from a storyboard (" + (proposal.error ?? "empty") + ")"); return null; }
    const project = state.projects[projectId];
    if (!project) return null;
    const title = noExt(file.name).slice(0, 200) || file.name;
    const board = replaces ? project.storyboards.find((b) => sameName(b.title, replaces) || sameName(b.source, replaces)) : null;
    if (board) {
      const old = board.title || noExt(board.source) || "Storyboard";
      board.previous = [{ title: board.title, source: board.source, scenes: board.scenes, replaced: Date.now() }, ...(board.previous ?? [])].slice(0, 3);
      board.title = title; board.source = file.name; board.scenes = proposal.scenes;
      touch(project);
      return { title, replaced: old };
    }
    if (project.storyboards.length >= 50) return null;
    project.storyboards.push({ id: newId("s"), title, source: file.name, scenes: proposal.scenes });
    touch(project);
    return { title, replaced: "" };
  } catch (error) {
    console.error("inbox: storyboard failed (" + error.message + ")");
    return null;
  }
}

/** Every project with a dashboard project, for the model: customer, date, open tasks, files, storyboards. */
async function inboxCandidates() {
  const projects = Object.values(state.projects).filter((p) => p.wdId && p.customerId !== UNASSIGNED).sort((a, b) => b.updated - a.updated).slice(0, 60);
  const out = [];
  for (const p of projects) {
    const tasks = (await wd.openTasks(p.id)) ?? [];
    const now = state.projects[p.id];
    if (!now) continue;
    out.push({
      id: now.id, name: now.name, customer: state.customers[now.customerId]?.name ?? "", date: now.date, tasks,
      files: now.files.map((f) => f.name), storyboards: now.storyboards.map((b) => b.title).filter(Boolean),
    });
  }
  return out;
}

/** The (up to 3) candidates most like the text, by the vector search; [] when it is off. Never throws. */
async function inboxHints(text, candidates) {
  if (!vectors.enabled || !String(text ?? "").trim() || !candidates.length) return [];
  try {
    const result = await vectors.query(String(text).slice(0, 4000), { limit: 12, projects: candidates.map((c) => c.id) });
    if (!result.ok) return [];
    const ids = [];
    for (const hit of result.hits) { if (!ids.includes(hit.entry.projectId)) ids.push(hit.entry.projectId); if (ids.length === 3) break; }
    return ids.map((id) => candidates.find((c) => c.id === id)).filter(Boolean).map((c) => [c.customer, c.name].filter(Boolean).join(" · ") + " (" + c.id + ")");
  } catch {
    return [];
  }
}

/**
 * One file from the inbox. Sure enough and the project known: into Shoot Day, moved to its
 * task (or "Unterlagen"), a comment there, a storyboard taken over. Otherwise it stays in the
 * inbox with a comment and a proposal. "failed" = try again on a later look.
 */
async function handleInboxItem(item, candidates) {
  const id = asId(item);
  const name = str(item?.filename, 300).trim() || "Datei";
  const bytes = await wd.readAttachment(id);
  if (!bytes) return { status: "failed", error: "download" };
  const type = bytes.length <= MAX_UPLOAD ? sniff(bytes) : null;
  let text = "";
  if (type === "pdf") { try { text = extractPdfText(bytes).text ?? ""; } catch { text = ""; } }
  let r;
  if (!type) {
    r = { project: null, task: null, art: "sonstiges", ersetzt: null, sicher: 0, grund: bytes.length > MAX_UPLOAD ? "Datei zu groß" : "weder PDF noch PNG noch JPEG" };
  } else {
    const hints = await inboxHints(text || name, candidates);
    const answer = await classifyFile({ file: { name, mime: str(item?.mime, 80) }, text, candidates, hints }, llmOptions());
    if (!answer.ok) return { status: "failed", error: "model " + answer.error };
    r = answer.result;
  }
  const facts = { file: name, art: r.art, sicher: r.sicher, grund: r.grund, ...(r.project ? { project: r.project } : {}) };
  const project = r.project ? state.projects[r.project] : null;
  if (!type || !project || r.sicher < INBOX_MIN) {
    const proposal = project ? [state.customers[project.customerId]?.name, project.name].filter(Boolean).join(" / ") : "keiner";
    if (inboxTaskId !== "") await wd.comment(inboxTaskId, name + ": nicht sicher zuzuordnen – Vorschlag: " + proposal + " (" + (r.grund || "ohne Begründung") + ", sicher " + percent(r.sicher) + ")");
    return { status: "kept", ...facts };
  }
  const pid = project.id;
  const imported = await importFile(pid, bytes, type, name);
  if (!imported) return { status: "failed", error: "import", ...facts };
  const target = r.task ?? await wd.docsTask(pid);
  if (target === null || target === undefined || target === "") { await persist(); return { status: "failed", error: "no task", ...facts }; }
  markImported(pid, id, imported.file.id);
  const moved = await wd.moveAttachment(id, target);
  if (!moved) { await persist(); return { status: "failed", error: "move", ...facts }; }
  const movedId = asId(moved);
  if (movedId !== "" && String(movedId) !== String(id)) markImported(pid, movedId, imported.file.id);
  await wd.comment(target, "Aus dem Eingang automatisch zugeordnet: " + (r.grund || "ohne Begründung") + " (" + r.art + ", sicher " + percent(r.sicher) + ")");
  const board = r.art === "storyboard" && type === "pdf" && !imported.duplicate ? await applyStoryboard(pid, imported.file, text, r.ersetzt) : null;
  await persist();
  scheduleBrain(pid);
  wd.schedule(pid);
  return {
    status: "assigned", ...facts, task: target, fileId: imported.file.id, ...(imported.duplicate ? { duplicate: true } : {}),
    ...(board ? { storyboard: board.title, ...(board.replaced ? { replaced: board.replaced } : {}) } : {}),
  };
}

/**
 * One look at the inbox: every item not looked at yet (state.inboxSeen), each once – a
 * failed look again up to INBOX_TRIES times, a "kept" one only after POST /api/inbox/retry.
 * Off without the sync or the local model. Never throws.
 */
function runInbox() {
  if (!inboxOn()) return Promise.resolve();
  if (inboxRunning) return inboxRunning;
  inboxRunning = (async () => {
    try {
      const box = await wd.inbox();
      if (!box) { inboxStatus.lastError = "inbox unreachable"; return; }
      inboxTaskId = box.taskId;
      let candidates = null;
      for (const item of box.items.slice(0, 25)) {
        const id = String(asId(item));
        const seen = state.inboxSeen[id];
        if (seen && (seen.result?.status !== "failed" || seen.tries >= INBOX_TRIES)) continue;
        candidates ??= await inboxCandidates();
        let result;
        try {
          result = await handleInboxItem(item, candidates);
        } catch (error) {
          console.error("inbox: " + error.message);
          result = { status: "failed", error: "internal" };
        }
        state.inboxSeen[id] = { at: Date.now(), name: str(item?.filename, 200), tries: (seen?.tries ?? 0) + 1, result };
        const ids = Object.keys(state.inboxSeen);
        if (ids.length > INBOX_KEEP) {
          for (const old of ids.sort((a, b) => state.inboxSeen[a].at - state.inboxSeen[b].at).slice(0, ids.length - INBOX_KEEP)) delete state.inboxSeen[old];
        }
        await persist();
        if (result.status === "assigned") candidates = null;   // its files and storyboards changed
        console.log("inbox: " + result.status + (result.project ? " → " + (state.projects[result.project]?.name ?? "?").slice(0, 40) : "")
          + (result.sicher !== undefined ? " (sicher " + percent(result.sicher) + ")" : "") + (result.error ? " – " + result.error : ""));
      }
      inboxStatus.lastError = "";
    } catch (error) {
      console.error("inbox: " + error.message);
      inboxStatus.lastError = "internal";
    } finally {
      inboxStatus.lastRun = Date.now();
      inboxRunning = null;
    }
  })();
  return inboxRunning;
}

/** GET /api/inbox/status: the latest results, never a file's content. */
function inboxView() {
  const items = Object.entries(state.inboxSeen ?? {}).sort((a, b) => b[1].at - a[1].at).slice(0, 50)
    .map(([id, v]) => ({ id, name: v.name, at: v.at, tries: v.tries, ...v.result }));
  return { enabled: inboxOn(), running: Boolean(inboxRunning), min: INBOX_MIN, lastRun: inboxStatus.lastRun || null, lastError: inboxStatus.lastError || null, items };
}

/**
 * Files people uploaded straight to a project's dashboard tasks (not the drafts and files
 * Shoot Day put there itself): into the project's files, once each (p.wdTasks.imported,
 * same content only once). A storyboard PDF replaces the storyboard it is a new version of
 * (local model; a comment says so) or is added. Never moved, never deleted. Never throws.
 */
async function importTaskFiles(projectId) {
  if (!wd.enabled) return;
  try {
    const list = await wd.projectAttachments(projectId);
    if (!list?.length) return;
    let changed = false;
    for (const a of list.slice(0, 50)) {
      let project = state.projects[projectId];
      if (!project) return;
      if ((inboxTaskId !== "" && String(a.taskId) === String(inboxTaskId)) || project.wdTasks?.imported?.[String(a.id)] !== undefined) continue;
      const bytes = await wd.readAttachment(a.id);
      if (!bytes) continue;   // again on the next look
      const type = bytes.length <= MAX_UPLOAD ? sniff(bytes) : null;
      if (!type) { markImported(projectId, a.id, ""); changed = true; continue; }
      const imported = await importFile(projectId, bytes, type, a.filename);
      if (!imported) continue;
      markImported(projectId, a.id, imported.file.id);
      changed = true;
      console.log("dashboard files: " + (imported.duplicate ? "already there" : "taken over") + " (" + type + ")");
      if (imported.duplicate || type !== "pdf" || !LLM_URL) continue;
      let text = "";
      try { text = extractPdfText(bytes).text ?? ""; } catch { text = ""; }
      project = state.projects[projectId];
      if (!text.trim() || !project) continue;
      // the project is known: the model only says what it is and what it replaces
      const candidate = {
        id: projectId, name: project.name, customer: state.customers[project.customerId]?.name ?? "", date: project.date, tasks: [],
        files: project.files.filter((f) => f.id !== imported.file.id).map((f) => f.name), storyboards: project.storyboards.map((b) => b.title).filter(Boolean),
      };
      const answer = await classifyFile({ file: { name: a.filename, mime: a.mime }, text, candidates: [candidate], project: projectId }, llmOptions());
      if (!answer.ok || answer.result.art !== "storyboard") continue;
      const board = await applyStoryboard(projectId, imported.file, text, answer.result.ersetzt);
      if (board?.replaced) await wd.comment(a.taskId, "Neue Fassung von " + board.replaced + " übernommen, alte Fassung aufgehoben", { silent: true });
    }
    if (changed && state.projects[projectId]) {
      await persist();
      scheduleBrain(projectId);
      wd.schedule(projectId);
    }
  } catch (error) {
    console.error("dashboard files: " + error.message);
  }
}

/**
 * One run: material → (unchanged? stop) → local model (or, without it, the words of
 * the to-dos) → drafts for the paperwork it names → stored on the project → dashboard.
 */
async function runBrain(projectId, { force = false } = {}) {
  let project = state.projects[projectId];
  if (!project || project.customerId === UNASSIGNED) return { ok: false, error: "no project" };
  const sources = await sourcesOf(project);
  if (!sources) return { ok: false, error: "gone" };
  project = state.projects[projectId];
  await indexProject(project, sources);
  const hash = materialHash(sources);
  if (!force && project.brain?.hash === hash && !project.brain?.error) return { ok: true, unchanged: true };
  let analysis; let digests = project.brain?.digests ?? {}; let error = "";
  if (LLM_URL) {
    const hint = earlierProjects(projectId);
    const result = await analyseProject(sources, {
      digests, url: LLM_URL, model: LLM_MODEL, token: LLM_TOKEN, timeoutMs: LLM_TIMEOUT_MS,
      ...(hint ? { hints: [hint] } : {}), ...(vectors.enabled ? { rank: vectors.ranker(projectId) } : {}),
    });
    digests = result.digests;
    if (result.ok) analysis = result.analysis; else error = result.error;
  }
  project = state.projects[projectId];
  if (!project) return { ok: false, error: "gone" };
  if (!analysis) analysis = fallbackAnalysis(project);
  const titles = new Map(sources.map((s) => [s.id, s.title]));
  for (const u of analysis.unterlagen) {
    u.label = templateLabel(u.template);
    if (isInternalTemplate(u.template)) u.internal = true; else delete u.internal;
    u.sourceTitles = u.quellen.map((id) => titles.get(id)).filter(Boolean);
    if (!PDF_CHROME) continue;
    try {
      u.files = await writeDrafts(projectId, u.template, { purpose: u.angaben?.zweck ?? "", facts: u.angaben ?? {}, point: u.warum, reuse: true });
    } catch (e) {
      console.error("drafts: " + u.template + " failed (" + e.message + ")");
    }
  }
  project = state.projects[projectId];
  if (!project) return { ok: false, error: "gone" };
  project.brain = { hash, at: Date.now(), sources: sources.length, analysis, digests, ...(error ? { error } : {}) };
  await persist();
  console.log("project understanding: " + project.name.slice(0, 40) + " – " + analysis.unterlagen.length + " paperwork item(s)" + (error ? " (model failed: " + error + ", words only)" : analysis.fallback ? " (words only)" : ""));
  wd.schedule(projectId);
  return { ok: true, analysis };
}

/**
 * What a talk left open (needed / questions / promises / next), from the local
 * model only (shoot-day-talkpoints.mjs). One talk after another; the result is
 * stored on the talk and the sync files it as proposals. A failure only notes
 * the reason on the talk – POST …/talks/points tries again.
 */
let pointsQueue = Promise.resolve();
const pointsQueued = new Set();
function queueTalkPoints(projectId, talkId) {
  if (!LLM_URL || pointsQueued.has(talkId)) return;
  pointsQueued.add(talkId);
  pointsQueue = pointsQueue.then(async () => {
    try {
      const find = () => state.projects[projectId]?.talks?.find((t) => t.id === talkId);
      const talk = find();
      if (!talk || talk.points) return;
      const result = await extractTalkPoints(talk, { url: LLM_URL, model: LLM_MODEL, token: LLM_TOKEN, timeoutMs: LLM_TIMEOUT_MS });
      // drafts first, on a copy: a sync in between must not see points without their drafts
      // (the dashboard tasks are created once and would never name them)
      if (result.ok) await draftsForTalk(projectId, { ...talk, points: result.points });
      const still = find();
      if (!still) return;
      if (result.ok) { still.points = result.points; delete still.pointsError; } else still.pointsError = result.error;
      await persist();
      console.log("talk points: " + (result.ok ? pointCount(result.points) + " point(s)" : "failed (" + result.error + ")"));
      if (result.ok) wd.schedule(projectId);
    } catch (error) {
      console.error("talk points: " + error.message);
    } finally {
      pointsQueued.delete(talkId);
    }
  });
}

/** A deleted project/customer is archived over there on the next sync (never deleted). */
function wdForget(kind, object) {
  if (!wd.enabled || !object?.wdId) return;
  (state.wdGone ??= []).push({ kind, wdId: object.wdId });
}

/** After every successful write: the project it touched is understood again once it is quiet. Never throws. */
function brainAfterWrite(url) {
  try {
    const parts = url.pathname.split("/").filter(Boolean).map((part) => { try { return decodeURIComponent(part); } catch { return ""; } });
    if (["wd", "stt", "active", "brain", "search", "context", "inbox"].includes(parts[1])) return;
    if (parts[1] === "customers") {
      if (vectors.enabled) void vectors.retain(Object.keys(state.projects));   // a deleted customer takes its projects along
      for (const p of Object.values(state.projects)) if (p.customerId === parts[2]) scheduleBrain(p.id);
      return;
    }
    if (parts[1] === "projects") { if (parts[2] && parts[4] !== "docs") scheduleBrain(parts[2]); return; }
    const wanted = url.searchParams.get("project");
    const project = wanted ? state.projects[wanted] : active();
    if (project) scheduleBrain(project.id);
  } catch (error) {
    console.error("project understanding: " + error.message);
  }
}

/** After every successful write: mirror the project (or customer) it touched, debounced. Never throws. */
function wdAfterWrite(url) {
  if (!wd.enabled) return;
  try {
    const parts = url.pathname.split("/").filter(Boolean).map((part) => { try { return decodeURIComponent(part); } catch { return ""; } });
    if (["wd", "stt", "active", "search", "context", "inbox"].includes(parts[1])) return;
    if (parts[1] === "customers") { if (parts[2]) wd.schedule({ customer: parts[2] }); return; }
    if (parts[1] === "projects") { if (parts[2]) wd.schedule(parts[2]); return; }
    const wanted = url.searchParams.get("project");
    const project = wanted ? state.projects[wanted] : active();
    if (project) wd.schedule(project.id);
  } catch (error) {
    console.error("work dashboard: " + error.message);
  }
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
        "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' blob:; frame-src blob:",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(html);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (!authorised(request)) { request.resume(); send(response, 401, { error: "unauthorized" }); return; }
      await api(request, response, url);
      if (request.method !== "GET" && response.statusCode < 300) { wdAfterWrite(url); brainAfterWrite(url); }
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
  console.log("Shoot Day server on http://" + HOST + ":" + PORT + "/  (project: " + (active()?.name || "–") + ")");
  console.log("  data: " + DATA_FILE + "  files: " + FILES_DIR);
  console.log("  speech: " + (WHISPER_URL ? "on" : "off (set WHISPER_URL)") + " · storyboard LLM: " + (LLM_URL ? "on" : "off") + " · Babel memory: " + (BABEL_URL ? "on" : "off"));
  console.log("  Work Dashboard sync: " + (wd.enabled ? "on" : "off (set SHOOT_WD_URL and SHOOT_WD_TOKEN)"));
  console.log("  Paperwork drafts: " + (PDF_CHROME ? "on" : "off (no chrome)") + " · letterhead: " + (brandInfo.brand ? "on" : "off"));
  console.log("  Project understanding: " + (LLM_URL ? "local model" : "words only (no SHOOT_LLM_URL)"));
  // every project once after the start, then now and then (unchanged material costs nothing)
  const sweep = (delay) => { let n = 0; for (const p of Object.values(state.projects)) scheduleBrain(p.id, delay + 5000 * n++); };
  sweep(Number(process.env["SHOOT_BRAIN_START_MS"] ?? 20_000));
  setInterval(() => sweep(0), BRAIN_SWEEP_MS).unref();
  console.log("  Search over all projects: " + (vectors.enabled ? "on (" + VECTORS_FILE + ")" : "off (set SHOOT_EMBED_URL)"));
  if (vectors.enabled) brainQueue = brainQueue.then(() => vectors.load()).then(indexAll).catch((error) => console.error("vectors: " + error.message));
  if (wd.enabled && WD_POLL_MS > 0) {
    void pollDashboard();
    setInterval(() => void pollDashboard(), WD_POLL_MS).unref();
  }
  if (inboxOn() && WD_POLL_MS > 0) {
    setTimeout(() => void runInbox(), INBOX_START_MS).unref();
    setInterval(() => void runInbox(), WD_POLL_MS).unref();
  }
  console.log("  Dashboard inbox: " + (inboxOn() && WD_POLL_MS > 0 ? "on (sure from " + Math.round(INBOX_MIN * 100) + " %)" : "off (needs the Work Dashboard sync, SHOOT_LLM_URL and SHOOT_WD_POLL_MS)"));
  console.log("  Google Calendar: " + (gcal.enabled() ? "on" : "off (see shoot-day-gcal.mjs)"));
  if (!TOKEN) console.log("  No TOKEN set: anyone who can reach this port can read and change your projects.");
});

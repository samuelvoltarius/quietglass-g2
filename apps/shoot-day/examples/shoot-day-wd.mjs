/**
 * One-way sync Shoot Day → Work Dashboard (self-hosted customer/project/task
 * manager, reached over its MCP endpoint `POST <SHOOT_WD_URL>/mcp` with an
 * agent token `Authorization: Bearer wd_…`).
 *
 *   customer (name, email)          → customer (matched by exact name, case-insensitive, before creating)
 *   project                         → project of that customer
 *   project.date                    → task "Termin: <project>" with start/due date
 *   idea tagged #todo               → one task each (labels = tags, done idea = status done)
 *   other open ideas + phone/notes  → description of the task "Ideen & Notizen"
 *   storyboards, shot list, script  → description of the task "Drehvorbereitung"
 *   talk (Babel summary + cards)    → one comment on "Termin: …" (or on "Gespräche" without a date)
 *   talk.points (local model)       → "Vorschlag: Offen aus Gespräch …" + one task per needed point and
 *                                     next step, created once (stable key), never updated again
 *   paperwork drafts (PDF)          → attached to the task of their needed point; drafts written by hand
 *                                     to the task "Unterlagen"; each file once
 *   project.brain (local model)     → task "Projektlage (KI)": overview, connections, paperwork, open points;
 *                                     rewritten when it changes, the previous text kept as a comment;
 *                                     each draft attached to every task it belongs to
 *   customer.team (user names)      → on the team of every task of that customer's projects (only added,
 *                                     never removed – the team sees the tasks and their attachments)
 *   brain.analysis.termine          → one appointment each (is_event, starts_at/ends_at or all day, location,
 *                                     labels "vorschlag" + "termin"), created once under a stable key from
 *                                     title + date, never updated or deleted – confirming (removing the label
 *                                     "vorschlag") or deleting it is the team's business
 *
 * Read only on request of the server (shoot-day-inbox.mjs): the inbox (files dropped there
 * without a project), the attachments of a project's tasks; an inbox file is moved to its
 * task and commented on only when the server says so. Shoot Day's own uploads (drafts) are
 * never taken back in.
 *
 * The dashboard owns the status of an existing task: "open" is only sent on
 * create, "done" from Shoot Day still goes over (a tick there is never undone).
 *
 * Nothing is ever deleted in the dashboard: a deleted project/customer is
 * archived there, a deleted #todo idea leaves its task with a note.
 * Ids of the dashboard objects are kept on the Shoot Day objects (wdId,
 * wdTasks) together with a content hash per pushed item (wdHash, wdHashes),
 * so a second sync with no changes sends nothing.
 *
 * Failures never reach the caller of schedule(): they are kept in status()
 * and retried with backoff. The URL and the token never appear in a log
 * line or in an error message.
 *
 * Dependency-free (Node 18+).
 */
import { createHash } from "node:crypto";
import { isoWithOffset } from "./shoot-day-gcal.mjs";

const UNASSIGNED = "unassigned";
const TITLE_IDEAS = "Ideen & Notizen";
const TITLE_PREP = "Drehvorbereitung";
const TITLE_TALKS = "Gespräche";
const TITLE_DOCS = "Unterlagen";
const TITLE_LAGE = "Projektlage (KI)";
/** Internal protocols (conversations, the AI's overview): marked in the text and with a label – never for the customer. */
export const INTERN = "INTERN – internes Protokoll, nur für das Team, nie an den Kunden senden.";
const INTERN_LABEL = "intern";
const NOTE_DELETED = "(in Shoot Day gelöscht)";
const NOTE_UNTAGGED = "(in Shoot Day nicht mehr als #todo markiert)";
const NOTE_NO_DATE = "(Termin in Shoot Day entfernt)";
const FOOTER = "— aus Shoot Day, wird automatisch aktualisiert";
/** File names of the paperwork drafts Shoot Day writes (never taken back in as customer files). */
export const DRAFT_PREFIX = "Entwurf – ";
const docsWant = () => ({ title: TITLE_DOCS, description: "Entwürfe aus den Vorlagen. Die PDFs hängen an dieser Aufgabe.\n\n" + FOOTER });
const DESC_MAX = 8000;
/** Labels of an appointment: "termin"; a proposal also "vorschlag" (the team confirms it by removing that). */
export const EVENT_LABEL = "termin";
export const CANCELLED_LABEL = "abgesagt";
const EVENT_NOTE = "Vorschlag der KI – bitte bestätigen oder löschen.";
/** At most this many appointment proposals per project, ever (a model that keeps changing its mind cannot flood the dashboard). */
const MAX_EVENT_PROPOSALS = 6;
const DEFAULT_RETRY_MS = [30_000, 120_000, 600_000, 1_800_000];

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const clip = (text, max) => {
  const s = String(text ?? "");
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
};
const oneLine = (text, max = 200) => clip(String(text ?? "").replace(/\s+/g, " ").trim(), max);
/** "14.10.: Barista erklärt …" → "Barista erklärt …" (Babel's date prefix on filed ideas). */
export const stripDatePrefix = (text) => String(text ?? "").replace(/^\s*\d{1,2}\.\d{1,2}\.(\d{2,4})?\s*:\s*/, "").trim();

/** "2026-10-14", "14.10.2026" → "2026-10-14"; anything else → "". */
export function isoDate(text) {
  const s = String(text ?? "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return "";
}

// ---------------------------------------------------------------------------
// Transport. Everything about the JSON-RPC envelope and the shape of a tool
// result lives here, so adapting to the dashboard's exact answers is one place.
// ---------------------------------------------------------------------------
export class WdError extends Error {}

/** The JSON-RPC message from a JSON body or from a server-sent-events body (last `data:` line). */
function rpcMessage(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  }
  const data = trimmed.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
  if (!data.length) throw new WdError("no JSON-RPC answer");
  return JSON.parse(data[data.length - 1]);
}

/** A tool result → plain value: structuredContent, else the JSON text of the first text part, else that text. */
export function toolValue(result) {
  if (result == null || typeof result !== "object") return result;
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts.filter((c) => c && c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
  if (result.isError === true) throw new WdError("tool error: " + oneLine(text || "unknown", 200));
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    const sc = result.structuredContent;
    // FastMCP wraps non-object returns as {result: …}
    return sc && typeof sc === "object" && !Array.isArray(sc) && Object.keys(sc).length === 1 && "result" in sc ? sc.result : sc;
  }
  if (!parts.length) return "content" in result ? null : result;
  try { return JSON.parse(text); } catch { return text; }
}

/** A list out of whatever a list_* tool answered: [..], {customers:[..]}, {items:[..]}, {data:[..]}. */
export function asList(value, key) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    for (const k of [key, "items", "data", "results", "result"]) if (Array.isArray(value[k])) return value[k];
    const first = Object.values(value).find(Array.isArray);
    if (first) return first;
  }
  return [];
}

/**
 * The id out of whatever a create_* tool answered: {id}, {customer:{id}}, {data:{id}}, a bare id.
 * Kept as the dashboard sent it (number or string), so it goes back in the same type.
 */
export function asId(value, key) {
  const ok = (id) => (typeof id === "number" && Number.isFinite(id)) || (typeof id === "string" && id !== "");
  if (ok(value)) return value;
  if (value && typeof value === "object") {
    if (ok(value.id)) return value.id;
    for (const k of [key, "data", "result", "item"]) {
      const inner = value[k];
      if (inner && typeof inner === "object" && ok(inner.id)) return inner.id;
    }
  }
  return "";
}
const sameId = (a, b) => a !== "" && a !== undefined && a !== null && String(a) === String(b);

/**
 * MCP client over plain HTTP POST. The only function that knows the envelope.
 * Initialises a session on its own when the server asks for one.
 */
export function createMcpClient({ url, token, fetchImpl = fetch, timeoutMs = 15_000 }) {
  const endpoint = String(url).trim().replace(/\/+$/, "").replace(/\/mcp$/, "") + "/mcp";
  let nextId = 1;
  let session = "";
  let initialised = false;

  async function rpc(method, params, notify = false) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer " + token,
      ...(session ? { "Mcp-Session-Id": session } : {}),
    };
    const message = { jsonrpc: "2.0", method, ...(params ? { params } : {}), ...(notify ? {} : { id: nextId++ }) };
    let response;
    try {
      response = await fetchImpl(endpoint, { method: "POST", headers, body: JSON.stringify(message), signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      // never echo the URL: fetch errors carry host names and addresses in their cause
      const code = error?.name === "TimeoutError" ? "timeout" : error?.cause?.code || error?.code || "unreachable";
      throw new WdError("network error (" + code + ")");
    }
    const sid = response.headers?.get?.("mcp-session-id");
    if (sid) session = sid;
    const text = await response.text();
    if (notify) return null;
    if (!response.ok) {
      let detail = "";
      try { detail = rpcMessage(text)?.error?.message ?? ""; } catch { /* not JSON */ }
      const error = new WdError("HTTP " + response.status + (detail ? ": " + oneLine(detail, 120) : ""));
      error.status = response.status;
      error.needsInit = /initiali[sz]/i.test(detail) || /session/i.test(detail);
      throw error;
    }
    let reply;
    try { reply = rpcMessage(text); } catch { throw new WdError("answer is not JSON-RPC"); }
    if (reply?.error) {
      const error = new WdError("JSON-RPC error " + (reply.error.code ?? "") + ": " + oneLine(reply.error.message, 160));
      error.needsInit = reply.error.code === -32002 || /initiali[sz]/i.test(String(reply.error.message));
      throw error;
    }
    return reply?.result;
  }

  async function initialise() {
    await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "shoot-day-sync", version: "1" } });
    await rpc("notifications/initialized", undefined, true).catch(() => undefined);
    initialised = true;
  }

  return {
    async call(name, args = {}) {
      try {
        return toolValue(await rpc("tools/call", { name, arguments: args }));
      } catch (error) {
        if (!error.needsInit || initialised) throw error;
        await initialise();
        return toolValue(await rpc("tools/call", { name, arguments: args }));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// What goes where (pure functions over a Shoot Day project/customer).
// ---------------------------------------------------------------------------
const isTodo = (idea) => Array.isArray(idea?.tags) && idea.tags.includes("todo");

function terminTask(project) {
  const date = isoDate(project.date);
  const d = project.dispo ?? {};
  const lines = [
    project.date ? "Datum: " + project.date : NOTE_NO_DATE,
    project.place ? "Ort: " + project.place : "",
    d.call ? "Treffpunkt/Call: " + d.call : "",
    d.location && d.location !== project.place ? "Location: " + d.location : "",
    d.contact ? "Kontakt vor Ort: " + d.contact : "",
    "", FOOTER,
  ].filter((line, i, all) => line !== "" || (i > 0 && all[i - 1] !== ""));
  return {
    title: clip("Termin: " + project.name, 200),
    description: lines.join("\n"),
    ...(date ? { start_date: date, due_date: date } : {}),
  };
}

function ideasTask(project, customer) {
  const contact = [
    customer?.company ? "Firma: " + customer.company : "",
    customer?.phone ? "Telefon: " + customer.phone : "",
    customer?.notes ? "Notizen zum Kunden:\n" + clip(customer.notes.trim(), 2000) : "",
  ].filter(Boolean);
  const open = (project.ideas ?? []).filter((idea) => !idea.done && !isTodo(idea));
  const ideas = open.map((idea) => "- " + oneLine(idea.text, 300) + (idea.tags?.length ? "  #" + idea.tags.join(" #") : ""));
  if (!contact.length && !ideas.length) return null;
  const parts = [];
  if (contact.length) parts.push(contact.join("\n"));
  if (ideas.length) parts.push("Offene Ideen (" + ideas.length + "):\n" + ideas.join("\n"));
  parts.push(FOOTER);
  return { title: TITLE_IDEAS, description: clip(parts.join("\n\n"), DESC_MAX) };
}

function prepTask(project) {
  const parts = [];
  const boards = project.storyboards ?? [];
  if (boards.length) {
    const lines = boards.slice(0, 10).map((b) => {
      const scenes = b.scenes ?? [];
      const titles = scenes.slice(0, 8).map((s) => oneLine(s.title || s.content, 50)).filter(Boolean);
      return "- " + (oneLine(b.title, 80) || "Storyboard") + ": " + scenes.length + " Szene(n)" + (titles.length ? " – " + titles.join(", ") + (scenes.length > 8 ? ", …" : "") : "");
    });
    parts.push("Storyboards (" + boards.length + "):\n" + lines.join("\n"));
  }
  const scenes = project.scenes ?? [];
  const shots = scenes.reduce((n, s) => n + (s.shots?.length ?? 0), 0);
  if (shots) {
    const list = scenes.flatMap((s) => (s.shots ?? []).map((sh) => s.scene + sh.shot + (sh.desc ? " " + oneLine(sh.desc, 40) : "")));
    parts.push("Shotlist: " + scenes.length + " Szene(n), " + shots + " Einstellung(en)\n" + list.slice(0, 15).map((x) => "- " + x).join("\n") + (list.length > 15 ? "\n- …" : ""));
  }
  const script = String(project.prompter ?? "").trim();
  if (script) {
    const words = script.split(/\s+/).length;
    parts.push("Skript: " + words + " Wörter (~" + Math.max(1, Math.round(words / 130)) + " min gesprochen)\n" + clip(script.replace(/\s+/g, " "), 300));
  }
  const schedule = project.dispo?.schedule ?? [];
  if (schedule.length) parts.push("Tagesplan: " + schedule.length + " Punkt(e)\n" + schedule.slice(0, 10).map((r) => "- " + [r.time, r.what].filter(Boolean).join(" ")).join("\n"));
  const need = (project.equipment ?? []).filter((i) => i.need);
  if (need.length) parts.push("Packliste: " + need.filter((i) => i.packed).length + "/" + need.length + " gepackt");
  if (!parts.length) return null;
  parts.push(FOOTER);
  return { title: TITLE_PREP, description: clip(parts.join("\n\n"), DESC_MAX) };
}

function todoTask(idea, statusOpen, statusDone) {
  return {
    title: oneLine(stripDatePrefix(idea.text), 200) || "Idee",
    description: clip(String(idea.text ?? ""), 2000) + "\n\n" + FOOTER,
    labels: (idea.tags ?? []).filter((t) => t !== "todo"),
    status: idea.done ? statusDone : statusOpen,
  };
}

const two = (n) => String(n).padStart(2, "0");
/** "Gespräch 14.10. 11:05 – Zusammenfassung\n…\n\nTipp-Karten:\n- …" */
export function talkComment(talk, timeZone) {
  const out = [INTERN, "", "Gespräch " + talkStamp(talk, timeZone) + " – Zusammenfassung", String(talk.summary ?? "").trim() || "(keine Zusammenfassung)"];
  const cues = Array.isArray(talk.cues) ? talk.cues : [];
  if (cues.length) out.push("", "Tipp-Karten:", ...cues.map((c) => "- " + [c.title, c.text].filter(Boolean).join(": ")));
  return clip(out.join("\n"), DESC_MAX);
}

/** "14.10. 11:05" in the given time zone. */
export function talkStamp(talk, timeZone) {
  const at = new Date(Number(talk?.at) || Date.now());
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("de-AT", { timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(at).map((p) => [p.type, p.value]));
    return `${parts.day}.${parts.month}. ${parts.hour}:${parts.minute}`;
  } catch {
    return `${two(at.getDate())}.${two(at.getMonth() + 1)}. ${two(at.getHours())}:${two(at.getMinutes())}`;
  }
}

/** "2026-10-20" → "20.10." */
const shortDate = (iso) => { const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(iso ?? "")); return m ? `${m[2]}.${m[1]}.` : ""; };
const POINT_HEADINGS = { needed: "Benötigt", questions: "Offene Fragen an den Kunden", promises: "Zusagen", next: "Nächste Schritte" };
const POINT_TITLES = { needed: "Benötigt", next: "Nächster Schritt" };
export const PROPOSAL = "Vorschlag: ";
const PROPOSAL_LABEL = "vorschlag";
const PROPOSAL_FOOTER = "— Vorschlag aus der Gesprächsauswertung (lokales Modell). Prüfen, anpassen oder löschen; wird nicht mehr überschrieben.";
const pointLine = (point) => "- " + (point.who ? point.who + ": " : "") + point.text + (point.due ? " (bis " + shortDate(point.due) + ")" : "");

/** One overview task per talk with everything it left open; null when nothing is open. */
export function pointsSummaryTask(talk, timeZone, draftsOf = () => []) {
  const points = talk?.points ?? {};
  const withDrafts = (point) => pointLine(point) + draftsOf(point).map((d) => "\n  → Entwurf (Anhang der Aufgabe dazu): " + d.name).join("");
  const blocks = Object.entries(POINT_HEADINGS)
    .filter(([kind]) => points[kind]?.length)
    .map(([kind, heading]) => heading + " (" + points[kind].length + "):\n" + points[kind].map(withDrafts).join("\n"));
  if (!blocks.length) return null;
  return {
    title: clip(PROPOSAL + "Offen aus Gespräch " + talkStamp(talk, timeZone), 200),
    description: clip([INTERN, ...blocks, PROPOSAL_FOOTER].join("\n\n"), DESC_MAX),
    labels: [PROPOSAL_LABEL, INTERN_LABEL],
  };
}

/**
 * One task for a single "needed" or "next" point, its date as due date. Drafts
 * written for it (`drafts`: [{name}]) are named in the description and attached.
 */
export function pointTask(kind, point, talk, timeZone, drafts = []) {
  const draftLines = drafts.length
    ? "Entwurf hängt an dieser Aufgabe (Anhänge, zum Herunterladen):\n" + drafts.map((d) => "- " + d.name).join("\n") + "\n\n"
    : "";
  return {
    title: clip(PROPOSAL + POINT_TITLES[kind] + ": " + point.text, 200),
    description: draftLines + (point.who ? "Wer: " + point.who + "\n" : "") + "Aus dem Gespräch " + talkStamp(talk, timeZone) + ".\n\n" + PROPOSAL_FOOTER,
    labels: [PROPOSAL_LABEL],
    ...(point.due ? { due_date: point.due } : {}),
  };
}

/** The text of "Projektlage (KI)" from the project understanding; null without one. */
export function lageTask(brain, timeZone) {
  const a = brain?.analysis;
  if (!a) return null;
  const parts = [INTERN, "Stand " + talkStamp({ at: brain.at }, timeZone) + " · " + (a.fallback ? "ohne Sprachmodell, nur aus dem Wortlaut der To-dos" : "lokales Sprachmodell") + " · " + (brain.sources ?? 0) + " Quellen"];
  if (a.lage) parts.push("Überblick\n" + a.lage);
  if (a.zusammenhaenge?.length) parts.push("Zusammenhänge\n" + a.zusammenhaenge.map((x) => "- " + x).join("\n"));
  if (a.unterlagen?.length) {
    parts.push("Benötigte Unterlagen\n" + a.unterlagen.map((u) => "- " + (u.label || u.template) + (u.warum ? ": " + u.warum : "")
      + (u.files?.length ? "\n  Entwurf hängt an: " + (u.sourceTitles?.length ? u.sourceTitles.map((t) => "„" + oneLine(t, 80) + "“").join(", ") : "„Vorschlag: Benötigt: " + (u.label || u.template) + "“") : "")).join("\n"));
  }
  if (a.offen?.length) parts.push("Offene Punkte\n" + a.offen.map((x) => "- " + x).join("\n"));
  parts.push("— wird bei jeder Änderung am Projekt neu geschrieben; frühere Stände stehen in den Kommentaren.");
  return { title: TITLE_LAGE, description: clip(parts.join("\n\n"), DESC_MAX), labels: ["ki", INTERN_LABEL] };
}

/**
 * An appointment proposal from the project understanding ({titel, datum, von, bis, ort, grund})
 * → the dashboard task: a timed event with starts_at/ends_at in `tz`, or all day (starts_at null,
 * start_date/due_date the day), or without a date at all.
 */
export function eventTask(termin, tz = "Europe/Vienna") {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(termin?.datum ?? "")) ? termin.datum : "";
  const at = (hhmm) => {
    const [y, m, d] = date.split("-").map(Number);
    const [hh, mm] = String(hhmm).split(":").map(Number);
    return isoWithOffset(Date.UTC(y, m - 1, d, hh, mm), tz);
  };
  const isTime = (v) => /^\d{2}:\d{2}$/.test(String(v ?? ""));
  const timed = Boolean(date && isTime(termin?.von));
  return {
    title: clip(oneLine(termin?.titel, 200) || "Termin", 200),
    description: (termin?.grund ? oneLine(termin.grund, 600) + "\n\n" : "") + EVENT_NOTE,
    labels: [PROPOSAL_LABEL, EVENT_LABEL],
    is_event: true,
    starts_at: timed ? at(termin.von) : null,
    ends_at: timed && isTime(termin?.bis) && termin.bis > termin.von ? at(termin.bis) : null,
    location: oneLine(termin?.ort, 200) || null,
    ...(date ? { start_date: date, due_date: date } : {}),
  };
}

/** The stable key of a proposal: the same title (any case/spacing) and date → the same dashboard task. */
export const eventKey = (termin) => "termin:" + hash([String(termin?.titel ?? "").toLowerCase().replace(/\s+/g, " ").trim(), String(termin?.datum ?? "")]).slice(0, 12);

/** Label names of a task, lower case, from ["a"], [{name: "a"}] or "a, b". */
export function labelNames(labels) {
  const list = Array.isArray(labels) ? labels : typeof labels === "string" ? labels.split(",") : [];
  return list.map((l) => (typeof l === "string" ? l : l?.name ?? l?.label ?? l?.title ?? "")).map((l) => String(l).trim().toLowerCase()).filter(Boolean);
}
const truthy = (value) => value === true || value === 1 || value === "true" || value === "1";

// ---------------------------------------------------------------------------
// The sync itself.
// ---------------------------------------------------------------------------
/**
 * @param {object} o
 * @param {string} o.url       dashboard base URL ("" = off)
 * @param {string} o.token     agent token ("" = off)
 * @param {() => object} o.getState  the live Shoot Day state ({customers, projects, wdGone?})
 * @param {() => Promise<void>} o.persist  saves the state
 * @param {(line: string) => void} [o.log]
 */
export function createWdSync({
  url = "", token = "", getState, persist, log = (line) => console.error(line), fetchImpl = fetch,
  debounceMs = 10_000, retryMs = DEFAULT_RETRY_MS, statusOpen = "open", statusDone = "done", timeZone = undefined, timeoutMs = 15_000,
  readDraft = null,
  isInternal = () => false,   // templates that are internal paperwork (never at a customer's task), from the server
  eventTz = "Europe/Vienna",  // time zone of appointment times (starts_at/ends_at)
}) {
  const enabled = Boolean(String(url).trim() && String(token).trim());
  const secrets = [String(url).trim(), String(url).trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""), String(token).trim()].filter((s) => s.length >= 4);
  const scrub = (text) => secrets.reduce((acc, s) => acc.split(s).join("***"), String(text ?? ""));
  const say = (line) => { try { log(scrub(line)); } catch { /* logging never breaks the sync */ } };
  const client = enabled ? createMcpClient({ url, token, fetchImpl, timeoutMs }) : null;
  const status = { enabled, lastSync: 0, lastError: "", lastErrorAt: 0, sent: 0 };
  const timers = new Map();     // key → timeout
  const attempts = new Map();   // key → failed attempts in a row
  let chain = Promise.resolve();
  let running = 0;

  const state = () => getState();
  const call = async (name, args, counter) => {
    counter.sent++;
    return client.call(name, args);
  };

  /** Run one job at a time: two saves never create the same dashboard object twice. */
  function exclusive(job) {
    running++;
    const run = chain.then(job).finally(() => { running--; });
    chain = run.catch(() => undefined);
    return run;
  }

  // ---- customers -----------------------------------------------------------
  async function syncCustomer(id, ctx) {
    if (id === UNASSIGNED) return "";
    let c = state().customers[id];
    if (!c) return "";
    const want = { name: c.name };
    const h = hash(want);
    if (c.wdId) {
      if (c.wdHash !== h) {
        await call("update_customer", { id: c.wdId, name: c.name }, ctx);
        c = state().customers[id] ?? c; c.wdHash = h; ctx.changed = true;
      }
      return c.wdId;
    }
    ctx.customers ??= asList(await call("list_customers", {}, ctx), "customers");
    const lower = c.name.trim().toLowerCase();
    const matches = ctx.customers.filter((x) => String(x?.name ?? "").trim().toLowerCase() === lower);
    const hit = matches.find((x) => !x.archived) ?? matches[0];
    let wdId = hit ? asId(hit) : "";
    if (wdId && hit.archived) await call("update_customer", { id: wdId, archived: false }, ctx);
    if (!wdId) {
      wdId = asId(await call("create_customer", { name: c.name, ...(c.email ? { email: c.email } : {}) }, ctx), "customer");
      if (!wdId) throw new WdError("create_customer answered without an id");
      ctx.customers.push({ id: wdId, name: c.name });
    }
    c = state().customers[id] ?? c;
    c.wdId = wdId; c.wdHash = h; ctx.changed = true;
    return wdId;
  }

  // ---- projects ------------------------------------------------------------
  async function ensureTask(pid, slot, want, ctx, { matchTitle } = {}) {
    let p = state().projects[pid];
    if (!p?.wdId) return "";
    p.wdTasks ??= { todo: {} };
    p.wdHashes ??= { todo: {} };
    p.wdTasks.todo ??= {}; p.wdHashes.todo ??= {};
    const h = hash(want);
    const known = slot.startsWith("todo:") ? p.wdTasks.todo[slot.slice(5)] : p.wdTasks[slot];
    const knownHash = slot.startsWith("todo:") ? p.wdHashes.todo[slot.slice(5)] : p.wdHashes[slot];
    if (known && knownHash === h) return known;
    let taskId = known;
    // the dashboard owns the status of an existing task: "open" is never sent again (would undo a tick there),
    // only "done" from Shoot Day goes over
    const update = { ...want };
    if (update.status !== undefined && update.status !== statusDone) delete update.status;
    if (taskId) {
      await call("update_task", { id: taskId, ...update }, ctx);
    } else {
      if (matchTitle && ctx.adopted?.has(pid)) {
        ctx.tasks ??= new Map();
        if (!ctx.tasks.has(pid)) ctx.tasks.set(pid, asList(await call("list_tasks", { project_id: p.wdId }, ctx), "tasks"));
        const hit = ctx.tasks.get(pid).find((t) => matchTitle(String(t?.title ?? "")));
        if (hit) taskId = asId(hit);
      }
      if (taskId) await call("update_task", { id: taskId, ...update }, ctx);
      else {
        taskId = asId(await call("create_task", { project_id: p.wdId, ...want, ...teamArgs(ctx) }, ctx), "task");
        if (!taskId) throw new WdError("create_task answered without an id");
      }
    }
    p = state().projects[pid];
    if (!p) return taskId;
    p.wdTasks ??= { todo: {} }; p.wdHashes ??= { todo: {} };
    p.wdTasks.todo ??= {}; p.wdHashes.todo ??= {};
    if (slot.startsWith("todo:")) { p.wdTasks.todo[slot.slice(5)] = taskId; p.wdHashes.todo[slot.slice(5)] = h; }
    else { p.wdTasks[slot] = taskId; p.wdHashes[slot] = h; }
    ctx.changed = true;
    return taskId;
  }

  async function syncProject(pid, ctx) {
    let p = state().projects[pid];
    if (!p || p.customerId === UNASSIGNED) return;
    const wdCustomer = await syncCustomer(p.customerId, ctx);
    if (!wdCustomer) return;
    ctx.team = await teamOf(p.customerId, ctx);
    p = state().projects[pid];
    if (!p) return;

    // moved to another customer: the old dashboard project is archived, a new one starts
    if (p.wdId && p.wdCustomer !== undefined && !sameId(p.wdCustomer, wdCustomer)) {
      await call("update_project", { id: p.wdId, archived: true }, ctx);
      p = state().projects[pid] ?? p;
      delete p.wdId; delete p.wdHash; p.wdTasks = { todo: {} }; p.wdHashes = { todo: {} };
      for (const talk of p.talks ?? []) { delete talk.wdComment; delete talk.wdPoints; }
      ctx.changed = true;
    }
    const h = hash({ name: p.name });
    if (!p.wdId) {
      ctx.projects ??= asList(await call("list_projects", {}, ctx), "projects");
      const lower = p.name.trim().toLowerCase();
      const hit = ctx.projects.find((x) => sameId(x?.customer_id ?? x?.customerId, wdCustomer) && String(x?.name ?? "").trim().toLowerCase() === lower && !x.archived);
      let wdId = hit ? asId(hit) : "";
      if (wdId) (ctx.adopted ??= new Set()).add(pid);
      else {
        wdId = asId(await call("create_project", { customer_id: wdCustomer, name: p.name }, ctx), "project");
        if (!wdId) throw new WdError("create_project answered without an id");
        ctx.projects.push({ id: wdId, name: p.name, customer_id: wdCustomer });
      }
      p = state().projects[pid];
      if (!p) return;
      p.wdId = wdId; p.wdCustomer = wdCustomer; p.wdHash = h; ctx.changed = true;
    } else if (p.wdHash !== h) {
      await call("update_project", { id: p.wdId, name: p.name }, ctx);
      p = state().projects[pid] ?? p; p.wdHash = h; p.wdCustomer = wdCustomer; ctx.changed = true;
    }
    p.wdTasks ??= { todo: {} }; p.wdHashes ??= { todo: {} };

    // Termin: only once there is (or was) a date
    if (p.date || p.wdTasks.termin) await ensureTask(pid, "termin", terminTask(p), ctx, { matchTitle: (t) => t.startsWith("Termin: ") });

    p = state().projects[pid]; if (!p) return;
    const ideas = ideasTask(p, state().customers[p.customerId]);
    if (ideas || p.wdTasks.ideen) {
      await ensureTask(pid, "ideen", ideas ?? { title: TITLE_IDEAS, description: "(keine offenen Ideen)\n\n" + FOOTER }, ctx, { matchTitle: (t) => t === TITLE_IDEAS });
    }

    p = state().projects[pid]; if (!p) return;
    const prep = prepTask(p);
    if (prep || p.wdTasks.drehvorbereitung) {
      await ensureTask(pid, "drehvorbereitung", prep ?? { title: TITLE_PREP, description: "(nichts vorbereitet)\n\n" + FOOTER }, ctx, { matchTitle: (t) => t === TITLE_PREP });
    }

    // #todo ideas: one task each; gone or untagged ones keep their task with a note
    p = state().projects[pid]; if (!p) return;
    const live = new Map((p.ideas ?? []).map((idea) => [idea.id, idea]));
    for (const idea of p.ideas ?? []) {
      if (!isTodo(idea)) continue;
      await ensureTask(pid, "todo:" + idea.id, todoTask(idea, statusOpen, statusDone), ctx);
      p = state().projects[pid]; if (!p) return;
    }
    for (const [ideaId, taskId] of Object.entries(p.wdTasks.todo ?? {})) {
      const idea = live.get(ideaId);
      if (idea && isTodo(idea)) continue;
      const note = idea ? NOTE_UNTAGGED : NOTE_DELETED;
      const marker = "gone:" + note;
      if (p.wdHashes.todo?.[ideaId] === marker) continue;
      await call("update_task", { id: taskId, description: (idea ? clip(String(idea.text), 2000) + "\n\n" : "") + note }, ctx);
      p = state().projects[pid]; if (!p) return;
      p.wdHashes.todo[ideaId] = marker; ctx.changed = true;
    }

    // talks: one comment each, once
    p = state().projects[pid]; if (!p) return;
    for (const talk of p.talks ?? []) {
      if (talk.wdComment) continue;
      let target = p.wdTasks.termin;
      if (!target) target = await ensureTask(pid, "gespraeche", { title: TITLE_TALKS, description: INTERN + "\n\nGesprächsnotizen aus Babel (ohne Termin).\n\n" + FOOTER, labels: [INTERN_LABEL] }, ctx, { matchTitle: (t) => t === TITLE_TALKS });
      const created = await call("create_comment", { task_id: target, body: talkComment(talk, timeZone) }, ctx);
      p = state().projects[pid]; if (!p) return;
      const same = (p.talks ?? []).find((x) => x.id === talk.id) ?? talk;
      same.wdComment = asId(created, "comment") || "ok";
      ctx.changed = true;
    }

    // what the talks left open: proposals, each created once and then left to the dashboard
    p = state().projects[pid]; if (!p) return;
    for (const talk of p.talks ?? []) {
      if (!talk.points || talk.wdPoints) continue;
      await filePoints(pid, talk.id, ctx);
      p = state().projects[pid]; if (!p) return;
    }

    await syncLage(pid, ctx);
    await fileEvents(pid, ctx);
    await attachDrafts(pid, ctx);
    if (ctx.team.length) await ensureTeam(pid, ctx.team, ctx);
  }

  // ---- project understanding ------------------------------------------------
  /** "Projektlage (KI)": rewritten when the understanding changes; the text it replaces becomes a comment. */
  async function syncLage(pid, ctx) {
    let p = state().projects[pid];
    const want = lageTask(p?.brain, timeZone);
    if (!want || !p?.wdId) return;
    const h = hash(want);
    if (p.wdHashes?.lage === h) return;
    const before = p.wdTasks?.lageText;
    const taskId = await ensureTask(pid, "lage", want, ctx, { matchTitle: (t) => t === TITLE_LAGE });
    if (before && before !== want.description && taskId) {
      // silent: the earlier overview is kept for reading, it pings nobody
      await call("create_comment", { task_id: taskId, body: clip("Früherer Stand:\n\n" + before, DESC_MAX), silent: true }, ctx);
    }
    p = state().projects[pid]; if (!p) return;
    p.wdTasks ??= { todo: {} };
    p.wdTasks.lageText = want.description;
    ctx.changed = true;
  }

  // ---- appointment proposals ---------------------------------------------------
  /** Each proposal of the understanding once, as an appointment marked "vorschlag" – never touched again. */
  async function fileEvents(pid, ctx) {
    if (!state().projects[pid]?.wdId) return;
    for (const termin of state().projects[pid]?.brain?.analysis?.termine ?? []) {
      const now = state().projects[pid];
      if (!now) return;
      const key = eventKey(termin);
      const known = now.wdTasks?.points ?? {};
      if (known[key]) continue;
      if (Object.keys(known).filter((k) => k.startsWith("termin:")).length >= MAX_EVENT_PROPOSALS) return;
      await createOnce(pid, key, eventTask(termin, eventTz), ctx);
    }
  }

  // ---- team ----------------------------------------------------------------
  const teamArgs = (ctx) => (ctx.team?.length ? { participant_ids: ctx.team } : {});

  /** The customer's team names → dashboard user ids (exact name or first name, any case). Unknown names are logged once. */
  async function teamOf(customerId, ctx) {
    const names = state().customers[customerId]?.team ?? [];
    if (!names.length) return [];
    ctx.users ??= asList(await call("list_users", {}, ctx), "users").filter((u) => !u?.disabled);
    const ids = [];
    for (const name of names) {
      const lower = String(name).trim().toLowerCase();
      const hit = ctx.users.find((u) => String(u?.name ?? "").trim().toLowerCase() === lower)
        ?? ctx.users.find((u) => String(u?.name ?? "").trim().toLowerCase().split(/\s+/)[0] === lower);
      const id = hit ? Number(asId(hit)) : NaN;
      if (Number.isInteger(id)) { if (!ids.includes(id)) ids.push(id); }
      else if (!(ctx.unknownUsers ??= new Set()).has(lower)) { ctx.unknownUsers.add(lower); say("work dashboard: no user named \"" + oneLine(name, 60) + "\" for a customer team"); }
    }
    return ids.sort((a, b) => a - b);
  }

  /**
   * Puts the team on every task of the project – also on tasks made by hand in the
   * dashboard. Only adds people, never removes anyone. Done once per task and team.
   */
  async function ensureTeam(pid, ids, ctx) {
    let p = state().projects[pid];
    if (!p?.wdId) return;
    const key = ids.join(",");
    const tasks = asList(await call("list_tasks", { project_id: p.wdId }, ctx), "tasks");
    for (const task of tasks) {
      const taskId = asId(task);
      p = state().projects[pid]; if (!p) return;
      if (!taskId || p.wdTasks?.team?.[taskId] === key) continue;
      const now = await call("list_task_participants", { task_id: taskId }, ctx);
      const have = (Array.isArray(now?.participant_ids) ? now.participant_ids : []).map(Number);
      const missing = ids.filter((id) => !have.includes(id));
      if (missing.length) await call("set_task_participants", { task_id: taskId, participant_ids: [...have, ...missing] }, ctx);
      p = state().projects[pid]; if (!p) return;
      p.wdTasks ??= { todo: {} };
      (p.wdTasks.team ??= {})[taskId] = key;
      ctx.changed = true;
    }
  }

  // ---- attachments ---------------------------------------------------------
  /**
   * Paperwork drafts as files in the dashboard, so everyone on the task can download
   * them: a draft for a needed point goes to that point's task (once the task exists),
   * a draft written by hand to the project's task "Unterlagen". Each file once.
   */
  async function attachDrafts(pid, ctx) {
    if (!readDraft) return;
    let p = state().projects[pid];
    if (!p?.wdId) return;
    const pairs = [];   // [task slot resolver, file id]
    const add = (resolve, fileId) => pairs.push([resolve, fileId]);
    // drafts for a needed point of a talk → that point's task
    for (const talk of p.talks ?? []) {
      for (const point of talk.points?.needed ?? []) {
        const taskId = p.wdTasks?.points?.[point.key];
        if (taskId) for (const fileId of point.docs ?? []) add(async () => taskId, fileId);
      }
    }
    // drafts the understanding names → every task of its sources (to-dos, talks); none known → its own proposal task
    for (const u of p.brain?.analysis?.unterlagen ?? []) {
      // an internal document (e.g. the internship contract) never hangs at a task the customer's papers go out from:
      // only at its own task, marked internal
      const internal = Boolean(u.internal || isInternal(u.template));
      const tasks = internal ? [] : [...new Set((u.quellen ?? []).map((src) => {
        const [kind, id] = String(src).split(":");
        return kind === "idea" ? p.wdTasks?.todo?.[id] : kind === "talk" ? p.wdTasks?.points?.["talk:" + id] : kind === "dash" ? (/^\d+$/.test(id) ? Number(id) : id) : "";
      }).filter(Boolean))];
      const labels = internal ? [PROPOSAL_LABEL, INTERN_LABEL] : [PROPOSAL_LABEL];
      const note = internal ? INTERN + "\n\n" : "";
      for (const fileId of u.files ?? []) {
        if (tasks.length) for (const taskId of tasks) add(async () => taskId, fileId);
        else add(() => createOnce(pid, "brain:" + u.template, { title: clip(PROPOSAL + "Benötigt: " + (u.label || u.template), 200), description: note + (u.warum ? u.warum + "\n\n" : "") + "Entwurf hängt an dieser Aufgabe (Anhänge, zum Herunterladen).\n\n" + PROPOSAL_FOOTER, labels }, ctx), fileId);
      }
    }
    // drafts written by hand → "Unterlagen"
    for (const draft of p.drafts ?? []) {
      if (!draft.manual) continue;
      for (const fileId of draft.files ?? []) add(() => createOnce(pid, "unterlagen", docsWant(), ctx), fileId);
    }
    for (const [resolve, fileId] of pairs) {
      p = state().projects[pid]; if (!p) return;
      const file = (p.files ?? []).find((f) => f.id === fileId);
      if (!file) continue;
      const attached = p.wdTasks?.attached ?? {};
      // known task: skip quickly; a task still to be created is resolved only when the file is not attached anywhere for it yet
      const taskId = await resolve();
      if (!taskId || attached[taskId + ":" + fileId]) continue;
      const bytes = await readDraft(pid, file);
      if (!bytes) continue;
      const created = await call("attach_file", { task_id: taskId, filename: file.name, content_base64: Buffer.from(bytes).toString("base64"), mime: "application/pdf" }, ctx);
      p = state().projects[pid]; if (!p) return;
      p.wdTasks ??= { todo: {} };
      (p.wdTasks.attached ??= {})[taskId + ":" + fileId] = asId(created, "attachment") || "ok";
      ctx.changed = true;
    }
  }


  /**
   * Creates a task once under a stable key (p.wdTasks.points) and never touches it again:
   * whatever is edited, ticked or deleted over there stays so. The same point from a
   * second talk has the same key and is not filed twice.
   */
  async function createOnce(pid, key, want, ctx) {
    let p = state().projects[pid];
    if (!p?.wdId) return "";
    const known = p.wdTasks?.points?.[key];
    if (known) return known;
    const taskId = asId(await call("create_task", { project_id: p.wdId, status: statusOpen, ...want, ...teamArgs(ctx) }, ctx), "task");
    if (!taskId) throw new WdError("create_task answered without an id");
    p = state().projects[pid];
    if (!p) return taskId;
    p.wdTasks ??= { todo: {} };
    (p.wdTasks.points ??= {})[key] = taskId;
    ctx.changed = true;
    return taskId;
  }

  async function filePoints(pid, talkId, ctx) {
    const find = () => state().projects[pid]?.talks?.find((t) => t.id === talkId);
    const talk = find();
    if (!talk?.points) return;
    // the drafts written for a point (attached to its task by attachDrafts)
    const draftsOf = (point) => {
      const files = state().projects[pid]?.files ?? [];
      return (point.docs ?? []).map((id) => files.find((f) => f.id === id)).filter(Boolean).map((f) => ({ name: f.name }));
    };
    const summary = pointsSummaryTask(talk, timeZone, draftsOf);
    const overview = summary ? await createOnce(pid, "talk:" + talkId, summary, ctx) : "";
    for (const kind of ["needed", "next"]) {
      for (const point of talk.points[kind] ?? []) {
        if (!point?.key) continue;
        await createOnce(pid, point.key, pointTask(kind, point, talk, timeZone, draftsOf(point)), ctx);
      }
    }
    const same = find();
    if (!same) return;
    same.wdPoints = overview || "none";
    ctx.changed = true;
  }

  // ---- deletions (queued by the server in state.wdGone) ----------------------
  async function syncGone(ctx) {
    const gone = state().wdGone ?? [];
    while (gone.length) {
      const item = gone[0];
      if (item?.wdId && (item.kind === "project" || item.kind === "customer")) {
        await call(item.kind === "project" ? "update_project" : "update_customer", { id: item.wdId, archived: true }, ctx);
      }
      gone.shift();
      ctx.changed = true;
    }
  }

  async function runJob(key) {
    const ctx = { sent: 0, changed: false };
    try {
      await syncGone(ctx);
      if (key === "all") {
        for (const id of Object.keys(state().customers)) await syncCustomer(id, ctx);
        for (const id of Object.keys(state().projects)) await syncProject(id, ctx);
      } else if (key.startsWith("p:")) {
        await syncProject(key.slice(2), ctx);
      } else if (key.startsWith("c:")) {
        const cid = key.slice(2);
        await syncCustomer(cid, ctx);
        for (const p of Object.values(state().projects)) if (p.customerId === cid) await syncProject(p.id, ctx);
      }
      status.lastSync = Date.now();
      status.lastError = "";
      status.sent += ctx.sent;
      attempts.delete(key);
      return { ok: true, sent: ctx.sent };
    } catch (error) {
      status.lastError = scrub(error?.message ?? String(error));
      status.lastErrorAt = Date.now();
      status.sent += ctx.sent;
      say("work dashboard: sync failed (" + (key === "all" ? "all" : key.slice(0, 1) === "p" ? "project" : "customer") + "): " + status.lastError);
      const n = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, n);
      if (n <= retryMs.length) arm(key, retryMs[n - 1]);
      else { attempts.delete(key); say("work dashboard: giving up until the next change"); }
      return { ok: false, sent: ctx.sent, error: status.lastError };
    } finally {
      if (ctx.changed) await Promise.resolve(persist()).catch(() => undefined);
    }
  }

  function arm(key, ms) {
    clearTimeout(timers.get(key));
    const timer = setTimeout(() => { timers.delete(key); void exclusive(() => runJob(key)); }, ms);
    timer.unref?.();
    timers.set(key, timer);
  }

  // ---- reading back (dashboard → project understanding, read-only) -----------
  /** Ids of the tasks this sync made for a project (their descriptions are Shoot Day's own text). */
  function ownTasks(p) {
    const t = p?.wdTasks ?? {};
    const ids = [t.termin, t.ideen, t.drehvorbereitung, t.lage, t.gespraeche, t.unterlagen, ...Object.values(t.todo ?? {}), ...Object.values(t.points ?? {})];
    return new Set(ids.filter((id) => id !== undefined && id !== null && id !== "").map(String));
  }
  const isLage = (p, task) => sameId(p?.wdTasks?.lage, asId(task)) || String(task?.title ?? "") === TITLE_LAGE;

  /**
   * What people did in the dashboard on a project's tasks: title, status, due date,
   * description and comments. Never Shoot Day's own text again (no feedback loop):
   * "Projektlage (KI)" is left out, of the tasks this sync made only title, status and
   * human comments are kept, and the comments written by the sync (talks, earlier
   * Projektlage) are dropped. Read-only; resolves null on any failure, never throws.
   * @returns {Promise<{ taskId: string, title: string, status: string, due_date: string, description: string, comments: string[] }[] | null>}
   */
  async function readBack(pid) {
    if (!enabled) return null;
    try {
      const p = state().projects[pid];
      if (!p?.wdId) return [];
      const own = ownTasks(p);
      const talkComments = new Set((p.talks ?? []).map((t) => t.wdComment).filter((id) => id !== undefined && id !== null && id !== "" && id !== "ok").map(String));
      const tasks = asList(await client.call("list_tasks", { project_id: p.wdId }), "tasks");
      const out = [];
      for (const task of tasks.slice(0, 200)) {
        const taskId = asId(task);
        if (taskId === "" || isLage(p, task)) continue;
        const comments = asList(await client.call("list_comments", { task_id: taskId }), "comments")
          .filter((c) => !talkComments.has(String(asId(c))))
          .map((c) => String(c?.body ?? c?.text ?? "").trim())
          .filter((body) => body && !body.startsWith("Früherer Stand:") && !body.startsWith("Gespräch ") && !body.startsWith(INTERN))
          .map((body) => clip(body, 1500));
        // a task this sync made and nobody touched yet tells the model nothing new
        // (and would cost one more run right after it was filed)
        if (own.has(String(taskId)) && !comments.length && String(task?.status ?? "") === statusOpen) continue;
        out.push({
          taskId: String(taskId), title: oneLine(task?.title, 200), status: oneLine(task?.status, 40), due_date: oneLine(task?.due_date, 40),
          description: own.has(String(taskId)) ? "" : clip(String(task?.description ?? "").trim(), 3000),
          comments: comments.slice(-30),
        });
      }
      return out;
    } catch (error) {
      say("work dashboard: reading back failed: " + scrub(error?.message ?? String(error)));
      return null;
    }
  }

  /**
   * A cheap fingerprint of a project's tasks (one list_tasks: id, status, due date,
   * updated_at or title) – changes when someone works on them in the dashboard.
   * "Projektlage (KI)" does not count. "" without a dashboard project, null on failure.
   */
  async function fingerprint(pid) {
    if (!enabled) return null;
    try {
      const p = state().projects[pid];
      if (!p?.wdId) return "";
      const tasks = asList(await client.call("list_tasks", { project_id: p.wdId }), "tasks").filter((t) => !isLage(p, t));
      const files = await attachmentPrint(tasks);
      return hash(tasks.map((t) => [String(asId(t)), t?.status ?? "", t?.due_date ?? "", t?.updated_at ?? t?.title ?? "", t?.comment_count ?? t?.comments_count ?? "", files.get(String(asId(t))) ?? ""])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
    } catch (error) {
      say("work dashboard: fingerprint failed: " + scrub(error?.message ?? String(error)));
      return null;
    }
  }

  /**
   * The attachments of each task for the fingerprint (task id → attachment ids), so a file
   * uploaded there is noticed: from a count in the task listing when the dashboard sends one,
   * else one list_attachments per task. A dashboard without attachments: left out, never a failure.
   */
  async function attachmentPrint(tasks) {
    const out = new Map();
    const countOf = (t) => t?.attachment_count ?? t?.attachments_count;
    if (tasks.every((t) => typeof countOf(t) === "number")) {
      for (const t of tasks) out.set(String(asId(t)), String(countOf(t)));
      return out;
    }
    try {
      for (const t of tasks.slice(0, 200)) {
        const taskId = asId(t);
        if (taskId === "") continue;
        const list = asList(await client.call("list_attachments", { task_id: taskId }), "attachments");
        out.set(String(taskId), list.map((a) => String(asId(a))).sort().join(","));
      }
    } catch {
      out.clear();
    }
    return out;
  }

  // ---- appointments of all projects (for the Google Calendar, read-only) ------
  /**
   * Every appointment in the dashboard (one list_tasks without a project, then the
   * projects and customers for the names): [{taskId, title, customer, project, status,
   * labels, starts_at, ends_at, start_date, due_date, location}]. Tasks that are no
   * appointment are left out. null when off or on any failure (then nothing may be
   * taken as deleted); never throws.
   */
  async function events() {
    if (!enabled) return null;
    try {
      const tasks = asList(await client.call("list_tasks", {}), "tasks").filter((t) => asId(t) !== "" && truthy(t?.is_event));
      if (!tasks.length) return [];
      const projects = asList(await client.call("list_projects", {}), "projects");
      const customers = asList(await client.call("list_customers", {}), "customers");
      const text = (v, max) => (v === null || v === undefined ? "" : oneLine(v, max));
      return tasks.map((t) => {
        const project = projects.find((x) => sameId(asId(x), t?.project_id ?? t?.projectId));
        const customer = customers.find((x) => sameId(asId(x), project?.customer_id ?? project?.customerId ?? t?.customer_id));
        return {
          taskId: String(asId(t)), title: text(t.title, 200), customer: text(customer?.name ?? t?.customer_name, 120), project: text(project?.name, 120),
          status: text(t.status, 40), labels: labelNames(t.labels), starts_at: text(t.starts_at, 40), ends_at: text(t.ends_at, 40),
          start_date: text(t.start_date, 40), due_date: text(t.due_date, 40), location: text(t.location, 200),
        };
      });
    } catch (error) { return failed("listing appointments", error); }
  }

  // ---- files people put into the dashboard (read; moving and commenting only on request) ----
  const failed = (what, error) => { say("work dashboard: " + what + " failed: " + scrub(error?.message ?? String(error))); return null; };
  const listAttachments = async (taskId) => asList(await client.call("list_attachments", { task_id: taskId }), "attachments");

  /**
   * The inbox: files dropped into the dashboard without a project.
   * @returns {Promise<{ taskId: string|number, items: object[] } | null>} null when off or on any failure; never throws
   */
  async function inbox() {
    if (!enabled) return null;
    try {
      const value = await client.call("list_inbox", {});
      return { taskId: asId(value?.task_id) || "", items: asList(value, "items").filter((item) => asId(item) !== "") };
    } catch (error) { return failed("inbox", error); }
  }

  /** The bytes of one attachment; null when off or on any failure. */
  async function readAttachment(id) {
    if (!enabled) return null;
    try {
      const value = await client.call("read_attachment", { id });
      const data = value?.content_base64 ?? value?.attachment?.content_base64;
      return typeof data === "string" ? Buffer.from(data, "base64") : null;
    } catch (error) { return failed("reading an attachment", error); }
  }

  /** Moves an attachment to another task; its snapshot (or true), null when off or on any failure. */
  async function moveAttachment(id, taskId) {
    if (!enabled) return null;
    try {
      return (await client.call("move_attachment", { id, task_id: taskId })) ?? true;
    } catch (error) { return failed("moving an attachment", error); }
  }

  /** A comment on a task; its id (or "ok"), null when off or on any failure. */
  async function comment(taskId, body, { silent = false } = {}) {
    if (!enabled) return null;
    try {
      return asId(await client.call("create_comment", { task_id: taskId, body: clip(String(body ?? ""), DESC_MAX), ...(silent ? { silent: true } : {}) }), "comment") || "ok";
    } catch (error) { return failed("commenting", error); }
  }

  /** The open tasks of a project ({id, title}, "Projektlage (KI)" left out); null when off or on any failure. */
  async function openTasks(pid) {
    if (!enabled) return null;
    try {
      const p = state().projects[pid];
      if (!p?.wdId) return [];
      return asList(await client.call("list_tasks", { project_id: p.wdId }), "tasks")
        .filter((t) => asId(t) !== "" && !isLage(p, t) && String(t?.status ?? "") !== statusDone)
        .map((t) => ({ id: asId(t), title: oneLine(t?.title, 200) }));
    } catch (error) { return failed("listing tasks", error); }
  }

  /**
   * Files people uploaded straight to a project's tasks: [{taskId, id, filename, mime, size}].
   * Shoot Day's own uploads (the attachment ids in wdTasks.attached) and drafts
   * ("Entwurf – …") are left out. [] without a dashboard project, null on any failure.
   */
  async function projectAttachments(pid) {
    if (!enabled) return null;
    try {
      const p = state().projects[pid];
      if (!p?.wdId) return [];
      const own = new Set(Object.values(p.wdTasks?.attached ?? {}).map(String));
      const tasks = asList(await client.call("list_tasks", { project_id: p.wdId }), "tasks");
      const out = [];
      for (const task of tasks.slice(0, 200)) {
        const taskId = asId(task);
        if (taskId === "" || isLage(p, task)) continue;
        for (const a of await listAttachments(taskId)) {
          const id = asId(a);
          const filename = String(a?.filename ?? "");
          if (id === "" || own.has(String(id)) || filename.startsWith(DRAFT_PREFIX)) continue;
          out.push({ taskId, id, filename, mime: String(a?.mime ?? ""), size: Number(a?.size) || 0 });
        }
      }
      return out;
    } catch (error) { return failed("listing attachments", error); }
  }

  /** The project's task "Unterlagen" (created once, the same one the hand-written drafts go to); null on any failure. */
  function docsTask(pid) {
    if (!enabled) return Promise.resolve(null);
    return exclusive(async () => {
      const ctx = { sent: 0, changed: false };
      try {
        return (await createOnce(pid, "unterlagen", docsWant(), ctx)) || null;
      } catch (error) {
        return failed("creating \"" + TITLE_DOCS + "\"", error);
      } finally {
        if (ctx.changed) await Promise.resolve(persist()).catch(() => undefined);
      }
    });
  }

  return {
    enabled,
    events,
    readBack,
    fingerprint,
    inbox,
    readAttachment,
    moveAttachment,
    comment,
    openTasks,
    projectAttachments,
    docsTask,
    /** After a save: sync this project (or customer) in `debounceMs`, restarting the wait on every save. Never throws. */
    schedule(target) {
      if (!enabled) return;
      try {
        const key = typeof target === "string" ? "p:" + target : target?.customer ? "c:" + target.customer : target?.project ? "p:" + target.project : "";
        if (!key) return;
        attempts.delete(key);
        arm(key, debounceMs);
      } catch (error) { say("work dashboard: " + (error?.message ?? error)); }
    },
    /** Everything now (POST /api/wd/sync). Resolves {ok, sent, error?}; never rejects. */
    syncAll() {
      if (!enabled) return Promise.resolve({ ok: false, sent: 0, error: "off" });
      clearTimeout(timers.get("all")); timers.delete("all");
      return exclusive(() => runJob("all"));
    },
    /** Waits until queued and running jobs are done (tests, shutdown). */
    async flush() {
      for (const [key, timer] of [...timers]) { clearTimeout(timer); timers.delete(key); void exclusive(() => runJob(key)); }
      await chain;
    },
    status() {
      return {
        enabled,
        lastSync: status.lastSync || null,
        lastError: status.lastError || null,
        pending: timers.size + running + (state().wdGone?.length ?? 0),
      };
    },
    stop() { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); },
  };
}

/**
 * Project understanding: the LOCAL model (SHOOT_LLM_URL, the Spark vLLM) reads
 * everything a project has – customer notes, Babel talks, ideas/to-dos,
 * storyboards, shot list, schedule and the text of every uploaded PDF – and
 * answers with one picture of the project:
 *
 *   lage            a short overview
 *   zusammenhaenge  connections and what follows from them
 *   unterlagen      which paperwork (from the template catalogue) is needed, why,
 *                   from which sources, with facts to fill in
 *   offen           open points
 *   termine         appointment proposals, only when the material explicitly asks for dates
 *                   ("Terminvorschläge Drehtage binnen 48 h"); checked in code (shoot-day-events.mjs):
 *                   max 3, never in the past, weekdays and the customer's closing days enforced
 *
 * Any amount of material: sources longer than DIGEST_OVER are first boiled down
 * to a digest each (cached by content hash, so only new material is read again),
 * and the whole is cut to the model's budget.
 *
 * Nothing is made up: a fact for a template (a name, a place, a date) is only
 * kept when it appears in the material; sources must be real source ids.
 *
 * Customer material never leaves the house – only the configured local model is asked.
 * Dependency-free (Node 18+).
 */
import { createHash } from "node:crypto";
import { chatUrl } from "./shoot-day-pdf.mjs";
import { TEMPLATE_IDS, matchTemplates, templateLabel } from "./shoot-day-docs.mjs";
import { chunkSources } from "./shoot-day-vectors.mjs";
import { cleanEventProposals, dateRequest, isoToday, weekdayName } from "./shoot-day-events.mjs";

export const DIGEST_OVER = 6000;           // longer sources get a digest first
export const BUDGET = 120_000;             // characters of material in one analysis (~35k tokens)
/** Id of the hint from other projects (vector search): experience only, never facts or sources of this project. */
export const HINT_ID = "frueher";
export const HINT_TITLE = "Aus früheren Projekten (nur Hinweis)";
export const FACT_KEYS = Object.freeze(["personen", "praktikant", "schule", "zeitraum", "betreuer", "eigentuemer", "ansprechperson", "termin", "ort", "team"]);

const sha = (text) => createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
const line = (value, max) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
};
const norm = (text) => String(text ?? "").toLowerCase().normalize("NFKC").replace(/[\s.,;:!?„“"'()\-–]+/g, " ").trim();
const stripDate = (text) => String(text ?? "").replace(/^\s*\d{1,2}\.\d{1,2}\.(\d{2,4})?\s*:\s*/, "").trim();

// ---------------------------------------------------------------------------
// The material of a project, as sources with stable ids.
// ---------------------------------------------------------------------------
/**
 * @param {object} project   Shoot Day project
 * @param {object} customer  Shoot Day customer
 * @param {{ id: string, name: string, text: string }[]} pdfs  text of the uploaded PDFs (own drafts left out)
 * @param {{ taskId: string, title: string, status?: string, due_date?: string, description?: string, comments?: string[] }[]} dashboard
 *        the project's tasks read back from the Work Dashboard (shoot-day-wd.mjs readBack; Shoot Day's own text left out)
 * @returns {{ id: string, title: string, text: string }[]}
 */
export function projectSources(project, customer, pdfs = [], dashboard = []) {
  const out = [];
  const add = (id, title, text) => { const t = String(text ?? "").trim(); if (t) out.push({ id, title: line(title, 120), text: t }); };
  add("kunde", "Kunde", [
    customer?.name ? "Name: " + customer.name : "", customer?.company ? "Firma: " + customer.company : "",
    customer?.notes ? "Notizen: " + customer.notes : "",
  ].filter(Boolean).join("\n"));
  const d = project?.dispo ?? {};
  add("projekt", "Projekt", [
    "Projekt: " + (project?.name ?? ""), project?.date ? "Termin: " + project.date : "", project?.place ? "Ort: " + project.place : "",
    d.call ? "Treffpunkt/Call: " + d.call : "", d.location ? "Location: " + d.location : "", d.contact ? "Kontakt vor Ort: " + d.contact : "",
    d.notes ? "Dispo-Notizen: " + d.notes : "",
    ...(d.schedule ?? []).map((r) => "Tagesplan: " + [r.time, r.what].filter(Boolean).join(" ")),
  ].filter(Boolean).join("\n"));
  for (const talk of project?.talks ?? []) {
    add("talk:" + talk.id, "Gespräch " + new Date(Number(talk.at) || 0).toISOString().slice(0, 10), [
      talk.summary, ...(talk.cues ?? []).map((c) => "Tipp-Karte: " + [c.title, c.text].filter(Boolean).join(": ")),
    ].filter(Boolean).join("\n"));
  }
  for (const idea of project?.ideas ?? []) {
    if (idea.done) continue;
    add("idea:" + idea.id, (idea.tags?.includes("todo") ? "To-do: " : "Idee: ") + stripDate(idea.text), idea.text + (idea.tags?.length ? "  #" + idea.tags.join(" #") : ""));
  }
  for (const board of project?.storyboards ?? []) {
    add("board:" + board.id, "Storyboard " + (board.title || ""), (board.scenes ?? []).map((s) =>
      [s.title, s.content, s.camera ? "Kamera: " + s.camera : "", s.overlay ? "Text: " + s.overlay : "", s.goal ? "Ziel: " + s.goal : ""].filter(Boolean).join(" – ")).join("\n"));
  }
  const shots = (project?.scenes ?? []).flatMap((s) => (s.shots ?? []).map((sh) => s.scene + sh.shot + " " + (sh.desc ?? "")));
  add("shotlist", "Shotlist", shots.join("\n"));
  add("skript", "Skript", project?.prompter);
  for (const pdf of pdfs) add("file:" + pdf.id, "Datei " + pdf.name, pdf.text);
  for (const task of Array.isArray(dashboard) ? dashboard : []) {
    if (!task?.taskId || !task.title) continue;
    add("dash:" + task.taskId, "Dashboard: " + task.title, [
      "Aufgabe: " + task.title, task.status ? "Status: " + task.status : "", task.due_date ? "Fällig: " + task.due_date : "",
      task.description ? "Beschreibung: " + task.description : "",
      ...(task.comments ?? []).map((c) => "Kommentar: " + c),
    ].filter(Boolean).join("\n"));
  }
  return out;
}

const sizeOf = (sources) => sources.reduce((n, s) => n + s.text.length + s.title.length + 20, 0);
const withDigests = (sources, digests) => sources.map((s) => (s.text.length > DIGEST_OVER && digests[sha(s.text)] ? { ...s, text: digests[sha(s.text)], digest: true } : s));
const KEEP_WHOLE = new Set(["kunde", "projekt"]);

/** The sections fitSources would rank (everything but customer and project, digests in place). */
export const rankableChunks = (sources, digests = {}) => chunkSources(withDigests(sources, digests).filter((s) => !KEEP_WHOLE.has(s.id)), { overlap: 0 });

/**
 * Over the budget with a `score` (section → number, e.g. likeness to the project
 * description): customer and project stay whole, every source keeps its best
 * section, then the best of the rest until the budget is full. null when the
 * scores do not help (then the plain cutting applies).
 */
function rankedFit(fitted, budget, score) {
  let room = budget - fitted.reduce((n, s) => n + s.title.length + 20 + (KEEP_WHOLE.has(s.id) ? s.text.length : 0), 0);
  if (room <= 0) return null;
  const chunks = chunkSources(fitted.filter((s) => !KEEP_WHOLE.has(s.id)), { overlap: 0 }).map((c, order) => {
    const value = Number(score(c));
    return { ...c, order, score: Number.isFinite(value) ? value : -Infinity };
  });
  if (!chunks.some((c) => c.score > -Infinity)) return null;
  const byScore = [...chunks].sort((a, b) => b.score - a.score || a.order - b.order);
  const chosen = new Set();
  const take = (c) => { if (c.text.length + 3 <= room) { chosen.add(c); room -= c.text.length + 3; } };
  const best = new Map();
  for (const c of byScore) if (!best.has(c.sourceId)) best.set(c.sourceId, c);
  for (const c of best.values()) take(c);
  for (const c of byScore) if (!chosen.has(c)) take(c);
  const out = [];
  for (const s of fitted) {
    if (KEEP_WHOLE.has(s.id)) { out.push(s); continue; }
    const own = chunks.filter((c) => c.sourceId === s.id);
    const kept = own.filter((c) => chosen.has(c));
    if (!kept.length) continue;
    out.push(kept.length === own.length ? s : { ...s, text: kept.map((c) => c.text).join(" … "), excerpt: true });
  }
  return out;
}

/**
 * Sources too long for the budget get their digest (from `digests`, keyed by content hash) instead of the text.
 * Still too much: with `score`, the sections most like the project description are kept; otherwise
 * (or when the scores do not help) the longest sources are cut.
 */
export function fitSources(sources, digests = {}, budget = BUDGET, score = null) {
  const fitted = withDigests(sources, digests);
  let total = sizeOf(fitted);
  if (total > budget && typeof score === "function") {
    const ranked = rankedFit(fitted, budget, score);
    if (ranked) return ranked;
  }
  // still too much: cut the longest ones first, never below 1500 characters
  while (total > budget) {
    const longest = fitted.reduce((a, b) => (b.text.length > a.text.length ? b : a), fitted[0]);
    if (!longest || longest.text.length <= 1500) break;
    const cut = Math.max(1500, longest.text.length - (total - budget));
    total -= longest.text.length - cut;
    longest.text = longest.text.slice(0, cut) + " …";
  }
  return fitted;
}

/** Sources that need a digest first (long, none cached yet). */
export const needsDigest = (sources, digests = {}) => sources.filter((s) => s.text.length > DIGEST_OVER && !digests[sha(s.text)]);
export const digestKey = (source) => sha(source.text);

/** A hash over everything the analysis sees: unchanged → no new run. */
export const materialHash = (sources) => sha(JSON.stringify(sources.filter((s) => s.id !== HINT_ID).map((s) => [s.id, s.text])));

// ---------------------------------------------------------------------------
// Asking the model.
// ---------------------------------------------------------------------------
async function chat(messages, { url, model = "", token = "", timeoutMs = 180_000, fetchImpl = fetch, maxTokens = 3000 }) {
  const endpoint = chatUrl(url);
  if (!endpoint) throw new Error("not-configured");
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: JSON.stringify({ ...(model ? { model } : {}), messages, temperature: 0.1, max_tokens: maxTokens, stream: false, chat_template_kwargs: { enable_thinking: false } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error("http " + response.status);
  const reply = await response.json();
  return String(reply?.choices?.[0]?.message?.content ?? "");
}

/** One long source → a dense digest that keeps names, dates, places, numbers, promises and needs. */
export async function digestSource(source, options) {
  const text = await chat([
    { role: "system", content: "Fasse das Dokument einer Filmproduktion dicht zusammen (höchstens 2500 Zeichen, Deutsch). Behalte ALLE Namen, Firmen, Daten, Uhrzeiten, Orte, Zahlen, Zusagen, Bedingungen, Genehmigungen, Rechte- und Datenschutzthemen und alles, was noch zu tun oder zu besorgen ist. Nichts erfinden. Nur die Zusammenfassung." },
    { role: "user", content: source.title + "\n\n" + source.text.slice(0, 60_000) },
  ], { ...options, maxTokens: 1500 });
  return line(text, 3000);
}

const catalogue = () => TEMPLATE_IDS.map((id) => `- ${id}: ${templateLabel(id)}`).join("\n");

export function analysisMessages(sources, { today = new Date(), tz } = {}) {
  const day = isoToday(today, tz);
  const asksForDates = Boolean(dateRequest(sources.filter((s) => s.id !== HINT_ID).map((s) => s.text).join("\n")));
  const system = "Du bist die Projektassistenz einer Filmproduktion in Österreich. Du bekommst ALLES Material eines Projekts als Quellen "
    + "mit Kennung in eckigen Klammern. Verstehe das Projekt als Ganzes und erkenne Zusammenhänge zwischen den Quellen "
    + "(z. B. Drohne über Gastgarten → Gäste im Bild → Hinweisschild und Einverständnis nötig).\n"
    + "Antworte NUR mit JSON, ohne Erklärung:\n"
    + "{\"lage\":\"3–6 Sätze Überblick\",\"zusammenhaenge\":[\"…\"],"
    + "\"unterlagen\":[{\"vorlage\":\"<id aus dem Katalog>\",\"warum\":\"ein Satz\",\"quellen\":[\"<Kennung>\"],"
    + "\"angaben\":{\"zweck\":\"2–4 Sätze, was gedreht wird, wofür, wo, wann\",\"personen\":\"\",\"praktikant\":\"\",\"schule\":\"\",\"zeitraum\":\"\",\"betreuer\":\"\",\"eigentuemer\":\"\",\"ansprechperson\":\"\",\"termin\":\"\",\"ort\":\"\",\"team\":\"\"}}],"
    + "\"offen\":[\"…\"],"
    + "\"termine\":[{\"titel\":\"…\",\"datum\":\"YYYY-MM-DD\",\"von\":\"HH:MM\",\"bis\":\"HH:MM\",\"ort\":\"\",\"grund\":\"ein Satz\",\"quellen\":[\"<Kennung>\"]}]}\n"
    + "Unterlagen-Katalog (nur diese ids, jede höchstens einmal, nur wenn das Material sie wirklich nahelegt):\n" + catalogue() + "\n"
    + "quellen = die Kennungen, aus denen du die Unterlage ableitest – auch To-dos, zu denen sie gehört. "
    + "Was mit (INTERN) markiert ist, ist eine interne Unterlage und geht NIE an den Kunden; will der Kunde etwas über das Team "
    + "oder Praktikanten wissen, nimm dafür teambestaetigung. "
    + "zweck: ohne Daten/Uhrzeiten und ohne den internen Projektnamen. "
    + "angaben: nur wörtlich aus dem Material übernehmen, sonst leer lassen; nichts erfinden. Heute ist " + weekdayName(day) + ", " + day + "."
    + (asksForDates
      ? "\ntermine: NUR weil das Material ausdrücklich nach Terminen fragt (z. B. Terminvorschläge für Drehtage): höchstens 3 Vorschläge, "
        + "nie in der Vergangenheit, der Wochentag muss stimmen, Ruhetage und Wünsche aus den Kundennotizen beachten; "
        + "von/bis leer lassen, wenn keine Uhrzeit gefragt ist; grund = warum dieser Termin passt."
      : "\ntermine: [] – das Material fragt nicht nach Terminen.")
    + (sources.some((s) => s.id.startsWith("dash:"))
      ? "\nQuellen [dash:…] sind Aufgaben aus dem Work Dashboard des Teams: Status „done“ heißt erledigt – so etwas nicht mehr als offen oder benötigt führen."
      : "")
    + (sources.some((s) => s.id === HINT_ID)
      ? "\nDie Quelle [" + HINT_ID + "] stammt aus ANDEREN, früheren Projekten: nur als Erfahrung nutzen (woran man denken sollte), "
        + "nie als Fakten dieses Projekts, nie als quellen nennen, keine angaben daraus übernehmen."
      : "");
  const body = sources.map((s) => `[${s.id}] ${s.title}${s.digest ? " (Zusammenfassung)" : s.excerpt ? " (Auszug)" : ""}\n${s.text}`).join("\n\n");
  return [{ role: "system", content: system }, { role: "user", content: body }];
}

function parseJson(content) {
  const text = String(content ?? "").replace(/```(?:json)?/gi, "").trim();
  const from = text.indexOf("{"); const to = text.lastIndexOf("}");
  if (from < 0 || to <= from) return null;
  try { return JSON.parse(text.slice(from, to + 1)); } catch { return null; }
}

/**
 * The model's answer → a checked picture. Unknown templates and sources are dropped,
 * the same template twice is merged, facts not found in the material are emptied.
 */
/**
 * A source as the model names it → its id. Models write "[idea:i_…]", "idea:i_… To-do: …" or
 * just the title once there is a lot of material; all of these are accepted, nothing else.
 */
export function resolveSource(raw, sources) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const ids = new Set(sources.map((s) => s.id));
  if (ids.has(text)) return text;
  const found = /(?:idea|talk|board|file|dash):[A-Za-z0-9_-]+|\b(?:kunde|projekt|shotlist|skript)\b/i.exec(text)?.[0] ?? "";
  const token = found.includes(":") ? found : found.toLowerCase();
  if (token && ids.has(token)) return token;
  const wanted = norm(text.replace(/^\[|\]$/g, ""));
  if (wanted.length < 6) return "";
  const hit = sources.find((s) => norm(s.title) === wanted)
    ?? sources.find((s) => norm(s.title).includes(wanted) || wanted.includes(norm(s.title)));
  return hit?.id ?? "";
}

export function cleanAnalysis(raw, sources, { today = new Date(), tz } = {}) {
  if (!raw || typeof raw !== "object") return null;
  // only the project's own material counts – never the hint from other projects
  const own = sources.filter((s) => s.id !== HINT_ID);
  const ids = new Set(own.map((s) => s.id));
  const haystack = norm(own.map((s) => s.title + " " + s.text).join(" "));
  const list = (value, max, n) => (Array.isArray(value) ? value : []).map((x) => line(x, max)).filter(Boolean).slice(0, n);
  const byTemplate = new Map();
  for (const u of Array.isArray(raw.unterlagen) ? raw.unterlagen : []) {
    const template = String(u?.vorlage ?? "").trim();
    if (!TEMPLATE_IDS.includes(template)) continue;
    const quellen = [...new Set((Array.isArray(u.quellen) ? u.quellen : []).map((q) => resolveSource(q, own)).filter(Boolean))];
    const angaben = {};
    const zweck = line(u?.angaben?.zweck, 700);
    if (zweck.length >= 20 && !/[{}[\]<>]|_{3,}/.test(zweck)) angaben.zweck = zweck;
    for (const key of FACT_KEYS) {
      const value = line(u?.angaben?.[key], 160);
      if (value && haystack.includes(norm(value))) angaben[key] = value;   // only what is really in the material
    }
    const known = byTemplate.get(template);
    if (known) {
      known.quellen = [...new Set([...known.quellen, ...quellen])];
      known.angaben = { ...angaben, ...known.angaben };
    } else {
      byTemplate.set(template, { template, warum: line(u?.warum, 300), quellen, angaben });
    }
  }
  const internship = byTemplate.get("praktikum");
  if (internship && !byTemplate.has("teambestaetigung")) {
    byTemplate.set("teambestaetigung", { template: "teambestaetigung", warum: "Für den Kunden statt des internen Praktikumsvertrags (ohne persönliche Daten).",
      quellen: [...internship.quellen], angaben: Object.fromEntries(Object.entries(internship.angaben).filter(([k]) => ["schule", "betreuer", "zweck"].includes(k))) });
  }
  const lage = line(raw.lage, 1500);
  const termine = cleanEventProposals(raw.termine, {
    material: own.map((s) => s.text).join("\n"),
    notes: own.find((s) => s.id === "kunde")?.text ?? "",
    today: isoToday(today, tz),
    resolve: (q) => resolveSource(q, own),
  });
  if (!lage && !byTemplate.size && !termine.length) return null;
  return {
    lage,
    zusammenhaenge: list(raw.zusammenhaenge, 300, 15),
    unterlagen: [...byTemplate.values()],
    offen: list(raw.offen, 300, 20),
    termine,
  };
}

/**
 * Without a model (or when it fails): paperwork from the words of open to-dos and of
 * the "needed" points of talks – no overview, no connections.
 */
export function fallbackAnalysis(project) {
  const byTemplate = new Map();
  const note = (template, source) => {
    const u = byTemplate.get(template) ?? { template, warum: "aus dem Wortlaut erkannt", quellen: [], angaben: {} };
    if (!u.quellen.includes(source)) u.quellen.push(source);
    byTemplate.set(template, u);
  };
  for (const idea of project?.ideas ?? []) {
    if (idea.done || !idea.tags?.includes("todo")) continue;
    for (const t of matchTemplates(stripDate(idea.text))) note(t, "idea:" + idea.id);
  }
  for (const talk of project?.talks ?? []) {
    for (const point of talk.points?.needed ?? []) for (const t of matchTemplates(point.text)) note(t, "talk:" + talk.id);
  }
  return { lage: "", zusammenhaenge: [], unterlagen: [...byTemplate.values()], offen: [], termine: [], fallback: true };
}

/**
 * The whole run: digests for new long sources, then the analysis.
 * `hints`: extra sources for the prompt only (the hint from other projects) – never
 * digested, cut or used for facts. `rank`: async (sections) → Map hash → score, used
 * when the material is over the budget (null/failure → plain cutting).
 * @returns {Promise<{ ok: true, analysis: object, digests: object } | { ok: false, error: string, digests: object }>}
 */
export async function analyseProject(sources, { digests = {}, hints = [], rank = null, ...options } = {}) {
  const next = { ...digests };
  try {
    for (const source of needsDigest(sources, next)) next[digestKey(source)] = await digestSource(source, options);
    // keep only digests of material that still exists
    const live = new Set(sources.map(digestKey));
    for (const key of Object.keys(next)) if (!live.has(key)) delete next[key];
    let scores = null;
    if (typeof rank === "function" && sizeOf(withDigests(sources, next)) > BUDGET) {
      try { scores = await rank(rankableChunks(sources, next)); } catch { scores = null; }
    }
    const fitted = fitSources(sources, next, BUDGET, scores instanceof Map ? (c) => scores.get(c.hash) : null);
    const extra = (Array.isArray(hints) ? hints : []).filter((h) => h?.id === HINT_ID && String(h.text ?? "").trim());
    const content = await chat(analysisMessages([...fitted, ...extra], options), options);
    const analysis = cleanAnalysis(parseJson(content), sources, options);
    if (!analysis) return { ok: false, error: "unreadable", digests: next };
    return { ok: true, analysis, digests: next };
  } catch (error) {
    return { ok: false, error: error?.name === "TimeoutError" ? "timeout" : String(error?.message ?? error).slice(0, 60), digests: next };
  }
}

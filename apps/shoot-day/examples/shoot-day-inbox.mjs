/**
 * The inbox: files somebody dropped into the Work Dashboard without saying where
 * they belong. The LOCAL model (SHOOT_LLM_URL) reads the file name and the start
 * of the text (PDF; pictures only by name) together with every candidate – the
 * Shoot Day projects that have a dashboard project, with customer, date, open
 * tasks, files and storyboards – and answers with one JSON object:
 *
 *   {"project": "<Shoot Day project id>"|null, "task": <dashboard task id>|null,
 *    "art": "storyboard|vertrag|angebot|rechnung|foto|unterlage|sonstiges",
 *    "ersetzt": "<existing file name or storyboard title>"|null,
 *    "sicher": 0..1, "grund": "one sentence"}
 *
 * Nothing the model names is taken on trust: project, task and "ersetzt" must
 * exist among the candidates (else null), "sicher" is kept within 0..1. What
 * happens with the answer (assign, move, comment) is the server's business.
 *
 * Customer material never leaves the house – only the configured local model is asked.
 * Dependency-free (Node 18+).
 */
import { chatUrl } from "./shoot-day-pdf.mjs";

export const ARTS = Object.freeze(["storyboard", "vertrag", "angebot", "rechnung", "foto", "unterlage", "sonstiges"]);
/** Characters of the file's text the model sees. */
export const TEXT_MAX = 6000;
const MAX_TASKS = 30;
const MAX_NAMES = 30;

const line = (value, max) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
};
const key = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const noExt = (name) => String(name ?? "").replace(/\.(pdf|png|jpe?g)$/i, "");

/**
 * @typedef {{ id: string, name: string, customer: string, date?: string,
 *   tasks?: { id: string|number, title: string }[], files?: string[], storyboards?: string[] }} Candidate
 */

/**
 * The prompt. `project` (a candidate id) when the project is already known: then
 * only "art" and "ersetzt" are asked for. `hints`: names of the projects most like
 * the text (vector search), only a hint.
 * @param {{ file: { name: string, mime?: string }, text?: string, candidates: Candidate[], hints?: string[], project?: string }} input
 */
export function classifyMessages({ file, text = "", candidates = [], hints = [], project = "" }) {
  const fixed = project ? candidates.find((c) => c.id === project) : null;
  const system = "Du ordnest eine Datei einer Filmproduktion einem Projekt zu. Antworte NUR mit JSON, ohne Erklärung: "
    + "{\"project\":\"<id>\",\"task\":<id>,\"art\":\"…\",\"ersetzt\":\"…\",\"sicher\":0.0,\"grund\":\"…\"}. "
    + "project = id eines Projekts aus der Liste oder null, wenn keins klar passt. "
    + "task = id einer offenen Aufgabe DIESES Projekts, zu der die Datei gehört, sonst null. "
    + "art = eine von " + ARTS.join("|") + ". "
    + "ersetzt = genau ein vorhandener Dateiname oder Storyboard-Titel dieses Projekts, wenn die Datei eine neue Fassung davon ist, sonst null. "
    + "sicher = wie sicher die Zuordnung ist, Zahl von 0 bis 1; im Zweifel niedrig. grund = ein kurzer Satz auf Deutsch. "
    + "Verwende nur ids und Namen aus der Liste, erfinde nichts.";
  const list = (fixed ? [fixed] : candidates).map((c) => [
    "- id: " + c.id + " | Kunde: " + line(c.customer, 80) + " | Projekt: " + line(c.name, 80) + (c.date ? " | Termin: " + line(c.date, 40) : ""),
    (c.tasks ?? []).length ? "  Offene Aufgaben: " + c.tasks.slice(0, MAX_TASKS).map((t) => "[" + t.id + "] " + line(t.title, 80)).join("; ") : "",
    (c.files ?? []).length ? "  Dateien: " + c.files.slice(0, MAX_NAMES).map((n) => line(n, 100)).join("; ") : "",
    (c.storyboards ?? []).length ? "  Storyboards: " + c.storyboards.slice(0, MAX_NAMES).map((n) => line(n, 100)).join("; ") : "",
  ].filter(Boolean).join("\n")).join("\n");
  const body = String(text ?? "").trim();
  const user = [
    "Datei: " + line(file?.name, 200) + (file?.mime ? " (" + line(file.mime, 60) + ")" : ""),
    "",
    body ? "Textanfang:\n" + body.slice(0, TEXT_MAX) : "(kein Text – Bild oder Scan, nur der Dateiname)",
    "",
    ...(fixed ? ["Das Projekt steht fest: " + fixed.id + ". Bestimme art, task und ersetzt.", ""] : []),
    ...(!fixed && hints.length ? ["Ähnlichste Projekte laut Suche (nur ein Hinweis):\n" + hints.map((h) => "- " + line(h, 160)).join("\n"), ""] : []),
    "Projekte:",
    list || "(keine)",
  ].join("\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

/** The first JSON object in a reply (code fences and chatter around it are fine); null when there is none. */
function jsonObject(content) {
  const text = String(content ?? "").replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** 0..1; "85" or 85 (a percentage) → 0.85; anything else → 0. */
export function clampSure(raw) {
  let n = typeof raw === "string" ? Number(raw.replace("%", "").replace(",", ".").trim()) : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 1 && n <= 100) n /= 100;
  return Math.min(1, Math.round(n * 1000) / 1000);
}

const isNull = (value) => value === null || value === undefined || value === "" || String(value).toLowerCase() === "null";

/**
 * The model's reply → a checked classification, or null when it is not readable.
 * Project, task and "ersetzt" that are not among the candidates become null; the
 * task must belong to the project; "ersetzt" comes back spelled as in the candidates.
 * With `project` (already known) that candidate is taken whatever the model says.
 * @param {string} content
 * @param {Candidate[]} candidates
 * @param {{ project?: string }} [options]
 * @returns {{ project: string|null, task: string|number|null, art: string, ersetzt: string|null, sicher: number, grund: string } | null}
 */
export function parseClassification(content, candidates = [], { project: known = "" } = {}) {
  const raw = jsonObject(content);
  if (!raw) return null;
  const fixed = known ? candidates.find((c) => c.id === known) ?? null : null;
  const project = fixed ?? (isNull(raw.project) ? null : candidates.find((c) => String(c.id) === String(raw.project).trim()) ?? null);
  const task = project && !isNull(raw.task) ? (project.tasks ?? []).find((t) => String(t.id) === String(raw.task).trim()) ?? null : null;
  let ersetzt = null;
  if (project && !isNull(raw.ersetzt)) {
    const wanted = key(raw.ersetzt);
    const names = [...(project.storyboards ?? []), ...(project.files ?? [])];
    ersetzt = names.find((n) => key(n) === wanted) ?? names.find((n) => key(noExt(n)) === key(noExt(raw.ersetzt))) ?? null;
  }
  const art = ARTS.includes(key(raw.art)) ? key(raw.art) : "sonstiges";
  return {
    project: project ? project.id : null,
    task: task ? task.id : null,
    art,
    ersetzt,
    sicher: clampSure(raw.sicher),
    grund: line(raw.grund, 300),
  };
}

/**
 * Asks the local model. Never throws.
 * @returns {Promise<{ ok: true, result: ReturnType<typeof parseClassification> & object } | { ok: false, error: string }>}
 */
export async function classifyFile(input, { url, model = "", token = "", timeoutMs = 120_000, fetchImpl = fetch } = {}) {
  const endpoint = chatUrl(url);
  if (!endpoint) return { ok: false, error: "not-configured" };
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: JSON.stringify({
        ...(model ? { model } : {}), messages: classifyMessages(input), temperature: 0.1, max_tokens: 600, stream: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, error: "http " + response.status };
    const reply = await response.json();
    const result = parseClassification(reply?.choices?.[0]?.message?.content ?? "", input.candidates ?? [], { project: input.project ?? "" });
    return result ? { ok: true, result } : { ok: false, error: "unreadable" };
  } catch (error) {
    return { ok: false, error: error?.name === "TimeoutError" ? "timeout" : "unreachable" };
  }
}

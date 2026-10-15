/**
 * What a customer conversation leaves behind: asks a LOCAL OpenAI-compatible
 * model (SHOOT_LLM_URL, the Spark vLLM) for four lists, derived from a Babel
 * talk (summary + cue cards):
 *
 *   needed     what still has to be organised (material, permits, people, locations)
 *   questions  open questions to the customer
 *   promises   who promised what, by when
 *   next       next steps, with a date where one was said
 *
 * Customer conversations never leave the house: only the configured local
 * model is asked, nothing else. Every point gets a stable key from its kind
 * and wording, so the same point from two conversations is filed only once.
 *
 * Dependency-free (Node 18+).
 */
import { createHash } from "node:crypto";
import { chatUrl } from "./shoot-day-pdf.mjs";

export const POINT_KINDS = Object.freeze(["needed", "questions", "promises", "next"]);
const MAX_PER_KIND = 12;
const TEXT_MAX = 200;
const PROMPT_MAX = 12_000;

const line = (value, max = TEXT_MAX) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
};

/** "2026-10-20", "20.10.2026", "20.10." (+ year of `now`) → "2026-10-20"; else "". */
export function pointDate(value, now = new Date()) {
  const s = String(value ?? "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  let y, mo, d;
  if (m) [, y, mo, d] = m.map(Number);
  else if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})?$/.exec(s))) {
    d = Number(m[1]); mo = Number(m[2]);
    y = m[3] ? Number(m[3].length === 2 ? "20" + m[3] : m[3]) : now.getFullYear();
  } else return "";
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return "";
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Same kind + same words (any case, spacing, trailing dot) → same key. */
export function pointKey(kind, text) {
  const norm = String(text ?? "").toLowerCase().replace(/[\s.,;:!?„“"'()-]+/g, " ").trim();
  return kind + ":" + createHash("sha256").update(norm).digest("hex").slice(0, 12);
}

function cleanPoint(kind, raw) {
  const text = line(typeof raw === "string" ? raw : raw?.text ?? raw?.what);
  if (!text) return null;
  const point = { key: pointKey(kind, text), text };
  if (kind === "promises") {
    const who = line(raw?.who, 60);
    if (who) point.who = who;
  }
  if (kind === "promises" || kind === "next") {
    const due = pointDate(raw?.due);
    if (due) point.due = due;
  }
  // drafts written for this point (shoot-day-docs.mjs): ids of project files, set by the server only
  if (kind === "needed" && Array.isArray(raw?.docs)) {
    const docs = raw.docs.filter((id) => typeof id === "string" && /^f_[0-9a-f]{12}$/.test(id)).slice(0, 5);
    if (docs.length) point.docs = docs;
  }
  return point;
}

/** Any model output → {needed:[], questions:[], promises:[], next:[]} without duplicates; null if there is no such object. */
export function cleanPoints(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const kind of POINT_KINDS) {
    const seen = new Set();
    out[kind] = (Array.isArray(raw[kind]) ? raw[kind] : [])
      .map((item) => cleanPoint(kind, item))
      .filter((p) => p && !seen.has(p.key) && seen.add(p.key))
      .slice(0, MAX_PER_KIND);
  }
  return out;
}

export const pointCount = (points) => POINT_KINDS.reduce((n, kind) => n + (points?.[kind]?.length ?? 0), 0);

/** The model's reply → points. Accepts code fences and chatter around the JSON object. */
export function parsePointsReply(content) {
  const text = String(content ?? "").replace(/```(?:json)?/gi, "").trim();
  const from = text.indexOf("{");
  const to = text.lastIndexOf("}");
  if (from < 0 || to <= from) return null;
  try {
    return cleanPoints(JSON.parse(text.slice(from, to + 1)));
  } catch {
    return null;
  }
}

export function talkPointsMessages(talk, { today = new Date() } = {}) {
  const cues = Array.isArray(talk?.cues) ? talk.cues : [];
  const body = [
    "Zusammenfassung:", String(talk?.summary ?? "").trim() || "(keine)",
    ...(cues.length ? ["", "Tipp-Karten:", ...cues.map((c) => "- " + [c.title, c.text].filter(Boolean).join(": "))] : []),
  ].join("\n").slice(0, PROMPT_MAX);
  const system = "Du liest die Notizen zu einem Kundengespräch einer Filmproduktion und ziehst heraus, was offen ist. "
    + "Antworte NUR mit JSON, ohne Erklärung: "
    + "{\"needed\":[\"…\"],\"questions\":[\"…\"],\"promises\":[{\"who\":\"…\",\"text\":\"…\",\"due\":\"JJJJ-MM-TT oder leer\"}],"
    + "\"next\":[{\"text\":\"…\",\"due\":\"JJJJ-MM-TT oder leer\"}]}. "
    + "needed = was noch besorgt/organisiert werden muss (Material, Genehmigungen, Personen, Drehorte); "
    + "questions = offene Fragen an den Kunden; promises = Zusagen (wer hat was versprochen, bis wann); "
    + "next = nächste Schritte. Jeder Punkt kurz (höchstens ein Satz). Nur was in den Notizen steht, nichts erfinden; "
    + "steht nichts dazu da, leere Liste. Datum nur, wenn es genannt wurde (heute ist " + today.toISOString().slice(0, 10) + ").";
  return [{ role: "system", content: system }, { role: "user", content: body }];
}

/**
 * Asks the local model. Never throws.
 * @returns {Promise<{ ok: true, points: object } | { ok: false, error: string }>}
 */
export async function extractTalkPoints(talk, { url, model = "", token = "", timeoutMs = 120_000, fetchImpl = fetch, today } = {}) {
  const endpoint = chatUrl(url);
  if (!endpoint) return { ok: false, error: "not-configured" };
  const body = {
    ...(model ? { model } : {}),
    messages: talkPointsMessages(talk, { today }),
    temperature: 0.1,
    max_tokens: 2000,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, error: "http " + response.status };
    const reply = await response.json();
    const points = parsePointsReply(reply?.choices?.[0]?.message?.content ?? "");
    if (!points) return { ok: false, error: "unreadable" };
    return { ok: true, points };
  } catch (error) {
    return { ok: false, error: error?.name === "TimeoutError" ? "timeout" : "unreachable" };
  }
}

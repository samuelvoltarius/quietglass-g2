/**
 * Vector search over every customer and project: the material of a project (the
 * sources of shoot-day-brain.mjs) is cut into sections of about 1200 characters,
 * every section is embedded once by the configured OpenAI-compatible embedding
 * service (SHOOT_EMBED_URL, `POST …/v1/embeddings`) and kept in Shoot Day's own
 * vector file next to DATA_FILE.
 *
 *   chunkText / chunkSources   sections at paragraph and sentence borders, small overlap
 *   createVectorIndex          the file, incremental embedding, cosine search
 *
 * Incremental: a section is known by the hash of its text, so only new sections
 * are embedded (in batches); sections that vanished are dropped. A failing service
 * never throws and never deletes anything – the next run tries again.
 *
 * Customer material only goes to the configured service and only into this file.
 * Dependency-free (Node 18+).
 */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

export const CHUNK_SIZE = 1200;
export const CHUNK_OVERLAP = 150;
export const BATCH = 32;
const KEEP_TEXT = 1600;            // characters of a section kept in the file (snippets, hints)
const FILE_VERSION = 1;

const sha = (text) => createHash("sha256").update(String(text)).digest("hex").slice(0, 16);

// ---------------------------------------------------------------------------
// Sections.
// ---------------------------------------------------------------------------
/** A piece longer than `size` → sentences → words, each at most `size` long. */
function splitLong(text, size) {
  if (text.length <= size) return [text];
  const out = [];
  for (const sentence of text.split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter(Boolean)) {
    if (sentence.length <= size) { out.push(sentence); continue; }
    let rest = sentence;
    while (rest.length > size) {
      let cut = rest.lastIndexOf(" ", size);
      if (cut < size / 2) cut = size;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

/** The end of a section to repeat at the start of the next one: from a sentence or word border. */
function tail(text, overlap) {
  if (overlap <= 0 || !text) return "";
  if (text.length <= overlap) return text;
  const end = text.slice(-overlap);
  const sentence = end.search(/(?<=[.!?…])\s+\S/);
  if (sentence >= 0) return end.slice(sentence).trim();
  const space = end.indexOf(" ");
  return space >= 0 ? end.slice(space + 1).trim() : end;
}

/**
 * Cuts a text into sections of about `size` characters at paragraph, line and
 * sentence borders; each section starts with the end of the one before (`overlap`).
 * @returns {string[]}
 */
export function chunkText(text, { size = CHUNK_SIZE, overlap = CHUNK_OVERLAP } = {}) {
  const clean = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const units = [];   // [separator before, piece]
  for (const paragraph of clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    splitLong(paragraph, size).forEach((piece, i) => units.push([i === 0 ? "\n\n" : " ", piece]));
  }
  const out = [];
  let current = "";
  let fresh = true;   // nothing but the overlap in `current` yet
  for (const [separator, piece] of units) {
    if (current && !fresh && current.length + separator.length + piece.length > size) {
      out.push(current);
      current = tail(current, overlap);
      fresh = true;
    }
    current = current ? current + (fresh && current ? " " : separator) + piece : piece;
    fresh = false;
  }
  if (current && !fresh) out.push(current);
  return out;
}

/** The sections of every source, each with the hash of what is embedded (title + text). */
export function chunkSources(sources, options = {}) {
  const out = [];
  for (const source of sources ?? []) {
    const title = String(source?.title ?? "");
    chunkText(source?.text, options).forEach((text, part) => {
      out.push({ sourceId: String(source.id), title, text, part, hash: sha(title + "\n" + text) });
    });
  }
  return out;
}
const embedInput = (chunk) => (chunk.title ? chunk.title + "\n" + chunk.text : chunk.text);

// ---------------------------------------------------------------------------
// Vectors: compact Float32 as base64, always normalised (dot product = cosine).
// ---------------------------------------------------------------------------
export function normalise(values) {
  const v = Float32Array.from(values, Number);
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const length = Math.sqrt(sum);
  if (!(length > 0) || !Number.isFinite(length)) return null;
  for (let i = 0; i < v.length; i++) v[i] /= length;
  return v;
}
export const encodeVector = (vector) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");
export function decodeVector(text) {
  const bytes = Buffer.from(String(text ?? ""), "base64");
  if (!bytes.length || bytes.length % 4) return null;
  const out = new Float32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = bytes.readFloatLE(i * 4);
  return out;
}
export function dot(a, b) {
  if (!a || !b || a.length !== b.length) return -Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
/** The normalised mean of several vectors (one direction for a whole project); null for none. */
export function centroid(vectors) {
  const list = vectors.filter(Boolean);
  if (!list.length) return null;
  const sum = new Float32Array(list[0].length);
  for (const v of list) if (v.length === sum.length) for (let i = 0; i < v.length; i++) sum[i] += v[i];
  return normalise(sum);
}

/** `…/v1/embeddings` from a base URL, `…/v1` or the full endpoint; "" when not configured. */
export function embedUrl(url) {
  const base = String(url ?? "").trim().replace(/\/+$/, "");
  if (!base) return "";
  if (/\/embeddings$/.test(base)) return base;
  if (/\/v1$/.test(base)) return base + "/embeddings";
  return base + "/v1/embeddings";
}

/**
 * Top-k of `entries` for a query vector. Filters: `projects` / `customers` (only
 * these ids), `exceptProjects` (everything but these), `minScore`.
 */
export function searchEntries(entries, vector, { limit = 8, projects = null, customers = null, exceptProjects = null, minScore = -Infinity } = {}) {
  if (!vector) return [];
  const onlyProjects = projects ? new Set(projects) : null;
  const onlyCustomers = customers ? new Set(customers) : null;
  const except = exceptProjects ? new Set(exceptProjects) : null;
  const hits = [];
  for (const entry of entries) {
    if (onlyProjects && !onlyProjects.has(entry.projectId)) continue;
    if (onlyCustomers && !onlyCustomers.has(entry.customerId)) continue;
    if (except && except.has(entry.projectId)) continue;
    const score = dot(vector, entry.vector);
    if (score >= minScore) hits.push({ entry, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------------------
// The index.
// ---------------------------------------------------------------------------
/**
 * @param {{ file: string, url?: string, model?: string, token?: string, timeoutMs?: number,
 *           batch?: number, fetchImpl?: typeof fetch, log?: (line: string) => void }} options
 */
export function createVectorIndex({ file, url = "", model = "", token = "", timeoutMs = 60_000, batch = BATCH, fetchImpl = fetch, log = () => undefined } = {}) {
  const endpoint = embedUrl(url);
  /** @type {Map<string, { projectId, customerId, sourceId, title, text, hash, vector: Float32Array }[]>} */
  const byProject = new Map();
  let loading = null;
  let writing = Promise.resolve();
  let queue = Promise.resolve();
  let lastError = null;

  /** One request to the service: texts → normalised vectors (same order). Throws on any failure. */
  async function embed(texts) {
    if (!endpoint) throw new Error("not-configured");
    const out = [];
    for (let i = 0; i < texts.length; i += batch) {
      const input = texts.slice(i, i + batch);
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
        body: JSON.stringify({ ...(model ? { model } : {}), input }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error("http " + response.status);
      const reply = await response.json();
      const data = Array.isArray(reply?.data) ? reply.data : [];
      if (data.length !== input.length) throw new Error("wrong answer");
      const ordered = [...data].sort((a, b) => Number(a?.index ?? 0) - Number(b?.index ?? 0));
      for (const item of ordered) {
        const vector = Array.isArray(item?.embedding) ? normalise(item.embedding) : null;
        if (!vector) throw new Error("wrong answer");
        out.push(vector);
      }
    }
    return out;
  }
  const reason = (error) => (error?.name === "TimeoutError" ? "timeout" : String(error?.message ?? error).slice(0, 60));

  /** Reads the file once; every caller waits for the same read. */
  function load() {
    loading ??= read();
    return loading;
  }
  async function read() {
    if (!file || !existsSync(file)) return;
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      // vectors of another model cannot be compared: start again
      if (raw?.version !== FILE_VERSION || String(raw?.model ?? "") !== model) { log("vectors: other model in " + file + ", building the index again"); return; }
      for (const e of Array.isArray(raw.entries) ? raw.entries : []) {
        const vector = decodeVector(e?.v);
        if (!vector || typeof e.projectId !== "string" || typeof e.hash !== "string") continue;
        const entry = { projectId: e.projectId, customerId: String(e.customerId ?? ""), sourceId: String(e.sourceId ?? ""), title: String(e.title ?? ""), text: String(e.text ?? ""), hash: e.hash, vector };
        if (!byProject.has(entry.projectId)) byProject.set(entry.projectId, []);
        byProject.get(entry.projectId).push(entry);
      }
    } catch (error) {
      log("vectors: could not read " + file + " (" + error.message + "), building the index again");
    }
  }

  /** Temporary file, fsync, rename – like the data file. Writes run one after another. */
  function save() {
    writing = writing.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const entries = [...byProject.values()].flat().map((e) => ({
        projectId: e.projectId, customerId: e.customerId, sourceId: e.sourceId, title: e.title, text: e.text, hash: e.hash, v: encodeVector(e.vector),
      }));
      const temporary = file + ".tmp-" + process.pid;
      const handle = await open(temporary, "w");
      try {
        await handle.writeFile(JSON.stringify({ version: FILE_VERSION, model, entries }), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Windows refuses the rename while another process reads the file: try again shortly
      for (let attempt = 1; ; attempt++) {
        try { await rename(temporary, file); break; } catch (error) {
          if (attempt >= 8 || !["EPERM", "EBUSY", "EACCES"].includes(error?.code)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
        }
      }
    }).catch((error) => log("vectors: could not save: " + error.message));
    return writing;
  }

  /** Every known vector by hash (the same section in two projects is embedded once). */
  const knownVectors = () => {
    const known = new Map();
    for (const list of byProject.values()) for (const e of list) known.set(e.hash, e.vector);
    return known;
  };

  /**
   * Brings one project up to date with its sources: new sections are embedded,
   * vanished ones dropped. Never throws; on a failure nothing is removed.
   * `alive()`: asked again just before the index changes – a project deleted meanwhile is dropped instead.
   * @returns {Promise<{ ok: boolean, added: number, removed: number, error?: string }>}
   */
  function syncProject(projectId, customerId, sources, { alive = () => true } = {}) {
    const run = queue.then(async () => {
      if (!endpoint) return { ok: false, added: 0, removed: 0, error: "not-configured" };
      await load();
      const gone = async () => {
        const removed = byProject.get(projectId)?.length ?? 0;
        if (removed) { byProject.delete(projectId); await save(); }
        return { ok: true, added: 0, removed };
      };
      if (!alive()) return gone();
      const old = byProject.get(projectId) ?? [];
      const wanted = [];
      const seen = new Set();
      for (const chunk of chunkSources(sources)) {
        const key = chunk.sourceId + "\u0000" + chunk.hash;
        if (!seen.has(key)) { seen.add(key); wanted.push(chunk); }
      }
      const have = new Map(old.map((e) => [e.sourceId + "\u0000" + e.hash, e]));
      const known = knownVectors();
      const missing = wanted.filter((c) => !known.has(c.hash));
      const fresh = new Map();
      let error = "";
      for (let i = 0; i < missing.length; i += batch) {
        const part = missing.slice(i, i + batch);
        try {
          const vectors = await embed(part.map(embedInput));
          part.forEach((c, n) => fresh.set(c.hash, vectors[n]));
        } catch (e) {
          error = reason(e);
          break;
        }
      }
      const entryOf = (c, vector) => ({ projectId, customerId, sourceId: c.sourceId, title: c.title, text: c.text.slice(0, KEEP_TEXT), hash: c.hash, vector });
      let next; let added = 0; let removed = 0;
      if (error) {
        // keep everything there was, add what did get embedded
        next = old.map((e) => ({ ...e, customerId }));
        for (const c of wanted) {
          const key = c.sourceId + "\u0000" + c.hash;
          if (have.has(key)) continue;
          const vector = fresh.get(c.hash) ?? known.get(c.hash);
          if (vector) { next.push(entryOf(c, vector)); added++; }
        }
      } else {
        next = wanted.map((c) => {
          const kept = have.get(c.sourceId + "\u0000" + c.hash);
          if (kept) return { ...kept, customerId, title: c.title };
          added++;
          return entryOf(c, fresh.get(c.hash) ?? known.get(c.hash));
        });
        const still = new Set(wanted.map((c) => c.sourceId + "\u0000" + c.hash));
        removed = old.filter((e) => !still.has(e.sourceId + "\u0000" + e.hash)).length;
      }
      if (!alive()) return gone();
      const changed = added > 0 || removed > 0 || old.some((e) => e.customerId !== customerId);
      if (next.length) byProject.set(projectId, next); else byProject.delete(projectId);
      if (changed) await save();
      lastError = error || null;
      if (error) log("vectors: embedding failed (" + error + "), kept the old index");
      return { ok: !error, added, removed, ...(error ? { error } : {}) };
    });
    queue = run.catch(() => undefined);
    return run.catch((e) => ({ ok: false, added: 0, removed: 0, error: reason(e) }));
  }

  /** Drops every project not in `projectIds` (deleted projects/customers). Never throws. */
  function retain(projectIds) {
    const run = queue.then(async () => {
      await load();
      const keep = new Set(projectIds);
      let removed = 0;
      for (const id of [...byProject.keys()]) if (!keep.has(id)) { removed += byProject.get(id).length; byProject.delete(id); }
      if (removed) await save();
      return removed;
    });
    queue = run.catch(() => undefined);
    return run.catch(() => 0);
  }

  const entries = () => [...byProject.values()].flat();
  const search = (vector, options) => searchEntries(entries(), vector, options);

  /** Text → hits. Never throws: `{ ok: false, error }` when the service fails. */
  async function query(text, options = {}) {
    if (!endpoint) return { ok: false, error: "not-configured", hits: [] };
    await load();
    try {
      const [vector] = await embed([String(text ?? "").slice(0, 4000)]);
      return { ok: true, hits: search(vector, options) };
    } catch (error) {
      return { ok: false, error: reason(error), hits: [] };
    }
  }

  /** One direction for a project: the mean of its sections (optionally only some sources). */
  function projectVector(projectId, sourceIds = null) {
    const only = sourceIds ? new Set(sourceIds) : null;
    return centroid((byProject.get(projectId) ?? []).filter((e) => !only || only.has(e.sourceId)).map((e) => e.vector));
  }

  /**
   * For fitSources: scores sections by their likeness to the project description
   * (sources `projekt` + `kunde`). Sections not in the index are embedded on the spot,
   * not stored. Resolves null when that is not possible (then the old cutting applies).
   */
  function ranker(projectId) {
    return async (chunks) => {
      if (!endpoint) return null;
      await load();
      const target = projectVector(projectId, ["projekt", "kunde"]);
      if (!target) return null;
      const known = knownVectors();
      const missing = [...new Map(chunks.filter((c) => !known.has(c.hash)).map((c) => [c.hash, c])).values()];
      try {
        if (missing.length) (await embed(missing.map(embedInput))).forEach((v, i) => known.set(missing[i].hash, v));
      } catch (error) {
        log("vectors: ranking failed (" + reason(error) + "), cutting instead");
        return null;
      }
      return new Map(chunks.map((c) => [c.hash, dot(target, known.get(c.hash))]));
    };
  }

  return {
    enabled: Boolean(endpoint),
    load, save, syncProject, retain, search, query, projectVector, ranker, entries,
    size: () => entries().length,
    status: () => ({ enabled: Boolean(endpoint), sections: entries().length, projects: byProject.size, lastError }),
    flush: () => queue.then(() => writing),
  };
}

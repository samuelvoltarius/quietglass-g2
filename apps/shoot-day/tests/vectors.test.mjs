import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHUNK_SIZE, chunkSources, chunkText, createVectorIndex, decodeVector, embedUrl, encodeVector, normalise, searchEntries,
} from "../examples/shoot-day-vectors.mjs";
import {
  BUDGET, HINT_ID, HINT_TITLE, analyseProject, analysisMessages, cleanAnalysis, fitSources, materialHash, projectSources,
} from "../examples/shoot-day-brain.mjs";

// Invented material only. A deterministic stand-in for an embedding model: a few
// topic dimensions (a word counts for a topic when it contains its stem) plus a
// faint "everything else" dimension, so similar wording gives similar vectors.
const TOPICS = ["drohne", "garten", "hochzeit", "torte", "bäcker", "brot", "licht", "interview", "schnee", "berg"];
function fakeVector(text) {
  const v = new Array(TOPICS.length + 1).fill(0);
  for (const word of String(text).toLowerCase().match(/\p{L}+/gu) ?? []) {
    const topic = TOPICS.findIndex((stem) => word.includes(stem));
    if (topic >= 0) v[topic] += 1; else v[TOPICS.length] += 0.05;
  }
  return v;
}
/** fetch() of a fake embedding service: records every input, can be told to fail. */
function fakeEmbedFetch() {
  const seen = { calls: 0, inputs: [], auth: [], bodies: [] };
  let fail = false;
  const impl = async (url, init) => {
    seen.calls++;
    seen.auth.push(init.headers.Authorization);
    if (fail) throw new Error("connect ECONNREFUSED");
    const body = JSON.parse(init.body);
    seen.bodies.push(body);
    seen.inputs.push(...body.input);
    return { ok: true, json: async () => ({ data: body.input.map((text, index) => ({ index, embedding: fakeVector(text) })).reverse() }) };
  };
  return { impl, seen, set fail(value) { fail = value; } };
}

const tmpDirs = [];
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), "shootday-vec-")); tmpDirs.push(dir); return dir; };

const sourcesA = () => [
  { id: "kunde", title: "Kunde", text: "Name: Bäckerei Beispiel\nFirma: Beispiel Brot GmbH" },
  { id: "projekt", title: "Projekt", text: "Projekt: Imagefilm Bäckerei\nOrt: Backstube" },
  { id: "idea:i_000000000001", title: "Idee: Brot im Morgenlicht", text: "Brot im Morgenlicht aus dem Ofen holen" },
];
const sourcesB = () => [
  { id: "kunde", title: "Kunde", text: "Name: Paar Muster" },
  { id: "projekt", title: "Projekt", text: "Projekt: Hochzeit im Garten" },
  { id: "idea:i_000000000002", title: "Idee: Drohne über dem Garten", text: "Drohne über dem Garten, Hochzeit von oben" },
];

describe("vector index (shoot-day-vectors.mjs)", () => {
  afterEach(() => { for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("cuts long text into sections at paragraph and sentence borders, with a little overlap", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("Kurz.")).toEqual(["Kurz."]);
    const sentences = Array.from({ length: 60 }, (_, i) => `Satz Nummer ${i} erzählt etwas über den Dreh.`);
    const text = sentences.slice(0, 30).join(" ") + "\n\n" + sentences.slice(30).join(" ");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(CHUNK_SIZE + 200);
      expect(c).toMatch(/^Satz Nummer \d+/);   // starts at a sentence
      expect(c).toMatch(/Dreh\.$/);            // ends at a sentence
    }
    // the overlap: each section starts with a sentence of the one before
    for (let i = 1; i < chunks.length; i++) expect(chunks[i - 1]).toContain(chunks[i].split(".")[0] + ".");
    // without overlap every sentence is there exactly once
    const plain = chunkText(text, { overlap: 0 }).join(" ");
    for (const s of sentences) expect(plain.split(s).length - 1).toBe(1);
    // one endless word is still cut
    expect(chunkText("x".repeat(3000)).every((c) => c.length <= CHUNK_SIZE + 200)).toBe(true);
    // a section is known by the hash of title + text
    const [a] = chunkSources([{ id: "kunde", title: "Kunde", text: "Max" }]);
    const [b] = chunkSources([{ id: "kunde", title: "Kunde neu", text: "Max" }]);
    expect(a).toMatchObject({ sourceId: "kunde", part: 0, text: "Max" });
    expect(a.hash).not.toBe(b.hash);
  });

  it("vectors: normalised, compact as base64, endpoint from the base URL", () => {
    const v = normalise([3, 4]);
    expect(Array.from(v)).toEqual([expect.closeTo(0.6, 6), expect.closeTo(0.8, 6)]);
    expect(Array.from(decodeVector(encodeVector(v)))).toEqual(Array.from(v));
    expect(normalise([0, 0])).toBeNull();
    expect(embedUrl("http://127.0.0.1:9/")).toBe("http://127.0.0.1:9/v1/embeddings");
    expect(embedUrl("http://127.0.0.1:9/v1")).toBe("http://127.0.0.1:9/v1/embeddings");
    expect(embedUrl("http://127.0.0.1:9/v1/embeddings")).toBe("http://127.0.0.1:9/v1/embeddings");
    expect(embedUrl("")).toBe("");
  });

  it("embeds only new sections (in batches), drops vanished ones, and survives a restart", async () => {
    const file = join(tmp(), "vectors.json");
    const fake = fakeEmbedFetch();
    const index = createVectorIndex({ file, url: "http://embed.invalid", model: "test-model", token: "t0k", fetchImpl: fake.impl, batch: 2 });
    const first = await index.syncProject("p_000000000001", "c_000000000001", sourcesA());
    expect(first).toEqual({ ok: true, added: 3, removed: 0 });
    expect(fake.seen.calls).toBe(2);                                      // 3 sections, batches of 2
    expect(fake.seen.bodies[0].model).toBe("test-model");
    expect(fake.seen.auth.every((a) => a === "Bearer t0k")).toBe(true);
    expect(fake.seen.inputs[0]).toBe("Kunde\nName: Bäckerei Beispiel\nFirma: Beispiel Brot GmbH");

    // the second run embeds nothing
    expect(await index.syncProject("p_000000000001", "c_000000000001", sourcesA())).toEqual({ ok: true, added: 0, removed: 0 });
    expect(fake.seen.calls).toBe(2);

    // one source changed, one gone: one new section, two dropped
    const changed = sourcesA().slice(0, 2);
    changed[1] = { ...changed[1], text: "Projekt: Imagefilm Bäckerei\nOrt: Verkaufsraum" };
    expect(await index.syncProject("p_000000000001", "c_000000000001", changed)).toEqual({ ok: true, added: 1, removed: 2 });
    expect(fake.seen.inputs.at(-1)).toContain("Verkaufsraum");
    expect(index.entries().map((e) => e.sourceId)).toEqual(["kunde", "projekt"]);

    // the file: atomic (no leftovers), compact vectors, own fields
    await index.flush();
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved).toMatchObject({ version: 1, model: "test-model" });
    expect(saved.entries[0]).toEqual({ projectId: "p_000000000001", customerId: "c_000000000001", sourceId: "kunde", title: "Kunde", text: expect.any(String), hash: expect.any(String), v: expect.any(String) });
    expect(existsSync(file + ".tmp-" + process.pid)).toBe(false);

    // restart: nothing embedded again
    const again = createVectorIndex({ file, url: "http://embed.invalid", model: "test-model", fetchImpl: fake.impl });
    const calls = fake.seen.calls;
    expect(await again.syncProject("p_000000000001", "c_000000000001", changed)).toEqual({ ok: true, added: 0, removed: 0 });
    expect(fake.seen.calls).toBe(calls);
    // another model: its vectors cannot be compared, so everything is embedded again
    const other = createVectorIndex({ file, url: "http://embed.invalid", model: "other-model", fetchImpl: fake.impl });
    expect((await other.syncProject("p_000000000001", "c_000000000001", changed)).added).toBe(2);
  });

  it("the same section in another project is not embedded twice", async () => {
    const fake = fakeEmbedFetch();
    const index = createVectorIndex({ file: join(tmp(), "v.json"), url: "http://embed.invalid", fetchImpl: fake.impl });
    await index.syncProject("p_000000000001", "c_000000000001", sourcesA());
    const calls = fake.seen.calls;
    expect((await index.syncProject("p_000000000009", "c_000000000001", sourcesA())).added).toBe(3);
    expect(fake.seen.calls).toBe(calls);
    expect(fake.seen.bodies.every((b) => !("model" in b))).toBe(true);   // no model configured → field left out
  });

  it("a failing service never throws and never deletes anything", async () => {
    const file = join(tmp(), "v.json");
    const fake = fakeEmbedFetch();
    const index = createVectorIndex({ file, url: "http://embed.invalid", fetchImpl: fake.impl });
    await index.syncProject("p_000000000001", "c_000000000001", sourcesA());
    const before = index.entries().map((e) => e.hash);
    fake.fail = true;
    // a source vanished AND a new one came: nothing removed, nothing added
    const result = await index.syncProject("p_000000000001", "c_000000000001", [...sourcesA().slice(1), { id: "skript", title: "Skript", text: "Neuer Text" }]);
    expect(result).toMatchObject({ ok: false, added: 0, removed: 0, error: expect.stringContaining("ECONNREFUSED") });
    expect(index.entries().map((e) => e.hash)).toEqual(before);
    expect(await index.query("Brot")).toEqual({ ok: false, error: expect.any(String), hits: [] });
    expect(await index.ranker("p_000000000001")([{ hash: "nope", text: "x", title: "" }])).toBeNull();
    // a service that answers nonsense is a failure too
    const odd = createVectorIndex({ file: join(tmp(), "w.json"), url: "http://embed.invalid", fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }) });
    expect((await odd.syncProject("p_000000000001", "c_000000000001", sourcesA())).ok).toBe(false);
    expect(odd.size()).toBe(0);
    // off: no URL, nothing is sent
    const off = createVectorIndex({ file: join(tmp(), "x.json"), url: "", fetchImpl: () => { throw new Error("must not be called"); } });
    expect(off.enabled).toBe(false);
    expect(await off.syncProject("p_000000000001", "c_000000000001", sourcesA())).toMatchObject({ ok: false, error: "not-configured" });
  });

  it("search: cosine top-k, only some projects/customers, or everything except one project", async () => {
    const fake = fakeEmbedFetch();
    const index = createVectorIndex({ file: join(tmp(), "v.json"), url: "http://embed.invalid", fetchImpl: fake.impl });
    await index.syncProject("p_00000000000a", "c_00000000000a", sourcesA());
    await index.syncProject("p_00000000000b", "c_00000000000b", sourcesB());
    const drone = await index.query("Drohne Hochzeit Garten", { limit: 2 });
    expect(drone.ok).toBe(true);
    expect(drone.hits).toHaveLength(2);
    expect(drone.hits[0].entry).toMatchObject({ projectId: "p_00000000000b", sourceId: "idea:i_000000000002" });
    expect(drone.hits[0].score).toBeGreaterThan(0.9);
    expect(drone.hits[0].score).toBeGreaterThanOrEqual(drone.hits[1].score);
    expect((await index.query("Drohne", { projects: ["p_00000000000a"] })).hits.every((h) => h.entry.projectId === "p_00000000000a")).toBe(true);
    expect((await index.query("Drohne", { customers: ["c_00000000000a"] })).hits.every((h) => h.entry.customerId === "c_00000000000a")).toBe(true);
    expect((await index.query("Drohne", { exceptProjects: ["p_00000000000b"] })).hits.every((h) => h.entry.projectId !== "p_00000000000b")).toBe(true);
    expect((await index.query("Drohne", { minScore: 0.99 })).hits.map((h) => h.entry.sourceId)).toEqual([]);
    // the project direction: like its own material, unlike the other project's
    const a = index.projectVector("p_00000000000a");
    expect(index.search(a, { limit: 1 })[0].entry.projectId).toBe("p_00000000000a");
    expect(searchEntries(index.entries(), null)).toEqual([]);
    // deleted projects leave the index
    expect(await index.retain(["p_00000000000a"])).toBe(3);
    expect(new Set(index.entries().map((e) => e.projectId))).toEqual(new Set(["p_00000000000a"]));
    // a project deleted while its run was under way is dropped, not written back
    expect(await index.syncProject("p_00000000000a", "c_00000000000a", sourcesA(), { alive: () => false })).toEqual({ ok: true, added: 0, removed: 3 });
    expect(index.size()).toBe(0);
  });
});

describe("project understanding with the vector index (shoot-day-brain.mjs)", () => {
  const hint = { id: HINT_ID, title: HINT_TITLE, text: "- Paar Muster · Hochzeit im Garten · Idee: Drohne über dem Garten: Drohnenpilot Fritz Fremd, Genehmigung lag vor" };

  it("the hint from earlier projects does not change the material hash", () => {
    const sources = sourcesA();
    expect(materialHash([...sources, hint])).toBe(materialHash(sources));
    expect(materialHash([...sources, { ...hint, text: "ganz anders" }])).toBe(materialHash(sources));
  });

  it("the hint gives no facts and is never a source", () => {
    const analysis = cleanAnalysis({
      lage: "Imagefilm für eine Bäckerei.",
      unterlagen: [{ vorlage: "drohne", warum: "früher nötig", quellen: [HINT_ID, "projekt"], angaben: { personen: "Fritz Fremd", ort: "Backstube" } }],
    }, [...sourcesA(), hint]);
    expect(analysis.unterlagen[0].quellen).toEqual(["projekt"]);
    expect(analysis.unterlagen[0].angaben).toEqual({ ort: "Backstube" });   // "Fritz Fremd" only stands in the hint
  });

  it("the prompt names the hint as experience only; the model sees it, the check does not", async () => {
    const messages = analysisMessages([...sourcesA(), hint]);
    expect(messages[0].content).toContain("[frueher] stammt aus ANDEREN, früheren Projekten");
    expect(messages[1].content).toContain("[frueher] " + HINT_TITLE);
    expect(analysisMessages(sourcesA())[0].content).not.toContain("frueher");
    const asked = [];
    const fetchImpl = async (url, init) => {
      asked.push(JSON.parse(init.body).messages[1].content);
      const content = JSON.stringify({ lage: "Bäckerei.", unterlagen: [{ vorlage: "drohne", quellen: [HINT_ID], angaben: { personen: "Fritz Fremd" } }] });
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
    };
    const result = await analyseProject(sourcesA(), { url: "http://llm.invalid/v1", fetchImpl, hints: [hint, { id: "projekt", title: "x", text: "kein Hinweis" }] });
    expect(result.ok).toBe(true);
    expect(asked[0]).toContain("Fritz Fremd");
    expect(asked[0]).not.toContain("kein Hinweis");                         // only the "frueher" id is taken as a hint
    expect(result.analysis.unterlagen[0]).toMatchObject({ quellen: [], angaben: {} });
  });

  it("over the budget: sections like the project description are kept instead of blind cutting", async () => {
    const filler = (i) => `Abschnitt ${i} über das Wetter im Schnee am Berg und anderes.`.repeat(25);
    const sources = [
      { id: "kunde", title: "Kunde", text: "Name: Bäckerei Beispiel" },
      { id: "projekt", title: "Projekt", text: "Projekt: Imagefilm Bäckerei" },
      ...Array.from({ length: 90 }, (_, i) => ({ id: "file:f_" + i, title: "Datei " + i, text: (i === 33 ? "Brot und Bäcker im Licht. " : "") + filler(i) })),
    ];
    expect(sources.reduce((n, s) => n + s.text.length, 0)).toBeGreaterThan(BUDGET);
    // the score: the Bäcker section counts most
    const score = (c) => (c.text.includes("Bäcker") ? 1 : 0.1);
    const fitted = fitSources(sources, {}, 20_000, score);
    expect(fitted.slice(0, 2)).toEqual(sources.slice(0, 2));               // customer and project stay whole
    expect(fitted.find((s) => s.id === "file:f_33").text).toContain("Brot und Bäcker im Licht.");
    expect(fitted.reduce((n, s) => n + s.text.length + s.title.length + 20, 0)).toBeLessThanOrEqual(20_000);
    expect(fitted.filter((s) => s.excerpt).length).toBeGreaterThan(0);
    // without scores that help: the old cutting
    const cut = fitSources(sources, {}, 20_000, () => NaN);
    expect(cut).toHaveLength(sources.length);
    expect(cut.every((s) => !s.excerpt)).toBe(true);

    // through analyseProject with a ranker from the index
    const fake = fakeEmbedFetch();
    const index = createVectorIndex({ file: join(tmp(), "v.json"), url: "http://embed.invalid", fetchImpl: fake.impl });
    await index.syncProject("p_000000000001", "c_000000000001", sources.slice(0, 2));
    let prompt = "";
    const llm = async (url, init) => {
      prompt = JSON.parse(init.body).messages[1].content;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "{\"lage\":\"ok\"}" } }] }) };
    };
    const big = sources.map((s) => (s.id.startsWith("file:") ? { ...s, text: s.text.slice(0, 5000) + " Ende " + s.id } : s));
    const many = [...big, ...big.slice(2).map((s) => ({ ...s, id: s.id + "b" }))];
    const result = await analyseProject(many, { url: "http://llm.invalid/v1", fetchImpl: llm, rank: index.ranker("p_000000000001") });
    expect(result.ok).toBe(true);
    expect(prompt).toContain("Brot und Bäcker im Licht.");
    expect(prompt).toContain("(Auszug)");
    expect(prompt.length).toBeLessThan(BUDGET + 20_000);
  });

  it("dashboard tasks are sources of their own: status, due date, description, comments", () => {
    const project = { name: "Imagefilm", dispo: {}, ideas: [], talks: [], storyboards: [], scenes: [] };
    const sources = projectSources(project, { name: "Max Beispiel" }, [], [
      { taskId: "17", title: "Location besichtigen", status: "done", due_date: "2026-10-18", description: "Schlüssel bei Frau Test", comments: ["War dort, passt."] },
      { taskId: "", title: "ohne id" },
    ]);
    const dash = sources.find((s) => s.id === "dash:17");
    expect(dash.title).toBe("Dashboard: Location besichtigen");
    expect(dash.text).toBe("Aufgabe: Location besichtigen\nStatus: done\nFällig: 2026-10-18\nBeschreibung: Schlüssel bei Frau Test\nKommentar: War dort, passt.");
    expect(sources.filter((s) => s.id.startsWith("dash:"))).toHaveLength(1);
    expect(materialHash(sources)).not.toBe(materialHash(sources.filter((s) => s.id !== "dash:17")));
    expect(analysisMessages(sources)[0].content).toContain("Status „done“ heißt erledigt");
    // facts may come from the dashboard
    const analysis = cleanAnalysis({ lage: "x", unterlagen: [{ vorlage: "drohne", quellen: ["dash:17"], angaben: { ansprechperson: "Frau Test" } }] }, sources);
    expect(analysis.unterlagen[0]).toMatchObject({ quellen: ["dash:17"], angaben: { ansprechperson: "Frau Test" } });
  });
});

// ---------------------------------------------------------------------------
// The server with a fake embedding service.
// ---------------------------------------------------------------------------
const serverFile = fileURLToPath(new URL("../examples/shoot-day-server.mjs", import.meta.url));
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
async function startServer(env, cleanup) {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "shootday-vec-srv-"));
  const dataFile = join(dir, "data.json");
  const child = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_FILE: dataFile, TOKEN: "", WHISPER_URL: "", PRESET_LANG: "de", SHOOT_BRAIN_START_MS: "600000",
      SHOOT_WD_URL: "", SHOOT_WD_TOKEN: "", SHOOT_LLM_URL: "", SHOOT_EMBED_URL: "", SHOOT_EMBED_MODEL: "", SHOOT_EMBED_TOKEN: "", SHOOT_VECTORS_FILE: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { output.stdout += chunk; });
  child.stderr.on("data", (chunk) => { output.stderr += chunk; });
  cleanup.push(() => { child.kill(); rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", () => { if (output.stdout.includes("http://")) resolve(); });
    child.on("exit", (code) => reject(new Error("exited " + code + ": " + output.stderr)));
  });
  return { base: `http://127.0.0.1:${port}`, output, dir };
}
const post = (base, path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const until = async (test, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return true; await new Promise((resolve) => setTimeout(resolve, 50)); }
  return false;
};
async function fakeEmbedServer() {
  const seen = { inputs: [], auth: [], urls: [] };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.urls.push(request.url);
      seen.auth.push(request.headers.authorization);
      const { input } = JSON.parse(body);
      seen.inputs.push(...input);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: fakeVector(text) })) }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: "http://127.0.0.1:" + server.address().port, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

describe("search over all projects in the Shoot Day server", () => {
  const cleanup = [];
  afterEach(async () => { for (const step of cleanup.splice(0)) await step(); });

  it("indexes every project, finds across customers, answers related sections, and gives the model a hint from other projects", async () => {
    const embed = await fakeEmbedServer();
    cleanup.push(() => embed.close());
    const prompts = [];
    const llm = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        prompts.push(JSON.parse(body).messages);
        const content = JSON.stringify({ lage: "Ein Projekt.", unterlagen: [{ vorlage: "drohne", warum: "x", quellen: ["frueher"], angaben: { personen: "Paar Muster" } }] });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise((resolve) => llm.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => llm.close(resolve)));
    const { base, output, dir } = await startServer({
      SHOOT_EMBED_URL: embed.url, SHOOT_EMBED_MODEL: "fake-embed", SHOOT_EMBED_TOKEN: "embed-t0k", SHOOT_BRAIN_DEBOUNCE_MS: "100",
      SHOOT_LLM_URL: "http://127.0.0.1:" + llm.address().port + "/v1",
    }, cleanup);
    expect(await until(() => output.stdout.includes("Search over all projects: on"))).toBe(true);
    expect((await (await fetch(base + "/api/config")).json()).embed).toBe(true);
    // the seeded example project is indexed at the start
    expect(await until(() => output.stdout.includes("section(s) indexed"))).toBe(true);
    expect(embed.seen.urls.every((u) => u === "/v1/embeddings")).toBe(true);
    expect(embed.seen.auth.every((a) => a === "Bearer embed-t0k")).toBe(true);

    // two invented customers with a project each
    const a = await (await post(base, "/api/customers", { name: "Bäckerei Beispiel" })).json();
    const b = await (await post(base, "/api/customers", { name: "Paar Muster" })).json();
    const pa = await (await post(base, "/api/projects", { name: "Imagefilm Bäckerei", customerId: a.id })).json();
    const pb = await (await post(base, "/api/projects", { name: "Hochzeit im Garten", customerId: b.id })).json();
    await post(base, "/api/projects/" + pa.id + "/ideas", { ideas: [{ text: "Drohne über den Garten der Bäckerei", tags: [] }] });
    await post(base, "/api/projects/" + pb.id + "/ideas", { ideas: [{ text: "Drohne über den Garten bei der Hochzeit, Torte von der Bäckerei", tags: [] }] });
    const search = async (q, limit = 8) => (await fetch(base + "/api/search?q=" + encodeURIComponent(q) + "&limit=" + limit)).json();
    expect(await until(async () => (await search("Drohne Garten Hochzeit")).hits?.some((h) => h.projectId === pb.id))).toBe(true);
    expect(await until(async () => (await search("Drohne Garten Bäckerei")).hits?.some((h) => h.projectId === pa.id))).toBe(true);

    const { hits } = await search("Drohne Garten Hochzeit Torte", 3);
    expect(hits).toHaveLength(3);
    expect(hits[0]).toEqual({
      projectId: pb.id, project: "Hochzeit im Garten", customerId: b.id, customer: "Paar Muster",
      sourceId: expect.stringMatching(/^idea:i_/), title: "Idee: Drohne über den Garten bei der Hochzeit, Torte von der Bäckerei", snippet: expect.stringContaining("Drohne"), score: expect.any(Number),
    });
    expect((await fetch(base + "/api/search?q=")).status).toBe(400);

    // related sections: this project, the others, everything
    const related = async (body) => (await (await post(base, "/api/context/related", body)).json()).hits;
    expect((await related({ text: "Drohne Garten", projectId: pa.id })).every((h) => h.projectId === pa.id)).toBe(true);
    const others = await related({ text: "Drohne Garten", projectId: pa.id, scope: "others", limit: 2 });
    expect(others).toHaveLength(2);
    expect(others.every((h) => h.projectId !== pa.id)).toBe(true);
    expect((await related({ text: "Drohne Garten" })).length).toBeGreaterThan(1);
    expect((await post(base, "/api/context/related", {})).status).toBe(400);
    expect((await post(base, "/api/context/related", { text: "x", projectId: "p_000000000000" })).status).toBe(404);

    // the analysis of A sees B as a hint – the answer takes no fact and no source from it
    const run = await (await post(base, "/api/projects/" + pa.id + "/brain", {})).json();
    expect(run.ok).toBe(true);
    const asked = prompts.at(-1);
    expect(asked[1].content).toContain("[frueher] Aus früheren Projekten (nur Hinweis)");
    expect(asked[1].content.split("[frueher]")[1]).toContain("Hochzeit im Garten");
    expect(asked[0].content).toContain("nie als Fakten dieses Projekts");
    expect(run.analysis.unterlagen[0]).toMatchObject({ template: "drohne", quellen: [], angaben: {} });

    // a deleted project leaves the index (and the search)
    expect((await fetch(base + "/api/projects/" + pb.id, { method: "DELETE" })).status).toBe(200);
    expect(await until(async () => !(await search("Drohne Garten Hochzeit")).hits.some((h) => h.projectId === pb.id))).toBe(true);
    expect(await until(() => !readFileSync(join(dir, "shoot-day-vectors.json"), "utf8").includes(pb.id))).toBe(true);
    expect(output.stderr).not.toContain("could not save");
    // the data file stays free of vectors
    expect(readFileSync(join(dir, "data.json"), "utf8")).not.toContain("\"v\":");
  }, 30000);

  it("is off without SHOOT_EMBED_URL", async () => {
    const { base, output, dir } = await startServer({}, cleanup);
    expect(await until(() => output.stdout.includes("Search over all projects: off"))).toBe(true);
    expect((await (await fetch(base + "/api/config")).json()).embed).toBe(false);
    expect((await fetch(base + "/api/search?q=Drohne")).status).toBe(503);
    expect((await post(base, "/api/context/related", { text: "Drohne" })).status).toBe(503);
    expect(existsSync(join(dir, "shoot-day-vectors.json"))).toBe(false);
  }, 10000);
});

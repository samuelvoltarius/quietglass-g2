import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { makePdf } from "./pdf-fixture.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const example = (name) => fileURLToPath(new URL("../examples/" + name, import.meta.url));

/** A port that was free a moment ago; good enough for a local test. */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Starts the server and resolves once it reports that it is listening. */
async function start(env, cleanup, setup = undefined) {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "shootday-"));
  const dataFile = join(dir, "data.json");
  setup?.(dataFile, dir);
  const child = spawn(process.execPath, [example("shoot-day-server.mjs")], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_FILE: dataFile, TOKEN: "", WHISPER_URL: "", ...env },
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
  return { base: `http://127.0.0.1:${port}`, output, dataFile, dir, child };
}

const post = (base, path, body, headers = {}) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("the Shoot Day server example", () => {
  const cleanup = [];
  afterEach(() => { for (const step of cleanup.splice(0)) step(); });

  it("seeds a neutral example project and serves the web terminal", async () => {
    const { base, dataFile } = await start({}, cleanup);
    const list = await (await fetch(base + "/api/shotlist")).json();
    expect(list.project).toBe("Example shoot");
    expect(list.shots.length).toBeGreaterThan(0);
    const page = await fetch(base + "/");
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await page.text()).toContain("Shoot Day");
    const stored = JSON.parse(readFileSync(dataFile, "utf8"));
    expect(stored.version).toBe(2);
    expect(stored.projects[stored.active].name).toBe("Example shoot");
    expect(Object.values(stored.customers).map((c) => c.name)).toEqual(["Example client"]);
  }, 10000);

  it("logs takes, counts per shot, and updates a note", async () => {
    const { base } = await start({}, cleanup);
    const first = await (await post(base, "/api/take", { scene: "1", shot: "A", status: "OK", note: "" })).json();
    const second = await (await post(base, "/api/take", { scene: "1", shot: "A", status: "NG", note: "<b>Ton</b>" })).json();
    expect([first.n, second.n]).toEqual([1, 2]);
    expect((await post(base, "/api/take/note", { scene: "1", shot: "A", n: 1, note: "super" })).status).toBe(200);
    const { takes } = await (await fetch(base + "/api/takes?all=1")).json();
    expect(takes.map((t) => [t.n, t.status, t.note])).toEqual([[1, "OK", "super"], [2, "NG", "<b>Ton</b>"]]);
  }, 10000);

  it("deletes exactly one take via /api/take/delete (404 when unknown, ?project honoured)", async () => {
    const { base } = await start({}, cleanup);
    for (const [scene, shot, status] of [["1", "A", "OK"], ["1", "A", "NG"], ["1", "B", "OK"], ["2", "A", "OK"]]) {
      await post(base, "/api/take", { scene, shot, status });
    }
    const key = (t) => `${t.scene}${t.shot}${t.n}${t.status}`;
    const all = async (q = "") => (await (await fetch(base + "/api/takes?all=1" + q)).json()).takes.map(key);
    expect(await all()).toEqual(["1A1OK", "1A2NG", "1B1OK", "2A1OK"]);

    const gone = await post(base, "/api/take/delete", { scene: "1", shot: "A", n: 2 });
    expect(gone.status).toBe(200);
    expect(await gone.json()).toMatchObject({ ok: true, deleted: { scene: "1", shot: "A", n: 2, status: "NG" } });
    expect(await all()).toEqual(["1A1OK", "1B1OK", "2A1OK"]);

    expect((await post(base, "/api/take/delete", { scene: "1", shot: "A", n: 2 })).status).toBe(404);
    expect((await post(base, "/api/take/delete", { scene: "9", shot: "A", n: 1 })).status).toBe(404);
    expect((await post(base, "/api/take/delete", { scene: "1", shot: "A" })).status).toBe(404);
    expect(await all()).toEqual(["1A1OK", "1B1OK", "2A1OK"]);

    // the next take of that shot continues the count
    expect((await (await post(base, "/api/take", { scene: "1", shot: "A", status: "OK" })).json()).n).toBe(2);

    // ?project=<id> works on that project, not on the active one
    const created = await (await post(base, "/api/projects", { name: "Other shoot" })).json();
    await post(base, "/api/take?project=" + created.id, { scene: "1", shot: "A", status: "OK" });
    expect((await post(base, "/api/take/delete?project=" + created.id, { scene: "1", shot: "B", n: 1 })).status).toBe(404);
    expect((await post(base, "/api/take/delete?project=nope", { scene: "1", shot: "A", n: 1 })).status).toBe(404);
    expect(await all("&project=" + created.id)).toEqual(["1A1OK"]);
    expect((await post(base, "/api/take/delete?project=" + created.id, { scene: "1", shot: "A", n: 1 })).status).toBe(200);
    expect(await all("&project=" + created.id)).toEqual([]);
    expect(await all()).toEqual(["1A1OK", "1B1OK", "2A1OK", "1A2OK"]);
  }, 10000);

  it("changes one packing-list item at a time", async () => {
    const { base } = await start({ PRESET_LANG: "de" }, cleanup);
    const { items } = await (await fetch(base + "/api/equipment")).json();
    expect(items.map((i) => i.name)).toContain("Gimbal");
    expect((await post(base, "/api/equipment", { setneed: { name: "Gimbal", need: true } })).status).toBe(200);
    const ticked = await (await post(base, "/api/equipment", { toggle: { name: "Gimbal", packed: true } })).json();
    expect(ticked).toMatchObject({ ok: true, packed: true, need: 1, packedCount: 1 });
    expect((await post(base, "/api/equipment", { toggle: { name: "nope", packed: true } })).status).toBe(404);
  }, 10000);

  it("answers the CORS preflight even with a TOKEN, and requires the token with a constant answer", async () => {
    const { base } = await start({ TOKEN: "s3cret" }, cleanup);
    const preflight = await fetch(base + "/api/shotlist", {
      method: "OPTIONS",
      headers: { Origin: "https://phone.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
    for (const headers of [{}, { Authorization: "Bearer wrong" }, { Authorization: "Bearer s3cretX" }, { Authorization: "s3cret" }]) {
      expect((await fetch(base + "/api/shotlist", { headers })).status, JSON.stringify(headers)).toBe(401);
    }
    expect((await fetch(base + "/api/shotlist", { headers: { Authorization: "Bearer s3cret" } })).status).toBe(200);
  }, 10000);

  it("lets an allowed Tailscale login in without the token (loopback only), anyone else still needs it", async () => {
    const { base } = await start({ TOKEN: "s3cret", SD_TAILSCALE_USERS: "Me@Example.com" }, cleanup);
    expect((await fetch(base + "/api/shotlist", { headers: { "Tailscale-User-Login": "me@example.com" } })).status).toBe(200);
    expect((await fetch(base + "/api/shotlist", { headers: { "Tailscale-User-Login": "stranger@example.com" } })).status).toBe(401);
    expect((await fetch(base + "/api/shotlist")).status).toBe(401);
    const preflight = await fetch(base + "/api/shotlist", { method: "OPTIONS", headers: { Origin: "https://phone.example", "Access-Control-Request-Method": "GET" } });
    expect(preflight.status).toBe(204);
    expect(await preflight.text()).toBe("");
  }, 10000);

  it("refuses to listen beyond this machine without a TOKEN", async () => {
    const port = await freePort();
    const result = spawnSync(process.execPath, [example("shoot-day-server.mjs")], {
      env: { ...process.env, PORT: String(port), HOST: "0.0.0.0", TOKEN: "" }, encoding: "utf8", timeout: 8000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("without a TOKEN");
  }, 10000);

  it("speech is off without WHISPER_URL, and an oversized body gets a 413", async () => {
    const { base } = await start({}, cleanup);
    expect((await fetch(base + "/api/stt", { method: "POST", body: new Uint8Array(100) })).status).toBe(503);
    const big = await post(base, "/api/prompter", { text: "x".repeat(400 * 1024) });
    expect(big.status).toBe(413);
  }, 10000);

  it("proxies speech to the configured recogniser with the language hint", async () => {
    let received = "";
    const whisper = createServer((request, response) => {
      let body = "";
      request.setEncoding("latin1");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => { received = body; response.end(JSON.stringify({ text: " Gimbal eingepackt " })); });
    });
    await new Promise((resolve) => whisper.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => { whisper.closeAllConnections(); whisper.close(); });
    const { base } = await start({ WHISPER_URL: `http://127.0.0.1:${whisper.address().port}/v1/audio/transcriptions` }, cleanup);
    const reply = await fetch(base + "/api/stt?lang=de", { method: "POST", body: new Uint8Array(4000) });
    expect(await reply.json()).toEqual({ text: "Gimbal eingepackt" });
    expect(received).toContain('name="language"');
    expect(received).toContain("de");
  }, 10000);
});

const python = ["python3", "python"].find((cmd) => spawnSync(cmd, ["--version"]).status === 0);

describe.skipIf(!python)("the MCP example", () => {
  const cleanup = [];
  afterEach(() => { for (const step of cleanup.splice(0)) step(); });

  it("lists its tools and reads the shoot over stdio", async () => {
    const { base } = await start({ TOKEN: "mcp-token" }, cleanup);
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "dreh_status", arguments: {} } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "dreh_take_eintragen", arguments: { szene: "1", shot: "A", status: "NG" } } },
    ].map((m) => JSON.stringify(m)).join("\n") + "\n";
    const child = spawn(python, [example("dreh_mcp.py")], {
      env: { ...process.env, SHOOTDAY_URL: base, SHOOTDAY_TOKEN: "mcp-token", SHOOTDAY_LANG: "en", PYTHONIOENCODING: "utf-8" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stdin.end(input);
    await new Promise((resolve) => child.on("close", resolve));
    const replies = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(replies[1].result.tools.map((t) => t.name)).toContain("dreh_pack_setzen");
    expect(replies[2].result.content[0].text).toContain("Project: Example shoot");
    expect(replies[3].result.content[0].text).toContain("Logged: 1·A T1 NG");
  }, 15000);
});

const json = async (response) => ({ status: response.status, body: await response.json() });
const del = (base, path) => fetch(base + path, { method: "DELETE" });
const upload = (base, projectId, name, bytes) => fetch(base + "/api/projects/" + projectId + "/files", {
  method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name) }, body: bytes,
});
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** A tiny HTTP server that answers every POST with `reply(body)` and remembers what it got. */
async function fakeService(reply, cleanup) {
  const seen = [];
  const service = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      seen.push({ path: request.url, body: parsed, auth: request.headers["authorization"] });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(reply(parsed)));
    });
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => { service.closeAllConnections(); service.close(); });
  return { url: `http://127.0.0.1:${service.address().port}`, seen };
}

describe("customers, projects and files on the server (0.5.0)", () => {
  const cleanup = [];
  afterEach(() => { for (const step of cleanup.splice(0)) step(); });

  it("migrates a version-1 data file to customers, after a byte-exact backup", async () => {
    const v1 = {
      active: "Hochzeit Beispiel",
      projects: {
        "Hochzeit Beispiel": { name: "Hochzeit Beispiel", scenes: [{ scene: "1", shots: [{ shot: "A", desc: "Kirche", size: "WS" }] }], takes: [{ scene: "1", shot: "A", n: 1, status: "OK", note: "", ts: 1 }], prompter: "Hallo" },
        "Imagefilm": { name: "Imagefilm" },
      },
    };
    const original = JSON.stringify(v1, null, 2);
    const { base, dataFile, dir, output } = await start({ PRESET_LANG: "de" }, cleanup, (file) => writeFileSync(file, original));
    const backups = readdirSync(dir).filter((name) => name.startsWith("data.json.bak-v1-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]), "utf8")).toBe(original);
    expect(output.stdout).toContain("migrating data to version 2");
    const { customers, active } = (await json(await fetch(base + "/api/customers"))).body;
    expect(customers.map((c) => [c.name, c.projectCount, c.unassigned])).toEqual([["Ohne Zuordnung", 2, true]]);
    const list = (await json(await fetch(base + "/api/shotlist"))).body;
    expect(list).toMatchObject({ project: "Hochzeit Beispiel", projectId: active, customer: "Ohne Zuordnung" });
    expect((await json(await fetch(base + "/api/takes?all=1"))).body.takes).toHaveLength(1);
    expect((await json(await fetch(base + "/api/prompter"))).body.text).toBe("Hallo");
    const stored = JSON.parse(readFileSync(dataFile, "utf8"));
    expect(stored.version).toBe(2);
    expect(Object.values(stored.projects).map((p) => p.customerId)).toEqual(["unassigned", "unassigned"]);
  }, 10000);

  it("customers: created on the web or the glasses, sorted by name, edited, deleted with care", async () => {
    const { base } = await start({}, cleanup);
    for (const name of ["zora", "Anna", "bernd"]) expect((await post(base, "/api/customers", { name })).status).toBe(200);
    expect((await post(base, "/api/customers", { name: "  " })).status).toBe(400);
    let { customers } = (await json(await fetch(base + "/api/customers"))).body;
    expect(customers.map((c) => c.name)).toEqual(["Anna", "bernd", "Example client", "zora"]);
    const anna = customers[0];
    const edited = (await json(await post(base, "/api/customers/" + anna.id, { phone: "+43 000 1111", email: "anna@example.invalid", notes: "<b>mag Pastell</b>" }))).body;
    expect(edited).toMatchObject({ name: "Anna", phone: "+43 000 1111", email: "anna@example.invalid", notes: "<b>mag Pastell</b>" });
    const project = (await json(await post(base, "/api/projects", { customerId: anna.id, name: "Porträt", date: "2026-10-20", place: "Park" }))).body;
    expect(project).toMatchObject({ name: "Porträt", customerId: anna.id });
    const detail = (await json(await fetch(base + "/api/customers/" + anna.id))).body;
    expect(detail.projects.map((p) => p.name)).toEqual(["Porträt"]);
    // A customer with projects is only deleted when it is said what happens to them.
    expect((await del(base, "/api/customers/" + anna.id)).status).toBe(409);
    expect((await json(await del(base, "/api/customers/" + anna.id + "?projects=move"))).body).toMatchObject({ ok: true, projects: 1, moved: true });
    expect((await del(base, "/api/customers/" + customers[1].id)).status).toBe(200);
    ({ customers } = (await json(await fetch(base + "/api/customers"))).body);
    expect(customers.map((c) => c.name)).toEqual(["Example client", "zora", "Unassigned"]);
    expect((await fetch(base + "/api/projects/" + project.id)).status).toBe(200);
    expect((await del(base, "/api/customers/unassigned")).status).toBe(409);
    // ?projects=delete takes the projects along.
    const zora = customers[1];
    const doomed = (await json(await post(base, "/api/projects", { customerId: zora.id, name: "Weg damit" }))).body;
    expect((await del(base, "/api/customers/" + zora.id + "?projects=delete")).status).toBe(200);
    expect((await fetch(base + "/api/projects/" + doomed.id)).status).toBe(404);
    expect((await fetch(base + "/api/customers/c_000000000000")).status).toBe(404);
  }, 10000);

  it("projects: the web terminal edits any project with ?project=, the glasses keep theirs until it is activated", async () => {
    const { base } = await start({}, cleanup);
    const { customers, active } = (await json(await fetch(base + "/api/customers"))).body;
    const other = (await json(await post(base, "/api/projects", { customerId: customers[0].id, name: "Zweiter Dreh" }))).body;
    expect((await post(base, "/api/prompter?project=" + other.id, { text: "Nur hier" })).status).toBe(200);
    expect((await json(await fetch(base + "/api/prompter?project=" + other.id))).body.text).toBe("Nur hier");
    expect((await json(await fetch(base + "/api/prompter"))).body.text).toBe("");
    expect((await post(base, "/api/equipment?project=" + other.id, { setneed: { name: "Gimbal", need: true } })).status).toBe(200);
    expect((await fetch(base + "/api/prompter?project=p_ffffffffffff")).status).toBe(404);
    expect((await json(await post(base, "/api/active", { id: other.id }))).body).toMatchObject({ active: "Zweiter Dreh", activeId: other.id });
    expect((await json(await fetch(base + "/api/shotlist"))).body.project).toBe("Zweiter Dreh");
    expect((await json(await fetch(base + "/api/equipment"))).body.need).toBe(1);
    // Move to another customer, then delete: the glasses fall back to the other project.
    const fresh = (await json(await post(base, "/api/customers", { name: "Neu" }))).body;
    expect((await json(await post(base, "/api/projects/" + other.id, { customerId: fresh.id }))).body.customerId).toBe(fresh.id);
    expect((await post(base, "/api/projects/" + other.id, { customerId: "c_000000000000" })).status).toBe(404);
    expect((await del(base, "/api/projects/" + other.id)).status).toBe(200);
    expect((await json(await fetch(base + "/api/customers"))).body.active).toBe(active);
  }, 10000);

  it("uploads: only PDF, PNG and JPEG, a size limit, and file names that can never become paths", async () => {
    const { base, dir } = await start({ SHOOT_MAX_UPLOAD_MB: "1" }, cleanup);
    const { active } = (await json(await fetch(base + "/api/customers"))).body;
    const pdf = makePdf();
    const stored = await json(await upload(base, active, "../../etc/bö<s>e:name.pdf", pdf));
    expect(stored.status).toBe(200);
    expect(stored.body).toMatchObject({ name: "bösename.pdf", type: "pdf", size: pdf.length });
    expect(stored.body.id).toMatch(/^f_[0-9a-f]{12}$/);
    const onDisk = join(dir, "shoot-day-files", active, stored.body.id + ".pdf");
    expect(existsSync(onDisk)).toBe(true);
    expect(readdirSync(join(dir, "shoot-day-files"))).toEqual([active]);
    const back = await fetch(base + "/api/projects/" + active + "/files/" + stored.body.id);
    expect(back.headers.get("content-type")).toBe("application/pdf");
    expect(back.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''b%C3%B6sename.pdf");
    expect(back.headers.get("content-security-policy")).toBe("sandbox");
    expect(Buffer.from(await back.arrayBuffer()).equals(pdf)).toBe(true);
    expect((await upload(base, active, "big.pdf", Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(1024 * 1024 + 10)]))).status).toBe(413);
    expect((await upload(base, active, "notes.pdf", Buffer.from("just text"))).status).toBe(415);
    expect((await upload(base, active, "photo.pdf", PNG)).status).toBe(415);
    expect((await upload(base, active, "script.exe", pdf)).status).toBe(415);
    const png = await json(await upload(base, active, "Foto.PNG", PNG));
    expect(png.body).toMatchObject({ type: "png", name: "Foto.png" });
    const jpeg = await json(await upload(base, active, "", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])));
    expect(jpeg.body).toMatchObject({ type: "jpg", name: "file.jpg" });
    expect((await del(base, "/api/projects/" + active + "/files/" + stored.body.id)).status).toBe(200);
    expect(existsSync(onDisk)).toBe(false);
    expect((await fetch(base + "/api/projects/" + active + "/files/" + stored.body.id)).status).toBe(404);
    expect((await fetch(base + "/api/projects/" + active + "/files/..%2F..%2Fdata.json")).status).toBe(404);
  }, 15000);

  it("storyboard from PDF: the text for manual entry without a model, scenes from a (fake) model, done flags from the glasses", async () => {
    const plain = await start({}, cleanup);
    const plainProject = (await json(await fetch(plain.base + "/api/customers"))).body.active;
    const file = (await json(await upload(plain.base, plainProject, "Storyboard.pdf", makePdf()))).body;
    const manual = (await json(await post(plain.base, "/api/projects/" + plainProject + "/files/" + file.id + "/storyboard", {}))).body;
    expect(manual).toMatchObject({ extracted: true, llm: "off", scenes: [], pages: 2 });
    expect(manual.text).toContain("Szene 1 (Intro)");
    const pictures = (await json(await upload(plain.base, plainProject, "scan.pdf", makePdf({ textless: true })))).body;
    expect((await json(await post(plain.base, "/api/projects/" + plainProject + "/files/" + pictures.id + "/storyboard", {}))).body)
      .toMatchObject({ extracted: false, llm: "off", scenes: [] });

    const llm = await fakeService(() => ({ choices: [{ message: { content: "```json\n{\"scenes\":[{\"n\":1,\"from\":\"0:00\",\"to\":\"0:05\",\"title\":\"Intro\",\"camera\":\"Totale\",\"overlay\":\"Hallo\"}]}\n```" } }] }), cleanup);
    const { base } = await start({ SHOOT_LLM_URL: llm.url + "/v1", SHOOT_LLM_MODEL: "test-model" }, cleanup);
    const project = (await json(await fetch(base + "/api/customers"))).body.active;
    const pdf = (await json(await upload(base, project, "Storyboard.pdf", makePdf()))).body;
    const proposal = (await json(await post(base, "/api/projects/" + project + "/files/" + pdf.id + "/storyboard?lang=de", {}))).body;
    expect(proposal).toMatchObject({ extracted: true, llm: "ok" });
    expect(proposal.scenes).toEqual([{ n: 1, from: 0, to: 5, title: "Intro", content: "", camera: "Totale", overlay: "Hallo", goal: "", done: false }]);
    expect(llm.seen[0].path).toBe("/v1/chat/completions");
    expect(llm.seen[0].body).toMatchObject({ model: "test-model", chat_template_kwargs: { enable_thinking: false } });
    expect(llm.seen[0].body.messages[1].content).toContain("Kamera: nah");
    const png = (await json(await upload(base, project, "a.png", PNG))).body;
    expect((await post(base, "/api/projects/" + project + "/files/" + png.id + "/storyboard", {})).status).toBe(400);

    // Reviewed and saved, then ticked on the glasses.
    const board = (await json(await post(base, "/api/projects/" + project + "/storyboards", { title: "Reel", source: pdf.name, scenes: proposal.scenes }))).body;
    expect(board.id).toMatch(/^s_/);
    const { storyboards } = (await json(await fetch(base + "/api/storyboard"))).body;
    expect(storyboards.map((b) => b.title)).toEqual(["Example reel", "Reel"]);
    expect((await json(await post(base, "/api/storyboard/scene", { storyboard: board.id, index: 0, done: true }))).body).toEqual({ ok: true, done: true });
    expect((await post(base, "/api/storyboard/scene", { storyboard: board.id, index: 7, done: true })).status).toBe(404);
    const saved = (await json(await fetch(base + "/api/projects/" + project))).body.storyboards.find((b) => b.id === board.id);
    expect(saved.scenes[0].done).toBe(true);
    expect((await del(base, "/api/projects/" + project + "/storyboards/" + board.id)).status).toBe(200);
  }, 20000);

  it("ideas with keywords for Babel, and the card before the appointment with Babel's memory", async () => {
    const babel = await fakeService((body) => ({ memory: true, entries: [{ id: "x", date: "2026-10-01T10:00:00", type: "session", title: "Erstgespräch", summary: "Will ein Reel im Herbst. " + body.query }] }), cleanup);
    const { base } = await start({ SHOOT_BABEL_URL: babel.url + "/v1", SHOOT_BABEL_TOKEN: "b4bel" }, cleanup);
    const clara = (await json(await post(base, "/api/customers", { name: "Clara Muster", company: "Muster GmbH", notes: "Kaffee schwarz." }))).body;
    const project = (await json(await post(base, "/api/projects", { customerId: clara.id, name: "Herbst-Reel" }))).body;
    const saved = (await json(await post(base, "/api/projects/" + project.id + "/ideas", {
      ideas: [{ text: "Drohnenflug bei Sonnenaufgang", tags: "Drohne, #Morgen" }, { text: "Schon umgesetzt", done: true }, { text: "  " }],
    }))).body.ideas;
    expect(saved.map((i) => [i.text, i.tags, i.done])).toEqual([["Drohnenflug bei Sonnenaufgang", ["drohne", "morgen"], false], ["Schon umgesetzt", [], true]]);
    const all = (await json(await fetch(base + "/api/ideas?customer=" + encodeURIComponent("clara muster")))).body.ideas;
    expect(all.map((i) => i.text)).toEqual(["Drohnenflug bei Sonnenaufgang", "Schon umgesetzt"]);
    expect(all[0]).toMatchObject({ customer: "Clara Muster", customerId: clara.id, project: "Herbst-Reel", tags: ["drohne", "morgen"] });
    expect((await json(await fetch(base + "/api/ideas?open=1&customer=" + clara.id))).body.ideas).toHaveLength(1);
    expect((await json(await fetch(base + "/api/ideas?customer=nobody"))).body.ideas).toEqual([]);
    const brief = (await json(await fetch(base + "/api/customers/" + clara.id + "/brief"))).body;
    expect(brief).toMatchObject({ name: "Clara Muster", notes: "Kaffee schwarz.", ideas: [{ text: "Drohnenflug bei Sonnenaufgang" }] });
    expect(brief.memory).toEqual([{ date: "2026-10-01T10:00:00", title: "Erstgespräch", summary: "Will ein Reel im Herbst. Clara Muster Muster GmbH" }]);
    expect(babel.seen[0]).toMatchObject({ path: "/memory/search", body: { query: "Clara Muster Muster GmbH", limit: 3 }, auth: "Bearer b4bel" });
  }, 10000);

  it("without Babel configured the card says nothing about it", async () => {
    const { base } = await start({}, cleanup);
    const { customers } = (await json(await fetch(base + "/api/customers"))).body;
    const brief = (await json(await fetch(base + "/api/customers/" + customers[0].id + "/brief"))).body;
    expect(brief.name).toBe("Example client");
    expect("memory" in brief).toBe(false);
    expect(brief.ideas.length).toBeGreaterThan(0);
  }, 10000);

  it("a data file it cannot read is put aside, never overwritten", async () => {
    const { dir } = await start({}, cleanup, (file) => writeFileSync(file, "{ not json"));
    const aside = readdirSync(dir).filter((name) => name.startsWith("data.json.broken-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]), "utf8")).toBe("{ not json");
  }, 10000);
});

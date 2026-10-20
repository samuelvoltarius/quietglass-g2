import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { INTERN, createWdSync, isoDate, stripDatePrefix, toolValue } from "../examples/shoot-day-wd.mjs";
import { cleanPoints } from "../examples/shoot-day-talkpoints.mjs";
import { analysisMessages, materialHash, projectSources } from "../examples/shoot-day-brain.mjs";

const TOKEN = "wd_test_0123456789abcdef";
const INBOX_TASK = 5000;

/** A one-page PDF with one line of text (made-up content for the tests). */
function textPdf(text) {
  const parts = [];
  const offsets = [];
  let size = 0;
  const push = (chunk) => { const b = Buffer.from(chunk, "latin1"); parts.push(b); size += b.length; };
  const object = (num, body) => { offsets[num] = size; push(`${num} 0 obj\n${body}\nendobj\n`); };
  const content = `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`;
  push("%PDF-1.4\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  object(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>");
  object(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  object(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = size;
  push("xref\n0 6\n0000000000 65535 f \n");
  for (let i = 1; i < 6; i++) push(String(offsets[i]).padStart(10, "0") + " 00000 n \n");
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/**
 * A fake Work Dashboard: POST /mcp, JSON-RPC "tools/call", bearer agent token,
 * results as MCP text content holding JSON. Records every tool call.
 */
async function fakeDashboard() {
  const db = {
    customers: [], projects: [], tasks: [], comments: [], attachments: [], team: {},
    users: [{ id: 1, name: "Alfred Beispiel", role: "owner", disabled: false }, { id: 2, name: "Sarah", role: "member", disabled: false }, { id: 3, name: "Max Alt", role: "member", disabled: true }],
  };
  const calls = [];
  const seen = { auth: [] };
  let fail = false;
  let next = 1;
  const id = () => next++;
  const tools = {
    list_customers: () => db.customers,
    create_customer: (a) => { const c = { id: id(), name: a.name, email: a.email ?? "", archived: false }; db.customers.push(c); return c; },
    update_customer: (a) => { const c = db.customers.find((x) => x.id === a.id); Object.assign(c, a); return c; },
    list_projects: () => ({ projects: db.projects }),
    create_project: (a) => { const p = { id: id(), customer_id: a.customer_id, name: a.name, archived: false }; db.projects.push(p); return p; },
    update_project: (a) => { const p = db.projects.find((x) => x.id === a.id); Object.assign(p, a); return p; },
    list_tasks: (a) => db.tasks.filter((t) => !a.project_id || t.project_id === a.project_id),
    create_task: (a) => { const { participant_ids: team = [], ...rest } = a; const t = { id: id(), status: "open", ...rest }; db.tasks.push(t); db.team[t.id] = [...team]; return t; },
    update_task: (a) => { const t = db.tasks.find((x) => x.id === a.id); Object.assign(t, a); return t; },
    delete_task: (a) => { const i = db.tasks.findIndex((x) => x.id === a.id); if (i < 0) throw new Error("no task"); db.tasks.splice(i, 1); return { deleted: true }; },
    list_comments: (a) => db.comments.filter((c) => c.task_id === a.task_id),
    create_comment: (a) => { const c = { id: id(), ...a }; db.comments.push(c); return c; },
    list_users: () => db.users,
    list_task_participants: (a) => ({ owner: 1, assignee_id: null, participant_ids: [...(db.team[a.task_id] ?? [])].sort() }),
    set_task_participants: (a) => { db.team[a.task_id] = [...a.participant_ids]; return db.tasks.find((t) => t.id === a.task_id); },
    attach_file: (a) => { const f = { id: id(), task_id: a.task_id, filename: a.filename, mime: a.mime, bytes: Buffer.from(a.content_base64, "base64").toString(), data: a.content_base64, size: Buffer.from(a.content_base64, "base64").length, uploaded_by_id: 99, created_at: "2026-10-15T08:00:00Z" }; db.attachments.push(f); return view(f); },
    // the inbox: files dropped without a project hang at one task of its own
    list_inbox: () => ({ task_id: INBOX_TASK, items: db.attachments.filter((f) => f.task_id === INBOX_TASK).map(view) }),
    list_attachments: (a) => db.attachments.filter((f) => f.task_id === a.task_id).map(view),
    read_attachment: (a) => { const f = db.attachments.find((x) => x.id === a.id); if (!f) throw new Error("no attachment"); return { ...view(f), content_base64: f.data }; },
    move_attachment: (a) => { const f = db.attachments.find((x) => x.id === a.id); if (!f) throw new Error("no attachment"); f.task_id = a.task_id; return view(f); },
  };
  const view = ({ bytes, data, ...rest }) => rest;
  /** Somebody uploads a file in the dashboard (to the inbox or to a task). */
  const drop = (taskId, filename, buffer, mime = "application/pdf") => {
    const f = { id: id(), task_id: taskId, filename, mime, bytes: buffer.toString(), data: buffer.toString("base64"), size: buffer.length, uploaded_by_id: 2, created_at: "2026-10-15T09:00:00Z" };
    db.attachments.push(f);
    return f;
  };
  const broken = new Set();
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.auth.push(request.headers.authorization);
      const reply = (status, value) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.url !== "/mcp" || request.method !== "POST") return reply(404, { detail: "not found" });
      if (request.headers.authorization !== "Bearer " + TOKEN) return reply(401, { detail: "bad token" });
      if (fail) return reply(500, { detail: "kaputt" });
      const message = JSON.parse(body);
      if (message.method !== "tools/call") return reply(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
      const { name, arguments: args } = message.params;
      calls.push({ name, args });
      const tool = tools[name];
      if (!tool || broken.has(name)) return reply(200, { jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: tool ? "broken" : "unknown tool" }] } });
      // Like the real dashboard: the text part is Python's str(data) (NOT JSON), the value is in structuredContent.result.
      let value;
      try { value = tool(args ?? {}); } catch (error) { return reply(200, { jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: error.message }] } }); }
      reply(200, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(value).replace(/"/g, "'").replace(/true/g, "True").replace(/false/g, "False") }], structuredContent: { result: value }, isError: false } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;
  return {
    url, db, calls, seen, drop, broken,
    set fail(value) { fail = value; },
    names: () => calls.map((c) => c.name),
    reset: () => { calls.length = 0; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const example = () => ({
  customers: {
    c_000000000001: { id: "c_000000000001", name: "Beispiel Café", company: "Beispiel Café GmbH", email: "info@example.com", phone: "+43 000 000", notes: "Mag ruhige Bilder." },
    unassigned: { id: "unassigned", name: "Ohne Zuordnung", company: "", email: "", phone: "", notes: "" },
  },
  projects: {
    p_000000000001: {
      id: "p_000000000001", customerId: "c_000000000001", name: "Imagefilm", date: "2026-10-20", place: "Beispielgasse 1",
      dispo: { date: "", call: "08:00", location: "", contact: "", notes: "", schedule: [{ time: "09:00", what: "Interview" }] },
      scenes: [{ scene: "1", shots: [{ shot: "A", desc: "Totale", size: "WS" }] }],
      storyboards: [{ id: "s_000000000001", title: "Reel", scenes: [{ n: 1, title: "Ankunft" }, { n: 2, title: "Hände" }] }],
      prompter: "Willkommen im Beispiel Café.",
      equipment: [{ group: "Kamera", name: "Kamera A", need: true, packed: false }],
      ideas: [
        { id: "i_000000000001", text: "14.10.: Logo als Vektor anfragen", tags: ["todo", "grafik"], done: false },
        { id: "i_000000000002", text: "Drohnenflug über den Gastgarten", tags: ["drohne"], done: false },
        { id: "i_000000000003", text: "Alte Idee", tags: [], done: true },
      ],
      talks: [],
    },
    p_000000000002: { id: "p_000000000002", customerId: "unassigned", name: "Lose Notizen", date: "", place: "", ideas: [], storyboards: [], scenes: [], talks: [] },
  },
  wdGone: [],
});

function setup(dash, state, options = {}) {
  const lines = [];
  let saves = 0;
  const sync = createWdSync({
    url: dash.url, token: TOKEN, getState: () => state, persist: async () => { saves++; },
    log: (line) => lines.push(line), retryMs: [], debounceMs: 30, timeZone: "Europe/Vienna", ...options,
  });
  return { sync, lines, saves: () => saves };
}

describe("Work Dashboard sync (shoot-day-wd.mjs)", () => {
  const cleanup = [];
  afterEach(async () => { for (const step of cleanup.splice(0)) await step(); });
  const dashboard = async () => { const d = await fakeDashboard(); cleanup.push(() => d.close()); return d; };

  it("helpers: dates, Babel's date prefix, tool results", () => {
    expect(isoDate("2026-10-20")).toBe("2026-10-20");
    expect(isoDate("3.4.2027")).toBe("2027-04-03");
    expect(isoDate("nächste Woche")).toBe("");
    expect(stripDatePrefix("14.10.: Logo anfragen")).toBe("Logo anfragen");
    expect(toolValue({ content: [{ type: "text", text: "{\"id\":5}" }] })).toEqual({ id: 5 });
    expect(toolValue({ structuredContent: { result: [1, 2] }, content: [] })).toEqual([1, 2]);
    expect(() => toolValue({ isError: true, content: [{ type: "text", text: "nope" }] })).toThrow(/nope/);
  });

  it("creates customer, project and tasks, skips 'Ohne Zuordnung', and stores the ids", async () => {
    const dash = await dashboard();
    const state = example();
    const { sync } = setup(dash, state);
    const result = await sync.syncAll();
    expect(result.ok).toBe(true);
    expect(dash.seen.auth.every((a) => a === "Bearer " + TOKEN)).toBe(true);
    expect(dash.db.customers).toEqual([expect.objectContaining({ name: "Beispiel Café", email: "info@example.com" })]);
    expect(dash.db.projects).toEqual([expect.objectContaining({ name: "Imagefilm", customer_id: dash.db.customers[0].id })]);
    const byTitle = Object.fromEntries(dash.db.tasks.map((t) => [t.title, t]));
    expect(Object.keys(byTitle).sort()).toEqual(["Drehvorbereitung", "Ideen & Notizen", "Logo als Vektor anfragen", "Termin: Imagefilm"]);
    expect(byTitle["Termin: Imagefilm"]).toMatchObject({ start_date: "2026-10-20", due_date: "2026-10-20" });
    expect(byTitle["Termin: Imagefilm"].description).toContain("Beispielgasse 1");
    expect(byTitle["Ideen & Notizen"].description).toContain("Drohnenflug über den Gastgarten");
    expect(byTitle["Ideen & Notizen"].description).toContain("+43 000 000");
    expect(byTitle["Ideen & Notizen"].description).toContain("Mag ruhige Bilder.");
    expect(byTitle["Ideen & Notizen"].description).not.toContain("Alte Idee");
    expect(byTitle["Ideen & Notizen"].description).not.toContain("Logo");
    expect(byTitle["Drehvorbereitung"].description).toMatch(/Storyboards \(1\)[\s\S]*Ankunft[\s\S]*Shotlist[\s\S]*Skript/);
    expect(byTitle["Logo als Vektor anfragen"]).toMatchObject({ labels: ["grafik"], status: "open" });
    expect(dash.db.projects.some((p) => p.name === "Lose Notizen")).toBe(false);
    const p = state.projects.p_000000000001;
    expect(state.customers.c_000000000001.wdId).toBe(dash.db.customers[0].id);
    expect(p.wdId).toBe(dash.db.projects[0].id);
    expect(Object.keys(p.wdTasks).sort()).toEqual(["drehvorbereitung", "ideen", "termin", "todo"]);
    expect(p.wdTasks.todo.i_000000000001).toBe(byTitle["Logo als Vektor anfragen"].id);
    expect(state.customers.unassigned.wdId).toBeUndefined();
    expect(sync.status()).toMatchObject({ enabled: true, lastError: null, pending: 0 });
  });

  it("a second sync without changes sends nothing", async () => {
    const dash = await dashboard();
    const state = example();
    const { sync } = setup(dash, state);
    await sync.syncAll();
    dash.reset();
    const again = await sync.syncAll();
    expect(again).toEqual({ ok: true, sent: 0 });
    expect(dash.calls).toEqual([]);
  });

  it("a change is sent as an update, nothing else; a done #todo idea becomes a done task", async () => {
    const dash = await dashboard();
    const state = example();
    const { sync } = setup(dash, state);
    await sync.syncAll();
    dash.reset();
    const p = state.projects.p_000000000001;
    p.name = "Imagefilm Frühstück";
    p.ideas[0] = { ...p.ideas[0], done: true };
    await sync.syncAll();
    expect(dash.names().sort()).toEqual(["update_project", "update_task", "update_task"]);
    expect(dash.db.projects[0].name).toBe("Imagefilm Frühstück");
    expect(dash.db.tasks.find((t) => t.title === "Logo als Vektor anfragen").status).toBe("done");
    expect(dash.db.tasks.find((t) => t.title.startsWith("Termin:")).title).toBe("Termin: Imagefilm Frühstück");
    expect(dash.db.projects).toHaveLength(1);
  });

  it("matches an existing dashboard customer by name (any case) instead of creating a duplicate", async () => {
    const dash = await dashboard();
    dash.db.customers.push({ id: 77, name: "BEISPIEL CAFÉ", email: "", archived: false }, { id: 78, name: "Anderer Kunde", archived: false });
    const state = example();
    const { sync } = setup(dash, state);
    await sync.syncAll();
    expect(dash.names()).not.toContain("create_customer");
    expect(dash.db.customers).toHaveLength(2);
    expect(state.customers.c_000000000001.wdId).toBe(77);
    expect(dash.db.projects[0].customer_id).toBe(77);
  });

  it("a talk becomes one comment on the Termin task, only once; without a date on a 'Gespräche' task", async () => {
    const dash = await dashboard();
    const state = example();
    const { sync } = setup(dash, state);
    await sync.syncAll();
    const p = state.projects.p_000000000001;
    p.talks.push({ id: "t_000000000001", at: Date.UTC(2026, 9, 14, 9, 5), summary: "- Barista statt Drohne", cues: [{ title: "Color Codes", text: "HEX anfordern", kind: "tipp" }] });
    dash.reset();
    await sync.syncAll();
    expect(dash.names()).toEqual(["create_comment"]);
    const termin = dash.db.tasks.find((t) => t.title.startsWith("Termin:"));
    expect(dash.db.comments[0].task_id).toBe(termin.id);
    expect(dash.db.comments[0].body).toBe(INTERN + "\n\nGespräch 14.10. 11:05 – Zusammenfassung\n- Barista statt Drohne\n\nTipp-Karten:\n- Color Codes: HEX anfordern");
    expect(p.talks[0].wdComment).toBeTruthy();
    dash.reset();
    await sync.syncAll();
    expect(dash.calls).toEqual([]);

    const undated = example();
    undated.projects.p_000000000001.date = "";
    undated.projects.p_000000000001.talks.push({ id: "t_000000000002", at: Date.now(), summary: "Kurz", cues: [] });
    const dash2 = await dashboard();
    await setup(dash2, undated).sync.syncAll();
    expect(dash2.db.tasks.some((t) => t.title.startsWith("Termin:"))).toBe(false);
    const talks = dash2.db.tasks.find((t) => t.title === "Gespräche");
    expect(dash2.db.comments).toEqual([expect.objectContaining({ task_id: talks.id })]);
  });

  it("a tick in the dashboard is never undone by a later change in Shoot Day; a done idea still goes over", async () => {
    const dash = await dashboard();
    const state = example();
    const { sync } = setup(dash, state);
    await sync.syncAll();
    const task = dash.db.tasks.find((t) => t.title === "Logo als Vektor anfragen");
    task.status = "done"; // ticked over there
    const p = state.projects.p_000000000001;
    p.ideas[0] = { ...p.ideas[0], text: "14.10.: Logo als Vektor anfragen (SVG)" };
    dash.reset();
    await sync.syncAll();
    expect(dash.names()).toEqual(["update_task"]);
    expect(dash.calls[0].args).not.toHaveProperty("status");
    expect(task).toMatchObject({ title: "Logo als Vektor anfragen (SVG)", status: "done" });
    // reopened over there, done in Shoot Day → done again
    task.status = "open";
    p.ideas[0] = { ...p.ideas[0], done: true };
    await sync.syncAll();
    expect(task.status).toBe("done");
  });

  it("talk points become proposals: one overview, one task per needed point and next step, each only once", async () => {
    const dash = await dashboard();
    const state = example();
    const { sync } = setup(dash, state);
    await sync.syncAll();
    const p = state.projects.p_000000000001;
    p.talks.push({
      id: "t_000000000001", at: Date.UTC(2026, 9, 14, 9, 5), summary: "- Drohne über den Garten", cues: [],
      points: cleanPoints({
        needed: ["Drohnengenehmigung", "Einverständnis der Mitarbeiter"],
        questions: ["Drehtag Samstag möglich?"],
        promises: [{ who: "Kunde", text: "Logo als Vektor", due: "2026-10-17" }],
        next: [{ text: "Angebot schicken", due: "2026-10-16" }],
      }),
    });
    dash.reset();
    await sync.syncAll();
    expect(dash.names().sort()).toEqual(["create_comment", "create_task", "create_task", "create_task", "create_task"]);
    const proposals = dash.db.tasks.filter((t) => t.title.startsWith("Vorschlag: "));
    expect(proposals.map((t) => t.title).sort()).toEqual([
      "Vorschlag: Benötigt: Drohnengenehmigung",
      "Vorschlag: Benötigt: Einverständnis der Mitarbeiter",
      "Vorschlag: Nächster Schritt: Angebot schicken",
      "Vorschlag: Offen aus Gespräch 14.10. 11:05",
    ]);
    expect(proposals.every((t) => t.status === "open" && t.labels?.[0] === "vorschlag")).toBe(true);
    expect(proposals.find((t) => t.title.includes("Angebot")).due_date).toBe("2026-10-16");
    const overview = proposals.find((t) => t.title.includes("Offen aus"));
    expect(overview.description).toContain("Offene Fragen an den Kunden (1):\n- Drehtag Samstag möglich?");
    expect(overview.description).toContain("Zusagen (1):\n- Kunde: Logo als Vektor (bis 17.10.)");
    expect(p.talks[0].wdPoints).toBe(overview.id);

    // edited and ticked over there: the next sync leaves everything alone
    const drone = proposals.find((t) => t.title.includes("Drohnengenehmigung"));
    drone.title = "Drohnengenehmigung beantragen";
    drone.status = "done";
    dash.reset();
    await sync.syncAll();
    expect(dash.calls).toEqual([]);

    // a second talk repeats one point: only the new overview and the new point
    p.talks.push({
      id: "t_000000000002", at: Date.UTC(2026, 9, 15, 8, 0), summary: "- Nachtelefoniert", cues: [],
      points: cleanPoints({ needed: ["drohnengenehmigung.", "Drehgenehmigung Gemeinde"] }),
    });
    dash.reset();
    await sync.syncAll();
    const created = dash.calls.filter((c) => c.name === "create_task").map((c) => c.args.title).sort();
    expect(created).toEqual(["Vorschlag: Benötigt: Drehgenehmigung Gemeinde", "Vorschlag: Offen aus Gespräch 15.10. 10:00"]);
    expect(drone).toMatchObject({ title: "Drohnengenehmigung beantragen", status: "done" });

    // a talk with nothing open files no overview, but is marked as handled
    p.talks.push({ id: "t_000000000003", at: Date.now(), summary: "Smalltalk", cues: [], points: cleanPoints({}) });
    dash.reset();
    await sync.syncAll();
    expect(dash.names()).toEqual(["create_comment"]);
    expect(p.talks[2].wdPoints).toBe("none");
  });

  it("a customer's team is on every task of its projects, also on tasks made by hand; only added, never removed", async () => {
    const dash = await dashboard();
    const state = example();
    state.customers.c_000000000001.team = ["sarah", "Alfred", "Max Alt", "Niemand"];
    const { sync, lines } = setup(dash, state);
    await sync.syncAll();
    const tasks = dash.db.tasks;
    expect(tasks.length).toBe(4);
    expect(tasks.every((t) => JSON.stringify(dash.db.team[t.id]) === "[1,2]")).toBe(true); // given right at creation
    expect(dash.names().filter((n) => n === "set_task_participants")).toEqual([]);
    expect(lines.filter((l) => l.includes("no user named"))).toEqual([
      'work dashboard: no user named "Max Alt" for a customer team',   // disabled
      'work dashboard: no user named "Niemand" for a customer team',
    ]);
    // a task made by hand over there, with someone else on it
    const manual = { id: 900, project_id: tasks[0].project_id, title: "Requisiten besorgen", status: "open" };
    dash.db.tasks.push(manual); dash.db.team[900] = [7];
    dash.reset();
    await sync.syncAll();
    expect(dash.names()).toEqual(["list_users", "list_tasks", "list_task_participants", "set_task_participants"]);
    expect(dash.db.team[900]).toEqual([7, 1, 2]);
    // nothing new: only the look over there
    dash.reset();
    await sync.syncAll();
    expect(dash.names()).toEqual(["list_users", "list_tasks"]);
    // the other project (no customer team) is left alone
    expect(dash.calls.every((c) => c.name !== "list_tasks" || c.args.project_id === tasks[0].project_id)).toBe(true);
  });

  it("drafts are attached to the task of their point, drafts by hand to 'Unterlagen'; each file once", async () => {
    const dash = await dashboard();
    const state = example();
    const p = state.projects.p_000000000001;
    p.files = [
      { id: "f_000000000001", name: "Entwurf – Zustimmung Grundeigentümer Drohnenflug – Imagefilm.pdf", type: "pdf" },
      { id: "f_000000000002", name: "Entwurf – Einverständnis Bild- und Tonaufnahmen – Imagefilm.pdf", type: "pdf" },
      { id: "f_000000000003", name: "Entwurf – Drehgenehmigung – Imagefilm.pdf", type: "pdf" },
    ];
    p.drafts = [
      { template: "drohne", files: ["f_000000000001"], at: 1 },
      { template: "einverstaendnis", files: ["f_000000000002"], at: 2, manual: true },
      { template: "drehgenehmigung", files: ["f_000000000003"], at: 3 },   // its talk is not filed yet
    ];
    p.talks.push({ id: "t_000000000001", at: Date.UTC(2026, 9, 14, 9, 5), summary: "-", cues: [],
      points: cleanPoints({ needed: [{ text: "Drohnengenehmigung", docs: ["f_000000000001"] }] }) });
    const read = [];
    const { sync } = setup(dash, state, { readDraft: async (pid, file) => { read.push(file.id); return Buffer.from("%PDF-" + file.id); } });
    await sync.syncAll();
    const drone = dash.db.tasks.find((t) => t.title === "Vorschlag: Benötigt: Drohnengenehmigung");
    const docs = dash.db.tasks.find((t) => t.title === "Unterlagen");
    expect(drone.description).toContain("Entwurf hängt an dieser Aufgabe (Anhänge, zum Herunterladen):\n- Entwurf – Zustimmung Grundeigentümer Drohnenflug – Imagefilm.pdf");
    expect(drone.description).not.toContain("http");
    expect(dash.db.tasks.find((t) => t.title.startsWith("Vorschlag: Offen")).description)
      .toContain("- Drohnengenehmigung\n  → Entwurf (Anhang der Aufgabe dazu): Entwurf – Zustimmung Grundeigentümer Drohnenflug – Imagefilm.pdf");
    expect(dash.db.attachments.map((a) => [a.task_id, a.filename, a.mime, a.bytes])).toEqual([
      [drone.id, "Entwurf – Zustimmung Grundeigentümer Drohnenflug – Imagefilm.pdf", "application/pdf", "%PDF-f_000000000001"],
      [docs.id, "Entwurf – Einverständnis Bild- und Tonaufnahmen – Imagefilm.pdf", "application/pdf", "%PDF-f_000000000002"],
    ]);
    expect(read).toEqual(["f_000000000001", "f_000000000002"]);
    dash.reset();
    await sync.syncAll();
    expect(dash.calls).toEqual([]);
    // a vanished PDF on disk: nothing attached, tried again later
    const gone = example();
    gone.projects.p_000000000001.files = [{ id: "f_000000000009", name: "x.pdf", type: "pdf" }];
    gone.projects.p_000000000001.drafts = [{ template: "einverstaendnis", files: ["f_000000000009"], at: 1, manual: true }];
    const dash2 = await dashboard();
    await setup(dash2, gone, { readDraft: async () => null }).sync.syncAll();
    expect(dash2.db.attachments).toEqual([]);
    expect(gone.projects.p_000000000001.wdTasks.attached).toBeUndefined();
  });

  it("the project understanding: 'Projektlage (KI)' kept current, the old text as comment; drafts on every task they belong to", async () => {
    const dash = await dashboard();
    const state = example();
    const p = state.projects.p_000000000001;
    p.ideas.push({ id: "i_000000000004", text: "Vordrucke Einverständnis Mitarbeitende", tags: ["todo"], done: false });
    p.files = [{ id: "f_000000000001", name: "Entwurf – Einverständnis Bild- und Tonaufnahmen – Imagefilm.pdf", type: "pdf" },
      { id: "f_000000000002", name: "Entwurf – Hinweisschild Gäste Drehtag – Imagefilm.pdf", type: "pdf" }];
    p.drafts = [{ template: "einverstaendnis", files: ["f_000000000001"], at: 1 }, { template: "hinweisschild", files: ["f_000000000002"], at: 2 }];
    p.brain = { hash: "x", at: Date.UTC(2026, 9, 15, 11, 0), sources: 7, analysis: {
      lage: "Imagefilm für ein Café mit Drohne über dem Gastgarten.",
      zusammenhaenge: ["Drohne über dem Gastgarten → Gäste im Bild → Hinweisschild und Einverständnis"],
      unterlagen: [
        { template: "einverstaendnis", label: "Einverständnis Bild- und Tonaufnahmen", warum: "Mitarbeitende sind im Bild", quellen: ["idea:i_000000000004", "idea:i_000000000001"], sourceTitles: ["To-do: Vordrucke Einverständnis Mitarbeitende", "To-do: Logo als Vektor anfragen"], angaben: {}, files: ["f_000000000001"] },
        { template: "hinweisschild", label: "Hinweisschild für Gäste", warum: "Gäste im Bild", quellen: ["board:s_000000000001"], sourceTitles: ["Storyboard Reel"], angaben: {}, files: ["f_000000000002"] },
      ],
      offen: ["Drehtag bestätigen"],
    } };
    const { sync } = setup(dash, state, { readDraft: async (pid, file) => Buffer.from("%PDF-" + file.id) });
    await sync.syncAll();
    const lage = dash.db.tasks.find((t) => t.title === "Projektlage (KI)");
    expect(lage.labels).toEqual(["ki", "intern"]);
    expect(lage.description.startsWith(INTERN)).toBe(true);
    expect(lage.description).toContain("Stand 15.10. 13:00 · lokales Sprachmodell · 7 Quellen");
    expect(lage.description).toContain("Zusammenhänge\n- Drohne über dem Gastgarten → Gäste im Bild → Hinweisschild und Einverständnis");
    expect(lage.description).toContain("- Einverständnis Bild- und Tonaufnahmen: Mitarbeitende sind im Bild\n  Entwurf hängt an: „To-do: Vordrucke Einverständnis Mitarbeitende“, „To-do: Logo als Vektor anfragen“");
    expect(lage.description).toContain("Offene Punkte\n- Drehtag bestätigen");
    const todo4 = dash.db.tasks.find((t) => t.title === "Vordrucke Einverständnis Mitarbeitende");
    const todo1 = dash.db.tasks.find((t) => t.title === "Logo als Vektor anfragen");
    const sign = dash.db.tasks.find((t) => t.title === "Vorschlag: Benötigt: Hinweisschild für Gäste");
    expect(dash.db.attachments.map((a) => [a.task_id, a.filename])).toEqual([
      [todo4.id, "Entwurf – Einverständnis Bild- und Tonaufnahmen – Imagefilm.pdf"],
      [todo1.id, "Entwurf – Einverständnis Bild- und Tonaufnahmen – Imagefilm.pdf"],
      [sign.id, "Entwurf – Hinweisschild Gäste Drehtag – Imagefilm.pdf"],
    ]);
    // unchanged: nothing
    dash.reset();
    await sync.syncAll();
    expect(dash.calls).toEqual([]);
    // a new understanding: the task is rewritten, the old text becomes a comment
    const oldText = lage.description;
    p.brain = { ...p.brain, at: Date.UTC(2026, 9, 16, 9, 0), analysis: { ...p.brain.analysis, offen: ["Drehtag bestätigen", "Parkplatz klären"] } };
    dash.reset();
    await sync.syncAll();
    expect(dash.names().sort()).toEqual(["create_comment", "update_task"]);
    expect(lage.description).toContain("- Parkplatz klären");
    expect(dash.db.comments.at(-1)).toMatchObject({ task_id: lage.id, body: "Früherer Stand:\n\n" + oldText });
  });

  it("a dashboard task named as source gets the draft; an internal draft only goes to its own internal task", async () => {
    const dash = await dashboard();
    const state = example();
    const p = state.projects.p_000000000001;
    p.files = [{ id: "f_000000000001", name: "Entwurf – Bestätigung Team am Drehort – Kunde.pdf", type: "pdf" },
      { id: "f_000000000002", name: "Entwurf – INTERN Praktikumsvereinbarung – Kunde.pdf", type: "pdf" }];
    p.drafts = [{ template: "teambestaetigung", files: ["f_000000000001"], at: 1 }, { template: "praktikum", files: ["f_000000000002"], at: 2 }];
    const { sync } = setup(dash, state, { readDraft: async (pid, file) => Buffer.from("%PDF-" + file.id), isInternal: (t) => t === "praktikum" });
    await sync.syncAll();
    const logo = dash.db.tasks.find((t) => t.title === "Logo als Vektor anfragen");
    p.brain = { hash: "x", at: 1, sources: 3, analysis: { lage: "x", zusammenhaenge: [], offen: [], unterlagen: [
      { template: "teambestaetigung", label: "Bestätigung Team am Drehort (für den Kunden)", quellen: ["dash:" + logo.id], files: ["f_000000000001"], angaben: {} },
      // an older stored analysis without the flag: the sync knows internal templates itself
      { template: "praktikum", label: "Praktikumsvereinbarung (INTERN)", quellen: ["dash:" + logo.id], files: ["f_000000000002"], angaben: {} },
    ] } };
    await sync.syncAll();
    const at = (fileName) => dash.db.attachments.filter((a) => a.filename === fileName).map((a) => dash.db.tasks.find((t) => t.id === a.task_id));
    expect(at("Entwurf – Bestätigung Team am Drehort – Kunde.pdf").map((t) => t.title)).toEqual(["Logo als Vektor anfragen"]);   // straight to the task named as source
    const internal = at("Entwurf – INTERN Praktikumsvereinbarung – Kunde.pdf");
    expect(internal.map((t) => t.title)).toEqual(["Vorschlag: Benötigt: Praktikumsvereinbarung (INTERN)"]);   // never at the customer's task
    expect(internal[0].labels).toEqual(["vorschlag", "intern"]);
    expect(internal[0].description.startsWith(INTERN)).toBe(true);
  });

  it("never deletes: a deleted #todo idea keeps its task with a note, a deleted project is archived", async () => {
    const dash = await dashboard();
    const state = example();
    const { sync } = setup(dash, state);
    await sync.syncAll();
    const p = state.projects.p_000000000001;
    p.ideas = p.ideas.filter((i) => i.id !== "i_000000000001");
    dash.reset();
    await sync.syncAll();
    const todo = dash.db.tasks.find((t) => t.title === "Logo als Vektor anfragen");
    expect(todo.description).toContain("(in Shoot Day gelöscht)");
    expect(dash.names().filter((n) => n.startsWith("delete"))).toEqual([]);
    dash.reset();
    await sync.syncAll();
    expect(dash.calls).toEqual([]);

    state.wdGone.push({ kind: "project", wdId: p.wdId });
    delete state.projects.p_000000000001;
    await sync.syncAll();
    expect(dash.names()).toEqual(["update_project"]);
    expect(dash.db.projects[0].archived).toBe(true);
    expect(state.wdGone).toEqual([]);
  });

  it("schedule() waits for the last save (debounce) and runs once", async () => {
    const dash = await dashboard();
    const state = example();
    const { sync } = setup(dash, state, { debounceMs: 60 });
    sync.schedule("p_000000000001");
    sync.schedule("p_000000000001");
    expect(sync.status().pending).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    sync.schedule("p_000000000001");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(dash.calls).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await sync.flush();
    expect(dash.names().filter((n) => n === "create_project")).toHaveLength(1);
  });

  it("failures are kept in the status, retried, and never show the URL or the token", async () => {
    const dash = await dashboard();
    dash.fail = true;
    const state = example();
    const { sync, lines } = setup(dash, state, { retryMs: [20] });
    expect(() => sync.schedule("p_000000000001")).not.toThrow();
    const result = await sync.syncAll();
    expect(result.ok).toBe(false);
    expect(sync.status().lastError).toMatch(/HTTP 500/);
    dash.fail = false;
    await new Promise((resolve) => setTimeout(resolve, 80));
    await sync.flush();
    expect(sync.status().lastError).toBeNull();
    expect(dash.db.projects).toHaveLength(1);
    const host = new URL(dash.url).host;
    for (const line of lines) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(host);
    }
    // unreachable: the error names no address either
    const gone = setup({ url: "http://127.0.0.1:9" }, example(), { timeoutMs: 2000 });
    const down = await gone.sync.syncAll();
    expect(down.ok).toBe(false);
    expect(down.error).toMatch(/network error/);
    expect(gone.lines.join("\n")).not.toContain("127.0.0.1:9");
  });

  it("reads back what people did in the dashboard for the project understanding – never Shoot Day's own text", async () => {
    const dash = await dashboard();
    const state = example();
    const p = state.projects.p_000000000001;
    p.talks = [{ id: "t_000000000001", at: Date.UTC(2026, 9, 14, 9), summary: "- Ruhige Bilder bitte", cues: [] }];
    p.brain = { hash: "x", at: 1, analysis: { lage: "KI-Überblick zum Café", zusammenhaenge: [], unterlagen: [], offen: [] } };
    const { sync } = setup(dash, state);
    expect((await sync.syncAll()).ok).toBe(true);
    const projectId = dash.db.projects[0].id;
    const byTitle = () => Object.fromEntries(dash.db.tasks.map((t) => [t.title, t]));
    const lage = byTitle()["Projektlage (KI)"];
    expect(lage.description).toContain("KI-Überblick zum Café");
    expect(dash.db.comments.some((c) => c.body.startsWith(INTERN + "\n\nGespräch "))).toBe(true);
    // what people did there: a task of their own (done), comments, an earlier Projektlage kept as comment
    dash.db.tasks.push({ id: 900, project_id: projectId, title: "Location besichtigen", description: "Schlüssel bei Frau Test", status: "done", due_date: "2026-10-18" });
    dash.db.comments.push({ id: 901, task_id: 900, body: "War dort, Strom im Hof vorhanden." });
    dash.db.comments.push({ id: 902, task_id: byTitle()["Termin: Imagefilm"].id, body: "Kunde will schon um 9 Uhr anfangen." });
    dash.db.comments.push({ id: 903, task_id: byTitle()["Termin: Imagefilm"].id, body: "Früherer Stand:\n\nalter KI-Text" });
    dash.db.comments.push({ id: 904, task_id: lage.id, body: "Mensch schreibt in die Projektlage" });
    dash.db.comments.push({ id: 905, task_id: byTitle()["Logo als Vektor anfragen"].id, body: "Logo kommt per Mail." });
    dash.reset();

    const back = await sync.readBack("p_000000000001");
    expect(dash.names().every((n) => n === "list_tasks" || n === "list_comments")).toBe(true);   // read-only
    const got = Object.fromEntries(back.map((t) => [t.title, t]));
    expect(got["Projektlage (KI)"]).toBeUndefined();
    expect(got["Location besichtigen"]).toEqual({ taskId: "900", title: "Location besichtigen", status: "done", due_date: "2026-10-18", description: "Schlüssel bei Frau Test", comments: ["War dort, Strom im Hof vorhanden."] });
    // tasks the sync made: title, status and human comments only
    expect(got["Termin: Imagefilm"]).toMatchObject({ description: "", comments: ["Kunde will schon um 9 Uhr anfangen."] });
    expect(got["Ideen & Notizen"]).toBeUndefined();   // made by the sync, untouched over there: nothing new for the model
    expect(got["Logo als Vektor anfragen"]).toMatchObject({ status: "open", description: "", comments: ["Logo kommt per Mail."] });

    const sources = projectSources(p, state.customers.c_000000000001, [], back);
    const dashText = sources.filter((s) => s.id.startsWith("dash:")).map((s) => s.title + "\n" + s.text).join("\n");
    expect(sources.find((s) => s.id === "dash:900").text).toContain("Status: done");
    for (const own of ["KI-Überblick", "Früherer Stand", "alter KI-Text", "Ruhige Bilder", "Mensch schreibt in die Projektlage", "Drohnenflug über den Gastgarten"]) expect(dashText).not.toContain(own);
    expect(analysisMessages(sources)[0].content).toContain("„done“ heißt erledigt");

    // the fingerprint: one list_tasks (+ the attachments of each task); the Projektlage does not count, a change there by people does
    dash.reset();
    const before = await sync.fingerprint("p_000000000001");
    expect(dash.names()[0]).toBe("list_tasks");
    expect(dash.names().slice(1).every((n) => n === "list_attachments")).toBe(true);
    lage.description = "neuer KI-Text";
    expect(await sync.fingerprint("p_000000000001")).toBe(before);
    dash.db.tasks.find((t) => t.id === 900).status = "open";
    const after = await sync.fingerprint("p_000000000001");
    expect(after).not.toBe(before);
    // a file uploaded to a task is noticed, too; a dashboard without attachments only leaves them out
    dash.drop(900, "Lageplan.pdf", textPdf("Lageplan"));
    const withFile = await sync.fingerprint("p_000000000001");
    expect(withFile).not.toBe(after);
    dash.broken.add("list_attachments");
    expect(await sync.fingerprint("p_000000000001")).toEqual(expect.any(String));
    dash.broken.clear();
    dash.db.attachments.pop();
    expect(materialHash(projectSources(p, state.customers.c_000000000001, [], await sync.readBack("p_000000000001")))).not.toBe(materialHash(sources));
    expect(await sync.fingerprint("p_000000000002")).toBe("");   // not in the dashboard

    // a failing dashboard: null, never a throw
    dash.fail = true;
    expect(await sync.readBack("p_000000000001")).toBeNull();
    expect(await sync.fingerprint("p_000000000001")).toBeNull();
    const off = createWdSync({ url: "", token: "", getState: () => state, persist: async () => undefined });
    expect(await off.readBack("p_000000000001")).toBeNull();
  });

  it("files in the dashboard: inbox, reading, moving, comments, a project's uploads without Shoot Day's own; never a throw", async () => {
    const dash = await dashboard();
    const state = example();
    const { sync, lines } = setup(dash, state);
    expect((await sync.syncAll()).ok).toBe(true);
    const p = state.projects.p_000000000001;
    const termin = p.wdTasks.termin;
    const pdf = textPdf("Angebot Beispiel");
    const dropped = dash.drop(INBOX_TASK, "Angebot.pdf", pdf);
    dash.reset();
    const box = await sync.inbox();
    expect(box).toEqual({ taskId: INBOX_TASK, items: [expect.objectContaining({ id: dropped.id, filename: "Angebot.pdf", mime: "application/pdf", size: pdf.length })] });
    expect(box.items[0]).not.toHaveProperty("content_base64");
    expect((await sync.readAttachment(dropped.id)).equals(pdf)).toBe(true);
    expect(await sync.readAttachment(99999)).toBeNull();
    expect(await sync.moveAttachment(dropped.id, termin)).toMatchObject({ id: dropped.id, task_id: termin });
    expect(await sync.comment(termin, "Hallo")).toEqual(expect.any(Number));
    expect(dash.db.comments.at(-1)).toMatchObject({ task_id: termin, body: "Hallo" });
    expect((await sync.openTasks("p_000000000001")).map((t) => t.title)).toContain("Termin: Imagefilm");
    // a project's uploads: the moved file and one by hand – not a draft, not what Shoot Day attached itself
    dash.drop(termin, "Entwurf – Einverständnis – Imagefilm.pdf", textPdf("Entwurf"));
    const ours = dash.drop(termin, "Logo.png", Buffer.from("not really a png"), "image/png");
    p.wdTasks.attached = { [termin + ":f_000000000009"]: ours.id };
    const hand = dash.drop(p.wdTasks.ideen, "Moodboard.pdf", textPdf("Moodboard"));
    expect((await sync.projectAttachments("p_000000000001")).map((a) => [a.taskId, a.id, a.filename])).toEqual([
      [termin, dropped.id, "Angebot.pdf"], [p.wdTasks.ideen, hand.id, "Moodboard.pdf"],
    ]);
    expect(await sync.projectAttachments("p_000000000002")).toEqual([]);
    // "Unterlagen": created once, the same task the hand-written drafts go to
    const docs = await sync.docsTask("p_000000000001");
    expect(dash.db.tasks.find((t) => t.id === docs).title).toBe("Unterlagen");
    expect(await sync.docsTask("p_000000000001")).toBe(docs);
    expect(dash.db.tasks.filter((t) => t.title === "Unterlagen")).toHaveLength(1);
    expect(p.wdTasks.points.unterlagen).toBe(docs);
    // a broken dashboard: null everywhere, nothing thrown, nothing secret in the log
    dash.fail = true;
    expect(await sync.inbox()).toBeNull();
    expect(await sync.readAttachment(dropped.id)).toBeNull();
    expect(await sync.moveAttachment(dropped.id, termin)).toBeNull();
    expect(await sync.comment(termin, "x")).toBeNull();
    expect(await sync.openTasks("p_000000000001")).toBeNull();
    expect(await sync.projectAttachments("p_000000000001")).toBeNull();
    expect(lines.join("\n")).toContain("work dashboard: inbox failed");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("appointment proposals of the understanding: each once as an event with labels, never touched again", async () => {
    const dash = await dashboard();
    const state = example();
    const p = state.projects.p_000000000001;
    p.brain = { hash: "x", at: Date.UTC(2026, 9, 20, 9, 0), sources: 3, analysis: {
      lage: "Imagefilm.", zusammenhaenge: [], unterlagen: [], offen: [],
      termine: [
        { titel: "Drehtag 1", datum: "2026-10-22", von: "08:00", bis: "16:00", ort: "Beispielgasse 1", grund: "Donnerstag, kein Ruhetag", quellen: [] },
        { titel: "Drehtag 2 (ganztägig)", datum: "2026-10-29", von: "", bis: "", ort: "", grund: "", quellen: [] },
      ],
    } };
    const { sync } = setup(dash, state);
    await sync.syncAll();
    const events = dash.db.tasks.filter((t) => t.is_event);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      title: "Drehtag 1", is_event: true, labels: ["vorschlag", "termin"], status: "open", location: "Beispielgasse 1",
      starts_at: "2026-10-22T08:00:00+02:00", ends_at: "2026-10-22T16:00:00+02:00", start_date: "2026-10-22", due_date: "2026-10-22",
    });
    expect(events[0].description).toBe("Donnerstag, kein Ruhetag\n\nVorschlag der KI – bitte bestätigen oder löschen.");
    expect(events[1]).toMatchObject({ title: "Drehtag 2 (ganztägig)", starts_at: null, ends_at: null, location: null, start_date: "2026-10-29" });
    expect(dash.db.comments).toEqual([]);   // no notifications
    // confirmed and moved in the dashboard, the other deleted: a new understanding with the same proposals changes nothing
    Object.assign(events[0], { labels: ["termin"], starts_at: "2026-10-22T09:00:00+02:00" });
    dash.db.tasks.splice(dash.db.tasks.indexOf(events[1]), 1);
    p.brain = { ...p.brain, at: Date.UTC(2026, 9, 20, 10, 0), analysis: { ...p.brain.analysis, termine: [...p.brain.analysis.termine.map((t) => ({ ...t, titel: "  " + t.titel.toUpperCase() + " " }))] } };
    dash.reset();
    await sync.syncAll();
    expect(dash.names().filter((n) => n === "create_task" || n === "update_task" || n === "delete_task")).toEqual(["update_task"]);   // only "Projektlage (KI)"
    expect(dash.db.tasks.filter((t) => t.is_event)).toHaveLength(1);
    expect(dash.db.tasks.find((t) => t.is_event)).toMatchObject({ labels: ["termin"], starts_at: "2026-10-22T09:00:00+02:00" });
    // a new date is a new proposal
    p.brain.analysis.termine = [{ titel: "Drehtag 1", datum: "2026-11-05", von: "", bis: "", ort: "", grund: "", quellen: [] }];
    await sync.syncAll();
    expect(dash.db.tasks.filter((t) => t.is_event).map((t) => t.start_date)).toEqual(["2026-10-22", "2026-11-05"]);
  });

  it("lists every appointment of the dashboard with customer and project; null on failure", async () => {
    const dash = await dashboard();
    const state = example();
    const { sync } = setup(dash, state);
    await sync.syncAll();
    const projectId = dash.db.projects[0].id;
    dash.db.tasks.push(
      { id: 700, project_id: projectId, title: "Dreh", is_event: true, starts_at: "2026-10-22T09:00:00+02:00", ends_at: null, location: "Hof", labels: [{ name: "Termin" }], status: "open" },
      { id: 701, project_id: projectId, title: "Keine Termin-Aufgabe", status: "open" },
    );
    const list = await sync.events();
    expect(list).toEqual([{
      taskId: "700", title: "Dreh", customer: "Beispiel Café", project: "Imagefilm", status: "open", labels: ["termin"],
      starts_at: "2026-10-22T09:00:00+02:00", ends_at: "", start_date: "", due_date: "", location: "Hof",
    }]);
    expect(dash.calls.at(-3)).toEqual({ name: "list_tasks", args: {} });
    dash.fail = true;
    expect(await sync.events()).toBeNull();
  });

  it("is off without URL or token", async () => {
    const sync = createWdSync({ url: "", token: TOKEN, getState: () => example(), persist: async () => undefined });
    expect(sync.enabled).toBe(false);
    sync.schedule("p_000000000001");
    expect(await sync.syncAll()).toMatchObject({ ok: false });
    expect(sync.status()).toMatchObject({ enabled: false, pending: 0 });
  });
});

// ---------------------------------------------------------------------------
// Through the real server.
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
  const dir = mkdtempSync(join(tmpdir(), "shootday-wd-"));
  const dataFile = join(dir, "data.json");
  const child = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_FILE: dataFile, TOKEN: "", WHISPER_URL: "", PRESET_LANG: "de", SHOOT_BRAIN_START_MS: "600000", ...env },
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
  return { base: `http://127.0.0.1:${port}`, output, dataFile };
}
const post = (base, path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const until = async (test, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return true; await new Promise((resolve) => setTimeout(resolve, 50)); }
  return false;
};

describe("Work Dashboard sync in the Shoot Day server", () => {
  const cleanup = [];
  afterEach(async () => { for (const step of cleanup.splice(0)) await step(); });

  it("syncs on demand and after saves, files talks as comments once, and a failing dashboard never breaks saving", async () => {
    const dash = await fakeDashboard();
    cleanup.push(() => dash.close());
    const { base, output, dataFile } = await startServer({ SHOOT_WD_URL: dash.url, SHOOT_WD_TOKEN: TOKEN, SHOOT_WD_DEBOUNCE_MS: "100" }, cleanup);
    expect(await until(() => output.stdout.includes("Work Dashboard sync: on"))).toBe(true);
    expect((await (await fetch(base + "/api/config")).json()).wd).toBe(true);

    const synced = await post(base, "/api/wd/sync", {});
    expect(synced.status).toBe(200);
    expect(await synced.json()).toMatchObject({ enabled: true, ok: true, lastError: null });
    expect(dash.db.customers.map((c) => c.name)).toEqual(["Beispielkunde"]);
    const { projects } = await (await fetch(base + "/api/projects")).json();
    const pid = projects[0].id;
    // the bookkeeping is stored, but never shown to clients
    expect(JSON.parse(readFileSync(dataFile, "utf8")).projects[pid].wdId).toBeTruthy();
    expect((await (await fetch(base + "/api/projects/" + pid)).json()).wdId).toBeUndefined();

    // a talk from Babel → one comment (no date → "Gespräche")
    expect((await post(base, "/api/projects/" + pid + "/talks", {})).status).toBe(400);
    const talk = await post(base, "/api/projects/" + pid + "/talks", { at: Date.now(), summary: "- Ruhige Bilder", cues: [{ title: "Licht", text: "Fenster nutzen", kind: "tipp" }] });
    expect(await talk.json()).toMatchObject({ ok: true, count: 1 });
    expect(await until(() => dash.db.comments.length === 1)).toBe(true);
    expect(dash.db.comments[0].body).toContain("Tipp-Karten:\n- Licht: Fenster nutzen");
    expect(dash.db.tasks.find((t) => t.id === dash.db.comments[0].task_id).title).toBe("Gespräche");
    dash.reset();
    expect((await post(base, "/api/wd/sync", {})).status).toBe(200);
    expect(dash.calls).toEqual([]);

    // a #todo idea after a save, debounced
    await post(base, "/api/projects/" + pid + "/ideas", { ideas: [{ text: "Logo anfragen", tags: ["todo"] }] });
    expect(await until(() => dash.db.tasks.some((t) => t.title === "Logo anfragen"))).toBe(true);

    // the dashboard breaks: saving still works, the status says so, nothing secret in the logs
    dash.fail = true;
    const saved = await post(base, "/api/prompter?project=" + pid, { text: "Neues Skript" });
    expect(saved.status).toBe(200);
    expect(await until(async () => (await (await fetch(base + "/api/wd/status")).json()).lastError !== null)).toBe(true);
    expect((await (await fetch(base + "/api/prompter?project=" + pid)).json()).text).toBe("Neues Skript");
    const failed = await post(base, "/api/wd/sync", {});
    expect(failed.status).toBe(502);
    const logs = output.stdout + output.stderr;
    expect(logs).toContain("work dashboard: sync failed");
    expect(logs).not.toContain(TOKEN);
    expect(logs).not.toContain(new URL(dash.url).host);
  }, 20000);

  it("a new talk is read by the local model in the background and filed as proposals", async () => {
    const dash = await fakeDashboard();
    cleanup.push(() => dash.close());
    const asked = [];
    const llm = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        asked.push({ url: request.url, body: JSON.parse(body) });
        const content = "```json\n{\"needed\":[\"Drohnengenehmigung\"],\"questions\":[\"Drehtag?\"],\"promises\":[],\"next\":[{\"text\":\"Angebot schicken\",\"due\":\"2026-10-16\"}]}\n```";
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise((resolve) => llm.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => llm.close(resolve)));
    const { base, output, dataFile } = await startServer({
      SHOOT_WD_URL: dash.url, SHOOT_WD_TOKEN: TOKEN, SHOOT_WD_DEBOUNCE_MS: "100",
      SHOOT_LLM_URL: "http://127.0.0.1:" + llm.address().port + "/v1",
    }, cleanup);
    const { projects } = await (await fetch(base + "/api/projects")).json();
    const pid = projects[0].id;
    const answer = await (await post(base, "/api/projects/" + pid + "/talks", { at: Date.now(), summary: "- Drohne über den Garten" })).json();
    expect(answer).toMatchObject({ ok: true, points: "pending" });
    expect(await until(() => dash.db.tasks.filter((t) => t.title.startsWith("Vorschlag: ")).length === 3, 8000)).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0].url).toBe("/v1/chat/completions");
    expect(output.stdout).toContain("talk points: 3 point(s)");
    const stored = JSON.parse(readFileSync(dataFile, "utf8")).projects[pid].talks[0];
    expect(stored.points.needed[0].text).toBe("Drohnengenehmigung");
    // the client sees the points, not the bookkeeping
    const listed = (await (await fetch(base + "/api/projects/" + pid + "/talks")).json()).talks[0];
    expect(listed.points.next[0]).toMatchObject({ text: "Angebot schicken", due: "2026-10-16" });
    expect(listed).not.toHaveProperty("wdPoints");
    // asking again does nothing for talks that already have points
    expect(await (await post(base, "/api/projects/" + pid + "/talks/points", {})).json()).toEqual({ queued: 0 });
    expect(asked).toHaveLength(1);
  }, 20000);

  const LOCAL_CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p)) ?? "";
  it.skipIf(!LOCAL_CHROME)("a needed permit becomes a PDF draft in the project files, named in its dashboard task", async () => {
    const dash = await fakeDashboard();
    cleanup.push(() => dash.close());
    const llm = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const system = JSON.parse(body).messages[0].content;
        const content = system.includes("„Vorhaben“")
          ? "Wir drehen einen kurzen Imagefilm im Garten."
          : "{\"needed\":[\"Drohnengenehmigung\",\"Logo als Vektor\"],\"questions\":[],\"promises\":[],\"next\":[]}";
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise((resolve) => llm.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => llm.close(resolve)));
    const { base, output } = await startServer({
      SHOOT_WD_URL: dash.url, SHOOT_WD_TOKEN: TOKEN, SHOOT_WD_DEBOUNCE_MS: "100",
      SHOOT_LLM_URL: "http://127.0.0.1:" + llm.address().port + "/v1", SHOOT_PDF_CHROME: LOCAL_CHROME,
    }, cleanup);
    expect(await until(() => output.stdout.includes("Paperwork drafts: on"))).toBe(true);
    const { projects } = await (await fetch(base + "/api/projects")).json();
    const pid = projects[0].id;
    await post(base, "/api/projects/" + pid + "/talks", { at: Date.now(), summary: "- Drohne über den Garten" });
    expect(await until(() => dash.db.tasks.some((t) => t.title === "Vorschlag: Benötigt: Drohnengenehmigung"), 30000)).toBe(true);
    const files = (await (await fetch(base + "/api/projects/" + pid)).json()).files;
    expect(files.map((f) => f.name)).toEqual([
      expect.stringMatching(/^Entwurf – Zustimmung Grundeigentümer Drohnenflug – .+\.pdf$/),
      expect.stringMatching(/^Entwurf – INTERN Checkliste Drohnenflug – .+\.pdf$/),
    ]);
    const pdf = Buffer.from(await (await fetch(base + "/api/projects/" + pid + "/files/" + files[0].id)).arrayBuffer());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const task = dash.db.tasks.find((t) => t.title === "Vorschlag: Benötigt: Drohnengenehmigung");
    expect(task.description).toContain("Entwurf hängt an dieser Aufgabe");
    // both PDFs hang at that task in the dashboard, byte for byte
    expect(await until(() => dash.db.attachments.length === 2, 10000)).toBe(true);
    expect(dash.db.attachments.map((a) => [a.task_id, a.filename])).toEqual([[task.id, files[0].name], [task.id, files[1].name]]);
    expect(dash.db.attachments[0].bytes).toBe(pdf.toString());
    const overview = dash.db.tasks.find((t) => t.title.startsWith("Vorschlag: Offen aus Gespräch"));
    expect(overview.description).toContain("- Drohnengenehmigung\n  → Entwurf (Anhang der Aufgabe dazu): " + files[0].name);
    expect(dash.db.tasks.find((t) => t.title === "Vorschlag: Benötigt: Logo als Vektor").description).not.toContain("Entwurf");
    // on demand: always a fresh one; unknown template refused
    expect((await post(base, "/api/projects/" + pid + "/docs", { template: "nix" })).status).toBe(400);
    const made = await (await post(base, "/api/projects/" + pid + "/docs", { template: "einverstaendnis" })).json();
    expect(made.files).toEqual([expect.objectContaining({ type: "pdf", name: expect.stringContaining("Einverständnis Bild- und Tonaufnahmen") })]);
    const info = await (await fetch(base + "/api/projects/" + pid + "/docs")).json();
    expect(info).toMatchObject({ pdf: true, templates: expect.arrayContaining([{ id: "drohne", label: "Drohnenflug" }]) });
    expect(info.drafts.map((d) => [d.template, Boolean(d.manual)])).toEqual([["drohne", false], ["einverstaendnis", true]]);
    // a new version of the drone draft replaces the old one (same tasks, new name), the hand-written one stays
    const replaced = await (await post(base, "/api/projects/" + pid + "/docs", { template: "drohne", replace: true })).json();
    // named after the customer, no project name and no date
    expect(replaced.files.map((f) => f.name)).toEqual([expect.stringMatching(/^Entwurf – Zustimmung Grundeigentümer Drohnenflug( – [^–]+)?\.pdf$/), expect.stringMatching(/^Entwurf – INTERN Checkliste Drohnenflug( – [^–]+)?\.pdf$/)]);
    expect(replaced.files.some((f) => /Fassung|\d\d\.\d\d\./.test(f.name))).toBe(false);
    const after = await (await fetch(base + "/api/projects/" + pid + "/docs")).json();
    expect(after.drafts.map((d) => [d.template, Boolean(d.manual)])).toEqual([["einverstaendnis", true], ["drohne", false]]);
    expect(after.drafts[1].files).toEqual(replaced.files.map((f) => f.id));
    // the one written by hand lands at "Unterlagen"
    expect(await until(() => dash.db.attachments.length === 3, 10000)).toBe(true);
    expect(dash.db.tasks.find((t) => t.id === dash.db.attachments[2].task_id).title).toBe("Unterlagen");
  }, 90000);

  it.skipIf(!LOCAL_CHROME)("the server understands a project from its to-dos, writes the drafts and hangs them at the to-do tasks", async () => {
    const dash = await fakeDashboard();
    cleanup.push(() => dash.close());
    const asked = [];
    const llm = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const { messages } = JSON.parse(body);
        asked.push(messages[0].content.slice(0, 12));
        const ids = [...messages[1].content.matchAll(/\[(idea:[^\]]+)\]/g)].map((m) => m[1]);
        const content = JSON.stringify({
          lage: "Imagefilm für ein Café.", zusammenhaenge: ["Mitarbeitende im Bild → Einverständnis"],
          unterlagen: [{ vorlage: "einverstaendnis", warum: "Mitarbeitende sind im Bild", quellen: ids.slice(0, 1), angaben: { zweck: "Wir drehen einen kurzen Imagefilm im Café." } },
            { vorlage: "praktikum", warum: "Praktikum", quellen: ids.slice(1, 2), angaben: { praktikant: "Lena Probe", schule: "erfunden" } }],
          offen: [],
        });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise((resolve) => llm.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => llm.close(resolve)));
    const { base, output } = await startServer({
      SHOOT_WD_URL: dash.url, SHOOT_WD_TOKEN: TOKEN, SHOOT_WD_DEBOUNCE_MS: "100", SHOOT_BRAIN_DEBOUNCE_MS: "600000",
      SHOOT_LLM_URL: "http://127.0.0.1:" + llm.address().port + "/v1", SHOOT_PDF_CHROME: LOCAL_CHROME,
    }, cleanup);
    expect(await until(() => output.stdout.includes("Project understanding: local model"))).toBe(true);
    const { projects } = await (await fetch(base + "/api/projects")).json();
    const pid = projects[0].id;
    await post(base, "/api/projects/" + pid + "/ideas", { ideas: [
      { text: "Vordrucke Einverständniserklärung Mitarbeitende vorbereiten", tags: ["todo"] },
      { text: "Praktikumsvereinbarung schicken (Lena Probe)", tags: ["todo"] },
    ] });
    const run = await (await post(base, "/api/projects/" + pid + "/brain", {})).json();
    expect(run.ok).toBe(true);
    expect(asked).toEqual(["Du bist die ", "Du schreibst", "Du schreibst"]);   // consent: purpose from the analysis; internship + team confirmation: written
    expect(run.analysis.unterlagen.map((u) => [u.template, u.files.length])).toEqual([["einverstaendnis", 1], ["praktikum", 1], ["teambestaetigung", 1]]);
    expect(run.analysis.unterlagen[1].angaben).toEqual({ praktikant: "Lena Probe" });   // "erfunden" is not in the material
    const brain = await (await fetch(base + "/api/projects/" + pid + "/brain")).json();
    expect(brain).not.toHaveProperty("digests");
    expect(brain.analysis.lage).toBe("Imagefilm für ein Café.");
    expect(await until(() => dash.db.attachments.length === 3, 15000)).toBe(true);
    const byTitle = Object.fromEntries(dash.db.tasks.map((t) => [t.title, t.id]));
    expect(dash.db.attachments.map((a) => [a.task_id, a.filename.replace(/ – .*$/, "")])).toEqual([
      [byTitle["Vordrucke Einverständniserklärung Mitarbeitende vorbereiten"], "Entwurf"],
      [byTitle["Vorschlag: Benötigt: Praktikumsvereinbarung (INTERN)"], "Entwurf"],   // the INTERN contract only at its own internal task
      [byTitle["Praktikumsvereinbarung schicken (Lena Probe)"], "Entwurf"],   // the customer gets the team confirmation
    ]);
    expect(dash.db.attachments.map((a) => a.filename)).toEqual([expect.stringContaining("Einverständnis"), expect.stringContaining("INTERN Praktikumsvereinbarung"), expect.stringContaining("Bestätigung Team am Drehort")]);
    expect(dash.db.tasks.some((t) => t.title === "Projektlage (KI)")).toBe(true);
    // the same material again: nothing new is written
    const again = await (await post(base, "/api/projects/" + pid + "/brain", {})).json();
    expect(again.ok).toBe(true);
    const files = (await (await fetch(base + "/api/projects/" + pid)).json()).files;
    expect(files).toHaveLength(3);   // one draft per template and project
  }, 90000);

  it("dashboard changes are noticed by the poll and reach the project understanding; a failing read-back never stops it", async () => {
    const dash = await fakeDashboard();
    cleanup.push(() => dash.close());
    const prompts = [];
    const llm = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        prompts.push(JSON.parse(body).messages[1].content);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: "{\"lage\":\"Ein Projekt.\"}" } }] }));
      });
    });
    await new Promise((resolve) => llm.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => llm.close(resolve)));
    const { base, output } = await startServer({
      SHOOT_WD_URL: dash.url, SHOOT_WD_TOKEN: TOKEN, SHOOT_WD_DEBOUNCE_MS: "100", SHOOT_WD_POLL_MS: "150", SHOOT_BRAIN_DEBOUNCE_MS: "100",
      SHOOT_LLM_URL: "http://127.0.0.1:" + llm.address().port + "/v1",
    }, cleanup);
    expect((await post(base, "/api/wd/sync", {})).status).toBe(200);
    const { projects } = await (await fetch(base + "/api/projects")).json();
    const pid = projects[0].id;
    // the poll has seen the tasks once, nothing ran
    expect(await until(() => dash.calls.filter((c) => c.name === "list_tasks").length >= 2)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(prompts).toEqual([]);
    // someone works in the dashboard
    dash.db.tasks.push({ id: 900, project_id: dash.db.projects[0].id, title: "Location besichtigen", description: "Schlüssel bei Frau Test", status: "done" });
    dash.db.comments.push({ id: 901, task_id: 900, body: "War dort, passt." });
    expect(await until(() => prompts.length > 0, 8000)).toBe(true);
    expect(prompts[0]).toContain("Dashboard: Location besichtigen");
    expect(prompts[0]).toContain("Status: done");
    expect(prompts[0]).toContain("Kommentar: War dort, passt.");
    // the dashboard breaks: the run still works, without it
    dash.fail = true;
    const run = await (await post(base, "/api/projects/" + pid + "/brain", {})).json();
    expect(run.ok).toBe(true);
    expect(prompts.at(-1)).not.toContain("Dashboard:");
    expect(output.stdout + output.stderr).toContain("work dashboard: reading back failed");
    expect(output.stdout + output.stderr).not.toContain(TOKEN);
  }, 30000);

  /** A fake local model for the inbox: classification by file name, scenes for storyboards. */
  async function inboxModel(answers) {
    const asked = [];
    const llm = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const { messages } = JSON.parse(body);
        const system = messages[0].content;
        const user = messages[1]?.content ?? "";
        let content = "{\"lage\":\"Ein Projekt.\"}";
        if (system.startsWith("Du ordnest")) {
          const file = /^Datei: (.+?)(?: \(|$)/m.exec(user)?.[1] ?? "";
          asked.push({ kind: "classify", file, fixed: user.includes("Das Projekt steht fest") });
          const pid = /id: (p_[0-9a-f]{12})/.exec(user)?.[1] ?? null;
          const prep = /\[(\d+)\] Drehvorbereitung/.exec(user)?.[1];
          content = JSON.stringify(answers(file, { pid, prep: prep ? Number(prep) : null }));
        } else if (system.startsWith("Du wandelst")) {
          asked.push({ kind: "scenes", text: user });
          content = JSON.stringify({ scenes: [{ n: 1, title: "Neue Ankunft", content: user.slice(0, 40) }, { n: 2, title: "Neuer Abschied" }] });
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise((resolve) => llm.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => llm.close(resolve)));
    return { url: "http://127.0.0.1:" + llm.address().port + "/v1", asked };
  }
  const inboxEnv = (dash, llm) => ({
    SHOOT_WD_URL: dash.url, SHOOT_WD_TOKEN: TOKEN, SHOOT_WD_DEBOUNCE_MS: "100", SHOOT_WD_POLL_MS: "250", SHOOT_INBOX_START_MS: "250",
    SHOOT_LLM_URL: llm.url,
  });

  it("the inbox: sure files go to their project and task with a comment, a storyboard replaces the old one; unsure ones stay; nothing twice", async () => {
    const dash = await fakeDashboard();
    cleanup.push(() => dash.close());
    const llm = await inboxModel((file, { pid, prep }) => ({
      "Reel_v2.pdf": { project: pid, task: prep, art: "storyboard", ersetzt: "Beispiel-Reel", sicher: 0.9, grund: "Neue Fassung des Reels" },
      "Vertrag.pdf": { project: pid, task: 777, art: "vertrag", ersetzt: null, sicher: 95, grund: "Vertrag zum Beispiel-Dreh" },
      "Unklar.pdf": { project: pid, task: null, art: "sonstiges", ersetzt: null, sicher: 0.4, grund: "Name passt nur ungefähr" },
      "Fremd.pdf": { project: "p_999999999999", task: null, art: "rechnung", ersetzt: null, sicher: 0.99, grund: "erfunden" },
    })[file] ?? { project: null, sicher: 0 });
    const { base, output, dataFile } = await startServer(inboxEnv(dash, llm), cleanup);
    expect(await until(() => output.stdout.includes("Dashboard inbox: on (sure from 75 %)"))).toBe(true);
    expect((await (await fetch(base + "/api/config")).json()).inbox).toBe(true);
    expect((await post(base, "/api/wd/sync", {})).status).toBe(200);
    const { projects } = await (await fetch(base + "/api/projects")).json();
    const pid = projects[0].id;
    const prep = dash.db.tasks.find((t) => t.title === "Drehvorbereitung");
    expect(prep).toBeTruthy();

    const reel = dash.drop(INBOX_TASK, "Reel_v2.pdf", textPdf("Szene 1 Ankunft am Hof"));
    const contract = dash.drop(INBOX_TASK, "Vertrag.pdf", textPdf("Vertrag Beispielkunde"));
    const unsure = dash.drop(INBOX_TASK, "Unklar.pdf", textPdf("Irgendein Text"));
    const foreign = dash.drop(INBOX_TASK, "Fremd.pdf", textPdf("Rechnung an jemand anderen"));
    expect(await until(async () => (await (await fetch(base + "/api/inbox/status")).json()).items.length === 4, 10000)).toBe(true);

    // sure: moved to its task (an unknown task id → "Unterlagen"), a comment there
    const docs = dash.db.tasks.find((t) => t.title === "Unterlagen");
    expect(docs).toBeTruthy();
    expect(dash.db.attachments.find((a) => a.id === reel.id).task_id).toBe(prep.id);
    expect(dash.db.attachments.find((a) => a.id === contract.id).task_id).toBe(docs.id);
    expect(dash.db.comments.find((c) => c.task_id === prep.id)?.body).toBe("Aus dem Eingang automatisch zugeordnet: Neue Fassung des Reels (storyboard, sicher 90 %)");
    expect(dash.db.comments.find((c) => c.task_id === docs.id)?.body).toBe("Aus dem Eingang automatisch zugeordnet: Vertrag zum Beispiel-Dreh (vertrag, sicher 95 %)");
    // unsure or an unknown project: stays in the inbox with a proposal
    expect(dash.db.attachments.find((a) => a.id === unsure.id).task_id).toBe(INBOX_TASK);
    expect(dash.db.attachments.find((a) => a.id === foreign.id).task_id).toBe(INBOX_TASK);
    const inboxComments = dash.db.comments.filter((c) => c.task_id === INBOX_TASK).map((c) => c.body);
    expect(inboxComments).toEqual([
      "Unklar.pdf: nicht sicher zuzuordnen – Vorschlag: Beispielkunde / Beispiel-Dreh (Name passt nur ungefähr, sicher 40 %)",
      "Fremd.pdf: nicht sicher zuzuordnen – Vorschlag: keiner (erfunden, sicher 99 %)",
    ]);
    // in Shoot Day: the files, the storyboard replaced, the old version kept
    const project = await (await fetch(base + "/api/projects/" + pid)).json();
    expect(project.files.map((f) => f.name)).toEqual(["Reel_v2.pdf", "Vertrag.pdf"]);
    expect(project.files[0]).not.toHaveProperty("content_base64");
    expect(project.storyboards).toHaveLength(1);
    expect(project.storyboards[0]).toMatchObject({ title: "Reel_v2", source: "Reel_v2.pdf", scenes: [expect.objectContaining({ title: "Neue Ankunft" }), expect.objectContaining({ title: "Neuer Abschied" })] });
    expect(project.storyboards[0].previous).toEqual([expect.objectContaining({ title: "Beispiel-Reel", scenes: [expect.objectContaining({ title: "Ankunft" }), expect.objectContaining({ title: "Hände bei der Arbeit" })] })]);
    expect(llm.asked.filter((a) => a.kind === "scenes")).toHaveLength(1);
    const status = await (await fetch(base + "/api/inbox/status")).json();
    expect(Object.fromEntries(status.items.map((i) => [i.name, i.status]))).toEqual({ "Reel_v2.pdf": "assigned", "Vertrag.pdf": "assigned", "Unklar.pdf": "kept", "Fremd.pdf": "kept" });
    expect(status.items.find((i) => i.name === "Reel_v2.pdf")).toMatchObject({ project: pid, art: "storyboard", sicher: 0.9, replaced: "Beispiel-Reel" });
    expect(status.items.find((i) => i.name === "Fremd.pdf")).not.toHaveProperty("project");
    // an editor save without the earlier versions keeps them
    const board = project.storyboards[0];
    expect((await post(base, "/api/projects/" + pid + "/storyboards", { id: board.id, title: "Reel_v2", source: board.source, scenes: board.scenes })).status).toBe(200);
    expect((await (await fetch(base + "/api/projects/" + pid)).json()).storyboards[0].previous).toHaveLength(1);

    // later looks: nothing is done twice (also not by the look at the project's task files)
    const classified = llm.asked.filter((a) => a.kind === "classify").length;
    const comments = dash.db.comments.length;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(llm.asked.filter((a) => a.kind === "classify")).toHaveLength(classified);
    expect(dash.db.comments.filter((c) => c.body.includes("Eingang") || c.body.includes("zuzuordnen"))).toHaveLength(4);
    expect(dash.db.comments.length).toBe(comments);
    expect((await (await fetch(base + "/api/projects/" + pid)).json()).files).toHaveLength(2);
    expect(Object.keys(JSON.parse(readFileSync(dataFile, "utf8")).inboxSeen).sort()).toEqual([reel.id, contract.id, unsure.id, foreign.id].map(String).sort());

    // only on request: once more
    expect((await post(base, "/api/inbox/retry", { id: 12345 })).status).toBe(404);
    expect((await post(base, "/api/inbox/retry", { id: String(unsure.id) })).status).toBe(202);
    expect(await until(() => dash.db.comments.filter((c) => c.task_id === INBOX_TASK).length === 3, 6000)).toBe(true);
    expect(llm.asked.filter((a) => a.kind === "classify" && a.file === "Unklar.pdf")).toHaveLength(2);
    // the logs carry no file content and no secrets
    const logs = output.stdout + output.stderr;
    expect(logs).toContain("inbox: assigned");
    expect(logs).not.toContain("Szene 1 Ankunft am Hof");
    expect(logs).not.toContain(TOKEN);
  }, 30000);

  it("files uploaded straight to a project's task are taken over, a new storyboard version replaces the old one; drafts and own uploads are left; a broken dashboard breaks nothing", async () => {
    const dash = await fakeDashboard();
    cleanup.push(() => dash.close());
    const llm = await inboxModel((file, { pid }) => ({
      "Reel_v3.pdf": { project: null, task: null, art: "storyboard", ersetzt: "Beispiel-Reel", sicher: 0.5, grund: "Neue Fassung" },
      "Ablauf.pdf": { project: pid, task: null, art: "unterlage", ersetzt: null, sicher: 0.9, grund: "Ablaufplan" },
      "Spaet.pdf": { project: pid, task: null, art: "unterlage", ersetzt: null, sicher: 0.9, grund: "Ablauf" },
    })[file] ?? { project: null, sicher: 0 });
    const { base, output } = await startServer(inboxEnv(dash, llm), cleanup);
    expect((await post(base, "/api/wd/sync", {})).status).toBe(200);
    const { projects } = await (await fetch(base + "/api/projects")).json();
    const pid = projects[0].id;
    const prep = dash.db.tasks.find((t) => t.title === "Drehvorbereitung");
    // let the first look of the poll pass, then people upload to the task
    expect(await until(() => dash.calls.some((c) => c.name === "list_attachments"), 6000)).toBe(true);
    const v3 = dash.drop(prep.id, "Reel_v3.pdf", textPdf("Szene 1 Neue Fassung"));
    dash.drop(prep.id, "Entwurf – Einverständnis – Beispiel-Dreh.pdf", textPdf("Entwurf"));
    const photo = dash.drop(prep.id, "Set.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("made-up image")]), "image/png");
    expect(await until(async () => {
      const now = await (await fetch(base + "/api/projects/" + pid)).json();
      return now.storyboards[0].title === "Reel_v3" && now.files.length === 2;
    }, 10000)).toBe(true);
    const project = await (await fetch(base + "/api/projects/" + pid)).json();
    expect(project.files.map((f) => [f.name, f.type])).toEqual([["Reel_v3.pdf", "pdf"], ["Set.png", "png"]]);
    expect(project.storyboards[0].previous[0]).toMatchObject({ title: "Beispiel-Reel" });
    // the project is fixed, the model only said what it is; nothing moved, one comment
    expect(llm.asked.filter((a) => a.kind === "classify")).toEqual([{ kind: "classify", file: "Reel_v3.pdf", fixed: true }]);
    expect(dash.db.attachments.find((a) => a.id === v3.id).task_id).toBe(prep.id);
    expect(dash.db.attachments.find((a) => a.id === photo.id).task_id).toBe(prep.id);
    expect(dash.db.comments.map((c) => [c.task_id, c.body])).toEqual([[prep.id, "Neue Fassung von Beispiel-Reel übernommen, alte Fassung aufgehoben"]]);
    // the same file once more (another task): known by its content, not taken twice
    const ideen = dash.db.tasks.find((t) => t.title === "Ideen & Notizen");
    dash.drop(ideen.id, "Reel_v3 Kopie.pdf", textPdf("Szene 1 Neue Fassung"));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect((await (await fetch(base + "/api/projects/" + pid)).json()).files).toHaveLength(2);
    expect(llm.asked.filter((a) => a.kind === "classify")).toHaveLength(1);

    // a broken attachment read: tried again on a later look
    dash.broken.add("read_attachment");
    const late = dash.drop(INBOX_TASK, "Spaet.pdf", textPdf("Ablauf spaet"));
    expect(await until(async () => (await (await fetch(base + "/api/inbox/status")).json()).items.some((i) => i.name === "Spaet.pdf" && i.status === "failed"), 6000)).toBe(true);
    dash.broken.clear();
    expect(await until(async () => (await (await fetch(base + "/api/inbox/status")).json()).items.some((i) => i.name === "Spaet.pdf" && i.status === "assigned"), 6000)).toBe(true);
    expect(dash.db.attachments.find((a) => a.id === late.id).task_id).toBe(dash.db.tasks.find((t) => t.title === "Unterlagen").id);

    // the dashboard breaks altogether: saving still works, the inbox says so, nothing secret in the logs
    dash.fail = true;
    dash.drop(INBOX_TASK, "Ablauf.pdf", textPdf("Ablauf"));
    expect(await until(async () => (await (await fetch(base + "/api/inbox/status")).json()).lastError === "inbox unreachable", 6000)).toBe(true);
    expect((await post(base, "/api/prompter?project=" + pid, { text: "Skript bleibt" })).status).toBe(200);
    expect((await (await fetch(base + "/api/prompter?project=" + pid)).json()).text).toBe("Skript bleibt");
    const logs = output.stdout + output.stderr;
    expect(logs).not.toContain(TOKEN);
    expect(logs).not.toContain(new URL(dash.url).host);
    expect(logs).not.toContain("Neue Fassung");
  }, 40000);

  it("appointments: an entry is understood (model, else rules); confirmed dashboard appointments reach Google, cancelled ones leave it", async () => {
    const dash = await fakeDashboard();
    cleanup.push(() => dash.close());
    // the local model: answers the appointment prompt, anything else with a plain overview
    const prompts = [];
    let modelUp = true;
    const llm = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const { messages } = JSON.parse(body);
        if (!modelUp) { response.writeHead(503); response.end(); return; }
        let content = "{\"lage\":\"Ein Projekt.\"}";
        if (messages[0].content.startsWith("Du liest eine kurze Termin-Eingabe")) {
          prompts.push(messages[1].content);
          const id = Number(/wdProjectId: (\d+) \| Kunde: Gasthof Musterwirt/.exec(messages[1].content)?.[1]);
          content = JSON.stringify({ title: "Drehtag Sommerreel", wdProjectId: id, date: "2026-10-21", start: "09:00", end: "12:00", location: "", hints: [] });
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise((resolve) => llm.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => llm.close(resolve)));
    // a fake Apps Script bridge (answers directly, without the redirect)
    const google = new Map();
    const bridgeCalls = [];
    const bridge = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const d = JSON.parse(body);
        bridgeCalls.push(d);
        let result = { ok: true };
        if (d.action === "delete") google.delete(d.project);
        else { result = { ok: true, eventId: google.get(d.project)?.eventId ?? "g" + bridgeCalls.length }; google.set(d.project, { ...d, eventId: result.eventId }); }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(result));
      });
    });
    await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => bridge.close(resolve)));

    const { base, dataFile } = await startServer({
      SHOOT_WD_URL: dash.url, SHOOT_WD_TOKEN: TOKEN, SHOOT_WD_DEBOUNCE_MS: "100", SHOOT_WD_POLL_MS: "200",
      SHOOT_LLM_URL: "http://127.0.0.1:" + llm.address().port + "/v1",
      SHOOT_GCAL_WEBHOOK: "http://127.0.0.1:" + bridge.address().port + "/exec", SHOOT_GCAL_SECRET: "geheim-test-wort", SHOOT_GCAL_RETRY_MS: "100",
    }, cleanup);
    const customer = await (await post(base, "/api/customers", { name: "Gasthof Musterwirt", notes: "Ruhetag Mo/Di" })).json();
    await post(base, "/api/projects", { customerId: customer.id, name: "Sommerreel", place: "Hauptplatz 3" });
    expect((await post(base, "/api/wd/sync", {})).status).toBe(200);
    const wdProject = dash.db.projects.find((x) => x.name === "Sommerreel");
    expect(wdProject).toBeTruthy();

    // the model proposes a Wednesday although the text says Thursday: the words win
    const parsed = await (await post(base, "/api/events/parse", { text: "Dreh bei Musterwirt nächsten Donnerstag 9 bis 12 Uhr", today: "2026-10-20" })).json();
    expect(parsed).toMatchObject({ ok: true, source: "model", proposal: {
      title: "Drehtag Sommerreel", wdProjectId: wdProject.id, customer: "Gasthof Musterwirt", project: "Sommerreel",
      date: "2026-10-22", start: "09:00", end: "12:00", location: "Hauptplatz 3",
    } });
    expect(parsed.proposal.hints).toContain("Gasthof Musterwirt hat Mo/Di Ruhetag – Donnerstag passt");
    expect(prompts[0]).toContain("Kundennotizen: Ruhetag Mo/Di");
    // without the model: the rules
    modelUp = false;
    const rules = await (await post(base, "/api/events/parse", { text: "Sommerreel Besprechung Montag 10:00", today: "2026-10-20" })).json();
    expect(rules).toMatchObject({ ok: true, source: "rules", proposal: { wdProjectId: wdProject.id, date: "2026-10-26", start: "10:00", end: "" } });
    expect(rules.proposal.hints).toContain("Gasthof Musterwirt hat Mo/Di Ruhetag – Montag fällt auf einen Ruhetag");
    expect((await post(base, "/api/events/parse", {})).status).toBe(400);
    // parsing creates nothing
    expect(dash.db.tasks.some((t) => t.is_event)).toBe(false);

    // appointments in the dashboard: confirmed → Google; a proposal and an internal one never
    dash.db.tasks.push(
      { id: 800, project_id: wdProject.id, title: "Drehtag", is_event: true, starts_at: "2026-10-22T09:00:00+02:00", ends_at: "2026-10-22T12:00:00+02:00", location: "Hauptplatz 3", labels: ["termin"], status: "open" },
      { id: 801, project_id: wdProject.id, title: "Reserve", is_event: true, starts_at: null, ends_at: null, start_date: "2026-10-29", due_date: "2026-10-29", labels: ["vorschlag", "termin"], status: "open" },
      { id: 802, project_id: wdProject.id, title: "Teamessen", is_event: true, starts_at: null, start_date: "2026-10-30", labels: ["intern"], status: "open" },
    );
    expect(await until(() => google.has("wd:800"), 8000)).toBe(true);
    expect(google.get("wd:800")).toMatchObject({ title: "Gasthof Musterwirt – Drehtag", start: "2026-10-22T09:00:00+02:00", end: "2026-10-22T12:00:00+02:00", location: "Hauptplatz 3", allDay: false });
    expect(google.get("wd:800").description).toContain("aus dem Work Dashboard");
    const sent = bridgeCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 600));   // a few more polls: nothing changed, nothing sent
    expect(bridgeCalls.length).toBe(sent);
    // the proposal is confirmed, the first one cancelled
    dash.db.tasks.find((t) => t.id === 801).labels = ["termin"];
    Object.assign(dash.db.tasks.find((t) => t.id === 800), { status: "done", labels: ["termin", "abgesagt"] });
    expect(await until(() => google.has("wd:801") && !google.has("wd:800"), 8000)).toBe(true);
    expect(google.get("wd:801")).toMatchObject({ allDay: true, date: "2026-10-29", title: "Gasthof Musterwirt – Reserve" });
    // deleted in the dashboard → gone from Google
    dash.db.tasks.splice(dash.db.tasks.findIndex((t) => t.id === 801), 1);
    expect(await until(() => !google.has("wd:801"), 8000)).toBe(true);
    expect(bridgeCalls.some((c) => c.project === "wd:802")).toBe(false);
    // the bookkeeping follows right after the bridge's answer
    expect(await until(async () => (await (await fetch(base + "/api/gcal/status")).json()).events.synced === 0)).toBe(true);
    expect((await (await fetch(base + "/api/gcal/status")).json()).events).toMatchObject({ enabled: true, lastError: "" });
    expect(await until(() => Object.keys(JSON.parse(readFileSync(dataFile, "utf8")).gcalEvents ?? { x: 1 }).length === 0)).toBe(true);
  }, 40000);

  it("is off without SHOOT_WD_URL / SHOOT_WD_TOKEN", async () => {
    const { base, output } = await startServer({ SHOOT_WD_URL: "", SHOOT_WD_TOKEN: "" }, cleanup);
    expect(await until(() => output.stdout.includes("Work Dashboard sync: off"))).toBe(true);
    expect(await (await fetch(base + "/api/wd/status")).json()).toEqual({ enabled: false, lastSync: null, lastError: null, pending: 0 });
    expect((await post(base, "/api/wd/sync", {})).status).toBe(503);
  }, 10000);
});

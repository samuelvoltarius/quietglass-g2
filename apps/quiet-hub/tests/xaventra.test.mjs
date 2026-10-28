import { describe, expect, it } from "vitest";
import { createController, validateConfig, xaventraBase, readXaventraToken } from "../examples/quiet-hub-relay.mjs";

const KEY = "test-desktop-key-0000";

/** A fake desktop API: rooms, messages and the progress side channel. */
function fakeXaventra(options = {}) {
  const seen = [];
  const rooms = [...(options.rooms ?? [])];
  let next = 1;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    seen.push({ url, method: init.method, path: u.pathname + u.search, headers: init.headers, body });
    if (options.status) return json({ error: "nope" }, options.status);
    if (u.pathname === "/api/desktop/rooms" && init.method === "GET") return json({ rooms });
    if (u.pathname === "/api/desktop/rooms" && init.method === "POST") {
      const room = { id: `room-${next++}`, title: body.title, botIds: body.botIds, archived: false, updatedAt: "2020-01-01T10:00:00.000Z" };
      rooms.push(room);
      return json(room);
    }
    if (u.pathname === "/api/desktop/fortschritt") return json({ schritt: "Nova sucht im Kalender" });
    const m = u.pathname.match(/^\/api\/desktop\/rooms\/([^/]+)\/messages$/);
    if (m && init.method === "POST") {
      if (options.slowMs) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, options.slowMs);
          init.signal?.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
        });
      }
      return json({ replies: [{ botId: "nova", message: { content: options.answer ?? `Antwort auf: ${body.content}` } }] });
    }
    return json({ error: "not found" }, 404);
  };
  return { fetchImpl, seen, rooms };
}

const ctxWith = (fake, extra = {}) => ({ fetch: fake.fetchImpl, readFile: () => `${KEY}\n`, home: "/home/test", ...extra });
const agent = (extra = {}) => ({ id: "xaventra", kind: "xaventra", mode: "auto", ...extra });

describe("Xaventra relay kind", () => {
  it("is a valid kind and only accepts loopback URLs", () => {
    expect(validateConfig({ agents: [agent()] }).agents[0]).toMatchObject({ kind: "xaventra", mode: "auto" });
    expect(validateConfig({ agents: [agent({ url: "http://localhost:3011/" })] }).agents[0].kind).toBe("xaventra");
    expect(() => validateConfig({ agents: [agent({ url: "http://192.0.2.10:3011" })] })).toThrow(/loopback/);
    expect(() => validateConfig({ agents: [agent({ url: "http://127.0.0.1.example.org:3011" })] })).toThrow(/loopback/);
    expect(() => validateConfig({ agents: [agent({ url: "ftp://127.0.0.1" })] })).toThrow(/http/);
    expect(() => createController(agent({ url: "https://xaventra.example.org" }), ctxWith(fakeXaventra()))).toThrow(/loopback/);
    expect(xaventraBase()).toBe("http://127.0.0.1:3011");
  });

  it("creates the room Zentrale once, then reuses it, with key and client headers", async () => {
    const fake = fakeXaventra();
    const c = createController(agent(), ctxWith(fake));
    const first = await c.run({ prompt: "wie spät ist es?" }, () => undefined);
    expect(first).toMatchObject({ status: "done", text: "Antwort auf: wie spät ist es?", sessionId: "room-1", transport: "http" });
    await c.run({ prompt: "und morgen?", sessionId: "room-1" }, () => undefined);
    const creates = fake.seen.filter((s) => s.method === "POST" && s.path === "/api/desktop/rooms");
    expect(creates).toHaveLength(1);
    expect(creates[0].body).toMatchObject({ title: "Zentrale", botIds: ["nova"] });
    const posts = fake.seen.filter((s) => s.path.endsWith("/messages"));
    expect(posts.map((p) => p.path)).toEqual(["/api/desktop/rooms/room-1/messages", "/api/desktop/rooms/room-1/messages"]);
    expect(posts[0].url.startsWith("http://127.0.0.1:3011/")).toBe(true);
    expect(posts[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(posts[0].headers["x-nova-desktop-client"]).toBe("quiet-hub-relay");
  });

  it("reuses an existing Zentrale room and opens a new room for fresh / new session", async () => {
    const fake = fakeXaventra({ rooms: [{ id: "room-alt", title: "Zentrale", archived: false, updatedAt: "2026-10-28T10:00:00.000Z" }] });
    const c = createController(agent(), ctxWith(fake));
    expect((await c.run({ prompt: "a" }, () => undefined)).sessionId).toBe("room-alt");
    const fresh = await c.run({ prompt: "b", fresh: true, title: "Neues Thema" }, () => undefined);
    expect(fresh.sessionId).toBe("room-1");
    expect(fake.rooms.at(-1).title).toBe("Zentrale · Neues Thema");
    await c.newSession();
    expect((await c.run({ prompt: "c" }, () => undefined)).sessionId).toBe("room-2");
    const list = await c.sessions();
    expect(list).toMatchObject({ supported: true, active: "room-2", transport: "http" });
    expect(list.items.map((i) => i.id)).toContain("room-alt");
  });

  it("reports the progress side channel as activity", async () => {
    const fake = fakeXaventra({ slowMs: 60 });
    const updates = [];
    const c = createController(agent({ progressMs: 10 }), ctxWith(fake));
    const result = await c.run({ prompt: "x" }, (u) => updates.push(u));
    expect(result.status).toBe("done");
    expect(updates.some((u) => u.activity === "Nova sucht im Kalender")).toBe(true);
    expect(updates.at(-1)).toEqual({ text: "Antwort auf: x", activity: "" });
    expect(fake.seen.some((s) => s.path === "/api/desktop/fortschritt?room=room-1")).toBe(true);
  });

  it("explains a rejected key, times out and stops on cancel", async () => {
    const rejected = await createController(agent(), ctxWith(fakeXaventra({ status: 401 }))).run({ prompt: "x" }, () => undefined);
    expect(rejected).toMatchObject({ status: "error", error: "Xaventra key rejected (desktop API)" });
    const forbidden = await createController(agent(), ctxWith(fakeXaventra({ status: 403 }))).run({ prompt: "x" }, () => undefined);
    expect(forbidden.error).toMatch(/key rejected/);
    const slow = await createController(agent({ timeoutMs: 30, progressMs: 1000 }), ctxWith(fakeXaventra({ slowMs: 5000 }))).run({ prompt: "x" }, () => undefined);
    expect(slow).toMatchObject({ status: "error", error: "timeout" });
    const abort = new AbortController();
    const pending = createController(agent({ progressMs: 1000 }), ctxWith(fakeXaventra({ slowMs: 5000 }))).run({ prompt: "x", signal: abort.signal }, () => undefined);
    setTimeout(() => abort.abort(), 20);
    expect(await pending).toMatchObject({ status: "cancelled" });
  });

  it("never shows the key in answers, activity or errors", async () => {
    const outputs = [];
    const collect = (u) => outputs.push(JSON.stringify(u));
    for (const fake of [fakeXaventra(), fakeXaventra({ status: 401 }), fakeXaventra({ status: 500 }), fakeXaventra({ slowMs: 40 })]) {
      const c = createController(agent({ progressMs: 10 }), ctxWith(fake));
      outputs.push(JSON.stringify(await c.run({ prompt: "x" }, collect)));
    }
    const broken = { ...ctxWith(fakeXaventra()), fetch: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:3011"); } };
    outputs.push(JSON.stringify(await createController(agent(), broken).run({ prompt: "x" }, collect)));
    expect(outputs.length).toBeGreaterThan(5);
    for (const out of outputs) expect(out).not.toContain(KEY);
  });

  it("reads the key file (default path, ~) and fails clearly without it", () => {
    const paths = [];
    const read = (path) => { paths.push(path); return ` ${KEY} `; };
    expect(readXaventraToken({}, { home: "/home/test", readFile: read })).toBe(KEY);
    readXaventraToken({ tokenFile: "~/keys/x" }, { home: "/home/test", readFile: read });
    expect(paths[0].replace(/\\/g, "/")).toBe("/home/test/.config/xaventra/desktop-token");
    expect(paths[1]).toBe("/home/test/keys/x");
    expect(() => readXaventraToken({}, { home: "/h", readFile: () => { throw new Error("ENOENT"); } })).toThrow(/not readable/);
    expect(() => readXaventraToken({}, { home: "/h", readFile: () => "\n" })).toThrow(/empty/);
  });

  it("leaves the other kinds untouched", () => {
    const ctx = { fetch: async () => new Response("{}") };
    expect(createController({ id: "claw", kind: "openclaw", url: "http://c" }, ctx).kind).toBe("openclaw");
    expect(createController(agent(), ctxWith(fakeXaventra())).kind).toBe("xaventra");
  });
});

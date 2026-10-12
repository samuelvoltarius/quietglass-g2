import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeProjectDir, createBridgeClient, createController, killTree, listClaudeSessions, parseCodexThreads, parseHermesSessions,
  readEnvValue, resolveBridgeToken, whenShort, createRelay, validateConfig, RECONNECT_BASE_MS,
} from "../examples/quiet-hub-relay.mjs";
import { fakeChild, sleep, startHub, until, TOKEN } from "./helpers.mjs";

const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

const SECRET = "bridge-secret-7f3a";
const ENV = { EVENHUB_BRIDGE_TOKEN: SECRET };

/** A scripted hermes-evenhub-bridge: speaks the wire protocol, records what the client sent. */
function fakeBridge({ hold = false, tokenOk = true } = {}) {
  const instances = [];
  const sessions = [
    { id: "s-1", title: "Erste Sitzung", updated: Math.floor(Date.now() / 1000) - 600 },
    { id: "s-2", title: "Zweite", updated: Math.floor(Date.now() / 1000) - 7200 },
  ];
  let active = "s-1";
  let counter = 0;
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      instances.push(this);
      setImmediate(() => { this.readyState = 1; this.onopen?.(); });
    }

    reply(message) { setImmediate(() => this.onmessage?.({ data: JSON.stringify(message) })); }

    send(raw) {
      const m = JSON.parse(raw);
      this.sent.push(m);
      if (m.t === "hello") {
        if (!tokenOk || m.token !== SECRET) { this.drop(1008); return; }
        this.reply({ t: "hello.ok", caps: {}, active });
      } else if (m.t === "sessions.list") this.reply({ t: "sessions", items: sessions, active });
      else if (m.t === "sessions.new") { counter += 1; active = `s-new-${counter}`; this.reply({ t: "active", id: active }); }
      else if (m.t === "sessions.switch") {
        active = m.id;
        this.reply({ t: "history", id: m.id, ok: true, items: [{ kind: "user", text: "Frage?" }, { kind: "assistant", text: "Antwort!" }] });
      } else if (m.t === "text") {
        if (hold) { this.reply({ t: "assistant.delta", text: "Ich denke " }); return; }
        this.reply({ t: "tool.start", name: "web", label: "suche" });
        this.reply({ t: "assistant.delta", text: "O" });
        this.reply({ t: "assistant.delta", text: "K" });
        this.reply({ t: "turn.done" });
      } else if (m.t === "stop") this.reply({ t: "turn.done" });
    }

    drop(code = 1006) { this.readyState = 3; setImmediate(() => this.onclose?.({ code })); }
    close() { this.readyState = 3; }
  }
  return { FakeWS, instances, setActive: (id) => { active = id; } };
}

const bridgeAgent = (extra = {}) => ({ id: "hermes-x", kind: "hermes", mode: "auto", bridge: { url: "ws://bridge.test:8765", tokenEnv: "EVENHUB_BRIDGE_TOKEN" }, ...extra });

describe("token handling", () => {
  it("reads the bridge token from env first, then from .hermes/.env with quotes stripped", () => {
    expect(resolveBridgeToken({ tokenEnv: "EVENHUB_BRIDGE_TOKEN" }, { env: ENV })).toBe(SECRET);
    const file = join("/h", ".hermes", ".env");
    const readFile = (p) => { if (p !== file) throw new Error("ENOENT"); return ["FOO=1", 'export EVENHUB_BRIDGE_TOKEN="from-file"', ""].join("\n"); };
    expect(resolveBridgeToken({ tokenEnv: "EVENHUB_BRIDGE_TOKEN" }, { env: {}, home: "/h", readFile })).toBe("from-file");
  });

  it("falls back to the env file of the home directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-home-"));
    mkdirSync(join(dir, ".hermes"));
    writeFileSync(join(dir, ".hermes", ".env"), "A=1\nEVENHUB_BRIDGE_TOKEN='quoted-token'\n");
    expect(resolveBridgeToken({ tokenEnv: "EVENHUB_BRIDGE_TOKEN" }, { env: {}, home: dir })).toBe("quoted-token");
    expect(readEnvValue("MISSING", [join(dir, ".hermes", ".env")])).toBe("");
  });
});

describe("Hermes bridge client", () => {
  it("says hello with the token, lists, creates and switches sessions", async () => {
    const b = fakeBridge();
    const client = createBridgeClient({ url: "ws://x", WebSocket: b.FakeWS, getToken: () => SECRET, device: "quiet-hub-t" });
    cleanup.push(() => client.dispose());
    await client.connect();
    expect(b.instances[0].sent[0]).toEqual({ t: "hello", token: SECRET, device: "quiet-hub-t" });
    expect(client.active).toBe("s-1");
    const list = await client.listSessions();
    expect(list.items.map((s) => s.title)).toEqual(["Erste Sitzung", "Zweite"]);
    expect(list.items[0].when).toBe("10m");
    const created = await client.newSession("Neu");
    expect(created.id).toBe("s-new-1");
    expect(client.active).toBe("s-new-1");
    const history = await client.switchSession("s-2");
    expect(history).toEqual([{ role: "user", text: "Frage?" }, { role: "assistant", text: "Antwort!" }]);
    expect(client.active).toBe("s-2");
  });

  it("reports a rejected token without retrying", async () => {
    const b = fakeBridge({ tokenOk: false });
    const client = createBridgeClient({ url: "ws://x", WebSocket: b.FakeWS, getToken: () => "wrong", keepAlive: true });
    cleanup.push(() => client.dispose());
    await expect(client.connect()).rejects.toThrow(/token rejected/);
    await sleep(RECONNECT_BASE_MS + 100);
    expect(b.instances).toHaveLength(1);
  });

  it("reconnects with backoff after the link drops", async () => {
    const b = fakeBridge();
    const client = createBridgeClient({ url: "ws://x", WebSocket: b.FakeWS, getToken: () => SECRET, keepAlive: true });
    cleanup.push(() => client.dispose());
    await client.connect();
    b.instances[0].drop(1006);
    await until(() => b.instances.length === 2, 3000);
    await until(() => client.connected, 3000);
    expect(b.instances[1].sent[0].t).toBe("hello");
  });

  it("refuses to connect without a token", async () => {
    const client = createBridgeClient({ url: "ws://x", WebSocket: fakeBridge().FakeWS, getToken: () => "" });
    await expect(client.connect()).rejects.toThrow(/token missing/);
  });
});

describe("Hermes controller", () => {
  const ctxFor = (b, spawn = () => { throw new Error("no CLI expected"); }) => ({ WebSocket: b.FakeWS, env: ENV, spawn, fetch: async () => { throw new Error("no http"); } });

  it("streams a prompt through the bridge into the selected session", async () => {
    const b = fakeBridge();
    const c = createController(bridgeAgent(), ctxFor(b));
    cleanup.push(() => c.close());
    const updates = [];
    const out = await c.run({ prompt: "Antworte nur mit OK", sessionId: "s-2", fresh: false, signal: new AbortController().signal }, (u) => updates.push(u));
    expect(out).toMatchObject({ status: "done", text: "OK", sessionId: "s-2", transport: "bridge" });
    const types = b.instances[0].sent.map((m) => m.t);
    expect(types).toEqual(["hello", "sessions.switch", "text"]);
    expect(updates.some((u) => u.activity.includes("web"))).toBe(true);
    expect(c.transport()).toBe("bridge");
  });

  it("a fresh session creates one on the bridge first", async () => {
    const b = fakeBridge();
    const c = createController(bridgeAgent(), ctxFor(b));
    cleanup.push(() => c.close());
    const out = await c.run({ prompt: "Hallo", sessionId: null, fresh: true, signal: new AbortController().signal }, () => undefined);
    expect(out.sessionId).toBe("s-new-1");
    expect(b.instances[0].sent.map((m) => m.t)).toEqual(["hello", "sessions.new", "text"]);
  });

  it("stop is a real interrupt: {t:'stop'} is sent and the turn ends as cancelled", async () => {
    const b = fakeBridge({ hold: true });
    const c = createController(bridgeAgent(), ctxFor(b));
    cleanup.push(() => c.close());
    const abort = new AbortController();
    const running = c.run({ prompt: "lange Aufgabe", sessionId: null, fresh: false, signal: abort.signal }, () => undefined);
    await until(() => b.instances[0]?.sent.some((m) => m.t === "text"));
    abort.abort();
    const out = await running;
    expect(out.status).toBe("cancelled");
    expect(out.text).toContain("Ich denke");
    expect(b.instances[0].sent.some((m) => m.t === "stop")).toBe(true);
  });

  it("an unpaired device (bridge answers with a pairing prompt) is never shown as an answer; the CLI answers instead", async () => {
    const b = fakeBridge();
    const send = b.FakeWS.prototype.send;
    b.FakeWS.prototype.send = function patched(raw) {
      const m = JSON.parse(raw);
      if (m.t === "text") { this.reply({ t: "assistant", text: "Hi~ I don't recognize you yet! Here's your pairing code: ABCD1234" }); this.reply({ t: "turn.done" }); return; }
      send.call(this, raw);
    };
    const spawn = () => { const child = fakeChild(); setImmediate(() => { child.emitLines("Servus"); child.exit(0); }); return child; };
    const c = createController(bridgeAgent(), ctxFor(b, spawn));
    cleanup.push(() => c.close());
    const out = await c.run({ prompt: "Hallo", sessionId: null, fresh: false, signal: new AbortController().signal }, () => undefined);
    expect(out).toMatchObject({ status: "done", text: "Servus", transport: "cli" });
    expect(c.transport()).toBe("cli");
  });

  it("a bridge that ends the turn without any reply (unpaired device) hands the prompt to the CLI", async () => {
    const b = fakeBridge();
    const send = b.FakeWS.prototype.send;
    b.FakeWS.prototype.send = function patched(raw) {
      if (JSON.parse(raw).t === "text") { this.reply({ t: "turn.done" }); return; }
      send.call(this, raw);
    };
    const spawn = () => { const child = fakeChild(); setImmediate(() => { child.emitLines("Servus"); child.exit(0); }); return child; };
    const c = createController(bridgeAgent(), ctxFor(b, spawn));
    cleanup.push(() => c.close());
    const out = await c.run({ prompt: "Hallo", sessionId: null, fresh: false, signal: new AbortController().signal }, () => undefined);
    expect(out).toMatchObject({ status: "done", text: "Servus", transport: "cli" });
  });

  it("select returns the last exchange for the glasses", async () => {
    const b = fakeBridge();
    const c = createController(bridgeAgent(), ctxFor(b));
    cleanup.push(() => c.close());
    expect(await c.select("s-2")).toEqual({ lastUser: "Frage?", lastAssistant: "Antwort!" });
  });

  it("lists sessions through the bridge, and the token never shows up in results", async () => {
    const b = fakeBridge();
    const c = createController(bridgeAgent(), ctxFor(b));
    cleanup.push(() => c.close());
    const out = await c.sessions();
    expect(out).toMatchObject({ transport: "bridge", supported: true, active: "s-1" });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("falls back to `hermes chat -q` (with --resume) when the bridge is unreachable", async () => {
    const calls = [];
    const spawn = (bin, args) => {
      calls.push([bin, ...args]);
      const child = fakeChild();
      setImmediate(() => { child.emitLines("session_id: 20261012_abc123", "Servus"); child.exit(0); });
      return child;
    };
    class DeadWS { constructor() { setImmediate(() => this.onerror?.()); } send() {} close() {} }
    const c = createController(bridgeAgent(), { WebSocket: DeadWS, env: ENV, spawn });
    cleanup.push(() => c.close());
    const first = await c.run({ prompt: "Hallo", sessionId: null, fresh: true, signal: new AbortController().signal }, () => undefined);
    expect(first).toMatchObject({ status: "done", text: "Servus", sessionId: "20261012_abc123", transport: "cli" });
    expect(calls[0]).not.toContain("--resume");
    const second = await c.run({ prompt: "Weiter", sessionId: null, fresh: false, signal: new AbortController().signal }, () => undefined);
    expect(second.sessionId).toBe("20261012_abc123");
    expect(calls[1].slice(-2)).toEqual(["--resume", "20261012_abc123"]);
    expect(c.transport()).toBe("cli");
  });

  it("the CLI session list is parsed from `hermes sessions list`", () => {
    const table = [
      "⚠ A previous `hermes update` pulled new code",
      "Title                        Workspace          Last Active   ID",
      "────────────────────────────────────────────────────────────────",
      "Antworte nur mit OK          quiet-hub          24m ago       20261012_202513_d7b925",
      "—                            —                  4h ago        ocuclaw_copy_c6e8535f4ce34d04b34dde4ca349de4a",
    ].join("\n");
    const items = parseHermesSessions(table);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: "20261012_202513_d7b925", title: "Antworte nur mit OK", when: "24m" });
    expect(items[1].title).toBe("(ohne Titel)");
  });

  it("reads full titles newest-first from state.db and falls back to the CLI table", async () => {
    const now = Math.round(Date.now() / 1000);
    const rows = [["b", "Nenne eine Hauptstadt in Europa", now - 600], ["a", "", now - 3600]];
    const calls = [];
    const spawn = (bin, args) => {
      calls.push(bin);
      const child = fakeChild();
      setImmediate(() => { if (bin === "python3") child.emitLines(JSON.stringify(rows)); child.exit(0); });
      return child;
    };
    const c = createController({ id: "h", kind: "hermes", mode: "auto" }, { spawn });
    cleanup.push(() => c.close());
    const list = await c.sessions();
    expect(calls).toEqual(["python3"]);
    expect(list.items.map((i) => i.title)).toEqual(["Nenne eine Hauptstadt in Europa", "(ohne Titel)"]);
    expect(list.items[0].when).toBe("10m");

    const failing = (bin) => {
      const child = fakeChild();
      setImmediate(() => { if (bin !== "python3") child.emitLines("x  y  2m ago  20261012_202513_d7b925"); child.exit(bin === "python3" ? 1 : 0); });
      return child;
    };
    const d = createController({ id: "h2", kind: "hermes", mode: "auto" }, { spawn: failing });
    cleanup.push(() => d.close());
    expect((await d.sessions()).items[0].id).toBe("20261012_202513_d7b925");
  });

  it("legacy agent.url configs still mean 'use the bridge'", async () => {
    const b = fakeBridge();
    const c = createController({ id: "h", kind: "hermes", mode: "auto", url: "ws://x", tokenEnv: "EVENHUB_BRIDGE_TOKEN" }, ctxFor(b));
    cleanup.push(() => c.close());
    expect(c.transport()).toBe("bridge");
    expect((await c.sessions()).transport).toBe("bridge");
  });
});

describe("Claude sessions", () => {
  const ctx = (spawn) => ({ spawn, hub: "http://h", token: "t", mcpConfigPath: () => "/tmp/mcp.json", claudeDir: "/nonexistent" });
  const stream = (child, id) => { child.emitLines({ type: "system", session_id: id }, { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }, { type: "result", result: "ok", session_id: id }); child.exit(0); };

  it("resumes a chosen session id, starts clean for a new one and remembers the id", async () => {
    const calls = [];
    const spawn = (bin, args) => { calls.push(args); const c = fakeChild(); setImmediate(() => stream(c, calls.length === 1 ? "sess-A" : "sess-B")); return c; };
    const c = createController({ id: "c", kind: "claude", mode: "auto", cwd: "/w" }, ctx(spawn));
    const sig = new AbortController().signal;
    const a = await c.run({ prompt: "x", sessionId: null, fresh: true, signal: sig }, () => undefined);
    expect(a.sessionId).toBe("sess-A");
    expect(calls[0]).not.toContain("--resume");
    await c.run({ prompt: "y", sessionId: "sess-OLD", fresh: false, signal: sig }, () => undefined);
    expect(calls[1].slice(calls[1].indexOf("--resume"), calls[1].indexOf("--resume") + 2)).toEqual(["--resume", "sess-OLD"]);
    await c.run({ prompt: "z", sessionId: null, fresh: false, signal: sig }, () => undefined);
    expect(calls[2]).toContain("--resume");
  });

  it("agent.continue uses --continue when there is no id", async () => {
    const calls = [];
    const spawn = (bin, args) => { calls.push(args); const c = fakeChild(); setImmediate(() => stream(c, "s")); return c; };
    const c = createController({ id: "c", kind: "claude", mode: "auto", continue: true }, ctx(spawn));
    await c.run({ prompt: "x", sessionId: null, fresh: false, signal: new AbortController().signal }, () => undefined);
    expect(calls[0]).toContain("--continue");
  });

  it("lists sessions from the project folder (title = first prompt), newest first", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-cfg-"));
    const cwd = "F:/os/nova-core";
    const folder = claudeProjectDir(cwd, dir);
    expect(folder.endsWith("F--os-nova-core")).toBe(true);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "old.jsonl"), `${JSON.stringify({ type: "user", message: { role: "user", content: "Alte Aufgabe" } })}\n`);
    writeFileSync(join(folder, "new.jsonl"), [
      JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "<command-name>x</command-name>" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Neue Aufgabe bitte" }] } }),
    ].join("\n"));
    const t = Date.now() / 1000;
    // make "new" the newest
    writeFileSync(join(folder, "new.jsonl"), [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Neue Aufgabe bitte" }] } }),
    ].join("\n"));
    const items = listClaudeSessions(cwd, dir);
    expect(items.map((s) => s.title)).toContain("Neue Aufgabe bitte");
    expect(items.map((s) => s.id).sort()).toEqual(["new", "old"]);
    expect(t).toBeGreaterThan(0);
    expect(listClaudeSessions("Z:/nothing", dir)).toEqual([]);
  });
});

describe("process tree kill", () => {
  it("Windows: taskkill /T /F /PID", () => {
    const calls = [];
    const child = fakeChild();
    killTree(child, (bin, args) => { calls.push([bin, ...args]); return fakeChild(); }, { platform: "win32" });
    expect(calls[0]).toEqual(["taskkill", "/T", "/F", "/PID", "4242"]);
  });

  it("Linux: the whole process group gets SIGTERM, then SIGKILL", async () => {
    const kill = vi.fn();
    killTree(fakeChild(), () => undefined, { platform: "linux", kill, graceMs: 20 });
    expect(kill).toHaveBeenCalledWith(-4242, "SIGTERM");
    await sleep(60);
    expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
  });

  it("falls back to the child itself when the group is gone", () => {
    const child = fakeChild();
    const own = vi.spyOn(child, "kill");
    killTree(child, () => undefined, { platform: "linux", kill: () => { throw new Error("ESRCH"); } });
    expect(own).toHaveBeenCalledWith("SIGTERM");
  });

  it("stopping a Claude run kills its tree and reports cancelled with the session id", async () => {
    const kills = [];
    const child = fakeChild();
    child.kill = () => { setImmediate(() => child.exit(143)); };
    const spawn = () => { setImmediate(() => child.emitLines({ type: "system", session_id: "sess-live" })); return child; };
    const c = createController({ id: "c", kind: "claude", mode: "auto" }, {
      spawn, hub: "", token: "", claudeDir: "/x", killOptions: { platform: "linux", kill: (pid, sig) => { kills.push([pid, sig]); setImmediate(() => child.exit(143)); } },
    });
    const abort = new AbortController();
    const run = c.run({ prompt: "lang", sessionId: null, fresh: true, signal: abort.signal }, () => undefined);
    await sleep(30);
    abort.abort();
    const out = await run;
    expect(kills[0]).toEqual([-4242, "SIGTERM"]);
    expect(out).toMatchObject({ status: "cancelled", sessionId: "sess-live" });
  });
});

describe("Codex sessions", () => {
  /** app-server that answers JSON-RPC lines; records every request. */
  function appServer(handlers) {
    const requests = [];
    const children = [];
    const spawn = (bin, args) => {
      const child = fakeChild();
      children.push(child);
      child.stdin.on("data", (chunk) => {
        for (const line of String(chunk).split("\n").filter(Boolean)) {
          const msg = JSON.parse(line);
          if (msg.id === undefined) continue;
          requests.push(msg);
          const result = handlers[msg.method]?.(msg, child);
          if (result !== undefined) child.emitLines({ id: msg.id, result });
        }
      });
      return child;
    };
    return { spawn, requests, children };
  }
  const base = { initialize: () => ({}) };

  it("thread/start for a new session, thread/resume for a chosen one", async () => {
    const s = appServer({
      ...base,
      "thread/start": () => ({ thread: { id: "th-new" } }),
      "thread/resume": () => ({ thread: { id: "th-old" } }),
      "turn/start": (_m, child) => { setImmediate(() => { child.emitLines({ method: "item/agentMessage/delta", params: { delta: "fertig" } }, { method: "turn/completed", params: { turn: { status: "completed" } } }); }); return { turn: { id: "t1" } }; },
    });
    const c = createController({ id: "x", kind: "codex", mode: "auto", cwd: "/w" }, { spawn: s.spawn, fetch: fetch, hub: "", token: "", killOptions: { platform: "linux", kill: () => undefined } });
    const sig = new AbortController().signal;
    const fresh = await c.run({ prompt: "a", sessionId: null, fresh: true, signal: sig }, () => undefined);
    expect(fresh).toMatchObject({ status: "done", sessionId: "th-new", transport: "app-server" });
    const resumed = await c.run({ prompt: "b", sessionId: "th-old", fresh: false, signal: sig }, () => undefined);
    expect(resumed.sessionId).toBe("th-old");
    const methods = s.requests.map((r) => r.method);
    expect(methods).toContain("thread/start");
    expect(methods).toContain("thread/resume");
    expect(s.requests.find((r) => r.method === "thread/resume").params).toEqual({ threadId: "th-old" });
  });

  it("stop sends turn/interrupt and ends the process", async () => {
    const s = appServer({
      ...base,
      "thread/start": () => ({ thread: { id: "th-1" } }),
      "turn/start": () => ({ turn: { id: "t-9" } }),
    });
    const c = createController({ id: "x", kind: "codex", mode: "auto" }, { spawn: s.spawn, fetch, hub: "", token: "", killOptions: { platform: "linux", kill: () => undefined } });
    const abort = new AbortController();
    const run = c.run({ prompt: "lang", sessionId: null, fresh: true, signal: abort.signal }, () => undefined);
    await until(() => s.requests.some((r) => r.method === "turn/start"));
    await sleep(20);
    abort.abort();
    const out = await run;
    expect(out.status).toBe("cancelled");
    expect(s.requests.some((r) => r.method === "turn/interrupt" && r.params.turnId === "t-9")).toBe(true);
  });

  it("lists threads via thread/list", async () => {
    const s = appServer({
      ...base,
      "thread/list": () => ({ data: [{ id: "th-1", preview: "Refactor", updatedAt: Math.floor(Date.now() / 1000) - 300 }, { id: "th-2", name: "Docs", updatedAt: 0 }] }),
    });
    const c = createController({ id: "x", kind: "codex", mode: "auto" }, { spawn: s.spawn, fetch, hub: "", token: "", killOptions: { platform: "linux", kill: () => undefined } });
    const out = await c.sessions();
    expect(out.items.map((i) => i.title)).toEqual(["Refactor", "Docs"]);
    expect(out.items[0].when).toBe("5m");
    expect(parseCodexThreads({ threads: [{ id: "a" }] })[0].id).toBe("a");
  });
});

describe("hub: sessions end to end (relay + daemon + bridge)", () => {
  async function setup({ hold = false } = {}) {
    const b = fakeBridge({ hold });
    const h = await startHub({});
    const relay = createRelay({
      hub: h.url, token: TOKEN, config: validateConfig({ machine: "spark", agents: [bridgeAgent({ id: "hermes-spark" })] }),
      WebSocket: b.FakeWS, env: ENV, pollTimeoutMs: 2000, log: () => undefined, spawnImpl: () => { throw new Error("no CLI"); },
    });
    const loop = relay.start();
    cleanup.push(async () => { relay.stop(); await loop; await h.close(); });
    await until(async () => (await h.api("/agents")).json.agents.some((a) => a.online));
    return { b, h, relay };
  }

  it("list → new → select → ask in the selected session → answer", async () => {
    const { b, h } = await setup();
    const list = await h.api("/agent/sessions?agentId=hermes-spark");
    expect(list.status).toBe(200);
    expect(list.json).toMatchObject({ transport: "bridge", supported: true });
    expect(list.json.sessions.map((s) => s.title)).toEqual(["Erste Sitzung", "Zweite"]);

    const picked = await h.api("/agent/session/select", { agentId: "hermes-spark", sessionId: "s-2", title: "Zweite" });
    expect(picked.json.session).toEqual({ id: "s-2", title: "Zweite" });
    let info = (await h.api("/agents")).json.agents[0];
    expect(info.session).toEqual({ id: "s-2", title: "Zweite" });
    expect(info.answer).toBe("Antwort!");

    await h.api("/agent/ask", { agentId: "hermes-spark", question: "Antworte nur mit OK", wait: false });
    await until(async () => (await h.api("/agents")).json.agents[0].busy === false && (await h.api("/agents")).json.agents[0].answer === "OK");
    const sent = b.instances[0].sent.filter((m) => m.t === "text");
    expect(sent[0].text).toContain("Antworte nur mit OK");
    expect(b.instances[0].sent.map((m) => m.t)).not.toContain("sessions.new");

    const created = await h.api("/agent/session/new", { agentId: "hermes-spark" });
    expect(created.json.session.id).toBe("s-new-1");
    info = (await h.api("/agents")).json.agents[0];
    expect(info).toMatchObject({ answer: null, transport: "bridge" });
    expect(info.session.id).toBe("s-new-1");
  });

  it("stop interrupts the bridge, reports stopped and frees the agent for the next prompt", async () => {
    const { b, h } = await setup({ hold: true });
    await h.api("/agent/ask", { agentId: "hermes-spark", question: "lange Aufgabe", wait: false });
    await until(() => b.instances[0]?.sent.some((m) => m.t === "text"));
    const stop = await h.api("/agent/cancel", { agentId: "hermes-spark" });
    expect(stop.json).toMatchObject({ ok: true, stopped: true });
    const quick = (await h.api("/agents")).json.agents[0];
    expect(quick).toMatchObject({ busy: false, stopped: true });
    await until(async () => (await h.api("/agents")).json.agents[0].stopConfirmed === true);
    expect(b.instances[0].sent.some((m) => m.t === "stop")).toBe(true);
    // the next ask starts cleanly (the relay waits for the old turn to be gone)
    const again = await h.api("/agent/ask", { agentId: "hermes-spark", question: "nochmal", wait: false });
    expect(again.status).toBe(202);
    expect((await h.api("/agents")).json.agents[0].stopped).toBe(false);
  });

  it("session commands are refused while the agent is busy, and unknown agents are 404", async () => {
    const { h, b } = await setup({ hold: true });
    await h.api("/agent/ask", { agentId: "hermes-spark", question: "lang", wait: false });
    await until(() => b.instances[0]?.sent.some((m) => m.t === "text"));
    expect((await h.api("/agent/session/new", { agentId: "hermes-spark" })).status).toBe(409);
    expect((await h.api("/agent/sessions?agentId=nope")).status).toBe(404);
    expect((await h.api("/agent/session/select", { agentId: "hermes-spark" })).status).toBe(409);
  });

  it("a relay that does not answer gives a clean timeout, not a hang", async () => {
    const h = await startHub({ rpcTimeoutMs: 200 });
    cleanup.push(() => h.close());
    await h.api("/relay/register", { machine: "ghost", agents: [{ id: "g", kind: "hermes" }] });
    const res = await h.api("/agent/sessions?agentId=g");
    expect(res.status).toBe(504);
  });

  it("the new session learns its id from the first answer (CLI transports)", async () => {
    const h = await startHub({});
    cleanup.push(() => h.close());
    const reg = await h.api("/relay/register", { machine: "win", agents: [{ id: "claude-win", kind: "claude", sessions: true }] });
    const relay = reg.json.relayId;
    const pending = h.api("/agent/session/new", { agentId: "claude-win" });
    const polled = await h.api(`/relay/poll?relay=${relay}`);
    const command = polled.json.commands[0];
    expect(command).toMatchObject({ type: "session.new", agentId: "claude-win" });
    await h.api("/relay/reply", { reqId: command.reqId, ok: true, data: { id: null, title: "", transport: "cli" } });
    expect((await pending).json.session).toEqual({ id: null, title: "" });

    await h.api("/agent/ask", { agentId: "claude-win", question: "Baue das Feature", wait: false });
    const ask = (await h.api(`/relay/poll?relay=${relay}`)).json.commands[0];
    expect(ask).toMatchObject({ type: "ask", sessionId: null, fresh: true });
    await h.api("/relay/result", { jobId: ask.jobId, status: "done", text: "fertig", sessionId: "sess-Z", transport: "cli" });
    const info = (await h.api("/agents")).json.agents[0];
    expect(info.session).toEqual({ id: "sess-Z", title: "Baue das Feature" });

    // The next prompt resumes exactly that session.
    await h.api("/agent/ask", { agentId: "claude-win", question: "Weiter", wait: false });
    const next = (await h.api(`/relay/poll?relay=${relay}`)).json.commands[0];
    expect(next).toMatchObject({ sessionId: "sess-Z", fresh: false });
  });
});

describe("misc", () => {
  it("whenShort renders relative ages", () => {
    const now = 1_000_000_000_000;
    expect(whenShort(now / 1000 - 30, now)).toBe("jetzt");
    expect(whenShort(now / 1000 - 600, now)).toBe("10m");
    expect(whenShort(now / 1000 - 7200, now)).toBe("2h");
    expect(whenShort(now / 1000 - 3 * 86400, now)).toBe("3d");
    expect(whenShort(0, now)).toBe("");
  });
});

describe("hermes stream-json lines", () => {
  it("parses tool steps, deltas, result and session id", async () => {
    const { parseHermesStreamLine } = await import("../examples/quiet-hub-agents.mjs");
    expect(parseHermesStreamLine('{"type":"tool_use","name":"terminal","input":{"command":"ls"}}')).toEqual({ activity: "terminal: ls" });
    expect(parseHermesStreamLine('{"type":"text","text":"Hi"}')).toEqual({ delta: "Hi" });
    expect(parseHermesStreamLine('{"type":"result","session_id":"S","text":"Fertig"}')).toEqual({ final: "Fertig", sessionId: "S" });
    expect(parseHermesStreamLine('{"type":"system","session_id":"S"}')).toEqual({ sessionId: "S" });
    expect(parseHermesStreamLine("kein json")).toBeNull();
  });
});

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub } from "../examples/quiet-hub-daemon.mjs";

export const TOKEN = "test-token-123";

/** A running hub on an ephemeral port with isolated state and no network side effects. */
export async function startHub(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "quiet-hub-test-"));
  const hub = createHub({
    env: {},
    token: TOKEN,
    stateFile: join(dir, "state.json"),
    localAgent: false,
    suggestions: false,
    approvalTimeoutMs: 400,
    pollHoldMs: 300,
    accessLog: false,
    ...options,
  });
  const address = await hub.listen(0, "127.0.0.1");
  const url = `http://127.0.0.1:${address.port}`;
  const api = async (path, body, init = {}) => {
    const res = await fetch(`${url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      body: body === undefined ? undefined : (init.raw ? body : JSON.stringify(body)),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, json };
  };
  return { hub, url, api, close: () => hub.close() };
}

/** Fake child process: feed stdout lines with `emitLines`, finish with `exit`. */
export function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdinData = "";
  child.stdin.on("data", (d) => { child.stdinData += d; });
  child.pid = 4242;
  child.killed = false;
  child.kill = () => { child.killed = true; setImmediate(() => child.exit(143)); };
  child.emitLines = (...lines) => { for (const l of lines) child.stdout.write(`${typeof l === "string" ? l : JSON.stringify(l)}\n`); };
  child.exit = (code = 0) => { child.stdout.end(); child.emit("close", code); };
  return child;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(15);
  }
  throw new Error("condition not met in time");
}

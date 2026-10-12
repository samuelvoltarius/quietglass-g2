#!/usr/bin/env node
/**
 * Status Glass reference server.
 *
 * A complete, dependency-free source in about a hundred lines. Copy it, replace
 * `collect()` with whatever you actually want to watch, and point Status Glass
 * at it. That is the whole integration story — if it needed more than this,
 * nobody would write one for their own homelab.
 *
 *   node reference-server.mjs                 # http://127.0.0.1:8099/status
 *   PORT=9000 TOKEN=secret node reference-server.mjs
 *
 * STATUS_TAILSCALE_USERS (comma list of Tailscale logins) lets those users in
 * without a token when `tailscale serve` proxies the request from loopback.
 *
 * The values below come from Node's own os module, so it runs anywhere without
 * installing anything.
 */
import { createServer } from "node:http";
import { cpus, freemem, totalmem, loadavg, uptime } from "node:os";

const PORT = Number(process.env["PORT"] ?? 8099);
const HOST = process.env["HOST"] ?? "127.0.0.1";
const TOKEN = process.env["TOKEN"] ?? "";
const NAME = process.env["NAME"] ?? "reference";
const TAILSCALE_USERS = String(process.env["STATUS_TAILSCALE_USERS"] ?? "").split(",").map((u) => u.trim().toLowerCase()).filter(Boolean);

/** `tailscale serve` connects from loopback and sets Tailscale-User-Login; a LAN client cannot spoof it. */
function tailscaleUser(request) {
  const peer = String(request.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (peer !== "127.0.0.1" && peer !== "::1") return "";
  const login = String(request.headers["tailscale-user-login"] ?? "").trim().toLowerCase();
  return TAILSCALE_USERS.includes(login) ? login : "";
}

/**
 * Build the report.
 *
 * Every metric needs `id` and `label`, plus either a numeric `value` or an
 * explicit `state`. `warn` and `critical` are optional thresholds; set
 * `lowerIsWorse: true` for metrics where a small number is the bad one.
 */
function collect() {
  const load = loadavg()[0] ?? 0;
  const cpuCount = cpus().length || 1;
  const loadPercent = (load / cpuCount) * 100;
  const memUsedPercent = ((totalmem() - freemem()) / totalmem()) * 100;

  return {
    name: NAME,
    timestamp: Date.now(),
    metrics: [
      {
        id: "load",
        label: "Load",
        value: Number(loadPercent.toFixed(1)),
        unit: "%",
        warn: 70,
        critical: 90,
      },
      {
        id: "memory",
        label: "RAM",
        value: Number(memUsedPercent.toFixed(1)),
        unit: "%",
        warn: 85,
        critical: 95,
      },
      {
        id: "freemem",
        label: "Free",
        value: Number((freemem() / 1024 / 1024 / 1024).toFixed(1)),
        unit: "GB",
        warn: 2,
        critical: 0.5,
        // Small numbers are the problem here, not large ones.
        lowerIsWorse: true,
      },
      {
        id: "uptime",
        label: "Up",
        value: Math.round(uptime() / 3600),
        unit: "h",
      },
      {
        // A check that is not a number: report a state directly.
        id: "service",
        label: "Web",
        state: "ok",
      },
    ],
  };
}

const CORS = {
  // Status Glass runs in a WebView; allow it to read this.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const server = createServer((request, response) => {
  // The browser's preflight never carries the Authorization header, so it is
  // answered before the token check. Checking it first answered 401 without
  // CORS headers, and the WebView then refused every request — a TOKEN made
  // the server unusable from Status Glass.
  if (request.method === "OPTIONS") {
    response.writeHead(204, CORS);
    response.end();
    return;
  }

  if (!request.url?.startsWith("/status")) {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found\n");
    return;
  }

  // Constant-time-ish check is overkill here, but never log the token.
  if ((TOKEN || TAILSCALE_USERS.length > 0) && tailscaleUser(request) === "") {
    const header = request.headers["authorization"] ?? "";
    if (!TOKEN || header !== "Bearer " + TOKEN) {
      response.writeHead(401, { ...CORS, "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
  }

  const body = JSON.stringify(collect());
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...CORS,
  });
  response.end(body);
});

server.listen(PORT, HOST, () => {
  console.log("Status Glass reference server on http://" + HOST + ":" + PORT + "/status");
  if (!TOKEN && TAILSCALE_USERS.length === 0) console.log("No TOKEN set: this endpoint is unauthenticated.");
  if (HOST === "0.0.0.0") console.log("Bound to all interfaces. Set a TOKEN and prefer TLS.");
});

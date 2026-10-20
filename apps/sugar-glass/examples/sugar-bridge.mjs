#!/usr/bin/env node
/**
 * Sugar Glass bridge: a tiny read-only proxy in front of your own Nightscout.
 *
 * Why: Nightscout with AUTH_DEFAULT_ROLES=denied needs a token for every read.
 * The glasses app is uploaded to the Even Hub, so the token must not be baked
 * into it, and nobody wants to type it on the phone. The bridge runs next to
 * Nightscout, holds a read-only token (role "readable") and passes only a few
 * GET endpoints through. Publish the bridge (not Nightscout) with
 * `tailscale serve`; Tailscale adds the `Tailscale-User-Login` header, and the
 * bridge only trusts it on loopback.
 *
 *   NS_URL=http://127.0.0.1:1337 NS_TOKEN=<readable token> \
 *   SUGAR_TAILSCALE_USERS=you@example.com node sugar-bridge.mjs
 *
 * Environment
 *   PORT                   port (default 8466)
 *   HOST                   address to bind (default 127.0.0.1 — this machine only)
 *   NS_URL                 Nightscout base (default http://127.0.0.1:1337)
 *   NS_TOKEN               Nightscout access token with role "readable" (never logged)
 *   SUGAR_TAILSCALE_USERS  Tailscale logins (comma list) allowed through `tailscale serve`
 *   TOKEN                  optional bearer token as an alternative to the Tailscale login
 *
 * Without SUGAR_TAILSCALE_USERS and without TOKEN every request is refused:
 * glucose values are health data. Dependency-free, Node 18+.
 */
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const PORT = Number(process.env["PORT"] ?? process.env["SUGAR_PORT"] ?? 8466);
const HOST = process.env["HOST"] ?? process.env["SUGAR_HOST"] ?? "127.0.0.1";
const NS_URL = String(process.env["NS_URL"] ?? "http://127.0.0.1:1337").replace(/\/+$/, "");
const NS_TOKEN = String(process.env["NS_TOKEN"] ?? "").trim();
const TOKEN = String(process.env["TOKEN"] ?? "");
const TAILSCALE_USERS = String(process.env["SUGAR_TAILSCALE_USERS"] ?? "").split(",").map((u) => u.trim().toLowerCase()).filter(Boolean);
const UPSTREAM_TIMEOUT_MS = 8_000;

/** The only paths passed through (GET). Everything else is 404. */
export const ALLOWED_PATHS = new Set([
  "/api/v1/entries/sgv.json",
  "/api/v1/entries.json",
  "/api/v1/devicestatus.json",
  "/api/v1/treatments.json",
  "/api/v1/status.json",
  "/api/v1/profile.json",
]);

/** Largest `count` the bridge asks Nightscout for. */
export const MAX_COUNT = 400;

/**
 * Keeps only harmless query parameters: `count` (clamped) and `find[...]`
 * filters on time fields and event types. A `token` from the caller is
 * dropped; the bridge adds its own.
 */
export function sanitizeQuery(search) {
  const input = new URLSearchParams(search);
  const out = new URLSearchParams();
  for (const [key, value] of input) {
    if (key === "count") {
      const n = Math.floor(Number(value));
      if (Number.isFinite(n) && n > 0) out.set("count", String(Math.min(MAX_COUNT, n)));
      continue;
    }
    if (/^find\[(date|dateString|created_at|sysTime|eventType|type)\](\[\$(gte|lte|gt|lt|eq|exists)\])?$/.test(key) && value.length <= 64) {
      out.append(key, value);
    }
  }
  return out;
}

export function upstreamUrl(pathname, search, base = NS_URL, token = NS_TOKEN) {
  const query = sanitizeQuery(search);
  if (token) query.set("token", token);
  const qs = query.toString();
  return base + pathname + (qs ? "?" + qs : "");
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function cors(request) {
  const origin = String(request.headers["origin"] ?? "");
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}
function send(request, response, code, body) {
  // A preflight answer must be 204 WITHOUT a body (iOS WebKit drops it otherwise).
  if (code === 204) { response.writeHead(204, cors(request)); response.end(); return; }
  response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(request) });
  response.end(JSON.stringify(body));
}

function tailscaleUser(request) {
  const peer = String(request.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (peer !== "127.0.0.1" && peer !== "::1") return "";
  const login = String(request.headers["tailscale-user-login"] ?? "").trim().toLowerCase();
  return TAILSCALE_USERS.includes(login) ? login : "";
}
const digest = (value) => createHash("sha256").update(value).digest();
function authorised(request) {
  if (tailscaleUser(request) !== "") return true;
  if (!TOKEN) return false;
  return timingSafeEqual(digest(String(request.headers["authorization"] ?? "")), digest("Bearer " + TOKEN));
}
/** Access log without secrets: only the kind of credential. */
function authForm(request) {
  if (tailscaleUser(request)) return "tailscale";
  const header = String(request.headers["authorization"] ?? "");
  const login = String(request.headers["tailscale-user-login"] ?? "");
  if (login) return "tailscale-not-allowed";
  return header ? `len${header.length} fp=${createHash("sha256").update(header).digest("hex").slice(0, 8)}` : "none";
}

async function passThrough(request, response, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(upstreamUrl(url.pathname, url.search), { headers: { Accept: "application/json" }, signal: controller.signal });
    const body = await upstream.text();
    if (upstream.status === 401 || upstream.status === 403) {
      console.warn(`upstream ${upstream.status} for ${url.pathname} (NS_TOKEN missing or not readable?)`);
      send(request, response, 502, { error: "nightscout refused the bridge token" });
      return;
    }
    response.writeHead(upstream.status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(request) });
    response.end(body);
  } catch (error) {
    const timeout = error?.name === "AbortError";
    console.warn(`upstream ${timeout ? "timeout" : "unreachable"} for ${url.pathname}`);
    send(request, response, timeout ? 504 : 502, { error: timeout ? "nightscout timeout" : "nightscout unreachable" });
  } finally {
    clearTimeout(timer);
  }
}

export function startServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "OPTIONS") { send(request, response, 204); return; }
    if (url.pathname === "/health") { send(request, response, 200, { ok: true }); return; }
    if (!authorised(request)) {
      console.warn(`401 ${request.method} ${url.pathname} auth=${authForm(request)}`);
      send(request, response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method !== "GET") { send(request, response, 405, { error: "read only" }); return; }
    if (!ALLOWED_PATHS.has(url.pathname)) { send(request, response, 404, { error: "not found" }); return; }
    await passThrough(request, response, url);
  });
  server.listen(PORT, HOST, () => {
    console.log("Sugar Glass bridge on http://" + HOST + ":" + PORT + "/api/v1/entries/sgv.json");
    console.log("  Nightscout: " + NS_URL + " · token: " + (NS_TOKEN ? "set" : "MISSING"));
    console.log("  access: " + (TAILSCALE_USERS.length ? TAILSCALE_USERS.length + " tailscale login(s)" : "no tailscale logins") + (TOKEN ? " + bearer token" : ""));
    if (!TOKEN && TAILSCALE_USERS.length === 0) console.log("  No SUGAR_TAILSCALE_USERS and no TOKEN: every request is refused.");
  });
  return server;
}

const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
if (process.argv[1] && same(fileURLToPath(import.meta.url), process.argv[1])) startServer();

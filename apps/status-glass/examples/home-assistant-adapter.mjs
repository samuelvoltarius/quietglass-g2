#!/usr/bin/env node
/**
 * Home Assistant → Status Glass adapter.
 *
 * Reads entity states from Home Assistant and serves them as a Status Glass
 * source, optionally offering a few actions you can trigger from the glasses.
 *
 *   HA_URL=http://homeassistant.local:8123 \
 *   HA_TOKEN=<long-lived access token> \
 *   node home-assistant-adapter.mjs
 *
 * Then add http://127.0.0.1:8100/status as a source in the Status Glass phone app.
 *
 * ---------------------------------------------------------------------------
 * Why an adapter rather than talking to Home Assistant directly
 * ---------------------------------------------------------------------------
 * Your Home Assistant token stays here, on a machine you control. It is never
 * given to the glasses app and never leaves this process. The glasses only ever
 * see the handful of readings and actions configured below — they cannot browse
 * your house, and a lost phone does not hand anyone control of it.
 *
 * Dependency-free: Node 18+ only.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const HA_URL = (process.env["HA_URL"] ?? "http://homeassistant.local:8123").replace(/\/+$/, "");
const HA_TOKEN = process.env["HA_TOKEN"] ?? "";
const PORT = Number(process.env["PORT"] ?? 8100);
const HOST = process.env["HOST"] ?? "127.0.0.1";
const TOKEN = process.env["TOKEN"] ?? "";           // protects THIS adapter
const NAME = process.env["NAME"] ?? "home";
/**
 * How long Home Assistant gets to answer. Without a limit a hung Home
 * Assistant held every /status request open, and the glasses showed the
 * app's own "timed out" instead of the adapter's clear 502.
 */
const HA_TIMEOUT_MS = Number(process.env["HA_TIMEOUT_MS"] ?? 8000);

if (!HA_TOKEN) {
  console.error("HA_TOKEN is required. Create a long-lived access token in");
  console.error("Home Assistant under your profile > Security.");
  process.exit(1);
}

/**
 * ---------------------------------------------------------------------------
 * WHAT TO SHOW — edit this
 * ---------------------------------------------------------------------------
 * Each entry maps one Home Assistant entity onto one Status Glass metric.
 *
 *   entity      the entity_id in Home Assistant
 *   label       what appears on the glasses (keep it short, the row is ~40 chars)
 *   unit        appended to the value
 *   warn/critical, lowerIsWorse   optional thresholds
 *   states      for non-numeric entities: map HA states onto ok/warn/critical
 */
const METRICS = [
  { entity: "sensor.living_room_temperature", label: "Living", unit: "°C", warn: 26, critical: 30 },
  { entity: "sensor.solar_power", label: "Solar", unit: "kW" },
  { entity: "sensor.house_consumption", label: "House", unit: "kW", warn: 5, critical: 8 },
  {
    entity: "binary_sensor.front_door",
    label: "Front door",
    states: { on: "warn", off: "ok" },   // "on" means open for a door sensor
  },
  {
    entity: "sensor.battery_level",
    label: "Battery",
    unit: "%",
    warn: 30,
    critical: 15,
    lowerIsWorse: true,
  },
];

/**
 * ---------------------------------------------------------------------------
 * WHAT MAY BE CONTROLLED — edit this, and keep it short
 * ---------------------------------------------------------------------------
 * This is an allow-list. Only what is named here can ever be triggered from the
 * glasses; nothing else in Home Assistant is reachable through this adapter.
 *
 *   id       what the glasses send back
 *   label    what appears on the glasses
 *   service  the Home Assistant service to call, e.g. "light.toggle"
 *   data     the service payload
 *   confirm  true = the glasses require a second tap
 *
 * Set `confirm: true` for anything you would not want triggered by a stray tap:
 * doors, gates, alarms, heating, anything that costs money or lets someone in.
 */
const ACTIONS = [
  {
    id: "kitchen_light",
    label: "Kitchen light",
    service: "light.toggle",
    data: { entity_id: "light.kitchen" },
  },
  {
    id: "movie_scene",
    label: "Movie scene",
    service: "scene.turn_on",
    data: { entity_id: "scene.movie" },
  },
  {
    id: "all_off",
    label: "Everything off",
    service: "script.turn_on",
    data: { entity_id: "script.all_off" },
    confirm: true,
  },
];

async function haFetch(path, init = {}) {
  const response = await fetch(HA_URL + path, {
    ...init,
    signal: AbortSignal.timeout(HA_TIMEOUT_MS),
    headers: {
      Authorization: "Bearer " + HA_TOKEN,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error("Home Assistant returned HTTP " + response.status);
  return response.json();
}

/** Builds the Status Glass report from the configured entities. */
async function collect() {
  const states = await haFetch("/api/states");
  const byId = new Map(states.map((s) => [s.entity_id, s]));
  const metrics = [];

  for (const spec of METRICS) {
    const entity = byId.get(spec.entity);

    // An entity that is missing or unavailable reports "unknown" rather than
    // being silently omitted — a missing sensor is itself worth seeing.
    if (!entity || entity.state === "unavailable" || entity.state === "unknown") {
      metrics.push({ id: spec.entity, label: spec.label, state: "unknown" });
      continue;
    }

    if (spec.states) {
      metrics.push({
        id: spec.entity,
        label: spec.label,
        // Own keys only: a state named "constructor" must not resolve to a function.
        state: Object.hasOwn(spec.states, entity.state) ? spec.states[entity.state] : "unknown",
      });
      continue;
    }

    const value = Number(entity.state);
    if (!Number.isFinite(value)) {
      metrics.push({ id: spec.entity, label: spec.label, state: "unknown" });
      continue;
    }

    metrics.push({
      id: spec.entity,
      label: spec.label,
      value: Math.round(value * 10) / 10,
      ...(spec.unit ? { unit: spec.unit } : {}),
      ...(spec.warn !== undefined ? { warn: spec.warn } : {}),
      ...(spec.critical !== undefined ? { critical: spec.critical } : {}),
      ...(spec.lowerIsWorse ? { lowerIsWorse: true } : {}),
    });
  }

  return {
    name: NAME,
    timestamp: Date.now(),
    metrics,
    // Without a TOKEN the glasses are not offered actions at all (see /action).
    actions: (TOKEN ? ACTIONS : []).map((a) => ({
      id: a.id,
      label: a.label,
      ...(a.confirm ? { confirm: true } : {}),
    })),
  };
}

async function runAction(id) {
  const action = ACTIONS.find((a) => a.id === id);
  // Anything not on the allow-list is refused, whatever the request says.
  if (!action) return { ok: false, status: 404, error: "unknown action" };

  const [domain, service] = action.service.split(".");
  if (!domain || !service) return { ok: false, status: 500, error: "bad service" };

  await haFetch("/api/services/" + domain + "/" + service, {
    method: "POST",
    body: JSON.stringify(action.data ?? {}),
  });
  console.log("ran action:", id, "->", action.service);
  return { ok: true, status: 200 };
}

const digest = (text) => createHash("sha256").update(text).digest();

/** Constant-time check, so response timing does not leak the TOKEN. */
function authorised(request) {
  if (!TOKEN) return true;
  return timingSafeEqual(digest(request.headers["authorization"] ?? ""), digest("Bearer " + TOKEN));
}

function send(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") { send(response, 204, {}); return; }

  if (!authorised(request)) { send(response, 401, { error: "unauthorized" }); return; }

  try {
    if (request.url?.startsWith("/status")) {
      send(response, 200, await collect());
      return;
    }

    if (request.url?.startsWith("/action") && request.method === "POST") {
      // Actions change the house, and CORS is open to every origin. Without a
      // TOKEN any web page the phone's or this machine's browser opens could
      // POST here — so control is refused outright until a TOKEN is set.
      if (!TOKEN) { send(response, 403, { error: "actions need TOKEN" }); return; }
      const body = await readBody(request);
      if (body === TOO_LARGE) { send(response, 413, { error: "request too large" }); return; }
      const result = await runAction(body?.id);
      send(response, result.status, result.ok ? { ok: true } : { error: result.error });
      return;
    }

    send(response, 404, { error: "not found" });
  } catch (error) {
    // Never echo the Home Assistant token or URL back to a client.
    console.error("adapter error:", error.message);
    send(response, 502, { error: "home assistant unreachable" });
  }
});

const TOO_LARGE = Symbol("too large");

/** Parses a small JSON body. Oversized bodies resolve TOO_LARGE instead of hanging. */
function readBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    request.on("data", (chunk) => {
      if (done) return;
      raw += chunk;
      if (raw.length > 4096) {                     // nothing legitimate is this big
        finish(TOO_LARGE);
        request.removeAllListeners("data");
        request.resume();                          // drain the rest, then answer 413
      }
    });
    request.on("end", () => {
      try { finish(JSON.parse(raw)); } catch { finish(null); }
    });
    request.on("error", () => finish(null));
  });
}

server.listen(PORT, HOST, () => {
  console.log("Home Assistant adapter on http://" + HOST + ":" + PORT + "/status");
  console.log("  Home Assistant: " + HA_URL);
  console.log("  metrics: " + METRICS.length + ", actions: " + ACTIONS.length);
  if (!TOKEN) console.log("  No TOKEN set: read-only. Readings are open to anyone who can reach this port; actions are disabled.");
  if (HOST === "0.0.0.0") console.log("  Bound to all interfaces. Set a TOKEN and prefer TLS.");
});

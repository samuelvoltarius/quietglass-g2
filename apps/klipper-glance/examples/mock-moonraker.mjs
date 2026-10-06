#!/usr/bin/env node
/**
 * A stand-in for a Klipper printer, for trying the bridge without one: it
 * answers the Moonraker endpoints the bridge uses and lets a print advance
 * slowly. Pause, resume and cancel change its state.
 *
 *   node mock-moonraker.mjs                     # http://127.0.0.1:7125
 *   KL_MOONRAKER=http://127.0.0.1:7125 KL_ALLOW_CONTROL=1 node klipper-bridge.mjs
 *
 * Environment: PORT (default 7125), HOST (default 127.0.0.1),
 * PRINT_SECONDS (length of the simulated print, default 600).
 */
import { createServer } from "node:http";

const PORT = Number(process.env["PORT"] ?? 7125);
const HOST = process.env["HOST"] ?? "127.0.0.1";
const PRINT_SECONDS = Number(process.env["PRINT_SECONDS"] ?? 600);

const started = Date.now();
let state = "printing";
let pausedAt = 0;
let pausedTotal = 0;
const commands = [];

const seconds = () => ((state === "paused" ? pausedAt : Date.now()) - started - pausedTotal) / 1000;

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  response.setHeader("Content-Type", "application/json");
  if (url.pathname === "/printer/info") {
    response.end(JSON.stringify({ result: { state: "ready", hostname: "mock-printer" } }));
    return;
  }
  if (url.pathname === "/printer/objects/query") {
    const s = seconds();
    const progress = Math.min(0.999, s / PRINT_SECONDS);
    response.end(JSON.stringify({ result: { status: {
      print_stats: {
        state, filename: "bracket_v3.gcode", print_duration: s, message: "",
        info: { current_layer: Math.floor(progress * 180) + 1, total_layer: 180 },
      },
      display_status: { progress },
      virtual_sdcard: { progress },
      extruder: { temperature: state === "printing" ? 219.4 + Math.sin(s / 5) : 180, target: state === "printing" ? 220 : 0 },
      heater_bed: { temperature: 59.8, target: 60 },
      gcode_move: { speed_factor: 1.0 },
    } } }));
    return;
  }
  if (request.method === "POST" && url.pathname.startsWith("/printer/print/")) {
    const what = url.pathname.slice("/printer/print/".length);
    commands.push(what);
    if (what === "pause" && state === "printing") { state = "paused"; pausedAt = Date.now(); }
    if (what === "resume" && state === "paused") { state = "printing"; pausedTotal += Date.now() - pausedAt; }
    if (what === "cancel") state = "cancelled";
    response.end(JSON.stringify({ result: "ok" }));
    return;
  }
  // For tests: which commands arrived.
  if (url.pathname === "/mock/commands") { response.end(JSON.stringify({ commands })); return; }
  response.statusCode = 404;
  response.end("{}");
}).listen(PORT, HOST, () => console.log("mock Moonraker on http://" + HOST + ":" + PORT));
